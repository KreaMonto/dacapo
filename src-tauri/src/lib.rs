//! Tauri shell of Partita: exposes `partita-core` to the web frontend.
//!
//! The Rust side owns every open document. The frontend only sends
//! [`Action`]s and redraws from the [`DocView`] it gets back, so a frontend
//! crash can never lose work.

mod audio;
mod ui_error;
mod updater;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use partita_core::cursor::{Caret, Move, SelectionRange};
use partita_core::document::StaffProps;
use partita_core::document::{Clipboard, Document};
use partita_core::file;
use partita_core::model::{
    Articulation, Barline, Beam, Clef, Duration, Dynamic, GroupKind, Issue, Jump, KeySignature,
    LayoutBreak, LyricJoin, Metadata, NoteTextKind, Score, Step, TempoMark, TextBox, TextKind,
    TextStyle, TimeSignature, Transposition,
};
use partita_core::musicxml;
use partita_core::recovery::{Recoverable, RecoveryStore};
use partita_core::session::{now_ms, Session};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use ui_error::UiError;
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
    fn find(&mut self, id: &str) -> Result<&mut Session, UiError> {
        self.sessions
            .iter_mut()
            .find(|s| s.id().to_string() == id)
            .ok_or_else(|| UiError::internal(format!("document {id} is not open")))
    }
}

/// The names Partita gives things, in the interface language. The frontend
/// sends them at start-up (`set_default_names`); `{n}` stands for a number.
struct DefaultNames {
    /// A new document: "Untitled {n}".
    untitled: String,
    /// A document with no file and an empty title.
    nameless: String,
    /// A staff added or imported without a name: "Staff {n}".
    staff: String,
}

static NAMES: RwLock<Option<DefaultNames>> = RwLock::new(None);

fn numbered(template: &str, n: usize) -> String {
    template.replace("{n}", &n.to_string())
}

fn untitled_name(n: usize) -> String {
    match &*NAMES.read().unwrap() {
        Some(names) => numbered(&names.untitled, n),
        None => format!("Untitled {n}"),
    }
}

fn staff_name(n: usize) -> String {
    match &*NAMES.read().unwrap() {
        Some(names) => numbered(&names.staff, n),
        None => format!("Staff {n}"),
    }
}

/// The name shown on a document's tab.
fn doc_name(doc: &Document) -> String {
    if doc.path.is_none() && doc.score.metadata.title.trim().is_empty() {
        if let Some(names) = &*NAMES.read().unwrap() {
            return names.nameless.clone();
        }
    }
    doc.display_name()
}

#[tauri::command]
fn set_default_names(untitled: String, nameless: String, staff: String) {
    *NAMES.write().unwrap() = Some(DefaultNames {
        untitled,
        nameless,
        staff,
    });
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
        name: doc_name(doc),
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
    pitch: Option<partita_core::model::Pitch>,
}

/// Editing commands sent by the frontend.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    /// Placing an accidental with the mouse (a chord tone alone when `pitch` is set).
    SetAccidentalAt {
        id: u64,
        pitch: Option<partita_core::model::Pitch>,
        alter: i8,
    },
    /// Dragging a notehead up or down (a chord tone alone when `pitch` is set).
    MovePitch {
        id: u64,
        pitch: Option<partita_core::model::Pitch>,
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
    /// How the target notes are beamed (`null`: automatically).
    SetBeam {
        beam: Option<Beam>,
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
    /// Adds a staff at the bottom. Without a name it is "Staff N".
    AddStaff {
        clef: Clef,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        short_name: String,
        #[serde(default)]
        instrument: u8,
        #[serde(default)]
        transposition: Transposition,
        /// 2 for a piano, harp or organ: braced staves, treble and bass.
        #[serde(default = "one")]
        staves: usize,
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
    /// Every text around the music (title, composer, header, footer, page
    /// numbers...). The frontend sends all of them: one left out is reset.
    SetMetadata(Metadata),
    /// How every text of a kind looks.
    SetTextStyle {
        kind: TextKind,
        style: TextStyle,
    },
    /// Several kinds of text at once.
    SetTextStyles {
        styles: std::collections::BTreeMap<TextKind, TextStyle>,
    },
    /// A text box (`id` 0 adds a new one; empty words remove it).
    SetTextBox {
        text_box: TextBox,
    },
    RemoveTextBox {
        id: u64,
    },
    /// Words on a note: an expression or a technique ("" removes it).
    SetNoteText {
        id: u64,
        kind: NoteTextKind,
        text: String,
    },
    /// A rehearsal mark at the start of a measure (`None` removes it).
    SetRehearsal {
        measure: usize,
        text: Option<String>,
    },
    /// A repeat from the start of `first` to the end of `last`: whether
    /// one starts at `first`, and how many times the passage ending at
    /// `last` plays (`None`: no end repeat there).
    SetRepeat {
        first: usize,
        last: usize,
        start: bool,
        end: Option<u8>,
    },
    /// Measures `first` to `last` as the ending `numbers` (empty removes
    /// it); with `close`, the last one goes back to the repeat.
    SetEnding {
        first: usize,
        last: usize,
        numbers: Vec<u8>,
        close: bool,
    },
    /// A system or page break after a measure (`None` removes it).
    SetBreak {
        measure: usize,
        layout_break: Option<LayoutBreak>,
    },
    /// How long a measure really is, in ticks (`None`: its time
    /// signature's length): a pickup, or the measure completing it.
    SetMeasureLength {
        measure: usize,
        length: Option<u32>,
    },
    /// The jump marks of a measure: a segno and the start of the coda at
    /// its beginning, Fine / To Coda / D.C. / D.S. at its end.
    SetJumps {
        measure: usize,
        segno: bool,
        coda: bool,
        jump: Option<Jump>,
    },
    /// The barline at the end of measures `first` to `last`.
    SetBarline {
        first: usize,
        last: usize,
        barline: Barline,
    },
    /// A tempo marking at the start of a measure (`None` removes it).
    SetTempoMark {
        measure: usize,
        mark: Option<TempoMark>,
    },
    SetTempo {
        bpm: u16,
    },
    /// Name, playback instrument (General MIDI program) and clef of a staff.
    /// The staff dialog: an instrument's name, sound, clef and transposition
    /// (all its braced staves), and `staves` to make a lone staff a grand staff.
    SetStaff {
        staff: usize,
        #[serde(flatten)]
        props: StaffProps,
        #[serde(default = "one")]
        staves: usize,
    },
    /// Joins staves `first..=last` with a bracket or brace (`None` ungroups).
    GroupStaves {
        first: usize,
        last: usize,
        kind: Option<GroupKind>,
    },
}

fn one() -> usize {
    1
}

fn start_session(state: &AppState, doc: Document) -> Result<Session, UiError> {
    match Session::start(doc.clone(), state.store.as_ref()) {
        Ok(s) => Ok(s),
        Err(e) => {
            // Better to edit unprotected than not at all; the UI shows it.
            eprintln!("[partita] crash recovery unavailable: {e}");
            Ok(Session::start(doc, None)?)
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
            name: doc_name(s.doc()),
            dirty: s.doc().is_dirty(),
        })
        .collect()
}

#[tauri::command]
fn new_document(state: State<AppState>) -> Result<serde_json::Value, UiError> {
    let mut inner = state.inner.lock().unwrap();
    inner.untitled_counter += 1;
    let mut score = Score::new(untitled_name(inner.untitled_counter as usize), 8);
    for (i, staff) in score.staves.iter_mut().enumerate() {
        staff.name = staff_name(i + 1);
    }
    let mut session = start_session(&state, Document::new(score))?;
    let v = view(&mut session);
    inner.sessions.push(session);
    Ok(v)
}

#[tauri::command]
fn open_document(state: State<AppState>, path: String) -> Result<serde_json::Value, UiError> {
    let path = PathBuf::from(path);
    let mut inner = state.inner.lock().unwrap();
    if let Some(s) = inner
        .sessions
        .iter_mut()
        .find(|s| s.doc().path.as_deref() == Some(path.as_path()))
    {
        return Ok(view(s));
    }
    let score = file::load_score(&path)?;
    let mut session = start_session(&state, Document::opened(score, path))?;
    let v = view(&mut session);
    inner.sessions.push(session);
    Ok(v)
}

/// Opens a MusicXML file as a new, unsaved document. Returns the view
/// plus `import_notes`: what had to be simplified (`{ kind, count }`, worded
/// by the frontend).
#[tauri::command]
fn import_musicxml(state: State<AppState>, path: String) -> Result<serde_json::Value, UiError> {
    let mut imported = musicxml::import_file(std::path::Path::new(&path))?;
    for &i in &imported.unnamed_staves {
        imported.score.staves[i].name = staff_name(i + 1);
    }
    let mut inner = state.inner.lock().unwrap();
    let mut session = start_session(&state, Document::new(imported.score))?;
    let mut v = view(&mut session);
    v["import_notes"] = serde_json::json!(imported.notes);
    inner.sessions.push(session);
    Ok(v)
}

/// Writes the document as MusicXML for other notation programs.
#[tauri::command]
fn export_musicxml(state: State<AppState>, id: String, path: String) -> Result<(), UiError> {
    let mut path = PathBuf::from(path);
    if path.extension().is_none() {
        path.set_extension("musicxml");
    }
    let mut inner = state.inner.lock().unwrap();
    let doc = inner.find(&id)?.doc();
    Ok(musicxml::export_to(&path, &doc.score)?)
}

#[tauri::command]
fn get_document(state: State<AppState>, id: String) -> Result<serde_json::Value, UiError> {
    let mut inner = state.inner.lock().unwrap();
    Ok(view(inner.find(&id)?))
}

#[tauri::command]
fn edit(state: State<AppState>, id: String, action: Action) -> Result<serde_json::Value, UiError> {
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
    let result = session.edit(|d| -> Result<(), UiError> {
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
            Action::SetBeam { beam } => d.set_beam(beam, now),
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
            Action::AddStaff {
                clef,
                name,
                short_name,
                instrument,
                transposition,
                staves,
            } => {
                let name = name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| staff_name(d.score.staves.len() + 1));
                let props = StaffProps {
                    name,
                    short_name,
                    instrument,
                    clef,
                    transposition,
                };
                d.add_instrument(props, staves, now)
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
            Action::SetMetadata(metadata) => d.set_metadata(metadata, now),
            Action::SetTempo { bpm } => d.set_tempo(bpm, now),
            Action::SetTempoMark { measure, mark } => d.set_tempo_mark(measure, mark, now),
            Action::SetNoteText { id, kind, text } => d.set_note_text(id, kind, &text, now),
            Action::SetTextStyle { kind, style } => d.set_text_style(kind, style, now),
            Action::SetTextStyles { styles } => d.set_text_styles(styles, now),
            Action::SetTextBox { text_box } => d.set_text_box(text_box, now),
            Action::RemoveTextBox { id } => d.remove_text_box(id, now),
            Action::SetRehearsal { measure, text } => d.set_rehearsal(measure, text, now),
            Action::SetRepeat {
                first,
                last,
                start,
                end,
            } => d.set_repeat(first, last, start, end, now),
            Action::SetEnding {
                first,
                last,
                numbers,
                close,
            } => d.set_ending(first, last, &numbers, close, now),
            Action::SetBreak {
                measure,
                layout_break,
            } => d.set_break(measure, layout_break, now),
            Action::SetMeasureLength { measure, length } => {
                d.set_measure_length(measure, length, now)
            }
            Action::SetJumps {
                measure,
                segno,
                coda,
                jump,
            } => d.set_jumps(measure, segno, coda, jump, now),
            Action::SetBarline {
                first,
                last,
                barline,
            } => d.set_barline(first, last, barline, now),
            Action::SetStaff {
                staff,
                props,
                staves,
            } => d.set_instrument(staff, props, staves, now),
            Action::GroupStaves { first, last, kind } => d.group_staves(first, last, kind, now),
        };
        r.map_err(UiError::from)
    });
    if result.is_ok() && preview {
        let d = session.doc();
        let c = d.caret();
        if let Some(e) = c
            .index
            .checked_sub(1)
            .and_then(|i| d.score.voice(c.staff, c.measure, c.voice)?.get(i))
        {
            let (instrument, transposition) = d
                .score
                .staves
                .get(c.staff)
                .map_or((0, Default::default()), |s| (s.instrument, s.transposition));
            let keys: Vec<u8> = e
                .pitches()
                .iter()
                .map(|p| transposition.sounding_midi(*p).clamp(0, 127) as u8)
                .collect();
            state.audio.preview(c.staff, instrument, &keys);
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
fn play(state: State<AppState>, id: String, from_start: bool) -> Result<(), UiError> {
    let mut inner = state.inner.lock().unwrap();
    let doc = inner.find(&id)?.doc();
    let timeline = partita_core::playback::build(&doc.score);
    let from = if from_start {
        0
    } else {
        let c = doc.caret();
        let tick = partita_core::cursor::tick_at(&doc.score, c.staff, c.measure, c.voice, c.index);
        timeline.tick_at(c.measure, tick)
    };
    Ok(state.audio.play(timeline, from)?)
}

/// Pauses and moves the caret to where the music stopped, so pressing play
/// again continues from there (like a word processor's read-aloud).
#[tauri::command]
fn pause(state: State<AppState>, id: String) -> Result<serde_json::Value, UiError> {
    let stopped = state.audio.stop();
    let mut inner = state.inner.lock().unwrap();
    let session = inner.find(&id)?;
    session.edit(|d| {
        let c = d.caret();
        let measure = stopped.measure.min(d.score.measures.len() - 1);
        let index =
            partita_core::cursor::index_at_tick(&d.score, c.staff, measure, c.voice, stopped.tick);
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
    /// For the frontend to translate `role` (about.role.<id>).
    id: &'static str,
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

const REPOSITORY: &str = "https://github.com/partita-notation/partita";

/// Everything the Help → About dialog shows: version, platform, the
/// SoundFont downloaded by the app, and credits for what Partita is built on.
#[tauri::command]
fn about_info(app: tauri::AppHandle, state: State<AppState>) -> AboutInfo {
    AboutInfo {
        name: "Partita",
        version: env!("CARGO_PKG_VERSION"),
        license: "GPL-3.0-or-later",
        repository: REPOSITORY,
        issues: "https://github.com/partita-notation/partita/issues",
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
                id: "bravura",
                name: "Bravura",
                version: "bundled",
                author: "Steinberg Media Technologies",
                license: "SIL Open Font License 1.1",
                url: "https://github.com/steinbergmedia/bravura",
                role: "Music font (SMuFL) used to engrave the score",
            },
            Credit {
                id: "fluidr3",
                name: "FluidR3 GM",
                version: "3.1",
                author: "Frank Wen",
                license: "MIT",
                url: "https://github.com/pianobooster/fluid-soundfont",
                role: "Instrument sounds for playback (downloaded on first use)",
            },
            Credit {
                id: "rustysynth",
                name: "RustySynth",
                version: "1.3",
                author: "Nobuaki Tanaka",
                license: "MIT",
                url: "https://github.com/sinshu/rustysynth",
                role: "SoundFont synthesizer",
            },
            Credit {
                id: "cpal",
                name: "cpal",
                version: "0.15",
                author: "The RustAudio developers",
                license: "Apache-2.0",
                url: "https://github.com/RustAudio/cpal",
                role: "Audio output",
            },
            Credit {
                id: "tauri",
                name: "Tauri",
                version: tauri::VERSION,
                author: "The Tauri Programme",
                license: "MIT or Apache-2.0",
                url: "https://tauri.app",
                role: "Desktop application framework",
            },
            Credit {
                id: "ureq",
                name: "ureq",
                version: "2",
                author: "Martin Algesten and contributors",
                license: "MIT or Apache-2.0",
                url: "https://github.com/algesten/ureq",
                role: "Downloading the SoundFont",
            },
            Credit {
                id: "serde",
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
fn reveal_soundfont_folder(state: State<AppState>) -> Result<String, UiError> {
    let dir = state.audio.soundfont_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.display().to_string())
}

#[tauri::command]
fn save_document(
    state: State<AppState>,
    id: String,
    path: Option<String>,
) -> Result<serde_json::Value, UiError> {
    let mut inner = state.inner.lock().unwrap();
    let session = inner.find(&id)?;
    let mut path = match path
        .map(PathBuf::from)
        .or_else(|| session.doc().path.clone())
    {
        Some(p) => p,
        None => return Err(UiError::internal("no file name chosen")),
    };
    if path.extension().is_none() {
        path.set_extension(file::FILE_EXTENSION);
    }
    session.save(&path)?;
    Ok(view(session))
}

/// Closes a tab. Refuses to drop unsaved work unless `discard` is set.
#[tauri::command]
fn close_document(state: State<AppState>, id: String, discard: bool) -> Result<(), UiError> {
    let mut inner = state.inner.lock().unwrap();
    let pos = inner
        .sessions
        .iter()
        .position(|s| s.id().to_string() == id)
        .ok_or_else(|| UiError::internal("document is not open"))?;
    if inner.sessions[pos].doc().is_dirty() && !discard {
        return Err(UiError::internal("document has unsaved changes"));
    }
    let session = inner.sessions.remove(pos);
    Ok(session.close()?)
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
) -> Result<serde_json::Value, UiError> {
    let store = state
        .store
        .as_ref()
        .ok_or_else(|| UiError::new("recovery.unavailable", "crash recovery is unavailable"))?;
    let old = Uuid::parse_str(&session_id)?;
    let loaded = store.load(old)?;
    let mut session = start_session(&state, loaded.document)?;
    // The new session already holds a full snapshot; make it durable
    // before deleting the old one.
    session.sync()?;
    let _ = store.discard(old);
    let v = view(&mut session);
    state.inner.lock().unwrap().sessions.push(session);
    Ok(v)
}

#[tauri::command]
fn discard_recoverable(state: State<AppState>, session_id: String) -> Result<(), UiError> {
    let store = state
        .store
        .as_ref()
        .ok_or_else(|| UiError::new("recovery.unavailable", "crash recovery is unavailable"))?;
    let id = Uuid::parse_str(&session_id)?;
    Ok(store.discard(id)?)
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
) -> Result<updater::UpdateStatus, UiError> {
    let updates = state.updates.clone();
    Ok(updates.check(&app).await)
}

#[tauri::command]
fn update_status(state: State<AppState>) -> updater::UpdateStatus {
    state.updates.status()
}

/// Starts downloading the update the user accepted.
#[tauri::command]
fn download_update(state: State<AppState>) -> Result<(), UiError> {
    Ok(state.updates.download()?)
}

/// Installs the downloaded update and restarts. Unsaved documents are
/// flushed to the recovery journal first, so they are offered back when the
/// new version starts, exactly as after a crash.
#[tauri::command]
fn install_update(app: tauri::AppHandle, state: State<AppState>) -> Result<(), UiError> {
    state.audio.stop();
    for s in &state.inner.lock().unwrap().sessions {
        if s.doc().is_dirty() {
            s.sync().map_err(|e| {
                UiError::new(
                    "update.protect",
                    format!("Could not protect unsaved work: {e}"),
                )
                .arg("detail", e.to_string())
            })?;
        }
    }
    state.updates.install().map_err(UiError::from)?;
    // Windows: the installer has already taken over and closed the app.
    app.restart()
}

/// Identifiers the app had before, newest first: as Da Capo in the
/// dacapo-editor GitHub organization (0.2.0 to 0.2.2), and before that
/// (0.2.0 development builds).
const OLD_IDENTIFIERS: [&str; 2] = ["io.github.dacapo-editor.dacapo", "org.dacapo.editor"];

/// Moves the downloaded SoundFont and pending crash-recovery data from the
/// old identifiers' data folders, once, so nothing is lost or re-downloaded.
/// Only folders missing in the new location are moved, so the newest old
/// folder wins; failures are logged and the old data is left untouched.
fn migrate_old_data_dirs(new_dir: &std::path::Path) {
    for id in OLD_IDENTIFIERS {
        if let Some(old_dir) = new_dir.parent().map(|p| p.join(id)) {
            migrate_old_data_dir(&old_dir, new_dir);
        }
    }
}

fn migrate_old_data_dir(old_dir: &std::path::Path, new_dir: &std::path::Path) {
    if !old_dir.is_dir() || old_dir == new_dir {
        return;
    }
    for sub in ["soundfonts", "recovery"] {
        let (from, to) = (old_dir.join(sub), new_dir.join(sub));
        if from.is_dir() && !to.exists() {
            let moved = std::fs::create_dir_all(new_dir).and_then(|_| std::fs::rename(&from, &to));
            match moved {
                Ok(()) => eprintln!("[partita] moved {} to {}", from.display(), to.display()),
                Err(e) => eprintln!("[partita] could not move {}: {e}", from.display()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_metadata_takes_every_text_from_the_frontend() {
        let action: Action = serde_json::from_value(serde_json::json!({
            "type": "set_metadata",
            "title": "Lied",
            "composer": "Anon",
            "footer": "{page}",
            "page_numbers": { "show": true, "edge": "bottom", "align": "center", "first_page": true, "format": "– {page} –" },
        }))
        .unwrap();
        let Action::SetMetadata(m) = action else {
            panic!("not set_metadata")
        };
        assert_eq!((m.title.as_str(), m.footer.as_str()), ("Lied", "{page}"));
        assert_eq!(m.page_numbers.edge, partita_core::model::PageEdge::Bottom);
        assert!(m.subtitle.is_empty(), "a text left out is empty");
    }

    #[test]
    fn old_data_folder_is_migrated_once() {
        let base = std::env::temp_dir().join(format!("partita-migrate-{}", Uuid::new_v4()));
        let old = base.join(OLD_IDENTIFIERS[0]);
        let older = base.join(OLD_IDENTIFIERS[1]);
        let new = base.join("io.github.partita-notation.partita");
        std::fs::create_dir_all(old.join("soundfonts")).unwrap();
        std::fs::create_dir_all(old.join("recovery").join("abc")).unwrap();
        std::fs::write(
            old.join("soundfonts").join("FluidR3_GM.sf2"),
            b"RIFF....sfbk",
        )
        .unwrap();

        std::fs::create_dir_all(older.join("soundfonts")).unwrap();
        std::fs::write(older.join("soundfonts").join("older.sf2"), b"x").unwrap();

        migrate_old_data_dirs(&new);
        assert!(new.join("soundfonts").join("FluidR3_GM.sf2").is_file());
        // The newest old folder wins; the older one is left alone.
        assert!(!new.join("soundfonts").join("older.sf2").exists());
        assert!(new.join("recovery").join("abc").is_dir());
        assert!(!old.join("soundfonts").exists());

        // A second run (or a later old folder) never overwrites new data.
        std::fs::create_dir_all(old.join("soundfonts")).unwrap();
        std::fs::write(old.join("soundfonts").join("other.sf2"), b"x").unwrap();
        migrate_old_data_dirs(&new);
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
                migrate_old_data_dirs(&dir);
            }
            let store = app
                .path()
                .app_local_data_dir()
                .ok()
                .and_then(|dir| RecoveryStore::open(dir.join("recovery")).ok());
            if store.is_none() {
                eprintln!(
                    "[partita] could not open the recovery folder; documents are not protected"
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
            set_default_names,
            list_documents,
            new_document,
            open_document,
            import_musicxml,
            export_musicxml,
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
        .expect("error while building Partita")
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
