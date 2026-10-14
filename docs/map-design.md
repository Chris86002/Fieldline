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

Three families today: **imagery** (Hybrid, Satellite, USGS imagery), **topo**
(USGS scan), **street**. Each defines land, water, vegetation, park,
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
`FIELDLINE_GALLERY_BASEMAPS` (default hybrid,topo). Other variables:
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

## Not done in this wave

- MAP-03 signature styles (Terrain, Satellite, Field), vector contours,
  supported land-cover classes, night/high-contrast.
- MAP-04 imagery comparison; MAP-06 recipes, clean mode, inspection
  highlights (the `inspection` group and `selected` token are ready for it).
- Text size and marker size settings, relief strength / contour intensity
  settings, marker clustering (rest of MAP-05).
- An automated visual comparison; the gallery is manual.
