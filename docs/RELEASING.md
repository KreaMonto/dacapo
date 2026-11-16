# Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`). It builds installers for Windows, macOS (Apple silicon and Intel) and Linux, and attaches them to a **draft** GitHub Release. Nothing is public until you publish the draft.

| System | Files |
|---|---|
| Windows | `.exe` setup (NSIS) and `.msi` |
| macOS | `.dmg` and `.app.tar.gz`, one set for Apple silicon and one for Intel |
| Linux | `.AppImage`, `.deb`, `.rpm` |

## Steps

1. **Set the version** in the workspace `Cargo.toml` (`[workspace.package] version`). It is the only place the version lives. Run `cargo check` so `Cargo.lock` picks it up.
2. **Update `CHANGELOG.md`**: replace `Unreleased` with today's date for that version.
3. Merge those changes into `main` through a pull request.
4. **Start the release**, either way:
   - On GitHub: **Actions → Release → Run workflow**, branch `main`.
   - Or push a tag: `git tag v0.2.0` and `git push origin v0.2.0`. The tag must match the version in `Cargo.toml`, or the workflow stops.
5. Wait for the four build jobs to finish (about 15–20 minutes).
6. Open **Releases**, check the draft (files and notes), and click **Publish release**. If the workflow was started by hand, publishing creates the tag `v<version>` on the commit that was built.

While the version is `0.x`, releases are marked as **pre-release**.

If a build fails, fix it and run the workflow again: it reuses the existing draft for that version. Delete stale assets from the draft first if a job had already uploaded some.

## Signing

The installers are not signed yet:

- **Windows** shows a SmartScreen warning ("More info → Run anyway"). The plan is to sign with [SignPath](https://signpath.org), which is free for open source projects.
- **macOS** builds are ad-hoc signed (`bundle.macOS.signingIdentity = "-"` in `tauri.conf.json`), which is needed to run on Apple silicon. They are not notarized, so users must click **Open Anyway** in **System Settings → Privacy & Security** the first time. Notarization needs a paid Apple Developer account.
- **Linux** packages are not signed.

The release notes explain these warnings to users.
