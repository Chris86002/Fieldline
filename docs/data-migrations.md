# Saved-data formats and migrations

Fieldline stores everything locally in the browser or desktop profile. This
file lists each stored format, its version, and how upgrades and downgrades
behave. Every schema change must update this file and add a fixture test.

## `fieldline-v1` (localStorage) — personal content and legacy preferences

- **Format.** Zustand persist envelope `{ state, version: 0 }`. `state` holds
  `waypoints`, `tracks`, `huntRegion`, `lastKind`, `activeHunt`,
  `introDismissed`, `lastView`, and the legacy preference fields (`basemap`,
  `show*`, `publicOpacity`, `terrain`, `imperial`).
- **Validation.** `persistence.ts` accepts `null` or `version` 0 with array
  `waypoints` and `tracks`. Anything else is left untouched and writes are
  disabled for the session (tested in `store.test.ts`).
- **Since settings v1 (2026-10-13).** The legacy preference fields are no
  longer written by the app; they are preserved byte-for-byte as the settings
  migration source and for older builds. Content writes keep `version: 0`.
- **Planned.** CC-05 moves growing content (tracks, attachments) to IndexedDB
  with transactional migration that keeps this key until the new store is
  committed and verified.

## `fieldline-settings` (localStorage) — preferences, version 1

- **Format.** `{ version: 1, state: { prefs, preset, presetEdits } }`.
  `prefs` is a complete `AppSettings` object; `preset` is `null`, `"field"` or
  `"scouting"`; `presetEdits` holds the user's changes to each preset.
- **First run.** When the key is absent, preferences are built from
  `fieldline-v1`: map and layer choices carry over; the single `imperial`
  switch sets every unit family (distance, elevation, area, speed,
  temperature, pressure) the same way. Nothing is written until the user
  changes a setting.
- **Invalid values.** Each field is validated on load; an invalid field falls
  back to its default and the user sees which ones.
- **Corrupt value.** Left untouched; preferences come from the legacy
  migration for the session; settings writes are disabled.
- **Newer version.** Read best-effort, never overwritten, warning shown.
- **Export file.** `{ format: "fieldline-settings", version, exportedAt,
  prefs, preset, presetEdits }`. Contains no credentials or personal content.
  Imports from a newer version are refused.

## Other caches (replaceable provider data, not personal content)

- Cache Storage `fieldline-tiles-v1` — viewed and pre-fetched map tiles
  (`tiles.ts`), limited to `OFFLINE_TEMPLATES` since 2026-10-14. On startup,
  tiles from other sources (Esri imagery stored by older builds) are deleted;
  this is replaceable provider data, not personal content (ADR-006).
- Settings v1 gained the `basemap` value `"usgs"` on 2026-10-14. No version
  bump: older builds never read `fieldline-settings`.
- Cache Storage `fieldline-units-v2` / `fieldline-units-id-v1` — Arizona and
  Idaho unit GeoJSON (`units.ts`).
- `fieldline-install-dismissed` (localStorage) — install banner flag.

## Upgrade and downgrade paths verified

| From | To | Result | Evidence |
| --- | --- | --- | --- |
| fieldline-v1 profile with metric units, topo map, one mark | settings v1 build | Units, basemap and opacity carried over; mark intact; `fieldline-v1` unchanged | `settings.test.ts` "migrates from fieldline-v1…"; manual browser check 2026-10-13 |
| settings v1 profile | older 1.0.0 build | Older build reads `fieldline-v1` only, with its frozen legacy preferences | By construction; not run against the packaged 1.0.0 binary |
| settings from a future version | settings v1 build | Read-only, warning shown | `settings.test.ts` "does not overwrite corrupt or newer settings" |

## `fieldline-content` (IndexedDB) — personal content, schema 1 (CC-05 wave 1, library only)

Built and tested in `src/lib/storage/` but **not yet used by the app**; until
the coordinator wires it in, `fieldline-v1` remains the store of record. Full
design in [storage.md](storage.md).

- **Layout.** IndexedDB database `fieldline-content`, version 1, object stores
  `waypoints`, `tracks`, `trash`, `sessions`, `chunks`, `meta` (string keys).
  A database with a higher IndexedDB version is never opened
  (`future-version`).
- **Content schema.** `meta/schema` = `{ version: 1, createdAt, lastStep }`,
  written only when a migration completes. Writes require it to exist and be
  ≤ 1; reads work regardless.
- **Records.** Waypoints and tracks as in `fieldline-v1`, copied verbatim
  (unknown and missing optional legacy fields preserved as they were), except
  that a waypoint `kind` the map can't draw becomes `"pin"` (recorded in the
  migration meta). Every write and restore requires a known `kind`, a text
  `name` and in-range coordinates. Recorded tracks
  may add `segmentStarts` and per-point `accuracy`, `altitude`,
  `altitudeAccuracy`, `speed`, `heading` (nullable); older code ignores them.
  Trash entries: `{ id: "kind:itemId:deletedAt", kind, itemId, deletedAt, item }`.
- **Migration v0 → v1.** Validate `fieldline-v1` (envelope version 0, array
  content, valid records, unique ids) → one transaction copies all waypoints
  and tracks → read-back compares counts, ids and every record → a final
  transaction writes `meta/migration:v0-v1` (counts, SHA-256 of the source
  and of its `{ waypoints, tracks }`, kind mappings) and `meta/schema`.
  `fieldline-v1` is only read, never written. Corrupt, newer-version or
  invalid sources stop with a status and nothing written; an interrupted run
  is unmarked and re-copies on the next start; a completed run is never
  repeated, but if `fieldline-v1` content later differs from what was copied
  the result is `legacy-changed-after-migration` (reported, not merged).
- **Backups.** `fieldline-backup` version 1 JSON (settings export, waypoints,
  tracks, trash, SHA-256 integrity). Newer backup versions or content schemas
  are refused.

| From | To | Result | Evidence |
| --- | --- | --- | --- |
| fieldline-v1 profile (marks with winds/notes, a 1.0.0-shape mark without `goodWinds`, 1,500-point track) | content schema 1 | Identical records; `fieldline-v1` byte-identical; second run no-op | `migrations.test.ts`; `scripts/storage-browser-check.mjs` in Chromium (migrate → reload → read back) |
| Interrupted copy / interrupted completion | retry | Nothing marked; retry copies the current source | `migrations.test.ts` |
| Corrupt or newer `fieldline-v1`, invalid records | content schema 1 | Refused, nothing written | `migrations.test.ts` |
| `fieldline-v1` mark with an unknown or missing `kind` | content schema 1 | Imported as `pin`, mapping recorded | `migrations.test.ts` |
| `fieldline-v1` content edited after migration | this build | `legacy-changed-after-migration`, nothing merged | `migrations.test.ts` |
| Content schema or IndexedDB version from a newer build | this build | Refused, left untouched | `migrations.test.ts`; browser check (`future-version`) |
| Backup v1 | clean or populated profile | All-or-nothing; identical records skipped; conflicts abort or keep existing | `backup.test.ts`; browser check restore |

### IndexedDB layout version 2 (CC-05 wave 2, offline packages)

- **Change.** `IDB_VERSION` 1 → 2. Upgrade step 2 only adds the object stores
  `packages`, `packageAssets`, `assets`, `assetData` (replaceable provider
  data). Content stores and the content schema (`meta/schema` = 1) are
  untouched; step 1 now names its own six stores, so a fresh database is
  built by replaying 1 then 2.
- **Package records.** `PackageRecord` with manifest summaries carrying
  `schemaVersion: 1` (`PACKAGE_SCHEMA_VERSION`). A record from a newer
  package schema is not served, and writes to it fail with `future-version`.
  Packages don't require the content migration to have run.
- **Downgrade.** A build with `IDB_VERSION = 1` refuses a version-2 database
  (`future-version`) and keeps using `fieldline-v1` (wave 1 behavior). The
  library isn't wired into the app yet, so no shipped build is affected; once
  it is, rolling back past this layout means content stays in the newer
  database until the user updates again.
- **Clearing.** The four offline stores are replaceable and clear together;
  personal stores are never cleared as cache.

| From | To | Result | Evidence |
| --- | --- | --- | --- |
| Layout 1 database (content only) | layout 2 | Offline stores added, content untouched | `backend.test.ts` "IndexedDB layout upgrades"; browser check opens a fresh database at version 2 |
| Layout 2 database | layout-1 build | Refused (`future-version`), left untouched | By construction (`openIndexedDbBackend` version check, wave-1 tests) |