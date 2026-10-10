# Fieldline

Fieldline is a hunting map for trip planning and field use. It includes Arizona
and Idaho unit references, public-land overlays, map layers, place/unit search,
weather and shooting-light context, saved waypoints, GPS tracks, measuring,
GPX/KML/GeoJSON/CSV import, GPX export, and home-screen installation.

## Desktop app for family

Fieldline desktop includes Chromium, Node, the production UI, assets, and local
server functions. **Recipients do not install Node, npm, a browser, or developer
tools.** It opens its own Fieldline window, not a hosted website.

1. Get the matching installer directly from the person sharing Fieldline (copy,
   USB, or download). Family members do not need a GitHub account or repository access.
2. **Windows 10/11, Intel/AMD 64-bit:** run `Fieldline-…-win-x64.exe`, install
   for your user, then open **Fieldline** from Start Menu or the desktop shortcut.
   The NSIS installer is self-contained, not a web/downloader installer, and
   normally needs no administrator privileges.
3. **macOS:** use `…-mac-arm64.dmg` for Apple Silicon or `…-mac-x64.dmg` for
   Intel. Open it, drag Fieldline to **Applications**, eject it, then launch
   Fieldline from Applications. Target macOS 12 or newer; test your actual OS
   before sharing widely.
4. **Linux (optional):** x64 `…-linux-x64.AppImage` targets desktop Linux with
   FUSE and normal Chromium system libraries (Ubuntu 22.04+). Mark it executable
   and launch it. Linux is less turnkey: missing OS libraries/FUSE may require
   distro packages. Prefer the Windows/macOS installers for family.

Initial installers are **unsigned**. Windows SmartScreen may warn about an
unknown publisher; macOS Gatekeeper may block an unidentified developer. Only
proceed if you trust the sender and file: use the OS's per-app approval flow
(Windows **More info → Run anyway**, if offered; macOS **System Settings →
Privacy & Security → Open Anyway**, if allowed). Organizational policies may
prevent approval. Do not disable antivirus, Gatekeeper, certificate validation,
or other system protections. Signing/notarization is optional maintainer work,
not required to build; these builds do not guarantee warning-free installation.

The UI is bundled and launches without a hosted site, but **packaging is not
complete offline maps**. Public-provider maps, search, weather, elevation, and
unit/land data still need internet. Tile caching remains small and best-effort,
subject to storage limits and provider terms. Attribution and legal/access
caveats remain in the map interface. GPS requires your permission and OS
location support; desktop location may be unavailable or inaccurate.

### Saved data and upgrades

The desktop app keeps the unchanged `fieldline-v1` data format in its own
persistent profile, separate from browsers. It always uses
`http://127.0.0.1:47831` and the `persist:fieldline` partition. Do not change this
origin, partition, app ID, or profile name in an upgrade without a migration.
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

### Build, download, and share (maintainer)

Use Node **22.12+** and `npm ci` on the build machine only:

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

Output is in `release/` (ignored). `desktop:build` uses Nitro's middleware
preset in `.desktop-output/`; normal `npm run build`/`start` remain unchanged.
electron-builder copies the **entire** desktop server/public output into
`resources/fieldline`, alongside Electron's bundled runtime. No external Node
process or development server is used. Version releases by updating
both `package.json` and `desktop/package.json` plus the root lockfile; preserve the profile/origin contract above.
Keep Electron current and rerun checks for security updates.

In this private repository, the owner can open **Actions → Fieldline desktop
installers → Run workflow** after this workflow is merged onto the default
branch. Select the intended branch/ref. The workflow uses native Windows,
Intel Mac, Apple Silicon Mac, and Linux runners with Node 22 and `npm ci`,
runs all four web checks plus desktop tests and packaged smoke tests, and uploads
installer-only artifacts for 14 days. It does **not** publish releases or run
on every push; permissions are read-only and no signing secrets are required.
Download the matching artifact ZIP, extract it, and share the `.exe`, `.dmg`, or
`.AppImage` itself through a trusted channel. Do not share build directories,
profiles, or signing credentials. GitHub access is only needed by the maintainer.

The smoke test checks packaged resources, local UI launch with renderer provider
requests blocked, API validation, sandbox preferences, rejected unauthenticated
server access/navigation, GPX import/export, full restart persistence, and server
cleanup. Override `FIELDLINE_DESKTOP_EXECUTABLE` with an absolute executable
path for another native package (including `release/mac-arm64/...`); on Linux run
under `xvfb-run -a` when no display is available.
Linux headless smoke uses SwiftShader software rendering flags only in the test
launcher, not in the distributed app, and never disables the renderer sandbox.
It does not verify live provider availability, real GPS hardware, or installer dialogs. Before sharing,
manually install each target artifact on a clean matching OS/architecture without
Node, launch offline, test online maps/search/weather, GPS permission, import/export,
restart, and upgrade over a previous version. Native Windows/macOS results must
be verified on those systems, not inferred from a Linux build.

Optional trusted distribution can use electron-builder's
[code signing](https://www.electron.build/code-signing.html) and Apple
notarization with maintainer-managed certificates. None are checked into this
repository. Packaging/security references:
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation),
[distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution),
and [NSIS](https://www.electron.build/nsis.html).

## Run locally

Use Node.js 22 or newer:

```sh
npm ci
npm run dev
```

Open <http://localhost:8080>. Useful checks and production commands:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run start
```

`npm run start` serves the production Node build from `.output/` (default port
3000; set `PORT` to choose another port). For a production preview without
starting the Node server, use `npm run preview`.

## Deployment and data

Build with `npm ci && npm run build`, then run `npm run start` on a Node 22+
host. No Grok/App Builder account, credentials, database, or environment
secrets are required. The app uses external public data services; map, search,
weather, elevation, and land-identification details need an internet connection.

Waypoints, tracks, and settings stay in this browser's local storage under the
`fieldline-v1` key. They do not sync between devices. Export a GPX file from
Saved before changing browser or domain, then import that file on the new
origin. GPX transfers marks and tracks, not settings.

The app can cache map tiles for a small, user-selected view at one zoom level.
This is best-effort browser storage, not a complete offline map: roads, labels,
search, weather, unit data, and some map styles still require a connection.
Browser storage limits, private browsing, and map-provider terms can also limit
tile caching.

## Data providers and limits

- **Map rendering:** MapLibre GL JS; OpenFreeMap tiles/fonts; Esri World Imagery,
  World Street Map, hillshade, and reference layers; USGS topo tiles; and BLM
  surface-management tiles. Map attribution is shown on the map.
- **Places:** Nominatim (OpenStreetMap) for explicit searches, with Photon as a
  fallback. Search only after submitting a query; do not use it as autocomplete.
- **Weather and terrain:** Open-Meteo, NOAA National Weather Service, and USGS
  elevation services. Forecasts are models, not local ridge readings.
- **Fonts:** system font stacks; no external font service is required.
- **Boundaries and ownership:** Arizona and Idaho unit and land data are
  references, not legal boundary or access determinations. Verify current rules,
  access, and ownership with the responsible agencies before a hunt. Owner-name
  parcel data is not included.

Fieldline is an independent planning aid, not official agency guidance. Map
availability and external-provider terms can change.

## Repository layout

- `src/components/hunt/` — map and hunting-map interface
- `src/lib/hunt/` — mapping data, persistence, import/export, weather, search,
  and tile cache
- `src/routes/` — TanStack Start routes and server functions
- `public/` — Fieldline PWA manifest, icons, service worker, and static assets
- `scripts/browser-smoke.mjs` — desktop/mobile browser smoke check
