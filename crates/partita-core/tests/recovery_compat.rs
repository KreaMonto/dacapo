//! Recovery data written by older releases must stay readable: an in-app
//! update restarts the program and gives unsaved work back through crash
//! recovery, so a format change must never strand it.

use std::path::{Path, PathBuf};

use partita_core::document::Document;
use partita_core::file;
use partita_core::model::{
    Barline, Duration, DurationBase, Jump, LayoutBreak, Metadata, NoteTextKind, Score, Step,
    TempoMark, TextAlign, TextBox, TextKind, TextStyle,
};
use partita_core::recovery::{load_dir, RecoveryStore};
use partita_core::session::Session;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// `recovery-0.2.1` was written by Da Capo 0.2.1 (binary format 3, before
/// lyrics): a snapshot with notes, a tie and an articulation, and a journal
/// that adds a rest, a chord, a dynamic and a slur, then a note that is
/// undone. `expected.dacapo` is the score that session held.
#[test]
fn reads_recovery_data_from_0_2_1() {
    let dir = fixture("recovery-0.2.1");
    let loaded = load_dir(&dir).expect("0.2.1 recovery data loads");
    assert!(!loaded.truncated, "no record was dropped");
    assert!(loaded.replayed > 0, "the journal was replayed");

    let expected = file::load_score(&dir.join("expected.dacapo")).unwrap();
    assert_eq!(loaded.document.score, expected);
    // The undo history came back too.
    assert!(loaded.document.can_undo());
    assert!(loaded.document.can_redo());
    assert!(loaded.document.is_dirty());
}

/// `recovery-0.2.2` was written by Da Capo 0.2.2 (binary format 4, before
/// staff instruments): a snapshot with two staves, and a journal with
/// notes, a lyric, a dynamic, a staff added and renamed, and a note that
/// is undone. `expected.partita` is the score that session held.
#[test]
fn reads_recovery_data_from_0_2_2() {
    let dir = fixture("recovery-0.2.2");
    let loaded = load_dir(&dir).expect("0.2.2 recovery data loads");
    assert!(!loaded.truncated, "no record was dropped");
    assert!(loaded.replayed > 0, "the journal was replayed");

    let expected = file::load_score(&dir.join("expected.partita")).unwrap();
    assert_eq!(loaded.document.score, expected);
    assert_eq!(loaded.document.score.staves.len(), 3);
    assert!(loaded
        .document
        .score
        .staves
        .iter()
        .all(|s| s.instrument == 0));
    assert!(loaded.document.can_undo());
    assert!(loaded.document.can_redo());
}

/// `recovery-0.3.0` is in binary format 5, the layout of Partita 0.3.0
/// (before page texts): a snapshot of a new score, and a journal with two
/// notes, a lyric, a dynamic, a new title and composer, a violin staff, and
/// a note that is undone. `expected.partita` is the score that session held.
#[test]
fn reads_recovery_data_from_0_3_0() {
    let dir = fixture("recovery-0.3.0");
    let loaded = load_dir(&dir).expect("0.3.0 recovery data loads");
    assert!(!loaded.truncated, "no record was dropped");
    assert!(loaded.replayed > 0, "the journal was replayed");

    let expected = file::load_score(&dir.join("expected.partita")).unwrap();
    assert_eq!(loaded.document.score, expected);
    assert_eq!(loaded.document.score.metadata.title, "Sonatina");
    assert_eq!(loaded.document.score.metadata.composer, "Anonymous");
    assert_eq!(loaded.document.score.staves[1].instrument, 40);
    assert!(loaded.document.can_undo());
    assert!(loaded.document.can_redo());
}

/// The session behind `recovery-0.3.14` (binary format 15, the layout of
/// Partita 0.3.14): a new score, then most of what 0.3.14 added: page
/// texts, a tempo marking, words on a note, a rehearsal mark, a text style,
/// a text box, barlines, a repeat with endings, jumps, a pickup and a page
/// break, and a note that is undone.
fn session_0_3_14(store: &RecoveryStore) -> Session {
    let q = Duration::new(DurationBase::Quarter);
    let mut s = Session::start(Document::new(Score::new("Untitled", 6)), Some(store)).unwrap();
    s.edit(|d| {
        d.set_metadata(
            Metadata {
                title: "Rondino".into(),
                subtitle: "for the 0.3.14 fixture".into(),
                composer: "Anonymous".into(),
                ..d.score.metadata.clone()
            },
            100,
        )
        .unwrap()
    });
    s.edit(|d| d.insert_note(Step::G, q, 200).unwrap());
    let id = s.doc().score.voice(0, 0, 0).unwrap()[0].id;
    s.edit(|d| d.set_measure_length(0, Some(960), 300).unwrap());
    s.edit(|d| d.insert_note(Step::C, q, 400).unwrap());
    s.edit(|d| {
        d.set_note_text(id, NoteTextKind::Expression, "dolce", 500)
            .unwrap()
    });
    s.edit(|d| {
        d.set_tempo_mark(
            0,
            Some(TempoMark {
                text: "Allegretto".into(),
                bpm: Some(108),
                ..TempoMark::default()
            }),
            600,
        )
        .unwrap()
    });
    s.edit(|d| d.set_rehearsal(1, Some("A".into()), 700).unwrap());
    s.edit(|d| {
        d.set_text_style(
            TextKind::Tempo,
            TextStyle {
                size: 110,
                ..TextStyle::default()
            },
            800,
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
                text: "Fixture".into(),
                style: TextStyle::default(),
                align: TextAlign::default(),
                frame: true,
            },
            900,
        )
        .unwrap()
    });
    s.edit(|d| d.set_barline(1, 1, Barline::Double, 1_000).unwrap());
    s.edit(|d| d.set_repeat(1, 2, true, Some(2), 1_100).unwrap());
    s.edit(|d| d.set_ending(2, 2, &[1], true, 1_200).unwrap());
    s.edit(|d| d.set_ending(3, 3, &[2], false, 1_300).unwrap());
    s.edit(|d| d.set_jumps(1, true, false, None, 1_400).unwrap());
    s.edit(|d| {
        d.set_jumps(4, false, false, Some(Jump::DalSegnoAlFine), 1_500)
            .unwrap()
    });
    s.edit(|d| d.set_break(2, Some(LayoutBreak::Page), 1_600).unwrap());
    s.edit(|d| d.insert_note(Step::E, q, 1_700).unwrap());
    s.edit(|d| d.undo().unwrap());
    s
}

/// Writes `recovery-0.3.14`. Run once, on the 0.3.14 code:
/// `cargo test -p partita-core --test recovery_compat -- --ignored write_fixture`.
#[test]
#[ignore]
fn write_fixture_0_3_14() {
    let tmp = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(tmp.path()).unwrap();
    let s = session_0_3_14(&store);
    let expected = s.doc().score.clone();
    s.sync().unwrap();
    // Dropped without closing, as when the program dies.
    drop(s);
    let found = store.scan();
    let session = tmp.path().join(found[0].session_id.to_string());
    let out = fixture("recovery-0.3.14");
    std::fs::create_dir_all(&out).unwrap();
    for name in ["snapshot.bin", "journal.bin"] {
        std::fs::copy(session.join(name), out.join(name)).unwrap();
    }
    file::save_score(&out.join("expected.partita"), &expected).unwrap();
}

/// `recovery-0.3.14` is in binary format 15, the layout of Partita 0.3.14:
/// see [`session_0_3_14`] for what it holds.
#[test]
fn reads_recovery_data_from_0_3_14() {
    let dir = fixture("recovery-0.3.14");
    let loaded = load_dir(&dir).expect("0.3.14 recovery data loads");
    assert!(!loaded.truncated, "no record was dropped");
    assert!(loaded.replayed > 0, "the journal was replayed");

    let expected = file::load_score(&dir.join("expected.partita")).unwrap();
    let score = &loaded.document.score;
    assert_eq!(*score, expected);
    assert_eq!(score.metadata.title, "Rondino");
    assert_eq!(score.measures[0].length, Some(960));
    assert!(score.measures[1].repeat_start && score.measures[1].segno);
    assert_eq!(score.measures[2].ending, vec![1]);
    assert_eq!(score.measures[4].jump, Some(Jump::DalSegnoAlFine));
    assert_eq!(score.measures[2].break_after, Some(LayoutBreak::Page));
    assert_eq!(score.text_boxes.len(), 1);
    assert!(loaded.document.can_undo());
    assert!(loaded.document.can_redo());
}
