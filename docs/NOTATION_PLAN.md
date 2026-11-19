# Notation plan: what is missing, and editing modes

The detailed list of what Partita still lacks, and how the tools will be organized. [ROADMAP.md](ROADMAP.md) gives the overview; this file holds the details so nothing gets lost. Items marked *(new)* were not on the roadmap before.

Agreed on 2026-11-18:

- **The common base comes first.** Instrument groups (percussion, guitar, choir…) come after it.
- **Each item is its own small change**, worked out in detail one at a time, usually one pull request each.
- **The starting point is the layout:** the common tools are spread over thin bars around the score instead of a few tall ones, so the score gets more space.
- **Releases:** Partita 0.4 is sections 0 (layout) and 1 (common base). Section 2 (modes) is big enough for a release of its own; section 3 (files) can come as minor versions.
- **Instrument modes switch automatically**, following the staff with the caret. Each person can add or remove tools in each mode, and a **Reset** button brings back the defaults.

## 0. Layout: thin bars around the score

This step goes first, because every later item needs a place on screen. Agreed on 2026-11-18:

- **Small, granular bars** rather than a few big ones, so each can sit where it is most convenient.
- **No visible titles.** The name of a button's bar shows in its tooltip, small and grey in the top right corner (the tooltip of *Key* says *Measure*).
- **Docking zones, no floating bars** (decided 2026-11-18): bars are dragged between the sides of the score and reordered. A bar on the left or right turns vertical.
- **Total freedom:** any bar can go on any side, and each side holds as many rows or columns as needed, created by dropping a bar beyond the last one and removed when they empty. Someone could put every bar on the right, in several columns side by side, without scrolling.
- **Every bar is defined as data** (name, buttons, zone, order) from the first step, so moving bars and saving layouts later need no rework.
- **Layouts:** Partita's own layouts (later one per mode: percussion, guitar, choir…) cannot be changed. People save their own from any of them, and **Reset** goes back to the built-in layout it came from.

The default layout:

| Bar | Where | What it holds |
|---|---|---|
| **File** | row 1 | new, open, save |
| **Edit** | row 1 | undo, redo |
| **Playback** | row 1 | start, play, stop, tempo |
| **View** | row 1 | multi-measure rests |
| **Tools** | row 2, first, so it is close to the score | select, eraser, text box |
| **Measure** | row 2 | clef, key, time, add / delete measure; later barlines, repeats, endings, D.C. / Coda |
| **Staves** | row 2 | add / delete staff, groups |
| **Indications** | row 2 | tempo marking, rehearsal mark |
| **Entry** | left, one column | figures, dot, grace notes, tuplets, notes / rests; accidentals; voice |
| **Marks** | right, one column | ties and slurs, articulations, dynamics, expressions and techniques; later ornaments and lines |
| **Status** | bottom | as today |

Large groups (the dynamics, later the ornaments) are drop-down buttons: they show the last one used, and open the whole group with a click.

The steps, one pull request each:

- [x] **0.1 The shared bar.** One thin look for every bar (about 30 px, icons in one row, names in tooltips as in the menus), the bar's name in its tooltips, and a **»** button holding what does not fit, instead of wrapping to a second row.
- [x] **0.2 Granular bars.** Split the top bar into File, Edit, Playback, Tools, Measure, Staves and Indications, in the default layout above.
- [x] **0.3 Entry bar.** The palette becomes one column on the left, without section titles; one button switches notes and rests. Done as three bars (Figures, Accidentals, Voice). Figures is the only bar with two columns: each note beside its rest, instead of a notes/rests switch.
- [x] **0.4 Marks bar.** What goes on notes moves to the right, with drop-down buttons for the large groups.
- [x] **0.5 View → Toolbars.** Show or hide each bar, remembered; **Reset** brings back the default layout.
- [x] **0.6 Moving bars.** Drag a bar by its handle (⋮⋮) to another zone or another place in its zone; remembered between sessions.
- [x] **0.7 Layouts.** Built-in layouts and the user's own: **Save Layout As…**, choose one, **Reset** to its built-in layout. The base for the instrument modes.
- [x] **0.8 Dynamic lanes.** Every bar fits every side (the Measure and Playback bars too, stacked in a column). Each side has any number of rows (top) or columns (left, right): dropping a bar past the first or last one opens a new one, and an empty one disappears.
- [x] **0.9 The default layout, by closeness** *(agreed 2026-11-19)*: review where each bar sits by default, not only by room but by which tools are used together (the figures beside their accidentals, the dot, grace notes and tuplets; the marks beside the ties). And **rename** your own layouts (saving, choosing, editing and deleting them already work, in **View → Toolbars**). Done: the Beams bar moved to the left column, after the accidentals (how a figure is beamed belongs with entering it); **Rename Layout…** in View → Toolbars.

## 1. Common base

Every mode needs these. The order inside each group is the planned order of work.

### Structure

- [x] Barline types: double, final, dashed *(new)*.
- [x] Repeat barlines, and playback that repeats *(new)*.
- [x] First and second endings (volta brackets) *(new)*.
- [x] D.C., D.S., Coda, Segno and *Fine*, and playback that follows them *(new)*.
- [x] Pickup measure (anacrusis) *(new)*.
- [x] System and page breaks *(new)*.

### Rhythm

*The whole group ships as one pull request: tuplets, grace notes and manual beams are built one after another on `feature/tuplets`, and the PR is opened once all three are done.*

- [x] Tuplets (triplets and other groups), with MusicXML import and export. Septuplets and other groups that do not divide 960 ticks evenly still import as written.
- [x] Grace notes (acciaccatura and appoggiatura), played in the time of the note after them, with MusicXML import and export.
- [x] Manual beam control: break or join beams on a note (the Beams bar). MusicXML does not keep them yet.

### Clefs and pitch

*One pull request for the group as well: clef changes, octave lines and enharmonic respelling are built on `feature/clef-changes`, and the PR is opened once all three are done.*

- [x] Clef changes mid-staff, at the start of a measure (from the Clef selector), with MusicXML import and export. Changes inside a measure are not supported yet.
- [x] 8va / 8vb and 15ma / 15mb lines *(new)*: notes keep their sound, only the drawing moves (as in MusicXML).
- [x] Enharmonic respelling (F♯ ↔ G♭) *(new)*: J, or the ♯⇄♭ button of the Accidentals bar.

### Lines

*One pull request for the group, on `feature/lines`. Every line between two notes (these and the octave lines) is one model in the core, `Score.lines` with a `LineKind`, with one command, one undo op and one drawing that splits it over systems.*

- [x] Hairpins (crescendo and diminuendo), which playback follows: about two dynamic levels over the line.
- [x] Glissando (a straight line; playback does not slide yet).
- [x] Trill with its wavy line *(new)*, played alternating with the step above.
- [x] Gradual tempo changes (*rit.*, *accel.*) that playback follows: to 75 % or 125 %, until the next tempo marking.

### Ornaments and other marks *(new)*

*One pull request for the group, on `feature/ornaments`. The marks are articulations in the core (added at the end of the list); the tremolo is part of the duration, like tuplets and grace notes.*

- [x] Mordent, turn and trill sign (the trill sign is a trill line on one note), played as figures.
- [x] Tremolo on one note and between two notes, in standard notation: the two notes are written twice as long and count half (MusicXML's time-modification 2:1).
- [x] Arpeggio, played rolled upwards.
- [x] Breath mark and caesura (they shorten the note; a caesura does not add a pause yet).

### Editing

Discussed with the user on 2026-11-19.

- [x] **Insert vs. overwrite mode** *(decided 2026-11-19: as proposed below)*. Today typing **inserts**: the new note goes in before what follows, and the measure can end up too full, which is marked in red with how many beats too many (the user likes that mark and wants to keep it). **Overwrite** would put the note in place of what is there, so the measure keeps its length (a half note over two quarters replaces both). Agreed: insert stays the default, the Insert key switches to overwrite, and the status bar says which one is on.
- [x] **Box selection.** Drag a rectangle over the music to select every note in it, across staves and measures, then tie, delete, move, transpose… them together. It selects a range (staves × time), as the selection already is; no picking loose notes with Ctrl+click. **Layers:** a rectangle over the music takes only notes, never text; text boxes have their own selection (a rectangle or Shift+click over boxes selects several, to move them together), which never takes notes.
- [x] **Reorder staves, and choose where a new one goes.** Two ways, both one undo step, and MusicXML keeps the order:
  - **Drag a staff** by a handle at its start: it only moves up or down, and drops between two staves.
  - **Score → Staves → Order…**: the staves' names in order, with ↑ ↓ arrows; **OK** applies the new order without touching the music.
  - Staves grouped with a brace or bracket move together; to move one out, ungroup it first (trying shows a warning saying so). A keyboard instrument (piano, harp, organ) always moves as one and is never split.
  - A new staff goes below the caret's staff and the staves joined to it.
- [x] **Edit one staff alone.** A view of the same score showing only that staff (or voice): work on it by itself, and every change is already in the full score. Playback plays only it. Getting back must be obvious: a clear bar over the score ("Only Violin I · Back to the full score") and Esc. Later the instrument **parts** build on it, with the tools each instrument needs; for now, the isolated view is enough.
- **Properties panel**: moved to the modes (section 2), see there.

## Architecture check (after the common base, before the modes)

Noted on 2026-11-18 while building the rhythm group. Partita is a functional core (`partita-core`: model, reversible ops, document commands, recovery journal) behind a thin Tauri adapter, with a frontend that only draws the state it receives. That works well, but three things grew while adding notation and are worth restructuring before the modes and the file exports pile more on top. Best done once 0.4 is out: the common base will have shown everything the model needs, and PDF export (section 3) needs the first point anyway.

- [ ] **Layout rules live in JavaScript, and some are written twice.** The core knows the music; `render.js` decides how it is grouped and placed. Rules both need are duplicated: tuplet groups (`tuplet_groups` in Rust and `tupletGroups` in JS), the length of an event in ticks (in `render.js`, `app.js` and the dev backend), beam groups (JS only, so MusicXML cannot write beams). Every model change touches three or four places, and they can drift apart.
  - First step: the core computes what the frontend needs (event start ticks, tuplet groups, beam groups, the clef in force) and sends it with the view, so the JS only draws.
  - Later, if PDF export or automatic parts call for it: move the engraving itself (spacing, systems, pages) into the core.
- [ ] **Every action returns the whole view.** Simple and robust, but a large score sends everything after each keystroke. Measure it with a big score (an orchestral one, a long choral one). If it is slow, send only what changed (measures, staves) or the visible pages.
- [ ] **The dev backend (`dev/app.html`) is a third implementation.** It fakes the core for the browser preview and falls behind (it has no caret moves, a simpler clef change, its own tick counting). Options: run the real core in the browser (Rust to WebAssembly), or keep the fake minimal and test behaviour in the core's tests only.

## 2. Modes

Two kinds of mode:

- **Instrument modes** follow the staff with the caret: on a drum kit staff the palette shows the percussion tools, on a guitar the guitar tools. Each person can customize them (add or remove tools), with **Reset** to go back to the defaults.
- **Task modes** are chosen by the user, as tabs above the palette: **Notes** (the default), **Text**, **Page**, **Mix**.

The foundation is a **staff type** in the model: normal, percussion or tablature *(new)*. The breve and 128th notes (View → Breve and 128th Notes) become "more figures" inside the Notes mode.

### Task modes

**Notes** (default): what is there today, plus the common base.

**The properties of what is selected** *(moved here from the Editing group on 2026-11-19)*. Options to choose from:

- **A contextual bar**: a thin bar, docked like the others, whose tools change with what is selected (a note: value, accidental, voice, stem direction; a measure: barline, repeat, length; a text: font and size, as the format bar already does for texts). Fits the thin bars and the modes best.
- **An inspector column**: a docked column listing every property of the selection, editable (as in Sibelius and MuseScore). Complete, but takes room.
- **A properties dialog**: double-click (or **Notes → Properties…**) shows everything about the selection; the status bar shows a summary. The least room, the slowest to use.

**Text**:

- Titles, lyrics, expressions, text boxes and styles, which exist today but are spread over several places.
- **Comments** *(new)*: review notes that are not printed, attached to a measure, with a list to go through them.
- **Songbook** *(new)*: lyrics with chord symbols above them, section labels (*Verse*, *Chorus*, *Bridge*) and numbered verses.

**Page**:

- Staff size and page margins per score.
- System and page breaks, spacing.
- Hide empty staves *(new)*.
- PDF export.

**Mix**:

- Volume, pan, mute and solo per staff.
- Metronome and count-in.
- Swing *(new)*.
- Another SoundFont (.sf2).
- MIDI keyboard input (step-time and real-time).

### Instrument modes (after the common base)

**Choir** *(new)*: full choral parts, which tend to be large and complex.

- SATB on four staves (open score) or two (closed score), switching between them.
- Lyrics under each voice, or shared by voices that sing the same words.
- Divisi.
- A piano reduction for rehearsal.
- Breath marks.
- Notes outside each voice's range shown in colour.
- Works with *Edit one staff or voice alone*.

**Percussion** *(new)*:

- A staff of one or five lines with a **drum map**: each line or space is an instrument, with its notehead and its sound on General MIDI channel 10.
- Noteheads: x, diamond, triangle, slash.
- Keyboard entry with one letter per instrument.
- Rolls, flams, sticking (R / L).
- Templates: drum kit, and orchestral percussion (timpani stay on a normal staff).

**Guitar and bass, acoustic and electric** *(new)*:

- Tablature linked to the staff: what is written in one appears in the other.
- Tunings (standard, drop D…) and capo.
- Entry by string and fret.
- Techniques: bend and release, slide, hammer-on and pull-off, vibrato, palm mute, let ring, harmonics, tapping, whammy bar.
- Strumming: slash notation, rhythmic notation, strum arrows.
- Chord diagrams and chord symbols.

**Keyboard** *(new)*:

- Pedal marks (*Ped.* and the pedal line).
- Notes crossing to the other staff.
- Fingering.

**Strings** *(new)*: up-bow and down-bow, harmonics, divisi.

**Orchestra and parts**:

- Concert-pitch view.
- Nested brackets.
- **Part extraction.**
- Cue notes *(new)*.
- Hide empty staves *(new)*.

## 3. Files

- [ ] PDF export.
- [ ] MIDI export and import *(new)*.
- [ ] Audio export: WAV or MP3 *(new)*.
- [ ] Recent files and the `.partita` file association.
- [ ] MusicXML for every new item above.

## 4. Look and feel *(new)*

Partita should look like the professional app it is from the first moment. To discuss and design with the user first.

- [ ] **A beautiful installer.** The Windows installers (NSIS and MSI) with their own images: the header and the side panel in Partita's look (the gold P on dark walnut, the manuscript feel of the website), and the same care for the macOS disk image (a background with the app and an arrow to Applications).
- [ ] **A splash screen** while Partita starts: a window about a fifth of the screen, in the middle, with the logo and the name in large, elegant type, the version, and a quiet note of what is loading (the sound bank, the documents recovered). It closes as soon as the main window is ready, and never makes startup slower.

## Further ahead

- Version history (see [ROADMAP.md](ROADMAP.md)).
- Customizable keyboard shortcuts.
- Other music fonts (Leland, Petaluma).
- Chant notation (neumes), if it is ever needed: it is a notation of its own.

## At 1.0: sustaining Partita

The app stays free, with no paid edition. When 1.0 is out:

- Apply for grants and funds for open source software (and for culture or music education, where they fit).
- Open ways to support the project (GitHub Sponsors, Patreon, Ko-fi), and consider a YouTube channel with tutorials and development notes to make Partita known.
- Think about paid things *around* the app (templates, courses, sounds, arrangements…), never inside it.
