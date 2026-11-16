# Contributing to Da Capo

Thank you for your interest in Da Capo! This document explains how to collaborate effectively on this Rust + Tauri project.

## Good practices

- Open an issue before starting significant changes, so the design can be discussed first.
- Use descriptive branch names, for example `feature/multi-staff-paste` or `fix/corrupt-measure`.
- Keep commits small and focused.
- Add tests whenever you change core logic (`crates/dacapo-core`).

## Reporting a bug

1. Describe the expected behavior.
2. Describe the actual behavior.
3. List the steps to reproduce it.
4. Attach screenshots or a `.dacapo` file when possible.

## Proposing an improvement

- Explain the current problem.
- Propose a clear solution.
- For complex features, include a short sketch or user flow.

## Contribution workflow

1. Fork the repository.
2. Create a branch from `main`.
3. Implement your change and update the documentation.
4. Make sure everything builds and the tests pass (`cargo test`).
5. Open a pull request that describes the change and references the issue.

## Ground rules for the core

These rules protect the editor's reliability:

- **Every change to a score goes through an `Op`** (`crates/dacapo-core/src/ops.rs`). Never mutate the `Score` directly from a command; otherwise undo and crash recovery break.
- **Ops must be deterministic.** Anything random or time-based (ids, timestamps) is decided *before* the op is created and stored inside it.
- **New ops need a round-trip test** proving that applying an op and then its inverse restores the original score.
- **File format changes** bump `FORMAT_VERSION` in `file.rs` and must keep loading older files.

## Style requirements

- Format Rust code with `cargo fmt`.
- Follow Rust and Tauri conventions.
- See [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md).

## Documentation

- All documentation is written in English. The application itself will be translated into other languages.
- Update `docs/` whenever a change affects usage or architecture.

## Code of conduct

Be respectful and collaborative. A formal `CODE_OF_CONDUCT.md` may be added later.
