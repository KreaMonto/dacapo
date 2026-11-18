//! Crash recovery: snapshot + write-ahead journal per open document.
//!
//! Every open document (saved or untitled) owns a directory:
//!
//! ```text
//! <recovery root>/<session uuid>/
//!     lock           held with an OS file lock while the session is alive
//!     manifest.json  human-readable description (name, path, timestamps)
//!     snapshot.bin   full document state at journal sequence N (CRC-checked)
//!     journal.bin    edits after N, one CRC-checked record each
//! ```
//!
//! Edits are appended to the journal as they happen by a background thread
//! that forces them to disk every [`DEFAULT_SYNC_INTERVAL`]. Periodically
//! the whole document is written as a new snapshot (atomically) and the
//! journal is truncated. After a crash, a session directory whose lock can
//! be taken belongs to a dead process: loading its snapshot and replaying
//! its journal gives back the work, including the undo history. A record
//! torn by a power cut fails its CRC and is ignored together with anything
//! after it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::document::{Document, JournalEntry};
use crate::file::atomic_write;

/// How often appended journal records are forced to the physical disk.
/// This bounds how much work a power cut can lose.
pub const DEFAULT_SYNC_INTERVAL: Duration = Duration::from_millis(500);

// The binary encoding is not self-describing, so any change to the document
// types must bump these: data from an older build is then reported as
// unreadable instead of being misread.
//
// Version 4 added lyrics to events, version 5 an instrument to staves,
// version 6 the page texts (subtitle, header, footer, page numbers...) to
// the score's metadata, version 7 tempo markings to measures, version 8
// texts to events and rehearsal marks to measures, version 9 text styles
// and text boxes to the score, version 10 barline types and version 11
// repeats to measures. Older data (version 3: Da Capo 0.2.0 and 0.2.1;
// version 4: Da Capo 0.2.2; version 5: Partita 0.3.0; versions 6 to 10:
// development builds before 0.4.0) is still read:
// updating the program must not lose the unsaved work it promises to give
// back after the restart. It is never written.
// (The "DC" in the magic bytes is from the project's former name.)
const FORMAT_VERSION: u32 = 11;
const READABLE_VERSIONS: [u32; 9] = [11, 10, 9, 8, 7, 6, 5, 4, 3];

fn journal_magic(version: u32) -> [u8; 4] {
    [b'D', b'C', b'J', version as u8]
}

fn snapshot_magic(version: u32) -> [u8; 4] {
    [b'D', b'C', b'S', version as u8]
}

/// Which readable format `bytes` starts with, and the rest after the magic.
fn strip_magic(bytes: &[u8], magic: fn(u32) -> [u8; 4]) -> Option<(u32, &[u8])> {
    READABLE_VERSIONS.iter().find_map(|&v| {
        bytes
            .strip_prefix(magic(v).as_slice())
            .map(|rest| (v, rest))
    })
}

/// Decodes binary data written in format `version`.
fn decode<T: serde::de::DeserializeOwned>(
    payload: &[u8],
    version: u32,
) -> Result<T, postcard::Error> {
    if version == FORMAT_VERSION {
        postcard::from_bytes(payload)
    } else {
        crate::model::reading_legacy(version, || postcard::from_bytes(payload))
    }
}

const LOCK_FILE: &str = "lock";
const MANIFEST_FILE: &str = "manifest.json";
const SNAPSHOT_FILE: &str = "snapshot.bin";
const JOURNAL_FILE: &str = "journal.bin";

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
    #[error("encoding error: {0}")]
    Encode(#[from] postcard::Error),
    #[error("recovery snapshot is missing or damaged")]
    BadSnapshot,
    #[error("recovery session is still in use by a running instance")]
    InUse,
}

/// One journal record: a document change and its sequence number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalRecord {
    pub seq: u64,
    pub entry: JournalEntry,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    /// Journal records with `seq <= this` are already included.
    seq: u64,
    document: Document,
}

/// Human-readable description of a recovery session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub session_id: Uuid,
    pub display_name: String,
    pub path: Option<PathBuf>,
    pub created_ms: u64,
    pub updated_ms: u64,
}

// ----- framing ---------------------------------------------------------------

/// `[len: u32 LE][crc32(payload): u32 LE][payload]`
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&crc32fast::hash(payload).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Reads one frame; `None` if truncated or the checksum does not match.
fn unframe(bytes: &[u8]) -> Option<(&[u8], usize)> {
    if bytes.len() < 8 {
        return None;
    }
    let len = u32::from_le_bytes(bytes[0..4].try_into().ok()?) as usize;
    let crc = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let payload = bytes.get(8..8 + len)?;
    (crc32fast::hash(payload) == crc).then_some((payload, 8 + len))
}

/// Encodes a journal record ready to append.
pub fn encode_record(record: &JournalRecord) -> Result<Vec<u8>, postcard::Error> {
    Ok(frame(&postcard::to_stdvec(record)?))
}

/// Parses a journal file. Returns the valid records and whether trailing
/// bytes had to be discarded (torn or corrupted write).
pub fn decode_journal(bytes: &[u8]) -> (Vec<JournalRecord>, bool) {
    let Some((version, mut rest)) = strip_magic(bytes, journal_magic) else {
        return (Vec::new(), !bytes.is_empty());
    };
    let mut records = Vec::new();
    while !rest.is_empty() {
        let Some((payload, used)) = unframe(rest) else {
            return (records, true);
        };
        match decode(payload, version) {
            Ok(r) => records.push(r),
            Err(_) => return (records, true),
        }
        rest = &rest[used..];
    }
    (records, false)
}

fn encode_snapshot(seq: u64, document: &Document) -> Result<Vec<u8>, postcard::Error> {
    let payload = postcard::to_stdvec(&Snapshot {
        version: FORMAT_VERSION,
        seq,
        document: document.clone(),
    })?;
    let mut out = snapshot_magic(FORMAT_VERSION).to_vec();
    out.extend(frame(&payload));
    Ok(out)
}

fn decode_snapshot(bytes: &[u8]) -> Result<Snapshot, RecoveryError> {
    let (version, rest) = strip_magic(bytes, snapshot_magic).ok_or(RecoveryError::BadSnapshot)?;
    let (payload, _) = unframe(rest).ok_or(RecoveryError::BadSnapshot)?;
    let snap: Snapshot = decode(payload, version).map_err(|_| RecoveryError::BadSnapshot)?;
    if snap.version != version {
        return Err(RecoveryError::BadSnapshot);
    }
    Ok(snap)
}

fn reset_journal(path: &Path) -> io::Result<File> {
    let mut f = File::create(path)?;
    f.write_all(&journal_magic(FORMAT_VERSION))?;
    f.sync_all()?;
    Ok(f)
}

// ----- loading ---------------------------------------------------------------

/// Result of reading a recovery directory.
#[derive(Debug)]
pub struct LoadedSession {
    pub document: Document,
    /// Number of journal entries replayed on top of the snapshot.
    pub replayed: usize,
    /// True if damaged trailing data was ignored (normal after a power cut).
    pub truncated: bool,
}

/// Rebuilds a document from a session directory (snapshot + journal).
pub fn load_dir(dir: &Path) -> Result<LoadedSession, RecoveryError> {
    let snap = decode_snapshot(&fs::read(dir.join(SNAPSHOT_FILE))?)?;
    let mut document = snap.document;
    let journal = fs::read(dir.join(JOURNAL_FILE)).unwrap_or_default();
    let (records, mut truncated) = decode_journal(&journal);
    let mut replayed = 0;
    let mut expected = snap.seq + 1;
    for record in records {
        if record.seq < expected {
            continue; // already contained in the snapshot
        }
        if record.seq != expected || document.replay(&record.entry).is_err() {
            truncated = true;
            break;
        }
        expected += 1;
        replayed += 1;
    }
    Ok(LoadedSession {
        document,
        replayed,
        truncated,
    })
}

// ----- the store -------------------------------------------------------------

/// A session left behind by a crash.
#[derive(Clone, Debug, Serialize)]
pub struct Recoverable {
    pub session_id: Uuid,
    pub manifest: Option<Manifest>,
    /// Whether the session contains changes that were never saved.
    pub has_unsaved_changes: bool,
}

/// The directory holding every recovery session of this user.
#[derive(Clone, Debug)]
pub struct RecoveryStore {
    root: PathBuf,
    sync_interval: Duration,
}

impl RecoveryStore {
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(RecoveryStore {
            root,
            sync_interval: DEFAULT_SYNC_INTERVAL,
        })
    }

    /// Overrides how often the journal is forced to disk.
    pub fn with_sync_interval(mut self, interval: Duration) -> Self {
        self.sync_interval = interval;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, id: Uuid) -> PathBuf {
        self.root.join(id.to_string())
    }

    /// Starts a new session for `document` and writes its first snapshot.
    pub fn create(
        &self,
        id: Uuid,
        document: &Document,
        now_ms: u64,
    ) -> Result<RecoveryWriter, RecoveryError> {
        let dir = self.dir(id);
        fs::create_dir_all(&dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(LOCK_FILE))?;
        lock.try_lock().map_err(|_| RecoveryError::InUse)?;
        let manifest = Manifest {
            session_id: id,
            display_name: document.display_name(),
            path: document.path.clone(),
            created_ms: now_ms,
            updated_ms: now_ms,
        };
        atomic_write(&dir.join(SNAPSHOT_FILE), &encode_snapshot(0, document)?)?;
        atomic_write(
            &dir.join(MANIFEST_FILE),
            &serde_json::to_vec_pretty(&manifest).map_err(io::Error::other)?,
        )?;
        let journal = reset_journal(&dir.join(JOURNAL_FILE))?;

        let (tx, rx) = mpsc::channel();
        let worker_dir = dir.clone();
        let interval = self.sync_interval;
        let handle = std::thread::Builder::new()
            .name(format!("partita-recovery-{id}"))
            .spawn(move || worker(worker_dir, journal, rx, interval))?;
        Ok(RecoveryWriter {
            id,
            dir,
            manifest,
            tx,
            handle: Some(handle),
            lock: Some(lock),
        })
    }

    /// Sessions left behind by instances that are no longer running.
    /// Orphans without unsaved changes are cleaned up silently.
    pub fn scan(&self) -> Vec<Recoverable> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            let Some(id) = entry
                .file_name()
                .to_str()
                .and_then(|n| Uuid::parse_str(n).ok())
            else {
                continue;
            };
            let dir = entry.path();
            if is_locked(&dir) {
                continue; // alive in this or another running instance
            }
            let manifest = fs::read(dir.join(MANIFEST_FILE))
                .ok()
                .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok());
            match load_dir(&dir) {
                Ok(loaded) if !loaded.document.is_dirty() => {
                    let _ = fs::remove_dir_all(&dir);
                }
                Ok(_) => found.push(Recoverable {
                    session_id: id,
                    manifest,
                    has_unsaved_changes: true,
                }),
                Err(_) if manifest.is_none() => {
                    // Crashed while the session was being created: nothing to save.
                    let _ = fs::remove_dir_all(&dir);
                }
                Err(_) => found.push(Recoverable {
                    session_id: id,
                    manifest,
                    has_unsaved_changes: true,
                }),
            }
        }
        found.sort_by_key(|r| std::cmp::Reverse(r.manifest.as_ref().map(|m| m.updated_ms)));
        found
    }

    /// Loads an orphaned session.
    pub fn load(&self, id: Uuid) -> Result<LoadedSession, RecoveryError> {
        let dir = self.dir(id);
        if is_locked(&dir) {
            return Err(RecoveryError::InUse);
        }
        load_dir(&dir)
    }

    /// Deletes an orphaned session.
    pub fn discard(&self, id: Uuid) -> Result<(), RecoveryError> {
        let dir = self.dir(id);
        if is_locked(&dir) {
            return Err(RecoveryError::InUse);
        }
        fs::remove_dir_all(dir)?;
        Ok(())
    }
}

/// True when a live process holds the session's lock.
fn is_locked(dir: &Path) -> bool {
    let Ok(f) = OpenOptions::new().write(true).open(dir.join(LOCK_FILE)) else {
        return false;
    };
    let locked = f.try_lock().is_err();
    if !locked {
        let _ = f.unlock();
    }
    locked
}

// ----- the writer ------------------------------------------------------------

enum Msg {
    Append(Vec<u8>),
    Snapshot {
        snapshot: Vec<u8>,
        manifest: Vec<u8>,
    },
    Flush(Sender<io::Result<()>>),
    Close,
}

/// Handle to a live recovery session. Writes happen on a background thread
/// so editing never waits for the disk.
pub struct RecoveryWriter {
    id: Uuid,
    dir: PathBuf,
    manifest: Manifest,
    tx: Sender<Msg>,
    handle: Option<JoinHandle<()>>,
    lock: Option<File>,
}

impl RecoveryWriter {
    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Queues a journal record.
    pub fn append(&self, record: &JournalRecord) -> Result<(), RecoveryError> {
        let bytes = encode_record(record)?;
        let _ = self.tx.send(Msg::Append(bytes));
        Ok(())
    }

    /// Queues a full snapshot at journal sequence `seq`; the journal is
    /// truncated once the snapshot is safely on disk.
    pub fn snapshot(
        &mut self,
        seq: u64,
        document: &Document,
        now_ms: u64,
    ) -> Result<(), RecoveryError> {
        self.manifest.display_name = document.display_name();
        self.manifest.path = document.path.clone();
        self.manifest.updated_ms = now_ms;
        let manifest = serde_json::to_vec_pretty(&self.manifest).map_err(io::Error::other)?;
        let snapshot = encode_snapshot(seq, document)?;
        let _ = self.tx.send(Msg::Snapshot { snapshot, manifest });
        Ok(())
    }

    /// Blocks until everything queued so far is on disk.
    pub fn sync(&self) -> io::Result<()> {
        let (reply, wait) = mpsc::channel();
        self.tx
            .send(Msg::Flush(reply))
            .map_err(|_| io::Error::other("recovery writer stopped"))?;
        wait.recv()
            .unwrap_or_else(|_| Err(io::Error::other("recovery writer stopped")))
    }

    /// Stops the writer. With `delete` the session directory is removed
    /// (normal close); otherwise it is left for the next start to recover.
    pub fn close(mut self, delete: bool) -> io::Result<()> {
        self.shutdown();
        if delete {
            fs::remove_dir_all(&self.dir)?;
        }
        Ok(())
    }

    fn shutdown(&mut self) {
        let _ = self.tx.send(Msg::Close);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        // Dropping the handle releases the OS lock.
        self.lock.take();
    }
}

impl Drop for RecoveryWriter {
    fn drop(&mut self) {
        // Keep the directory: if we got here without `close`, something
        // went wrong and the data should stay recoverable.
        self.shutdown();
    }
}

fn worker(dir: PathBuf, mut journal: File, rx: mpsc::Receiver<Msg>, interval: Duration) {
    let journal_path = dir.join(JOURNAL_FILE);
    let mut unsynced = false;
    let mut last_sync = Instant::now();
    let mut error: Option<io::Error> = None;

    let note = |r: io::Result<()>, error: &mut Option<io::Error>| {
        if let Err(e) = r {
            eprintln!("[partita] recovery write failed in {}: {e}", dir.display());
            error.get_or_insert(e);
        }
    };

    loop {
        let timeout = if unsynced {
            interval.saturating_sub(last_sync.elapsed())
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(timeout) {
            Ok(Msg::Append(bytes)) => {
                note(journal.write_all(&bytes), &mut error);
                unsynced = true;
            }
            Ok(Msg::Snapshot { snapshot, manifest }) => {
                // Journal first, so the snapshot never gets ahead of it.
                note(journal.sync_data(), &mut error);
                let r = atomic_write(&dir.join(SNAPSHOT_FILE), &snapshot)
                    .and_then(|_| atomic_write(&dir.join(MANIFEST_FILE), &manifest));
                let ok = r.is_ok();
                note(r, &mut error);
                if ok {
                    match reset_journal(&journal_path) {
                        Ok(f) => journal = f,
                        Err(e) => note(Err(e), &mut error),
                    }
                }
                unsynced = false;
                last_sync = Instant::now();
            }
            Ok(Msg::Flush(reply)) => {
                note(journal.sync_data(), &mut error);
                unsynced = false;
                last_sync = Instant::now();
                let _ = reply.send(match error.take() {
                    Some(e) => Err(e),
                    None => Ok(()),
                });
            }
            Ok(Msg::Close) | Err(RecvTimeoutError::Disconnected) => {
                note(journal.sync_data(), &mut error);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if unsynced && last_sync.elapsed() >= interval {
            note(journal.sync_data(), &mut error);
            unsynced = false;
            last_sync = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::Caret;
    use crate::history::TxKind;

    fn record(seq: u64) -> JournalRecord {
        JournalRecord {
            seq,
            entry: JournalEntry::Commit {
                kind: TxKind::Edit,
                ops: vec![],
                caret_before: Caret::default(),
                caret_after: Caret::default(),
                time_ms: seq,
                merge: false,
            },
        }
    }

    #[test]
    fn journal_survives_torn_tail() {
        let mut bytes = journal_magic(FORMAT_VERSION).to_vec();
        for seq in 1..=3 {
            bytes.extend(encode_record(&record(seq)).unwrap());
        }
        let full = bytes.len();
        let (records, damaged) = decode_journal(&bytes);
        assert_eq!(records.len(), 3);
        assert!(!damaged);

        // Power cut in the middle of the last record.
        let (records, damaged) = decode_journal(&bytes[..full - 3]);
        assert_eq!(records.len(), 2);
        assert!(damaged);

        // Bit flip in the second record: it and everything after is dropped.
        let mut flipped = bytes.clone();
        let second = 4 + encode_record(&record(1)).unwrap().len() + 10;
        flipped[second] ^= 0xFF;
        let (records, damaged) = decode_journal(&flipped);
        assert_eq!(records.len(), 1);
        assert!(damaged);
    }

    #[test]
    fn snapshot_detects_corruption() {
        let doc = Document::new(crate::model::Score::new("x", 1));
        let mut bytes = encode_snapshot(7, &doc).unwrap();
        assert_eq!(decode_snapshot(&bytes).unwrap().seq, 7);
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(decode_snapshot(&bytes).is_err());
    }
}
