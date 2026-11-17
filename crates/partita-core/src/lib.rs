//! # partita-core
//!
//! The engine behind Partita, independent of any user interface:
//!
//! - [`model`]: the musical data model (score, staves, measures, voices, events).
//! - [`ops`]: primitive, invertible edits; the only way a score changes.
//! - [`cursor`]: text-editor style caret and selection.
//! - [`history`]: undo/redo with word-processor style grouping.
//! - [`document`]: an open document and every editing command.
//! - [`file`]: the `.partita` file format and atomic saving.
//! - [`musicxml`]: MusicXML import and export.
//! - [`recovery`]: snapshot + journal crash recovery.
//! - [`session`]: a document wired to its recovery journal.

pub mod cursor;
pub mod document;
pub mod file;
pub mod history;
pub mod model;
pub mod musicxml;
pub mod ops;
pub mod playback;
pub mod recovery;
pub mod session;

pub use cursor::{Caret, Move, SelectionRange};
pub use document::{Clipboard, Document, EditError, JournalEntry, StaffProps};
pub use model::*;
pub use recovery::{Recoverable, RecoveryStore};
pub use session::{now_ms, Session};
