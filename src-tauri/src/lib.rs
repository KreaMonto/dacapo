//! Tauri shell of Da Capo: exposes `dacapo-core` to the web frontend.
//!
//! The Rust side owns every open document. The frontend only sends
//! [`Action`]s and redraws from the [`DocView`] it gets back, so a frontend
//! crash can never lose work.

mod audio;
mod updater;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dacapo_core::cursor::{Caret, Move, SelectionRange};
use dacapo_core::document::{Clipboard, Document};
use dacapo_core::file;
use dacapo_core::model::{
    Articulation, Clef, Duration, Dynamic, Issue, KeySignature, LyricJoin, Metadata, Score, Step,
    TimeSignature,
};
use dacapo_core::recovery::{Recoverable, RecoveryStore};
use dacapo_core::session::{now_ms, Session};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

/// Everything the Rust side keeps between calls.
struct AppState {
    store: Option<RecoveryStore>,
    inner: Mutex<Inner>,
    audio: Arc<audio::Engine>,
    updates: updater::Updates,
}

#[derive(Default)]
struct Inner {
    /// Open documents in tab order.
    sessions: Vec<Session>,
    /// Shared between documents, like a word processor's clipboard.
    clipboard: Option<Clipboard>,
    untitled_counter: u32,
}

impl Inner {
    fn find(&mut self, id: &str) -> Result<&mut Session, String> {
        self.sessions
            .iter_mut()
            .find(|s| s.id().to_string() == id)
            .ok_or_else(|| format!("document {id} is not open"))
    }
}

/// What the frontend needs to draw a document.
#[derive(Serialize)]
struct DocView<'a> {
    id: String,
    name: String,
    path: Option<String>,
    dirty: bool,
    can_undo: bool,
    can_redo: bool,
    /// Whether crash recovery is active for this document.
    protected: bool,
    warning: Option<String>,
    score: &'a Score,
    caret: Caret,
    selection: Option<SelectionRange>,
    issues: Vec<Issue>,
}

fn view(session: &mut Session) -> serde_json::Value {
    let warning = session.take_warning();
    let doc = session.doc();
    let v = DocView {
        id: session.id().to_string(),
        name: doc.display_name(),
        path: doc.path.as_ref().map(|p| p.display().to_string()),
        dirty: doc.is_dirty(),
        can_undo: doc.can_undo(),
        can_redo: doc.can_redo(),
        protected: session.is_protected(),
        warning,
        score: &doc.score,
        caret: doc.caret(),
        selection: doc.selection(),
        issues: doc.score.validate(),
    };
    serde_json::to_value(v).expect("view serializes")
}

#[derive(Serialize)]
struct TabInfo {
    id: String,
    name: String,
    dirty: bool,
}

#[derive(Deserialize)]
struct EraseTarget {
    id: u64,
    pitch: Option<dacapo_core::model::Pitch>,
}

/// Editing commands sent by the frontend.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    /// Placing an accidental with the mouse (a chord tone alone when `pitch` is set).
    SetAccidentalAt {
        id: u64,
        pitch: Option<dacapo_core::model::Pitch>,
        alter: i8,
    },
    /// Dragging a notehead up or down (a chord tone alone when `pitch` is set).
    MovePitch {
        id: u64,
        pitch: Option<dacapo_core::model::Pitch>,
        steps: i32,
    },
    /// The eraser: whole events, or single chord tones when `pitch` is set.
    Erase {
        targets: Vec<EraseTarget>,
    },
    InsertNote {
        step: Step,
        duration: Duration,
    },
    InsertRest {
        duration: Duration,
    },
    AddToChord {
        step: Step,
    },
    /// Mouse entry: note at an insertion point.
    PlaceNote {
        at: Caret,
        step: Step,
        octave: i8,
        duration: Duration,
    },
    /// Mouse entry: rest at an insertion point.
    PlaceRest {
        at: Caret,
        duration: Duration,
    },
    /// Mouse entry on an existing event (`at.index` = event index).
    AddPitch {
        at: Caret,
        step: Step,
        octave: i8,
    },
    DeleteBackward,
    DeleteForward,
    Move {
        to: Move,
        extend: bool,
    },
    SetCaret {
        caret: Caret,
        extend: bool,
    },
    SelectAll,
    Transpose {
        steps: i32,
    },
    Accidental {
        delta: i8,
    },
    SetAccidental {
        alter: i8,
    },
    ToggleTie,
    ToggleSlur,
    ToggleArticulation {
        articulation: Articulation,
    },
    SetDynamic {
        dynamic: Dynamic,
    },
    /// The syllable event `id` sings in `verse` (0 = first); empty text
    /// removes it.
    SetLyric {
        id: u64,
        verse: usize,
        text: String,
        #[serde(default)]
        join: LyricJoin,
    },
    SetDuration {
        duration: Duration,
    },
    Copy,
    Cut,
    Paste,
    Undo,
    Redo,
    InsertMeasure,
    RemoveMeasure,
    AddStaff {
        clef: Clef,
    },
    RemoveStaff,
    SetClef {
        clef: Clef,
    },
    SetTime {
        beats: u8,
        beat_type: u8,
    },
    SetKey {
        fifths: i8,
    },
    SetMetadata {
        title: String,
        composer: String,
    },
    SetTempo {
        bpm: u16,
    },
}

fn start_session(state: &AppState, doc: Document) -> Result<Session, String> {
    match Session::start(doc.clone(), state.store.as_ref()) {
        Ok(s) => Ok(s),
        Err(e) => {
            // Better to edit unprotected than not at all; the UI shows it.
            eprintln!("[dacapo] crash recovery unavailable: {e}");
            Session::start(doc, None).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn list_documents(state: State<AppState>) -> Vec<TabInfo> {
    let inner = state.inner.lock().unwrap();
    inner
        .sessions
        .iter()
        .map(|s| TabInfo {
            id: s.id().to_string(),
            name: s.doc().display_name(),
            dirty: s.doc().is_dirty(),
        })
        .collect()
}

#[tauri::command]
fn new_document(state: State<AppState>) -> Result<serde_json::Value, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.untitled_counter += 1;
    let title = format!("Untitled {}", inner.untitled_counter);
    let mut session = start_session(&state, Document::new(Score::new(title, 8)))?;
    let v = view(&mut session);
    inner.sessions.push(session);
    Ok(v)
}

#[tauri::command]
fn open_document(state: State<AppState>, path: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(path);
    let mut inner = state.inner.lock().unwrap();
    if let Some(s) = inner
        .sessions
        .iter_mut()
        .find(|s| s.doc().path.as_deref() == Some(path.as_path()))
    {
        return Ok(view(s));
    }
    let score = file::load_score(&path).map_err(|e| e.to_string())?;
    let mut session = start_session(&state, Document::opened(score, path))?;
    let v = view(&mut session);
    inner.sessions.push(session);
    Ok(v)
}

#[tauri::command]
fn get_document(state: State<AppState>, id: String) -> Result<serde_json::Value, String> {
    let mut inner = state.inner.lock().unwrap();
    Ok(view(inner.find(&id)?))
}

#[tauri::command]
fn edit(state: State<AppState>, id: String, action: Action) -> Result<serde_json::Value, String> {
    let mut inner = state.inner.lock().unwrap();
    let clipboard = inner.clipboard.clone();
    let now = now_ms();
    let session = inner.find(&id)?;
    let mut copied: Option<Clipboard> = None;
    // Entering or re-pitching notes plays them, so you hear what you write.
    let preview = matches!(
        action,
        Action::InsertNote { .. }
            | Action::AddToChord { .. }
            | Action::PlaceNote { .. }
            | Action::AddPitch { .. }
            | Action::Transpose { .. }
            | Action::MovePitch { .. }
            | Action::SetAccidentalAt { .. }
            | Action::Accidental { .. }
            | Action::SetAccidental { .. }
    );
    let result = session.edit(|d| -> Result<(), String> {
        let r = match action {
            Action::InsertNote { step, duration } => d.insert_note(step, duration, now),
            Action::InsertRest { duration } => d.insert_rest(duration, now),
            Action::AddToChord { step } => d.add_to_chord(step, now),
            Action::PlaceNote {
                at,
                step,
                octave,
                duration,
            } => d.place_note(at, step, octave, duration, now),
            Action::PlaceRest { at, duration } => d.place_rest(at, duration, now),
            Action::AddPitch { at, step, octave } => d.add_pitch(at, step, octave, now),
            Action::DeleteBackward => d.delete_backward(now),
            Action::DeleteForward => d.delete_forward(now),
            Action::MovePitch { id, pitch, steps } => d.move_pitch(id, pitch, steps, now),
            Action::SetAccidentalAt { id, pitch, alter } => {
                d.set_accidental_at(id, pitch, alter, now)
            }
            Action::Erase { targets } => {
                let targets: Vec<_> = targets.into_iter().map(|t| (t.id, t.pitch)).collect();
                d.erase(&targets, now)
            }
            Action::Move { to, extend } => {
                d.move_caret(to, extend);
                Ok(())
            }
            Action::SetCaret { caret, extend } => {
                d.set_caret(caret, extend);
                Ok(())
            }
            Action::SelectAll => {
                d.select_all();
                Ok(())
            }
            Action::Transpose { steps } => d.transpose(steps, now),
            Action::Accidental { delta } => d.change_accidental(delta, now),
            Action::SetAccidental { alter } => d.set_accidental(alter, now),
            Action::ToggleTie => d.toggle_tie(now),
            Action::ToggleSlur => d.toggle_slur(now),
            Action::ToggleArticulation { articulation } => d.toggle_articulation(articulation, now),
            Action::SetDynamic { dynamic } => d.set_dynamic(dynamic, now),
            Action::SetLyric {
                id,
                verse,
                text,
                join,
            } => d.set_lyric(id, verse, &text, join, now),
            Action::SetDuration { duration } => d.set_duration(duration, now),
            Action::Copy => {
                copied = d.copy();
                Ok(())
            }
            Action::Cut => d.cut(now).map(|c| copied = c),
            Action::Paste => match &clipboard {
                Some(c) => d.paste(c, now),
                None => Ok(()),
            },
            Action::Undo => d.undo().map(|_| ()),
            Action::Redo => d.redo().map(|_| ()),
            Action::InsertMeasure => d.insert_measure(d.caret().measure + 1, now),
            Action::RemoveMeasure => d.remove_measure(d.caret().measure, now),
            Action::AddStaff { clef } => {
                let name = format!("Staff {}", d.score.staves.len() + 1);
                d.add_staff(name, clef, now)
            }
            Action::RemoveStaff => d.remove_staff(d.caret().staff, now),
            Action::SetClef { clef } => d.set_clef(d.caret().staff, clef, now),
            Action::SetTime { beats, beat_type } => {
                d.set_time_signature(TimeSignature { beats, beat_type }, now)
            }
            Action::SetKey { fifths } => d.set_key_signature(
                KeySignature {
                    fifths: fifths.clamp(-7, 7),
                },
                now,
            ),
            Action::SetMetadata { title, composer } => {
                d.set_metadata(Metadata { title, composer }, now)
            }
            Action::SetTempo { bpm } => d.set_tempo(bpm, now),
        };
        r.map_err(|e| e.to_string())
    });
    if result.is_ok() && preview {
        let d = session.doc();
        let c = d.caret();
        if let Some(e) = c
            .index
            .checked_sub(1)
            .and_then(|i| d.score.voice(c.staff, c.measure, c.voice)?.get(i))
        {
            let keys: Vec<u8> = e
                .pitches()
                .iter()
                .map(|p| p.midi().clamp(0, 127) as u8)
                .collect();
            state.audio.preview(c.staff, &keys);
        }
    }
    if let Some(c) = copied {
        inner.clipboard = Some(c);
    }
    result?;
    Ok(view(inner.find(&id)?))
}

// ----- playback ------------------------------------------------------------

#[tauri::command]
fn audio_status(state: State<AppState>) -> audio::SoundStatus {
    state.audio.status()
}

/// Starts downloading FluidR3_GM (the UI asked the user first).
#[tauri::command]
fn download_soundfont(state: State<AppState>) {
    state.audio.download_soundfont();
}

/// Plays the document from the caret (or from the beginning).
#[tauri::command]
fn play(state: State<AppState>, id: String, from_start: bool) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let doc = inner.find(&id)?.doc();
    let timeline = dacapo_core::playback::build(&doc.score);
    let from = if from_start {
        0
    } else {
        let c = doc.caret();
        let tick = dacapo_core::cursor::tick_at(&doc.score, c.staff, c.measure, c.voice, c.index);
        timeline.tick_at(c.measure, tick)
    };
    state.audio.play(timeline, from)
}

/// Pauses and moves the caret to where the music stopped, so pressing play
/// again continues from there (like a word processor's read-aloud).
#[tauri::command]
fn pause(state: State<AppState>, id: String) -> Result<serde_json::Value, String> {
    let stopped = state.audio.stop();
    let mut inner = state.inner.lock().unwrap();
    let session = inner.find(&id)?;
    session.edit(|d| {
        let c = d.caret();
        let measure = stopped.measure.min(d.score.measures.len() - 1);
        let index =
            dacapo_core::cursor::index_at_tick(&d.score, c.staff, measure, c.voice, stopped.tick);
        d.set_caret(
            Caret {
                measure,
                index,
                ..c
            },
            false,
        );
    });
    Ok(view(session))
}

/// Stops without moving the caret.
#[tauri::command]
fn stop_playback(state: State<AppState>) {
    state.audio.stop();
}

#[tauri::command]
fn playback_state(state: State<AppState>) -> audio::PlaybackState {
    state.audio.state()
}

// ----- about -----------------------------------------------------------------

/// A third-party component credited in the About dialog.
#[derive(Serialize)]
struct Credit {
    name: &'static str,
    version: &'static str,
    author: &'static str,
    license: &'static str,
    url: &'static str,
    role: &'static str,
}

#[derive(Serialize)]
struct AboutInfo {
    name: &'static str,
    version: &'static str,
    license: &'static str,
    repository: &'static str,
    issues: &'static str,
    os: &'static str,
    arch: &'static str,
    tauri: &'static str,
    file_format: u32,
    data_dir: String,
    soundfont: audio::SoundFontInfo,
    credits: Vec<Credit>,
}

const REPOSITORY: &str = "https://github.com/dacapo-editor/dacapo";

/// Everything the Help → About dialog shows: version, platform, the
/// SoundFont downloaded by the app, and credits for what Da Capo is built on.
#[tauri::command]
fn about_info(app: tauri::AppHandle, state: State<AppState>) -> AboutInfo {
    AboutInfo {
        name: "Da Capo",
        version: env!("CARGO_PKG_VERSION"),
        license: "GPL-3.0-or-later",
        repository: REPOSITORY,
        issues: "https://github.com/dacapo-editor/dacapo/issues",
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        tauri: tauri::VERSION,
        file_format: file::FORMAT_VERSION,
        data_dir: app
            .path()
            .app_local_data_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        soundfont: state.audio.soundfont_info(),
        credits: vec![
            Credit {
                name: "Bravura",
                version: "bundled",
                author: "Steinberg Media Technologies",
                license: "SIL Open Font License 1.1",
                url: "https://github.com/steinbergmedia/bravura",
                role: "Music font (SMuFL) used to engrave the score",
            },
            Credit {
                name: "FluidR3 GM",
                version: "3.1",
                author: "Frank Wen",
                license: "MIT",
                url: "https://github.com/pianobooster/fluid-soundfont",
                role: "Instrument sounds for playback (downloaded on first use)",
            },
            Credit {
                name: "RustySynth",
                version: "1.3",
                author: "Nobuaki Tanaka",
                license: "MIT",
                url: "https://github.com/sinshu/rustysynth",
                role: "SoundFont synthesizer",
            },
            Credit {
                name: "cpal",
                version: "0.15",
                author: "The RustAudio developers",
                license: "Apache-2.0",
                url: "https://github.com/RustAudio/cpal",
                role: "Audio output",
            },
            Credit {
                name: "Tauri",
                version: tauri::VERSION,
                author: "The Tauri Programme",
                license: "MIT or Apache-2.0",
                url: "https://tauri.app",
                role: "Desktop application framework",
            },
            Credit {
                name: "ureq",
                version: "2",
                author: "Martin Algesten and contributors",
                license: "MIT or Apache-2.0",
                url: "https://github.com/algesten/ureq",
                role: "Downloading the SoundFont",
            },
            Credit {
                name: "serde · postcard · crc32fast",
                version: "1",
                author: "Their respective authors",
                license: "MIT or Apache-2.0",
                url: "https://serde.rs",
                role: "Saving files and crash-recovery data",
            },
        ],
    }
}

/// Opens the folder that holds the downloaded SoundFont.
#[tauri::command]
fn reveal_soundfont_folder(state: State<AppState>) -> Result<String, String> {
    let dir = state.audio.soundfont_dir().to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

#[tauri::command]
fn save_document(
    state: State<AppState>,
    id: String,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut inner = state.inner.lock().unwrap();
    let session = inner.find(&id)?;
    let mut path = match path
        .map(PathBuf::from)
        .or_else(|| session.doc().path.clone())
    {
        Some(p) => p,
        None => return Err("no file name chosen".into()),
    };
    if path.extension().is_none() {
        path.set_extension(file::FILE_EXTENSION);
    }
    session.save(&path).map_err(|e| e.to_string())?;
    Ok(view(session))
}

/// Closes a tab. Refuses to drop unsaved work unless `discard` is set.
#[tauri::command]
fn close_document(state: State<AppState>, id: String, discard: bool) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let pos = inner
        .sessions
        .iter()
        .position(|s| s.id().to_string() == id)
        .ok_or("document is not open")?;
    if inner.sessions[pos].doc().is_dirty() && !discard {
        return Err("document has unsaved changes".into());
    }
    let session = inner.sessions.remove(pos);
    session.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_recoverable(state: State<AppState>) -> Vec<Recoverable> {
    state.store.as_ref().map(|s| s.scan()).unwrap_or_default()
}

/// Reopens a document left behind by a crash.
#[tauri::command]
fn recover_document(
    state: State<AppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let store = state
        .store
        .as_ref()
        .ok_or("crash recovery is unavailable")?;
    let old = Uuid::parse_str(&session_id).map_err(|e| e.to_string())?;
    let loaded = store.load(old).map_err(|e| e.to_string())?;
    let mut session = start_session(&state, loaded.document)?;
    // The new session already holds a full snapshot; make it durable
    // before deleting the old one.
    session.sync().map_err(|e| e.to_string())?;
    let _ = store.discard(old);
    let v = view(&mut session);
    state.inner.lock().unwrap().sessions.push(session);
    Ok(v)
}

#[tauri::command]
fn discard_recoverable(state: State<AppState>, session_id: String) -> Result<(), String> {
    let store = state
        .store
        .as_ref()
        .ok_or("crash recovery is unavailable")?;
    let id = Uuid::parse_str(&session_id).map_err(|e| e.to_string())?;
    store.discard(id).map_err(|e| e.to_string())
}

/// Quits after the user confirmed (unsaved work is discarded).
#[tauri::command]
fn quit(app: tauri::AppHandle, state: State<AppState>) {
    let sessions = std::mem::take(&mut state.inner.lock().unwrap().sessions);
    for s in sessions {
        let _ = s.close();
    }
    app.exit(0);
}

/// Asks GitHub Releases whether a newer version exists.
#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<updater::UpdateStatus, String> {
    let updates = state.updates.clone();
    Ok(updates.check(&app).await)
}

#[tauri::command]
fn update_status(state: State<AppState>) -> updater::UpdateStatus {
    state.updates.status()
}

/// Starts downloading the update the user accepted.
#[tauri::command]
fn download_update(state: State<AppState>) -> Result<(), String> {
    state.updates.download()
}

/// Installs the downloaded update and restarts. Unsaved documents are
/// flushed to the recovery journal first, so they are offered back when the
/// new version starts, exactly as after a crash.
#[tauri::command]
fn install_update(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    state.audio.stop();
    for s in &state.inner.lock().unwrap().sessions {
        if s.doc().is_dirty() {
            s.sync()
                .map_err(|e| format!("Could not protect unsaved work: {e}"))?;
        }
    }
    state.updates.install()?;
    // Windows: the installer has already taken over and closed the app.
    app.restart()
}

/// Identifier used before the project moved to the dacapo-editor GitHub
/// organization (versions up to 0.2.0 development builds).
const OLD_IDENTIFIER: &str = "org.dacapo.editor";

/// Moves the downloaded SoundFont and pending crash-recovery data from the
/// old identifier's data folder, once, so nothing is lost or re-downloaded.
/// Only folders missing in the new location are moved; failures are logged
/// and the old data is left untouched.
fn migrate_old_data_dir(new_dir: &std::path::Path) {
    let Some(old_dir) = new_dir.parent().map(|p| p.join(OLD_IDENTIFIER)) else {
        return;
    };
    if !old_dir.is_dir() || old_dir == new_dir {
        return;
    }
    for sub in ["soundfonts", "recovery"] {
        let (from, to) = (old_dir.join(sub), new_dir.join(sub));
        if from.is_dir() && !to.exists() {
            let moved = std::fs::create_dir_all(new_dir).and_then(|_| std::fs::rename(&from, &to));
            match moved {
                Ok(()) => eprintln!("[dacapo] moved {} to {}", from.display(), to.display()),
                Err(e) => eprintln!("[dacapo] could not move {}: {e}", from.display()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_data_folder_is_migrated_once() {
        let base = std::env::temp_dir().join(format!("dacapo-migrate-{}", Uuid::new_v4()));
        let old = base.join(OLD_IDENTIFIER);
        let new = base.join("io.github.dacapo-editor.dacapo");
        std::fs::create_dir_all(old.join("soundfonts")).unwrap();
        std::fs::create_dir_all(old.join("recovery").join("abc")).unwrap();
        std::fs::write(
            old.join("soundfonts").join("FluidR3_GM.sf2"),
            b"RIFF....sfbk",
        )
        .unwrap();

        migrate_old_data_dir(&new);
        assert!(new.join("soundfonts").join("FluidR3_GM.sf2").is_file());
        assert!(new.join("recovery").join("abc").is_dir());
        assert!(!old.join("soundfonts").exists());

        // A second run (or a later old folder) never overwrites new data.
        std::fs::create_dir_all(old.join("soundfonts")).unwrap();
        std::fs::write(old.join("soundfonts").join("other.sf2"), b"x").unwrap();
        migrate_old_data_dir(&new);
        assert!(!new.join("soundfonts").join("other.sf2").exists());

        std::fs::remove_dir_all(&base).unwrap();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Opens links (website, licenses) and folders with the system's apps.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Ok(dir) = app.path().app_local_data_dir() {
                migrate_old_data_dir(&dir);
            }
            let store = app
                .path()
                .app_local_data_dir()
                .ok()
                .and_then(|dir| RecoveryStore::open(dir.join("recovery")).ok());
            if store.is_none() {
                eprintln!(
                    "[dacapo] could not open the recovery folder; documents are not protected"
                );
            }
            // SoundFonts live next to the recovery data, outside the repo.
            let soundfonts = app
                .path()
                .app_local_data_dir()
                .map(|d| d.join("soundfonts"))
                .unwrap_or_else(|_| PathBuf::from("soundfonts"));
            app.manage(AppState {
                store,
                inner: Mutex::new(Inner::default()),
                audio: Arc::new(audio::Engine::start(soundfonts)),
                updates: updater::Updates::default(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let dirty: Vec<String> = state
                    .inner
                    .lock()
                    .unwrap()
                    .sessions
                    .iter()
                    .filter(|s| s.doc().is_dirty())
                    .map(|s| s.doc().display_name())
                    .collect();
                if !dirty.is_empty() {
                    // Let the frontend ask; it calls `quit` if confirmed.
                    api.prevent_close();
                    let _ = window.emit("close-requested", dirty);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_documents,
            new_document,
            open_document,
            get_document,
            edit,
            save_document,
            close_document,
            list_recoverable,
            recover_document,
            discard_recoverable,
            quit,
            audio_status,
            download_soundfont,
            play,
            pause,
            stop_playback,
            playback_state,
            about_info,
            reveal_soundfont_folder,
            check_for_update,
            update_status,
            download_update,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Da Capo")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Clean documents are closed normally. Dirty ones keep their
                // recovery data so nothing is lost if we are being killed
                // (logoff, shutdown) without the user being asked.
                let state = app.state::<AppState>();
                let sessions = std::mem::take(&mut state.inner.lock().unwrap().sessions);
                for s in sessions {
                    if s.doc().is_dirty() {
                        let _ = s.sync();
                        drop(s);
                    } else {
                        let _ = s.close();
                    }
                }
            }
        });
}
