# Desktop: building, distribution, and saved data

[Back to README / end-user installation](../README.md#desktop-app-no-node-needed) ·
[Development and repository map](development.md)

This guide is for maintainers building source or sharing installers. Recipients
install a provided binary and do **not** need Node, npm, a browser, or developer
tools. The repository is public. Verified Windows ZIPs are published to GitHub Releases;
Mac/Linux installer artifacts are available after successful native packaging.

## Build from source

Use Git and **Node.js 22.13+ (22.x) or 24+ (with npm)** on the build machine only.
Follow the [clone and dependency setup](../README.md#developers-local-browser-run),
then run these commands from the repository root:

```sh
npm run desktop:test
npm run desktop:dev       # builds/opens real production desktop; rerun after edits
npm run desktop:pack      # unpacked app for native smoke verification
npm run desktop:dist      # installer + share ZIP for the current native target
npm run desktop:win       # Windows x64 installer + ZIP, on Windows
npm run desktop:mac       # separate Intel and Apple Silicon DMGs + ZIPs, on macOS
npm run desktop:linux     # optional Linux x64 AppImage + ZIP, on Linux
npm run desktop:smoke     # run against an already-packaged native app
```

These are separate choices, not a requirement to build every platform locally.
Installers are in `release/`; forward only `release/share/Fieldline-<version>-<platform>-<arch>.zip`
(both directories are ignored). Each share ZIP contains only the matching
`Install-Fieldline.exe`, `Install-Fieldline.dmg`, or `Fieldline.AppImage` and
`START-HERE.txt` at its root. It never includes source or unpacked apps.
The ZIP is byte-for-byte deterministic for identical installer bytes and target/version;
this does not promise reproducible or signed native installers.

The installer commands build, package, run the native packaged smoke, then bundle.
For Linux without a display, run the installer command under `xvfb-run -a`.
To regenerate a ZIP after an already-verified native build, use
`npm run desktop:bundle -- --platform win --arch x64` (substitute `mac`/`linux`
and `arm64` as appropriate; Windows/Linux support x64 only).
Run packaging on the matching native OS; cross-platform archive tests do not
prove that an installer runs. `desktop:mac` smokes both architectures, so it needs
a Mac capable of running both (including Rosetta for x64 on Apple Silicon);
otherwise use CI's separate native runners.

`desktop:build` uses Nitro's middleware
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
A maintainer with permission can open **Actions →
Fieldline desktop installers → Run workflow**. The workflow must be on the
default branch for manual dispatch; select the intended branch/ref.

It uses native Windows, Intel Mac, Apple Silicon Mac, and Linux runners with
Node 22 and `npm ci`, runs all four web checks plus desktop tests and packaged
smoke tests, generates share ZIPs, and uploads them for **14 days** after successful
packaging. It also runs when app or packaging files change on main. After the
Windows job passes every check, it publishes the Windows ZIP and SHA-256 checksum
to a public GitHub Release with a unique workflow-run/attempt tag. The package job
has contents-write permission for that publication; no signing secrets are required.
Other platform failures do not prevent a verified Windows release.
A configured workflow is not proof that installers have already been built or tested.

For Windows, use [the latest release](https://github.com/Chris86002/Fieldline/releases/latest)
and download the Fieldline ZIP under Assets. Do not download the automatic Source code ZIP.
The artifact instructions below remain useful for Mac/Linux and troubleshooting.

One build/download/share path:

1. Dispatch the workflow and wait for the matching platform job to succeed.
2. Open that run's summary and download **only** the matching artifact:
   `Fieldline-win-x64-share`, `Fieldline-mac-x64-share`,
   `Fieldline-mac-arm64-share`, or optional `Fieldline-linux-x64-share`.
3. GitHub downloads an **outer artifact ZIP**. Extract this outer ZIP **once**.
   Inside is the actual **`Fieldline-<version>-<platform>-<arch>.zip`**.
4. Forward that inner, versioned ZIP unchanged through a trusted channel.
   **Do not forward GitHub's outer ZIP or use “Download all artifacts.”**
   Recipients extract the forwarded ZIP once to find the installer and short guide;
   they never need GitHub access.

If artifacts have expired or a run failed, build again rather than
pointing recipients to an unavailable download. Do not share build directories,
profiles, or signing credentials. GitHub access is only needed by the maintainer.

## Packaged smoke tests and manual verification

The smoke test checks packaged resources, local UI launch with renderer provider
requests blocked, API validation, sandbox preferences, rejected unauthenticated
server access/navigation, GPX import/export, full restart persistence, and server
cleanup. Override `FIELDLINE_DESKTOP_EXECUTABLE` with an absolute executable
path for another native package (including `release/mac-arm64/...`); on Linux run
under `xvfb-run -a` when no display is available.

Native smoke tests use SwiftShader software rendering flags only in the test
launcher, not in the distributed app, and never disable the renderer sandbox.
The test removes developer runtimes from PATH, retaining only Windows System32
on Windows because Playwright needs the system shell to launch Electron.
It does not verify live provider availability, real GPS hardware, or installer
dialogs. Before sharing, verify each actual ZIP on a clean matching OS/architecture:

- Extract the ZIP and install without Node/npm/developer tools installed.
- Windows: use a standard (non-admin) user; verify no directory wizard, automatic
  launch, and working desktop/Start menu shortcuts. Record unsigned prompts honestly.
- Mac: verify the matching DMG opens, drag to Applications, eject, and launch.
- Launch offline (bundled UI, not complete maps), then test online
  maps/search/weather, GPS permission, import/export, and full restart.
- Export a GPX backup, install an upgrade over a previous version, and verify saved
  marks/tracks/settings remain. On Windows, also uninstall/reinstall and verify
  the retained profile; never select manual profile deletion.

Native Windows/macOS results must be verified on those systems,
not inferred from a Linux build. See the [platform requirements and unsigned-app
warnings](../README.md#desktop-app-no-node-needed) before sharing.

Optional trusted distribution can use electron-builder's
[code signing](https://www.electron.build/code-signing.html) and Apple
notarization with maintainer-managed certificates. None are checked into this
repository. Signing/notarization remains the prerequisite for reducing unsigned
warnings, not required to build; these builds do not guarantee prompt-free installation.
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
