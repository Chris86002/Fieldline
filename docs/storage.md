# Durable storage (CC-05 wave 1)

`src/lib/storage/` moves personal content (waypoints, tracks, trash,
active-recording checkpoints) off the single `fieldline-v1` localStorage blob
into a transactional repository, and provides complete backups. Wave 1 is a
tested library; the app does not use it yet (see "Wiring it in" below).
Settings stay in `fieldline-settings` (ADR-001) and are carried by backups.

## Modules

| File | Purpose |
| --- | --- |
| `backend.ts` | `StorageBackend` contract, `StorageError` codes, store lists, `MemoryBackend` |
| `indexeddb.ts` | IndexedDB backend, `requestPersistentStorage()`, `estimateStorage()` |
| `records.ts` | Record types (`StoredTrack`, `TrashEntry`), the one validator used everywhere, canonical JSON |
| `repository.ts` | `ContentRepository`: waypoints, tracks, trash; schema readiness guard |
| `migrations.ts` | Ordered migration steps; v0→v1 from `fieldline-v1` |
| `checkpoints.ts` | `TrackCheckpointStore` for recording (CC-06) |
| `backup.ts` | `fieldline-backup` export, validation and restore |
| `digest.ts` | SHA-256 (WebCrypto, with a pure-JS fallback for insecure http contexts) |
| `open.ts` | `openContentStorage()`: open IndexedDB, fall back, run migrations |
| `test-fixtures.ts` | Synthetic test records only; never imported by app code |

## Backend and stores

IndexedDB database `fieldline-content`, IndexedDB version 1. Object stores
(out-of-line string keys):

| Store | Key | Value | Class |
| --- | --- | --- | --- |
| `waypoints` | waypoint id | `Waypoint` | personal |
| `tracks` | track id | `StoredTrack` (`Track` + optional `segmentStarts`, per-point accuracy/altitude/speed/heading) | personal |
| `trash` | `${kind}:${itemId}:${deletedAt}` | `TrashEntry` | personal |
| `sessions` | session id | `RecordingSession` | personal |
| `chunks` | `${sessionId}:${seq, 8 digits}` | `FixChunk` | personal |
| `meta` | `schema`, `migration:v0-v1` | schema and migration records | bookkeeping |

`REPLACEABLE_STORES` is empty in schema 1. Offline package caches (wave 2)
will be added there; cache clearing (`clearReplaceableData()`) only ever
touches that list, so it can never empty the trash or delete content.

Transactions (`backend.read/write(stores, fn)`) are atomic across stores:
all writes commit or none do. `write` resolves only after commit, with strict
durability requested in IndexedDB. Inside a callback, await only that
transaction's operations (IndexedDB auto-commits otherwise); hashing and
other slow work happens before or after.

Failures are typed `StorageError`s, never reported as success:
`quota`, `unavailable`, `aborted`, `future-version`, `not-ready`,
`conflict`, `invalid`, `not-found`.

`MemoryBackend` has the same semantics (serialized transactions, staged
commits, structured clones) plus test hooks (`faults.onOp`,
`faults.beforeCommit`, `quotaBytes`). It is also the explicit non-durable
fallback when IndexedDB can't be opened (`openContentStorage` returns
`durable: false` and a warning).

## Schema versions

Two independent versions:

- **IndexedDB version** (`IDB_VERSION = 1`) — object-store layout. Upgrades
  are ordered functions in `UPGRADES`. A database with a higher version is
  never opened: `future-version`.
- **Content schema** (`CONTENT_SCHEMA_VERSION = 1`, `meta/schema`) — record
  formats. Absent until the first migration completes. Every repository and
  checkpoint write checks it inside its transaction: no schema → `not-ready`;
  newer → `future-version`. Reads still work for diagnosis and export.

## Migrations

`runMigrations({ backend, legacy, now })` runs ordered, idempotent steps
(`MIGRATIONS`) from the stored schema up to `CONTENT_SCHEMA_VERSION`. Call
it on every start; a current repository is a no-op (`already-complete`).

**v0 → v1 (copy from `fieldline-v1`):**

1. Read `fieldline-v1` with `getItem` only. It is never written, renamed or
   removed: older builds and rollback depend on it.
2. Validate: JSON envelope with `version` 0 (or absent) and array `waypoints`
   / `tracks`; each record passes `records.ts` validation; ids unique. Any
   failure stops with a status and writes nothing:
   `corrupt-source`, `unsupported-source-version`, `invalid-source-records`
   (with up to 50 problems), `source-unavailable`.
3. One transaction makes the `waypoints` and `tracks` stores an exact copy of
   the source. Records are copied verbatim — fields older builds never wrote
   (e.g. `goodWinds`, which the first builds didn't have) are not filled with defaults.
4. Read back in a new transaction: counts, ids and every record (canonical
   JSON) must equal the source, else `verification-failed`.
5. Only then a final transaction writes `meta/migration:v0-v1` (time, counts,
   SHA-256 of the source string) and `meta/schema` `{ version: 1 }`.

Guarantees: an interruption before step 5 leaves the repository unmarked and
the next run starts again from the current `fieldline-v1` (which the app may
have changed meanwhile; leftovers are replaced). A completed migration is
never re-run, so later `fieldline-v1` changes are not re-imported. A
repository from a newer build (`unsupported-database`) is left untouched.
Two tabs racing are safe: the second sees the schema record and reports
`already-complete`. No `fieldline-v1` (new profile) → empty repository,
`nothing-to-migrate`.

New steps go at the end of `MIGRATIONS`; never edit a shipped step. Each
step must be re-runnable and must write `meta/schema` last.

## Trash and retention (DATA-02 foundation)

- `deleteWaypoint(id)` / `deleteTrack(id)` move the whole record (hunt label,
  winds, notes, segments, fix detail) into `trash` with `deletedAt`, in one
  transaction.
- `restoreFromTrash(trashId)` puts it back with the same id and content; if a
  live item already uses that id it fails with `conflict` and changes nothing.
- `purgeTrash(trashId)` and `emptyTrash()` are the only permanent deletes, for
  explicit user actions.
- **Retention policy: trashed items are kept until the user permanently
  deletes them.** There is no automatic expiry, and cache eviction cannot
  reach the trash. Browser-level eviction of the whole origin is a separate
  risk: call `requestPersistentStorage()` and show its answer.
- Undo/redo commands and attachment relationships come later (CC-11); the
  trash entry holds the full record so restores need nothing else today.

## Recording checkpoints (for CC-06)

```ts
const rec = new TrackCheckpointStore(backend);
await rec.startSession({ id, name, startedAt? });   // one open session at a time
await rec.appendFixes(id, fixes);                  // Fix: lng, lat, t, accuracy, altitude|null, altitudeAccuracy|null, speed|null, heading|null
await rec.markGap(id);                             // signal loss: next fixes start a new segment
await rec.setPaused(id, true | false);             // pause also breaks the segment
await rec.getActiveSession();                      // after restart: { session, segments, fixCount, damagedChunks } | null
await rec.finalizeSession(id, { trackId?, name? }); // → StoredTrack with segmentStarts; session removed atomically
await rec.discardSession(id);
```

Each `appendFixes` commits its chunk(s) and the session counter together;
when it resolves, those fixes survive a crash. Bounds: 250 fixes per chunk,
2,000 per append, 172,800 per session (48 h at 1 Hz). Invalid fixes (NaN,
out-of-range, `undefined` instead of `null`) are rejected, never stored as
zeros. Damaged chunks are counted in `damagedChunks`, not silently dropped,
and block finalizing. A quota failure rejects with `quota`: the recorder
must tell the user, keep the unsaved fixes in memory and retry.

## Full backup format

`createBackup(repo, { settings, appVersion })` → JSON text:

```json
{
  "format": "fieldline-backup",
  "version": 1,
  "createdAt": "2026-10-13T12:00:00.000Z",
  "app": { "name": "Fieldline", "version": "1.0.0" },
  "contentSchema": 1,
  "settings": { "format": "fieldline-settings", "version": 1, "...": "settings export" },
  "content": { "waypoints": [], "tracks": [], "trash": [] },
  "counts": { "waypoints": 0, "tracks": 0, "trash": 0 },
  "integrity": { "algorithm": "SHA-256", "digest": "<64 hex>" }
}
```

The digest covers the canonical JSON (sorted keys) of every member except
`integrity`. Active recordings are not included (finish or discard first).
GPX stays the interchange format; this file is the complete backup.

`parseBackup(text)` / `readBackupFile(file)` validate everything before any
write, in this order: size (150 MB), JSON, format, version (newer →
`future-version`), content schema, structure and counts, record limits
(50,000 waypoints, 10,000 tracks, 20,000 trash entries, 200,000 points per
track, 5,000,000 points total), checksum (`checksum-mismatch`), every record
with the shared validator (`invalid-records`: unsafe/path-like ids,
out-of-range coordinates, wrong types, duplicate ids, trash entries whose key
doesn't match their item), then settings through `importSettings`
(`invalid-settings` for damaged or newer settings; individual bad values are
reported in `rejectedSettings`). Text is stored as inert data; nothing in a
backup is executed or rendered as HTML.

**Restore policy** (`restoreBackup(repo, parsed, { onConflict })`), one
transaction, all or nothing:

- id not present here → added;
- same id, identical content → skipped and counted (`identical`), never
  duplicated;
- same id, different content → conflict. Default `"abort"`: nothing is
  written and a `conflict` StorageError is thrown. `"keep-existing"`: new
  records are added, this profile's version of each conflicting record is
  kept, and every conflict is listed in the report.

`planRestore()` returns the same counts without writing, for a confirmation
screen. The repository must be migrated first (`not-ready` otherwise).
Settings are returned in the report; the caller applies them through the
settings store after the content commit (they live in localStorage, outside
the transaction).

## Verification

- `npm test` — `src/lib/storage/*.test.ts` (56 tests): transactions,
  rollback, quota, migration (identity, byte-identical source, no-op re-run,
  interruption at both commits, corrupt/future/invalid sources, future
  database), checkpoints (restart recovery, gaps, bounds, finalize/discard,
  failure atomicity), trash, backup round-trip and rejection cases.
- `node scripts/storage-browser-check.mjs` — bundles the library, serves a
  harness on 127.0.0.1:3201 (`STORAGE_CHECK_PORT`), and in headless Chromium
  runs migrate → write → reload → read back, a rollback probe, backup restore
  into a fresh database and refusal of a future-version database.

## Wiring it in (coordinator)

1. On client start, after `hydrateSettings()`:
   `const storage = await openContentStorage({ legacy: localStorage })`.
2. If `storage.migration.ok && storage.durable`: load waypoints/tracks from
   `storage.repository` into the hunt store and route `addWaypoint`,
   `updateWaypoint`, `removeWaypoint` (→ `deleteWaypoint`, i.e. trash),
   `addTrack`, `toggleTrack`, `removeTrack`, `importAll` (→ `putMany`) through
   the repository. Show a visible error when a write rejects.
3. Decide what `fieldline-v1` content does after migration. Recommended
   (mirrors ADR-001): stop writing `waypoints`/`tracks` there, so it stays
   the frozen pre-migration copy for older builds and rollback; keep writing
   the non-content fields it still owns (`lastKind`, `activeHunt`,
   `introDismissed`, `lastView`). Older builds will not see content created
   after the upgrade; say so in release notes.
4. If migration failed or storage isn't durable: keep using `fieldline-v1`
   exactly as today and show `migration.message` / `storage.warning`.
5. Call `requestPersistentStorage()` once content exists and show the result
   in the storage/offline settings.
6. CC-06: on start, `storage.checkpoints.getActiveSession()` → offer to
   resume or finish the recovered recording.
7. Settings → "Backup and restore": `createBackup` with the settings store
   state; restore = `readBackupFile` → `planRestore` → confirm →
   `restoreBackup` → apply `report.settings` via the settings store.
8. Add an ADR (content in IndexedDB; `fieldline-v1` frozen after migration)
   and update `implementation-status.md`.

## Known gaps

- Offline package manifests, the package state machine and `PackageStore`
  are wave 2.
- Not wired into the app; no UI; no cross-tab change notification.
- No undo/redo stack yet (trash only).
- Backup restore of a single huge file runs in one transaction on the main
  thread; very large profiles may need chunked restore later.
- Real-device storage eviction and quota behavior is unverified (REL-03).
  A real-browser quota failure was not exercised: Chromium 153's CDP
  `Storage.overrideQuotaForOrigin` had no effect in headless runs. The
  `QuotaExceededError` → `quota` mapping is unit-tested and the memory
  backend's quota path is tested end to end.
