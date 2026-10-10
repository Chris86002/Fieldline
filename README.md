# Fieldline

Fieldline is a hunting map for trip planning and field use. It includes Arizona
and Idaho unit references, public-land overlays, map layers, place/unit search,
weather and shooting-light context, saved waypoints, GPS tracks, measuring,
GPX/KML/GeoJSON/CSV import, GPX export, and home-screen installation.

## Install / get started

- **Use the desktop app:** [Install a provided installer](#desktop-app-no-node-needed).
- **Run from source in a browser:** [Local quick start](#developers-local-browser-run).
- **Build or download installers to share:** [Desktop maintainer guide](docs/desktop.md).
- **Contribute or find files:** [Development and repository guide](docs/development.md).

### Desktop app (no Node needed)

Fieldline desktop includes Chromium, Node, the production UI, assets, and local
server functions. **Recipients do not install Node, npm, a browser, or developer
tools.** It opens its own Fieldline window, not a hosted website.

1. Get the matching installer from a **trusted maintainer** (copy, USB, or their
   download). This repository is private: there is no public installer download
   promised here, and workflow artifacts exist only after a successful packaging
   run. Recipients do not need a GitHub account or repository access.
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

For backups, browser-to-desktop transfer, and upgrades, see
[saved data and profiles](docs/desktop.md#saved-data-profiles-and-upgrades).

### Developers: local browser run

Building source requires **Git and Node.js 22.12 or newer (with npm)**, matching
the locked framework requirements. Private repository access is needed to clone:

```sh
git clone https://github.com/Chris86002/Fieldline.git
cd Fieldline
npm ci
npm run dev
```

Keep the terminal running and open <http://localhost:8080>. Stop with Ctrl+C.
This is a development browser session, **not** a desktop installer.
See [checks, production commands, and repository navigation](docs/development.md).

### Browser home-screen installation

The browser app includes a manifest, service worker, and installation help.
On a supported browser using HTTPS (or localhost), use Fieldline's installation
prompt or your browser's install option. On iPhone/iPad, open in Safari and use
**Share → Add to Home Screen**. Availability depends on browser support; there
is no hosted Fieldline URL supplied here. Home-screen installation does not
provide complete offline maps or transfer data between origins.

## Troubleshooting

- **Cannot find an installer or access the repository?** Ask the trusted
  maintainer for a matching binary; downloading a source ZIP is not installing
  the desktop app. See [maintainer download directions](docs/desktop.md#download-and-share-workflow-artifacts).
- **Unsigned app blocked or desktop won't start?** Keep OS protections enabled;
  see [desktop troubleshooting](docs/desktop.md#troubleshooting).
- **`npm ci`, startup, or port errors?** See [local troubleshooting](docs/development.md#troubleshooting).

## Saved data and offline limits

Waypoints, tracks, and settings stay in this browser's local storage under the
`fieldline-v1` key. They do not sync between devices. Export a GPX file from
**Saved** before changing browser or domain, then import that file on the new
origin. GPX transfers marks and tracks, not settings. Desktop uses a separate
persistent profile; browser data does not transfer automatically. Export backups
before upgrades or uninstalling. There is no cloud sync.

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

## Contributor navigation

Start with [contributor notes](AGENTS.md) and the
[repository map and development commands](docs/development.md#repository-map).
Detailed packaging, smoke tests, and profile contracts live in the
[desktop guide](docs/desktop.md). Required framework/configuration files stay at
the root; this cleanup does not move source code or change saved-data formats.
