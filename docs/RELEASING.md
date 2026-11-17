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
5. Wait for the four build jobs to finish (about 15–20 minutes). If Windows signing is on, approve its two signing requests in SignPath while it runs.
6. Open **Releases**, check the draft (files and notes), and click **Publish release**. If the workflow was started by hand, publishing creates the tag `v<version>` on the commit that was built.

Releases are not marked as pre-release, even while the version is `0.x`: the in-app updater and the `releases/latest` links only see full releases.

If a build fails, fix it and run the workflow again: it reuses the existing draft for that version. Delete stale assets from the draft first if a job had already uploaded some.

## In-app updates

Installed copies of Partita look for a new version once a day (and from **Help → Check for Updates…**). They read `latest.json` from the latest published release:

```
https://github.com/partita-notation/partita/releases/latest/download/latest.json
```

The workflow generates that file and a signature for every update package. The app only installs packages signed with the project's **updater key**, whose public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.

### The updater key

- The private key is stored in the repository secret **`TAURI_SIGNING_PRIVATE_KEY`** (Settings → Secrets and variables → Actions). If the key has a password, it goes in **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**. The release workflow stops if the key is missing.
- **Keep a backup of the private key** somewhere safe, outside GitHub (a password manager, for example). If it is lost, installed copies can no longer be updated: users would have to download the next version by hand.
- Never commit the private key. Only the public key belongs in the repository.
- To replace the key, generate a new pair with `npx @tauri-apps/cli@2 signer generate -w <path>`, put the new public key in `tauri.conf.json`, and update the secret. Copies installed with the old public key cannot verify updates signed with the new key, so they need one manual update.

On Windows the update runs the `.exe` installer in passive mode (a progress window, no questions). Linux updates work for the AppImage, `.deb` and `.rpm`.

## Signing

### Windows (SignPath)

Windows files are signed with a certificate from the [SignPath Foundation](https://signpath.org), free for open source projects. The rules the project follows are in [CODE_SIGNING.md](CODE_SIGNING.md) (the **code signing policy**, which SignPath requires on the home and download pages).

The `windows` job of the release workflow signs in two rounds, because the installers contain the program:

1. It builds `partita.exe` (`tauri build --no-bundle`) and sends it to SignPath with the artifact configuration **`app`**.
2. It builds the `.exe` setup and the `.msi` around the signed program (`tauri bundle`) and sends both to SignPath with the artifact configuration **`installers`**.
3. It makes the updater signatures (`.sig`) from the signed files. They must come last: Authenticode signing changes the files.

Each round waits until an approver approves the request on [app.signpath.io](https://app.signpath.io) (up to an hour). Approve both when you start a release.

The artifact configurations live in [`.signpath/artifact-configurations/`](../.signpath/artifact-configurations). SignPath does not read them from the repository: paste each one into the SignPath project under the same slug when it changes. They check that the product name is "Partita" and the version is the one being released.

Signing is switched on by these repository settings (**Settings → Secrets and variables → Actions**). Without `SIGNPATH_ORGANIZATION_ID`, the workflow publishes unsigned Windows installers, as before.

| Kind | Name | Value |
|---|---|---|
| Variable | `SIGNPATH_ORGANIZATION_ID` | The organization ID shown in SignPath |
| Secret | `SIGNPATH_API_TOKEN` | API token of a SignPath CI user with *submitter* rights on the project |
| Variable (optional) | `SIGNPATH_PROJECT_SLUG` | Default `partita` |
| Variable (optional) | `SIGNPATH_SIGNING_POLICY_SLUG` | Default `release-signing` |

In SignPath, the project must use the GitHub trusted build system, so only builds from this repository's workflow are signed.

A signed installer can still trigger SmartScreen for a while: Windows builds reputation for the certificate from downloads. It is not lost between versions.

### macOS and Linux

- **macOS** builds are ad-hoc signed (`bundle.macOS.signingIdentity = "-"` in `tauri.conf.json`), which is needed to run on Apple silicon. They are not notarized, so users must click **Open Anyway** in **System Settings → Privacy & Security** the first time. Notarization needs a paid Apple Developer account.
- **Linux** packages are not signed.

The release notes explain these warnings to users.
