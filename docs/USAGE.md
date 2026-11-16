# Using Da Capo

Da Capo is designed to feel like a word processor whose "text" is music. A blinking caret marks where the next note goes. You can select with Shift or the mouse, cut, copy and paste, and undo with Ctrl+Z.

## Documents

- **New** (Ctrl+N) opens a new tab with an empty 8-measure score.
- **Open** (Ctrl+O) loads a `.dacapo` file.
- **Save** (Ctrl+S) saves the document. **Save As** is Ctrl+Shift+S.
- **Close tab** is Ctrl+W, and **next/previous tab** is Ctrl+Tab and Ctrl+Shift+Tab.
- Edit the **title** and **composer** directly on the page.

The tab of a document with unsaved changes shows a dot (●). Closing it asks whether to save.

## Menus

The menu bar has **File**, **Edit**, **View**, **Insert**, **Play** and **Help**.

**Help** contains:
- **Keyboard Shortcuts** (F1).
- **What's New**, which opens the changelog.
- **Report a Problem…** and **Source Code on GitHub**, which open in your browser.
- **Check for Updates…** and **Automatic Updates** (see [Updates](#updates)).
- **Credits and Licenses** and **About Da Capo**. They show:
  - the version and platform;
  - the components Da Capo downloaded, such as FluidR3 GM: its version, whether it is installed, and where;
  - credits for every project Da Capo is built on, with licenses and links.

  **Copy version info** puts a short summary on the clipboard to paste into a bug report.

The rest of the menu bar: Press **Alt** to move into it, or **Alt + first letter** (Alt+F, Alt+E, Alt+V…) to open a menu. Then use the arrows, Enter, and Esc. **Help → Keyboard Shortcuts** (F1) lists every shortcut.

## Views

Choose how the score is laid out in **View**:

| View | What you see |
|---|---|
| **Page (as printed)** | Default. Real sheets of paper (A4 or Letter, chosen in View) with margins. The title sits on page 1 and page numbers appear from page 2 on. What you see is what prints. |
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
- **View → Fit Page Width** sizes the page to the window. Page view starts that way the first time.
- The zoom is shown at the right of the status bar. Click it to go back to 100%.

**Print** (Ctrl+P) prints the page view in black on white, one sheet per page. Editing aids such as the caret, the selection and the error marks are left out. From another view, Da Capo switches to page view for the print and back afterwards.

**Theme:** **System** (default) follows your computer's light or dark setting. **Light** or **Dark** fix it for Da Capo only.

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

## Playback

| Control | Action |
|---|---|
| **Space** or ▶ | Play from the caret. Press again to pause: the caret moves to where the music stopped, so the next Play continues from there. |
| **Shift + Space** or ⏮ | Play from the beginning |
| **Esc** or ⏹ | Stop without moving the caret |
| **♩ = 100** in the toolbar | Tempo in quarter notes per minute (20–400). Type a value and press Enter. It is saved with the score. |

A green line follows the music, and the view scrolls to keep it in sight. Notes also **sound while you write them**: placing a note, adding to a chord, or changing a pitch or accidental plays it.

**Sounds.** Playback uses **FluidR3 GM**, a free set of recorded instruments by Frank Wen (MIT license). The first time you press Play, Da Capo asks before downloading it (148 MB, once). Progress shows in the status bar, and playback starts by itself when it is ready. The file is kept in the app's data folder (`%LOCALAPPDATA%\io.github.dacapo-editor.dacapo\soundfonts\` on Windows).

How the score is played:
- **Ties** sustain the note, including across barlines.
- **Staccato** plays half the value and **staccatissimo** a quarter. **Tenuto**, **slurs** and tied notes are played full length. Other notes play slightly detached.
- **Dynamics** set the loudness from that note on. **sfz** affects only its note, and **fp** plays forte then piano. **Accents** and **marcato** add emphasis.
- Every staff plays piano for now. Choosing an instrument per staff is on the roadmap.

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

## Updates

Da Capo looks for a new version on GitHub a few seconds after it starts, at most once a day. When there is one, it tells you which version it is and links to what's new:

- **Download and Install** downloads it in the background while you keep working. Progress shows in the status bar.
- **Later** asks again the next day.
- **Skip This Version** stays quiet until a newer version appears.

When the download is ready (and verified against the project's signing key), Da Capo asks to restart. **Restart Now** installs the update and opens the new version. Unsaved changes are kept: they are offered back when Da Capo starts again, as after a crash. If you choose **Later**, click **⟳ Restart to update** in the status bar whenever you are ready.

**Help → Check for Updates…** checks right away. Turn off **Help → Automatic Updates** if you prefer Da Capo never to contact GitHub on its own.
