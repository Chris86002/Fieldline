# Fieldline

Fieldline is a hunting map for trip planning and field use. It includes Arizona
and Idaho unit references, public-land overlays, map layers, place/unit search,
weather and shooting-light context, saved waypoints, GPS tracks, measuring,
GPX/KML/GeoJSON/CSV import, GPX export, and home-screen installation.

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
