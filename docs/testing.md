# Testing

Reproducible commands, fixtures and recorded results. See
[development.md](development.md) for setup.

## Commands

```sh
npm ci
npm test            # node --test over src/**/*.test.ts
npm run typecheck
npm run lint
npm run build
npm run desktop:test
# Browser smoke: needs `npx playwright install chromium` once, and
# `npm run start` running in another terminal.
npm run smoke
# Phone field-test tool (CC-01), headless Chromium with emulated GPS:
npm run field-test:check            # /field-test on the running build (FIELDLINE_URL)
npm run field-test:build && npm run field-test:check -- --static   # standalone page
```

`npm test` discovers every `*.test.ts` under `src/` (it used to cover only
`src/lib/hunt`). Tests run with Node's type stripping, so a module that a test
imports must reach other modules at runtime through relative paths with the
`.ts` extension (`import { x } from "./schema.ts"`). Type-only imports may use
the `@/` alias.

## Fixtures

Fixtures live inside the test files and are labeled as fixtures. None of them
is real provider data.

- `src/lib/hunt/weather.test.ts` — Open-Meteo and NWS response shapes with
  deliberately missing fields.
- `src/lib/hunt/land.test.ts` — BLM SMA identify results: empty, unknown
  codes, unrecognized agency, private, overlapping records, HTTP and
  in-body failures (fetch stubbed).
- `src/features/settings/settings.test.ts` — a legacy `fieldline-v1` profile
  (metric, topo, one mark) used for migration, plus corrupt and newer-version
  settings.
- `src/lib/hunt/store.test.ts` — `fieldline-v1` content round-trip and corrupt
  data protection.

## Results log

| Date | Revision | Environment | Result |
| --- | --- | --- | --- |
| 2026-10-13 | 6caea69 (baseline) | Windows 11, Node 24.20.0, npm 11.19.0 | test 15/15, typecheck, lint, build, desktop:test 15/15 all pass |
| 2026-10-13 | CC-02 before review | same | test 46/46, typecheck, lint, build, desktop:test 15/15 pass; `npm run smoke` passed desktop + mobile against `npm run start` |
| 2026-10-13 | CC-02 after review fixes | same | test 52/52, typecheck, lint, build, desktop:test 15/15 pass; `npm run smoke` passed desktop + mobile |
| 2026-10-14 | CC-03 integrated | same | test 167/167, typecheck, lint, build, desktop:test 15/15 pass; `npm run smoke` passed desktop + mobile (now mocks AZ/ID/MT ArcGIS layers and searches all three via the UI); live headless cross-border check passed |

| 2026-10-14 | CC-04 + CC-05 wave 1 integrated (`feature/cc04-cc05`) | same | test 262/262, typecheck, lint, build, desktop:test 15/15, smoke desktop + mobile pass; `scripts/storage-browser-check.mjs` passes in Chromium; fresh-profile reload keeps the new public-land default (real browser) |
| 2026-10-14 | CC-04 wave 2 MAP-03 (`cc04/map-wave2`) | same | test 352/352, typecheck, lint, build; smoke desktop + mobile pass; `offline-contours-check` and `offline-ui-check` pass against the production build (desktop:test not run: no desktop changes) |
| 2026-10-14 | MAP-03 CC-12 review fixes, merged with `feature/cc04-cc05` b2b0c32 | same | test 408/408, typecheck, lint, build; smoke desktop + mobile pass; `offline-contours-check` (now also past the package: 25 terrain requests for 25 tiles) and `offline-ui-check` pass against the production build |
| 2026-10-14 | CC-01 field-test prototype (`cc01/recording-prototype`) | same | test 429/429, typecheck, lint, build; smoke desktop + mobile pass; `field-test:check` passes for the app route and the static page (headless Chromium: page hidden by a synthetic visibilitychange because headless keeps pages visible; no freeze events delivered). No phone tested. |

Other scripts: `node scripts/storage-browser-check.mjs` (real IndexedDB in
Chromium), `node scripts/map-gallery.mjs` (fixed-view screenshots with live
tiles; manual visual comparison), `node scripts/map-perf.mjs` (load and pan
cost at a fixed view, live tiles; compare runs on one machine) and
`node scripts/offline-contours-check.mjs` (contours drawn from a downloaded
area with tile hosts blocked).

Opt-in live provider test: `FIELDLINE_LIVE=1 node --experimental-strip-types --test src/features/catalog/adapters/mtfwp.live.test.ts`
(a few real requests to Montana FWP; never run in CI).

Manual browser checks (2026-10-13, dev server and production build in the
desktop app's built-in browser, desktop and 375×812 mobile): legacy profile
migration, Settings panel, Scouting preset on/off, weather card with live
Open-Meteo data, no horizontal overflow at 375 px.

Not run: packaged Electron smoke (`npm run desktop:smoke`), physical phone
tests, live-provider smoke tests beyond the manual browser session.

## Known console noise

- A React hydration mismatch on the shade-bar clock when the server and client
  render in different minutes. Present before CC-02; not yet fixed.
- "An unknown error occurred when fetching the script" in the built-in
  browser, likely its service-worker registration. Not investigated.
