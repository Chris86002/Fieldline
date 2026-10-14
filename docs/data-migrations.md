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
