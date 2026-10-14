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
| CC-03 Nationwide catalog | verified (first slices); see CC-03 detail | AZ/ID mode removed; catalog contracts, three unit adapters (AZ, ID, MT), protected unit store, 51-entry coverage register, discovery, nationwide unit search, shell integration. Remaining slices listed below. |
| CC-04 Map design | not started | MAP-01..06. Default public-land opacity change waits for the before/after gallery. |
| CC-05 Storage and offline | not started | ADR-006 done: tile storage restricted to `OFFLINE_TEMPLATES`; USGS imagery base map added. |
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

**CC-03 remaining slices:**
- More jurisdictions (one adapter each) — the coverage register lists 48
  states + DC without a unit source.
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

1. CC-04 map design (MAP-01 named render groups first) and CC-05 storage /
   offline packages can now run in parallel with disjoint ownership.
2. CC-01 PWA recording prototype behind the proposed `LocationSource`
   interface (isolated files).
3. More CC-03 jurisdiction adapters (each is an independent worker task).
3. CC-08 (when reached): implement ADR-007 NWS gridpoint primary source.
