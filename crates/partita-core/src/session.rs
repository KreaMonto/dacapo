//! A [`Session`] is an open document wired to its recovery journal. This is
//! the type the application layer works with.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::document::Document;
use crate::file::{self, FileError};
use crate::recovery::{JournalRecord, RecoveryError, RecoveryStore, RecoveryWriter};

/// When to replace the journal with a fresh full snapshot.
#[derive(Clone, Copy, Debug)]
pub struct SnapshotPolicy {
    pub max_entries: usize,
    pub max_age: Duration,
}

impl Default for SnapshotPolicy {
    fn default() -> Self {
        SnapshotPolicy {
            max_entries: 200,
            max_age: Duration::from_secs(60),
        }
    }
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Session {
    id: Uuid,
    doc: Document,
    writer: Option<RecoveryWriter>,
    seq: u64,
    entries_since_snapshot: usize,
    last_snapshot: Instant,
    policy: SnapshotPolicy,
    /// Last recovery write problem, for the UI to show.
    warning: Option<String>,
}

impl Session {
    /// Starts a session. Without a store the document is not protected
    /// (used in tests and if the recovery folder is unavailable).
    pub fn start(doc: Document, store: Option<&RecoveryStore>) -> Result<Session, RecoveryError> {
        let id = Uuid::new_v4();
        let writer = match store {
            Some(s) => Some(s.create(id, &doc, now_ms())?),
            None => None,
        };
        Ok(Session {
            id,
            doc,
            writer,
            seq: 0,
            entries_since_snapshot: 0,
            last_snapshot: Instant::now(),
            policy: SnapshotPolicy::default(),
            warning: None,
        })
    }

    pub fn with_policy(mut self, policy: SnapshotPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn doc(&self) -> &Document {
        &self.doc
    }

    pub fn is_protected(&self) -> bool {
        self.writer.is_some()
    }

    pub fn take_warning(&mut self) -> Option<String> {
        self.warning.take()
    }

    /// Runs an editing command and streams its changes to the journal.
    pub fn edit<R>(&mut self, f: impl FnOnce(&mut Document) -> R) -> R {
        let result = f(&mut self.doc);
        self.persist();
        result
    }

    fn persist(&mut self) {
        let entries = self.doc.take_pending();
        if entries.is_empty() {
            return;
        }
        if let Some(writer) = &self.writer {
            for entry in entries {
                self.seq += 1;
                self.entries_since_snapshot += 1;
                if let Err(e) = writer.append(&JournalRecord {
                    seq: self.seq,
                    entry,
                }) {
                    self.warning = Some(e.to_string());
                }
            }
        }
        if self.entries_since_snapshot >= self.policy.max_entries
            || self.last_snapshot.elapsed() >= self.policy.max_age
        {
            self.snapshot_now();
        }
    }

    /// Writes a full snapshot and truncates the journal.
    pub fn snapshot_now(&mut self) {
        if let Some(writer) = &mut self.writer {
            if let Err(e) = writer.snapshot(self.seq, &self.doc, now_ms()) {
                self.warning = Some(e.to_string());
            }
        }
        self.entries_since_snapshot = 0;
        self.last_snapshot = Instant::now();
    }

    /// Saves to `path` (atomically) and marks the document clean.
    pub fn save(&mut self, path: &Path) -> Result<(), FileError> {
        file::save_score(path, &self.doc.score)?;
        self.doc.mark_saved(path.to_path_buf());
        self.snapshot_now();
        Ok(())
    }

    /// Waits until all recovery data queued so far is on disk.
    pub fn sync(&self) -> std::io::Result<()> {
        match &self.writer {
            Some(w) => w.sync(),
            None => Ok(()),
        }
    }

    /// Closes the session. The recovery data is deleted: call this only
    /// after the user saved or chose to discard their changes.
    pub fn close(mut self) -> std::io::Result<()> {
        match self.writer.take() {
            Some(w) => w.close(true),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::Move;
    use crate::model::{Duration as Dur, DurationBase, Score, Step};

    const Q: Dur = Dur {
        base: DurationBase::Quarter,
        dots: 0,
        tuplet: None,
    };

    fn store(dir: &Path) -> RecoveryStore {
        RecoveryStore::open(dir)
            .unwrap()
            .with_sync_interval(Duration::from_millis(10))
    }

    /// Simulates a crash: the process disappears without closing anything.
    fn crash(session: Session) {
        session.sync().unwrap();
        // Dropping the writer without `close` keeps the directory (and
        // releases the lock, exactly as the OS does when a process dies).
        drop(session);
    }

    #[test]
    fn work_survives_a_crash_including_undo_history() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Etude", 2)), Some(&store)).unwrap();
        s.edit(|d| {
            for (i, step) in [Step::C, Step::D, Step::E].into_iter().enumerate() {
                d.insert_note(step, Q, i as u64 * 100).unwrap();
            }
        });
        s.edit(|d| d.move_caret(Move::Left, false));
        s.edit(|d| d.delete_backward(5_000).unwrap());
        let expected = s.doc().score.clone();
        crash(s);

        let found = store.scan();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest.as_ref().unwrap().display_name, "Etude");
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.score, expected);
        // Three typed notes (one undo step, but one journal entry each) + delete.
        assert_eq!(loaded.replayed, 4);
        // Undo history came back too.
        let mut doc = loaded.document;
        doc.undo().unwrap();
        assert_eq!(doc.score.voice(0, 0, 0).unwrap().len(), 3);
    }

    #[test]
    fn text_styles_and_boxes_survive_a_crash() {
        use crate::model::{TextAlign, TextBox, TextKind, TextStyle};
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Nocturne", 1)), Some(&store)).unwrap();
        s.edit(|d| {
            d.set_text_style(
                TextKind::Expression,
                TextStyle {
                    font: "Garamond".into(),
                    ..TextStyle::default()
                },
                1_000,
            )
            .unwrap()
        });
        s.edit(|d| {
            d.set_text_box(
                TextBox {
                    id: 0,
                    page: 0,
                    x: 200,
                    y: 2700,
                    text: "Ped. ad lib.".into(),
                    style: TextStyle::default(),
                    align: TextAlign::Right,
                    frame: true,
                },
                2_000,
            )
            .unwrap()
        });
        let expected = s.doc().score.clone();
        crash(s);
        let found = store.scan();
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.score, expected);
    }

    #[test]
    fn note_texts_and_rehearsal_marks_survive_a_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Air", 2)), Some(&store)).unwrap();
        s.edit(|d| d.insert_note(Step::A, Q, 0).unwrap());
        let id = s.doc().score.voice(0, 0, 0).unwrap()[0].id;
        s.edit(|d| {
            d.set_note_text(
                id,
                crate::model::NoteTextKind::Expression,
                "cantabile",
                1_000,
            )
            .unwrap()
        });
        s.edit(|d| d.set_rehearsal(1, Some("B".into()), 2_000).unwrap());
        s.edit(|d| {
            d.set_barline(0, 0, crate::model::Barline::Double, 3_000)
                .unwrap()
        });
        s.edit(|d| d.set_repeat(0, 1, true, Some(3), 4_000).unwrap());
        s.edit(|d| d.set_ending(1, 1, &[1, 2], true, 5_000).unwrap());
        s.edit(|d| {
            d.set_jumps(
                1,
                true,
                false,
                Some(crate::model::Jump::DaCapoAlFine),
                6_000,
            )
            .unwrap()
        });
        s.edit(|d| d.set_measure_length(0, Some(960), 7_000).unwrap());
        s.edit(|d| {
            d.set_break(0, Some(crate::model::LayoutBreak::Page), 8_000)
                .unwrap()
        });
        let expected = s.doc().score.clone();
        crash(s);
        let found = store.scan();
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.score, expected);
    }

    #[test]
    fn tempo_markings_survive_a_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Rondo", 2)), Some(&store)).unwrap();
        let mark = crate::model::TempoMark {
            text: "Allegretto".into(),
            bpm: Some(108),
            beat: crate::model::BeatUnit::DottedQuarter,
            show_text: true,
            show_metronome: false,
        };
        s.edit(|d| d.set_tempo_mark(1, Some(mark.clone()), 1_000).unwrap());
        crash(s);
        let found = store.scan();
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.score.measures[1].tempo, Some(mark));
    }

    #[test]
    fn page_texts_survive_a_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Lied", 1)), Some(&store)).unwrap();
        let mut metadata = s.doc().score.metadata.clone();
        metadata.subtitle = "Op. 3".into();
        metadata.footer = "{title} · {page}/{pages}".into();
        metadata.page_numbers.first_page = true;
        s.edit(|d| d.set_metadata(metadata.clone(), 1_000).unwrap());
        crash(s);
        let found = store.scan();
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.score.metadata, metadata);
    }

    #[test]
    fn snapshots_truncate_journal_and_recovery_still_works() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Long", 1)), Some(&store))
            .unwrap()
            .with_policy(SnapshotPolicy {
                max_entries: 3,
                max_age: Duration::from_secs(3600),
            });
        for i in 0..10u64 {
            // Each note far apart in time so each is its own undo step.
            s.edit(|d| d.insert_note(Step::G, Q, i * 10_000).unwrap());
        }
        let expected = s.doc().score.clone();
        crash(s);
        let found = store.scan();
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.score, expected);
        assert!(
            loaded.replayed < 3,
            "most work should come from the snapshot"
        );
    }

    #[test]
    fn running_sessions_are_not_offered_for_recovery() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let mut s = Session::start(Document::new(Score::new("Live", 1)), Some(&store)).unwrap();
        s.edit(|d| d.insert_note(Step::A, Q, 0).unwrap());
        s.sync().unwrap();
        assert!(store.scan().is_empty());
        assert!(matches!(store.load(s.id()), Err(RecoveryError::InUse)));
        s.close().unwrap();
        assert!(store.scan().is_empty());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[test]
    fn clean_orphans_are_removed_silently() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let file = tmp.path().join("piece.partita");
        let mut s = Session::start(Document::new(Score::new("Piece", 1)), Some(&store)).unwrap();
        s.edit(|d| d.insert_note(Step::A, Q, 0).unwrap());
        s.save(&file).unwrap();
        crash(s);
        assert!(store.scan().is_empty());
    }

    #[test]
    fn save_then_more_edits_recovers_path_and_dirty_state() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(tmp.path());
        let file = tmp.path().join("piece.partita");
        let mut s = Session::start(Document::new(Score::new("Piece", 1)), Some(&store)).unwrap();
        s.edit(|d| d.insert_note(Step::A, Q, 0).unwrap());
        s.save(&file).unwrap();
        s.edit(|d| d.insert_note(Step::B, Q, 10_000).unwrap());
        crash(s);
        let found = store.scan();
        assert_eq!(found.len(), 1);
        let loaded = store.load(found[0].session_id).unwrap();
        assert_eq!(loaded.document.path.as_deref(), Some(file.as_path()));
        assert!(loaded.document.is_dirty());
        assert_eq!(loaded.document.score.voice(0, 0, 0).unwrap().len(), 2);
        // The file on disk still has the saved version.
        assert_eq!(
            file::load_score(&file)
                .unwrap()
                .voice(0, 0, 0)
                .unwrap()
                .len(),
            1
        );
    }
}
