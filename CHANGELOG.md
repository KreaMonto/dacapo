# Changelog

All notable changes to Da Capo are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, minor versions may include breaking changes.

## [0.2.1] - Unreleased

### Added
- **Beams**: eighths and shorter notes are beamed by beat, following the time signature (dotted quarters in 6/8, 9/8 and 12/8; half bars of eighths in 4/4). Secondary beams and partial beams for 16ths to 128ths; one stem direction per group.
- **Eraser** next to Select (`X`): aim the crosshair at a note to erase just that note, or one tone of a chord; drag a box to erase everything inside. One undo step.
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
