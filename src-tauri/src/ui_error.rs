//! Errors as the frontend receives them: a `code` it translates
//! (`error.<code>` in `src/locales/`), the values to fill in (`args`), and
//! the English text as a fallback for codes it does not know.
//!
//! Details that come from the operating system or a library (an I/O error,
//! a parser message) travel as `args.detail` and are shown as they are.

use std::fmt;

use partita_core::document::EditError;
use partita_core::file::FileError;
use partita_core::musicxml::MusicXmlError;
use partita_core::ops::OpError;
use partita_core::recovery::RecoveryError;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
pub struct UiError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub args: Map<String, Value>,
    pub message: String,
}

impl UiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            args: Map::new(),
            message: message.into(),
        }
    }

    pub fn arg(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.args.insert(name.to_string(), value.into());
        self
    }

    /// An error that has a code and a technical detail to show with it.
    fn detailed(code: &'static str, message: impl fmt::Display, detail: impl fmt::Display) -> Self {
        Self::new(code, message.to_string()).arg("detail", detail.to_string())
    }

    /// Something that should not happen (a bug, or a stale document id).
    pub fn internal(message: impl fmt::Display) -> Self {
        let message = message.to_string();
        Self::new("internal", message.clone()).arg("detail", message)
    }
}

impl fmt::Display for UiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Messages without a code yet (audio, updater): shown as they are.
impl From<String> for UiError {
    fn from(message: String) -> Self {
        Self::new("other", message)
    }
}

impl From<&str> for UiError {
    fn from(message: &str) -> Self {
        Self::new("other", message)
    }
}

impl From<std::io::Error> for UiError {
    fn from(e: std::io::Error) -> Self {
        Self::detailed("io", &e, &e)
    }
}

impl From<uuid::Error> for UiError {
    fn from(e: uuid::Error) -> Self {
        Self::internal(e)
    }
}

impl From<FileError> for UiError {
    fn from(e: FileError) -> Self {
        match &e {
            FileError::Io(io) => Self::detailed("io", &e, io),
            FileError::Parse(p) => Self::detailed("file.parse", &e, p),
            FileError::WrongFormat => Self::new("file.wrong_format", e.to_string()),
            FileError::TooNew(v) => Self::new("file.too_new", e.to_string()).arg("version", *v),
            FileError::Corrupt(d) => Self::detailed("file.corrupt", &e, d),
        }
    }
}

impl From<MusicXmlError> for UiError {
    fn from(e: MusicXmlError) -> Self {
        match &e {
            MusicXmlError::Io(io) => Self::detailed("io", &e, io),
            MusicXmlError::Xml(d) => Self::detailed("musicxml.invalid", &e, d),
            MusicXmlError::NotAScore => Self::new("musicxml.not_a_score", e.to_string()),
            MusicXmlError::Timewise => Self::new("musicxml.timewise", e.to_string()),
            MusicXmlError::Archive(d) => Self::detailed("musicxml.archive", &e, d),
        }
    }
}

impl From<OpError> for UiError {
    fn from(e: OpError) -> Self {
        match &e {
            OpError::LastOne("measure") => Self::new("edit.last_measure", e.to_string()),
            OpError::LastOne("staff") => Self::new("edit.last_staff", e.to_string()),
            OpError::InvalidTime => Self::new("edit.invalid_time", e.to_string()),
            OpError::InvalidTempo(bpm) => {
                Self::new("edit.invalid_tempo", e.to_string()).arg("bpm", *bpm)
            }
            _ => Self::internal(e),
        }
    }
}

impl From<EditError> for UiError {
    fn from(e: EditError) -> Self {
        match e {
            EditError::Op(op) => op.into(),
            EditError::InvalidTime => Self::new("edit.invalid_time", e.to_string()),
            EditError::SlurNeedsSelection => Self::new("edit.slur_needs_selection", e.to_string()),
            EditError::SlurTooShort => Self::new("edit.slur_too_short", e.to_string()),
            EditError::GroupSplit => Self::new("edit.group_split", e.to_string()),
        }
    }
}

impl From<RecoveryError> for UiError {
    fn from(e: RecoveryError) -> Self {
        match &e {
            RecoveryError::BadSnapshot => Self::new("recovery.damaged", e.to_string()),
            RecoveryError::InUse => Self::new("recovery.in_use", e.to_string()),
            RecoveryError::Io(io) => Self::detailed("io", &e, io),
            RecoveryError::Encode(d) => Self::detailed("recovery.failed", &e, d),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_carry_a_code_and_their_values() {
        let e = UiError::from(FileError::TooNew(9));
        assert_eq!(e.code, "file.too_new");
        assert_eq!(e.args["version"], 9);
        let e = UiError::from(EditError::Op(OpError::LastOne("staff")));
        assert_eq!(e.code, "edit.last_staff");
        let json = serde_json::to_value(UiError::from(EditError::SlurTooShort)).unwrap();
        assert_eq!(json["code"], "edit.slur_too_short");
        assert!(json.get("args").is_none(), "empty args are left out");
        assert_eq!(json["message"], "A slur needs at least two notes");
    }

    #[test]
    fn unknown_failures_keep_their_text() {
        let e = UiError::from(OpError::SlurIndex(3));
        assert_eq!(e.code, "internal");
        assert_eq!(e.args["detail"], "slur index 3 out of range");
    }
}
