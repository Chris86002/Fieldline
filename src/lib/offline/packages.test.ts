import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryBackend, StorageError } from "../storage/backend.ts";
import { sha256HexBytes } from "../storage/digest.ts";
import { loadTile, setPackageTileSource } from "../hunt/tiles.ts";
import {
  _resetProviderBackoff,
  downloadPackage,
  parseRetryAfter,
  repairPackage,
} from "./download.ts";
import {
  assetKey,
  OfflinePackageStore,
  versionRef,
  type AssetMeta,
  type PackageRecord,
} from "./package-store.ts";
import { createPackageTileSource } from "./serve.ts";
import {
  downloadOptions,
  FIXTURE_APP_ORIGIN,
  fakeProvider,
  fakeSleep,
  newStore,
  smallPlan,
} from "./test-fixtures.ts";
import { verifyPackage } from "./verify.ts";

const DAY = 86_400_000;

async function readyPackage(
  store: OfflinePackageStore,
  provider = fakeProvider(),
  name = "Fixture area",
) {
  const created = await store.createPackage(smallPlan(), { name });
  const result = await downloadPackage(store, created.packageId, downloadOptions(provider));
  assert.equal(result.state, "ready", JSON.stringify(result.failed));
  return { packageId: created.packageId, provider, result };
}

/** Every asset has bytes, every byte record has metadata, refs point at existing versions. */
async function assertConsistent(backend: MemoryBackend) {
  const [records, metaKeys, metas, dataKeys] = await backend.read(
    ["packages", "assets", "assetData"],
    async (tx) =>
      [
        await tx.getAll<PackageRecord>("packages"),
        await tx.getAllKeys("assets"),
        await tx.getAll<AssetMeta>("assets"),
        await tx.getAllKeys("assetData"),
      ] as const,
  );
  assert.deepEqual(
    [...metaKeys].sort(),
    [...dataKeys].sort(),
    "asset metadata and bytes match one to one",
  );
  const versions = new Set(
    records.flatMap((r) =>
      [r.active, r.pending].filter(Boolean).map((m) => versionRef(r.packageId, m!.version)),
    ),
  );
  for (const meta of metas) {
    assert.ok(meta.refs.length > 0, "no unreferenced assets");
    for (const ref of meta.refs) assert.ok(versions.has(ref), `dangling ref ${ref}`);
  }
}

/** Emulates navigator.onLine (undefined restores the runtime's own). */
function setOnline(value: boolean | undefined) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  if (value === undefined) Reflect.deleteProperty(nav, "onLine");
  else Object.defineProperty(nav, "onLine", { configurable: true, value });
}

afterEach(() => {
  setPackageTileSource(null);
  Reflect.deleteProperty(globalThis, "location");
  _resetProviderBackoff();
  setOnline(undefined);
});

describe("offline package download", () => {
  it("downloads, verifies and reports ready with a complete manifest", async () => {
    const { backend, store } = newStore();
    const { packageId, provider, result } = await readyPackage(store);
    assert.equal(result.persistence, "granted");
    const manifest = (await store.getManifest(packageId))!;
    assert.equal(manifest.phase, "ready");
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.integrityStatus.status, "ok");
    assert.equal(manifest.requiredAssets.length, manifest.requiredAssetCount);
    assert.equal(Object.keys(manifest.checksums).length, manifest.requiredAssets.length);
    assert.equal(manifest.progress.done, manifest.progress.total);
    assert.equal(manifest.sourceVersions["ofm-vector"], "20260101_000000_pt");
    assert.ok(manifest.actualBytes > 0);
    assert.ok(manifest.expiryPolicy.expiresAt! > Date.now());
    assert.ok(manifest.attribution.includes("© OpenStreetMap, OpenFreeMap"));
    assert.ok(manifest.requiredAssets.includes("https://tiles.openfreemap.org/planet"));
    assert.ok(manifest.requiredAssets.some((u) => u.includes("/fonts/Noto%20Sans%20Bold/")));
    // Terrain went through the app's proxy but is keyed by its upstream URL.
    assert.ok(provider.calls.some((u) => u.startsWith(`${FIXTURE_APP_ORIGIN}/api/dem/`)));
    assert.ok(
      manifest.requiredAssets.some((u) =>
        u.startsWith("https://s3.amazonaws.com/elevation-tiles-prod/"),
      ),
    );
    assert.ok(!provider.calls.some((u) => u.includes("arcgisonline")));
    assert.equal(new Set(provider.calls).size, provider.calls.length, "nothing fetched twice");
    await assertConsistent(backend);
  });

  it("resumes an interrupted download without re-fetching stored assets, never ready before verified", async () => {
    const backend = new MemoryBackend();
    let store = new OfflinePackageStore(backend);
    const created = await store.createPackage(smallPlan(), { name: "Resume" });
    const flaky = fakeProvider();
    flaky.override = (_url, call) => (call > 12 ? new TypeError("network down") : null);
    const first = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(flaky, { maxAttempts: 1 }),
    );
    assert.equal(first.state, "failed");
    assert.ok(first.failed.length > 0);
    assert.notEqual((await store.getPackage(created.packageId))!.state, "ready");
    const storedFirst = new Set(flaky.calls.slice(0, 12));

    // Simulated restart: a fresh store over the same database.
    store = new OfflinePackageStore(backend);
    const before = (await store.getPackage(created.packageId))!;
    assert.equal(before.state, "failed");
    assert.equal(before.manifest.progress.done, 12);
    const healthy = fakeProvider();
    const second = await downloadPackage(store, created.packageId, downloadOptions(healthy));
    assert.equal(second.state, "ready");
    for (const url of healthy.calls) assert.ok(!storedFirst.has(url), `re-fetched ${url}`);
    assert.equal(
      healthy.calls.length + 12,
      (await store.getManifest(created.packageId))!.requiredAssets.length,
    );
    await assertConsistent(backend);
  });

  it("pauses on abort and reports a crashed download as paused (interrupted), never ready", async () => {
    const backend = new MemoryBackend();
    const store = new OfflinePackageStore(backend);
    const created = await store.createPackage(smallPlan(), { name: "Pause" });
    const controller = new AbortController();
    const provider = fakeProvider();
    provider.override = (_url, call) => {
      if (call === 8) controller.abort();
      return null;
    };
    const paused = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(provider, { signal: controller.signal }),
    );
    assert.equal(paused.state, "paused");
    const done = paused.status.manifest.progress.done;
    assert.ok(done > 0 && done < paused.status.manifest.progress.total);

    // A tab that died mid-download leaves phase "downloading": another session sees it paused.
    await store.updateTarget(created.packageId, 1, (m) => {
      m.phase = "downloading";
    });
    const reopened = new OfflinePackageStore(backend);
    const status = (await reopened.getPackage(created.packageId))!;
    assert.equal(status.state, "paused");
    assert.equal(status.interrupted, true);
    assert.equal(status.servable, false);
    const resumed = await downloadPackage(
      reopened,
      created.packageId,
      downloadOptions(fakeProvider()),
    );
    assert.equal(resumed.state, "ready");
  });

  it("verify reports exactly which assets are missing or corrupt; repair fetches only those", async () => {
    const { backend, store } = newStore();
    const { packageId } = await readyPackage(store);
    const manifest = (await store.getManifest(packageId))!;
    const ref = versionRef(packageId, manifest.version);
    const [missingUrl, corruptUrl, dataGoneUrl] = manifest.requiredAssets.slice(3, 6);
    await backend.write(["assets", "assetData"], async (tx) => {
      const gone = (await tx.getRange<AssetMeta>("assets", `${missingUrl}#`))[0];
      await tx.delete("assets", assetKey(gone.url, gone.sha256));
      await tx.delete("assetData", assetKey(gone.url, gone.sha256));
      const bad = (await tx.getRange<AssetMeta>("assets", `${corruptUrl}#`))[0];
      const flipped = new Uint8Array(bad.bytes).fill(7);
      await tx.put("assetData", assetKey(bad.url, bad.sha256), flipped.buffer);
      const noData = (await tx.getRange<AssetMeta>("assets", `${dataGoneUrl}#`))[0];
      await tx.delete("assetData", assetKey(noData.url, noData.sha256));
    });

    const verified = await verifyPackage(store, packageId);
    assert.equal(verified.ok, false);
    assert.deepEqual(verified.missing.sort(), [missingUrl, dataGoneUrl].sort());
    assert.deepEqual(verified.corrupt, [corruptUrl]);
    assert.equal(verified.status.state, "failed");
    assert.equal(verified.status.manifest.integrityStatus.status, "damaged");
    assert.equal(verified.status.manifest.integrityStatus.corruptCount, 1);
    // The intact rest still serves; the corrupt file doesn't.
    assert.equal(await store.readServableAsset(corruptUrl), null);
    assert.ok(await store.readServableAsset(manifest.requiredAssets[0]));

    const repairer = fakeProvider();
    const repaired = await repairPackage(store, packageId, downloadOptions(repairer));
    assert.equal(repaired.state, "ready");
    const fetched = repairer.calls.map((u) =>
      u.startsWith(`${FIXTURE_APP_ORIGIN}/api/dem/`) ? "dem" : u,
    );
    assert.deepEqual(
      fetched.sort(),
      [missingUrl, corruptUrl, dataGoneUrl]
        .map((u) => (u.includes("elevation-tiles") ? "dem" : u))
        .sort(),
    );
    const after = (await store.getManifest(packageId))!;
    assert.equal(after.integrityStatus.status, "ok");
    assert.equal(after.progress.done, after.progress.total);
    assert.ok((await store.assetsFor(corruptUrl)).every((m) => m.refs.includes(ref)));
    await assertConsistent(backend);
  });

  it("shares assets between overlapping packages; deleting one keeps the other ready", async () => {
    const { backend, store } = newStore();
    const a = await readyPackage(store, fakeProvider(), "A");
    const providerB = fakeProvider();
    const createdB = await store.createPackage(
      smallPlan({ bounds: { west: -111.5, south: 34.49, east: -111.44, north: 34.53 } }),
      { name: "B" },
    );
    const b = await downloadPackage(store, createdB.packageId, downloadOptions(providerB));
    assert.equal(b.state, "ready");
    const listA = (await store.getManifest(a.packageId))!.requiredAssets;
    const listB = (await store.getManifest(createdB.packageId))!.requiredAssets;
    const shared = listB.filter((u) => listA.includes(u));
    assert.ok(shared.length >= 10, `shared ${shared.length}`);
    // Shared assets were adopted, not downloaded again (the TileJSON is always
    // re-read: it names the current OpenFreeMap tile version).
    for (const url of providerB.calls) {
      if (url === "https://tiles.openfreemap.org/planet") continue;
      assert.ok(!shared.includes(url), `re-downloaded shared ${url}`);
    }
    for (const url of shared) {
      const metas = await store.assetsFor(url);
      assert.equal(metas.length, 1);
      assert.equal(metas[0].refs.length, 2, "reference count 2");
    }
    const usage = await store.storageUsage();
    assert.equal(usage.sharedAssets, shared.length);

    const onlyA = listA.filter((u) => !listB.includes(u));
    const { deletedAssets } = await store.deletePackage(a.packageId);
    assert.equal(deletedAssets, onlyA.length);
    for (const url of shared) assert.equal((await store.assetsFor(url))[0].refs.length, 1);
    for (const url of onlyA) assert.deepEqual(await store.assetsFor(url), []);
    const reverified = await verifyPackage(store, createdB.packageId);
    assert.equal(reverified.ok, true);
    assert.equal(reverified.status.state, "ready");
    assert.equal(await store.getPackage(a.packageId), null);
    await assertConsistent(backend);
  });

  it("updates atomically: a failed update keeps the old version ready and servable", async () => {
    const { backend, store } = newStore();
    const { packageId } = await readyPackage(store);
    const v1 = (await store.getManifest(packageId))!;
    const probe = v1.requiredAssets.find((u) => u.includes("USGSTopo"))!;
    const servedText = async () => {
      const hit = await store.readServableAsset(probe);
      return hit ? new TextDecoder().decode(hit.data) : null;
    };
    assert.match((await servedText())!, /^fixture r1 /);

    const provider = fakeProvider();
    provider.revision = 2;
    const started = await store.startUpdate(packageId);
    assert.equal(started.state, "updating");
    assert.equal(started.servable, true);
    provider.override = (_url, call) => (call > 10 ? new TypeError("connection lost") : null);
    const failed = await downloadPackage(
      store,
      packageId,
      downloadOptions(provider, { maxAttempts: 1 }),
    );
    // The failure is reported as such, with the old version still ready and served.
    assert.equal(failed.status.state, "failed");
    assert.equal(failed.status.activeState, "ready");
    assert.equal(failed.status.servable, true);
    assert.equal(failed.status.update?.phase, "failed");
    assert.equal(failed.status.update?.lastError?.code, "network");
    assert.equal(failed.status.activeVersion, 1);
    assert.equal(failed.status.manifest.phase, "ready");
    assert.match((await servedText())!, /^fixture r1 /, "old version still served");
    // Discarding the failed update returns to the ready old version.
    const reread = (await store.getPackage(packageId))!;
    assert.equal(reread.state, "failed");

    // A new version that fails verification doesn't replace the old one either.
    provider.override = null;
    const pendingRef = versionRef(packageId, 2);
    const resumed = await downloadPackage(store, packageId, downloadOptions(provider));
    assert.equal(resumed.state, "ready");
    assert.equal(resumed.status.activeVersion, 2);
    assert.match((await servedText())!, /^fixture r2 /, "new version served after commit");
    const metas = await store.assetsFor(probe);
    assert.equal(metas.length, 1, "old copy released");
    assert.deepEqual(metas[0].refs, [pendingRef]);
    assert.equal(await store.getAssetList(packageId, 1), undefined);
    await assertConsistent(backend);
  });

  it("an update whose verification fails keeps the old version", async () => {
    const { backend, store } = newStore();
    const { packageId } = await readyPackage(store);
    const provider = fakeProvider();
    provider.revision = 3;
    await store.startUpdate(packageId);
    // Corrupt one new asset between download and verification.
    const original = store.commitAssets.bind(store);
    let tampered = false;
    store.commitAssets = async (id, version, assets) => {
      const record = await original(id, version, assets);
      if (!tampered && version === 2) {
        tampered = true;
        const asset = assets.find((a) => a.bytes > 0)!;
        await backend.write(["assetData"], (tx) =>
          tx.put(
            "assetData",
            assetKey(asset.url, asset.sha256),
            new Uint8Array(asset.bytes).buffer,
          ),
        );
      }
      return record;
    };
    const result = await downloadPackage(store, packageId, downloadOptions(provider));
    assert.equal(result.status.state, "failed");
    assert.equal(result.status.activeState, "ready");
    assert.equal(result.status.update?.integrityStatus.status, "damaged");
    assert.equal(result.status.activeVersion, 1);
    assert.equal(result.status.servable, true);
    // The failed update can be discarded: back to the old version, ready.
    const discarded = (await store.discardPending(packageId))!;
    assert.equal(discarded.state, "ready");
    assert.equal(discarded.update, null);
    assert.equal(await store.getAssetList(packageId, 2), undefined);
    await assertConsistent(backend);
  });

  it("a disk-full error while storing assets is typed and leaves the package failed, nothing half-committed", async () => {
    const { backend, store } = newStore();
    const created = await store.createPackage(smallPlan(), { name: "Quota" });
    let puts = 0;
    backend.faults.onOp = (op) => {
      if (op.type === "put" && op.store === "assetData" && ++puts > 10) {
        throw new StorageError("quota", "Storage is full.");
      }
    };
    await assert.rejects(
      downloadPackage(store, created.packageId, downloadOptions(fakeProvider())),
      (error: unknown) => error instanceof StorageError && error.code === "quota",
    );
    backend.faults = {};
    const status = (await store.getPackage(created.packageId))!;
    assert.equal(status.state, "failed");
    assert.equal(status.manifest.lastError?.code, "quota");
    assert.equal(status.servable, false);
    const stored = (
      await store.storedAssets(
        created.packageId,
        1,
        (await store.getManifest(created.packageId, 1))!.requiredAssets,
      )
    ).size;
    assert.ok(stored > 0 && stored <= 10, `stored ${stored}`);
    assert.equal(status.manifest.progress.done, stored, "progress matches what was committed");
    await assertConsistent(backend);
    const resumed = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(fakeProvider()),
    );
    assert.equal(resumed.state, "ready");
  });

  it("quota errors are typed, leave the package not ready, and commit nothing partial", async () => {
    const { backend, store } = newStore();
    const created = await store.createPackage(smallPlan(), { name: "Quota" });
    backend.quotaBytes = backend.sizeBytes() + 3_000;
    await assert.rejects(
      downloadPackage(store, created.packageId, downloadOptions(fakeProvider())),
      (error: unknown) => error instanceof StorageError && error.code === "quota",
    );
    const status = (await store.getPackage(created.packageId))!;
    assert.ok(["failed", "paused"].includes(status.state), status.state);
    assert.equal(status.servable, false);
    await assertConsistent(backend);
    // With room again, the download resumes and completes.
    backend.quotaBytes = undefined;
    const resumed = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(fakeProvider()),
    );
    assert.equal(resumed.state, "ready");
  });

  it("refuses to start when the storage budget can't fit the package", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan(), { name: "Budget" });
    const provider = fakeProvider();
    await assert.rejects(
      downloadPackage(
        store,
        created.packageId,
        downloadOptions(provider, {
          estimate: async () => ({ usage: 9_990_000, quota: 10_000_000 }),
        }),
      ),
      { code: "quota" },
    );
    assert.equal(provider.calls.length, 0);
    const status = (await store.getPackage(created.packageId))!;
    assert.equal(status.state, "planned");
    assert.equal(status.manifest.lastError?.code, "quota");
  });

  it("honors Retry-After and never exceeds the provider's parallel request cap", async () => {
    const { store } = newStore();
    const created = await store.createPackage(
      smallPlan({ minZoom: 12, maxZoom: 14, layers: ["ofm-vector", "usgs-topo", "blm-sma"] }),
      { name: "Polite" },
    );
    const provider = fakeProvider({ delayMs: 3 });
    const throttled = new Set<string>();
    provider.override = (url) => {
      if (/\/planet\/[^/]+\/13\/\d+\/\d+\.pbf$/.test(url) && !throttled.size) {
        throttled.add(url);
        return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
      }
      return null;
    };
    const { sleep, delays } = fakeSleep();
    const result = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(provider, { sleep }),
    );
    assert.equal(result.state, "ready", JSON.stringify(result.failed));
    assert.ok(throttled.size === 1, "the throttled tile was requested");
    assert.ok(
      delays.some((ms) => ms >= 6_000 && ms <= 7_000),
      `delays ${delays}`,
    );
    const ofmMax = provider.maxInFlight.get("tiles.openfreemap.org") ?? 0;
    assert.ok(ofmMax >= 2 && ofmMax <= 4, `OpenFreeMap parallel requests: ${ofmMax}`);
    assert.ok((provider.maxInFlight.get("gis.blm.gov") ?? 0) <= 2);
    assert.ok(provider.maxInFlightTotal() <= 6);
    assert.equal(parseRetryAfter("120", 0), 120_000);
    assert.equal(parseRetryAfter(new Date(60_000).toUTCString(), 0), 60_000);
  });

  it("stops requesting a provider that asks to wait too long, and keeps waiting across resumes", async () => {
    const backend = new MemoryBackend();
    const store = new OfflinePackageStore(backend);
    const created = await store.createPackage(
      smallPlan({ layers: ["usgs-topo"], minZoom: 12, maxZoom: 14 }),
      { name: "Wait" },
    );
    const usgsTiles = (await store.getPackage(created.packageId))!.manifest.layers[0].assetCount;
    assert.ok(usgsTiles >= 14, `${usgsTiles} USGS tiles planned`);
    const provider = fakeProvider();
    provider.override = (url) =>
      url.includes("USGSTopo")
        ? new Response("", { status: 429, headers: { "retry-after": "3600" } })
        : null;
    const usgsCalls = () => provider.calls.filter((u) => u.includes("USGSTopo")).length;
    const progress: (number | null)[] = [];
    const result = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(provider, { onProgress: (p) => progress.push(p.waitUntil) }),
    );
    // Only the requests already in flight when the first 429 arrived (≤ the 4-request cap).
    assert.ok(usgsCalls() >= 1 && usgsCalls() <= 4, `USGS requests: ${usgsCalls()}`);
    assert.equal(result.state, "failed");
    assert.equal(result.failed.length, usgsTiles, "every USGS tile reported, none requested again");
    assert.equal(result.status.manifest.lastError?.code, "rate-limited");
    assert.ok(result.status.waitUntil! > Date.now() + 3_500_000);
    assert.ok(
      progress.some((until) => until !== null),
      "progress reports the wait",
    );

    // Resume right away after a restart: nothing goes to USGS before the time.
    _resetProviderBackoff();
    const before = usgsCalls();
    const reopened = new OfflinePackageStore(backend);
    const again = await downloadPackage(reopened, created.packageId, downloadOptions(provider));
    assert.equal(usgsCalls(), before, "no USGS request before the provider's time");
    assert.equal(again.state, "failed");

    // After the time has passed, the remaining tiles download.
    provider.override = null;
    const later = () => Date.now() + 2 * 3_600_000;
    const done = await downloadPackage(
      reopened,
      created.packageId,
      downloadOptions(provider, { now: later }),
    );
    assert.equal(done.state, "ready", JSON.stringify(done.failed.slice(0, 2)));
  });

  it("an expired source makes the package stale (still usable), not silently ready", async () => {
    const { store } = newStore();
    const { packageId } = await readyPackage(store);
    const now = Date.now();
    assert.equal((await store.getPackage(packageId, now))!.state, "ready");
    // OpenFreeMap data is kept current for 60 days; BLM land status (in this package) for 90.
    const later = now + 61 * DAY;
    const stale = (await store.getPackage(packageId, later))!;
    assert.equal(stale.state, "stale");
    assert.equal(stale.stale, true);
    assert.equal(stale.servable, true);
    const coverage = await store.coverage({ lng: -111.5, lat: 34.5 }, later);
    assert.equal(coverage.covered, true);
    assert.equal(coverage.packages[0].state, "stale");
    // Updating a stale package is allowed.
    assert.equal((await store.startUpdate(packageId)).state, "updating");
  });

  it("refuses to package Esri even if a manifest is tampered with", async () => {
    const { backend, store } = newStore();
    const created = await store.createPackage(smallPlan({ layers: ["usgs-topo"] }), {
      name: "Tamper",
    });
    const provider = fakeProvider();
    const first = await downloadPackage(store, created.packageId, downloadOptions(provider));
    assert.equal(first.state, "ready");
    await store.startUpdate(created.packageId);
    await downloadPackage(store, created.packageId, {
      ...downloadOptions(provider),
      signal: AbortSignal.abort(),
    });
    await backend.write(["packageAssets"], async (tx) => {
      const list = (await tx.get<{ urls: string[] }>(
        "packageAssets",
        versionRef(created.packageId, 2),
      ))!;
      list.urls[0] =
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1631/770";
      await tx.put("packageAssets", versionRef(created.packageId, 2), list);
    });
    const calls = provider.calls.length;
    await assert.rejects(downloadPackage(store, created.packageId, downloadOptions(provider)), {
      code: "invalid",
    });
    assert.equal(provider.calls.length, calls);
  });
});

describe("review fixes (wave 2 round 1)", () => {
  it("shares provider limits across concurrent downloads in a tab", async () => {
    const { store } = newStore();
    const plan = (west: number) =>
      smallPlan({
        bounds: { west, south: 34.4, east: west + 0.1, north: 34.6 },
        minZoom: 12,
        maxZoom: 14,
        layers: ["ofm-vector"],
      });
    const a = await store.createPackage(plan(-111.6), { name: "A" });
    const b = await store.createPackage(plan(-110.6), { name: "B" });
    const provider = fakeProvider({ delayMs: 3 });
    const [ra, rb] = await Promise.all([
      downloadPackage(store, a.packageId, downloadOptions(provider)),
      downloadPackage(store, b.packageId, downloadOptions(provider)),
    ]);
    assert.equal(ra.state, "ready");
    assert.equal(rb.state, "ready");
    const ofm = provider.maxInFlight.get("tiles.openfreemap.org") ?? 0;
    assert.ok(ofm >= 3 && ofm <= 4, `OpenFreeMap requests in flight across both: ${ofm}`);
    assert.ok(provider.maxInFlightTotal() <= 6);
  });

  it("lets only one tab download: another tab holding the lock means conflict, no requests", async () => {
    const fakeLocks = (heldElsewhere: boolean) => {
      const log = { requests: 0, released: 0 };
      const locks = {
        request: async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
          log.requests += 1;
          if (heldElsewhere) return callback(null);
          const result = await callback({ name, mode: "exclusive" });
          log.released += 1;
          return result;
        },
      } as unknown as LockManager;
      return { locks, log };
    };
    const { store } = newStore();
    const created = await store.createPackage(smallPlan(), { name: "Locked" });
    const provider = fakeProvider();
    const busy = fakeLocks(true);
    await assert.rejects(
      downloadPackage(store, created.packageId, downloadOptions(provider, { locks: busy.locks })),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "conflict" &&
        /Another Fieldline tab/.test(error.message),
    );
    assert.equal(provider.calls.length, 0);
    assert.equal((await store.getPackage(created.packageId))!.state, "planned");

    // In this tab, concurrent downloads share one lock, released when the last finishes.
    const free = fakeLocks(false);
    const other = await store.createPackage(
      smallPlan({ bounds: { west: -110.52, south: 34.48, east: -110.47, north: 34.52 } }),
      { name: "Other" },
    );
    const results = await Promise.all([
      downloadPackage(store, created.packageId, downloadOptions(provider, { locks: free.locks })),
      downloadPackage(store, other.packageId, downloadOptions(provider, { locks: free.locks })),
    ]);
    assert.deepEqual(
      results.map((r) => r.state),
      ["ready", "ready"],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(free.log, { requests: 1, released: 1 });
  });

  it("keeps every package's vector tiles reachable across OpenFreeMap versions, offline and online", async () => {
    const { store } = newStore();
    const providerA = fakeProvider();
    providerA.ofmVersion = "20260101_a";
    const a = await store.createPackage(smallPlan({ layers: ["ofm-vector"] }), { name: "A" });
    assert.equal(
      (await downloadPackage(store, a.packageId, downloadOptions(providerA))).state,
      "ready",
    );
    const providerB = fakeProvider();
    providerB.ofmVersion = "20260301_b";
    const b = await store.createPackage(
      smallPlan({
        bounds: { west: -110.52, south: 34.48, east: -110.47, north: 34.52 },
        layers: ["ofm-vector"],
      }),
      { name: "B" },
    );
    assert.equal(
      (await downloadPackage(store, b.packageId, downloadOptions(providerB))).state,
      "ready",
    );
    const tileOf = async (id: string) =>
      (await store.getManifest(id))!.requiredAssets
        .find((u) => /\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(u))!
        .match(/(\d+\/\d+\/\d+)\.pbf$/)![1];
    const zxyA = await tileOf(a.packageId);
    const zxyB = await tileOf(b.packageId);

    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: FIXTURE_APP_ORIGIN },
    });
    setPackageTileSource(createPackageTileSource(store));
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    let networkUp = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      networkCalls += 1;
      if (!networkUp) throw new TypeError("offline");
      const url = String(input);
      if (url.endsWith("/planet")) {
        return Response.json({
          tiles: ["https://tiles.openfreemap.org/planet/20261001_live/{z}/{x}/{y}.pbf"],
        });
      }
      return new Response(new TextEncoder().encode(`network ${url}`));
    }) as typeof fetch;
    const abort = new AbortController();
    const text = (r: { data: unknown }) => new TextDecoder().decode(r.data as ArrayBuffer);
    try {
      // Offline: whichever packaged TileJSON the map gets, both packages' tiles load.
      setOnline(false);
      const offlineJson = (await loadTile(
        { url: "fltile://https://tiles.openfreemap.org/planet", type: "json" },
        abort,
      )) as { data: { tiles: string[] } };
      const template = offlineJson.data.tiles[0].replace("fltile://", "");
      assert.match(template, /\/planet\/20260(101_a|301_b)\//);
      const tileA = await loadTile(
        { url: `fltile://${template.replace("{z}/{x}/{y}", zxyA)}` },
        abort,
      );
      const tileB = await loadTile(
        { url: `fltile://${template.replace("{z}/{x}/{y}", zxyB)}` },
        abort,
      );
      assert.match(text(tileA), /20260101_a/);
      assert.match(text(tileB), /20260301_b/);
      assert.equal(networkCalls, 0, "offline: nothing tried the network");

      // Online: the TileJSON comes from the network (current version), and
      // tiles of that version come from the network, not an old package.
      setOnline(true);
      networkUp = true;
      const onlineJson = (await loadTile(
        { url: "fltile://https://tiles.openfreemap.org/planet", type: "json" },
        abort,
      )) as { data: { tiles: string[] } };
      assert.deepEqual(onlineJson.data.tiles, [
        "fltile://https://tiles.openfreemap.org/planet/20261001_live/{z}/{x}/{y}.pbf",
      ]);
      assert.equal(networkCalls, 1);
      const live = await loadTile(
        { url: `fltile://https://tiles.openfreemap.org/planet/20261001_live/${zxyB}.pbf` },
        abort,
      );
      assert.match(text(live), /^network /);
      assert.equal(networkCalls, 2);

      // Online but the request fails (navigator.onLine wrong): packaged copies still answer.
      networkUp = false;
      const fallback = await loadTile(
        { url: `fltile://https://tiles.openfreemap.org/planet/20261001_live/${zxyA}.pbf` },
        abort,
      );
      assert.match(text(fallback), /20260101_a/);
      const jsonFallback = (await loadTile(
        { url: "fltile://https://tiles.openfreemap.org/planet", type: "json" },
        abort,
      )) as { data: { tiles: string[] } };
      assert.match(jsonFallback.data.tiles[0], /\/planet\/20260(101_a|301_b)\//);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never serves any corrupt asset, even beyond the first 50 listed", async () => {
    const { backend, store } = newStore();
    const created = await store.createPackage(smallPlan({ minZoom: 12, maxZoom: 14 }), {
      name: "Many",
    });
    const result = await downloadPackage(store, created.packageId, downloadOptions(fakeProvider()));
    assert.equal(result.state, "ready");
    const manifest = (await store.getManifest(created.packageId))!;
    const urls = manifest.requiredAssets.filter(
      (u) => u !== "https://tiles.openfreemap.org/planet",
    );
    assert.ok(urls.length > 55, `${urls.length} assets`);
    await backend.write(["assets", "assetData"], async (tx) => {
      for (const url of urls) {
        const meta = (await tx.getRange<AssetMeta>("assets", `${url}#`))[0];
        await tx.put(
          "assetData",
          assetKey(meta.url, meta.sha256),
          new Uint8Array(meta.bytes).buffer,
        );
      }
    });
    const verified = await verifyPackage(store, created.packageId);
    assert.equal(verified.corrupt.length, urls.length);
    const preview = verified.status.manifest.integrityStatus.corrupt;
    assert.equal(preview.length, 50);
    const beyond = urls.filter((u) => !preview.includes(u));
    assert.ok(beyond.length > 0);
    for (const url of beyond) assert.equal(await store.readServableAsset(url), null, url);
  });

  it("never follows redirects", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan({ layers: ["usgs-topo"] }), {
      name: "Redirect",
    });
    const provider = fakeProvider();
    let target = "";
    provider.override = (url) => {
      if (!target && url.includes("USGSTopo")) target = url;
      return url === target
        ? new Response(null, { status: 302, headers: { location: "https://evil.example/tile" } })
        : null;
    };
    const result = await downloadPackage(store, created.packageId, downloadOptions(provider));
    assert.ok(provider.inits.every((init) => init?.redirect === "manual"));
    assert.equal(result.state, "failed");
    assert.deepEqual(
      result.failed.map((f) => f.url),
      [target],
    );
    assert.match(result.failed[0].reason, /redirect/);
    assert.equal(provider.calls.filter((u) => u === target).length, 1, "not retried");
    assert.ok(!provider.calls.some((u) => u.includes("evil.example")));
  });

  it("re-checks every checksum inside the commit, so bytes replaced after hashing can't become ready", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan({ layers: ["usgs-topo"] }), {
      name: "Swap",
    });
    const original = store.commitVerification.bind(store);
    let swapped = "";
    store.commitVerification = async (id, version, result) => {
      if (!swapped) {
        const list = (await store.getAssetList(id, version))!;
        swapped = list.urls.find((u) => u.includes("USGSTopo"))!;
        const data = new TextEncoder().encode("replaced by another tab").buffer as ArrayBuffer;
        await store.commitAssets(id, version, [
          {
            url: swapped,
            layerIndex: list.layerIndex[list.urls.indexOf(swapped)],
            sha256: await sha256HexBytes(data),
            bytes: data.byteLength,
            contentType: "image/jpeg",
            status: 200,
            data,
            fetchedAt: Date.now(),
          },
        ]);
      }
      return original(id, version, result);
    };
    const result = await downloadPackage(store, created.packageId, downloadOptions(fakeProvider()));
    assert.notEqual(result.state, "ready");
    assert.equal(result.status.manifest.integrityStatus.status, "damaged");
    assert.deepEqual(result.status.manifest.integrityStatus.corrupt, [swapped]);
  });

  it("counts each asset once toward OpenFreeMap's byte cap when repairing", async () => {
    const { backend, store } = newStore();
    const created = await store.createPackage(smallPlan({ layers: ["ofm-vector"] }), {
      name: "OFM repair",
    });
    assert.equal(
      (await downloadPackage(store, created.packageId, downloadOptions(fakeProvider()))).state,
      "ready",
    );
    const manifest = (await store.getManifest(created.packageId))!;
    const total = manifest.actualBytes;
    const victim = manifest.requiredAssets.find((u) => /\/planet\/.+\.pbf$/.test(u))!;
    const meta = (await store.assetsFor(victim))[0];
    await backend.write(["assetData"], (tx) =>
      tx.put("assetData", assetKey(meta.url, meta.sha256), new Uint8Array(meta.bytes).buffer),
    );
    assert.equal((await verifyPackage(store, created.packageId)).ok, false);
    const provider = fakeProvider();
    const repaired = await repairPackage(
      store,
      created.packageId,
      downloadOptions(provider, {
        // Room for the package once, not for the repaired file twice.
        limitsOverride: { providerMaxBytes: { openfreemap: total + Math.floor(meta.bytes / 2) } },
      }),
    );
    assert.equal(repaired.state, "ready", JSON.stringify(repaired.failed));
    assert.deepEqual(provider.calls, [victim]);
  });

  it("accepts a 404 as 'no tile here' only when it repeats, and reports the count", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan({ layers: ["usgs-topo"] }), {
      name: "Holes",
    });
    const provider = fakeProvider();
    const topo: string[] = [];
    provider.override = (url) => {
      if (!url.includes("USGSTopo")) return null;
      if (!topo.includes(url)) topo.push(url);
      const [flaky, absent] = topo;
      if (url === absent) return new Response("", { status: 404 });
      if (url === flaky && provider.calls.filter((u) => u === flaky).length === 1)
        return new Response("", { status: 404 });
      return null;
    };
    const result = await downloadPackage(store, created.packageId, downloadOptions(provider));
    assert.equal(result.state, "ready");
    const [flaky, absent] = topo;
    assert.equal(provider.calls.filter((u) => u === flaky).length, 2);
    assert.equal(provider.calls.filter((u) => u === absent).length, 2);
    const served = await store.readServableAsset(flaky);
    assert.equal(served?.status, 200, "a transient 404 didn't leave a hole");
    assert.equal((await store.readServableAsset(absent))?.status, 404);
    const integrity = result.status.manifest.integrityStatus;
    assert.equal(integrity.absentCount, 1);
    assert.equal(result.status.manifest.layers.find((l) => l.layerId === "usgs-topo")!.absent, 1);
  });

  it("enforces the package byte cap on real downloaded bytes", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan({ minZoom: 12, maxZoom: 14 }), {
      name: "Too big",
    });
    const planned = (await store.getPackage(created.packageId))!.manifest.requiredAssetCount;
    const provider = fakeProvider();
    const result = await downloadPackage(
      store,
      created.packageId,
      downloadOptions(provider, { limitsOverride: { packageMaxBytes: 3_000 } }),
    );
    assert.equal(result.state, "failed");
    assert.ok(result.failed.some((f) => /A package can be at most/.test(f.reason)));
    assert.ok(result.status.manifest.actualBytes <= 3_000);
    assert.ok(provider.calls.length < planned, `${provider.calls.length} of ${planned} requested`);
  });
});

describe("serving packaged tiles through fltile://", () => {
  it("serves from a ready package with the network down, including TileJSON, glyphs and terrain", async () => {
    const { store } = newStore();
    const { packageId } = await readyPackage(store);
    const manifest = (await store.getManifest(packageId))!;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: FIXTURE_APP_ORIGIN },
    });
    setPackageTileSource(createPackageTileSource(store));
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new TypeError("offline");
    }) as typeof fetch;
    setOnline(false);
    try {
      const abort = new AbortController();
      const tileJson = (await loadTile(
        { url: "fltile://https://tiles.openfreemap.org/planet", type: "json" },
        abort,
      )) as { data: { tiles: string[] } };
      assert.deepEqual(tileJson.data.tiles, [
        "fltile://https://tiles.openfreemap.org/planet/20260101_000000_pt/{z}/{x}/{y}.pbf",
      ]);
      const vector = manifest.requiredAssets.find(
        (u) => u.endsWith(".pbf") && u.includes("/planet/"),
      )!;
      const tile = await loadTile({ url: `fltile://${vector}`, type: "arrayBuffer" }, abort);
      assert.match(new TextDecoder().decode(tile.data as ArrayBuffer), /^fixture r1 /);
      const glyph = await loadTile(
        {
          url: "fltile://https://tiles.openfreemap.org/fonts/Noto Sans Regular/0-255.pbf",
          type: "arrayBuffer",
        },
        abort,
      );
      assert.ok((glyph.data as ArrayBuffer).byteLength > 0);
      const dem = manifest.requiredAssets.find((u) => u.includes("elevation-tiles"))!;
      const [z, x, y] = dem.match(/(\d+)\/(\d+)\/(\d+)\.png$/)!.slice(1);
      const terrain = await loadTile(
        { url: `fltile://${FIXTURE_APP_ORIGIN}/api/dem/${z}/${x}/${y}`, type: "image" },
        abort,
      );
      assert.ok((terrain.data as ArrayBuffer).byteLength > 0);
      assert.equal(networkCalls, 0);
      // Outside the package, the network is used (and here fails).
      await assert.rejects(
        loadTile(
          { url: "fltile://https://tiles.openfreemap.org/planet/20260101_000000_pt/2/1/1.pbf" },
          abort,
        ),
      );
      assert.equal(networkCalls, 1);
      // Other origins' http URLs stay blocked.
      await assert.rejects(
        loadTile({ url: "fltile://http://evil.example/api/dem/1/1/1" }, abort),
        /Blocked/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not serve a package that isn't verified yet", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan(), { name: "Partial" });
    const controller = new AbortController();
    const provider = fakeProvider();
    provider.override = (_url, call) => {
      if (call === 6) controller.abort();
      return null;
    };
    await downloadPackage(
      store,
      created.packageId,
      downloadOptions(provider, { signal: controller.signal }),
    );
    const stored = (await store.getManifest(created.packageId))!.requiredAssets[0];
    assert.ok((await store.assetsFor(stored)).length > 0);
    assert.equal(await store.readServableAsset(stored), null);
  });
});

describe("package coverage (FIELD-01)", () => {
  it("reads coverage from manifests: covering packages, zooms, per-layer completeness", async () => {
    const { store } = newStore();
    const { packageId } = await readyPackage(store);
    const partial = await store.createPackage(
      smallPlan({ bounds: { west: -111.6, south: 34.4, east: -111.4, north: 34.6 }, maxZoom: 12 }),
      { name: "Bigger, unfinished" },
    );
    const inside = await store.coverage({ lng: -111.5, lat: 34.5 });
    assert.equal(inside.covered, true);
    assert.deepEqual(
      inside.packages.map((p) => p.packageId),
      [packageId],
    );
    assert.deepEqual(
      inside.incomplete.map((p) => p.packageId),
      [partial.packageId],
    );
    assert.equal(inside.incomplete[0].state, "planned");
    const topo = inside.packages[0].layers.find((l) => l.layerId === "usgs-topo")!;
    assert.equal(topo.complete, true);
    assert.deepEqual([topo.minZoom, topo.maxZoom], [12, 13]);
    assert.deepEqual(inside.layers["usgs-topo"], [{ minZoom: 12, maxZoom: 13 }]);
    assert.deepEqual(inside.layers.dem, [{ minZoom: 12, maxZoom: 13 }]);

    const outside = await store.coverage({ lng: -100, lat: 40 });
    assert.equal(outside.covered, false);
    assert.equal(outside.packages.length, 0);

    // A view that extends past the package touches it but isn't contained.
    const view = await store.coverage({ west: -111.55, south: 34.45, east: -111.45, north: 34.55 });
    assert.equal(view.covered, false);
    assert.equal(view.packages[0].contains, false);
  });
});
