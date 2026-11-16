# Da Capo Roadmap

This document tracks the development goals and major stages toward a complete open source notation editor.

## Phase 1: Foundation and MVP *(in progress)*

- [x] Musical data model: staves, measures, four voices, notes, chords, rests.
- [x] Invertible edit operations.
- [x] Word-processor caret and selection, including multi-staff selection.
- [x] Undo/redo with Word-style grouping.
- [x] Several documents open at once, in tabs.
- [x] `.dacapo` file format with atomic saving and a `.bak` copy.
- [x] Crash recovery: CRC-checked binary journal, snapshots, recovery on start-up.
- [x] Basic SVG rendering: clefs, key and time signatures, notes, rests, accidentals, ledger lines.
- [x] Keyboard note entry and editing shortcuts.
- [ ] First run on Windows (blocked by Smart App Control on the main development machine; see INSTALLATION.md).
- [ ] Basic MusicXML export.

## Phase 2: Interactive editing

- [ ] Automatic measure reflow: notes that overflow a measure continue in the next one, tied across the barline.
- [x] Ties and slurs (slurs follow their notes; deleting a note removes its slur in the same undo step).
- [x] Articulations (staccato, staccatissimo, tenuto, accent, marcato, fermata) and dynamics (ppp–fff, sfz, fp).
- [x] Palette in collapsible categories; toolbar icons; tooltips with description and shortcut.
- [x] Menu bar (File, Edit, View, Insert, Help) with keyboard navigation; shortcuts dialog (F1).
- [x] Page view (A4/Letter, as printed), wrap view, continuous (one line) view; printing from page view.
- [x] Theme choice: system, light or dark.
- [x] Zoom (Alt+wheel around the pointer, Ctrl+=/−/0, fit page width); Ctrl+wheel horizontal scroll; middle-button panning.
- [ ] Staff size and page margins per score (today a fixed 7 mm staff and 15 mm margins).
- [ ] Copy/paste of slurs inside the copied region (today only the notes and their marks are copied).
- [ ] Hairpins (crescendo / diminuendo), tempo marks, text.
- [x] Beaming: eighths and shorter notes grouped by beat (compound meters by dotted quarter, 4/4 eighths by half bar), secondary beams and beamlets.
- [ ] Manual beam control: break or join beams on a note.
- [x] Breve and 128th note values, shown in the palette with View → Breve and 128th Notes.
- [x] Eraser tool: aim at one note (or one chord tone) to erase it, or drag a box to erase several.
- [x] Mouse note entry: the pointer carries the chosen figure, snaps to lines and spaces, and clicking on a note builds a chord.
- [ ] Computer keyboard as a piano (two rows of keys = white and black keys, as in DAWs), as an alternative to letter entry.
- [ ] MIDI keyboard input (also listed under phase 4).
- [ ] Stable measure widths while entering notes (today the layout re-flows on every insertion).
- [ ] Rectangle (marquee) selection and dragging notes up and down to change pitch.
- [x] Side palette: figures with a notes/rests switch, dot, accidentals, voices on demand.
- [x] Measures with errors labelled in red and counted in the status bar (click to jump).
- [x] Centered measure rests; writing into a measure rest replaces it.
- [x] Multi-measure rests (view toggle).
- [ ] **New score wizard**, like Encore's: title, tempo, key, time signature, number of measures, and instrument templates (piano grand staff, string quartet, voice + piano, guitar with tablature).
- [ ] Note property panel.
- [ ] Insert vs. overwrite mode (the Insert key, as in a word processor).
- [ ] Tuplets.

## Phase 3: Export and formats

- [ ] MusicXML import.
- [ ] PDF export with page layout.
- [ ] Print.
- [ ] Recent files list and file association for `.dacapo`.

## Phase 4: Audio and playback

- [x] Playback with the FluidR3 GM SoundFont (rustysynth + cpal), downloaded on first use.
- [x] Play / pause (caret follows) / stop, play from the beginning, playhead that follows the music.
- [x] Notes sound while entering them.
- [x] Tempo per score; ties, articulations, slurs and dynamics affect playback.
- [ ] Metronome / count-in.
- [ ] Instrument per staff (General MIDI programs) and volume/pan per staff.
- [ ] Fermatas and tempo changes inside the score.
- [ ] Choose another SoundFont (.sf2) in the settings.
- [ ] Verify the downloaded SoundFont with a pinned SHA-256 (today: exact size + RIFF/sfbk signature).
- [ ] MIDI input (step-time and real-time entry).
- [ ] Multi-instrument support with instrument names and transposing instruments.

## Phase 5: UX and collaboration

- [x] SMuFL music font (Bravura) for engraving-quality glyphs.
- [ ] Option to switch music font (Leland, Petaluma for a handwritten/jazz look).
- [ ] Light/dark theme switch (currently follows the system).
- [ ] Customizable keyboard shortcuts.
- [ ] Localization of the application (English first; Spanish next).
- [ ] Complete user documentation.

## Planned: version history

Separate from crash recovery. Recovery protects the *current* session. Version history lets the user go back to *earlier* states of a score, for example "how it looked yesterday".

- Keep periodic snapshots of saved documents (for example on every save, thinned out over time), in the user's data folder or next to the file.
- A "Versions…" panel to browse, compare and restore them.
- Retention settings (how many versions, for how long).
- It can reuse the snapshot format and the deterministic op journal already present in the core.

## Future ideas

- Orchestral scores with staff groups, brackets and part extraction.
- Lyrics and chord symbols.
- Guitar tablature.
- Plugins for effects and advanced dynamics.
- Automatic transposition mode.
- Harmonic analysis and composition assistance.

## Good first contributions

- Document the Tauri commands with usage examples.
- Add unit tests for edge cases in `cursor.rs`.
- Improve glyph placement in `render.js`, using `dev/preview.html`.
- Add more time-signature and key-signature presets to the toolbar.
