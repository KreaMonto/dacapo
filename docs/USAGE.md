# Using Da Capo

Da Capo is designed to feel like a word processor whose "text" is music. A blinking caret marks where the next note goes. You can select with Shift or the mouse, cut, copy and paste, and undo with Ctrl+Z.

## Documents

- **New** (Ctrl+N) opens a new tab with an empty 8-measure score.
- **Open** (Ctrl+O) loads a `.dacapo` file.
- **Save** (Ctrl+S) saves the document. **Save As** is Ctrl+Shift+S.
- **Close tab** is Ctrl+W, and **next/previous tab** is Ctrl+Tab and Ctrl+Shift+Tab.
- Edit the **title** and **composer** directly on the page.

The tab of a document with unsaved changes shows a dot (●). Closing it asks whether to save.

## Entering music

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

## Score structure (toolbar)

- **Clef**: clef of the staff containing the caret.
- **Key** and **Time**: apply from the caret's measure until the next change. For Time, type something like `3/4` and press Enter.
- **+ Measure / − Measure**: insert after, or delete, the current measure.
- **+ Staff / − Staff**: add a staff at the bottom, or delete the current staff.

Measures with more beats than their time signature allows are tinted red, and the status bar counts them.

## Crash protection

Every change is written to a recovery journal on disk within half a second. If the app or the computer shuts down unexpectedly, the next start shows a banner listing the recovered documents, with **Restore** and **Discard** buttons. Restoring brings back the work, including the undo history.

The status bar shows **● Recovery on** when protection is active.
