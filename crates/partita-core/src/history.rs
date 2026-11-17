//! Undo/redo history with word-processor style grouping.
//!
//! Like a text editor, a burst of typing becomes a single undo step. A burst
//! ends when the user moves the caret, switches to a different kind of
//! action, or pauses for longer than [`COALESCE_WINDOW_MS`].

use serde::{Deserialize, Serialize};

use crate::cursor::Caret;
use crate::ops::Op;

/// Pause that ends a typing burst.
pub const COALESCE_WINDOW_MS: u64 = 2_000;
/// Maximum number of undo steps kept.
pub const HISTORY_LIMIT: usize = 1_000;

/// Kind of user action; consecutive actions of the same groupable kind are
/// merged into one undo step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxKind {
    /// Entering notes, rests or chord tones.
    Typing,
    /// Backspace / Delete one event at a time.
    Deleting,
    /// Repeated pitch changes (Alt+Up/Down, accidentals).
    Repitch,
    /// Anything else; never merged.
    Edit,
}

impl TxKind {
    fn groups(self) -> bool {
        self != TxKind::Edit
    }
}

/// One undo step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transaction {
    pub kind: TxKind,
    /// Ops to redo the step.
    pub forward: Vec<Op>,
    /// Ops to undo the step, in application order.
    pub inverse: Vec<Op>,
    pub caret_before: Caret,
    pub caret_after: Caret,
    /// Time of the most recent action merged into this step.
    pub time_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    undo: Vec<Transaction>,
    redo: Vec<Transaction>,
    /// When true the next action always starts a new step.
    sealed: bool,
}

impl History {
    /// Whether an action would join the latest undo step.
    pub fn would_merge(&self, kind: TxKind, caret_before: &Caret, time_ms: u64) -> bool {
        let Some(last) = self.undo.last() else {
            return false;
        };
        !self.sealed
            && kind.groups()
            && last.kind == kind
            && last.caret_after == *caret_before
            && time_ms.saturating_sub(last.time_ms) <= COALESCE_WINDOW_MS
    }

    /// Records a step, merging it into the previous one when `merge` is set.
    pub fn push(&mut self, tx: Transaction, merge: bool) {
        self.redo.clear();
        self.sealed = false;
        match self.undo.last_mut() {
            Some(last) if merge => {
                last.forward.extend(tx.forward);
                let mut inverse = tx.inverse;
                inverse.append(&mut last.inverse);
                last.inverse = inverse;
                last.caret_after = tx.caret_after;
                last.time_ms = tx.time_ms;
            }
            _ => {
                self.undo.push(tx);
                if self.undo.len() > HISTORY_LIMIT {
                    self.undo.remove(0);
                }
            }
        }
    }

    /// Ends the current burst (caret moved, file saved, …).
    pub fn seal(&mut self) {
        self.sealed = true;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub(crate) fn take_undo(&mut self) -> Option<Transaction> {
        self.sealed = true;
        self.undo.pop()
    }

    pub(crate) fn take_redo(&mut self) -> Option<Transaction> {
        self.sealed = true;
        self.redo.pop()
    }

    pub(crate) fn push_redo(&mut self, tx: Transaction) {
        self.redo.push(tx);
    }

    pub(crate) fn push_undo_keep_redo(&mut self, tx: Transaction) {
        self.undo.push(tx);
    }
}
