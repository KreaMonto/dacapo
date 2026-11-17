//! An open document: score + caret + selection + undo history.
//!
//! All user-facing editing commands live here. Each command turns into a
//! list of [`Op`]s that is applied atomically and recorded both in the undo
//! history and in a list of pending [`JournalEntry`]s, which the
//! [`crate::session::Session`] streams to the crash-recovery journal.
//! Replaying the same entries on the same starting document reproduces the
//! exact same state, including the undo history.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::cursor::{self, Caret, Move, SelectionRange};
use crate::history::{History, Transaction, TxKind};
use crate::model::{
    is_measure_rest, Articulation, Clef, Duration, Dynamic, Event, EventId, EventKind, GroupKind,
    KeySignature, LyricJoin, Metadata, Pitch, Score, Slur, StaffGroup, Step, Syllable,
    TimeSignature, Transposition, MAX_STAFF_NAME_CHARS, MAX_SYLLABLE_CHARS, MAX_VERSES,
};
use crate::ops::{apply_all, Op, OpError, VoiceLoc};

/// One durable change, as written to the recovery journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalEntry {
    Commit {
        kind: TxKind,
        ops: Vec<Op>,
        caret_before: Caret,
        caret_after: Caret,
        time_ms: u64,
        merge: bool,
    },
    Undo,
    Redo,
}

/// Errors returned by editing commands.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum EditError {
    #[error(transparent)]
    Op(#[from] OpError),
    #[error("invalid time signature")]
    InvalidTime,
    #[error("Select the notes to slur first (Shift+arrows or drag)")]
    SlurNeedsSelection,
    #[error("A slur needs at least two notes")]
    SlurTooShort,
}

/// Music copied with Ctrl+C: one list of events per selected staff.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clipboard {
    pub staves: Vec<Vec<Event>>,
}

impl Clipboard {
    pub fn is_empty(&self) -> bool {
        self.staves.iter().all(Vec::is_empty)
    }
}

/// An open score with its editing state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub score: Score,
    caret: Caret,
    /// Selection anchor; the caret is the other end.
    anchor: Option<Caret>,
    history: History,
    /// Bumped on every change (edit, undo, redo).
    revision: u64,
    saved_revision: u64,
    /// File on disk, `None` for untitled documents.
    pub path: Option<PathBuf>,
    #[serde(skip)]
    pending: Vec<JournalEntry>,
}

const SHARP_ORDER: [Step; 7] = [
    Step::F,
    Step::C,
    Step::G,
    Step::D,
    Step::A,
    Step::E,
    Step::B,
];

/// Alteration that the key signature implies for a step.
pub fn key_alter(key: KeySignature, step: Step) -> i8 {
    let n = key.fifths.unsigned_abs().min(7) as usize;
    if key.fifths > 0 && SHARP_ORDER[..n].contains(&step) {
        1
    } else if key.fifths < 0 && SHARP_ORDER.iter().rev().take(n).any(|s| *s == step) {
        -1
    } else {
        0
    }
}

/// The octave of `step` closest to `reference` (ties go up), the way
/// letter-key note entry works in most notation programs.
pub fn nearest_pitch(step: Step, reference: Pitch) -> Pitch {
    let r = reference.diatonic_index();
    let base = r.div_euclid(7) * 7 + step.index();
    let best = [base - 7, base, base + 7]
        .into_iter()
        .min_by_key(|c| ((c - r).abs(), if *c >= r { 0 } else { 1 }))
        .unwrap();
    Pitch::from_diatonic_index(best)
}

/// What the staff dialog edits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaffProps {
    pub name: String,
    #[serde(default)]
    pub short_name: String,
    #[serde(default)]
    pub instrument: u8,
    pub clef: Clef,
    #[serde(default)]
    pub transposition: Transposition,
}

impl Document {
    pub fn new(score: Score) -> Self {
        Document {
            score,
            caret: Caret::default(),
            anchor: None,
            history: History::default(),
            revision: 0,
            saved_revision: 0,
            path: None,
            pending: Vec::new(),
        }
    }

    /// Document freshly loaded from `path`: clean, empty history.
    pub fn opened(score: Score, path: PathBuf) -> Self {
        Document {
            path: Some(path),
            ..Document::new(score)
        }
    }

    // ----- state ---------------------------------------------------------

    pub fn caret(&self) -> Caret {
        self.caret
    }

    pub fn anchor(&self) -> Option<Caret> {
        self.anchor
    }

    pub fn selection(&self) -> Option<SelectionRange> {
        let anchor = self.anchor?;
        cursor::selection_range(&self.score, &anchor, &self.caret)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn is_dirty(&self) -> bool {
        self.revision != self.saved_revision
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Display name: file name, else score title, else "Untitled".
    pub fn display_name(&self) -> String {
        if let Some(name) = self.path.as_ref().and_then(|p| p.file_stem()) {
            return name.to_string_lossy().into_owned();
        }
        if !self.score.metadata.title.trim().is_empty() {
            return self.score.metadata.title.clone();
        }
        "Untitled".to_string()
    }

    /// Records that the current state is what is on disk at `path`.
    pub fn mark_saved(&mut self, path: PathBuf) {
        self.path = Some(path);
        self.saved_revision = self.revision;
        self.history.seal();
    }

    /// Journal entries produced since the last call.
    pub fn take_pending(&mut self) -> Vec<JournalEntry> {
        std::mem::take(&mut self.pending)
    }

    // ----- core plumbing -------------------------------------------------

    fn commit(
        &mut self,
        kind: TxKind,
        ops: Vec<Op>,
        caret_after: Caret,
        time_ms: u64,
        keep_selection: bool,
    ) -> Result<(), EditError> {
        let anchor = self.anchor;
        if ops.is_empty() {
            self.set_caret(caret_after, false);
            return Ok(());
        }
        let caret_before = self.caret;
        let merge = self.history.would_merge(kind, &caret_before, time_ms);
        let mut ops = ops;
        let mut inverse = apply_all(&mut self.score, &ops)?;
        // Slurs whose start or end event was just deleted disappear in the
        // same step, so undo brings back both the notes and their slurs.
        let cleanup = self.dangling_slur_ops();
        if !cleanup.is_empty() {
            let mut undo_cleanup = apply_all(&mut self.score, &cleanup)?;
            ops.extend(cleanup);
            undo_cleanup.append(&mut inverse);
            inverse = undo_cleanup;
        }
        let caret_after = self.record(
            kind,
            ops.clone(),
            inverse,
            caret_before,
            caret_after,
            time_ms,
            merge,
        );
        self.pending.push(JournalEntry::Commit {
            kind,
            ops,
            caret_before,
            caret_after,
            time_ms,
            merge,
        });
        if keep_selection {
            self.anchor = anchor.map(|a| cursor::clamp(&self.score, a));
        }
        Ok(())
    }

    fn apply_commit(
        &mut self,
        kind: TxKind,
        ops: Vec<Op>,
        caret_before: Caret,
        caret_after: Caret,
        time_ms: u64,
        merge: bool,
    ) -> Result<Caret, EditError> {
        let inverse = apply_all(&mut self.score, &ops)?;
        Ok(self.record(
            kind,
            ops,
            inverse,
            caret_before,
            caret_after,
            time_ms,
            merge,
        ))
    }

    /// RemoveSlur ops for slurs that point to events no longer in the score,
    /// highest index first so the indices stay valid.
    fn dangling_slur_ops(&self) -> Vec<Op> {
        if self.score.slurs.is_empty() {
            return Vec::new();
        }
        let ids = self.score.event_ids();
        self.score
            .slurs
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, s)| !ids.contains(&s.start) || !ids.contains(&s.end))
            .map(|(index, _)| Op::RemoveSlur { index })
            .collect()
    }

    /// Stores an applied step in the history and moves the caret.
    #[allow(clippy::too_many_arguments)]
    fn record(
        &mut self,
        kind: TxKind,
        ops: Vec<Op>,
        inverse: Vec<Op>,
        caret_before: Caret,
        caret_after: Caret,
        time_ms: u64,
        merge: bool,
    ) -> Caret {
        let caret_after = cursor::clamp(&self.score, caret_after);
        self.history.push(
            Transaction {
                kind,
                forward: ops,
                inverse,
                caret_before,
                caret_after,
                time_ms,
            },
            merge,
        );
        self.caret = caret_after;
        self.anchor = None;
        self.revision += 1;
        caret_after
    }

    fn apply_undo(&mut self) -> Result<bool, EditError> {
        let Some(tx) = self.history.take_undo() else {
            return Ok(false);
        };
        if let Err(e) = apply_all(&mut self.score, &tx.inverse) {
            self.history.push_undo_keep_redo(tx);
            return Err(e.into());
        }
        self.caret = cursor::clamp(&self.score, tx.caret_before);
        self.anchor = None;
        self.revision += 1;
        self.history.push_redo(tx);
        Ok(true)
    }

    fn apply_redo(&mut self) -> Result<bool, EditError> {
        let Some(tx) = self.history.take_redo() else {
            return Ok(false);
        };
        if let Err(e) = apply_all(&mut self.score, &tx.forward) {
            self.history.push_redo(tx);
            return Err(e.into());
        }
        self.caret = cursor::clamp(&self.score, tx.caret_after);
        self.anchor = None;
        self.revision += 1;
        self.history.push_undo_keep_redo(tx);
        Ok(true)
    }

    /// Re-applies a journal entry during crash recovery. Produces no new
    /// pending entries.
    pub fn replay(&mut self, entry: &JournalEntry) -> Result<(), EditError> {
        match entry {
            JournalEntry::Commit {
                kind,
                ops,
                caret_before,
                caret_after,
                time_ms,
                merge,
            } => {
                self.apply_commit(
                    *kind,
                    ops.clone(),
                    *caret_before,
                    *caret_after,
                    *time_ms,
                    *merge,
                )?;
            }
            JournalEntry::Undo => {
                self.apply_undo()?;
            }
            JournalEntry::Redo => {
                self.apply_redo()?;
            }
        }
        Ok(())
    }

    // ----- caret & selection ---------------------------------------------

    /// Places the caret. With `extend` the selection grows from the anchor
    /// (Shift+click / Shift+arrow behaviour).
    pub fn set_caret(&mut self, caret: Caret, extend: bool) {
        let caret = cursor::clamp(&self.score, caret);
        if extend {
            if self.anchor.is_none() {
                self.anchor = Some(self.caret);
            }
        } else {
            self.anchor = None;
        }
        if caret != self.caret {
            self.history.seal();
        }
        self.caret = caret;
    }

    pub fn move_caret(&mut self, mv: Move, extend: bool) {
        // Like a word processor: Left/Right without Shift collapse a
        // selection to its edge instead of moving.
        if !extend && matches!(mv, Move::Left | Move::Right) {
            if let (Some(anchor), Some(_)) = (self.anchor, self.selection()) {
                let a = cursor::time_of(&self.score, &anchor);
                let h = cursor::time_of(&self.score, &self.caret);
                let take_anchor = (mv == Move::Left) == (a < h);
                let target = if take_anchor { anchor } else { self.caret };
                self.set_caret(
                    Caret {
                        staff: self.caret.staff,
                        ..target
                    },
                    false,
                );
                return;
            }
        }
        let next = cursor::moved(&self.score, self.caret, mv);
        self.set_caret(next, extend);
    }

    pub fn select_all(&mut self) {
        let last_staff = self.score.staves.len() - 1;
        let last_measure = self.score.measures.len() - 1;
        let voice = self.caret.voice;
        self.anchor = Some(Caret {
            staff: 0,
            measure: 0,
            voice,
            index: 0,
        });
        let index = cursor::voice_len(&self.score, last_staff, last_measure, voice);
        self.caret = Caret {
            staff: last_staff,
            measure: last_measure,
            voice,
            index,
        };
        self.history.seal();
    }

    /// Removal ops for the selection plus the caret position afterwards.
    fn delete_selection_ops(&self) -> Option<(Vec<Op>, Caret)> {
        let range = self.selection()?;
        let mut targets = cursor::events_in_range(&self.score, &range);
        // Remove back to front so earlier indices stay valid.
        targets.sort_by_key(|t| std::cmp::Reverse(a_key(t)));
        let ops = targets
            .into_iter()
            .map(|(at, index)| Op::RemoveEvent { at, index })
            .collect();
        let staff = range.staff_lo;
        let caret = Caret {
            staff,
            measure: range.start.measure,
            voice: range.voice,
            index: cursor::index_at_tick(
                &self.score,
                staff,
                range.start.measure,
                range.voice,
                range.start.tick,
            ),
        };
        Some((ops, caret))
    }

    // ----- entering music ------------------------------------------------

    /// Most recent pitch before the caret in its voice, else the clef's
    /// middle line.
    fn reference_pitch(&self, c: Caret) -> Pitch {
        let mut measure = c.measure;
        let mut limit = c.index;
        loop {
            if let Some(events) = self.score.voice(c.staff, measure, c.voice) {
                let limit = limit.min(events.len());
                if let Some(p) = events[..limit]
                    .iter()
                    .rev()
                    .find_map(|e| e.pitches().first())
                {
                    return *p;
                }
            }
            if measure == 0 {
                break;
            }
            measure -= 1;
            limit = usize::MAX;
        }
        self.score.staves[c.staff].clef.middle_line()
    }

    fn insert_event(
        &mut self,
        kind: EventKind,
        duration: Duration,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let (mut ops, mut caret, tx) = match self.delete_selection_ops() {
            Some((ops, caret)) => (ops, caret, TxKind::Edit),
            None => (Vec::new(), self.caret, TxKind::Typing),
        };
        // Writing into a measure that only holds a measure rest replaces the
        // rest, as in any notation program.
        if ops.is_empty() {
            let capacity = self.score.measures[caret.measure].time.measure_ticks();
            let events = self
                .score
                .voice(caret.staff, caret.measure, caret.voice)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if is_measure_rest(events, capacity) {
                ops.push(Op::RemoveEvent {
                    at: caret.loc(),
                    index: 0,
                });
                caret.index = 0;
            }
        }
        let event = Event::new(self.score.alloc_id(), duration, kind);
        ops.push(Op::InsertEvent {
            at: caret.loc(),
            index: caret.index,
            event,
        });
        let after = Caret {
            index: caret.index + 1,
            ..caret
        };
        self.commit(tx, ops, after, now_ms, false)
    }

    /// Types a note (letter key). Octave follows the previous note and the
    /// accidental follows the key signature.
    pub fn insert_note(
        &mut self,
        step: Step,
        duration: Duration,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let reference = self.reference_pitch(self.caret);
        let mut pitch = nearest_pitch(step, reference);
        pitch.alter = key_alter(
            self.score.written_key(self.caret.staff, self.caret.measure),
            step,
        );
        self.insert_event(
            EventKind::Chord {
                pitches: vec![pitch],
            },
            duration,
            now_ms,
        )
    }

    pub fn insert_rest(&mut self, duration: Duration, now_ms: u64) -> Result<(), EditError> {
        self.insert_event(EventKind::Rest, duration, now_ms)
    }

    /// Natural pitch adjusted by the key signature of `measure`.
    fn pitch_in_key(&self, staff: usize, measure: usize, step: Step, octave: i8) -> Pitch {
        Pitch {
            step,
            octave: octave.clamp(0, 9),
            alter: key_alter(self.score.written_key(staff, measure), step),
        }
    }

    /// Mouse entry: places a note with an explicit pitch at `at` (an
    /// insertion point). The key signature decides the accidental.
    pub fn place_note(
        &mut self,
        at: Caret,
        step: Step,
        octave: i8,
        duration: Duration,
        now_ms: u64,
    ) -> Result<(), EditError> {
        self.set_caret(at, false);
        let pitch = self.pitch_in_key(self.caret.staff, self.caret.measure, step, octave);
        self.insert_event(
            EventKind::Chord {
                pitches: vec![pitch],
            },
            duration,
            now_ms,
        )
    }

    /// Mouse entry: places a rest at `at` (an insertion point).
    pub fn place_rest(
        &mut self,
        at: Caret,
        duration: Duration,
        now_ms: u64,
    ) -> Result<(), EditError> {
        self.set_caret(at, false);
        self.insert_rest(duration, now_ms)
    }

    /// Mouse entry on an existing event (`at.index` is the event's index):
    /// adds a pitch to it, turning a rest into a note. The caret ends up
    /// after the event.
    pub fn add_pitch(
        &mut self,
        at: Caret,
        step: Step,
        octave: i8,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let at = cursor::clamp(&self.score, at);
        let Some(event) = self
            .score
            .voice(at.staff, at.measure, at.voice)
            .and_then(|v| v.get(at.index))
            .cloned()
        else {
            return Ok(());
        };
        let after = Caret {
            index: at.index + 1,
            ..at
        };
        self.set_caret(after, false);
        let pitch = self.pitch_in_key(at.staff, at.measure, step, octave);
        let mut pitches = event.pitches().to_vec();
        if pitches.contains(&pitch) {
            return Ok(());
        }
        pitches.push(pitch);
        pitches.sort_by_key(|p| p.diatonic_index());
        let op = Op::ReplaceEvent {
            at: at.loc(),
            index: at.index,
            event: Event {
                kind: EventKind::Chord { pitches },
                ..event
            },
        };
        self.commit(TxKind::Typing, vec![op], after, now_ms, false)
    }

    /// Adds a pitch above the top of the chord just before the caret
    /// (Shift+letter). Turns a rest into a note.
    pub fn add_to_chord(&mut self, step: Step, now_ms: u64) -> Result<(), EditError> {
        let c = self.caret;
        if c.index == 0 {
            return Ok(());
        }
        let Some(event) = self
            .score
            .voice(c.staff, c.measure, c.voice)
            .and_then(|v| v.get(c.index - 1))
            .cloned()
        else {
            return Ok(());
        };
        let mut pitches = event.pitches().to_vec();
        let top = pitches.iter().max_by_key(|p| p.diatonic_index()).copied();
        let mut pitch = match top {
            Some(top) => {
                let mut p = nearest_pitch(step, top);
                if p.diatonic_index() <= top.diatonic_index() {
                    p = p.shifted(7);
                }
                p
            }
            None => nearest_pitch(step, self.reference_pitch(c)),
        };
        pitch.alter = key_alter(self.score.written_key(c.staff, c.measure), step);
        if pitches.contains(&pitch) {
            return Ok(());
        }
        pitches.push(pitch);
        pitches.sort_by_key(|p| p.diatonic_index());
        let replaced = Event {
            kind: EventKind::Chord { pitches },
            ..event
        };
        let op = Op::ReplaceEvent {
            at: c.loc(),
            index: c.index - 1,
            event: replaced,
        };
        self.commit(TxKind::Typing, vec![op], c, now_ms, false)
    }

    // ----- deleting ------------------------------------------------------

    /// Backspace.
    pub fn delete_backward(&mut self, now_ms: u64) -> Result<(), EditError> {
        if let Some((ops, caret)) = self.delete_selection_ops() {
            return self.commit(TxKind::Edit, ops, caret, now_ms, false);
        }
        let c = self.caret;
        if c.index == 0 {
            self.move_caret(Move::Left, false);
            return Ok(());
        }
        let op = Op::RemoveEvent {
            at: c.loc(),
            index: c.index - 1,
        };
        self.commit(
            TxKind::Deleting,
            vec![op],
            Caret {
                index: c.index - 1,
                ..c
            },
            now_ms,
            false,
        )
    }

    /// Delete key.
    pub fn delete_forward(&mut self, now_ms: u64) -> Result<(), EditError> {
        if let Some((ops, caret)) = self.delete_selection_ops() {
            return self.commit(TxKind::Edit, ops, caret, now_ms, false);
        }
        let c = self.caret;
        if c.index >= cursor::voice_len(&self.score, c.staff, c.measure, c.voice) {
            return Ok(());
        }
        let op = Op::RemoveEvent {
            at: c.loc(),
            index: c.index,
        };
        self.commit(TxKind::Deleting, vec![op], c, now_ms, false)
    }

    /// The eraser: removes the given events in one undo step. When a target
    /// names a pitch of a chord that has other pitches, only that pitch is
    /// removed (matched by step and octave). Unknown ids are ignored. The
    /// caret moves to where the first erased event was.
    pub fn erase(
        &mut self,
        targets: &[(EventId, Option<Pitch>)],
        now_ms: u64,
    ) -> Result<(), EditError> {
        let mut removals = Vec::new();
        let mut ops = Vec::new();
        let mut first: Option<(usize, usize, usize, usize)> = None;
        for &(id, pitch) in targets {
            let Some(found) = self.score.locate(id) else {
                continue;
            };
            let (s, m, v, i) = found;
            first = Some(first.map_or(found, |f| f.min(found)));
            let at = VoiceLoc {
                staff: s,
                measure: m,
                voice: v,
            };
            let event = &self.score.staves[s].measures[m].voices[v][i];
            if let (Some(p), EventKind::Chord { pitches }) = (pitch, &event.kind) {
                let keep: Vec<Pitch> = pitches
                    .iter()
                    .copied()
                    .filter(|q| !(q.step == p.step && q.octave == p.octave))
                    .collect();
                if !keep.is_empty() && keep.len() < pitches.len() {
                    let mut event = event.clone();
                    event.kind = EventKind::Chord { pitches: keep };
                    ops.push(Op::ReplaceEvent {
                        at,
                        index: i,
                        event,
                    });
                    continue;
                }
            }
            removals.push((at, i));
        }
        // Remove back to front so earlier indices stay valid.
        removals.sort_by_key(|t| std::cmp::Reverse(a_key(t)));
        removals.dedup();
        ops.extend(
            removals
                .into_iter()
                .map(|(at, index)| Op::RemoveEvent { at, index }),
        );
        let Some((staff, measure, voice, index)) = first else {
            return Ok(());
        };
        let caret = Caret {
            staff,
            measure,
            voice,
            index,
        };
        self.commit(TxKind::Edit, ops, caret, now_ms, false)
    }

    // ----- changing pitches ----------------------------------------------

    /// Events affected by pitch commands: the selection, or the event
    /// just before the caret.
    fn pitch_targets(&self) -> Vec<(crate::ops::VoiceLoc, usize)> {
        if let Some(range) = self.selection() {
            return cursor::events_in_range(&self.score, &range);
        }
        let c = self.caret;
        if c.index > 0 {
            vec![(c.loc(), c.index - 1)]
        } else {
            Vec::new()
        }
    }

    fn repitch(&mut self, now_ms: u64, f: impl Fn(Pitch) -> Pitch) -> Result<(), EditError> {
        let ops: Vec<Op> = self
            .pitch_targets()
            .into_iter()
            .filter_map(|(at, index)| {
                let event = self
                    .score
                    .voice(at.staff, at.measure, at.voice)?
                    .get(index)?;
                let EventKind::Chord { pitches } = &event.kind else {
                    return None;
                };
                let pitches = pitches.iter().map(|p| f(*p)).collect();
                Some(Op::ReplaceEvent {
                    at,
                    index,
                    event: Event {
                        kind: EventKind::Chord { pitches },
                        ..event.clone()
                    },
                })
            })
            .collect();
        let caret = self.caret;
        self.commit(TxKind::Repitch, ops, caret, now_ms, true)
    }

    /// Dragging a notehead: moves one event's notes by diatonic steps, or
    /// only the tone `pitch` (matched by step and octave) when the event is
    /// a chord of several notes. The caret goes after the event, so the
    /// moved note sounds and Alt+Up/Down keep moving it. Consecutive moves
    /// undo as one step.
    pub fn move_pitch(
        &mut self,
        id: EventId,
        pitch: Option<Pitch>,
        steps: i32,
        now_ms: u64,
    ) -> Result<(), EditError> {
        self.retune_event(id, pitch, TxKind::Repitch, now_ms, |q| q.shifted(steps))
    }

    /// Placing an accidental with the mouse: sets the alteration of one
    /// event's notes, or only of the tone `pitch` in a chord of several
    /// notes. The caret goes after the event.
    pub fn set_accidental_at(
        &mut self,
        id: EventId,
        pitch: Option<Pitch>,
        alter: i8,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let alter = alter.clamp(-2, 2);
        self.retune_event(id, pitch, TxKind::Edit, now_ms, |q| Pitch { alter, ..q })
    }

    /// Applies `f` to the notes of one event (only to `pitch` when the
    /// event is a chord of several notes) and puts the caret after it.
    fn retune_event(
        &mut self,
        id: EventId,
        pitch: Option<Pitch>,
        kind: TxKind,
        now_ms: u64,
        f: impl Fn(Pitch) -> Pitch,
    ) -> Result<(), EditError> {
        let Some((staff, measure, voice, index)) = self.score.locate(id) else {
            return Ok(());
        };
        let event = &self.score.staves[staff].measures[measure].voices[voice][index];
        let EventKind::Chord { pitches } = &event.kind else {
            return Ok(());
        };
        let only = pitch.filter(|_| pitches.len() > 1);
        let pitches = pitches
            .iter()
            .map(|q| match only {
                Some(p) if !(q.step == p.step && q.octave == p.octave) => *q,
                _ => f(*q),
            })
            .collect();
        let op = Op::ReplaceEvent {
            at: VoiceLoc {
                staff,
                measure,
                voice,
            },
            index,
            event: Event {
                kind: EventKind::Chord { pitches },
                ..event.clone()
            },
        };
        let caret = Caret {
            staff,
            measure,
            voice,
            index: index + 1,
        };
        self.commit(kind, vec![op], caret, now_ms, false)
    }

    /// Moves notes up/down by diatonic steps (Alt+Up/Down; 7 = octave).
    pub fn transpose(&mut self, steps: i32, now_ms: u64) -> Result<(), EditError> {
        self.repitch(now_ms, |p| p.shifted(steps))
    }

    /// Raises (+1) or lowers (-1) the accidental, within double sharp/flat.
    pub fn change_accidental(&mut self, delta: i8, now_ms: u64) -> Result<(), EditError> {
        self.repitch(now_ms, |p| Pitch {
            alter: (p.alter + delta).clamp(-2, 2),
            ..p
        })
    }

    /// Sets an explicit accidental (palette ♯ ♭ ♮ buttons) on the
    /// selection or the previous event.
    pub fn set_accidental(&mut self, alter: i8, now_ms: u64) -> Result<(), EditError> {
        let alter = alter.clamp(-2, 2);
        self.repitch(now_ms, |p| Pitch { alter, ..p })
    }

    /// Changes the rhythmic value of the selection / previous event.
    pub fn set_duration(&mut self, duration: Duration, now_ms: u64) -> Result<(), EditError> {
        let ops: Vec<Op> = self
            .pitch_targets()
            .into_iter()
            .filter_map(|(at, index)| {
                let event = self
                    .score
                    .voice(at.staff, at.measure, at.voice)?
                    .get(index)?;
                (event.duration != duration).then(|| Op::ReplaceEvent {
                    at,
                    index,
                    event: Event {
                        duration,
                        ..event.clone()
                    },
                })
            })
            .collect();
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, true)
    }

    // ----- ties, slurs, articulations, dynamics ---------------------------

    /// The selection's events, or the one before the caret, as owned copies.
    fn target_events(&self) -> Vec<(crate::ops::VoiceLoc, usize, Event)> {
        self.pitch_targets()
            .into_iter()
            .filter_map(|(at, index)| {
                let e = self
                    .score
                    .voice(at.staff, at.measure, at.voice)?
                    .get(index)?;
                Some((at, index, e.clone()))
            })
            .collect()
    }

    /// Replaces each target event by `f(event)`; unchanged events are skipped.
    fn rewrite_targets(
        &mut self,
        targets: Vec<(crate::ops::VoiceLoc, usize, Event)>,
        now_ms: u64,
        f: impl Fn(&Event) -> Event,
    ) -> Result<(), EditError> {
        let ops = targets
            .into_iter()
            .filter_map(|(at, index, e)| {
                let new = f(&e);
                (new != e).then_some(Op::ReplaceEvent {
                    at,
                    index,
                    event: new,
                })
            })
            .collect();
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, true)
    }

    /// Ties the target notes to the following note (or removes the ties if
    /// they all have one already).
    pub fn toggle_tie(&mut self, now_ms: u64) -> Result<(), EditError> {
        let targets: Vec<_> = self
            .target_events()
            .into_iter()
            .filter(|(_, _, e)| !e.is_rest())
            .collect();
        let tie = !targets.iter().all(|(_, _, e)| e.tie);
        self.rewrite_targets(targets, now_ms, |e| Event { tie, ..e.clone() })
    }

    /// Adds an articulation to the target notes, or removes it when they
    /// all have it. Only a fermata can go on a rest.
    pub fn toggle_articulation(&mut self, art: Articulation, now_ms: u64) -> Result<(), EditError> {
        let targets: Vec<_> = self
            .target_events()
            .into_iter()
            .filter(|(_, _, e)| !e.is_rest() || art == Articulation::Fermata)
            .collect();
        let add = !targets
            .iter()
            .all(|(_, _, e)| e.articulations.contains(&art));
        self.rewrite_targets(targets, now_ms, |e| {
            let mut arts: Vec<Articulation> = e
                .articulations
                .iter()
                .copied()
                .filter(|a| *a != art)
                .collect();
            if add {
                arts.push(art);
                arts.sort();
            }
            Event {
                articulations: arts,
                ..e.clone()
            }
        })
    }

    /// Puts a dynamic under the target events; choosing the one they all
    /// already have removes it.
    pub fn set_dynamic(&mut self, dynamic: Dynamic, now_ms: u64) -> Result<(), EditError> {
        let targets = self.target_events();
        let value = if targets.iter().all(|(_, _, e)| e.dynamic == Some(dynamic)) {
            None
        } else {
            Some(dynamic)
        };
        self.rewrite_targets(targets, now_ms, |e| Event {
            dynamic: value,
            ..e.clone()
        })
    }

    /// Writes (or, with an empty `text`, removes) the syllable that event
    /// `id` sings in `verse` (0 = first verse). Rests cannot carry lyrics.
    ///
    /// Each call is its own undo step, like a word in a word processor. The
    /// caret goes after the event, so the view follows the lyrics as they
    /// are typed and undo comes back to the same place.
    pub fn set_lyric(
        &mut self,
        id: EventId,
        verse: usize,
        text: &str,
        join: LyricJoin,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let Some((staff, measure, voice, index)) = self.score.locate(id) else {
            return Ok(());
        };
        let event = &self.score.staves[staff].measures[measure].voices[voice][index];
        if event.is_rest() || verse >= MAX_VERSES {
            return Ok(());
        }
        // A syllable is one piece of a word: no control characters, and
        // whitespace only inside it (as single spaces).
        let text: String = text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_SYLLABLE_CHARS)
            .collect();
        let syllable = Syllable {
            join: if text.is_empty() {
                LyricJoin::None
            } else {
                join
            },
            text,
        };
        let mut lyrics = event.lyrics.clone();
        if lyrics.len() <= verse {
            lyrics.resize(verse + 1, Syllable::default());
        }
        lyrics[verse] = syllable;
        while lyrics.last().is_some_and(Syllable::is_empty) {
            lyrics.pop();
        }
        if lyrics == event.lyrics {
            return Ok(());
        }
        let op = Op::ReplaceEvent {
            at: VoiceLoc {
                staff,
                measure,
                voice,
            },
            index,
            event: Event {
                lyrics,
                ..event.clone()
            },
        };
        let caret = Caret {
            staff,
            measure,
            voice,
            index: index + 1,
        };
        self.commit(TxKind::Edit, vec![op], caret, now_ms, false)
    }

    /// Adds a slur over the selected notes of the top selected staff, or
    /// removes it if exactly that slur exists.
    pub fn toggle_slur(&mut self, now_ms: u64) -> Result<(), EditError> {
        let Some(range) = self.selection() else {
            return Err(EditError::SlurNeedsSelection);
        };
        let ids: Vec<u64> = cursor::events_in_range(&self.score, &range)
            .into_iter()
            .filter(|(at, _)| at.staff == range.staff_lo)
            .filter_map(|(at, i)| {
                let e = self.score.voice(at.staff, at.measure, at.voice)?.get(i)?;
                Some(e.id)
            })
            .collect();
        let (Some(&start), Some(&end)) = (ids.first(), ids.last()) else {
            return Ok(());
        };
        if start == end {
            return Err(EditError::SlurTooShort);
        }
        let op = match self
            .score
            .slurs
            .iter()
            .position(|s| s.start == start && s.end == end)
        {
            Some(index) => Op::RemoveSlur { index },
            None => Op::AddSlur {
                index: self.score.slurs.len(),
                slur: Slur {
                    id: self.score.alloc_id(),
                    start,
                    end,
                },
            },
        };
        let caret = self.caret;
        self.commit(TxKind::Edit, vec![op], caret, now_ms, true)
    }

    /// Playback tempo in quarter notes per minute (20–400).
    pub fn set_tempo(&mut self, bpm: u16, now_ms: u64) -> Result<(), EditError> {
        if bpm == self.score.tempo {
            return Ok(());
        }
        let caret = self.caret;
        self.commit(
            TxKind::Edit,
            vec![Op::SetTempo { bpm }],
            caret,
            now_ms,
            false,
        )
    }

    // ----- clipboard -----------------------------------------------------

    pub fn copy(&self) -> Option<Clipboard> {
        let range = self.selection()?;
        let mut staves = vec![Vec::new(); range.staff_hi - range.staff_lo + 1];
        for (at, index) in cursor::events_in_range(&self.score, &range) {
            if let Some(e) = self
                .score
                .voice(at.staff, at.measure, at.voice)
                .and_then(|v| v.get(index))
            {
                staves[at.staff - range.staff_lo].push(e.clone());
            }
        }
        Some(Clipboard { staves })
    }

    pub fn cut(&mut self, now_ms: u64) -> Result<Option<Clipboard>, EditError> {
        let Some(clip) = self.copy() else {
            return Ok(None);
        };
        if let Some((ops, caret)) = self.delete_selection_ops() {
            self.commit(TxKind::Edit, ops, caret, now_ms, false)?;
        }
        Ok(Some(clip))
    }

    /// Inserts copied music at the caret (replacing the selection). Each
    /// copied staff goes to the staff below the previous one.
    pub fn paste(&mut self, clip: &Clipboard, now_ms: u64) -> Result<(), EditError> {
        if clip.is_empty() {
            return Ok(());
        }
        let (mut ops, caret) = self
            .delete_selection_ops()
            .unwrap_or_else(|| (Vec::new(), self.caret));
        let tick = cursor::tick_at(
            &self.score,
            caret.staff,
            caret.measure,
            caret.voice,
            caret.index,
        );
        let mut first_len = 0;
        for (k, events) in clip.staves.iter().enumerate() {
            let staff = caret.staff + k;
            if staff >= self.score.staves.len() {
                break;
            }
            let start = if k == 0 {
                caret.index
            } else {
                cursor::index_at_tick(&self.score, staff, caret.measure, caret.voice, tick)
            };
            let at = crate::ops::VoiceLoc {
                staff,
                ..caret.loc()
            };
            for (i, e) in events.iter().enumerate() {
                let event = Event {
                    id: self.score.alloc_id(),
                    ..e.clone()
                };
                ops.push(Op::InsertEvent {
                    at,
                    index: start + i,
                    event,
                });
            }
            if k == 0 {
                first_len = events.len();
            }
        }
        let after = Caret {
            index: caret.index + first_len,
            ..caret
        };
        self.commit(TxKind::Edit, ops, after, now_ms, false)
    }

    // ----- structure -----------------------------------------------------

    /// Adds an empty measure at `index` (copying the attributes in force).
    pub fn insert_measure(&mut self, index: usize, now_ms: u64) -> Result<(), EditError> {
        let index = index.min(self.score.measures.len());
        let attrs = self.score.measures[index.saturating_sub(1).min(self.score.measures.len() - 1)];
        let op = Op::InsertMeasure {
            index,
            attrs,
            contents: Vec::new(),
        };
        let caret = self.caret;
        self.commit(TxKind::Edit, vec![op], caret, now_ms, false)
    }

    pub fn append_measure(&mut self, now_ms: u64) -> Result<(), EditError> {
        self.insert_measure(self.score.measures.len(), now_ms)
    }

    pub fn remove_measure(&mut self, index: usize, now_ms: u64) -> Result<(), EditError> {
        let caret = self.caret;
        self.commit(
            TxKind::Edit,
            vec![Op::RemoveMeasure { index }],
            caret,
            now_ms,
            false,
        )
    }

    pub fn add_staff(
        &mut self,
        name: impl Into<String>,
        clef: Clef,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let staff = self.score.blank_staff(name, clef);
        let op = Op::InsertStaff {
            index: self.score.staves.len(),
            staff,
        };
        let caret = self.caret;
        self.commit(TxKind::Edit, vec![op], caret, now_ms, false)
    }

    /// Adds a staff at the bottom with the given name, sound, clef and
    /// transposition.
    pub fn add_instrument_staff(
        &mut self,
        props: StaffProps,
        now_ms: u64,
    ) -> Result<(), EditError> {
        self.add_instrument(props, 1, now_ms)
    }

    /// Adds an instrument at the bottom on `staves` staves (1-4) in one
    /// undo step. Several staves (a piano, a harp, an organ) share the
    /// name, sound and transposition and are joined by a brace; the first
    /// uses `props.clef`, the others the bass clef.
    pub fn add_instrument(
        &mut self,
        props: StaffProps,
        staves: usize,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let staves = staves.clamp(1, 4);
        let clip = |s: &str| -> String { s.trim().chars().take(MAX_STAFF_NAME_CHARS).collect() };
        let group = (staves > 1).then(|| StaffGroup {
            id: self.score.alloc_id(),
            kind: GroupKind::Brace,
        });
        let first = self.score.staves.len();
        let mut ops = Vec::with_capacity(staves);
        for k in 0..staves {
            let clef = if k == 0 { props.clef } else { Clef::Bass };
            let mut staff = self.score.blank_staff(clip(&props.name), clef);
            staff.short_name = clip(&props.short_name);
            staff.instrument = props.instrument.min(127);
            staff.transposition = props.transposition;
            staff.group = group;
            ops.push(Op::InsertStaff {
                index: first + k,
                staff,
            });
        }
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, false)
    }

    /// Joins staves `first..=last` with a bracket or a brace, or (`None`)
    /// takes them out of any group. One undo step.
    pub fn group_staves(
        &mut self,
        first: usize,
        last: usize,
        kind: Option<GroupKind>,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let (first, last) = (first.min(last), first.max(last));
        if last >= self.score.staves.len() {
            return Err(crate::ops::OpError::StaffIndex(last).into());
        }
        let group = match kind {
            Some(kind) if last > first => Some(StaffGroup {
                id: self.score.alloc_id(),
                kind,
            }),
            Some(_) => return Ok(()), // one staff alone is not a group
            None => None,
        };
        let ops: Vec<Op> = (first..=last)
            .filter(|&s| self.score.staves[s].group != group)
            .map(|staff| Op::SetStaffGroup { staff, group })
            .collect();
        if ops.is_empty() {
            return Ok(());
        }
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, false)
    }

    pub fn remove_staff(&mut self, index: usize, now_ms: u64) -> Result<(), EditError> {
        let caret = self.caret;
        self.commit(
            TxKind::Edit,
            vec![Op::RemoveStaff { index }],
            caret,
            now_ms,
            false,
        )
    }

    pub fn set_clef(&mut self, staff: usize, clef: Clef, now_ms: u64) -> Result<(), EditError> {
        let caret = self.caret;
        self.commit(
            TxKind::Edit,
            vec![Op::SetStaffClef { staff, clef }],
            caret,
            now_ms,
            false,
        )
    }

    /// Sets a staff's name, playback instrument and clef in one undo step.
    /// Only what changes is recorded.
    pub fn set_staff_properties(
        &mut self,
        staff: usize,
        props: StaffProps,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let Some(current) = self.score.staves.get(staff) else {
            return Err(crate::ops::OpError::StaffIndex(staff).into());
        };
        let clip = |s: &str| -> String { s.trim().chars().take(MAX_STAFF_NAME_CHARS).collect() };
        let (name, short_name) = (clip(&props.name), clip(&props.short_name));
        let mut ops = Vec::new();
        if current.name != name {
            ops.push(Op::SetStaffName { staff, name });
        }
        if current.short_name != short_name {
            ops.push(Op::SetStaffShortName { staff, short_name });
        }
        if current.instrument != props.instrument {
            ops.push(Op::SetStaffInstrument {
                staff,
                instrument: props.instrument.min(127),
            });
        }
        if current.clef != props.clef {
            ops.push(Op::SetStaffClef {
                staff,
                clef: props.clef,
            });
        }
        if current.transposition != props.transposition {
            // The music keeps sounding the same: written notes move by the
            // difference (a C for piano becomes a D for B-flat clarinet).
            let (old, new) = (current.transposition, props.transposition);
            let d = old.diatonic as i32 - new.diatonic as i32;
            let c = old.chromatic as i32 - new.chromatic as i32;
            for (m, cell) in current.measures.iter().enumerate() {
                for (v, events) in cell.voices.iter().enumerate() {
                    for (index, e) in events.iter().enumerate() {
                        if let EventKind::Chord { pitches } = &e.kind {
                            let mut moved = e.clone();
                            moved.kind = EventKind::Chord {
                                pitches: pitches.iter().map(|p| p.transposed(d, c)).collect(),
                            };
                            ops.push(Op::ReplaceEvent {
                                at: VoiceLoc {
                                    staff,
                                    measure: m,
                                    voice: v,
                                },
                                index,
                                event: moved,
                            });
                        }
                    }
                }
            }
            ops.push(Op::SetStaffTransposition {
                staff,
                transposition: new,
            });
        }
        if ops.is_empty() {
            return Ok(());
        }
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, false)
    }

    pub fn set_staff_name(
        &mut self,
        staff: usize,
        name: String,
        now_ms: u64,
    ) -> Result<(), EditError> {
        let caret = self.caret;
        self.commit(
            TxKind::Edit,
            vec![Op::SetStaffName { staff, name }],
            caret,
            now_ms,
            false,
        )
    }

    /// Changes the time signature from the caret's measure up to the next
    /// existing change.
    pub fn set_time_signature(
        &mut self,
        time: TimeSignature,
        now_ms: u64,
    ) -> Result<(), EditError> {
        if !time.is_valid() {
            return Err(EditError::InvalidTime);
        }
        let from = self.caret.measure;
        let old = self.score.measures[from].time;
        let ops = self.score.measures[from..]
            .iter()
            .enumerate()
            .take_while(|(_, a)| a.time == old)
            .map(|(i, a)| Op::SetMeasureAttrs {
                index: from + i,
                attrs: crate::model::MeasureAttrs { time, ..*a },
            })
            .collect();
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, false)
    }

    /// Changes the key signature from the caret's measure up to the next
    /// existing change.
    pub fn set_key_signature(&mut self, key: KeySignature, now_ms: u64) -> Result<(), EditError> {
        let from = self.caret.measure;
        let old = self.score.measures[from].key;
        let ops = self.score.measures[from..]
            .iter()
            .enumerate()
            .take_while(|(_, a)| a.key == old)
            .map(|(i, a)| Op::SetMeasureAttrs {
                index: from + i,
                attrs: crate::model::MeasureAttrs { key, ..*a },
            })
            .collect();
        let caret = self.caret;
        self.commit(TxKind::Edit, ops, caret, now_ms, false)
    }

    pub fn set_metadata(&mut self, metadata: Metadata, now_ms: u64) -> Result<(), EditError> {
        if metadata == self.score.metadata {
            return Ok(());
        }
        let caret = self.caret;
        self.commit(
            TxKind::Edit,
            vec![Op::SetMetadata { metadata }],
            caret,
            now_ms,
            false,
        )
    }

    // ----- undo / redo ---------------------------------------------------

    pub fn undo(&mut self) -> Result<bool, EditError> {
        let done = self.apply_undo()?;
        if done {
            self.pending.push(JournalEntry::Undo);
        }
        Ok(done)
    }

    pub fn redo(&mut self) -> Result<bool, EditError> {
        let done = self.apply_redo()?;
        if done {
            self.pending.push(JournalEntry::Redo);
        }
        Ok(done)
    }
}

fn a_key(t: &(crate::ops::VoiceLoc, usize)) -> (usize, usize, usize, usize) {
    (t.0.staff, t.0.measure, t.0.voice, t.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DurationBase, Step::*};

    const Q: Duration = Duration {
        base: DurationBase::Quarter,
        dots: 0,
    };

    fn steps(doc: &Document, staff: usize, measure: usize) -> Vec<Option<Step>> {
        doc.score
            .voice(staff, measure, 0)
            .unwrap()
            .iter()
            .map(|e| e.pitches().first().map(|p| p.step))
            .collect()
    }

    fn at(staff: usize, measure: usize, index: usize) -> Caret {
        Caret {
            staff,
            measure,
            voice: 0,
            index,
        }
    }

    #[test]
    fn eraser_removes_notes_and_single_chord_tones_in_one_step() {
        let mut doc = Document::new(Score::new("t", 2));
        doc.place_note(at(0, 0, 0), C, 5, Q, 10_000).unwrap();
        doc.place_note(at(0, 0, 1), D, 5, Q, 10_100).unwrap();
        doc.place_note(at(0, 0, 2), E, 5, Q, 10_200).unwrap();
        doc.add_pitch(at(0, 0, 2), G, 5, 10_300).unwrap();
        let ids: Vec<EventId> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        let before = doc.score.clone();

        // C5 and D5 go; of the E5–G5 chord only G5 goes.
        let g5 = Pitch::new(G, 5);
        doc.erase(
            &[
                (ids[1], None),
                (ids[0], None),
                (ids[2], Some(g5)),
                (999, None),
            ],
            20_000,
        )
        .unwrap();
        let voice = doc.score.voice(0, 0, 0).unwrap();
        assert_eq!(voice.len(), 1);
        assert_eq!(voice[0].pitches(), &[Pitch::new(E, 5)]);
        assert_eq!(doc.caret, at(0, 0, 0));

        // Erasing the last tone of a chord removes the event.
        doc.erase(&[(ids[2], Some(Pitch::new(E, 5)))], 21_000)
            .unwrap();
        assert!(doc.score.voice(0, 0, 0).unwrap().is_empty());

        doc.undo().unwrap();
        doc.undo().unwrap();
        assert_eq!(doc.score, before);
    }

    #[test]
    fn accidental_from_the_mouse_on_a_note_or_one_chord_tone() {
        let mut doc = Document::new(Score::new("t", 1));
        doc.place_note(at(0, 0, 0), F, 4, Q, 10_000).unwrap();
        doc.place_note(at(0, 0, 1), C, 5, Q, 10_100).unwrap();
        doc.add_pitch(at(0, 0, 1), E, 5, 10_200).unwrap();
        let ids: Vec<EventId> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        let before = doc.score.clone();

        doc.set_accidental_at(ids[0], None, 1, 20_000).unwrap();
        assert_eq!(doc.score.voice(0, 0, 0).unwrap()[0].pitches()[0].alter, 1);
        assert_eq!(doc.caret, at(0, 0, 1));
        // In the C–E chord only the E becomes flat.
        doc.set_accidental_at(ids[1], Some(Pitch::new(E, 5)), -1, 21_000)
            .unwrap();
        let chord = doc.score.voice(0, 0, 0).unwrap()[1].pitches().to_vec();
        assert_eq!((chord[0].alter, chord[1].alter), (0, -1));
        doc.undo().unwrap();
        doc.undo().unwrap();
        assert_eq!(doc.score, before);
    }

    #[test]
    fn dragging_moves_a_note_or_one_chord_tone() {
        let mut doc = Document::new(Score::new("t", 1));
        doc.place_note(at(0, 0, 0), C, 5, Q, 10_000).unwrap();
        doc.place_note(at(0, 0, 1), E, 4, Q, 10_100).unwrap();
        doc.add_pitch(at(0, 0, 1), G, 4, 10_200).unwrap();
        let ids: Vec<EventId> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        let before = doc.score.clone();

        doc.move_pitch(ids[0], None, 2, 20_000).unwrap();
        doc.move_pitch(ids[0], None, 1, 20_050).unwrap();
        assert_eq!(
            doc.score.voice(0, 0, 0).unwrap()[0].pitches(),
            &[Pitch::new(F, 5)]
        );
        assert_eq!(doc.caret, at(0, 0, 1));
        // Only the G of the E–G chord moves.
        doc.move_pitch(ids[1], Some(Pitch::new(G, 4)), -1, 30_000)
            .unwrap();
        assert_eq!(
            doc.score.voice(0, 0, 0).unwrap()[1].pitches(),
            &[Pitch::new(E, 4), Pitch::new(F, 4)]
        );
        doc.undo().unwrap();
        doc.undo().unwrap();
        assert_eq!(doc.score, before);
    }

    #[test]
    fn mouse_entry_places_notes_rests_and_chords() {
        let mut doc = Document::new(Score::new("t", 3));
        doc.set_key_signature(KeySignature { fifths: 2 }, 0)
            .unwrap();
        // Click in measure 2, on the C5 space: C is sharp in D major.
        doc.place_note(at(0, 1, 0), C, 5, Q, 10_000).unwrap();
        doc.place_note(at(0, 1, 1), A, 4, Q, 10_100).unwrap();
        doc.place_rest(at(0, 1, 2), Q, 10_200).unwrap();
        let v = doc.score.voice(0, 1, 0).unwrap();
        assert_eq!(
            v[0].pitches(),
            &[Pitch {
                step: C,
                alter: 1,
                octave: 5
            }]
        );
        assert_eq!(v[1].pitches(), &[Pitch::new(A, 4)]);
        assert!(v[2].is_rest());
        assert_eq!(doc.caret(), at(0, 1, 3));

        // Clicking on the A adds a third below it; clicking on the rest
        // turns it into a note.
        doc.add_pitch(at(0, 1, 1), F, 4, 10_300).unwrap();
        doc.add_pitch(at(0, 1, 2), E, 4, 10_400).unwrap();
        let v = doc.score.voice(0, 1, 0).unwrap();
        assert_eq!(
            v[1].pitches(),
            &[
                Pitch {
                    step: F,
                    alter: 1,
                    octave: 4
                },
                Pitch::new(A, 4)
            ]
        );
        assert_eq!(v[2].pitches(), &[Pitch::new(E, 4)]);
        assert_eq!(doc.caret(), at(0, 1, 3));
        // Same pitch twice is ignored.
        doc.add_pitch(at(0, 1, 2), E, 4, 10_500).unwrap();
        assert_eq!(doc.score.voice(0, 1, 0).unwrap()[2].pitches().len(), 1);

        // Each chord edit was a click elsewhere, so each is its own step;
        // the three placed events before them are one step.
        doc.undo().unwrap();
        doc.undo().unwrap();
        let v = doc.score.voice(0, 1, 0).unwrap();
        assert_eq!(v[1].pitches().len(), 1);
        assert!(v[2].is_rest());
        doc.undo().unwrap();
        assert!(doc.score.voice(0, 1, 0).unwrap().is_empty());
    }

    #[test]
    fn measure_rests() {
        let whole = Duration::new(DurationBase::Whole);
        let mut doc = Document::new(Score::new("t", 2));
        doc.set_time_signature(
            TimeSignature {
                beats: 3,
                beat_type: 4,
            },
            0,
        )
        .unwrap();
        // A whole rest is a measure rest even in 3/4: not an error.
        doc.place_rest(at(0, 0, 0), whole, 1_000).unwrap();
        assert!(doc.score.validate().is_empty());
        // A whole *note* in 3/4 is still an error.
        doc.place_note(at(0, 1, 0), C, 5, whole, 2_000).unwrap();
        assert_eq!(doc.score.validate().len(), 1);

        // Writing into a measure-rest measure replaces the rest, wherever
        // the click landed (before or after the rest).
        doc.place_note(at(0, 0, 1), G, 4, Q, 9_000).unwrap();
        let v = doc.score.voice(0, 0, 0).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].pitches(), &[Pitch::new(G, 4)]);
        assert_eq!(doc.caret(), at(0, 0, 1));
        // Undo brings the rest back in one step.
        doc.undo().unwrap();
        assert!(doc.score.voice(0, 0, 0).unwrap()[0].is_rest());
    }

    #[test]
    fn ties_articulations_and_dynamics() {
        let mut doc = Document::new(Score::new("t", 1));
        type_notes(&mut doc, &[C, C], 0);
        doc.place_rest(at(0, 0, 2), Q, 300).unwrap();
        // Caret after the rest: staccato is ignored on rests, fermata is not.
        doc.toggle_articulation(Articulation::Staccato, 5_000)
            .unwrap();
        assert!(doc.score.voice(0, 0, 0).unwrap()[2]
            .articulations
            .is_empty());
        doc.toggle_articulation(Articulation::Fermata, 5_100)
            .unwrap();
        assert_eq!(
            doc.score.voice(0, 0, 0).unwrap()[2].articulations,
            vec![Articulation::Fermata]
        );

        // Tie the first note to the second.
        doc.set_caret(at(0, 0, 1), false);
        doc.toggle_tie(6_000).unwrap();
        assert!(doc.score.voice(0, 0, 0).unwrap()[0].tie);
        doc.toggle_tie(6_100).unwrap();
        assert!(!doc.score.voice(0, 0, 0).unwrap()[0].tie);

        // Articulations stay sorted and toggle off.
        doc.toggle_articulation(Articulation::Tenuto, 7_000)
            .unwrap();
        doc.toggle_articulation(Articulation::Staccato, 7_100)
            .unwrap();
        assert_eq!(
            doc.score.voice(0, 0, 0).unwrap()[0].articulations,
            vec![Articulation::Staccato, Articulation::Tenuto]
        );
        doc.toggle_articulation(Articulation::Staccato, 7_200)
            .unwrap();
        assert_eq!(
            doc.score.voice(0, 0, 0).unwrap()[0].articulations,
            vec![Articulation::Tenuto]
        );

        // Choosing the same dynamic again removes it.
        doc.set_dynamic(Dynamic::Mf, 8_000).unwrap();
        assert_eq!(
            doc.score.voice(0, 0, 0).unwrap()[0].dynamic,
            Some(Dynamic::Mf)
        );
        doc.set_dynamic(Dynamic::Mf, 8_100).unwrap();
        assert_eq!(doc.score.voice(0, 0, 0).unwrap()[0].dynamic, None);
    }

    #[test]
    fn lyrics_by_verse() {
        let mut doc = Document::new(Score::new("t", 2));
        let q = Duration::new(DurationBase::Quarter);
        doc.insert_note(Step::C, q, 0).unwrap();
        doc.insert_rest(q, 10).unwrap();
        doc.insert_note(Step::E, q, 20).unwrap();
        let ids: Vec<EventId> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        let lyrics = |doc: &Document, i: usize| doc.score.voice(0, 0, 0).unwrap()[i].lyrics.clone();
        let syl = |text: &str, join| Syllable {
            text: text.to_string(),
            join,
        };

        // Second verse first: the first verse stays empty in between.
        doc.set_lyric(ids[0], 1, "  glo \t ria\n", LyricJoin::Hyphen, 10_000)
            .unwrap();
        assert_eq!(
            lyrics(&doc, 0),
            vec![Syllable::default(), syl("glo ria", LyricJoin::Hyphen)]
        );
        assert_eq!(doc.caret().index, 1);
        doc.set_lyric(ids[0], 0, "can", LyricJoin::Extender, 20_000)
            .unwrap();
        assert_eq!(lyrics(&doc, 0)[0], syl("can", LyricJoin::Extender));

        // Rests, unknown events, verses past the limit and unchanged text
        // are ignored.
        let rev = doc.revision();
        doc.set_lyric(ids[1], 0, "x", LyricJoin::None, 30_000)
            .unwrap();
        doc.set_lyric(9_999, 0, "x", LyricJoin::None, 30_000)
            .unwrap();
        doc.set_lyric(ids[2], MAX_VERSES, "x", LyricJoin::None, 30_000)
            .unwrap();
        doc.set_lyric(ids[0], 0, "can", LyricJoin::Extender, 30_000)
            .unwrap();
        assert_eq!(doc.revision(), rev);

        // Long text is cut.
        doc.set_lyric(ids[2], 0, &"a".repeat(200), LyricJoin::None, 40_000)
            .unwrap();
        assert_eq!(lyrics(&doc, 2)[0].text.chars().count(), MAX_SYLLABLE_CHARS);

        // Clearing the last verse removes it; clearing all leaves no lyrics.
        doc.set_lyric(ids[0], 1, "", LyricJoin::Hyphen, 50_000)
            .unwrap();
        assert_eq!(lyrics(&doc, 0), vec![syl("can", LyricJoin::Extender)]);
        doc.set_lyric(ids[0], 0, " ", LyricJoin::Hyphen, 60_000)
            .unwrap();
        assert!(lyrics(&doc, 0).is_empty());

        // Every syllable is one undo step.
        assert!(doc.undo().unwrap());
        assert_eq!(lyrics(&doc, 0), vec![syl("can", LyricJoin::Extender)]);
        assert!(doc.undo().unwrap());
        assert_eq!(lyrics(&doc, 0).len(), 2);
    }

    #[test]
    fn lyrics_travel_with_their_notes() {
        let mut doc = Document::new(Score::new("t", 2));
        let q = Duration::new(DurationBase::Quarter);
        doc.insert_note(Step::C, q, 0).unwrap();
        doc.insert_note(Step::D, q, 10).unwrap();
        let ids: Vec<EventId> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        doc.set_lyric(ids[0], 0, "la", LyricJoin::Hyphen, 10_000)
            .unwrap();
        doc.set_lyric(ids[1], 0, "na", LyricJoin::None, 20_000)
            .unwrap();

        // Editing the notes keeps their syllables.
        doc.set_caret(at(0, 0, 0), false);
        doc.set_caret(at(0, 0, 2), true);
        doc.transpose(1, 30_000).unwrap();
        doc.set_duration(Duration::new(DurationBase::Eighth), 40_000)
            .unwrap();
        let texts = |doc: &Document, m: usize| -> Vec<String> {
            doc.score
                .voice(0, m, 0)
                .unwrap()
                .iter()
                .map(|e| e.lyrics.first().map(|s| s.text.clone()).unwrap_or_default())
                .collect()
        };
        assert_eq!(texts(&doc, 0), ["la", "na"]);

        // Copy and paste carries them along.
        let clip = doc.copy().unwrap();
        doc.set_caret(at(0, 1, 0), false);
        doc.paste(&clip, 50_000).unwrap();
        assert_eq!(texts(&doc, 1), ["la", "na"]);
        assert_eq!(
            doc.score.voice(0, 1, 0).unwrap()[0].lyrics[0].join,
            LyricJoin::Hyphen
        );

        // The journal reproduces lyric edits exactly.
        let mut source = Document::new(Score::new("t", 2));
        let mut replica = source.clone();
        source.insert_note(Step::C, q, 0).unwrap();
        let id = source.score.voice(0, 0, 0).unwrap()[0].id;
        source
            .set_lyric(id, 2, "Sanc", LyricJoin::Hyphen, 10_000)
            .unwrap();
        source.undo().unwrap();
        source.redo().unwrap();
        for entry in source.take_pending() {
            replica.replay(&entry).unwrap();
        }
        assert_eq!(replica, source);
    }

    #[test]
    fn slurs_follow_their_notes() {
        let mut doc = Document::new(Score::new("t", 2));
        type_notes(&mut doc, &[C, D, E, F], 0);
        // No selection: a slur needs one.
        assert!(matches!(
            doc.toggle_slur(1_000),
            Err(EditError::SlurNeedsSelection)
        ));
        doc.set_caret(at(0, 0, 0), false);
        doc.set_caret(at(0, 0, 3), true);
        doc.toggle_slur(2_000).unwrap();
        assert_eq!(doc.score.slurs.len(), 1);
        let ids: Vec<u64> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(
            (doc.score.slurs[0].start, doc.score.slurs[0].end),
            (ids[0], ids[2])
        );

        // Deleting the slur's last note removes the slur in the same step…
        doc.set_caret(at(0, 0, 3), false);
        doc.delete_backward(3_000).unwrap();
        assert!(doc.score.slurs.is_empty());
        // …and undo restores both.
        doc.undo().unwrap();
        assert_eq!(doc.score.voice(0, 0, 0).unwrap().len(), 4);
        assert_eq!(doc.score.slurs.len(), 1);

        // Same selection again toggles the slur off.
        doc.set_caret(at(0, 0, 0), false);
        doc.set_caret(at(0, 0, 3), true);
        doc.toggle_slur(4_000).unwrap();
        assert!(doc.score.slurs.is_empty());
    }

    #[test]
    fn replay_reproduces_slur_cleanup() {
        let start = Document::new(Score::new("t", 1));
        let mut live = start.clone();
        type_notes(&mut live, &[C, D, E], 0);
        live.set_caret(at(0, 0, 0), false);
        live.set_caret(at(0, 0, 3), true);
        live.toggle_slur(1_000).unwrap();
        live.set_caret(at(0, 0, 3), false);
        live.delete_backward(2_000).unwrap();
        live.undo().unwrap();
        live.redo().unwrap();
        let mut replayed = start;
        for e in live.take_pending() {
            replayed.replay(&e).unwrap();
        }
        assert_eq!(replayed.score, live.score);
    }

    #[test]
    fn explicit_accidentals() {
        let mut doc = Document::new(Score::new("t", 1));
        doc.set_key_signature(KeySignature { fifths: 1 }, 0)
            .unwrap();
        type_notes(&mut doc, &[F], 5_000); // F sharp from the key
        doc.set_accidental(0, 6_000).unwrap(); // natural
        assert_eq!(doc.score.voice(0, 0, 0).unwrap()[0].pitches()[0].alter, 0);
        doc.set_accidental(-1, 6_100).unwrap(); // flat
        assert_eq!(doc.score.voice(0, 0, 0).unwrap()[0].pitches()[0].alter, -1);
        // Both changes are one undo step (repitch burst).
        doc.undo().unwrap();
        assert_eq!(doc.score.voice(0, 0, 0).unwrap()[0].pitches()[0].alter, 1);
    }

    #[test]
    fn mouse_entry_groups_consecutive_clicks() {
        let mut doc = Document::new(Score::new("t", 2));
        doc.place_note(at(0, 0, 0), G, 4, Q, 0).unwrap();
        doc.place_note(at(0, 0, 1), A, 4, Q, 300).unwrap();
        doc.place_note(at(0, 0, 2), B, 4, Q, 600).unwrap();
        // Jump to another measure: new undo step.
        doc.place_note(at(0, 1, 0), C, 5, Q, 900).unwrap();
        doc.undo().unwrap();
        assert_eq!(doc.score.voice(0, 0, 0).unwrap().len(), 3);
        assert!(doc.score.voice(0, 1, 0).unwrap().is_empty());
        doc.undo().unwrap();
        assert!(doc.score.voice(0, 0, 0).unwrap().is_empty());
    }

    fn type_notes(doc: &mut Document, notes: &[Step], start_ms: u64) {
        for (i, s) in notes.iter().enumerate() {
            doc.insert_note(*s, Q, start_ms + i as u64 * 100).unwrap();
        }
    }

    #[test]
    fn typing_is_one_undo_step() {
        let mut doc = Document::new(Score::new("t", 2));
        type_notes(&mut doc, &[C, D, E], 0);
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(D), Some(E)]);
        assert_eq!(doc.caret().index, 3);
        assert!(doc.undo().unwrap());
        assert!(steps(&doc, 0, 0).is_empty());
        assert_eq!(doc.caret().index, 0);
        assert!(!doc.can_undo());
        assert!(doc.redo().unwrap());
        assert_eq!(steps(&doc, 0, 0).len(), 3);
        assert_eq!(doc.caret().index, 3);
    }

    #[test]
    fn pause_or_caret_move_starts_new_step() {
        let mut doc = Document::new(Score::new("t", 2));
        type_notes(&mut doc, &[C, D], 0);
        // Long pause.
        doc.insert_note(E, Q, 10_000).unwrap();
        // Caret moves away and back.
        doc.move_caret(Move::Left, false);
        doc.move_caret(Move::Right, false);
        doc.insert_note(F, Q, 10_100).unwrap();
        doc.undo().unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(D), Some(E)]);
        doc.undo().unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(D)]);
        doc.undo().unwrap();
        assert!(steps(&doc, 0, 0).is_empty());
    }

    #[test]
    fn new_edit_clears_redo() {
        let mut doc = Document::new(Score::new("t", 1));
        type_notes(&mut doc, &[C], 0);
        doc.undo().unwrap();
        type_notes(&mut doc, &[G], 5_000);
        assert!(!doc.can_redo());
    }

    #[test]
    fn octave_follows_previous_note_and_key() {
        let mut doc = Document::new(Score::new("t", 1));
        doc.set_key_signature(KeySignature { fifths: 1 }, 0)
            .unwrap();
        type_notes(&mut doc, &[C, B, F], 10_000);
        let pitches: Vec<Pitch> = doc
            .score
            .voice(0, 0, 0)
            .unwrap()
            .iter()
            .map(|e| e.pitches()[0])
            .collect();
        // C closest to B4 (treble middle line) is C5; B closest to C5 is B4;
        // F closest to B4 is F4 (3 steps down vs 4 up) and is sharp in G major.
        assert_eq!(pitches[0], Pitch::new(C, 5));
        assert_eq!(pitches[1], Pitch::new(B, 4));
        assert_eq!(
            pitches[2],
            Pitch {
                step: F,
                alter: 1,
                octave: 4
            }
        );
        // Repeating the same letter stays on the same note.
        assert_eq!(nearest_pitch(C, Pitch::new(C, 4)), Pitch::new(C, 4));
    }

    #[test]
    fn backspace_and_delete() {
        let mut doc = Document::new(Score::new("t", 1));
        type_notes(&mut doc, &[C, D, E, F], 0);
        doc.delete_backward(5_000).unwrap();
        doc.delete_backward(5_100).unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(D)]);
        doc.move_caret(Move::MeasureStart, false);
        doc.delete_forward(6_000).unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(D)]);
        // The two backspaces were one step.
        doc.undo().unwrap();
        doc.undo().unwrap();
        assert_eq!(steps(&doc, 0, 0).len(), 4);
    }

    #[test]
    fn shift_selection_delete_and_replace_by_typing() {
        let mut doc = Document::new(Score::new("t", 1));
        type_notes(&mut doc, &[C, D, E, F], 0);
        doc.move_caret(Move::MeasureStart, false);
        doc.move_caret(Move::Right, false);
        doc.move_caret(Move::Right, true);
        doc.move_caret(Move::Right, true);
        assert!(doc.selection().is_some());
        doc.insert_note(A, Q, 9_000).unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(A), Some(F)]);
        doc.undo().unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(D), Some(E), Some(F)]);
    }

    #[test]
    fn multi_staff_selection_copy_paste() {
        let mut doc = Document::new(Score::new("t", 2));
        doc.add_staff("Bass", Clef::Bass, 0).unwrap();
        type_notes(&mut doc, &[C, D], 1_000);
        doc.move_caret(Move::Down, false);
        type_notes(&mut doc, &[E, F], 5_000);
        // Select both staves, first measure.
        doc.set_caret(
            Caret {
                staff: 0,
                measure: 0,
                voice: 0,
                index: 0,
            },
            false,
        );
        doc.set_caret(
            Caret {
                staff: 1,
                measure: 0,
                voice: 0,
                index: 2,
            },
            true,
        );
        let clip = doc.copy().unwrap();
        assert_eq!(clip.staves.len(), 2);
        assert_eq!(clip.staves[0].len(), 2);
        doc.set_caret(
            Caret {
                staff: 0,
                measure: 1,
                voice: 0,
                index: 0,
            },
            false,
        );
        doc.paste(&clip, 9_000).unwrap();
        assert_eq!(steps(&doc, 0, 1), vec![Some(C), Some(D)]);
        assert_eq!(steps(&doc, 1, 1), vec![Some(E), Some(F)]);
        // Pasted events get fresh ids.
        assert_ne!(
            doc.score.voice(0, 1, 0).unwrap()[0].id,
            doc.score.voice(0, 0, 0).unwrap()[0].id
        );
        // Cut removes from both staves.
        doc.set_caret(
            Caret {
                staff: 0,
                measure: 0,
                voice: 0,
                index: 0,
            },
            false,
        );
        doc.set_caret(
            Caret {
                staff: 1,
                measure: 0,
                voice: 0,
                index: 2,
            },
            true,
        );
        doc.cut(10_000).unwrap();
        assert!(steps(&doc, 0, 0).is_empty());
        assert!(steps(&doc, 1, 0).is_empty());
    }

    #[test]
    fn transpose_keeps_selection_and_groups() {
        let mut doc = Document::new(Score::new("t", 1));
        type_notes(&mut doc, &[C, E], 0);
        doc.select_all();
        doc.transpose(1, 5_000).unwrap();
        doc.transpose(1, 5_100).unwrap();
        assert!(doc.selection().is_some());
        assert_eq!(steps(&doc, 0, 0), vec![Some(E), Some(G)]);
        doc.undo().unwrap();
        assert_eq!(steps(&doc, 0, 0), vec![Some(C), Some(E)]);
    }

    #[test]
    fn time_signature_change_runs_until_next_change() {
        let mut doc = Document::new(Score::new("t", 4));
        doc.set_caret(
            Caret {
                measure: 2,
                ..Caret::default()
            },
            false,
        );
        doc.set_time_signature(
            TimeSignature {
                beats: 3,
                beat_type: 4,
            },
            0,
        )
        .unwrap();
        doc.set_caret(
            Caret {
                measure: 1,
                ..Caret::default()
            },
            false,
        );
        doc.set_time_signature(
            TimeSignature {
                beats: 6,
                beat_type: 8,
            },
            0,
        )
        .unwrap();
        let beats: Vec<u8> = doc.score.measures.iter().map(|m| m.time.beats).collect();
        assert_eq!(beats, vec![4, 6, 3, 3]);
    }

    #[test]
    fn replay_reproduces_state_exactly() {
        let start = Document::new(Score::new("t", 2));
        let mut live = start.clone();
        live.add_staff("Bass", Clef::Bass, 0).unwrap();
        type_notes(&mut live, &[C, D, E], 100);
        live.add_to_chord(G, 400).unwrap();
        live.delete_backward(5_000).unwrap();
        live.undo().unwrap();
        live.redo().unwrap();
        live.undo().unwrap();
        live.select_all();
        live.transpose(2, 9_000).unwrap();
        let entries = live.take_pending();

        let mut replayed = start;
        for e in &entries {
            replayed.replay(e).unwrap();
        }
        assert_eq!(replayed.score, live.score);
        assert_eq!(replayed.history, live.history);
        assert_eq!(replayed.revision(), live.revision());
    }

    #[test]
    fn dirty_tracking() {
        let mut doc = Document::new(Score::new("t", 1));
        assert!(!doc.is_dirty());
        type_notes(&mut doc, &[C], 0);
        assert!(doc.is_dirty());
        doc.mark_saved("x.partita".into());
        assert!(!doc.is_dirty());
        assert_eq!(doc.display_name(), "x");
    }
}

#[cfg(test)]
mod staff_properties_tests {
    use super::*;

    fn props(name: &str, instrument: u8, clef: Clef) -> StaffProps {
        StaffProps {
            name: name.into(),
            short_name: String::new(),
            instrument,
            clef,
            transposition: Transposition::NONE,
        }
    }

    #[test]
    fn name_instrument_and_clef_are_one_undo_step() {
        let mut doc = Document::new(Score::new("Orchestra", 2));
        let mut cello = props("  Violoncello  ", 42, Clef::Bass);
        cello.short_name = "Vc.".into();
        doc.set_staff_properties(0, cello, 1_000).unwrap();
        let s = &doc.score.staves[0];
        assert_eq!(
            (s.name.as_str(), s.short_name.as_str(), s.instrument, s.clef),
            ("Violoncello", "Vc.", 42, Clef::Bass)
        );
        assert!(doc.undo().unwrap());
        let s = &doc.score.staves[0];
        assert_eq!(
            (s.name.as_str(), s.short_name.as_str(), s.instrument, s.clef),
            ("Staff 1", "", 0, Clef::Treble)
        );
        assert!(!doc.can_undo());
        // Nothing changed: nothing recorded.
        doc.set_staff_properties(0, props("Staff 1", 0, Clef::Treble), 2_000)
            .unwrap();
        assert!(!doc.can_undo());
    }

    #[test]
    fn a_transposing_instrument_keeps_the_sound() {
        let mut doc = Document::new(Score::new("Clarinet", 2));
        doc.set_key_signature(KeySignature { fifths: -1 }, 0)
            .unwrap(); // F major
        doc.insert_note(
            Step::C,
            Duration::new(crate::model::DurationBase::Quarter),
            1,
        )
        .unwrap();
        doc.insert_note(
            Step::B,
            Duration::new(crate::model::DurationBase::Quarter),
            2,
        )
        .unwrap();
        let before: Vec<i32> = doc.score.staves[0].measures[0].voices[0]
            .iter()
            .map(|e| e.pitches()[0].midi())
            .collect();
        let mut clarinet = props("Clarinet in B♭", 71, Clef::Treble);
        clarinet.transposition = Transposition {
            diatonic: -1,
            chromatic: -2,
        };
        doc.set_staff_properties(0, clarinet, 10_000).unwrap();
        let staff = &doc.score.staves[0];
        let written: Vec<Pitch> = staff.measures[0].voices[0]
            .iter()
            .map(|e| e.pitches()[0])
            .collect();
        // C becomes D, B-flat becomes C: a major second up on paper...
        assert_eq!((written[0].step, written[0].alter), (Step::D, 0));
        assert_eq!((written[1].step, written[1].alter), (Step::C, 0));
        // ...in G major for the clarinet, sounding exactly as before.
        assert_eq!(doc.score.written_key(0, 0).fifths, 1);
        let sounding: Vec<i32> = written
            .iter()
            .map(|p| staff.transposition.sounding_midi(*p))
            .collect();
        assert_eq!(sounding, before);
        // New notes follow the clarinet's key: F is F-sharp in G major.
        doc.insert_note(
            Step::F,
            Duration::new(crate::model::DurationBase::Quarter),
            20_000,
        )
        .unwrap();
        let f = doc.score.staves[0].measures[0].voices[0][2].pitches()[0];
        assert_eq!((f.step, f.alter), (Step::F, 1));
        // One undo puts the piano and its notes back.
        doc.undo().unwrap();
        doc.undo().unwrap();
        assert!(doc.score.staves[0].transposition.is_none());
        assert_eq!(
            doc.score.staves[0].measures[0].voices[0][0].pitches()[0].step,
            Step::C
        );
    }

    #[test]
    fn a_piano_comes_on_two_braced_staves() {
        let mut doc = Document::new(Score::new("Song", 2));
        let mut piano = props("Piano", 0, Clef::Treble);
        piano.short_name = "Pno.".into();
        doc.add_instrument(piano, 2, 1_000).unwrap();
        let s = &doc.score.staves;
        assert_eq!(s.len(), 3);
        assert_eq!((s[1].clef, s[2].clef), (Clef::Treble, Clef::Bass));
        assert_eq!((s[1].name.as_str(), s[2].name.as_str()), ("Piano", "Piano"));
        assert_eq!(s[1].group.map(|g| g.kind), Some(GroupKind::Brace));
        assert_eq!(s[1].group, s[2].group);
        assert!(s[0].group.is_none());
        // One undo removes both.
        doc.undo().unwrap();
        assert_eq!(doc.score.staves.len(), 1);
    }

    #[test]
    fn grouping_staves() {
        let mut score = Score::new("Strings", 1);
        for name in ["Violin II", "Viola", "Violoncello"] {
            let s = score.blank_staff(name, Clef::Treble);
            score.staves.push(s);
        }
        let mut doc = Document::new(score);
        doc.group_staves(0, 3, Some(GroupKind::Bracket), 1).unwrap();
        let g = doc.score.staves[0].group;
        assert!(g.is_some());
        assert!(doc.score.staves.iter().all(|s| s.group == g));
        doc.group_staves(3, 3, Some(GroupKind::Brace), 2).unwrap(); // one staff: no-op
        assert_eq!(doc.score.staves[3].group, g);
        doc.group_staves(2, 3, None, 3).unwrap();
        assert!(doc.score.staves[3].group.is_none());
        doc.undo().unwrap();
        assert_eq!(doc.score.staves[3].group, g);
    }
}
