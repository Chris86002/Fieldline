# Fieldline

Fieldline is a hunting map for trip planning and field use across all 50
states and DC. It includes state hunt-unit references where available (Arizona,
Idaho, and Montana so far; see [coverage](docs/coverage.md)), public-land
overlays, map layers, place/unit search,
weather and shooting-light context, saved waypoints, GPS tracks, measuring,
GPX/KML/GeoJSON/CSV import, GPX export, and home-screen installation.

## Install / get started

- **Use the desktop app:** [Install from a shared ZIP](#desktop-app-no-node-needed).
- **Run from source in a browser:** [Local quick start](#developers-local-browser-run).
- **Build or download installers to share:** [Desktop maintainer guide](docs/desktop.md).
- **Contribute or find files:** [Development and repository guide](docs/development.md).

### Desktop app (no Node needed)

Fieldline desktop includes Chromium, Node, the production UI, assets, and local
server functions. **Recipients do not install Node, npm, a browser, or developer
tools.** It opens its own Fieldline window, not a hosted website.

1. Download the Windows **Fieldline ZIP** from [Releases](https://github.com/Chris86002/Fieldline/releases/latest).
   Choose `Fieldline-…-win-x64.zip` under **Assets**, not GitHub's **Source code** ZIP.
   Downloads appear only after the Windows packaging and launch checks pass.
   No GitHub account is required. Mac/Linux builds remain available as workflow artifacts.
2. **Windows 10/11, Intel/AMD 64-bit:** get `Fieldline-…-win-x64.zip`.
   Right-click it → **Extract All**, open the extracted folder, and double-click
   **Install-Fieldline.exe**. It installs for your user without a directory wizard,
   creates desktop/Start menu shortcuts, and opens Fieldline when finished.
   Everything needed is included; normally no administrator permission is needed.
3. **macOS:** get `Fieldline-…-mac-arm64.zip` for Apple Silicon or
   `Fieldline-…-mac-x64.zip` for Intel. Double-click the ZIP to extract it, open
   **Install-Fieldline.dmg**, drag Fieldline to **Applications**, eject it, then launch
   Fieldline from Applications. Target macOS 12 or newer; test your actual OS
   before sharing widely.
4. **Linux (optional):** extract `Fieldline-…-linux-x64.zip`. Its
   **Fieldline.AppImage** targets desktop Linux with FUSE and normal Chromium
   system libraries (Ubuntu 22.04+). Allow it to run as a program in file
   properties and launch it. Linux is less turnkey: missing OS libraries/FUSE may require
   distro packages. Prefer the Windows/macOS installers for family.

Every ZIP includes a short **START-HERE.txt** guide. Mac installation still needs
the drag-to-Applications step; it is not a Windows-style automatic installer.

Initial installers are **unsigned**. Windows SmartScreen may warn about an
unknown publisher; macOS Gatekeeper may block an unidentified developer. Only
proceed if you trust the sender and file: use the OS's per-app approval flow
(Windows **More info → Run anyway**, if offered; macOS **System Settings →
Privacy & Security → Open Anyway**, if allowed). Organizational policies may
prevent approval. Do not disable antivirus, Gatekeeper, certificate validation,
or other system protections. Maintainer signing/notarization is still needed to
reduce these warnings; these builds do not guarantee prompt-free installation.

The UI is bundled and launches without a hosted site, but **packaging is not
complete offline maps**. Public-provider maps, search, weather, elevation, and
unit/land data still need internet. Tile caching remains small and best-effort,
subject to storage limits and provider terms. Attribution and legal/access
caveats remain in the map interface. GPS requires your permission and OS
location support; desktop location may be unavailable or inaccurate.

Saved marks and tracks stay on this device, not in cloud sync. Export a GPX backup
from **Saved** before updates or uninstalling. For browser-to-desktop transfer and upgrades, see
[saved data and profiles](docs/desktop.md#saved-data-profiles-and-upgrades).

### Developers: local browser run

Building source requires **Git and Node.js 22.13+ (22.x) or 24+ (with npm)**,
matching the locked dependency requirements. Clone the public repository:

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

- **Cannot find an installer?** Check the Releases page for a successful Windows build;
  downloading a source ZIP is not installing the desktop app. See [maintainer download directions](docs/desktop.md#download-and-share-workflow-artifacts).
- **Unsigned app blocked or desktop won't start?** Keep OS protections enabled;
  see [desktop troubleshooting](docs/desktop.md#troubleshooting).
- **`npm ci`, startup, or port errors?** See [local troubleshooting](docs/development.md#troubleshooting).

## Saved data and offline limits

Waypoints and tracks are kept in this browser's database (IndexedDB), moved
there automatically from the older `fieldline-v1` storage, which is left as it
was; preferences are under `fieldline-settings` (see
[saved-data formats](docs/data-migrations.md)). Deleted marks and tracks go to
**Recently deleted** in Saved until you delete them forever, and a recording
interrupted by a crash or reload is offered back when Fieldline reopens.
Nothing syncs between devices. **Settings → Backup and restore** saves
settings, marks, tracks and recently deleted items in one file; GPX remains
the format for other apps. Desktop uses a separate
persistent profile; browser data does not transfer automatically. Export backups
before upgrades or uninstalling. There is no cloud sync.

**Layers → Offline maps** downloads the map view for use with no signal: USGS
imagery or topo, public land, roads and labels, and terrain, over a zoom range
you choose, with a size estimate first, pause and resume, and a check that every
file arrived before an area counts as ready. Downloaded areas can be checked,
repaired, updated, shown on the map, or deleted; the spot card says whether a
spot is covered. Esri imagery and hunt units are never downloaded (provider
terms; unverified rights), and search, weather and land lookups still need a
connection. Downloads live in browser storage: private browsing or a full device
can still clear them, so check an area before a trip. See
[docs/storage.md](docs/storage.md).

## Data providers and limits

- **Map rendering:** MapLibre GL JS; OpenFreeMap tiles/fonts; Esri World Imagery,
  World Street Map, hillshade, and reference layers; USGS topo tiles; and BLM
  surface-management tiles. Map attribution is shown on the map.
- **Places:** Nominatim (OpenStreetMap) for explicit searches, with Photon as a
  fallback. Search only after submitting a query; do not use it as autocomplete.
- **Weather and terrain:** Open-Meteo, NOAA National Weather Service, and USGS
  elevation services. Forecasts are models, not local ridge readings.
- **Fonts:** system font stacks; no external font service is required.
- **Boundaries and ownership:** hunt units (Arizona Game and Fish, Idaho Fish
  and Game, Montana Fish, Wildlife & Parks) and land data are references, not
  legal boundary or access determinations. Verify current rules,
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
