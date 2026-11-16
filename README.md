# Da Capo

**Da Capo** is an open source, cross-platform music notation editor built with Rust and Tauri. It aims to be lightweight, safe and pleasant to use: you write music the way you write text in a word processor, with a blinking caret, Shift-selection, copy/paste and Ctrl+Z, and with no lost work after a crash or a power cut.

The name comes from the musical direction *da capo* ("from the beginning"). The project is a fresh start inspired by the classic notation editors of the 1990s, such as Encore.

## Status

Early development (MVP, phase 1). What works today:

- Multi-staff scores (treble, bass, alto and tenor clefs) with four voices per staff.
- Time and key signatures that can change mid-score.
- Keyboard note entry: letters, note values, rests, chords, accidentals and transposition.
- Word-processor editing: caret, Shift/drag selection across staves, cut/copy/paste, grouped undo/redo.
- Several documents open at once, in tabs.
- `.dacapo` files with atomic saves and a backup copy.
- **Crash recovery**: every edit is journaled to disk within half a second, and unsaved work is offered back after a crash.

See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.

## Technology

- **Core**: Rust (`crates/dacapo-core`). The musical model, editing engine and persistence have no UI dependency.
- **App shell**: Tauri 2 (`src-tauri`).
- **UI**: plain HTML/CSS/JavaScript with SVG rendering (`src`). No Node.js or build step is required.
- **Formats**: `.dacapo` (JSON) for documents and a binary CRC-checked journal for recovery. MusicXML import/export is planned.

## Repository layout

```
crates/dacapo-core/   musical model, editing, undo, files, crash recovery (+ tests)
src-tauri/            Tauri application: commands exposed to the UI
src/                  web frontend (index.html, app.js, render.js, styles.css)
dev/                  development helpers (renderer preview)
docs/                 technical documentation
```

## Documentation

- [docs/INSTALLATION.md](docs/INSTALLATION.md): setting up a development environment.
- [docs/USAGE.md](docs/USAGE.md): how to use the editor and its keyboard shortcuts.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): technical design, including the saving and recovery system.
- [docs/ROADMAP.md](docs/ROADMAP.md): development plan.
- [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md): code and contribution conventions.

## Quick start

```bash
cargo test -p dacapo-core     # run the core test suite
cargo run -p dacapo           # launch the app
```

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for prerequisites, including a Windows Smart App Control caveat.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

Da Capo is free software, licensed under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later). See [LICENSE](LICENSE).

In short, you may use, study, modify and share Da Capo, including building your own tools on top of `dacapo-core`. If you distribute a modified version, or software built from it, you must release it under the same license with its source code. This keeps every improvement available to the community.

```
Da Capo — music notation editor
Copyright (C) 2026 The Da Capo contributors

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
more details.
```
