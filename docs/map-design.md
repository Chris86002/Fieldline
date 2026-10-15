# Map design

Packet CC-04, wave 1: MAP-01 (named render groups and tokens), MAP-02 (default
visual cleanup), the label/symbol-hierarchy part of MAP-05, and the fixed-view
gallery. Spec: [§17 and §19](Fieldline-AI-Master-Implementation-Document.txt).
Baseline: `678caf7`.

## Structure

| Module | Role |
| --- | --- |
| `src/features/map/layer-groups.ts` | The nine render groups and `orderLayers()`, which flattens them in order and rejects duplicate ids. `firstLayerAbove()` gives the `beforeId` for re-adding a layer at runtime. |
| `src/features/map/style-layers.ts` | Every map layer, built by group from style options (`mapLayerGroups`, `buildLayers`), plus the id lists MapCanvas toggles. Pure; tested in Node. |
| `src/features/map/tokens.ts` | Design tokens per style family, boundary-strength weights, and `reliefPaint()` for the hillshade. |
| `src/features/map/labels.ts` | Label priority order and label-density rules. |
| `src/components/hunt/MapCanvas.tsx` | Sources and attribution (unchanged strings), map lifecycle, and effects. It no longer contains layer definitions or color constants. |

### Render groups (bottom to top)

1. **base** — `land`, `satellite`, `usgs`, `topo`, `vx-water`, `vx-wood`, `vx-park`
2. **relief** — `hillshade`
3. **thematic** — `sma` (public land)
4. **detail** — `vx-creek-line`, `vx-local-casing`, `vx-local`, `vx-track-casing`, `vx-track`, `vx-highway-casing`, `vx-highway`, `vx-freeway-casing`, `vx-freeway`
5. **boundaries** — `units-casing`, `units-line`, `border-casing`, `border-line`
6. **labels** (low → high priority) — `vx-road-minor`, `vx-road-major`, `vx-shield`, `vx-place-small`, `vx-creek`, `vx-peak`, `vx-place-town`, `vx-place-city`, `unit-labels`
7. **personal** — `tracks-casing`, `tracks`, `live-casing`, `live`
8. **navigation** — `rings`, `sun-casing`, `sun-line`, `sun-label`, `accuracy`, `accuracy-line`, `measure-fill`, `measure-casing`, `measure`, `measure-pts`
9. **inspection** — empty; reserved for selection highlights (MAP-06)

Marks and the GPS dot are HTML markers and always sit above the canvas.

Every pre-existing layer id is kept. One layer was added: `vx-track-casing`.
The positional `overlay.slice(0, 3)`, `slice(3, 11)` and `slice(11)` are gone.
A test inserts and removes a layer at every position of every group and checks
that all other layers keep their relative order.

Draw-order changes against the baseline (intentional, per spec order):

- Hillshade moved **below** public land (it used to darken the agency colors).
- Road, place, peak and creek labels moved from the very top of the stack to
  below tracks, measure lines and sun lines.
- GPS accuracy and range rings now draw above saved tracks.
- Trails draw above local roads and below highways (were below all roads).

### Repainting

`applyStylePaint()` repaints every layer's paint from the same builder that
made the style when the base map, boundary strength or public-land opacity
changes. There is no hand-maintained repaint list to drift out of sync. The
hillshade is excluded and owned by the sun-shade effect (`reliefPaint`).
Toggling a layer or moving the opacity slider never rebuilds the style.

## Tokens

Wave 1 had three families: **imagery** (Hybrid, Satellite, USGS imagery), **topo**
(USGS scan), **street** (MAP-03 replaced street with terrain and field; see below). Each defines land, water, vegetation, park,
waterway, freeway/highway/minor roads (line, casing, opacities), trail, unit
and state lines, label text/halo, unit-label text/halo, selected, warning,
recorded/live routes, navigation colors and relief strength. `selected` and
`warning` are defined but not yet drawn by any layer (inspection highlights
and closure overlays come later). Personal and navigation colors are identical
in every family.

## MAP-02 changes

| Area | Before | After |
| --- | --- | --- |
| Public land default | 0.62 | **0.25** for new profiles (see evidence and the known issue below) |
| Unit lines (imagery) | casing #141910 @ 0.75, 2.6–6.5 px; line @ 0.96 | casing @ 0.40, 2.2–4.8 px; line @ 0.85, 1.0–2.4 px |
| State lines (imagery) | casing @ 0.90, 3.4–7 px; white line 1.6–3.5 px | casing @ 0.45, 2.6–5.4 px; line @ 0.90, 1.2–2.7 px |
| Unit/state lines on Topo and Street | white line, black casing | dark purple unit lines / near-black state lines with a light edge |
| Roads (imagery) | bright orange/yellow, heavy black casings | same hues (Layers hint still true), ~20 % narrower, line 0.85, casings 0.45–0.5 |
| Trails/tracks | thin dashed pale line, no casing, under roads | brighter dashed line with a dark casing, above local roads; sidewalks/footways stay faint and uncased |
| Unit labels | `text-allow-overlap` + `text-ignore-placement`, size 13 | collision-managed, top label priority, 11.5 → 15 px by zoom |
| Place/peak labels | no priority | `symbol-sort-key` by OpenMapTiles `rank`; layer order sets cross-layer priority |
| Hillshade | one strength everywhere, shadow 0.82 | imagery ×0.55 strength, shadow 0.5; topo ×0.8; street ×1.0, shadow 0.75; night shadow ≤ 0.4 |

**Boundary strength** "Strong" reproduces the old imagery line weights within
a few percent (tested); colors on Topo/Street stay the new ones.

### Settings added (Map and display)

- `boundaryStrength`: subtle / standard / strong, default standard. Scales unit
  and state line widths and opacities.
- `labelDensity`: fewer / standard / more, default standard. Shifts the first
  zoom of town, small-place, peak, creek and road labels by ±1, scales
  collision padding and line-label spacing. City names and unit numbers are
  not reduced.

Older saved settings load without warnings and get the defaults.

### Public-land opacity evidence

Trials on the baseline build (hybrid, desktop; `screenshots/gallery/before-opacity-*`)
and on the new build (`after-opacity-*`, hybrid + topo):

- 0.62 (old): the Flagstaff state-trust/USFS checkerboard and all of Four
  Peaks and the Brooks Range are tinted so strongly that imagery texture is
  lost; with hillshade above it, colors turned muddy.
- 0.15: imagery is clean but the checkerboard is barely visible and the
  blue (state trust) vs. green (USFS) hue is not distinguishable.
- 0.20: checkerboard visible; hue difference only on close inspection.
- **0.25**: checkerboard and the blue/green hue difference are readable on
  imagery, private parcels in the Sawtooth valley read as untinted, and the
  imagery stays legible. On Topo the state-trust blocks remain visible.
- 0.35: hue clear, but imagery starts to wash out again.

0.25 was chosen. Central Pennsylvania has no BLM SMA polygons in view, so it
gave no evidence either way.

### Known issue: new profiles fall back to 0.62 after a reload

Verified in headless Chromium against this build: a brand-new profile shows
0.25, but `useHunt` (`src/lib/hunt/store.ts`) still persists its own legacy
`publicOpacity: 0.62` into `fieldline-v1` on the first map move, and while no
`fieldline-settings` copy exists, `loadSettings()` re-migrates from
`fieldline-v1` on every load. After a reload the slider shows 0.62. Saved and
migrated profiles behave correctly. The fix is outside this packet's files:
persist the migrated settings once when `fieldline-settings` is absent
(`src/features/settings/store.ts`), or change the legacy default in
`src/lib/hunt/store.ts`.

## Gallery

`scripts/map-gallery.mjs` (manual visual tool, live tiles):

```powershell
npm run build; $env:PORT='3100'; npm run start   # in another shell
$env:FIELDLINE_URL='http://127.0.0.1:3100'; $env:FIELDLINE_GALLERY_LABEL='after'
node scripts/map-gallery.mjs
```

Views: Four Peaks AZ (desert), Sawtooths ID (forested mountains), Penns Valley
PA (eastern rural), Flagstaff AZ (town), Brooks Range AK, Mauna Kea HI; two
zooms each; desktop 1280×800 and narrow 390×844; base maps from
`FIELDLINE_GALLERY_BASEMAPS` (wave 1 default hybrid,topo; since MAP-03
terrain,satellite,field,topo). Other variables:
`FIELDLINE_GALLERY_VIEWS`, `FIELDLINE_GALLERY_VIEWPORTS`, `FIELDLINE_GALLERY_PREFS`
(JSON merged into settings, e.g. `{"publicOpacity":0.2}`), `FIELDLINE_GALLERY_DIR`,
`FIELDLINE_GALLERY_SETTLE_MS`. Each shot seeds one mark and one short track
near the center and fixes the clock at about 10:00 local solar time.
Output goes to `screenshots/gallery/<label>/` (gitignored) with a
`manifest.json`. The fixed clock makes React report hydration error #418
(the server rendered a different time); it is expected and harmless for the
gallery.

### Before/after observations (hybrid, topo, street, satellite; 96 shots each)

Better:
- Imagery reads through: relief no longer turns sunlit slopes cream and shaded
  slopes black (Four Peaks z13.5, Sawtooths, Brooks Range); public land no
  longer hides the ground.
- Unit lines on Topo are dark purple and stand out from the scan's own black
  and gray linework; the old white-on-black lines looked like roads.
- Trails at z13+ are visible on imagery (Four Peaks, Sawtooths).
- Flagstaff z12: the city name now places; before, the neighborhood label
  "Cherry Hill" took its spot (cities now outrank small places).

Worse or unchanged:
- With weaker relief on imagery, gentle terrain at low zoom has less depth
  (Penns Valley ridges, Four Peaks z10.5). Users who liked the strong shading
  have no relief-strength setting yet.
- At 0.25, telling agencies apart on imagery needs a closer look; the Layers
  slider still goes to 0.9.
- Freeway/highway casings are thinner, so major roads are slightly harder to
  pick out over bright desert imagery.
- Unit numbers can now be hidden by collisions with each other where units
  are small at low zoom (by design; they were overlapping before).
- Street style is nearly unchanged apart from boundary colors and trail color.
- A dark rectangular artifact near Sister Peak (Four Peaks z13.5) appears in
  both before and after; not caused by styling.

## Not done in wave 1

- MAP-03 signature styles, contours, land cover: done in wave 2 (below).
- MAP-04 imagery comparison; MAP-06 recipes, clean mode, inspection
  highlights (the `inspection` group and `selected` token are ready for it).
- Text size and marker size settings, relief strength setting, marker
  clustering (rest of MAP-05).
- An automated visual comparison; the gallery is manual.

# Wave 2: MAP-03 three complete styles

Packet CC-04 wave 2, slice MAP-03. Base: `feature/cc04-cc05` at `60b40ad`.

## Styles and base maps

Evidence from the code before this change: **Hybrid and Satellite drew
exactly the same thing** (Esri imagery with every vector overlay; the only
difference was the name, since before wave 1), and **Street** was a plain
vector map (land color, water, wood, park) with the same overlays.

| Style | Base (`basemap` value) | Draws | Offline |
| --- | --- | --- | --- |
| **Terrain** (default for new profiles) | `terrain` | natural-earth land color, restrained elevation tint (`terrain-tint`, MapLibre `color-relief` on the DEM), OSM land cover, water, sun-direction relief, contours with index labels, blue waterways, dark-red trails, muted public land | yes: OpenFreeMap + terrain (+ BLM SMA) |
| | `topo` (reference) | the USGS topo scan, as before; no vector roads, names or contours over it (the scan has its own) | yes: USGS topo |
| **Satellite** | `satellite` | Esri imagery and the wave-1 imagery overlays, unchanged; contours only if "Contours on satellite" is on (pale lines) | live only (ADR-006, plain HTTPS) |
| | `usgs` | USGS imagery, same overlays | yes: USGS imagery |
| **Field** | `field` | high contrast: pale land, fewer land-cover distinctions (no parks, no tint), white roads with gray edges, dark-red trails, black names 15 % larger, quiet contours, gentle relief; 2D-friendly (nothing in it needs 3D) | yes: OpenFreeMap + terrain |

The Layers panel shows Terrain / Satellite / Field, then the base inside
the style (Terrain: Fieldline or USGS topo; Satellite: Esri or USGS), a
one-line note on the base (linked to both pickers with `aria-describedby`),
and Contours and Land cover switches. The two pickers are radio groups with
the standard keyboard pattern (one tab stop, arrow keys move and select,
Home/End; `RadioRow`, `radio-keys.ts`) and 44-px targets. If the contour
chunk fails to load, the map starts without contours instead of failing. Settings
lists all five as "Map style".

**Saved settings** (`BASEMAP_ALIASES`, docs/data-migrations.md):
`hybrid` → `satellite` (same picture), `street` → `terrain` (its successor;
the look changes: land cover, contours, tint). Aliases apply everywhere a
setting is parsed (saved prefs, Scouting preset edits, imports, the
`fieldline-v1` migration) and are not reported as invalid. The Scouting
preset now names `satellite`. The Field preset is unchanged (it does not
switch to the Field style; a product decision, see open questions).

**Defaults that don't surprise existing users:** saved profiles keep their
base map; contours on imagery are a separate switch, off by default, so an
imagery user sees nothing new; Terrain/Field contours and land cover default
on (they are the style). New profiles start on Terrain (spec §17).

## Tokens

Families are now `terrain`, `imagery` (satellite, usgs), `topo` and `field`
(`street` is gone). New per-family tokens: `landcover` (scrub, grass,
wetland, rock, sand, ice, farmland, developed, opacity), `contour` (minor,
index, opacities, label, halo), `textScale` (Field 1.15) and `tint` (Terrain
only). Personal and navigation colors stay identical in every family
(tested).

## Layers added (stable ids)

| Id | Group | Source |
| --- | --- | --- |
| `terrain-tint` | base (after the rasters) | `dem` (`color-relief`) |
| `vx-landcover` | base | `ofm` / `landcover` (`grass` — `scrub`/`heath`/`fell` shown as brush —, `wetland`, `rock`, `sand`, `ice`, `farmland`) |
| `vx-landuse` | base | `ofm` / `landuse` (residential, commercial, industrial, retail, railway, quarry) |
| `contours` | relief (above `hillshade`, below public land) | `contours` |
| `contour-labels` | labels, lowest priority | `contours`, index lines only |

`vx-wood`, `vx-park` and `vx-water` keep their ids; base order is now land,
rasters, tint, land cover, wood, built-up, parks, water (water over wetland
and wood). `PRE_MAP01_IDS` in `style-layers.test.ts` lists the additions.

`styleVisibility()` is the single visibility table: the style is built from
it and MapCanvas applies the same table at runtime (it replaced the
hand-written show/hide list). `styleLayout()` re-applies label sizes on a
style switch (Field's larger names). Nothing rebuilds the style.

## Contours

- **Generator:** `maplibre-contour` 0.1.1 (BSD-3-Clause, onthegomap, no
  dependencies, 10.2 kB gzip as the lazy `contour-source` chunk; pinned
  exactly; 0.1.1 is from 2026-09-17, 0.1.0 from 2024-12). Read: its source
  for `DemSource`, `LocalDemManager`, `HeightTile`; the only network call is
  the default `fetch`, which Fieldline replaces.
- **Fetching:** the library's worker mode fetches with plain `fetch` and
  would bypass offline packages, so Fieldline runs the library's
  `LocalDemManager` on the main thread with a `getTile` that calls the
  `fltile://` handler (`loadTile`): package, then network. Contour tiles are
  512-px vector tiles at the map zoom, each traced from DEM tile z/x/y plus
  its eight neighbors (`DEM_ZOOM_OFFSET` 0), up to tile z15 (z14 DEM split).
  Packages hold terrain from min(5, min − 1) to max + 1, so inside a
  downloaded area the DEM tiles for map zooms up to the package's top zoom
  + 1 are packaged. Deeper than that, offline, `loadTile` enlarges a packaged
  ancestor (up to 4 levels), so contours there are traced from enlarged,
  coarser terrain. Outside the area, a neighbor DEM tile with no packaged
  ancestor fails; that is tolerated only when there is no network (browser
  offline or a fetch `TypeError`) and leaves that tile edge without lines; a
  gapped tile isn't kept in the generator's cache, and coming back online
  re-traces contour tiles. Any other neighbor failure (HTTP error, timeout)
  fails the tile so MapLibre retries, and the tile always fails if its own DEM
  tile does. A failed DEM URL is remembered for 45 s, so adjacent tiles don't
  each ask again. Zooms without contour levels (z9 at Standard, z9–10 at
  Wider) return an empty tile without fetching any DEM. Tests:
  `contour-source.test.ts`.
- **Tried and dropped:** a vector source with `tileSize: 256` (to match the
  hillshade's deeper zoom) makes MapLibre 6.13 silently never finish loading
  the style (reproduced in isolation); a 2×2 mosaic of the deeper DEM tiles
  gave stair-stepped lines on which labels could not sit.
- **Smoothing:** each DEM tile is copied and smoothed (two passes of a
  [1 2 1] kernel, `smoothElevation`, tested) before tracing. Without it
  index labels barely placed (Four Peaks z13.5: 0–2 labels); with it and
  `text-max-angle` 60°: Four Peaks z13.5 8 labels, Sawtooths z12.5 6, Penns
  Valley z14 1 (gentle ground, few index lines). Relief, 3D terrain and
  elevation readouts keep raw DEM values.
- **Intervals** (`contours.ts`, map zoom → minor/index): feet 10 → 500/2500,
  11 → 200/1000, 12 → 100/500, 13 → 40/200, 14+ → 20/100; meters 200/1000,
  100/500, 50/250, 20/100, 10/50. "Contour interval" Wider/Standard/Closer
  shifts the table one zoom. The unit is in the tile URL (multiplier 3.28084
  for feet), so lines fall on whole feet or meters; changing unit or interval
  swaps the source tiles (`setTiles`), not the style.
- **Labels:** index lines only, number without unit as on printed topo maps
  (a unit suffix placed fewer labels: Sawtooths 3 vs 4 before smoothing);
  the Layers line states the unit ("40 ft lines, index every 200 ft at this
  zoom"). Lowest label priority.
- **Settings:** `showContours` (Terrain/Field, on), `showImageryContours`
  (Satellite, off), `contourDetail`, `contourStrength` (0.3–1.6, multiplies
  the style's contour opacity). The Layers switch binds to the key of the
  current style.
- **Offline:** verified with `scripts/offline-contours-check.mjs` (see
  Checks). Contour tiles are made on the device and never stored.

## Land cover

Only OpenMapTiles classes already in OpenFreeMap tiles (no new provider), so
offline packages cover it. Drawn on Terrain and Field only, never over
imagery. Coverage is OpenStreetMap's and uneven: in the gallery Penns Valley
PA has wood, farmland and wetland polygons; the Sawtooths have a glacier, a
wetland and a park polygon in view; Four Peaks has three bare-rock polygons
and no vegetation at all. Unmapped ground keeps the land color (no inferred
classes), and the Layers hint says "where OpenStreetMap maps them". The OSM
data date (OpenFreeMap build in the TileJSON) is not shown yet.

## Performance

`scripts/map-perf.mjs`, Sawtooths ID map zoom 12.5, 1280×800, headless
Chromium with SwiftShader (software WebGL: absolute frame times are much
worse than a real GPU), median of 3 fresh loads, live tiles, same machine and
session. Before = baseline build (`68747c5`), after = this branch.

| Entry | DEM req. | tile req. | last tile (ms) | load long tasks (ms, max) | pan frames > 50 ms | pan frame p95 (ms) | pan long tasks (ms, max) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before hybrid | 36 | 118 | 1583 | 0 | 15 | 50 | 0 |
| before street | 36 | 82 | 1646 | 0 | 15 | 50 | 0 |
| before topo | 0 | 80 | 2426 | 0 | 0 | 16.8 | 0 |
| after satellite | 36 | 118 | 1968 | 0 | 23 | 50.1 | 0 |
| after terrain | 56 | 102 | 1920 | 59 (59) | 50 | 83.4 | 103 (53) |
| after terrain, contours + land cover off | 36 | 82 | 1818 | 0 | 24 | 50.1 | 55 (55) |
| after field | 56 | 102 | 1982 | 175 (72) | 34 | 66.7 | 161 (56) |
| after topo | 0 | 80 | 2337 | 0 | 0 | 16.8 | 0 |
| after satellite + contours | 56 | 138 | 2049 | 113 (63) | 40 | 66.7 | 152 (73) |

Measured before the final Terrain relief and sidewalk opacity tweaks (paint
values only; no layers or requests changed). Reading: contours cost 20 extra DEM requests at this view (the hillshade's
tiles are one zoom deeper, so they don't overlap) and main-thread long tasks
of 50–75 ms while tiles are traced, which shows up as more slow frames while
panning into new ground (6 s window: ~50 vs ~24 frames over 50 ms on
Terrain). Satellite with contours off and the topo scan are unchanged within
noise. Terrain without contours and land cover is close to the old Street.
Mitigations if this matters on phones: move tracing to a worker that asks
the main thread for DEM bytes (keeps `fltile://`), or trace at a coarser
DEM zoom on small screens. Not done here.

## Gallery (MAP-03)

Same six views, two zooms, desktop and narrow (`scripts/map-gallery.mjs`,
which now takes `terrain,satellite,field,topo` by default and per-entry
settings such as `satellite:showImageryContours=true`). Before:
`screenshots/gallery/before-map03/` (baseline build, hybrid/topo/street, 72
shots). After: `after-map03/` (terrain/satellite/field/topo, 96 shots, plus
24 desktop shots of satellite with contours and terrain without land cover)
and `after-map03-final/` (terrain and field after the relief and sidewalk
tweaks below, 48 shots). Screenshots are gitignored. Every shot's only page
error is the expected hydration #418 from the fixed clock.

Better:
- Terrain reads as a landscape without imagery: contours with index labels
  (Sawtooths z13.5: 7000–8600 ft labels along the lines; Four Peaks; Penns
  Valley ridges 1100–1200 ft), blue lakes and creeks, the elevation tint
  separates the Penns Valley floor from the ridges, wood polygons in PA.
  Old Street at the same views was a flat green-gray with heavy shadows and
  no water fill at the Sawtooth lakes.
- Field is the most legible on a phone: pale land, black names 15 % larger,
  white roads with gray edges, dark-red trails, contours quiet but readable
  (Four Peaks narrow, Sawtooths).
- Satellite and the USGS topo scan look as before (contours off on imagery
  by default; the topo scan gets no vector duplicates).
- Contours over imagery (opt-in) are readable as pale lines; in steep
  terrain (Sawtooths z13.5) they are dense enough to compete with the
  imagery, so they stay off by default and have a strength slider.

Worse or unresolved:
- Terrain relief at Street's strength (1.0, shadow 0.75) made the PA ridges
  and shaded Sawtooth and Brooks Range slopes nearly black and hid contours
  in shadow; lowered to 0.85 / 0.55 for the final set (still the strongest
  relief of the styles; the imagery family keeps 0.55 / 0.5).
- Sidewalks in Flagstaff z15 (OpenMapTiles `path` subclasses) drew as a dense
  dark-red dotted grid on the light styles; halved again (0.3 of the trail
  opacity) on Terrain and Field.
- Land cover is thin where OSM is thin: Four Peaks shows only bare rock, the
  Sawtooths one glacier and one wetland; most of the West looks like the
  plain land color plus tint. Honest, but less "atlas" than the spec's
  picture until a nationwide land-cover source is chosen (needs a source
  decision; NLCD would be a new provider).
- Brooks Range (AK): BLM public-land tint at 0.25 is a strong yellow block
  over the pale Terrain land; on imagery it was subtler. Public-land
  strength per style is a possible follow-up.
- Contour labels are sparse in very rugged or very gentle ground (curving or
  few index lines), by design of collision and angle limits.
- The phone attribution line wraps to three rows on Terrain because of the
  number of sources (now de-duplicated: contours share the terrain credit).

## Checks run (MAP-03)

- `npm test` (352 pass; new: `contours.test.ts`, style-layer tests for the
  styles, land cover, visibility table, label sizes and contour layers,
  settings aliases/defaults/persistence, offline default layers),
  `npm run typecheck`, `npm run lint`, `npm run build`.
- `npm run smoke` against the production build: passed (desktop and mobile).
- `node scripts/offline-contours-check.mjs`: passed. Terrain is the default
  with Contours and Land cover on; the plan preselects public land,
  OpenFreeMap and terrain (no raster base, nothing live-only); after the
  download every tile host and `/api/dem` is blocked and the page reloaded:
  no packaged tile reached the network, and turning contours off changed
  5.3 % of the map's pixels. The only terrain requests that went out were the
  16 neighbor tiles around the packaged 3×3 block (contour tile edges).
- After the CC-12 review fixes (merged with `feature/cc04-cc05` b2b0c32):
  `npm test` 408 pass (new `contour-source.test.ts`: neighbor failures
  tolerated only without network, own-DEM failure, abort re-throw, `fltile://`
  fetching, no-levels short-circuit, 45 s failed-tile memory, gapped tiles not
  cached; `radio-keys.test.ts`), typecheck, lint, build, smoke.
  `offline-contours-check` now also zooms two levels past the package on
  Field with sun shade off: 25 terrain requests for 25 tiles, none repeated
  (the review's 38 for 29 came from the elevation tint and hillshade, which
  request the same URLs as a separate MapLibre source). Probe at map zoom 9.5
  on Terrain: no z9 terrain requests (contours have no levels there); the
  Layers pickers keep one tab stop, arrows move and select, buttons are 44 px.
- `node scripts/offline-ui-check.mjs` (updated for the style picker):
  passed.
- Real-browser probes (headless Chromium, production build): contour
  features present with whole-foot `ele` values (6700, 6800 … with index
  lines at multiples of 500 ft at z12.5) and the unit-dependent tile URL;
  land-cover classes per view as listed above.

## Known gaps and open questions

- Night mode and high contrast beyond the Field style (spec: night preserves
  categories) are not done.
- Contour tracing is on the main thread (see Performance).
- The contour generator and MapLibre's `dem` source (hillshade, elevation
  tint, 3D terrain) fetch terrain separately, so a tile both use is fetched
  twice when the browser cache can't answer (offline past a package: each
  tries the network once, then enlarges a packaged ancestor). Sharing them
  would need maplibre-contour's shared-DEM protocol on the `dem` source.
- Downgrade: a pre-MAP-03 development build reading settings v1 falls back
  to its defaults for the new values (docs/data-migrations.md).
- Unused: the library bundles a blob worker URL Fieldline never starts.
- Land-cover provenance date is not shown; land cover is only as good as
  OSM mapping in the area.
- Field preset does not switch to the Field style; Field style does not turn
  off 3D or relief by itself (the preset does). Product owner may want the
  Field preset to select the Field style.
- New profiles start on Terrain (spec). If the owner prefers imagery first,
  change `DEFAULT_SETTINGS.basemap`; saved profiles are unaffected either way.
- Contour lines from a 10–30 m DEM are approximate; fine intervals in flat
  ground show model noise (the help text says so).
