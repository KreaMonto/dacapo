//! Tauri shell of Da Capo: exposes `dacapo-core` to the web frontend.
//!
//! The Rust side owns every open document. The frontend only sends
//! [`Action`]s and redraws from the [`DocView`] it gets back, so a frontend
//! crash can never lose work.

use std::path::PathBuf;
use std::sync::Mutex;

use dacapo_core::cursor::{Caret, Move, SelectionRange};
use dacapo_core::document::{Clipboard, Document};
use dacapo_core::file;
use dacapo_core::model::{
    Articulation, Clef, Duration, Dynamic, Issue, KeySignature, Metadata, Score, Step,
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

/// Editing commands sent by the frontend.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
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
        };
        r.map_err(|e| e.to_string())
    });
    if let Some(c) = copied {
        inner.clipboard = Some(c);
    }
    result?;
    Ok(view(inner.find(&id)?))
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            app.manage(AppState {
                store,
                inner: Mutex::new(Inner::default()),
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
