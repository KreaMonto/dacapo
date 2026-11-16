# Using Da Capo

Da Capo is designed to feel like a word processor whose "text" is music. A blinking caret marks where the next note goes. You can select with Shift or the mouse, cut, copy and paste, and undo with Ctrl+Z.

## Documents

- **New** (Ctrl+N) opens a new tab with an empty 8-measure score.
- **Open** (Ctrl+O) loads a `.dacapo` file.
- **Save** (Ctrl+S) saves the document. **Save As** is Ctrl+Shift+S.
- **Close tab** is Ctrl+W, and **next/previous tab** is Ctrl+Tab and Ctrl+Shift+Tab.
- Edit the **title** and **composer** directly on the page.

The tab of a document with unsaved changes shows a dot (●). Closing it asks whether to save.

## Entering music with the mouse

This works like the note palette in Encore. The **palette** on the left holds the tools for entering music.

1. Click a figure in the palette. The pointer turns into that figure.
2. Move over a staff. The figure snaps to the nearest line or space and shows the pitch name (for example `F♯4`). A dashed line marks where it will be inserted.
3. Click to place it. Notes you place one after another undo together with a single Ctrl+Z.
4. Click **on an existing note** (the label shows `+`) to add the pitch to its chord. Clicking on a rest turns it into a note.

## The palette

The palette is grouped into collapsible categories. Click a heading to open or close it; Da Capo remembers your choice. Hover any button, or reach it with Tab, to see a tooltip with its name, what it does, and its keyboard shortcut.

Marks (accidentals, ties, articulations, dynamics) apply to **the note just before the caret**, or to **every note in the selection**. Clicking the same mark again removes it.

| Category | Contents |
|---|---|
| **↖ Select** | Back to normal editing: click to place the caret, drag to select. **Esc**, a right-click or `N` leave entry mode. |
| **Figures** | **Notes \| Rests** switches the figures between notes and their matching rests. **• Dot** makes the figure dotted. |
| **Accidentals** | ♯ ♭ ♮. The key signature's sharps and flats are applied automatically when you place a note. |
| **Ties & slurs** | **Tie** (`T`) joins a note to the next one of the same pitch. **Slur** (`S`) draws a phrase mark over the selected notes, and needs a selection. Deleting a slurred note removes its slur; undo restores both. |
| **Articulations** | Staccato, staccatissimo, tenuto, accent, marcato, fermata. They are placed on the notehead side; the fermata goes above and also works on rests. |
| **Dynamics** | ppp … fff, sfz, fp. Printed below the staff. Choosing the dynamic a note already has removes it. |
| **Voice** | Shows *Single voice* until you need more. **+ Voice** adds an independent line on the same staff, for example divisi strings or two melodies in one hand. Its buttons switch between voices (also `Alt+1`…`4`). A voice that contains no music disappears again once you leave it. |

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
| `.` | Toggle a dot. |
| `+` / `-` | Raise or lower the accidental of the previous note (or the selection). |
| `Alt` + `↑` / `↓` | Move the previous note (or the selection) up or down one step. |
| `Ctrl` + `Alt` + `↑` / `↓` | Move it up or down an octave. |
| `Alt` + `1`…`4` | Switch voice. Each voice has its own color. |

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

- **Clef**: clef of the staff containing the caret.
- **Key** and **Time**: apply from the caret's measure until the next change. For Time, type something like `3/4` and press Enter.
- **+ Measure / − Measure**: insert after, or delete, the current measure.
- **+ Staff / − Staff**: add a staff at the bottom, or delete the current staff.


## Crash protection

Every change is written to a recovery journal on disk within half a second. If the app or the computer shuts down unexpectedly, the next start shows a banner listing the recovered documents, with **Restore** and **Discard** buttons. Restoring brings back the work, including the undo history.

The status bar shows **● Recovery on** when protection is active.
