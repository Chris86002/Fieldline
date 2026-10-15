# Implementation status

Ledger for [the master spec](Fieldline-AI-Master-Implementation-Document.txt).
Resume here after a session reset: check `git log` and `git status` first, then
continue from **Next runnable work**.

Status values: not started · in progress · implemented unverified · verified ·
blocked. Device certification is tracked separately from code completion.

- **Branch:** `feature/master-spec-v4` (from `main` @ `6caea69`)
- **Last updated:** 2026-10-13
- **Coordinator-owned files right now:** `package.json`, lockfile, CI,
  `desktop/*`, `HuntApp.tsx`, `MapCanvas.tsx`, `src/lib/hunt/store.ts`,
  `src/lib/hunt/types.ts`, `src/features/settings/*`. No worker holds write
  ownership.

## Baseline (CC-00)

- HEAD at start: `6caea69`, identical to the spec's reviewed snapshot; clean
  tree.
- Toolchain installed for this work: Git 2.55, Node 24.20.0 (meets AGENTS.md
  Node 24+), npm 11.19.0.
- Baseline checks all passed (see [testing.md](testing.md)).
- Platforms in repo: browser/PWA (TanStack Start + Nitro), Electron desktop
  (Windows/macOS/Linux packaging). No native mobile shell.
- Saved formats: see [data-migrations.md](data-migrations.md).
- Providers: see [data-sources.md](data-sources.md) (register verified against
  provider pages on 2026-10-13).
- Spec findings A–K were confirmed against the code; line numbers matched the
  snapshot.

## Packet ledger

| Packet | Status | Evidence / notes |
| --- | --- | --- |
| CC-00 Baseline and contracts | verified | Baseline report above; test glob widened to `src/**/*.test.ts` (verified a feature-folder test runs); provider register; ADR-001–006; ownership table above. |
| CC-01 Phone feasibility | in progress | [phone-strategy.md](phone-strategy.md): options, proposed `LocationSource` / `TrackCheckpointStore` / `PackageStore` interfaces, 13-scenario device protocol, result template, capability matrix. No physical devices available; decision and certification pending (REL-02/03). Prototype not built yet. |
| CC-02 Correctness and settings | verified (automated + manual browser); see deferred items | Slices below. Independent CC-12 review found 0 blockers, 2 major, 10 minor; both majors and 7 minors fixed with regression tests. |
| CC-03 Nationwide catalog | verified (first slices); see CC-03 detail | AZ/ID mode removed; catalog contracts, five unit adapters (AZ, ID, MT, CO, UT), protected unit store, 51-entry coverage register, discovery, nationwide unit search, shell integration. Remaining slices listed below. |
| CC-04 Map design | wave 1 verified (merged on `feature/cc04-cc05`) | MAP-01 named render groups (9 groups, stable ids, insert/remove order tests) + per-style tokens; MAP-02 cleanup: public-land default 0.62 → 0.25 for new profiles only (gallery trials: 0.15–0.2 lost agency distinction, 0.35+ washed out imagery), lighter casings on imagery, quieter highways, cased trails above local roads, relief ~half strength on imagery; unit labels use collision + priority instead of forced overlap; new settings Boundary strength and Label density. Gallery: `scripts/map-gallery.mjs` (96 before / 96 after shots kept locally in screenshots/gallery, not committed). Known trade-offs in docs/map-design.md (agency colors subtle at 0.25, less depth in gentle terrain, unit numbers can hide each other). Wave 2: MAP-03 signature styles + contours/land cover, MAP-04 comparison, MAP-06 recipes/inspection, text/marker size, clustering. |
| CC-05 Storage and offline | waves 1–2 verified and wired into the app (merged on `feature/cc04-cc05`); see "Offline maps" below | Wave 2 (offline packages, `src/lib/offline/`): CC-12 review found 3 major (long Retry-After not stopping a provider; per-download instead of tab-wide limits and no cross-tab lock; OpenFreeMap data versions pinning/unreachable offline) + 8 minor — all fixed with behavioral tests and re-verified, including a real v1 → v2 IndexedDB upgrade in Chromium. Wave 1: `src/lib/storage/`: IndexedDB + in-memory backends, v0→v1 migration copying fieldline-v1 content without modifying it (verified read-back, idempotent, refuses corrupt/newer), recording checkpoints with gap segments and damage reporting, trash, `fieldline-backup` v1 with integrity check and strict record validation. Independent review: 0 blockers, 2 major (silent loss of a missing checkpoint chunk; backup accepting an unknown mark kind that would crash rendering) + 9 minor — all fixed with regression tests and re-verified (237 tests; Chromium IndexedDB check: migrate → reload → read back, 602-fix recovery, restore, future-version refusal). Next: wire into the app shell (content store, recording, backup UI), then wave 2 offline package manifests/state machine. |
| CC-06 Navigation | not started | Recording thresholds from settings are in place (CC-02). |
| CC-07 Maintenance and reports | not started | REL-04 fields listed as "not tracked" in data-sources.md. |
| CC-08 Weather platform | not started | Point-forecast nullability and provenance done in CC-02. |
| CC-09 / CC-10 Clouds | not started | Requires CC-08 frame contracts and MAP-02/03. |
| CC-11 Scouting workspace | not started | |
| CC-12 Independent review | in progress (continuous) | CC-02 reviewed 2026-10-13: data-loss/compatibility pass, land pass, React pass; settings and weather majors fixed (NWS "Tonight" treated as tomorrow; damaged settings had no recovery and import claimed success when unsaved). |
| CC-13 Release integration | not started | |

### CC-02 slices

| Slice | Status | What changed | Verification |
| --- | --- | --- | --- |
| Land unknown/error states (finding D, §7) | verified | `land.ts`: empty answer → "Ownership unknown" (`no-record`); unknown codes → tone `unknown`; `PVT` → private; ArcGIS error bodies → outage; overlapping records listed with source and check time. UI no longer says "Likely private" or "blank ground is usually private"; removed "owner names are a paid dataset". | `land.test.ts` 8 tests |
| Nullable, provenanced point weather (finding E, §10) | verified | `weather.ts`: all values nullable; `popHour` vs `popDayMax`; "today" chosen by the point's local date (NWS evening "Tonight" fix); NWS wind range no longer used as gusts; NWS cloud labeled inferred; `source` records provider, fetch/issue time, kind of "now", time zone. UI shows "—" for unknowns, names the forecast point, and labels which clock each time uses. | `weather.test.ts` 12 tests; manual check with live Open-Meteo |
| Daylight vs legal rules (finding G, §7) | verified | Removed `AZ_SHOOT_LEAD_MIN` and the AZ/ID shooting-hours claims; personal light window setting labeled "not a legal rule"; agency link. | Manual check; covered by settings tests for the window values |
| Versioned settings and migration (§5) | verified | `src/features/settings/*`: 34 settings across 6 categories, Field and Scouting presets, per-category reset (home area kept), search, export/import with strict validation, home view, backup-then-replace recovery for damaged or newer settings, honest "not saved" messages. Layers panel writes the same store and says when a preset is on. | `settings.test.ts` 17 tests; manual browser checks (migration, preset on/off) |
| Settings UI accessibility | implemented unverified | Labeled controls, radiogroups, focus-trapped panel (existing `Panel`), 44 px targets. | Not yet screen-reader tested |

**CC-02 deferred items** (from review; low risk, tracked here):
- Settings changed in the instant before hydration are not saved (no UI is
  interactive then; revisit if that changes).
- No cross-tab sync of settings; the last tab to write wins.
- GPS filtering and minimum-move logic is inline in `HuntApp.tsx` and has no
  unit test; CC-06 extracts it into the location service with tests.
- Wake-lock lifecycle is untested beyond manual reasoning.
- `scripts/desktop-smoke.mjs` says "settings survive restart" but only checks
  `fieldline-v1`; extend it to `fieldline-settings` (needs a packaged build to
  run).

**Spec §5 options not yet built** (they will be added with the packet that
gives them a real effect; no placeholder controls were shipped): theme / high
contrast / text size (CC-04), MGRS, scale-bar and range-ring distances,
startup "national overview" and "device location" (CC-03/CC-06), accuracy
circle / fix age / auto-pause / off-route alerts (CC-06), weather radar /
clouds / timeline / refresh policy / time-zone choice / alert channels
(CC-08..10), offline package settings (CC-05), diagnostics / sharing / photo
metadata (CC-07/CC-11), species filters and marker defaults (CC-11), Weather
preset (CC-08).

### CC-03 detail (2026-10-14)

Delegation: coordinator wrote the contracts (`src/features/catalog/types.ts`)
and owned the shell; three workers ran in separate git worktrees with
disjoint file ownership (A and B in parallel, then C on the integrated
branch). Each worker's diff was reviewed and its checks re-run by the
coordinator before a `--no-ff` merge; the merged result was re-tested.

| Slice | Owner | Status | Evidence |
| --- | --- | --- | --- |
| Catalog contracts (LayerDescriptor/ProviderInfo, HuntUnit with namespaced ids, DataStatus, UnitAdapter, JurisdictionCoverage) | coordinator | verified | typecheck; consumed unchanged by all three workers |
| AZ/ID adapters behind the contract; ArcGIS paging/count/metadata helper; interior label points; protected unit store (finding H, REL-05) | worker A | verified | 41 tests; coordinator review of `unit-store.ts`; live: AZ 77 units, ID 100 units, all label points inside |
| Antimeridian-aware bounds; 51-entry coverage register (TIGERweb extents; Alaska split at 180°); discovery; nationwide unit search; docs/coverage.md | worker B | verified | 52 tests incl. AZ–UT, ID–MT, PA–NY, Aleutians, Hawaii, DC |
| Montana deer/elk/lion districts via adapter kit only (REL-10 demo) | worker C | verified | tests + opt-in live run: 139 districts available; no app-shell file in its diff |
| Shell: remove AZ/ID switch; view-driven provider loading; multi-unit spot inspection; nationwide search; OFM state lines; "Coverage in view"; agency links per point; IANA clock zone; national default view | coordinator | verified | 167 unit tests; updated browser smoke (no state switch, three-state search via UI); live headless check below |

Live cross-border check (headless Chromium, real providers, 2026-10-14):
Idaho–Montana view loaded IDFG (100) and MTFWP (139); inspecting a point near
Missoula returned "Hunting District 260 · Region 2". Arizona–Utah view loaded
AZGFD (77) and reported "Utah — Hunt units: not in Fieldline yet"; a point on
the Arizona Strip returned "Unit 12B · Flagstaff" on BLM land. No page errors.

Incident: worker C's shell briefly wrote `docs/coverage.md` in the
coordinator's checkout through a relative .NET path, then reverted it; the
coordinator confirmed the file was byte-identical to HEAD before merging.

**Colorado and Utah (2026-10-14) — verified.** Two workers in parallel
worktrees, adapter kit only (registry, host allowlist and register lines;
no app-shell change). Colorado `cpw-gmu`: CPW's own ArcGIS Online layer, 186
big-game GMUs with herd-unit (DAU) context and area; bighorn sheep and
mountain goat units not included. Utah `udwr-deer-general`: DWR's 2026
general-season buck deer layer, 31 named units ("Deer unit Cache"); elk,
limited-entry and other sets not included, so limited-entry-only areas
(Paunsaugunt, Henry Mtns) show no unit, and the layer URL is per season (move
it to the 2027 layer when DWR publishes it). Both licences: as-is
disclaimers granting nothing, download/redistribution "unknown". The
coordinator re-ran both live tests (CO 186; Leadville → GMU 49, Gunnison →
55; UT 31; Logan → Cache, St. George → Pine Valley), resolved the shared-line
merge conflicts, and fixed unit search for named units (commas, and names
starting with a state code such as "La Sal Mtns" or "Mt Dutton"; the state
reading ranks first, the whole-name match still shows) with tests. Live check
in Chromium against the production build: a Four Corners view lists Arizona
77, Colorado 186, Utah 31 and New Mexico "not in Fieldline yet"; the CO–UT
line loads both; searches "La Sal Mtns", "beaver east", "co 49", "Mt Dutton"
find their units; smoke passes with both mocks; 373 tests.

**CC-03 remaining slices:**
- More jurisdictions (one adapter each) — the coverage register lists 46
  states + DC without a unit source. Colorado and Utah each have more unit
  sets to add (CO sheep/goat; UT elk, limited-entry, pronghorn, others).
- Spatial index for local identify (linear scan today; fine at ~300 units).
- Verified legal-hours rules registry (§7) — not started; UI links agencies.
- Coverage boxes are discovery hints only; "which state am I in" needs real
  boundaries (not needed yet).
- AZ, NE, RI agency URLs: AZ filled in by coordinator confirmation; NE and RI
  still null (bot-check blocked automated verification).
- IDFG license reconfirmation (copyright text changed).

## Requirement-to-packet map

| Spec section | Packet(s) |
| --- | --- |
| §1 A settings, §5 | CC-02 |
| §1 B, §2 P1 national, §6 | CC-03 |
| §1 C, §8 offline | CC-05 |
| §1 D, §7 ownership | CC-02 (unknown states), CC-03 (multi-provider) |
| §1 E/F, §10 | CC-02 (point nullability), CC-08 |
| §1 G legal hours | CC-02 (daylight split), CC-03 (verified rules registry) |
| §1 H unit cache validity | CC-03 |
| §1 I GPS durability, §9 | CC-06 (CC-05 checkpoint API) |
| §1 J large files | Extracted incrementally by each packet |
| §1 K parcels / sync | CC-03 adapters; sync is P3, later |
| §11 clouds | CC-09, CC-10 |
| §12 extra features | CC-11 (A–D, F, G), CC-03 (E), CC-08 (wind), CC-07 (K) |
| §13 cost / terms | CC-00 register; ADR-006; CC-07 |
| §14 testing / security | Every packet; CC-12, CC-13 |
| §17, MAP-01..06 | CC-04 |
| §18, SCOUT-01..06, DATA-01/02, FIELD-01 | CC-11, CC-05 |
| §20 REL-01 / REL-08 | CC-13 |
| §20 REL-02 / REL-03 | CC-01 |
| §20 REL-04 / 05 / 09 / 10 | CC-07, CC-03 |
| §20 REL-06 / REL-07 | CC-06 |

## Blockers and external decisions

1. **Esri imagery (ADR-006)** — resolved for offline: Esri is live only and
   offline imagery comes from USGS (2026-10-14, verified in headless
   Chromium: 0 Esri tiles stored, old ones purged, saves store USGS imagery).
   Still open: licensing of keyless live Esri use.
2. **Open-Meteo commercial terms** — fine for a free, ad-free app. ADR-007
   proposes NWS gridpoints as the primary US source in CC-08.
3. **Required attributions missing** (Open-Meteo link, Copernicus, USGS
   credit line, Terrain Tiles per-source credits) — Esri fixed; rest in
   CC-04/CC-07.
4. **Nominatim remote kill switch** — OSMF policy requires one; needs a small
   remotely served config or a self-hosted geocoder. CC-07.
5. **Physical phone devices** — targets set (iPhone 13+, Google Pixel); the
   Pixel model and the locked-screen requirement are still open (REL-03).
6. **Data maintainers** — every provider is "unassigned" (REL-04).

## Next runnable work

1. CC-04 wave 2 (MAP-03 signature styles, contours/land cover, MAP-04
   comparison, MAP-06 inspection) — MapCanvas is free again.

**Offline maps (coordinator, 2026-10-14) — verified.** `src/features/offline/`:
Layers → Offline maps plans the map view (layers preselected from the map,
map zoom range, per-layer files and size, exclusions with reasons, provider
violations), downloads with progress and pause/resume, lists downloaded areas
(state, size, expiry, errors; show on map, resume, update, check, repair,
drop update, delete); the spot card shows "Offline here" (FIELD-01); area
outlines on the map. Found while verifying: MapLibre requests 256-pixel
raster/terrain tiles one zoom deeper than the map zoom, so packages are now
planned in map zooms (`zoomBasis: "map"`), and offline tiles past a
package's top zoom are enlarged from a packaged ancestor instead of going
blank. Desktop sends OpenFreeMap an identifying User-Agent.
Independent CC-12 review of the screens: 0 blockers, 1 major, 8 minor, all
fixed. The major: with 3D terrain on, MapLibre asks for terrain tiles at the
map zoom (512-px, plus parent and a zoom-5 ancestor), not one deeper, so 3D
terrain went flat offline at the downloaded zoom; terrain is now planned for
both consumers. Minors: list re-read on open/foreground; packages still
served if the startup read fails; "Update not finished" instead of a stuck
"Updating"; a new download holds the slot while its area is created; no
enlarging over HTTP errors or cancelled requests; coverage text keeps zoom
gaps and names out-of-date areas; row labels follow the running operation
and Pause hides while files are checked; 44 px targets, quieter live
progress, focus into the delete confirmation. Also: default zooms start two
levels out (cheap; covers zooming out and tilted 3D distance); the legacy
one-zoom save had the same raster zoom off-by-one.
Evidence: 19 controller/model tests + style-layer and desktop policy tests
(331 + 16 desktop; the slot race test fails on the old controller);
`scripts/offline-ui-check.mjs` against the production build in Chromium with
USGS imagery and 3D terrain on: download with pause and resume, reload with
every tile host blocked → no tile the package holds reached the network
(checked against its stored tile ranges); zoom past the package
(screenshot-checked only), "Offline here", outline, delete;
`offline-browser-check.mjs` and `storage-browser-check.mjs` pass.
Gaps: the area is always the map view (no drawing); a tilted 3D view's far
distance and edges need the package's lower zooms; the desktop User-Agent is
unit-tested but not run in a packaged build (the Electron binary isn't
installed here); checking files shows no progress; enlarged tiles are soft.

**Storage wiring (coordinator, 2026-10-14) — verified.** `content-sync.ts`
(ADR-008): repository is the store of record after a verified migration;
changes mirrored in order; Recently deleted with restore / delete forever;
recordings checkpointed per fix, recovered after reload (banner: save or
discard), saved with `segmentStarts`; tracks drawn, measured and exported to
GPX per segment; Settings → Backup and restore (plan shown before restore).
ADR-009: transient GPS errors no longer end a recording. Evidence: 8
content-sync tests + 4 track-segment tests (275 total); real-browser
acceptance in Chromium against the production build — existing mark
migrated, new mark persisted across reload with `fieldline-v1` content
frozen, delete → restore, recording through simulated GPS outages recovered
after a mid-recording reload (6 points), full backup restored into a fresh
profile; smoke + desktop tests pass. Gaps: the live recording line still
draws straight across an outage until the track is saved; no cross-tab
change sync; old-build edits after upgrade are reported, not merged.
2. CC-01 PWA recording prototype behind the proposed `LocationSource`
   interface (isolated files).
3. More CC-03 jurisdiction adapters (each is an independent worker task).
3. CC-08 (when reached): implement ADR-007 NWS gridpoint primary source.
