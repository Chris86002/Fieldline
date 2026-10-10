# Desktop: building, distribution, and saved data

[Back to README / end-user installation](../README.md#desktop-app-no-node-needed) ·
[Development and repository map](development.md)

This guide is for maintainers building source or sharing installers. Recipients
install a provided binary and do **not** need Node, npm, a browser, or developer
tools. The repository is private; do not assume public releases or existing
installer artifacts.

## Build from source

Use Git and **Node.js 22.13+ (22.x) or 24+ (with npm)** on the build machine only.
Follow the [clone and dependency setup](../README.md#developers-local-browser-run),
then run these commands from the repository root:

```sh
npm run desktop:test
npm run desktop:dev       # builds/opens real production desktop; rerun after edits
npm run desktop:pack      # unpacked app for native smoke verification
npm run desktop:dist      # installer for the current platform
npm run desktop:win       # Windows x64 NSIS, preferably on Windows
npm run desktop:mac       # separate Intel and Apple Silicon DMGs, on macOS
npm run desktop:linux     # optional Linux x64 AppImage
npm run desktop:smoke     # run against an already-packaged native app
```

These are separate choices, not a requirement to build every platform locally.
Output is in `release/` (ignored). `desktop:build` uses Nitro's middleware
preset in `.desktop-output/`; normal `npm run build`/`start` remain unchanged.
electron-builder copies the **entire** desktop server/public output into
`resources/fieldline`, alongside Electron's bundled Chromium and Node runtime.
No external Node process or development server is used.

Version releases by updating both [`package.json`](../package.json) and
[`desktop/package.json`](../desktop/package.json) plus the root lockfile;
preserve the profile/origin contract below. Keep Electron current and rerun
checks for security updates.

## Download and share workflow artifacts

The manual workflow is [`Fieldline desktop installers`](../.github/workflows/desktop.yml).
In this private repository, a maintainer with permission can open **Actions →
Fieldline desktop installers → Run workflow**. The workflow must be on the
default branch for manual dispatch; select the intended branch/ref.

It uses native Windows, Intel Mac, Apple Silicon Mac, and Linux runners with
Node 22 and `npm ci`, runs all four web checks plus desktop tests and packaged
smoke tests, and uploads installer-only artifacts for **14 days** after successful
packaging. It does **not** publish releases or run on every push; permissions are
read-only and no signing secrets are required. A configured workflow is not
proof that installers have already been built or tested.

Open the successful run's summary, download the matching
`Fieldline-win-x64-installers`, `Fieldline-mac-x64-installers`,
`Fieldline-mac-arm64-installers`, or `Fieldline-linux-x64-installers` artifact ZIP,
extract it, and share the `.exe`, `.dmg`, or `.AppImage` itself through a trusted
channel. If artifacts have expired or a run failed, build again rather than
pointing recipients to an unavailable download. Do not share build directories,
profiles, or signing credentials. GitHub access is only needed by the maintainer.

## Packaged smoke tests and manual verification

The smoke test checks packaged resources, local UI launch with renderer provider
requests blocked, API validation, sandbox preferences, rejected unauthenticated
server access/navigation, GPX import/export, full restart persistence, and server
cleanup. Override `FIELDLINE_DESKTOP_EXECUTABLE` with an absolute executable
path for another native package (including `release/mac-arm64/...`); on Linux run
under `xvfb-run -a` when no display is available.

Linux headless smoke uses SwiftShader software rendering flags only in the test
launcher, not in the distributed app, and never disables the renderer sandbox.
It does not verify live provider availability, real GPS hardware, or installer
dialogs. Before sharing, manually install each target artifact on a clean
matching OS/architecture without Node, launch offline, test online
maps/search/weather, GPS permission, import/export, restart, and upgrade over a
previous version. Native Windows/macOS results must be verified on those systems,
not inferred from a Linux build. See the [platform requirements and unsigned-app
warnings](../README.md#desktop-app-no-node-needed) before sharing.

Optional trusted distribution can use electron-builder's
[code signing](https://www.electron.build/code-signing.html) and Apple
notarization with maintainer-managed certificates. None are checked into this
repository. Signing/notarization is optional maintainer work, not required to
build, and these builds do not guarantee warning-free installation.
Packaging/security references:
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation),
[distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution),
and [NSIS](https://www.electron.build/nsis.html).

## Saved data, profiles, and upgrades

The desktop app keeps the unchanged `fieldline-v1` data format in its own
persistent profile, separate from browsers. It always uses
`http://127.0.0.1:47831`, the `persist:fieldline` partition, app ID
`org.fieldline.desktop`, and profile name `Fieldline`. Do not change this origin,
partition, app ID, or profile name in an upgrade without a migration.
If the port is occupied, startup fails with guidance rather than changing ports
and appearing to lose your data. The server binds only to IPv4 loopback, requires
a private per-launch token, and stops when Fieldline quits.

Profiles live under `%APPDATA%/Fieldline` (Windows),
`~/Library/Application Support/Fieldline` (Mac), or `~/.config/Fieldline`
(Linux; OS app-data overrides may vary). Installing an update over the old app
does not clear that profile; the Windows uninstaller also retains it. Export GPX
backups before upgrades or uninstalling. Deleting this profile deletes local data.
Existing browser data **does not transfer automatically**: export GPX from
**Saved** in your browser, then import it in desktop Fieldline. GPX transfers
marks and tracks, **not settings**; reapply settings manually. No cloud sync.

## Troubleshooting

- **SmartScreen/Gatekeeper warning:** only approve a file from a trusted sender
  using the OS's per-app flow described in the [README](../README.md#desktop-app-no-node-needed).
  If policy prevents approval, contact the maintainer or administrator. Never
  disable antivirus, Gatekeeper, certificate validation, or other protections.
- **Startup says port 47831 is occupied:** quit any existing Fieldline instance.
  If another app uses that port, close it only if safe or ask for help. Do not
  change Fieldline's port or delete its profile as a workaround.
- **Wrong architecture or missing Linux libraries:** request the matching
  installer. Linux AppImage needs FUSE and normal Chromium system libraries;
  use your distro's supported packages. Do not bypass the renderer sandbox.
- **Maps/search/weather unavailable offline:** the bundled UI is not complete
  offline maps. Public-provider data still needs internet; caching is small,
  best-effort, storage-limited, and subject to provider terms.
- **GPS unavailable or inaccurate:** check requested location permission and OS
  location support; a successful desktop launch does not guarantee usable GPS.
- **Saved browser marks missing in desktop:** the profiles are separate. Use GPX
  export/import rather than deleting data or expecting cloud sync.
