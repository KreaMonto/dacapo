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

- [x] Clef changes mid-staff, at the start of a measure (from the Clef selector), with MusicXML import and export. Changes inside a measure are not supported yet.
- [ ] 8va / 8vb and 15ma lines *(new)*.
- [ ] Enharmonic respelling (F♯ ↔ G♭) *(new)*.

### Lines

- [ ] Hairpins (crescendo and diminuendo).
- [ ] Glissando.
- [ ] Trill with its wavy line *(new)*.
- [ ] Gradual tempo changes (*rit.*, *accel.*) that playback follows.

### Ornaments and other marks *(new)*

- [ ] Mordent, turn and trill sign.
- [ ] Tremolo (on one note and between two notes).
- [ ] Arpeggio.
- [ ] Breath mark and caesura.

### Editing

- [ ] Insert vs. overwrite mode.
- [ ] Box selection.
- [ ] A panel with the properties of the selected note.
- [ ] **Reorder staves, and choose where a new one goes** *(new, to discuss)*: today a new staff is always added at the bottom. Moving staves up and down, and placing a new one, should be easy to guess and visual.
- [ ] **Edit one staff or voice alone** *(new)*: as in Encore, take one instrument or voice out of a large score, work on it by itself, and have the result saved back in the full score. Especially useful for large choral scores.

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
