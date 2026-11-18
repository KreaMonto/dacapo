# Changelog

All notable changes to Partita (called Da Capo up to 0.2.2) are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, minor versions may include breaking changes.

## [Unreleased]

### Added
- **System and page breaks**: after any measure, from the **Measure** bar or **Score → Measure**; a mark beside the line shows them while editing, and they are never printed. MusicXML keeps them in Partita's files (the layouts of other programs are not imported). Recovery data is now format 15.
- **Pickup measures (anacrusis)**: **Score → Measure → Length…** makes a measure shorter than its time signature. A short first measure is not numbered (the next one is measure 1); playback and the error check use the real length, and MusicXML keeps it as an implicit measure. Recovery data is now format 14.
- **Jumps**: segno, coda, *Fine*, *To Coda*, *D.C.* and *D.S.* (plain, *al Fine*, *al Coda*), from the **Jumps** button of the **Indications** bar or **Score → Jumps**. Playback follows them, with the usual convention that repeats are not taken again after the jump and only the last ending plays. MusicXML import and export keep them (they are no longer read as words for a note). Recovery data is now format 13.
- **First and second endings**: from the **Ending** button of the **Measure** bar or **Score → Measure → Ending** (1st, 2nd, 3rd, or 1st and 2nd), drawn as a numbered bracket over the measures. A first ending gets its end repeat at once. Playback plays each ending on its own time through the repeat, and MusicXML keeps them. Recovery data is now format 12.
- **Repeats**: start and end repeat signs, from the **Measure** bar or **Score → Measure → Repeat**, on the caret's measure or around the selection, with the number of times played (×3, ×4… over the sign). Playback plays the repeats, and the playhead goes back with the music. Multi-measure rests stop at them, and MusicXML keeps them. Recovery data is now format 11.
- **Barline types**: the line closing a measure can be single, double (the end of a section), final or dashed. The **Measure** bar has a button for it (it shows the last kind chosen), and so does **Score → Measure → Barline**; it changes the caret's measure or every measure in the selection, in one undo step. Multi-measure rests stop at them, and MusicXML import and export keep them. Recovery data is now format 10; unsaved work from earlier builds is still recovered.
- **Text boxes**: the **T** tool writes anywhere on a page; a box stays where it is put, whatever the music does. Drag it to move it, click it to change it; several lines, alignment and an optional frame.
- **Text styles**: every kind of text (title, tempo markings, expressions, lyrics, staff names, header, page numbers…) has its font, size, bold and italic. A format bar appears above any text being typed, and **Score → Text Styles…** shows them all. Sizes are in points; spacing follows them.
- **Words in the music**: expressions under the staff (*dolce*, *espressivo*; **Ctrl+E**) and techniques over it (*pizz.*, *arco*), attached to a note so they move, copy and delete with it; and boxed **rehearsal marks** (A, B, C… in order). They are in the palette and the toolbar with the tempo marking; click any of them in the score to change it. MusicXML keeps them.
- **A staff can become a grand staff**: choosing a piano (or harp, organ…) for an existing staff offers two braced staves and adds the bass staff below it. Changing a braced instrument's name, sound or transposition now changes all its staves.
- **Tempo markings** such as *Andante con moto ♩ = 76*, at the start of any measure (**Score → Tempo Marking…**, the toolbar, or click a printed one). Print words and metronome mark, either one, or nothing; hidden ones still set the tempo. A marking later in the piece can change the tempo from its measure on, and playback follows it. The metronome mark can count eighths, quarters, halves or dotted values. MusicXML import and export keep them.
- **Titles, header and footer.** Besides the title and composer, a score can have a subtitle, a lyricist or arranger, a dedication, a part name and a copyright line on page 1, a running header (from page 2) and a footer on every page. **Page numbers** can go at the top or bottom, left, centre, right or on the outside edge, and on page 1 too. Header, footer and page numbers can show the page number, the number of pages, the title and the composer. **Score → Titles, Header and Footer…** has them all, and clicking any of these texts on the page edits it there. MusicXML import and export keep the subtitle, lyricist, part and copyright.
- **Spanish.** The whole interface is translated, including the 128 instrument sounds, error messages and the names Partita gives new documents and staves. **View → Language** chooses English, Español, or the computer's language (the default); the window reloads in the new language and open scores stay as they are.
- **Notes → Accidentals, Articulations and Dynamics**: the palette's marks are now in the menus too, so they can be reached from the keyboard. They go on the selection, or on the note before the caret.

### Changed
- **Thin, named bars around the score instead of the palette**, so the score gets more room. A button's tooltip shows which bar it belongs to, and when a row or column has no room, its last bars go behind **»** instead of wrapping.
  - **On top**, two thin rows: File, Edit, Playback and View; then Tools (select, eraser, text box), Measure, Staves (with **Bracket**, **Brace** and **Ungroup** buttons) and Indications (tempo marking, rehearsal mark).
  - **Left of the score**, one column for note entry: Figures (two columns, each note beside its rest, and the dot), Accidentals and Voice (**1**, **2**… and **+**). Off the staff, the whole and half rests carry a short line so they can be told apart.
  - **Right of the score**, one column for what goes on the notes: Ties & slurs, Articulations, Dynamics and Expressions (*dolce*, *pizz.*). The dynamics are one button that shows the last one chosen and opens all of them.
  - **Every bar can be moved anywhere**: drag it by its grip to another place, in its row or column or in another one, or onto the dashed strip at the edge of a side to start a new row or column there. Each side holds as many as needed, and an empty one disappears. **View → Toolbars** shows or hides each bar; a row or column with nothing left disappears. Partita remembers the arrangement, and **Reset Toolbars** brings back its own.
  - **Layouts**: **View → Toolbars → Save Layout As…** keeps an arrangement of bars under a name, to choose it again from the same menu; changes made while it is chosen are kept in it. Partita's own layout stays as it is.
  - In the menu, bracket, brace and ungroup are now under **Score → Staff → Group**.
- **The title and composer are drawn on the page** like the music, so they print exactly as shown, and the music moves down to make room for the texts of page 1.
- Files that use the new page texts are saved as file format 7, which older versions cannot open; other files are still written in the older formats. Unsaved work from Partita 0.3.0 is still recovered after updating.
- **The menus are organized in categories, with submenus.** **Insert** is replaced by **Score** (Measure, and Staff with its Group submenu) and **Notes** (ties, slurs, lyrics and marks). In **View**, Layout, Zoom, Paper, Theme and Language are submenus that show their current setting. Every item fits on one line; resting the pointer on an item explains what it does.

## [0.3.0] - 2026-11-16

### Added
- **MusicXML import and export**, to exchange scores with Finale, Sibelius, Dorico, MuseScore and other notation programs.
  - **File → Import MusicXML…** (or **Open**) reads `.musicxml`, `.xml` and compressed `.mxl` files as a new score: parts and their staves (a piano becomes two staves), clefs, keys, time signatures, notes, chords, rests, up to four voices per staff, ties, slurs, articulations, dynamics, lyrics, tempo, title and composer.
  - What Partita cannot show yet is simplified, and a message says what: tuplets keep their written values, grace notes are left out, and only the first clef of each staff is kept.
  - **File → Export MusicXML…** writes the score as MusicXML 4.0, one part per staff, with each staff's name and instrument.
- **An instrument for every staff**, to write for any ensemble up to a full orchestra.
  - Each staff plays its own sound, chosen from the 128 General MIDI instruments of FluidR3 GM (strings, woodwinds, brass, percussion, keyboards, voices…). Notes you enter sound with that instrument too.
  - The staff's name is printed at its start, on the first system. Click it (or use **Insert → Staff Name, Sound and Clef…**) to change the name, the sound and the clef in one step. Picking a sound proposes its usual name and clef, for example *Violoncello* in bass clef.
  - **Insert → Staff…** asks for the instrument of the new staff. A piano, harp, harpsichord, celesta or organ comes on two braced staves (treble and bass) at once; the dialog lets you choose one or two staves.
  - **Short names** (Vln. I, Vc.) on the systems after the first. Picking a sound proposes the usual abbreviation, and *Violin II* becomes *Vln. II*.
  - **Brackets and braces**: select music across some staves and choose **Insert → Bracket Selected Staves** (an instrument family) or **Brace Selected Staves** (a piano or harp). Barlines run through the group, and a braced instrument shows its name once, in the middle.
  - **Transposing instruments**: clarinet and trumpet in B♭, horn in F, saxophones, piccolo, guitar, double bass and more are written in their own key and play at concert pitch. Picking one in the staff dialog sets its usual transposition, and changing a staff's transposition rewrites its notes so the music sounds the same.
  - MusicXML keeps all of this: part abbreviations, part groups and transpositions are read and written.
  - Scores where a staff plays something other than the piano are saved as file format 6, which Da Capo 0.2.2 and older cannot open. Crash-recovery data is now format 5; data left by 0.2.0 to 0.2.2 is still read, so unsaved work survives the update.

### Changed
- **Da Capo is now Partita.** Another free notation editor was already called DaCapo Editor, so the project has a new name, a new home at https://github.com/partita-notation/partita and a new website at https://partita-notation.github.io. It comes with a new icon: a Baroque letter P in gold on dark walnut.
  - Scores are now saved as `.partita`. Files saved as `.dacapo` still open (and open with a double-click), and keep their name when saved again.
  - The downloaded SoundFont and any unsaved work waiting in crash recovery move over from Da Capo on the first start, so nothing is lost or downloaded again. View settings (theme, zoom, page view) start from their defaults once.
  - On Windows, Partita installs next to Da Capo instead of replacing it: uninstall Da Capo from Settings → Apps once Partita runs.
- The palette now runs from the toolbar down, and the document tabs sit above the page, to the right of the palette.

## [0.2.2] - 2026-11-16

### Added
- **Lyrics**: words under the notes, one syllable per note, in up to 8 verses per staff.
  - Click under a staff or press `Ctrl+L` (Insert → Lyrics) and type. `Space` goes to the next note, `-` joins syllables with a hyphen, `_` holds a syllable over several notes (extender line), `↓` / `↑` change verse.
  - Syllables move, copy and paste with their notes. Each one is its own undo step.
  - Measures widen to fit the words, and staves move apart to fit the verses.
  - On a staff with lyrics, dynamics are drawn above the staff.
- **Marks with the mouse**: click an accidental, articulation or dynamic in the palette, then click the notes it goes on, as many as you like (the pointer carries the mark and the target note lights up). An accidental can go on one tone of a chord. `Esc` or a right-click puts the mark down. With a selection, the palette applies to the selection at once, as before. Ties and slurs still work on the selection.

### Changed
- Scores with lyrics are saved as file format 5, which Da Capo 0.2.1 and older cannot open. Scores without lyrics are saved as before.
- Crash-recovery data is now format 4. Data left by 0.2.0 and 0.2.1 is still read, so unsaved work survives the update.
- The Select tool and the eraser are icon buttons of the same size, so the eraser is no longer cut off at the edge of the palette (their names are in the tooltips).

### Fixed
- Lyrics keep clear of beams: the words sit lower when a beam under the notes needs the room, with more space between the music and the text.
- Note values and rests in the palette are centred in their buttons; the stems and flags of 32nd, 64th and 128th notes are no longer cut off at the top.

## [0.2.1] - 2026-11-16

### Added
- **Beams**: eighths and shorter notes are beamed by beat, following the time signature (dotted quarters in 6/8, 9/8 and 12/8; half bars of eighths in 4/4). Secondary beams and partial beams for 16ths to 128ths; one stem direction per group.
- **Eraser** next to Select (`X`): aim the crosshair at a note to erase just that note, or one tone of a chord; drag a box to erase everything inside. One undo step.
- **Drag notes**: with the Select tool, grab a notehead and drag it up or down to change its pitch, one line or space at a time. In a chord only the grabbed tone moves. The note sounds as it moves, and the whole drag undoes in one step.
- **Breve and 128th notes** (and their rests). View → Breve and 128th Notes shows them, with the 64th, in the palette; keys `8` and `9`.
- Windows installers can be signed through SignPath. The release workflow signs once the SignPath project is set up.
- [Code signing and privacy policy](docs/CODE_SIGNING.md).

### Changed
- Files that use breves or 128th notes are saved as format version 4, which older versions cannot open. Other files stay at version 3.
- A little more room below the last staff, so low notes' beams and stems are not cut off.

## [0.2.0] - 2026-11-16

### Added
- **Playback** with the FluidR3 GM SoundFont, downloaded on first use with progress in the status bar.
  - Play/pause from the caret (the caret follows the stop point), play from the beginning, and stop.
  - A playhead follows the music.
  - Tempo is saved per score.
  - Notes sound while you enter them.
  - Ties, articulations, slurs and dynamics affect playback.
- **Notation**:
  - Ties and slurs.
  - Articulations: staccato, staccatissimo, tenuto, accent, marcato, fermata.
  - Dynamics: ppp–fff, sfz, fp.
  - Centered measure rests and multi-measure rests.
- **Engraving** with the Bravura SMuFL font.
- **Views**: page (A4/Letter, as printed), wrap to window, and continuous (one line). Printing from page view.
- **Navigation**:
  - Zoom with Alt+wheel around the pointer, Ctrl+= / Ctrl+− / Ctrl+0, and Fit Page Width.
  - Ctrl+wheel scrolls sideways; the middle button pans.
- **Interface**:
  - Menu bar (File, Edit, View, Insert, Play, Help) with keyboard navigation.
  - Palette in collapsible categories, toolbar icons, and tooltips with shortcuts.
  - Keyboard shortcuts dialog (F1).
  - Theme choice: system, light or dark.
- **Mouse note entry**: the pointer carries the chosen figure; click on a note to build a chord.
- **About dialog** with version, credits and the components downloaded by the app.
- **Installers** for Windows, macOS (Apple silicon and Intel) and Linux, built by GitHub Actions and published on GitHub Releases (see `docs/RELEASING.md`).
- **Automatic updates**: Da Capo checks for a new version once a day, asks before downloading it, downloads it in the background, and installs it when you restart. Unsaved changes are kept through the restart. Help → Check for Updates… checks on demand; automatic checks can be turned off with Help → Automatic Updates. Updates are verified with the project's signing key.
- **Help → Support Da Capo…** opens the page about donating to and helping the project.

### Changed
- **License** changed from MIT to **GPL-3.0-or-later**.
- **File format** is now version 3, which adds ties, articulations, dynamics, slurs and tempo. Older files still open.
- **Recovery data** from 0.1.0 cannot be read by 0.2.0. Save your work before updating.
- **New home:** the project moved to the [dacapo-editor](https://github.com/dacapo-editor) GitHub organization.
- **App identifier** is now `io.github.dacapo-editor.dacapo`. The downloaded SoundFont and pending recovery data move automatically from the old data folder on first start. View preferences (zoom, view, theme) start from their defaults once.

### Fixed
- Horizontal scrolling in continuous view.
- Clef and time-signature placement.
- The status bar position.
- Dialog buttons in the webview.

## [0.1.0]

First working version: musical model, word-processor style editing with grouped undo, crash recovery (CRC journal + snapshots), several documents in tabs, `.dacapo` files with atomic saves, and SVG rendering.
