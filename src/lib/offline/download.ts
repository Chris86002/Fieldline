import { StorageError, isStorageError } from "../storage/backend.ts";
import { sha256HexBytes } from "../storage/digest.ts";
import {
  estimateStorage,
  requestPersistentStorage,
  type PersistenceResult,
} from "../storage/indexeddb.ts";
import {
  workTarget,
  type AssetFailure,
  type FetchedAsset,
  type ManifestSummary,
  type OfflinePackageStore,
  type PackageState,
  type PackageStatus,
} from "./package-store.ts";
import { layerAssetUrls } from "./plan.ts";
import {
  fetchUrlFor,
  OFM_TILEJSON_URL,
  ofmTemplateFromTileJson,
  PACKAGE_LAYERS,
  PACKAGE_LIMITS,
  packageRuleFor,
  PROVIDER_LIMITS,
  type PackageLayerId,
  type ProviderId,
} from "./sources.ts";
import { verifyPackage } from "./verify.ts";

/**
 * Resumable offline package downloader.
 *
 * - Progress is persisted per asset (each stored asset carries the package
 *   version's reference), so a restarted download fetches only what's missing.
 * - Bounded concurrency per provider (OpenFreeMap ≤ 4) and overall, timeouts,
 *   exponential backoff, and Retry-After on 429/503.
 * - Only canonical URLs that `packageRuleFor` accepts are fetched: Esri and
 *   any other host are impossible. OpenFreeMap's 3,000-tile / 50 MB limits
 *   are re-checked against real bytes while downloading.
 * - Abort the signal to pause. Storage failures (quota) reject with a typed
 *   `StorageError` and leave the package "failed"; network failures leave it
 *   "failed" with the list of files that didn't download. Only a full
 *   verification makes it "ready".
 */

export type DownloadOptions = {
  fetch?: typeof fetch;
  /** Abort to pause. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0..1, for backoff jitter. */
  random?: () => number;
  /** Per request, default 20 s. */
  timeoutMs?: number;
  /** Attempts per asset, default 4. */
  maxAttempts?: number;
  /** A Retry-After longer than this fails the asset for this run instead of waiting. Default 120 s. */
  maxRetryAfterMs?: number;
  /** Overall parallel requests, default 6 (each provider has its own lower cap). */
  concurrency?: number;
  /** The app's origin, for terrain tiles fetched through /api/dem. Default `location.origin`. */
  appOrigin?: string | null;
  /**
   * Extra request headers, e.g. an identifying User-Agent where the runtime
   * allows setting one (desktop). Browsers don't let pages set User-Agent.
   */
  requestHeaders?: Record<string, string>;
  persist?: () => Promise<PersistenceResult>;
  estimate?: () => Promise<{ usage: number | null; quota: number | null }>;
  onProgress?: (progress: { done: number; total: number; failed: number; bytes: number }) => void;
  /** Re-download these canonical URLs even if stored (repair of corrupt assets). */
  only?: readonly string[];
};

export type DownloadResult = {
  packageId: string;
  state: PackageState;
  status: PackageStatus;
  downloaded: number;
  failed: AssetFailure[];
  persistence: PersistenceResult;
};

type Job = { url: string; layerIndex: number; provider: ProviderId; kind: string };

/** Copies another package fetched within this window are shared instead of re-downloaded. */
const ADOPT_MAX_AGE_MS = 7 * 86_400_000;

const DEFAULTS = {
  timeoutMs: 20_000,
  maxAttempts: 4,
  maxRetryAfterMs: 120_000,
  concurrency: 6,
  batchSize: 32,
};

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Paused", "AbortError");
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds from now. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

class PermanentFailure extends Error {}

const EXPECTED_TYPES: Record<string, RegExp> = {
  raster: /^image\//i,
  terrain: /^image\/png/i,
  vector: /(protobuf|octet-stream|vnd\.mapbox-vector-tile|application\/x-pbf)/i,
  glyphs: /(protobuf|octet-stream|application\/x-pbf)/i,
  tilejson: /json/i,
};

/**
 * Downloads (or resumes, or repairs) a package's working version, then
 * verifies it. Resolves with the resulting state; rejects only with a
 * `StorageError` (quota, not-found, conflict, invalid).
 */
export async function downloadPackage(
  store: OfflinePackageStore,
  packageId: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const now = options.now ?? Date.now;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const appOrigin =
    options.appOrigin !== undefined ? options.appOrigin : (globalThis.location?.origin ?? null);
  const signal = options.signal;

  store.claim(packageId);
  let version = 0;
  try {
    const record = await store.getRecord(packageId);
    if (!record) throw new StorageError("not-found", "That offline package no longer exists.");
    const target = workTarget(record);
    if (!target) {
      return {
        packageId,
        state: store.statusOf(record).state,
        status: store.statusOf(record),
        downloaded: 0,
        failed: [],
        persistence: record.persistence ?? "unsupported",
      };
    }
    version = target.version;

    // Ask the browser not to evict packages, and report the answer.
    const persistence = await (options.persist ?? requestPersistentStorage)();

    // Budget: refuse to start when the estimate can't fit (nothing is changed but lastError).
    const remaining = Math.max(0, target.expectedBytes - target.actualBytes);
    const { usage, quota } = await (options.estimate ?? estimateStorage)();
    if (usage !== null && quota !== null && remaining * 1.1 > quota - usage) {
      const message = `Not enough storage for this package: it needs about ${mb(remaining)} and ${mb(Math.max(0, quota - usage))} is free. Delete another package or choose a smaller area.`;
      await store.updateTarget(packageId, version, (m, r) => {
        m.lastError = { code: "quota", message, at: now() };
        r.persistence = persistence;
      });
      throw new StorageError("quota", message);
    }

    const net: NetContext = {
      fetchFn,
      sleep,
      random,
      timeoutMs,
      maxAttempts,
      maxRetryAfterMs,
      appOrigin,
      signal,
      headers: options.requestHeaders ?? {},
      notBefore: new Map(),
      global: new Semaphore(options.concurrency ?? DEFAULTS.concurrency),
      lanes: new Map(),
      now,
    };

    await store.updateTarget(packageId, version, (m, r) => {
      m.phase = "downloading";
      m.downloadStartedAt ??= now();
      m.lastError = null;
      m.failures = [];
      m.progress.failed = 0;
      r.persistence = persistence;
    });

    // Resolve versioned sources (OFM TileJSON) and the required asset list.
    let current = (await store.getRecord(packageId))!;
    let working = workTarget(current)!;
    if (!working.assetsResolved) {
      let resolved: Awaited<ReturnType<typeof resolveAssets>>;
      try {
        resolved = await resolveAssets(store, packageId, working, net);
      } catch (error) {
        if (!signal?.aborted || isStorageError(error)) throw error;
        resolved = { failure: { url: OFM_TILEJSON_URL, reason: "paused" } };
      }
      if ("failure" in resolved) {
        return await finishFailed(
          store,
          packageId,
          version,
          [resolved.failure],
          persistence,
          signal,
          now,
        );
      }
      current = (await store.getRecord(packageId))!;
      working = workTarget(current)!;
    }

    const list = await store.getAssetList(packageId, version);
    if (!list) throw new StorageError("not-found", "The package's asset list is missing.");
    for (const url of list.urls) {
      if (!packageRuleFor(url))
        throw new StorageError(
          "invalid",
          `Refusing to download ${url}: not a source that permits offline storage.`,
        );
    }
    const stored = await store.storedAssets(packageId, version, list.urls);
    const only = new Set(options.only ?? []);
    const providerBytes = new Map<ProviderId, number>();
    const jobs: Job[] = [];
    list.urls.forEach((url, i) => {
      const layerIndex = list.layerIndex[i];
      const rule = packageRuleFor(url)!;
      const have = stored.get(url);
      if (have)
        providerBytes.set(rule.provider, (providerBytes.get(rule.provider) ?? 0) + have.bytes);
      if (!have || only.has(url))
        jobs.push({ url, layerIndex, provider: rule.provider, kind: rule.kind });
    });
    // Recount persisted progress (it is the source of truth after a restart).
    await store.updateTarget(packageId, version, (m) => {
      m.progress.done = stored.size;
      m.layers.forEach((layer, index) => {
        layer.done = list.urls.filter(
          (url, i) => list.layerIndex[i] === index && stored.has(url),
        ).length;
      });
    });
    // Share recent copies other packages already hold instead of downloading
    // them again. An update only shares copies fetched since it started.
    const isUpdate = Boolean(current.active && current.pending?.version === version);
    const fetchedSince = Math.max(now() - ADOPT_MAX_AGE_MS, isUpdate ? working.createdAt : 0);
    const adoptable = jobs.filter((job) => !only.has(job.url) && !stored.has(job.url));
    if (adoptable.length) {
      const adopted = await store.adoptExisting(packageId, version, adoptable, fetchedSince);
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        const bytes = adopted.get(jobs[i].url);
        if (bytes === undefined) continue;
        providerBytes.set(jobs[i].provider, (providerBytes.get(jobs[i].provider) ?? 0) + bytes);
        jobs.splice(i, 1);
      }
    }

    const failures: AssetFailure[] = [];
    let downloaded = 0;
    let writeError: unknown = null;
    const internal = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
    net.signal = runSignal;

    // Batched, ordered writes: each batch is one transaction (bytes + metadata + reference + progress).
    const queue: FetchedAsset[] = [];
    let flushing: Promise<void> | null = null;
    const flush = async () => {
      // Never finish synchronously: `flushing` is assigned after this returns.
      await Promise.resolve();
      while (queue.length && !writeError) {
        const batch = queue.splice(0, DEFAULTS.batchSize);
        try {
          const updated = await store.commitAssets(packageId, version, batch);
          downloaded += batch.length;
          const m = workTarget(updated) ?? updated.active!;
          options.onProgress?.({
            done: m.progress.done,
            total: m.progress.total,
            failed: failures.length,
            bytes: m.actualBytes,
          });
        } catch (error) {
          writeError = error;
          internal.abort(new DOMException("Storage failed", "AbortError"));
        }
      }
      flushing = null;
    };
    const enqueue = (asset: FetchedAsset) => {
      if (writeError) return; // Storage already failed; this asset is fetched again on resume.
      queue.push(asset);
      flushing ??= flush();
    };

    const byProvider = new Map<ProviderId, Job[]>();
    for (const job of jobs) {
      const list = byProvider.get(job.provider) ?? [];
      list.push(job);
      byProvider.set(job.provider, list);
    }
    const workers: Promise<void>[] = [];
    for (const [provider, providerJobs] of byProvider) {
      const limits = PROVIDER_LIMITS[provider];
      const lane = new Semaphore(limits.maxConcurrency);
      net.lanes.set(provider, lane);
      let stopProvider: string | null = null;
      const worker = async () => {
        while (providerJobs.length && !runSignal.aborted) {
          if (stopProvider) {
            for (const job of providerJobs.splice(0))
              failures.push({ url: job.url, reason: stopProvider });
            return;
          }
          const job = providerJobs.shift()!;
          try {
            const asset = await fetchAsset(job, net);
            if (limits.maxBytesPerPackage !== null) {
              const total = (providerBytes.get(provider) ?? 0) + asset.bytes;
              if (total > limits.maxBytesPerPackage) {
                stopProvider = `OpenFreeMap allows at most ${mb(limits.maxBytesPerPackage)} per download; this package reached that limit.`;
                failures.push({ url: job.url, reason: stopProvider });
                continue;
              }
              providerBytes.set(provider, total);
            }
            enqueue(asset);
          } catch (error) {
            if (runSignal.aborted) {
              // Paused or storage failed: the job stays undone and is fetched on resume.
              return;
            }
            failures.push({
              url: job.url,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };
      for (let i = 0; i < limits.maxConcurrency; i += 1) workers.push(worker());
    }
    await Promise.all(workers);
    while (flushing) await flushing;

    if (writeError) {
      const error = isStorageError(writeError)
        ? writeError
        : new StorageError("unavailable", "Saving the package failed.", { cause: writeError });
      await markFailed(store, packageId, version, error.code, error.message, failures, now);
      throw error;
    }
    if (signal?.aborted) {
      const updated = await store
        .updateTarget(packageId, version, (m) => {
          m.phase = "paused";
        })
        .catch(() => null);
      const status = updated ? store.statusOf(updated) : await store.getPackage(packageId);
      return {
        packageId,
        state: status?.state ?? "paused",
        status: status!,
        downloaded,
        failed: failures,
        persistence,
      };
    }
    if (failures.length) {
      return await finishFailed(
        store,
        packageId,
        version,
        failures,
        persistence,
        signal,
        now,
        downloaded,
      );
    }
    store.release(packageId);
    const verified = await verifyPackage(store, packageId, { now });
    return {
      packageId,
      state: verified.status.state,
      status: verified.status,
      downloaded,
      failed: [],
      persistence,
    };
  } finally {
    store.release(packageId);
  }
}

/** Re-downloads only the assets the last verification found missing or corrupt, then verifies. */
export async function repairPackage(
  store: OfflinePackageStore,
  packageId: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const record = await store.getRecord(packageId);
  if (!record) throw new StorageError("not-found", "That offline package no longer exists.");
  let target = workTarget(record);
  if (!target) {
    // A ready package: re-check it first; repair only if that finds damage.
    const verified = await verifyPackage(store, packageId, { now: options.now });
    if (verified.ok) {
      return {
        packageId,
        state: verified.status.state,
        status: verified.status,
        downloaded: 0,
        failed: [],
        persistence: record.persistence ?? "unsupported",
      };
    }
    target = workTarget((await store.getRecord(packageId))!)!;
  }
  const list = await store.getAssetList(packageId, target.version);
  const only = list ? [...list.missing, ...list.corrupt] : [];
  return downloadPackage(store, packageId, { ...options, only });
}

type NetContext = {
  fetchFn: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  timeoutMs: number;
  maxAttempts: number;
  maxRetryAfterMs: number;
  appOrigin: string | null;
  signal: AbortSignal | undefined;
  headers: Record<string, string>;
  /** Per provider: no request before this time (Retry-After). */
  notBefore: Map<ProviderId, number>;
  global: Semaphore;
  lanes: Map<ProviderId, Semaphore>;
  now: () => number;
};

async function fetchAsset(job: Job, net: NetContext): Promise<FetchedAsset> {
  const rule = packageRuleFor(job.url);
  if (!rule) throw new PermanentFailure("Not a source that permits offline storage.");
  const target = fetchUrlFor(job.url, net.appOrigin);
  let lastError = "failed";
  for (let attempt = 1; attempt <= net.maxAttempts; attempt += 1) {
    const wait = (net.notBefore.get(job.provider) ?? 0) - net.now();
    if (wait > 0) await net.sleep(wait, net.signal);
    if (net.signal?.aborted) throw abortError(net.signal);
    const lane = net.lanes.get(job.provider);
    await lane?.acquire();
    await net.global.acquire();
    let retryAfter: number | null = null;
    try {
      const timeout = AbortSignal.timeout(net.timeoutMs);
      const signal = net.signal ? AbortSignal.any([net.signal, timeout]) : timeout;
      const response = await net.fetchFn(target, {
        signal,
        credentials: "omit",
        headers: net.headers,
      });
      if (response.url && !responseHostAllowed(response.url, target)) {
        throw new PermanentFailure("The provider redirected to a host that isn't allowed.");
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return {
          url: job.url,
          layerIndex: job.layerIndex,
          sha256: await sha256HexBytes(new ArrayBuffer(0)),
          bytes: 0,
          contentType: "",
          status: 404,
          data: new ArrayBuffer(0),
          fetchedAt: net.now(),
        };
      }
      if (response.status === 429 || response.status === 503) {
        retryAfter = parseRetryAfter(response.headers.get("retry-after"), net.now());
        await response.body?.cancel().catch(() => undefined);
        lastError = `HTTP ${response.status}`;
        if (retryAfter !== null && retryAfter > net.maxRetryAfterMs) {
          throw new PermanentFailure(
            `The provider asked to wait ${Math.round(retryAfter / 1000)} s; try again later.`,
          );
        }
        const delay = retryAfter ?? backoff(attempt, net.random);
        net.notBefore.set(
          job.provider,
          Math.max(net.notBefore.get(job.provider) ?? 0, net.now() + delay),
        );
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        lastError = `HTTP ${response.status}`;
      } else if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new PermanentFailure(`HTTP ${response.status}`);
      } else {
        const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
        const expected = EXPECTED_TYPES[job.kind];
        if (contentType && expected && !expected.test(contentType)) {
          await response.body?.cancel().catch(() => undefined);
          throw new PermanentFailure(
            `Unexpected ${contentType} response (a provider error page?).`,
          );
        }
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > PACKAGE_LIMITS.maxAssetBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new PermanentFailure("File too large.");
        }
        const data = await response.arrayBuffer();
        if (data.byteLength > PACKAGE_LIMITS.maxAssetBytes)
          throw new PermanentFailure("File too large.");
        if (data.byteLength === 0) throw new PermanentFailure("Empty response.");
        return {
          url: job.url,
          layerIndex: job.layerIndex,
          sha256: await sha256HexBytes(data),
          bytes: data.byteLength,
          contentType,
          status: 200,
          data,
          fetchedAt: net.now(),
        };
      }
    } catch (error) {
      if (error instanceof PermanentFailure) throw error;
      if (net.signal?.aborted) throw abortError(net.signal);
      lastError =
        error instanceof Error && error.name === "TimeoutError" ? "timed out" : "network error";
    } finally {
      net.global.release();
      lane?.release();
    }
    if (attempt < net.maxAttempts && retryAfter === null) {
      await net.sleep(backoff(attempt, net.random), net.signal);
    }
  }
  throw new Error(`${lastError} after ${net.maxAttempts} attempts`);
}

function backoff(attempt: number, random: () => number): number {
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

function responseHostAllowed(responseUrl: string, requested: string): boolean {
  try {
    return new URL(responseUrl).origin === new URL(requested).origin;
  } catch {
    return false;
  }
}

/** Fetches OFM's TileJSON (when included), records its tile version, and saves the asset list. */
async function resolveAssets(
  store: OfflinePackageStore,
  packageId: string,
  manifest: ManifestSummary,
  net: NetContext,
): Promise<{ ok: true } | { failure: AssetFailure }> {
  const templates: Partial<Record<PackageLayerId, string>> = {};
  const sourceVersions: Record<string, string | null> = {};
  let tileJson: FetchedAsset | null = null;
  const ofmIndex = manifest.layers.findIndex((layer) => layer.layerId === "ofm-vector");
  if (ofmIndex >= 0) {
    try {
      net.lanes.set("openfreemap", new Semaphore(PROVIDER_LIMITS.openfreemap.maxConcurrency));
      tileJson = await fetchAsset(
        { url: OFM_TILEJSON_URL, layerIndex: ofmIndex, provider: "openfreemap", kind: "tilejson" },
        net,
      );
      const parsed = ofmTemplateFromTileJson(JSON.parse(new TextDecoder().decode(tileJson.data)));
      if (!parsed) throw new Error("OpenFreeMap returned an unexpected tile description.");
      templates["ofm-vector"] = parsed.template;
      sourceVersions["ofm-vector"] = parsed.version;
    } catch (error) {
      if (net.signal?.aborted) throw error;
      return {
        failure: {
          url: OFM_TILEJSON_URL,
          reason: error instanceof Error ? error.message : "OpenFreeMap couldn't be reached.",
        },
      };
    }
  }
  const urls: string[] = [];
  const layerIndex: number[] = [];
  manifest.layers.forEach((layer, index) => {
    const template = templates[layer.layerId] ?? layer.template;
    const def = PACKAGE_LAYERS[layer.layerId];
    if (def.kind === "vector") {
      urls.push(OFM_TILEJSON_URL);
      layerIndex.push(index);
    }
    for (const url of layerAssetUrls(layer, template)) {
      urls.push(url);
      layerIndex.push(index);
    }
  });
  for (const url of urls) {
    if (!packageRuleFor(url))
      throw new StorageError(
        "invalid",
        `Refusing to package ${url}: not a source that permits offline storage.`,
      );
  }
  for (const [provider, limits] of Object.entries(PROVIDER_LIMITS) as [
    ProviderId,
    (typeof PROVIDER_LIMITS)[ProviderId],
  ][]) {
    if (limits.maxAssetsPerPackage === null) continue;
    const count = urls.filter((url) => packageRuleFor(url)?.provider === provider).length;
    if (count > limits.maxAssetsPerPackage)
      throw new StorageError(
        "invalid",
        `This package needs ${count} files from ${provider}; the limit is ${limits.maxAssetsPerPackage}.`,
      );
  }
  if (urls.length > PACKAGE_LIMITS.maxAssets)
    throw new StorageError(
      "invalid",
      `This package needs ${urls.length} files; the limit is ${PACKAGE_LIMITS.maxAssets}.`,
    );
  await store.saveAssetList(
    packageId,
    manifest.version,
    { urls, layerIndex },
    { templates, sourceVersions },
  );
  if (tileJson) await store.commitAssets(packageId, manifest.version, [tileJson]);
  return { ok: true };
}

async function markFailed(
  store: OfflinePackageStore,
  packageId: string,
  version: number,
  code: string,
  message: string,
  failures: AssetFailure[],
  now: () => number,
) {
  await store
    .updateTarget(packageId, version, (m) => {
      m.phase = "failed";
      m.lastError = { code, message, at: now() };
      m.failures = failures.slice(0, 50);
      m.progress.failed = failures.length;
    })
    .catch(() => undefined); // The record then reads as an interrupted download (paused), never ready.
}

async function finishFailed(
  store: OfflinePackageStore,
  packageId: string,
  version: number,
  failures: AssetFailure[],
  persistence: PersistenceResult,
  signal: AbortSignal | undefined,
  now: () => number,
  downloaded = 0,
): Promise<DownloadResult> {
  const paused = signal?.aborted;
  await store.updateTarget(packageId, version, (m) => {
    m.phase = paused ? "paused" : "failed";
    m.lastError = paused
      ? null
      : {
          code: "network",
          message: `${failures.length} map file${failures.length === 1 ? "" : "s"} couldn't be downloaded. Retry to fetch only those.`,
          at: now(),
        };
    m.failures = paused ? [] : failures.slice(0, 50);
    m.progress.failed = paused ? 0 : failures.length;
  });
  const status = (await store.getPackage(packageId))!;
  return {
    packageId,
    state: status.state,
    status,
    downloaded,
    failed: paused ? [] : failures,
    persistence,
  };
}

function mb(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 100_000) / 10)} MB`;
}
