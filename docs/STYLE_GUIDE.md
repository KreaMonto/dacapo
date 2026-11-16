# Da Capo Style Guide

This guide summarizes the style rules and conventions for contributing to Da Capo.

## Rust style

- Format all Rust code with `cargo fmt`.
- Follow Rust naming conventions (`snake_case`, `CamelCase`, `SCREAMING_SNAKE_CASE`).
- Document public items with `///` comments and modules with `//!`.
- Keep modules small and coherent.
- Do not panic in library code on user-reachable paths. Return a `Result` instead.
- All score mutations go through `Op`s (see CONTRIBUTING.md).

## Frontend style

- Plain ES modules, without a framework or build step for now.
- Keep rendering (`render.js`, pure functions) separate from app logic (`app.js`).
- The frontend never stores musical state of its own; Rust is the source of truth.
- Colors are CSS custom properties defined in `:root`, with a dark-mode override.

## Commits and branches

- Write concise, descriptive commit messages using these prefixes:
  - `feat: add PDF export`
  - `fix: correct rest rendering`
  - `docs: update installation guide`
  - `test: cover multi-staff paste`
  - `refactor: split cursor module`
- Branch names:
  - `feature/<description>`
  - `fix/<description>`
  - `docs/<description>`

## Pull requests

- Describe the purpose of the change.
- List the modified areas and their impact.
- State whether tests were added.
- Close the related issue when applicable.

## Tests

- Add unit tests for every core function and op.
- Run `cargo test` before opening a PR.

## Documentation

- Update `docs/` when you change the UI or the architecture.
- Write in clear, concise English.
- Use Markdown for sections, lists and examples.

## Code quality

- Avoid duplicated logic.
- Use descriptive names for variables and functions.
- Keep functions focused on a single responsibility.
- Refactor carefully and document non-obvious code.
