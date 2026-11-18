//! The `.partita` document format and crash-safe file writing.
//!
//! Until 0.2.2 the project was called Da Capo and its files were `.dacapo`
//! with the marker `"dacapo"`. They are the same format and still load.
//!
//! A `.partita` file is UTF-8 JSON with a format marker and version so future
//! releases can migrate old files:
//!
//! ```json
//! { "format": "partita", "format_version": 1, "score": { ... } }
//! ```

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{Issue, Score};

/// File extension of Partita documents (without the dot).
pub const FILE_EXTENSION: &str = "partita";
/// Version written by this build.
/// History:
/// - 1: initial format.
/// - 2: ties, articulations and dynamics on events; slurs on the score.
///   Version 1 files load unchanged (the new fields default to empty).
/// - 3: playback tempo on the score (older files get the default, 100).
/// - 4: breve and 128th note values. Only files that use them are written
///   as version 4, so everything else still opens in older versions.
/// - 5: lyrics on events. As with version 4, only files that have lyrics
///   are written as version 5.
/// - 6: staff instruments, short names, transpositions and brackets or
///   braces. Only files that use one of them are written as version 6.
/// - 7: page texts in the metadata (subtitle, dedication, lyricist, part,
///   copyright, running header and footer, and page numbering), tempo
///   markings and rehearsal marks on measures, texts on notes, text styles
///   and text boxes. Only files that use one of them are written as
///   version 7.
pub const FORMAT_VERSION: u32 = 7;
const FORMAT_MARKER: &str = "partita";
/// Marker written by Da Capo (the project's former name) up to 0.2.2.
const LEGACY_FORMAT_MARKER: &str = "dacapo";

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    format_version: u32,
    score: Score,
}

#[derive(Debug, Error)]
pub enum FileError {
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
    #[error("not a valid Partita file: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("not a Partita file")]
    WrongFormat,
    #[error("file was written by a newer version of Partita (format {0})")]
    TooNew(u32),
    #[error("file is damaged: {0}")]
    Corrupt(String),
}

/// Serializes a score into the `.partita` format.
pub fn to_bytes(score: &Score) -> Result<Vec<u8>, FileError> {
    let envelope = Envelope {
        format: FORMAT_MARKER.to_string(),
        format_version: required_version(score),
        score: score.clone(),
    };
    Ok(serde_json::to_vec_pretty(&envelope)?)
}

/// The oldest format version that can represent `score`.
fn required_version(score: &Score) -> u32 {
    let any_event = |test: fn(&crate::model::Event) -> bool| {
        score.staves.iter().any(|staff| {
            staff
                .measures
                .iter()
                .any(|m| m.voices.iter().any(|v| v.iter().any(test)))
        })
    };
    if score.metadata.uses_page_texts() || score.has_markings() {
        7
    } else if score.staves.iter().any(|s| {
        s.instrument != 0
            || !s.short_name.is_empty()
            || !s.transposition.is_none()
            || s.group.is_some()
    }) {
        6
    } else if any_event(|e| e.has_lyrics()) {
        5
    } else if any_event(|e| e.duration.base.is_extended()) {
        4
    } else {
        3
    }
}

/// Parses and validates a `.partita` document.
pub fn from_bytes(bytes: &[u8]) -> Result<Score, FileError> {
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    if envelope.format != FORMAT_MARKER && envelope.format != LEGACY_FORMAT_MARKER {
        return Err(FileError::WrongFormat);
    }
    if envelope.format_version > FORMAT_VERSION {
        return Err(FileError::TooNew(envelope.format_version));
    }
    let score = envelope.score;
    if score.staves.is_empty() || score.measures.is_empty() {
        return Err(FileError::Corrupt("score has no staves or measures".into()));
    }
    if let Some(Issue::Structure { message }) = score
        .validate()
        .into_iter()
        .find(|i| matches!(i, Issue::Structure { .. }))
    {
        return Err(FileError::Corrupt(message));
    }
    Ok(score)
}

/// Saves a score atomically. The previous version of the file, if any, is
/// kept next to it as `<name>.bak`.
pub fn save_score(path: &Path, score: &Score) -> Result<(), FileError> {
    let bytes = to_bytes(score)?;
    if path.exists() {
        // Best effort: a failed backup must not prevent saving.
        let _ = fs::copy(path, sibling(path, ".bak"));
    }
    atomic_write(path, &bytes)?;
    Ok(())
}

pub fn load_score(path: &Path) -> Result<Score, FileError> {
    from_bytes(&fs::read(path)?)
}

/// `path` with `suffix` appended to the file name.
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Writes a file so that, whatever happens (crash, power loss), the target
/// holds either the complete old content or the complete new content:
/// write a temporary file next to it, flush it to disk, then rename it over
/// the target.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = sibling(path, ".tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    sync_parent_dir(path);
    Ok(())
}

/// Makes the rename itself durable (needed on Unix; Windows/NTFS journals
/// metadata and does not allow opening directories this way).
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.partita");
        let score = Score::new("Song", 3);
        save_score(&path, &score).unwrap();
        assert_eq!(load_score(&path).unwrap(), score);
        // Second save keeps a backup and leaves no temp file behind.
        save_score(&path, &score).unwrap();
        assert!(sibling(&path, ".bak").exists());
        assert!(!sibling(&path, ".tmp").exists());
    }

    #[test]
    fn loads_files_saved_as_da_capo() {
        let score = Score::new("Old name", 2);
        let mut v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        assert_eq!(v["format"], "partita");
        v["format"] = "dacapo".into();
        let bytes = serde_json::to_vec(&v).unwrap();
        assert_eq!(from_bytes(&bytes).unwrap(), score);
    }

    #[test]
    fn loads_version_1_files() {
        use crate::model::{Duration, DurationBase, Event, EventKind, Pitch, Step};
        let mut score = Score::new("Old", 1);
        let e = Event::new(
            7,
            Duration::new(DurationBase::Quarter),
            EventKind::Chord {
                pitches: vec![Pitch::new(Step::C, 4)],
            },
        );
        score.staves[0].measures[0].voices[0].push(e);
        // Write it as a version 1 file would look: no slurs, no event extras.
        let mut v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        v["format_version"] = 1.into();
        v["score"].as_object_mut().unwrap().remove("slurs");
        v["score"].as_object_mut().unwrap().remove("tempo");
        let ev = &mut v["score"]["staves"][0]["measures"][0]["voices"][0][0];
        for k in ["tie", "articulations", "dynamic"] {
            ev.as_object_mut().unwrap().remove(k);
        }
        let loaded = from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(loaded, score);
    }

    #[test]
    fn breve_and_128th_need_format_4_only_when_used() {
        use crate::model::{Duration, DurationBase, Event, EventKind, Pitch, Step};
        let version = |score: &Score| -> u64 {
            let v: serde_json::Value = serde_json::from_slice(&to_bytes(score).unwrap()).unwrap();
            v["format_version"].as_u64().unwrap()
        };
        let mut score = Score::new("Song", 1);
        assert_eq!(version(&score), 3);
        let note = |id, base| {
            Event::new(
                id,
                Duration::new(base),
                EventKind::Chord {
                    pitches: vec![Pitch::new(Step::C, 4)],
                },
            )
        };
        score.staves[0].measures[0].voices[0].push(note(1, DurationBase::Breve));
        score.staves[0].measures[0].voices[0].push(note(2, DurationBase::HundredTwentyEighth));
        assert_eq!(version(&score), 4);
        assert_eq!(from_bytes(&to_bytes(&score).unwrap()).unwrap(), score);
    }

    #[test]
    fn lyrics_need_format_5_only_when_used() {
        use crate::model::{
            Duration, DurationBase, Event, EventKind, LyricJoin, Pitch, Step, Syllable,
        };
        let version = |score: &Score| -> u64 {
            let v: serde_json::Value = serde_json::from_slice(&to_bytes(score).unwrap()).unwrap();
            v["format_version"].as_u64().unwrap()
        };
        let mut score = Score::new("Song", 1);
        let mut note = Event::new(
            1,
            Duration::new(DurationBase::Quarter),
            EventKind::Chord {
                pitches: vec![Pitch::new(Step::C, 4)],
            },
        );
        score.staves[0].measures[0].voices[0].push(note.clone());
        assert_eq!(version(&score), 3);

        note.lyrics = vec![
            Syllable::default(),
            Syllable {
                text: "Glo".into(),
                join: LyricJoin::Hyphen,
            },
        ];
        score.staves[0].measures[0].voices[0][0] = note;
        assert_eq!(version(&score), 5);
        assert_eq!(from_bytes(&to_bytes(&score).unwrap()).unwrap(), score);

        // Files written before lyrics existed have no such field.
        let mut v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        let event = &mut v["score"]["staves"][0]["measures"][0]["voices"][0][0];
        event.as_object_mut().unwrap().remove("lyrics");
        let old = from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(old.staves[0].measures[0].voices[0][0].lyrics.is_empty());
    }

    #[test]
    fn instruments_need_format_6_only_when_used() {
        let mut score = Score::new("Band", 1);
        let v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        assert_eq!(v["format_version"], 3);
        score.staves[0].instrument = 73; // flute
        let bytes = to_bytes(&score).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format_version"], 6);
        assert_eq!(from_bytes(&bytes).unwrap(), score);
        // Files without the field (older versions) play the piano.
        let mut v = v;
        v["score"]["staves"][0]
            .as_object_mut()
            .unwrap()
            .remove("instrument");
        let old = from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(old.staves[0].instrument, 0);
    }

    #[test]
    fn page_texts_need_format_7_only_when_used() {
        let mut score = Score::new("Suite", 1);
        score.metadata.composer = "Anon".into();
        let v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        assert_eq!(
            v["format_version"], 3,
            "title and composer are older than page texts"
        );

        score.metadata.footer = "{title} · {page}/{pages}".into();
        score.metadata.page_numbers.edge = crate::model::PageEdge::Bottom;
        let bytes = to_bytes(&score).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format_version"], 7);
        assert_eq!(from_bytes(&bytes).unwrap(), score);

        // Files from before page texts have only a title and a composer:
        // pages are numbered as they always were.
        let mut v = v;
        v["score"]["metadata"] = serde_json::json!({ "title": "Suite", "composer": "Anon" });
        let old = from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(old.metadata.title, "Suite");
        assert!(old.metadata.footer.is_empty());
        assert_eq!(
            old.metadata.page_numbers,
            crate::model::PageNumbers::default()
        );
        assert!(!old.metadata.uses_page_texts());
    }

    #[test]
    fn tempo_markings_need_format_7_only_when_used() {
        let mut score = Score::new("Etude", 2);
        let v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        assert_eq!(v["format_version"], 3);
        score.measures[1].tempo = Some(crate::model::TempoMark {
            text: "Allegro".into(),
            bpm: Some(132),
            ..Default::default()
        });
        let bytes = to_bytes(&score).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format_version"], 7);
        assert_eq!(from_bytes(&bytes).unwrap(), score);
        // Files from before tempo markings have measures without the field.
        let mut v = v;
        for m in v["score"]["measures"].as_array_mut().unwrap() {
            m.as_object_mut().unwrap().remove("tempo");
        }
        let old = from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(!old.has_tempo_marks());
    }

    #[test]
    fn note_texts_and_rehearsal_marks_need_format_7() {
        let mut score = Score::new("Etude", 1);
        score.measures[0].rehearsal = Some("A".into());
        let v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        assert_eq!(v["format_version"], 7);
        assert_eq!(from_bytes(&to_bytes(&score).unwrap()).unwrap(), score);
    }

    #[test]
    fn barlines_need_format_7() {
        let mut score = Score::new("Etude", 2);
        let plain =
            serde_json::from_slice::<serde_json::Value>(&to_bytes(&score).unwrap()).unwrap();
        assert!(
            plain["format_version"].as_u64().unwrap() < 7,
            "single barlines need nothing new"
        );
        score.measures[0].barline = crate::model::Barline::Double;
        let v: serde_json::Value = serde_json::from_slice(&to_bytes(&score).unwrap()).unwrap();
        assert_eq!(v["format_version"], 7);
        assert_eq!(from_bytes(&to_bytes(&score).unwrap()).unwrap(), score);
    }

    #[test]
    fn text_styles_and_boxes_need_format_7() {
        let mut score = Score::new("Etude", 1);
        score.text_styles.insert(
            crate::model::TextKind::Tempo,
            crate::model::TextStyle {
                size: 85,
                ..Default::default()
            },
        );
        let bytes = to_bytes(&score).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format_version"], 7);
        assert_eq!(v["score"]["text_styles"]["tempo"]["size"], 85);
        assert_eq!(from_bytes(&bytes).unwrap(), score);
        // Files from before have neither field.
        let mut v = v;
        let s = v["score"].as_object_mut().unwrap();
        s.remove("text_styles");
        s.remove("text_boxes");
        let old = from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(old.text_styles.is_empty() && old.text_boxes.is_empty());
    }

    #[test]
    fn rejects_foreign_and_future_files() {
        assert!(matches!(
            from_bytes(b"{\"format\":\"x\",\"format_version\":1,\"score\":null}"),
            Err(FileError::Parse(_))
        ));
        let mut v: serde_json::Value =
            serde_json::from_slice(&to_bytes(&Score::new("a", 1)).unwrap()).unwrap();
        v["format_version"] = 99.into();
        assert!(matches!(
            from_bytes(&serde_json::to_vec(&v).unwrap()),
            Err(FileError::TooNew(99))
        ));
        v["format"] = "other".into();
        assert!(matches!(
            from_bytes(&serde_json::to_vec(&v).unwrap()),
            Err(FileError::WrongFormat)
        ));
    }
}
