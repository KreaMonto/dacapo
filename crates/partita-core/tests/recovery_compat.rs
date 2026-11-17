//! Recovery data written by older releases must stay readable: an in-app
//! update restarts the program and gives unsaved work back through crash
//! recovery, so a format change must never strand it.

use std::path::{Path, PathBuf};

use partita_core::file;
use partita_core::recovery::load_dir;

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
