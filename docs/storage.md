# Durable storage and offline packages (CC-05 waves 1–2)

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

IndexedDB database `fieldline-content`, IndexedDB version 2. Object stores
(out-of-line string keys):

| Store | Key | Value | Class |
| --- | --- | --- | --- |
| `waypoints` | waypoint id | `Waypoint` | personal |
| `tracks` | track id | `StoredTrack` (`Track` + optional `segmentStarts`, per-point accuracy/altitude/speed/heading) | personal |
| `trash` | `${kind}:${itemId}:${deletedAt}` | `TrashEntry` | personal |
| `sessions` | session id | `RecordingSession` | personal |
| `chunks` | `${sessionId}:${seq, 8 digits}` | `FixChunk` | personal |
| `meta` | `schema`, `migration:v0-v1` | schema and migration records | bookkeeping (personal) |
| `packages` | package id | `PackageRecord` (state, active + pending manifest) | replaceable (v2) |
| `packageAssets` | `${packageId}@${version}` | required asset URLs, checksums, last verification | replaceable (v2) |
| `assets` | `${canonicalUrl}#${sha256}` | `AssetMeta` (bytes, type, status, `refs`) | replaceable (v2) |
| `assetData` | same as `assets` | `ArrayBuffer` | replaceable (v2) |

`PERSONAL_STORES` = the six content stores; `REPLACEABLE_STORES` = the four
offline package stores. Cache clearing (`clearReplaceableData(stores?)`) first
calls `assertEvictable`, which throws (clearing nothing) if any requested
store is personal or unlisted, or if any store is classified both personal
and replaceable; it can never empty the trash or delete content. The offline
stores are cleared all together or not at all (`invalid` otherwise), so no
package is left claiming assets that are gone.

Transactions (`backend.read/write(stores, fn)`) are atomic across stores:
all writes commit or none do. `write` resolves only after commit, with strict
durability requested in IndexedDB. Inside a callback, await only that
transaction's operations (IndexedDB auto-commits otherwise, and the next
request fails with `aborted`: "no longer active"); hashing and other slow
work happens before or after.

Failures are typed `StorageError`s, never reported as success:
`quota`, `unavailable`, `aborted`, `future-version`, `not-ready`,
`conflict`, `invalid`, `not-found`.

`MemoryBackend` has the same semantics (serialized transactions, staged
commits, structured clones, and a transaction that goes inactive once its
callback awaits anything that crosses a macrotask boundary, so such a bug
fails in `npm test` too; unlike IndexedDB, earlier writes are then rolled
back rather than committed) plus test hooks (`faults.onOp`,
`faults.beforeCommit`, `quotaBytes`). It is also the explicit non-durable
fallback when IndexedDB can't be opened (`openContentStorage` returns
`durable: false` and a warning).

## Schema versions

Two independent versions:

- **IndexedDB version** (`IDB_VERSION = 2`) — object-store layout. Upgrades
  are ordered functions in `UPGRADES`, each naming its own stores (1: content
  stores; 2: offline package stores) and only adding stores. A database with
  a higher version is never opened: `future-version`.
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
   / `tracks`; a waypoint whose `kind` the map can't draw (unknown or
   missing) is imported with `kind: "pin"` and listed in the result's
   `normalized` and in `meta/migration:v0-v1` (`normalized`,
   `normalizedCount`), never dropped; every record then passes `records.ts`
   validation; ids unique. Any failure stops with a status and writes nothing:
   `corrupt-source`, `unsupported-source-version`, `invalid-source-records`
   (with up to 50 problems), `source-unavailable`.
3. One transaction makes the `waypoints` and `tracks` stores an exact copy of
   the source. Records are copied verbatim apart from the kind mapping —
   optional fields older builds never wrote (e.g. `goodWinds`, which the first
   builds didn't have) are not filled with defaults.
4. Read back in a new transaction: counts, ids and every record (canonical
   JSON) must equal the source, else `verification-failed`.
5. Only then a final transaction writes `meta/migration:v0-v1` (time, counts,
   SHA-256 of the source string, `contentDigest` = SHA-256 of the canonical
   `{ waypoints, tracks }` as read, kind mappings) and `meta/schema`
   `{ version: 1 }`.

Guarantees: an interruption before step 5 leaves the repository unmarked and
the next run starts again from the current `fieldline-v1` (which the app may
have changed meanwhile; leftovers are replaced). A completed migration is
never re-run, so later `fieldline-v1` changes are not re-imported; instead,
each start compares the current `{ waypoints, tracks }` in `fieldline-v1`
with `contentDigest` and, if they differ (or the copy became unreadable or was
removed), returns `ok: true, status: "legacy-changed-after-migration"` with a
message. Nothing is merged: the coordinator should surface it (an older build
or the not-yet-rewired app saved marks there). Only content counts, so
`lastView`/`activeHunt` changes don't trigger it. A
repository from a newer build (`unsupported-database`) is left untouched.
Two tabs racing are safe: the second sees the schema record (signalled by
an internal sentinel, not a storage error code, so a real `ConstraintError`
can't be mistaken for it) and reports `already-complete`. No `fieldline-v1` (new profile) → empty repository,
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
await rec.getActiveSession();                      // after restart: { session, segments, fixCount, intact, lostFixes, missingChunks, damagedChunks } | null
await rec.finalizeSession(id, { trackId?, name?, acceptDamage? }); // → { track, lostFixes, missingChunks, damagedChunks }; session removed atomically
await rec.discardSession(id);                      // not-found if no such session
```

Session ids are safe ids without `:` (the chunk-key delimiter), so one
session's key range can't overlap another's. Each `appendFixes` tops up the
last chunk of the current segment (up to the cap) and adds new chunks as
needed, together with the session counters, in one transaction; when it
resolves, those fixes survive a crash, and a failed append leaves the
previous chunk contents intact. At 1 Hz that is one chunk per 250 fixes, not
one per append. Bounds: 250 fixes per chunk, 2,000 per append, 172,800 per
session (48 h at 1 Hz). Invalid fixes (NaN, out-of-range, `undefined` instead
of `null`) are rejected, never stored as zeros.

Loss is detected, never silent: the session records `nextSeq` and
`fixCount`, and recovery checks chunks `0..nextSeq-1` and the fix total.
`intact: false` comes with `missingChunks` (gone), `damagedChunks` (present
but unreadable) and `lostFixes`. `finalizeSession` then refuses with
`invalid` (a message stating what was lost) and changes nothing, unless the
caller passes `acceptDamage: true` after the user agrees; the result always
reports the loss. A quota failure rejects with `quota`: the recorder must tell
the user, keep the unsaved fixes in memory and retry.

The phone field-test tool (CC-01, `src/features/field-test/run-store.ts`) uses
the same checkpoint store over its **own database, `fieldline-field-test`**
(same layout and schema record, nothing migrated into it), so test runs never
reach `fieldline-content` or show up as the app's interrupted recording. Its
run setup, event log and reports are `ft-run:`, `ft-event:` and `ft-report:`
records in that database's `meta` store; finished runs become tracks there.
Deleting a test run touches only that database.

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
with the shared validator (`invalid-records`: unsafe/path-like ids, marker
kinds the map can't draw, missing names, out-of-range coordinates, wrong
types, unknown fields nested more than 16 levels, duplicate ids, trash
entries whose key doesn't match their item), then settings through `importSettings`
(`invalid-settings` for damaged or newer settings; individual bad values are
reported in `rejectedSettings`). A file nested more than 32 levels is
`damaged`, and any unexpected exception during parsing also returns
`damaged`, so `parseBackup` never throws. The SHA-256 digest detects damage,
not tampering (anyone can re-sign an edited file), which is why every record
is validated as if hostile. Text is stored as inert data; nothing in a backup
is executed or rendered as HTML.

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

- `npm test` — `src/lib/storage/*.test.ts` (70 tests): transactions,
  rollback, inactive-transaction detection, quota, blocked-open cleanup,
  migration (identity, byte-identical source, no-op re-run, interruption at
  both commits, corrupt/future/invalid sources, kind mapping, legacy change
  detection, conflict-vs-race, future database), checkpoints (restart
  recovery, gaps, bounds, chunk top-up, missing/damaged chunk detection,
  acceptDamage, finalize/discard, failure atomicity), trash and cache-clearing
  guard, backup round-trip and rejection cases (re-signed bad kinds, deep
  nesting).
- `node scripts/storage-browser-check.mjs` — bundles the library, serves a
  harness on 127.0.0.1:3201 (`STORAGE_CHECK_PORT`), and in headless Chromium
  runs migrate → write → reload → read back, a rollback probe, an
  auto-commit probe (await a timer inside a transaction → `aborted`), backup
  restore into a fresh database and refusal of a future-version database.

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
   resume or finish the recovered recording; if `intact` is false, say how
   many points were lost before offering `finalizeSession(id, { acceptDamage: true })`.
   Surface `migration.status === "legacy-changed-after-migration"` too.
7. Settings → "Backup and restore": `createBackup` with the settings store
   state; restore = `readBackupFile` → `planRestore` → confirm →
   `restoreBackup` → apply `report.settings` via the settings store.
8. Add an ADR (content in IndexedDB; `fieldline-v1` frozen after migration)
   and update `implementation-status.md`.

## Offline packages (CC-05 wave 2)

`src/lib/offline/` downloads a rectangle of map data into IndexedDB so every
advertised layer works with no network. The screens are in
`src/features/offline/` ("In the app" below).

| File | Purpose |
| --- | --- |
| `sources.ts` | Packageable layers, provider limits, `packageRuleFor` (the only allowlist the downloader trusts), canonical URLs |
| `plan.ts` | `planPackage`, tile math (antimeridian aware), bounds helpers |
| `package-store.ts` | `OfflinePackageStore`: records, shared assets with reference counts, states, coverage, serving reads |
| `download.ts` | `downloadPackage`, `repairPackage` |
| `verify.ts` | `verifyPackage` |
| `serve.ts` | `createPackageTileSource` for the `fltile://` protocol |
| `test-fixtures.ts` | Fake providers for tests only |

### Layers and provider rules

| Layer id | Source | Zooms | Stale after | Notes |
| --- | --- | --- | --- | --- |
| `usgs-imagery` | USGS TNM USGSImageryOnly | ≤ 16 | 365 days | |
| `usgs-topo` | USGS TNM USGSTopo | ≤ 16 | 365 days | |
| `blm-sma` | BLM SMA cached tiles | ≤ 16 | 90 days | ≤ 2 parallel requests |
| `ofm-vector` | OpenFreeMap TileJSON + vector tiles | ≤ 14 | 60 days | tile URL is versioned; version read from the TileJSON at download time |
| `dem` | AWS Terrain Tiles via the app's `/api/dem` | ≤ 14 | 3650 days | stored under the upstream S3 URL, so any app origin serves it |
| `glyphs` | OpenFreeMap fonts | — | 365 days | added to every package: Noto Sans Regular/Bold/Italic × ranges 0-255, 256-511, 8192-8447 (marks, sun labels and place names need them) |

Never packaged, reported in `plan.excluded` with a reason: `esri-imagery` /
`satellite` / `hybrid` (Esri's terms; ADR-006) and `hunt-units` / `units`
(download rights unverified). `packageRuleFor` refuses Esri hosts
(`*.arcgisonline.com`, `*.arcgis.com`) and every host not listed, before any
request, even if a stored asset list is tampered with.

Limits enforced at planning (`plan.violations`, `plan.ok = false`), when the
asset list is resolved, and again on real bytes while downloading:

- OpenFreeMap: ≤ 3,000 files (tiles + TileJSON + glyphs) and ≤ 50 MB per
  package; ≤ 4 parallel requests.
- USGS ≤ 4, BLM ≤ 2, terrain ≤ 4 parallel requests; ≤ 6 overall. These
  limits are tab-wide (module-level semaphores shared by every download in
  the tab), so two packages downloading at once still send at most 4
  OpenFreeMap requests together.
- One tab downloads at a time: the first download in a tab takes the Web
  Lock `fieldline-offline-download` (`navigator.locks`, `ifAvailable`) and
  the tab holds it while any of its downloads (and their verification) run.
  A download started in another tab rejects immediately with a `conflict`
  `StorageError` ("Another Fieldline tab or window is downloading…") and
  sends no request; the UI should say so and offer to retry later. That
  other tab sees the downloading package as `paused` with
  `interrupted: true` until the first tab finishes. Without Web Locks
  (insecure http origins, old runtimes) there is no cross-tab exclusion.
- Package hard cap: 20,000 files, zoom ≤ 16, one file ≤ 8 MB, and 1 GB —
  estimated at planning and enforced again on real downloaded bytes (each
  asset counted once, so a repaired file replaces its old size rather than
  adding to it; the same applies to OpenFreeMap's 50 MB).
- Before starting: the remaining estimate × 1.1 must fit in
  `navigator.storage.estimate()` headroom, else `quota` (nothing downloaded).
- OpenFreeMap asks for a unique User-Agent. Browsers don't let pages set it;
  the desktop shell adds one to every `tiles.openfreemap.org` request
  (`desktop/policy.mjs` `providerUserAgent`). `downloadPackage({
  requestHeaders })` remains for runtimes that allow it. See "Known gaps".

### Manifest and states

`getManifest(id)` returns spec §8's manifest: `packageId`, `schemaVersion`
(`PACKAGE_SCHEMA_VERSION = 1`), `bounds`, `createdAt`, `sourceVersions`
(OFM tile version, terrain dataset version; null when unknown), `zoomRange`,
`layerIds`, `requiredAssets` (canonical URLs), `checksums` (URL → SHA-256,
set when verified), `expectedBytes`, `actualBytes`, `progress`,
`integrityStatus` (`unverified | ok | damaged`, `missingCount`,
`corruptCount`, `absentCount` — tiles the source confirmed it has no data
for, for "N tiles had no data at the source" — and the first 50 missing /
corrupt URLs for display; the complete lists live in the version's asset
list and are what serving and repair use), `expiryPolicy` (`maxAgeDays` =
shortest layer, `expiresAt`),
`attribution`; plus per-layer `done/verified/missing/corrupt/absent`,
`lastError`, `failures`.

States (`PackageStatus.state`):

```
planned → downloading → paused | failed → (resume) downloading → verifying → ready
ready → stale (time) → updating → verifying → ready
```

- **ready** only after `verifyPackage` re-hashed every required asset and
  found it with its recorded size and SHA-256, committed in a transaction
  that re-checks, for every asset, that it is still stored for this version
  with exactly the verified checksum (bytes replaced by another tab after
  hashing are reported corrupt, never ready). A partly downloaded package is
  never ready.
- **stale**: the active version is older than `expiryPolicy` (computed from
  `now` at read time, never stored as ready). Still served; offer an update.
- **updating**: a pending version is downloading. During an update `state`
  describes the new version (`updating`, `verifying`, `paused`, `failed`);
  `activeState` (`ready` / `stale`) and `servable` describe the old version,
  which stays served until the new one verifies; then one transaction swaps
  them and releases the old version's references. A failed update reports
  `state: "failed"` with `activeState: "ready"`, `servable: true` and
  `update.lastError`; retry with `downloadPackage` (or `repairPackage`) or
  drop it with `discardPending` (back to `ready`).
- **paused**: aborted by the caller, or `interrupted: true` when a download
  stopped without pausing (tab closed, crash, another tab). Resume with
  `downloadPackage`.
- **failed**: network failures (`failures` lists them), provider limit, disk
  full (`lastError.code = "quota"`), or a verification that found damage.
  `servable` stays true for a once-verified package; corrupt files are not
  served.

### Storage behavior and guarantees

- Assets are content-addressed under their canonical URL
  (`${url}#${sha256}`), with `refs` listing the package versions using them
  (reference count = `refs.length`). Overlapping packages share one copy;
  a new package adopts copies fetched in the last 7 days instead of
  downloading them (an update adopts only copies fetched since it started).
  Deleting a package releases its references in one transaction and deletes
  only assets nobody else references.
- Per-asset progress is persisted: each stored asset carries the version's
  reference, written with its bytes and progress in one transaction (batches
  of up to 32). After a restart, `downloadPackage` fetches only what's
  missing.
- SHA-256 is computed outside transactions; every transaction awaits only its
  own operations.
- Fetching: timeout 20 s, up to 4 attempts with exponential backoff
  (0.5–30 s, jittered); 429/503 honor `Retry-After` (seconds or date) for
  the whole provider, tab-wide. A Retry-After beyond 120 s stops that
  provider for the rest of the run: its remaining files are reported failed
  without being requested, the time is persisted in the package record
  (`providerNotBefore`, surfaced as `status.waitUntil` and
  `progress.waitUntil`; `lastError.code = "rate-limited"`), and a resume
  before that time — even after a restart — sends nothing to that provider.
  Other providers keep downloading.
- A 404 is accepted as "no tile here" only when a second request later in
  the same run also returns 404; it is then stored as an empty "absent" tile
  and counted in `absentCount` / per-layer `absent`. A 404 followed by data
  stores the data. Other 4xx, HTML/JSON error pages and oversize files fail.
- Redirects are never followed (`redirect: "manual"`): a 3xx or opaque
  redirect fails the file, so no request reaches a host outside the
  allowlist.
- Storage errors reject with a typed `StorageError` (`quota`, …) and leave the
  package failed (or paused/interrupted if even that write fails); batches are
  atomic, so bytes, metadata and references are never half-written.
- `navigator.storage.persist()` is requested at every download start; the
  answer is in `result.persistence` and `status.persistence`.

### Serving

`fltile://` (src/lib/hunt/tiles.ts) now tries, in order: verified packages
(`setPackageTileSource`), the `fieldline-tiles-v1` cache (unchanged:
`OFFLINE_TEMPLATES` only), the network. Plain http is allowed only for this
origin's `/api/dem/`. `tileProtocolStats()` counts package/cache/network/
failed responses.

OpenFreeMap's TileJSON names its current data version (tile URLs are
versioned), so it is handled differently:

- Online (`navigator.onLine !== false`), the TileJSON always comes from the
  network, so the map follows the provider's current version and never
  stays pinned to an old packaged one; a packaged copy is used only if that
  request fails. Offline, a packaged copy is used directly. Either way its
  tile URLs are wrapped in `fltile://`.
- A vector tile is served from a package that stored exactly that URL.
  Offline (or when the network request fails), a tile requested under one
  data version is answered from any ready package that has the same z/x/y
  under another version (`readServableAsset(url, { substituteVersions })`),
  newest verification first — so packages downloaded months apart under
  different OpenFreeMap versions all stay reachable whichever packaged
  TileJSON the map loaded. Online, tiles of the current version come from
  the network.
- Corrupt assets are never served: the complete corrupt list from the last
  verification is consulted, not the 50-entry display preview.

### In the app (`src/features/offline/`)

- `controller.ts` (Zustand `useOffline`): `startOfflinePackages(backend)`
  runs at startup after content sync, with `durableBackend()` from
  content-sync (repository mode only; otherwise `status: "unavailable"` with
  the reason, and the Offline maps sheet keeps the old one-zoom tile-cache
  save as a fallback). The map waits for the package list, so the first tile
  can come from a package. `setPackageTileSource` is attached only while at
  least one package is servable, so nothing reads IndexedDB per tile when
  nothing is downloaded. One operation at a time in the tab (download,
  update, check, repair) with throttled progress; `pauseDownload()` aborts;
  `resumePackage` continues a first download or update (repairing only bad
  files when its check found damage); a `conflict` from another tab is shown
  as its message.
- `OfflinePanel.tsx` (Layers → Offline maps): area = the map view (dashed on
  the map, "Use the map view now" to re-take it), name, layers preselected
  from what the map shows (USGS imagery stands in for Esri), map zoom range,
  per-layer files and size, totals, violations, what's not included and why
  (Esri imagery, hunt units), attribution. Progress with Pause. Downloaded
  areas: state, size, zooms, expiry, update/stale notes, provider
  wait-until, interrupted, last error, absent tiles; Show on map, Resume,
  Update, Check, Repair, Drop update, Delete (confirmed).
- `OfflineHere.tsx` (FIELD-01): the spot card's "Offline here: … (zooms)"
  line from `coverage()`; hidden when nothing is downloaded.
- Map: `offline-areas` GeoJSON source and three navigation-group layers
  (`offline-areas-casing`, `offline-areas` solid sage = usable / amber =
  unfinished, `offline-area-preview` dashed). Outlines show while Offline
  maps is open and after "Show on map" until the next tap on the map.
- MapCanvas sends glyphs, OpenFreeMap and terrain through `fltile://`
  (`usgs`, `topo`, `sma` already were; Esri stays plain HTTPS).
- Desktop: `desktop/policy.mjs` `providerUserAgent` gives
  `tiles.openfreemap.org` requests `Fieldline/<version> (desktop; …)` in the
  session's single `onBeforeSendHeaders` listener.

### Map zooms vs tile zooms

MapLibre's zoom is based on 512-pixel tiles. The screen asks for map zooms
and plans with `planPackage({ …, zoomBasis: "map" })`, which gives each layer
the tile zooms the map requests (`mapZoomTileRange`, MapLibre 6.13):

- 256-pixel rasters (USGS imagery and topo, BLM SMA; rounded): one zoom
  deeper than the map (map zoom 12 → z13).
- OpenFreeMap's 512-pixel vector tiles (floored): the map zoom.
- Terrain has two consumers. Hillshade alone treats it as a 256-pixel raster
  (one deeper). With 3D terrain on, MapLibre's terrain manager switches the
  source to 512-pixel tiles at floor(map zoom) without rounding, and also asks
  for each tile's parent and a zoom-5 ancestor (`_addTerrainIdealTiles`). So
  terrain is planned from min(5, min − 1) to max + 1; the shallow levels are a
  handful of tiles.

- Contours (MAP-03) are a third terrain consumer: 512-pixel contour tiles at
  floor(map zoom), each traced from the DEM tile with the same z/x/y and its
  eight neighbors, read through `fltile://` (`src/features/map/contour-source.ts`).
  For map zooms up to the package's top zoom + 1 that zoom is inside the
  terrain range above, so packages need no change; contour tiles themselves
  are made on the device and never stored. Deeper, offline, the terrain tile
  comes from the ancestor enlargement below, so contours are traced from
  coarser enlarged terrain. A neighbor outside the area is also enlarged from
  a packaged ancestor when one exists; with none, and no network, that tile
  edge is left without lines (and re-traced when the network returns). Land
  cover is drawn from the OpenFreeMap tiles a package already holds.

Manifests keep the map zooms in `zoomRange` and each layer's tile zooms in
`layers[]`. The "Offline here" line lists, per layer, the map zoom ranges of
the covering areas where that layer is complete, merging only overlapping or
adjacent ranges ("zooms 6 and 12"); "12+" where a layer reaches its deepest
tiles (the map enlarges past a source's maximum); out-of-date covering areas
are named. The default range is two zooms out to two zooms in from the view:
the levels further out cost a few percent and cover zooming out and the far
distance of a tilted 3D view, which the map draws at lower zooms.

Past a package's top zoom with no network: `fltile://` enlarges the missing
raster or terrain tile from the nearest packaged ancestor up to 4 levels up
(`ancestorTile`, canvas crop and scale, decoded without color conversion;
nearest-neighbor for terrain, whose colors encode elevation). It runs only
when offline or when the request itself failed (a network `TypeError`), never
on an HTTP error from a reachable provider or a request the map cancelled.

### Verification

- `npm test`: `src/lib/offline/plan.test.ts` (exclusions, OFM limits, hard
  cap, antimeridian, zoom clamping, source allowlist, canonical URLs) and
  `packages.test.ts` (resume after failure and restart, pause/interrupted,
  missing/corrupt verify + targeted repair, shared assets and deletion,
  update success/failure/failed verification, disk full mid-download, quota
  simulation, budget refusal, Retry-After and parallel caps, long
  Retry-After stopping a provider across resumes, tab-wide caps across
  concurrent downloads, the cross-tab lock, two OpenFreeMap versions offline
  and online, corrupt assets beyond the first 50, refused redirects,
  checksum re-check at commit, repair byte accounting, confirmed 404s,
  real-byte package cap, failed-update reporting and discard, stale, Esri
  tampering, serving through `fltile://` with the network down, unverified
  packages not served, coverage).
- `src/features/offline/controller.test.ts`: the app controller (unavailable
  storage, download to ready with sizes and coverage, serving only while a
  package is usable, pause/resume, one operation at a time, check/update/
  delete, provider failure and resume, a new download holding the slot
  while its area is created, row labels while running and for an update
  that never started), map-zoom planning including both terrain consumers,
  3D-terrain tiles served offline at the downloaded zoom, no enlarging over
  HTTP errors or cancelled requests, ancestor tile math and enlarging
  offline, coverage text with zoom gaps and out-of-date areas, default
  layers/zooms, outlines across the antimeridian.
- `node scripts/offline-ui-check.mjs` against `npm start` (live, about 80
  requests): the real screens with USGS imagery and 3D terrain on — plan,
  download with pause and resume, reload with every tile host blocked: no
  tile the package holds (per its stored tile ranges) may reach the network
  (OpenFreeMap's TileJSON is asked online once by design; tiles the tilted
  view asks for outside the package are listed), zoom past the package
  (screenshot only, no assertion), "Offline here", outline, delete.
- `node scripts/offline-contours-check.mjs` against `npm start` (live): a new
  profile on the Terrain style downloads its view at map zoom 12 (public
  land, OpenFreeMap, terrain; no raster base), reloads with every tile host
  and the terrain proxy blocked: no packaged tile may reach the network, and
  turning contours off must change the screenshot (contours were drawn from
  the package).
- `node scripts/offline-browser-check.mjs` (live, about 50 polite requests;
  not in `npm test`): first a real IndexedDB upgrade (a populated version-1
  database built with `UPGRADES[1]` is opened by this build: every content
  record unchanged, the four offline stores present, version 2); then
  downloads a small Flagstaff package (zooms 11–12: topo,
  SMA, OFM + glyphs, terrain) into real IndexedDB in Chromium, verifies it,
  then `context.setOffline(true)`, reloads, renders a MapLibre map whose
  sources all use `fltile://` and asserts every tile came from the package
  (no network, no tile errors, vector features decoded, labels placed).

## Known gaps

- Offline packages: rectangle selection only, and the rectangle is the map
  view (no drawing, polygon or route corridor); no sprites (the style uses
  none); no local search index or hunt-unit identify data; OFM User-Agent
  can't be set from a browser page (desktop sets it; unit-tested, not yet
  run in a packaged desktop build); staleness is time-based (no upstream
  version check); a package downloading in another tab shows as "Stopped"
  here until that tab finishes. There's no cross-tab change notification:
  the list is re-read when the Offline maps sheet opens and when the app
  returns to the foreground, which is also when a package finished
  elsewhere starts being served in this tab.
- A tilted 3D view (3D terrain always tilts) draws its far distance at lower
  zooms and can reach a little past the flat view's rectangle: those tiles
  are blank offline unless the package's lower zooms cover them
  (`offline-ui-check` lists them; with zoom 12 only: lower-zoom OpenFreeMap
  and terrain tiles at the west edge).
- Enlarged tiles past a package's top zoom are blurrier than real ones.
  Vector tiles aren't enlarged by Fieldline; MapLibre keeps parent tiles on
  screen when children fail, which covers some of that.
- Checking every file (a check, the end of a download, repair's first check)
  shows no progress and can't be paused.
- No undo/redo stack yet (trash only).
- Backup restore of a single huge file runs in one transaction on the main
  thread; very large profiles may need chunked restore later.
- Real-device storage eviction and quota behavior is unverified (REL-03).
  A real-browser quota failure was not exercised: Chromium 153's CDP
  `Storage.overrideQuotaForOrigin` had no effect in headless runs. The
  `QuotaExceededError` → `quota` mapping is unit-tested and the memory
  backend's quota path is tested end to end.
