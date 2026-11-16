# Installation

This guide explains how to set up an environment to develop and run Da Capo locally.

## Requirements

- **Rust**, stable channel, 1.89 or newer (`rustup update stable`).
- **Platform dependencies for Tauri 2:**
  - **Windows**: Microsoft C++ Build Tools (or Visual Studio with the "Desktop development with C++" workload) and WebView2, which is preinstalled on Windows 10 and 11.
  - **macOS**: Xcode Command Line Tools.
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `build-essential`, `libssl-dev`.
- **Node.js is not required.** The frontend is plain HTML/CSS/JS served directly by Tauri.
- Optional: the Tauri CLI (`cargo install tauri-cli --version "^2"`), only needed for `cargo tauri build` installers.

## Get the code

```bash
git clone https://github.com/dacapo-editor/dacapo.git
cd dacapo
```

## Run the tests

```bash
cargo test -p dacapo-core
```

## Run the app

```bash
cargo run -p dacapo
```

The app loads the frontend from `src/`. After changing HTML, JS or CSS, rebuild with `cargo run` to see the change.

## Build an installer

```bash
cargo tauri build
```

Installers are written to `target/release/bundle/`.

## Windows: Smart App Control

Windows 11 **Smart App Control** blocks every unsigned executable, including the build scripts Cargo compiles. You will see an error like:

```
could not execute process `...build-script-build` (never executed)
An Application Control policy has blocked this file. (os error 4551)
```

To develop natively you have to turn it off: **Windows Security → App & browser control → Smart App Control → Off**. Be aware that on many Windows versions it cannot be turned back on without resetting Windows. Decide for yourself whether that is acceptable.

Alternatives while it is on:

- **Core tests in Docker** (no GUI needed):

  ```bash
  docker run --rm -v "${PWD}:/work" -v dacapo-cargo:/usr/local/cargo/registry -v dacapo-target:/target -e CARGO_TARGET_DIR=/target -w /work rust:1-bookworm cargo test -p dacapo-core
  ```

- **Renderer preview**: serve the repository over HTTP and open `/dev/preview.html` in a browser. For example: `docker run --rm -p 8765:80 -v "${PWD}:/usr/share/nginx/html:ro" nginx:alpine`, then open http://localhost:8765/dev/preview.html.
- A virtual machine or another computer without Smart App Control.

Running the desktop app itself inside Docker is not practical on Windows, because containers run Linux and have no access to the Windows desktop or WebView2.

## Where data is stored

- Documents: wherever you save them (`*.dacapo`), plus a `*.dacapo.bak` copy of the previous version.
- Crash-recovery data: `%LOCALAPPDATA%\io.github.dacapo-editor.dacapo\recovery\` on Windows (the app's local data directory on other systems). It is deleted automatically when documents are closed normally.
