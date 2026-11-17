# Partita Architecture

This document describes the technical design of Partita and the reasons behind its key decisions.

## Overview

```
┌──────────────────────────────┐
│  Web UI  (src/)              │  draws SVG, turns keys/clicks into Actions
└──────────────┬───────────────┘
               │ invoke("edit", { id, action })   ▲ DocView (score, caret, selection…)
┌──────────────▼───────────────┐
│  Tauri shell  (src-tauri/)   │  owns the open Sessions, dialogs, window events
└──────────────┬───────────────┘
┌──────────────▼───────────────┐
│  partita-core  (crates/)      │  model · ops · cursor · history · document
│                              │  file (.partita) · recovery (journal) · session
└──────────────────────────────┘
```

**Rust is the single source of truth.** The frontend holds no musical state of its own. It sends an `Action`, receives the complete view of the document, and redraws. A crash or reload of the web view therefore cannot lose work, and everything that needs protecting lives in one place.

`partita-core` has no UI or Tauri dependency, so it can be tested with plain `cargo test`. It could also power other front ends later, such as a CLI converter or a WebAssembly build.

## Musical model (`model.rs`)

A `Score` is a grid:

- **Columns**: global measures (`Vec<MeasureAttrs>`), each with its time and key signature.
- **Rows**: staves (`Vec<Staff>`), each with a clef and one `StaffMeasure` per column.
- **Cells**: a `StaffMeasure` holds `MAX_VOICES` (4) independent voices.
- **Voices**: an ordered `Vec<Event>`. An `Event` is a rest or a chord, and a single note is a one-pitch chord.

Time is measured in ticks (960 per quarter note). Pitches use scientific notation (C4 = middle C) with a diatonic step, an alteration and an octave, so the spelling (F♯ vs G♭) is preserved.

Events and staves carry stable numeric ids, which the UI uses for hit-testing and future features such as ties and slurs. `Score::next_id` is a high-water mark: an id is never reused.

**Measure model vs. flowing text.** Notes live inside measures, as in MusicXML and most notation programs. Inserting a note does not push later notes into the next measure yet. Overfull measures are allowed while editing, highlighted in red, and reported by `Score::validate`. Automatic reflow (spilling over the barline with ties) is planned.

## Edit operations (`ops.rs`)

Every change to a score is an `Op`: insert/remove/replace event, insert/remove measure, set measure attributes, insert/remove staff, set clef, set name, set metadata.

- `Op::apply` mutates the score and **returns the exact inverse op**. This is the foundation of undo/redo.
- `apply_all` applies a batch atomically. If one op fails, the ones already applied are rolled back.
- Ops are serializable and **deterministic**. Ids are allocated before an op is built and stored inside it, so replaying the same ops always produces the same score.

## Caret and selection (`cursor.rs`)

The editor behaves like a word processor:

- The **caret** sits between events of one voice (`staff, measure, voice, index`), the way a text cursor sits between characters.
- A **selection** is the region between an *anchor* and the caret (Shift+arrows, Shift+click, mouse drag). Across several staves it is interpreted by musical time, so dragging over a piano system selects the same beats in both hands, as Encore's selection did.
- Typing with a selection replaces it, and Backspace or Delete removes it.

## Undo/redo (`history.rs`)

Each user action becomes a `Transaction` containing forward ops, inverse ops, the caret before and after, and a timestamp. Consecutive actions of the same kind are **merged into one undo step**, as in Word:

- A burst of typed notes is one step. So is a run of Backspaces, or repeated transpositions.
- A burst ends when the caret is moved by the user, the action kind changes, the user pauses for more than 2 s, or the document is saved.
- Undo restores the caret position as well.

The history is capped at 1,000 steps.

## Documents and sessions

- `Document` (`document.rs`) is an open score plus its caret, selection, history, revision counter and file path. It implements every editing command: `insert_note`, `delete_backward`, `paste`, `transpose`, `set_time_signature`, and so on. Each command records `JournalEntry`s.
- `Session` (`session.rs`) wraps a document with its recovery writer. The Tauri layer keeps one session per open tab, so **several documents can be open at once**, each protected independently.

## Saving files (`file.rs`)

`.partita` files are pretty-printed JSON:

```json
{ "format": "partita", "format_version": 1, "score": { … } }
```

Saving is **atomic**:

1. Copy the existing file to `name.partita.bak`.
2. Write the new content to `name.partita.tmp`.
3. Flush it to the physical disk (`fsync`).
4. Rename it over `name.partita`.

A crash at any moment leaves either the complete old file or the complete new one, never a half-written file. Loading checks the format marker, refuses files from newer versions, and validates the structure.

## Crash recovery (`recovery.rs`)

Goal: **if the computer loses power, at most about half a second of work is lost.** This applies to untitled documents too.

Each open document has a folder under the app's local data directory (on Windows, `%LOCALAPPDATA%\io.github.partita-notation.partita\recovery\<session-uuid>\`):

| File | Content |
|---|---|
| `lock` | Exclusively locked by the running process (OS file lock). |
| `manifest.json` | Human-readable: name, original path, timestamps. |
| `snapshot.bin` | Full document state (including undo history) at journal sequence *N*. |
| `journal.bin` | Every change after *N*, one record each. |

**Binary records with checksums.** Each journal record is `[length u32][CRC32 u32][payload]`, where the payload is a `JournalRecord { seq, entry }` encoded with postcard. The snapshot uses the same framing behind a magic header.

**Format versions.** The binary encoding is not self-describing, so the magic header carries a version that changes whenever the document types change (version 4 added lyrics). Data written by the previous release must stay readable, because an in-app update restarts the program and returns unsaved work through crash recovery: `recovery.rs` still decodes version 3, and `tests/recovery_compat.rs` checks it against data written by Da Capo 0.2.1. When a type changes again, keep the old layout readable the same way (see `reading_pre_lyrics` in `model.rs`) and add a fixture from the release being replaced.

**While editing:**

1. Every change is appended to the journal by a **background thread**, so the UI never waits for the disk.
2. The thread forces the journal to the physical disk at least every **500 ms** (`DEFAULT_SYNC_INTERVAL`).
3. Every 200 changes or 60 seconds, a new snapshot is written atomically and the journal is truncated. Records carry sequence numbers, so a crash between those two steps is harmless: records already in the snapshot are skipped.
4. Saving writes a fresh snapshot that marks the document clean.

**On start-up**, the app scans the recovery folder. A session whose `lock` can be acquired belongs to a process that is no longer running:

- If it had no unsaved changes, it is deleted silently.
- Otherwise the user is offered **Restore** or **Discard**. Restoring loads the snapshot and replays the journal. A record torn by a power cut fails its CRC and is ignored together with everything after it.

Because the journal contains full transactions, **the undo history survives the crash too**.

**On normal close**, the session folder is deleted after the user saves or confirms discarding. If the process is killed (for example on logoff), dirty sessions keep their folder, so the work is offered back next time.

## Tauri layer (`src-tauri/`)

Commands: `new_document`, `open_document`, `get_document`, `edit`, `save_document`, `close_document`, `list_documents`, `list_recoverable`, `recover_document`, `discard_recoverable`, `quit`.

`edit` takes a tagged `Action` (for example `{ "type": "insert_note", "step": "C", "duration": { "base": "Quarter", "dots": 0 } }`) and returns a `DocView`. The clipboard lives on the Rust side and is shared between documents.

Closing the window with unsaved documents is intercepted: the frontend asks the user, then calls `quit`.

## Playback

**Core: `playback.rs`.** This module turns a `Score` into a `Timeline`: a sorted list of notes with absolute start and end ticks, MIDI key, velocity and staff, plus the start tick of each measure.

- Ties are merged into single notes, including across barlines.
- Articulations and slurs set how long a note sounds.
- Dynamics and accents set its velocity.
- The module has no audio dependency, so it is fully unit-tested.

**App: `src-tauri/src/audio.rs`.** The audio engine:

- **`rustysynth`** synthesizes with a SoundFont.
- **`cpal`** drives the default output device. The stream lives on a dedicated thread for the whole session.
- **The audio callback** pulls from a shared `Player`. Its queue holds the timeline converted to *sample* times, and the render loop splits each buffer at the exact sample where a note starts or stops.
- **Slow work stays off the lock:** loading the 148 MB SoundFont, downloading it, and building a timeline all happen outside it, so the callback is never blocked for long.
- **Downloading** goes through `ureq` from a pinned GitHub release URL. It writes to a `.part` file and checks the exact size and the `RIFF…sfbk` signature before renaming.

**Commands:**

| Command | What it does |
|---|---|
| `play` | Builds the timeline and starts from the caret or the beginning. |
| `pause` | Stops and moves the caret to the stop position. |
| `stop_playback` | Stops without moving the caret. |
| `playback_state` | Returns the current position; the UI polls it about 30 times per second for the playhead. |
| `audio_status` | Reports whether the SoundFont is missing, downloading, loading or ready. |
| `download_soundfont` | Starts the SoundFont download. |

Note-entry edits also call `Engine::preview` to sound the note just written.

## Rendering (`src/render.js`)

`render.js` is a pure function from `DocView` to SVG markup plus a layout object used for hit-testing clicks. It:

1. Packs measures into systems.
2. Justifies them.
3. Places events proportionally to time, so all staves line up vertically.
4. Draws clefs, key and time signatures, noteheads, stems, flags, beams, ledger lines, accidentals, dots, rests, the selection and the caret.

It also returns the position of every notehead and rest (`hits`), which the eraser uses to pick one note out of a crowded passage.

**Beams.** `beamGroups` splits each voice of a measure into beam groups: runs of notes of an eighth or shorter that start in the same beat group, broken by rests. Beat groups follow the time signature (a dotted quarter in 6/8, 9/8 and 12/8, the whole bar in 3/8, a quarter in x/4, a half in x/2), and in 4/4 four plain eighths in a half bar share one beam. A group has one stem direction, away from the note farthest from the middle line. `drawBeams` slants the beam with the outer notes (at most one space, flat when an inner note reaches further), keeps every stem long enough for its beams and long enough to reach the middle line, and draws secondary beams and beamlets. Beaming is computed while drawing and is not stored in the document; manual beam overrides would be stored per event later.

**Views.** The layout has three modes:

- **Wrap** fills the window width.
- **Continuous** uses an infinite width, so everything stays on one system.
- **Page** uses a paper size (A4/Letter) expressed in staff spaces, assuming a 7 mm staff, so a page keeps its real proportions. It flows systems onto pages: a system that would cross the bottom margin starts the next page.

Everything is laid out in one shared coordinate space. Each page is emitted as its own SVG whose `viewBox` shows its slice of that space, so the same layout serves hit-testing on any page (`clientToLayout`) and printing (one SVG per sheet, scaled by CSS).

**Chrome.** The menu bar (`src/menu.js`) and tooltips (`src/tooltip.js`) are small dependency-free modules. Every menu, toolbar and palette action goes through one `commands` map in `app.js`.

**Languages.** Every text the user reads goes through `t('key')` in `src/i18n.js`. The texts live in `src/locales/<lang>.js`, one flat object per language. English (`en.js`) is the reference: a key missing from another language falls back to English. Static HTML is tagged with `data-i18n` attributes instead of carrying text. The language is View → Language, or the system's; it is read once at start-up, so changing it reloads the page (documents live in Rust, so nothing is lost).

The Rust side sends no sentences. Errors reach the frontend as `{ code, args, message }` (`src-tauri/src/ui_error.rs`), and the frontend shows `error.<code>` from the locale, filling in `args` (an operating-system or library message travels as `args.detail` and is shown as it comes; `message` is the English fallback for unknown codes). MusicXML import notes are `{ kind, count }`. The few names Rust has to make up ("Untitled 2", "Staff 3") are templates the frontend sends at start-up with `set_default_names`.

To add a language: copy `src/locales/en.js` to `src/locales/<code>.js`, translate the values, add it to `LOCALES` and `LANGUAGE_NAMES` in `src/i18n.js`, and give top-level menu labels distinct Alt letters (`&` marks the letter, as in `A&yuda`).

**Music font.** All symbols come from **Bravura**, the reference font of the [SMuFL](https://www.smufl.org/) standard by Steinberg. It is bundled in `src/fonts/` under the SIL Open Font License, so the app works offline.

SMuFL fonts follow fixed conventions:

- 1 em = 4 staff spaces, so with `SP = 10px` the font size is 40px.
- Every glyph's origin sits on a staff position. A G clef's baseline is the G line, a notehead's baseline is its vertical center, and time-signature digits are centered on their baseline.

Because of this, symbols are placed exactly from staff positions, with no font-specific offsets. Glyph widths (noteheads, rests, accidentals) are taken from Bravura's metadata. Line thicknesses follow its engraving defaults.

`dev/preview.html` renders sample data without Tauri, for working on the renderer in a normal browser. `dev/beams.html` shows the beaming cases, and `dev/app.html` runs the whole interface against a small fake backend.

## Design principles

- **Never lose work**: atomic saves, journaling and recovery are part of the core, not an add-on.
- **Word-processor ergonomics**: caret, selection and grouped undo.
- **Deterministic core**: the same ops always give the same result, which makes the core testable and replayable.
- **Separation**: the model knows nothing about rendering, and the UI knows nothing about persistence.
