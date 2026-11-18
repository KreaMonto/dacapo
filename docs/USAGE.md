# Using Partita

Partita is designed to feel like a word processor whose "text" is music. A blinking caret marks where the next note goes. You can select with Shift or the mouse, cut, copy and paste, and undo with Ctrl+Z.

## Documents

- **New** (Ctrl+N) opens a new tab with an empty 8-measure score.
- **Open** (Ctrl+O) loads a `.partita` file (or a `.dacapo` file from before the project was renamed). It also opens MusicXML files, like **Import MusicXML**.
- **Import MusicXML…** (File menu) opens a score from another notation program (`.musicxml`, `.xml` or compressed `.mxl`) as a new, unsaved score. What Partita cannot show yet is simplified, and a message lists it: septuplets and other tuplets that do not divide evenly keep their written values, voices beyond four per staff are dropped, and each staff keeps the clef it starts with.
- **Export MusicXML…** (File menu) saves the score as MusicXML for Finale, Sibelius, Dorico, MuseScore and others: one part per staff, with its name and instrument.
- **Save** (Ctrl+S) saves the document. **Save As** is Ctrl+Shift+S.
- **Close tab** is Ctrl+W, and **next/previous tab** is Ctrl+Tab and Ctrl+Shift+Tab.
- Click the **title** or the **composer** on the page to type them (see [Titles, header and footer](#titles-header-and-footer)).

The tab of a document with unsaved changes shows a dot (●). Closing it asks whether to save.

## Menus

The menu bar has **File**, **Edit**, **View**, **Insert**, **Play** and **Help**.

**Help** contains:
- **Keyboard Shortcuts** (F1).
- **What's New**, which opens the changelog.
- **Report a Problem…**, **Source Code on GitHub** and **Support Partita…**, which open in your browser.
- **Check for Updates…** and **Automatic Updates** (see [Updates](#updates)).
- **Credits and Licenses** and **About Partita**. They show:
  - the version and platform;
  - the components Partita downloaded, such as FluidR3 GM: its version, whether it is installed, and where;
  - credits for every project Partita is built on, with licenses and links.

  **Copy version info** puts a short summary on the clipboard to paste into a bug report.

The rest of the menu bar: **File**, **Edit**, **View**, **Score** (measures, staves and their groups), **Notes** (ties, slurs, lyrics, accidentals, articulations and dynamics), **Play** and **Help**. Items marked **›** open a submenu; where an item has a current setting (the theme, the zoom), it shows on the right. Rest the pointer on an item for a moment to see what it does.

Press **Alt** to move into the menu bar, or **Alt + first letter** (Alt+F, Alt+E, Alt+V…) to open a menu. Then use the arrows (**→** opens a submenu, **←** closes it), Enter, and Esc. **Help → Keyboard Shortcuts** (F1) lists every shortcut.

## Views

Choose how the score is laid out in **View**:

| View | What you see |
|---|---|
| **Page (as printed)** | Default. Real sheets of paper (A4 or Letter, chosen in View) with margins. The titles sit on page 1, with the header, footer and page numbers you choose. What you see is what prints. |
| **Wrap to Window** | The music fills the window width and wraps to new lines, with no page breaks. Handy on small screens. |
| **Continuous (one line)** | Encore-style: the whole piece on one endless line that grows to the right. The view scrolls sideways to follow the caret. |

All views edit the same way. Clicking, selecting and the pointer figure work identically.

**Moving around and zoom:**

| Mouse / keys | Action |
|---|---|
| Wheel | Scroll up and down |
| **Ctrl** + wheel | Scroll sideways |
| **Alt** + wheel | Zoom in and out, keeping the point under the pointer in place |
| **Middle button** + drag | Pan the score in any direction |
| Ctrl + = / Ctrl + − / Ctrl + 0 | Zoom in / out / back to 100% |

- At **100%**, one staff space is 10 pixels in every view. In page view, a whole A4 page at 100% is about 1200 px wide.
- **View → Zoom → Fit Page Width** sizes the page to the window. Page view starts that way the first time.
- The zoom is shown at the right of the status bar. Click it to go back to 100%.

**Print** (Ctrl+P) prints the page view in black on white, one sheet per page. Editing aids such as the caret, the selection and the error marks are left out. From another view, Partita switches to page view for the print and back afterwards.

**Toolbars:** every bar can go where it suits you. Drag it by the dotted grip at its start to another place in its row or column, or to another one; a line shows where it will land, and **Esc** cancels. While you drag, a dashed strip shows at each end of every side (above and below the rows, left and right of the columns): drop the bar there to start a new row or column. A side can hold as many as you like, so all the bars could sit on one side, in columns next to each other; a row or column left empty disappears. In a column, a bar with lists shows each label over its list; in a row, the figures run in two lines with the rests under the notes. **View → Toolbars → Show Bars** shows or hides each bar. A row or column whose bars are all hidden disappears, and the score takes its room; while you drag a bar it shows again, so a bar can go back into it. Partita remembers all of this.

**Layouts.** **View → Toolbars** also lists the layouts: Partita's own, then yours. **Save Layout As…** keeps the bars as they are now under a name (*Composing*, *Choir*…); while one of your layouts is chosen, moving or hiding a bar changes it. Choose a layout in the list to put its bars on screen. Partita's layout cannot be changed: what you move is only on screen until you choose it again. **Delete Layout** removes the one on screen, if it is yours. **Reset Toolbars** goes back to Partita's layout, as it was made; your layouts are kept.

**Theme:** **System** (default) follows your computer's light or dark setting. **Light** or **Dark** fix it for Partita only.

**Language:** Partita speaks English and Spanish. **View → Language → System** (default) follows your computer's language; choosing **English** or **Español** fixes it for Partita only. The window reloads in the new language; open scores and their undo history stay as they are.

## Words in the music

The **Indications** bar of the toolbar has the tempo marking and the rehearsal mark; the **Expressions** bar, right of the score, has the expression and the technique. All four are in the Notes and Score menus too:

| Button | What it adds |
|---|---|
| **♩=** | A tempo marking at the start of the caret's measure (see [Tempo markings](#tempo-markings)). |
| ***dolce*** | An **expression** under the staff, in italics, on the note before the caret (**Ctrl+E**): *dolce*, *espressivo*, *cresc.* |
| **pizz.** | A **technique** over the staff on the note before the caret: *pizz.*, *arco*, *con sord.* |
| **A** | A **rehearsal mark** in a box at the start of the caret's measure: the next letter after the last one (A, B, C…). |

A grey hint shows where the words go; type over it and press **Enter** (**Esc** leaves nothing). Words on a note move, copy and delete with it. Click any of them in the score to change them; leave the text empty to remove them. MusicXML keeps them (words from other programs become expressions when they are in italics or below the staff, techniques otherwise).

## Text boxes

The **T** tool (in the **Tools** bar, next to Select and the eraser, or **Score → Text Box**) writes anywhere on a page: click where the text should start and type. **Shift+Enter** starts a new line; **Enter** (or a click elsewhere) keeps it, **Esc** leaves nothing. A text box stays where it was put on its page, whatever the music does, so it is only shown in page layout.

- **Drag** a box to move it; **click** it to change its words or look.
- While typing, the format bar above the text sets its font, size, bold and italic, its alignment (left, centred, right) and a frame around it.
- Leaving a box empty, or clicking it with the eraser, removes it.

## Text styles

Each kind of text (title, subtitle, composer, tempo markings, expressions, techniques, rehearsal marks, lyrics, staff names, header, footer, page numbers…) has one look, so that all the tempo markings, for example, match.

- **While typing a text**, the format bar above it changes the look of every text of that kind: font, size in points, **bold** and *italic*; **↺** goes back to Partita's look.
- **Score → Text Styles…** shows every kind at once (useful for kinds you do not type in place, such as tempo markings or lyrics). **All to Default** goes back to Partita's look.

Changes can be undone like any other. Sizes and spacing follow: a bigger title moves the music down, bigger lyrics take more room between verses. Fonts are the ones installed on the computer; a file opened where a font is missing uses Georgia instead. MusicXML does not keep text boxes or styles.

## Titles, header and footer

The texts around the music are part of the score and print as shown.

- **On page 1:** the **title**, a **subtitle** under it, the **composer** on the right and a **lyricist or arranger** on the left ("Words: …", "Arr. …"), a **dedication** above the title, the **part** at the top left (for a set of parts: "Violin I"), and a **copyright** line at the bottom.
- **On every page:** a **footer**; and from page 2 on, a **header**.
- **Page numbers:** at the top or the bottom, left, centre, right or on the outside edge (right on odd pages, left on even ones, as in a book); from page 2 on, or on page 1 too.

**Score → Titles, Header and Footer…** has all of them. In the header, the footer and the page number text, `{page}`, `{pages}`, `{title}` and `{composer}` are filled in for each page (the **Insert** buttons type them): `{title} · page {page} of {pages}` prints *Sonata · page 2 of 3*. A text left empty is not printed. Clicking a page number opens the dialog too.

**Click any text on the page** to change it there: type, then **Enter** (or click elsewhere) to keep it, **Esc** to leave it as it was. An empty title or composer shows a grey hint where it goes; hints are never printed. Every change can be undone with Ctrl+Z.

The headings of page 1 also show above the music in the other views. MusicXML keeps the title, subtitle, composer, lyricist, part and copyright; the header, footer and page numbers are saved in `.partita` files only.

## Entering music with the mouse

This works like the note palette in Encore. The **entry bars** on the left of the score hold what you write with.

1. Click a figure (or a rest, in the column beside it) in the **Figures** bar. The pointer turns into that figure.
2. Move over a staff. The figure snaps to the nearest line or space and shows the pitch name (for example `F♯4`). A dashed line marks where it will be inserted.
3. Click to place it. Notes you place one after another undo together with a single Ctrl+Z.
4. Click **on an existing note** (the label shows `+`) to add the pitch to its chord. Clicking on a rest turns it into a note.

## Moving notes with the mouse

With the **Select** tool, point at a notehead: the pointer becomes a vertical double arrow. Press and drag up or down to move the note one line or space at a time; it sounds at each step. In a chord, only the note you grabbed moves. Let go to drop it. One **Ctrl+Z** undoes the whole drag. The key signature's accidentals are not applied while dragging: an altered note keeps its accidental, as with **Alt+↑/↓**.

## The bars beside the score

Left of the score, one column of buttons: the **Figures**, **Accidentals** and **Voice** bars. When the window is too short for all of them, the last ones go behind **»** at the bottom. Right of the score, another column holds what goes on the notes: the **Ties & slurs**, **Beams**, **Articulations**, **Dynamics** and **Expressions** bars. **Dynamics** is one button that shows the last dynamic you chose: click it to open all of them, then choose one. Hover any button, or reach it with Tab, to see a tooltip with its name, what it does, its keyboard shortcut and the bar it belongs to.

**Accidentals, articulations and dynamics** can be placed with the mouse: click the mark (it stays highlighted and follows the pointer) (it stays highlighted and follows the pointer), then click each note it goes on; the note under the pointer lights up first. An accidental clicked on a chord changes only that tone. **Esc**, a right-click or clicking the mark again puts it down. With a selection, clicking a mark applies it to every note in the selection at once. From the keyboard, marks apply to **the note just before the caret**.

**Ties and slurs** work on what you select first: select the notes, then click Tie or Slur. Applying the same mark again removes it.

| Bar or category | Contents |
|---|---|
| **↖ Select** (Tools bar) | Back to normal editing: click to place the caret, drag to select. **Esc**, a right-click or `N` leave entry mode. |
| **Eraser** (Tools bar, next to Select, `X`) | The pointer becomes a crosshair. Aim at a note and click to erase just that note; in a chord, only the tone you aim at goes. Drag a box to erase every note and rest inside it. The note under the crosshair turns red before you click. One Ctrl+Z brings back everything erased in one go. **Esc**, a right-click or `X` leave the eraser. |
| **Figures** (left) | Two columns: the notes, and beside each one its rest. Click either to place it. The **dot** below them makes the figure dotted. The **Grace Note** button below it writes the next notes as acciaccaturas or appoggiaturas, small and before the note they ornament, until you choose the same kind again. The **Tuplet** button (it shows the last one chosen) writes the next notes as a triplet, quintuplet, sextuplet, duplet or quadruplet until you choose it again; the figure in use when you turn it on is what the group counts in. **View → Breve and 128th Notes** adds the breve (double whole note), the 64th and the 128th. |
| **Accidentals** (left) | ♯ ♭ ♮. The key signature's sharps and flats are applied automatically when you place a note. |
| **Ties & slurs** (right) | **Tie** (`T`) joins a note to the next one of the same pitch. **Slur** (`S`) draws a phrase mark over the selected notes, and needs a selection. Deleting a slurred note removes its slur; undo restores both. |
| **Beams** (right) | Beam the note before the caret (or the selected notes) by hand: start a new beam there, join it to the note before across the beat, or go back to automatic (**auto**). |
| **Articulations** (right) | Staccato, staccatissimo, tenuto, accent, marcato, fermata. They are placed on the notehead side; the fermata goes above and also works on rests. |
| **Dynamics** (right) | ppp … fff, sfz, fp, behind one button that shows the last one chosen. Printed below the staff. Choosing the dynamic a note already has removes it. |
| **Voice** (left) | Shows **1** until you need more. **+** adds an independent line on the same staff, for example divisi strings or two melodies in one hand. Its buttons switch between voices (also `Alt+1`…`4`). A voice that contains no music disappears again once you leave it. |

## Playback

| Control | Action |
|---|---|
| **Space** or ▶ | Play from the caret. Press again to pause: the caret moves to where the music stopped, so the next Play continues from there. |
| **Shift + Space** or ⏮ | Play from the beginning |
| **Esc** or ⏹ | Stop without moving the caret |
| **♩ = 100** in the toolbar | The opening tempo in quarter notes per minute (20–400). Type a value and press Enter. It is saved with the score. |

### Tempo markings

The **♩=** button in the **Indications** bar adds a tempo marking; the other words in the music are described in [Words in the music](#words-in-the-music).

**Score → Tempo Marking…** (or the ♩= button) puts a marking at the start of the caret's measure, such as **Andante con moto ♩ = 76**: the words (suggestions such as *Allegro* or *a tempo* appear as you type), and a metronome mark counting quarter notes, eighths, halves or dotted values (♩. = 60 in 6/8 is the same speed as ♩ = 90). Click a printed marking to change or remove it.

- **What prints and what plays are separate.** *Printed* chooses words and metronome mark, words only, metronome mark only, or nothing; a hidden marking still sets the tempo. In the first measure, the metronome value is the opening tempo, the same as in the toolbar.
- **Tempo changes.** A marking later in the piece with *Changes the tempo from this measure* plays at its new tempo from there on (no gradual *rit.* or *accel.* yet). Without it, the words alone are printed (*dolce*, *a tempo*) and the tempo stays as it was.
- The marking belongs to its measure: inserting or deleting measures before it moves it along, and deleting its measure removes it.
- MusicXML keeps the words, the metronome mark (hidden ones too) and the tempo.

A green line follows the music, and the view scrolls to keep it in sight. Notes also **sound while you write them**: placing a note, adding to a chord, or changing a pitch or accidental plays it.

**Sounds.** Playback uses **FluidR3 GM**, a free set of recorded instruments by Frank Wen (MIT license). The first time you press Play, Partita asks before downloading it (148 MB, once). Progress shows in the status bar, and playback starts by itself when it is ready. The file is kept in the app's data folder (`%LOCALAPPDATA%\io.github.partita-notation.partita\soundfonts\` on Windows).

How the score is played:
- **Ties** sustain the note, including across barlines.
- **Staccato** plays half the value and **staccatissimo** a quarter. **Tenuto**, **slurs** and tied notes are played full length. Other notes play slightly detached.
- **Dynamics** set the loudness from that note on. **sfz** affects only its note, and **fp** plays forte then piano. **Accents** and **marcato** add emphasis.
- **Each staff plays its own instrument** (see *Staves and instruments*). Notes you enter sound with it too.

## Beams

Eighths and shorter notes are beamed automatically, following the time signature:

- In x/4 time, notes are grouped by quarter-note beat. In 4/4, four eighths in the same half of the bar share one beam.
- In 6/8, 9/8 and 12/8 they are grouped by dotted quarter; in 3/8 the whole bar is one group.
- In x/2 time they are grouped by half note.
- Rests and quarter notes (or longer) break the beam.

The stems of a group all point the same way, away from the note farthest from the middle line; with several voices, voice 1 and 3 point up and voice 2 and 4 down. Sixteenths and shorter get extra beams, and a lone shorter note in a group gets a short partial beam.

## Rests that fill a measure

A rest that fills the whole measure is drawn as a whole rest **centered** in the measure, following standard notation. A plain whole rest counts as "rest for the whole measure" in any time signature (3/4, 6/8…), so it is never flagged as an error.

When you place a note or a rest in a measure that only holds a measure rest, the new figure **replaces** the rest.

**Multi-measure rests:** with **Multirests** turned on in the toolbar, consecutive measures where every staff rests are drawn as a single measure. It shows a thick bar and the number of measures above it, as in printed parts. The grouping stops at time or key signature changes. This is a view setting only: the measures still exist, and writing into one of them splits the group.

## Measures with errors

A measure that holds more beats than its time signature allows is outlined in red and labelled, for example **⚠ Too many beats: 5 of 4**. The status bar counts them (**⚠ 2 measures with errors**). Click that text to jump to the next one.

## Entering music with the keyboard

| Key | Action |
|---|---|
| `A`–`G` | Insert a note at the caret. The octave is chosen closest to the previous note, and the key signature's sharps and flats are applied. |
| `Shift` + `A`–`G` | Add a note to the chord just before the caret (above its top note). |
| `R` or `0` | Insert a rest. |
| `1`…`7` | Choose the note value: 64th, 32nd, 16th, eighth, quarter, half, whole. With a selection, change its note values. |
| `8` / `9` | Breve / 128th, when **View → Breve and 128th Notes** is on. |
| `.` | Toggle a dot. |
| `Ctrl+G` | Grace notes (acciaccaturas) on / off; `Ctrl+Shift+G`: appoggiaturas. |
| `Ctrl+3` | Triplet on / off (`Ctrl+5`, `Ctrl+6`, `Ctrl+2`, `Ctrl+4`: quintuplet, sextuplet, duplet, quadruplet). |
| `+` / `-` | Raise or lower the accidental of the previous note (or the selection). |
| `Alt` + `↑` / `↓` | Move the previous note (or the selection) up or down one step. |
| `Ctrl` + `Alt` + `↑` / `↓` | Move it up or down an octave. |
| `Alt` + `1`…`4` | Switch voice. Each voice has its own color. |

## Lyrics

Lyrics are written **under the notes**, one syllable per note, so they move, copy and paste with the music.

To start, either:

- click **under a staff**, below the note where the words begin (a dashed box shows where you would type), or
- press **Ctrl+L** (or **Notes → Lyrics**) to start at the note next to the caret.

A text field opens under the note. Type the syllable, then:

| Key | Action |
|---|---|
| `Space` | End the word and go to the next note. |
| `-` | End the syllable and go to the next note; a hyphen joins the two (`can-tar`). |
| `_` | Hold the syllable over the following notes: an extender line is drawn up to the last note before the next syllable. |
| `←` / `→` | Move inside the text; at its edge, go to the previous or next note. |
| `Tab` / `Shift` + `Tab` | Next or previous note. |
| `Backspace` | In an empty syllable, go back to the previous note. |
| `↓` / `↑` | Next or previous **verse**. |
| `Esc` or `Enter` | Finish (what you typed is kept). |

- Rests are skipped, and a note tied from the previous one continues its syllable. Press `Space` on an empty syllable to skip a note.
- **Verses**: press `↓` to write a second line of words under the same notes, or click just below the last line. A staff can have up to 8 verses; they are numbered when there is more than one, and a verse disappears when its last syllable is deleted.
- To change a syllable, click it. To delete it, clear its text.
- Each syllable is one **Ctrl+Z** step. With nothing typed in the field, Ctrl+Z undoes the previous syllable; otherwise it undoes your typing.
- On a staff with lyrics, dynamics are drawn above the staff, as in vocal music.

## Moving and selecting

| Key | Action |
|---|---|
| `←` / `→` | Move the caret one note. |
| `↑` / `↓` | Move to the staff above or below. |
| `Home` / `End` | Start or end of the measure. |
| `Ctrl` + `←` / `→` | Previous or next measure. |
| `Ctrl` + `Home` / `End` | Start or end of the score. |
| `Shift` + any of the above | Extend the selection. |
| Click | Place the caret. |
| Shift+click or drag | Select. Dragging across staves selects the same beats on all of them. |
| `Ctrl` + `A` | Select everything. |

## Editing

| Key | Action |
|---|---|
| `Backspace` / `Delete` | Delete the note before or after the caret, or the whole selection. |
| Typing a note with a selection | Replaces the selection. |
| `Ctrl` + `X` / `C` / `V` | Cut, copy, paste. Multi-staff selections paste onto the staves starting at the caret's staff. |
| `Ctrl` + `Z` | Undo. Consecutive typing is undone as one step, as in Word. |
| `Ctrl` + `Y` or `Ctrl` + `Shift` + `Z` | Redo. |
| `Ctrl` + `Enter` | Insert a measure after the current one. |

## Score structure (top toolbar)

The toolbar is two rows of thin bars. Rest the pointer on a button to see what it does; the name of its bar shows small in the corner. When the window is too narrow for a row, its last bars move behind **»** at the right end: click it to reach them.

| Row | Bars |
|---|---|
| **1** | **File** (new, open, save), **Edit** (undo, redo), **Playback** (from the start, play, stop, tempo), **View** (multi-measure rests) |
| **2** | **Tools** (select, eraser, text box), **Measure** (clef, key, time, insert or delete a measure), **Staves** (add or delete a staff, bracket, brace, ungroup), **Indications** (tempo marking, rehearsal mark) |


- **Clef**: clef of the staff containing the caret.
- **Key** and **Time**: apply from the caret's measure until the next change. For Time, type something like `3/4` and press Enter.
- **+ Measure / − Measure**: insert after, or delete, the current measure.
- **System and page breaks**: the **System Break** button of the **Measure** bar (or **Score → Measure → System Break**) ends the line of music after the caret's measure; **Page Break** ends the page there (in page view; in wrap view it ends the line). Again takes it away. A ↵ or ⇟ beside the line shows where a break is; it is never printed. The continuous view has no lines and ignores them. MusicXML keeps them in Partita's own files; the line breaks of files from other programs are not kept, so the music flows freely.
- **Pickup (anacrusis)**: **Score → Measure → Length…** says how long the caret's measure really is, in steps of half a beat (a quarter of a beat in x/8 time), up to the whole measure, which means as long as its time signature. It proposes what the measure holds now. A shorter first measure is a pickup: it is not numbered, the next one is measure 1, and the status bar says *Pickup*. A shorter measure at the end usually completes it. Playback and the measures-with-errors check use the real length, and MusicXML keeps it (an `implicit` measure).
- **Barline**: the line that closes the caret's measure, or every measure in the selection: **single**, **double** (the end of a section), **final** (the end of the piece or a movement) or **dashed** (a subdivision of a long measure). The button shows the last kind you chose; click it to choose. **Score → Measure → Barline** does the same and shows the kind of the caret's measure. The last measure of a score ends with a final barline anyway. A multi-measure rest stops at a barline that is not single. MusicXML keeps barlines.
- **Repeats**: the **Start Repeat** button puts a repeat sign at the start of the caret's measure (or the first measure of the selection), **End Repeat** at its end (or the end of the last measure of the selection); each turns its sign on or off and shows whether the measure has it. **Score → Measure → Repeat** has them too, with **Repeat Selection** (both signs around the selected measures) and **Times Played** (2 to 6; more than twice shows as ×3, ×4… over the sign). Playback plays the passage again: at an end repeat it goes back to the start repeat, or to the beginning (or just after the previous end repeat) when there is none, and the playhead goes back with it. MusicXML keeps repeats.
- **Endings** (first and second time): the **Ending** button makes the caret's measure, or the selected ones, a **1st**, **2nd** or **3rd** ending, or **1st and 2nd**; **No Ending** removes it. **Score → Measure → Ending** does the same. A bracket with the number is drawn over them; it is closed on the right when the ending goes back to the repeat (the first ending gets an end repeat if it has none) and open otherwise. Each time through the repeat, playback skips the endings that are not for that time: the first time the 1st ending, the second time straight to the 2nd. MusicXML keeps endings.
- **Jumps**: the **Jumps** button of the **Indications** bar (or **Score → Jumps**) puts on the caret's measure a **segno** 𝄋 or the start of the **coda** 𝄌 (at its beginning), or at its end one of *Fine*, *To Coda*, *D.C.*, *D.C. al Fine*, *D.C. al Coda*, *D.S.*, *D.S. al Fine* or *D.S. al Coda*; choosing the one already there takes it away, and **No Jump** removes it. Playback follows them: a D.C. goes back to the beginning and a D.S. to the segno, once each; after the jump, repeats are not taken again and of a group of endings only the last plays; *al Fine* stops at Fine, *al Coda* goes on from To Coda to the coda. MusicXML keeps them.
- **+ Staff / − Staff**: add a staff at the bottom, or delete the current staff.
- **Bracket / Brace / Ungroup**: group the staves of the selection (see [Staves and instruments](#staves-and-instruments)).

## Staves and instruments

Every staff has a **name**, a **sound** and a **clef**:

- The name is printed at the start of the staff, on the first system (for example *Flute*, *Violin I*, *Piano*). A score with a single staff that is still called "Staff 1" shows no name.
- **Click the name** on the page, or use **Score → Staff → Name, Sound and Clef…** for the staff with the caret, to change all three at once (one undo step).
- **Sound** is one of the 128 General MIDI instruments, grouped by family. Picking one proposes its usual name and clef (Viola → alto clef, Violoncello → bass clef); a name you typed yourself is kept.
- **To make a staff a piano** (or a harp or organ), open it (click its name) and choose the sound: *Staves* proposes **two staves, braced**, and the bass staff is added below it. Name, sound and transposition then apply to both staves; each keeps its clef. To have one staff again, delete the other.
- **Score → Staff → Add…** adds a staff at the bottom and asks for its instrument first. Keyboards, the harp and the organ come on **two braced staves** (treble and bass) in one step; the *Staves* field lets you choose one or two. Repeat it to build an ensemble, up to a full orchestra.
- **Short name**: shown on the systems after the first (*Vln. I*, *Vc.*). It follows the name and the sound until you type your own; leave it empty for no name on later systems.
- **Transposition**: for instruments that sound in another key than written. A clarinet in B♭ is written a major second higher than it sounds, so in a concert C major score its staff shows D major. Notes are entered and shown as written, and played at concert pitch. Picking a sound sets its usual transposition (B♭ clarinet and trumpet, F horn, E♭ alto saxophone, piccolo an octave up, guitar and double bass an octave down…). Changing it rewrites the staff's notes so the music keeps sounding the same.
- **Brackets and braces**: select some music across the staves to join, then choose **Score → Staff → Group → Bracket** (an instrument family: woodwinds, brass, strings) or **Brace** (one instrument on several staves: piano, harp, organ). **Ungroup** undoes it. Barlines run through a group, and when the staves of a brace share a name, it is shown once, centred.


## Crash protection

Every change is written to a recovery journal on disk within half a second. If the app or the computer shuts down unexpectedly, the next start shows a banner listing the recovered documents, with **Restore** and **Discard** buttons. Restoring brings back the work, including the undo history.

The status bar shows **● Recovery on** when protection is active.

## Updates

Partita looks for a new version on GitHub a few seconds after it starts, at most once a day. When there is one, it tells you which version it is and links to what's new:

- **Download and Install** downloads it in the background while you keep working. Progress shows in the status bar.
- **Later** asks again the next day.
- **Skip This Version** stays quiet until a newer version appears.

When the download is ready (and verified against the project's signing key), Partita asks to restart. **Restart Now** installs the update and opens the new version. Unsaved changes are kept: they are offered back when Partita starts again, as after a crash. If you choose **Later**, click **⟳ Restart to update** in the status bar whenever you are ready.

**Help → Check for Updates…** checks right away. Turn off **Help → Automatic Updates** if you prefer Partita never to contact GitHub on its own.
