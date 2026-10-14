import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryBackend, StorageError } from "../storage/backend.ts";
import { loadTile, setPackageTileSource } from "../hunt/tiles.ts";
import { downloadPackage, parseRetryAfter, repairPackage } from "./download.ts";
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

afterEach(() => {
  setPackageTileSource(null);
  Reflect.deleteProperty(globalThis, "location");
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
    assert.equal(failed.status.state, "updating");
    assert.equal(failed.status.update?.phase, "failed");
    assert.equal(failed.status.activeVersion, 1);
    assert.equal(failed.status.manifest.phase, "ready");
    assert.match((await servedText())!, /^fixture r1 /, "old version still served");

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
    assert.equal(result.status.state, "updating");
    assert.equal(result.status.update?.integrityStatus.status, "damaged");
    assert.equal(result.status.activeVersion, 1);
    assert.equal(result.status.servable, true);
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

  it("gives up on an asset when the provider asks to wait too long, leaving the package failed", async () => {
    const { store } = newStore();
    const created = await store.createPackage(smallPlan({ layers: ["usgs-topo"] }), {
      name: "Wait",
    });
    const provider = fakeProvider();
    provider.override = (url) =>
      url.includes("USGSTopo")
        ? new Response("", { status: 503, headers: { "retry-after": "3600" } })
        : null;
    const result = await downloadPackage(store, created.packageId, downloadOptions(provider));
    assert.equal(result.state, "failed");
    assert.match(result.failed[0].reason, /asked to wait 3600 s/);
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
