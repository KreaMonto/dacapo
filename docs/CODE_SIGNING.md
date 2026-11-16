# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

The Windows installers (`.exe` and `.msi`) and the `dacapo.exe` program inside them are signed. They are built from this repository by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) and published on the [Releases page](https://github.com/dacapo-editor/dacapo/releases). Nothing built outside that workflow is signed.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [Members of the dacapo-editor organization](https://github.com/orgs/dacapo-editor/people) |
| Approvers | [Owners of the dacapo-editor organization](https://github.com/orgs/dacapo-editor/people?query=role%3Aowner) |

- Every change reaches `main` through a reviewed pull request.
- Every signing request is approved by hand by an approver in SignPath, once per release.
- All team members use multi-factor authentication on GitHub and SignPath.

## Privacy policy

Da Capo does not collect, store or send personal data or usage statistics. Your scores stay on your computer.

The program connects to the internet only in these cases:

| When | Where | Why | How to turn it off |
|---|---|---|---|
| Once a day, at startup | `github.com` (the Da Capo Releases page) | To check whether a newer version exists. If there is one, Da Capo asks you before downloading it. | **Help → Automatic Updates** (untick). **Help → Check for Updates…** still works when you ask. |
| When you choose to download the SoundFont for playback | `github.com` (the FluidR3 GM SoundFont release) | To download the sounds used for playback. It happens once, after you confirm. | Do not download it; everything except playback works without it. |
| When you click a link (for example in the About dialog) | The site of that link, in your web browser | — | Do not click it. |

These requests send only what any web request contains (your IP address and the program's name and version). GitHub's handling of them is described in the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

Apart from these cases, this program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.
