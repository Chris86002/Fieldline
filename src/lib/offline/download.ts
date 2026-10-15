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
  onProgress?: (progress: DownloadProgress) => void;
  /** Re-download these canonical URLs even if stored (repair of corrupt assets). */
  only?: readonly string[];
  /**
   * Cross-tab lock manager (default `navigator.locks`). Only one tab
   * downloads packages at a time; null disables the lock (tests, runtimes
   * without Web Locks).
   */
  locks?: LockManager | null;
  /** @internal Tests only: lower (never raise) the byte caps. */
  limitsOverride?: {
    providerMaxBytes?: Partial<Record<ProviderId, number>>;
    packageMaxBytes?: number;
  };
};

export type DownloadProgress = {
  done: number;
  total: number;
  failed: number;
  bytes: number;
  /** A provider asked us to stop until this time (ms since epoch); its files wait. */
  waitUntil: number | null;
};

export type DownloadResult = {
  packageId: string;
  state: PackageState;
  status: PackageStatus;
  downloaded: number;
  failed: AssetFailure[];
  persistence: PersistenceResult;
};

type Job = {
  url: string;
  layerIndex: number;
  provider: ProviderId;
  kind: string;
  /** A first 404 was seen; a second one confirms the provider has no tile here. */
  seen404?: boolean;
};

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

/** The provider asked us to wait longer than we will: stop requesting it until `until`. */
class ProviderBackoff extends Error {
  readonly provider: ProviderId;
  readonly until: number;
  constructor(provider: ProviderId, until: number) {
    super(
      `${PROVIDER_NAMES[provider]} asked Fieldline to wait until ${new Date(until).toISOString()}; its files will download when you resume after that.`,
    );
    this.provider = provider;
    this.until = until;
  }
}

/** A first 404: re-queued once before the tile is accepted as absent. */
class Unconfirmed404 extends Error {}

const PROVIDER_NAMES: Record<ProviderId, string> = {
  usgs: "USGS",
  blm: "BLM",
  openfreemap: "OpenFreeMap",
  "aws-terrain": "AWS Terrain Tiles",
};

/**
 * Tab-wide request limits, shared by every download in this tab, so two
 * packages downloading at once still respect each provider's cap.
 */
const sharedGlobal = new Semaphore(DEFAULTS.concurrency);
const sharedLanes = new Map<ProviderId, Semaphore>();
/** Tab-wide "no request before" per provider (Retry-After). */
const sharedNotBefore = new Map<ProviderId, number>();

function laneFor(provider: ProviderId): Semaphore {
  let lane = sharedLanes.get(provider);
  if (!lane) {
    lane = new Semaphore(PROVIDER_LIMITS[provider].maxConcurrency);
    sharedLanes.set(provider, lane);
  }
  return lane;
}

function noteNotBefore(provider: ProviderId, until: number) {
  sharedNotBefore.set(provider, Math.max(sharedNotBefore.get(provider) ?? 0, until));
}

/** @internal Tests: forget tab-wide Retry-After state between cases. */
export function _resetProviderBackoff() {
  sharedNotBefore.clear();
}

const LOCK_NAME = "fieldline-offline-download";
let tabLock: { holders: number; release: () => void } | null = null;
let tabLockPending: Promise<"held" | "busy" | "unsupported"> | null = null;

/**
 * One tab downloads at a time: the first download in a tab takes the
 * `fieldline-offline-download` Web Lock (if it's free) and the tab keeps it
 * while any of its downloads run; downloads in this tab share it. Another tab
 * gets a `conflict` error instead of starting.
 */
async function enterDownloadLock(locks: LockManager | null): Promise<() => void> {
  if (!locks) return () => undefined;
  if (!tabLock) {
    tabLockPending ??= new Promise<"held" | "busy" | "unsupported">((resolve) => {
      locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve("busy");
            return null;
          }
          return new Promise<void>((release) => {
            tabLock = { holders: 0, release };
            resolve("held");
          });
        })
        .catch(() => resolve("unsupported"));
    });
    const outcome = await tabLockPending;
    tabLockPending = null;
    if (outcome === "unsupported") return () => undefined;
    if (outcome === "busy" || !tabLock) {
      throw new StorageError(
        "conflict",
        "Another Fieldline tab or window is downloading a map package. Let it finish (or pause it there), then try again.",
      );
    }
  }
  const held: { holders: number; release: () => void } = tabLock;
  held.holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders === 0) {
      if (tabLock === held) tabLock = null;
      held.release();
    }
  };
}

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
  let leaveLock: () => void = () => undefined;
  let version = 0;
  try {
    leaveLock = await enterDownloadLock(
      options.locks !== undefined ? options.locks : (globalThis.navigator?.locks ?? null),
    );
    const record = await store.getRecord(packageId);
    if (!record) throw new StorageError("not-found", "That offline package no longer exists.");
    // A provider's earlier "wait until" survives restarts: honor it before any request.
    for (const [provider, until] of Object.entries(record.providerNotBefore ?? {}) as [
      ProviderId,
      number,
    ][]) {
      noteNotBefore(provider, until);
    }
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
      local: options.concurrency ? new Semaphore(options.concurrency) : null,
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
    // Real bytes per provider and for the whole package, each asset counted
    // once (a re-downloaded asset replaces its stored size, never adds to it).
    const assetBytes = new Map<string, number>();
    const providerBytes = new Map<ProviderId, number>();
    let packageBytes = 0;
    const account = (url: string, provider: ProviderId, bytes: number) => {
      const delta = bytes - (assetBytes.get(url) ?? 0);
      assetBytes.set(url, bytes);
      providerBytes.set(provider, (providerBytes.get(provider) ?? 0) + delta);
      packageBytes += delta;
    };
    const providerCap = (provider: ProviderId) => {
      const caps = [
        PROVIDER_LIMITS[provider].maxBytesPerPackage,
        options.limitsOverride?.providerMaxBytes?.[provider],
      ];
      const set = caps.filter((c): c is number => typeof c === "number");
      return set.length ? Math.min(...set) : null;
    };
    const packageCap = Math.min(
      PACKAGE_LIMITS.maxBytes,
      options.limitsOverride?.packageMaxBytes ?? PACKAGE_LIMITS.maxBytes,
    );
    const jobs: Job[] = [];
    list.urls.forEach((url, i) => {
      const layerIndex = list.layerIndex[i];
      const rule = packageRuleFor(url)!;
      const have = stored.get(url);
      if (have) account(url, rule.provider, have.bytes);
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
        account(jobs[i].url, jobs[i].provider, bytes);
        jobs.splice(i, 1);
      }
    }

    const failures: AssetFailure[] = [];
    /** Providers that asked us to stop until a time beyond our wait cap. */
    const blockedUntil = new Map<ProviderId, number>();
    let stopAll: string | null = null;
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
            waitUntil: blockedUntil.size ? Math.max(...blockedUntil.values()) : null,
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
      let stopProvider: string | null = null;
      const worker = async () => {
        while (providerJobs.length && !runSignal.aborted) {
          const stop = stopAll ?? stopProvider;
          if (stop) {
            // Never requested: they stay missing and are fetched on a later resume.
            for (const job of providerJobs.splice(0)) failures.push({ url: job.url, reason: stop });
            return;
          }
          const job = providerJobs.shift()!;
          try {
            const asset = await fetchAsset(job, net);
            const cap = providerCap(provider);
            const previous = assetBytes.get(job.url) ?? 0;
            if (cap !== null && (providerBytes.get(provider) ?? 0) + asset.bytes - previous > cap) {
              stopProvider = `${PROVIDER_NAMES[provider]} allows at most ${mb(cap)} per download; this package reached that limit.`;
              failures.push({ url: job.url, reason: stopProvider });
              continue;
            }
            if (packageBytes + asset.bytes - previous > packageCap) {
              stopAll = `A package can be at most ${mb(packageCap)}; this one reached that limit. Choose a smaller area or fewer layers.`;
              failures.push({ url: job.url, reason: stopAll });
              continue;
            }
            account(job.url, provider, asset.bytes);
            enqueue(asset);
          } catch (error) {
            if (error instanceof Unconfirmed404) {
              // Ask again later in the run before accepting "no tile here".
              job.seen404 = true;
              providerJobs.push(job);
              continue;
            }
            if (error instanceof ProviderBackoff) {
              blockedUntil.set(provider, Math.max(blockedUntil.get(provider) ?? 0, error.until));
              stopProvider = error.message;
              failures.push({ url: job.url, reason: error.message });
              continue;
            }
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
        blockedUntil,
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
    leaveLock();
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
  /** Optional per-call cap (`concurrency` option), below the tab-wide limits. */
  local: Semaphore | null;
  now: () => number;
};

async function fetchAsset(job: Job, net: NetContext): Promise<FetchedAsset> {
  const rule = packageRuleFor(job.url);
  if (!rule) throw new PermanentFailure("Not a source that permits offline storage.");
  const target = fetchUrlFor(job.url, net.appOrigin);
  let lastError = "failed";
  /** Throws ProviderBackoff when the provider's "wait until" is beyond our cap. */
  const checkBlocked = () => {
    const until = sharedNotBefore.get(job.provider) ?? 0;
    if (until - net.now() > net.maxRetryAfterMs) throw new ProviderBackoff(job.provider, until);
    return until - net.now();
  };
  for (let attempt = 1; attempt <= net.maxAttempts; attempt += 1) {
    const wait = checkBlocked();
    if (wait > 0) await net.sleep(wait, net.signal);
    if (net.signal?.aborted) throw abortError(net.signal);
    const lane = laneFor(job.provider);
    await lane.acquire();
    await net.local?.acquire();
    await sharedGlobal.acquire();
    let retryAfter: number | null = null;
    try {
      // Another download may have been told to stop while we waited for a slot.
      checkBlocked();
      if (net.signal?.aborted) throw abortError(net.signal);
      const timeout = AbortSignal.timeout(net.timeoutMs);
      const signal = net.signal ? AbortSignal.any([net.signal, timeout]) : timeout;
      const response = await net.fetchFn(target, {
        signal,
        credentials: "omit",
        headers: net.headers,
        // Never follow a redirect: no request may reach a host that isn't allowlisted.
        redirect: "manual",
      });
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && !responseHostAllowed(response.url, target))
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new PermanentFailure("The provider redirected elsewhere; redirects aren't followed.");
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        if (!job.seen404) throw new Unconfirmed404();
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
          // Stop asking this provider for the rest of the run (and across resumes, until then).
          noteNotBefore(job.provider, net.now() + retryAfter);
          throw new ProviderBackoff(job.provider, net.now() + retryAfter);
        }
        const delay = retryAfter ?? backoff(attempt, net.random);
        noteNotBefore(job.provider, net.now() + delay);
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
      if (
        error instanceof PermanentFailure ||
        error instanceof ProviderBackoff ||
        error instanceof Unconfirmed404
      )
        throw error;
      if (net.signal?.aborted) throw abortError(net.signal);
      lastError =
        error instanceof Error && error.name === "TimeoutError" ? "timed out" : "network error";
    } finally {
      sharedGlobal.release();
      net.local?.release();
      lane.release();
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
  blocked: Map<ProviderId, number> = new Map(),
): Promise<DownloadResult> {
  const paused = signal?.aborted;
  const waitUntil = blocked.size ? Math.max(...blocked.values()) : null;
  await store.updateTarget(packageId, version, (m, record) => {
    const at = now();
    const kept = Object.entries(record.providerNotBefore ?? {}).filter(([, until]) => until > at);
    record.providerNotBefore = Object.fromEntries([...kept, ...blocked]);
    m.phase = paused ? "paused" : "failed";
    m.lastError = paused
      ? null
      : waitUntil !== null
        ? {
            code: "rate-limited",
            message: `${[...blocked.keys()].map((p) => PROVIDER_NAMES[p]).join(", ")} asked Fieldline to pause downloads until ${new Date(waitUntil).toLocaleString()}. ${failures.length} map file${failures.length === 1 ? "" : "s"} will download when you resume after that.`,
            at,
          }
        : {
            code: "network",
            message: `${failures.length} map file${failures.length === 1 ? "" : "s"} couldn't be downloaded. Retry to fetch only those.`,
            at,
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
