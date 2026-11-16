//! The `.dacapo` document format and crash-safe file writing.
//!
//! A `.dacapo` file is UTF-8 JSON with a format marker and version so future
//! releases can migrate old files:
//!
//! ```json
//! { "format": "dacapo", "format_version": 1, "score": { ... } }
//! ```

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{Issue, Score};

/// File extension of Da Capo documents (without the dot).
pub const FILE_EXTENSION: &str = "dacapo";
/// Version written by this build.
pub const FORMAT_VERSION: u32 = 1;
const FORMAT_MARKER: &str = "dacapo";

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
    #[error("not a valid Da Capo file: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("not a Da Capo file")]
    WrongFormat,
    #[error("file was written by a newer version of Da Capo (format {0})")]
    TooNew(u32),
    #[error("file is damaged: {0}")]
    Corrupt(String),
}

/// Serializes a score into the `.dacapo` format.
pub fn to_bytes(score: &Score) -> Result<Vec<u8>, FileError> {
    let envelope = Envelope {
        format: FORMAT_MARKER.to_string(),
        format_version: FORMAT_VERSION,
        score: score.clone(),
    };
    Ok(serde_json::to_vec_pretty(&envelope)?)
}

/// Parses and validates a `.dacapo` document.
pub fn from_bytes(bytes: &[u8]) -> Result<Score, FileError> {
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    if envelope.format != FORMAT_MARKER {
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
        let path = dir.path().join("song.dacapo");
        let score = Score::new("Song", 3);
        save_score(&path, &score).unwrap();
        assert_eq!(load_score(&path).unwrap(), score);
        // Second save keeps a backup and leaves no temp file behind.
        save_score(&path, &score).unwrap();
        assert!(sibling(&path, ".bak").exists());
        assert!(!sibling(&path, ".tmp").exists());
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
