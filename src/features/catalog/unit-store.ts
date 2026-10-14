/**
 * Versioned local copy of one provider's hunt units, with protected
 * promotion (spec §6 ingestion, REL-05; fixes finding H).
 *
 * - The stored copy is one Cache Storage entry holding a manifest and the
 *   processed units, so promotion is a single atomic `put`.
 * - A download replaces the copy only after validation passes. Empty,
 *   truncated, malformed, out-of-coverage or sharply shrunken downloads are
 *   quarantined: the last good copy stays and the result is "stale".
 * - A copy older than the refresh policy is still returned ("stale") when a
 *   refresh fails. With no good copy a failure is "unavailable".
 * - Concurrent loads share one job; finished jobs (good or bad) are never
 *   cached as promises, so the next load re-evaluates.
 */
import type { Bounds, HuntUnit, UnitLoadResult } from "./types.ts";
import { boundsContain } from "./unit-geometry.ts";

export const UNIT_CACHE_NAME = "fieldline-units-v3";
export const UNIT_SCHEMA_VERSION = 3;
const KEY_ROOT = "https://fieldline.local/units/v3/";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A copy older than this is "stale" and a refresh is attempted. */
export const DEFAULT_REFRESH_MS = 30 * DAY_MS;
/** After a failed refresh, wait this long before contacting the provider again. */
export const DEFAULT_RETRY_MS = 5 * 60 * 1000;
/** Fraction of units that may disappear between versions before the update is quarantined. */
export const DEFAULT_MAX_DROP_RATIO = 0.2;
/** Unit bounds may extend this far (degrees) beyond the provider's coverage boxes. */
const COVERAGE_TOLERANCE = 0.25;
const MAX_UNITS = 5000;

export type UnitManifest = {
  schemaVersion: number;
  providerId: string;
  /** When this copy's features were downloaded (ms). */
  retrievedAt: number;
  /** When the provider last confirmed this copy is current (ms); drives the refresh policy. */
  checkedAt: number;
  /** Provider's edit/version marker, or null when it publishes none. */
  sourceVersion: string | null;
  /** Raw features received. */
  featureCount: number;
  /** Server's returnCountOnly answer for the same query, or null if not known. */
  expectedCount: number | null;
  unitCount: number;
  /** Deterministic transformation settings (query and simplification) used to build the copy. */
  transform: string;
};

export type UnitSnapshot = { manifest: UnitManifest; units: HuntUnit[] };

/** What a provider download produced, before validation. */
export type UnitCandidate = {
  units: HuntUnit[];
  featureCount: number;
  expectedCount: number | null;
  sourceVersion: string | null;
};

/** A download that confirmed the stored copy is still current without refetching features. */
export type UnitUnchanged = { unchanged: true; sourceVersion: string | null; expectedCount: number | null };

export type UnitDownload = (context: {
  previous: UnitManifest | null;
  signal: AbortSignal;
}) => Promise<UnitCandidate | UnitUnchanged>;

/** A rejected (quarantined) download, kept for review. */
export type UnitRejection = {
  providerId: string;
  rejectedAt: number;
  reason: string;
  featureCount: number | null;
  expectedCount: number | null;
  unitCount: number | null;
  sourceVersion: string | null;
};

/** Thrown by downloads when the provider's data fails provider-specific checks. */
export class UnitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitValidationError";
  }
}

export type UnitStorage = {
  /** Raw stored JSON for the provider, or null. Never throws. */
  read(providerId: string): Promise<unknown>;
  /** Stores the snapshot atomically. Resolves false when storage is unavailable. Never throws. */
  write(snapshot: UnitSnapshot): Promise<boolean>;
  /** Records a rejected download for review. Never throws. */
  quarantine(record: UnitRejection): Promise<void>;
};

function keyFor(providerId: string, suffix = ""): string {
  return `${KEY_ROOT}${encodeURIComponent(providerId)}${suffix}.json`;
}

/** Cache Storage backend. Degrades to "nothing stored" when `caches` is missing or blocked. */
export function cacheUnitStorage(cacheName = UNIT_CACHE_NAME): UnitStorage {
  const open = async () => (typeof caches === "undefined" ? null : caches.open(cacheName));
  const put = async (key: string, value: unknown) => {
    const cache = await open();
    if (!cache) return false;
    await cache.put(key, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
    return true;
  };
  return {
    async read(providerId) {
      try {
        const cache = await open();
        const hit = cache ? await cache.match(keyFor(providerId)) : undefined;
        return hit ? ((await hit.json()) as unknown) : null;
      } catch {
        return null;
      }
    },
    async write(snapshot) {
      try {
        return await put(keyFor(snapshot.manifest.providerId), snapshot);
      } catch {
        return false;
      }
    },
    async quarantine(record) {
      try {
        await put(keyFor(record.providerId, ".quarantine"), record);
      } catch {
        /* private mode or quota: the in-memory record remains */
      }
    },
  };
}

/** In-memory backend for tests and for platforms without Cache Storage. */
export function memoryUnitStorage(): UnitStorage & {
  snapshots: Map<string, unknown>;
  rejections: UnitRejection[];
} {
  const snapshots = new Map<string, unknown>();
  const rejections: UnitRejection[] = [];
  return {
    snapshots,
    rejections,
    async read(providerId) {
      const value = snapshots.get(providerId);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    async write(snapshot) {
      snapshots.set(snapshot.manifest.providerId, JSON.parse(JSON.stringify(snapshot)));
      return true;
    },
    async quarantine(record) {
      rejections.push(record);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validPosition(point: unknown): boolean {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    finite(point[0]) &&
    finite(point[1]) &&
    point[0] >= -180 &&
    point[0] <= 180 &&
    point[1] >= -90 &&
    point[1] <= 90
  );
}

function withinCoverage(bounds: Bounds, coverage: Bounds[]): boolean {
  if (coverage.length === 0) return true;
  return coverage.some((box) => {
    const padded = {
      west: box.west - COVERAGE_TOLERANCE,
      south: box.south - COVERAGE_TOLERANCE,
      east: box.east + COVERAGE_TOLERANCE,
      north: box.north + COVERAGE_TOLERANCE,
    };
    return (
      boundsContain(padded, bounds.west, bounds.south) && boundsContain(padded, bounds.east, bounds.north)
    );
  });
}

/** Structural and geographic checks on processed units. Returns a reason, or null when valid. */
export function checkUnits(units: unknown, providerId: string, coverage: Bounds[]): string | null {
  if (!Array.isArray(units)) return "the unit list is missing";
  if (units.length === 0) return "the provider returned no units";
  if (units.length > MAX_UNITS) return `the provider returned ${units.length} units, more than the ${MAX_UNITS} limit`;
  const ids = new Set<string>();
  for (const unit of units as unknown[]) {
    if (!isRecord(unit) || typeof unit.id !== "string" || !unit.id || typeof unit.code !== "string") {
      return "a unit is missing its identifier";
    }
    if (unit.providerId !== providerId) return `unit ${unit.code} belongs to another provider`;
    if (ids.has(unit.id)) return `unit ${unit.code} appears twice`;
    ids.add(unit.id);
    const polygons = unit.polygons;
    if (!Array.isArray(polygons) || polygons.length === 0) return `unit ${unit.code} has no geometry`;
    for (const polygon of polygons as unknown[]) {
      if (!Array.isArray(polygon) || polygon.length === 0) return `unit ${unit.code} has malformed geometry`;
      for (const ring of polygon as unknown[]) {
        if (!Array.isArray(ring) || ring.length < 4 || !ring.every(validPosition)) {
          return `unit ${unit.code} has malformed geometry`;
        }
      }
    }
    const bounds = unit.bounds;
    const label = unit.labelPoint;
    if (!isRecord(bounds) || ![bounds.west, bounds.south, bounds.east, bounds.north].every(finite)) {
      return `unit ${unit.code} has no bounds`;
    }
    if (!isRecord(label) || !finite(label.lng) || !finite(label.lat)) return `unit ${unit.code} has no label point`;
    if (!withinCoverage(bounds as Bounds, coverage)) return `unit ${unit.code} lies outside the provider's coverage area`;
  }
  return null;
}

export type CandidateCheck = {
  providerId: string;
  coverage: Bounds[];
  previous: UnitSnapshot | null;
  maxDropRatio: number;
};

/** REL-05 promotion gate. Returns a plain-language rejection reason, or null to promote. */
export function checkCandidate(candidate: UnitCandidate, check: CandidateCheck): string | null {
  const { featureCount, expectedCount } = candidate;
  if (featureCount === 0) return "the provider answered successfully but sent no features";
  if (expectedCount !== null && featureCount < expectedCount) {
    return `the download stopped early: ${featureCount} of ${expectedCount} features arrived`;
  }
  if (expectedCount !== null && featureCount > expectedCount) {
    return `the download returned ${featureCount} features but the provider counts ${expectedCount}`;
  }
  const problem = checkUnits(candidate.units, check.providerId, check.coverage);
  if (problem) return problem;
  const before = check.previous?.units.length ?? 0;
  const after = candidate.units.length;
  if (before > 0 && after < before * (1 - check.maxDropRatio)) {
    return `the unit count fell from ${before} to ${after}, a larger drop than expected; held for review`;
  }
  return null;
}

/** Parses a stored copy; null when it is missing, from another schema or invalid. */
export function parseSnapshot(raw: unknown, providerId: string, coverage: Bounds[]): UnitSnapshot | null {
  if (!isRecord(raw) || !isRecord(raw.manifest)) return null;
  const m = raw.manifest;
  if (m.schemaVersion !== UNIT_SCHEMA_VERSION || m.providerId !== providerId) return null;
  if (!finite(m.retrievedAt) || !finite(m.checkedAt) || !finite(m.featureCount) || typeof m.transform !== "string") {
    return null;
  }
  if (m.sourceVersion !== null && typeof m.sourceVersion !== "string") return null;
  if (m.expectedCount !== null && !finite(m.expectedCount)) return null;
  if (checkUnits(raw.units, providerId, coverage)) return null;
  const units = raw.units as HuntUnit[];
  return { manifest: { ...(m as UnitManifest), unitCount: units.length }, units };
}

export type UnitStoreOptions = {
  providerId: string;
  /** Short name for messages, e.g. "Arizona Game and Fish hunt units". */
  title: string;
  coverage: Bounds[];
  /** Identifies the query/simplification settings; a stored copy built differently is refreshed. */
  transform: string;
  download: UnitDownload;
  storage?: UnitStorage;
  now?: () => number;
  refreshMs?: number;
  retryMs?: number;
  maxDropRatio?: number;
};

export type UnitStore = {
  /** Loads the stored copy, refreshing it when it is past policy. Rejects only when `signal` aborts. */
  load(signal?: AbortSignal): Promise<UnitLoadResult>;
  /** Last good copy from memory or storage, without any network request. */
  peek(): Promise<{ snapshot: UnitSnapshot; current: boolean } | null>;
  /** The most recent quarantined download, if any. */
  lastRejection(): UnitRejection | null;
};

export function abortError(signal?: AbortSignal): unknown {
  const reason = signal?.reason;
  return reason instanceof Error || (typeof DOMException !== "undefined" && reason instanceof DOMException)
    ? reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error && error.message ? error.message : "the provider could not be reached";
  return text.replace(/[.\s]+$/, "");
}

type Job = { promise: Promise<UnitLoadResult>; controller: AbortController; waiting: number; pinned: boolean };

export function createUnitStore(options: UnitStoreOptions): UnitStore {
  const storage = options.storage ?? cacheUnitStorage();
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxDropRatio = options.maxDropRatio ?? DEFAULT_MAX_DROP_RATIO;
  const { providerId, coverage, transform, title } = options;

  let memory: UnitSnapshot | null = null;
  let failure: { at: number; reason: string } | null = null;
  let rejection: UnitRejection | null = null;
  let job: Job | null = null;

  const isCurrent = (snapshot: UnitSnapshot) =>
    snapshot.manifest.transform === transform && now() - snapshot.manifest.checkedAt < refreshMs;

  async function stored(): Promise<UnitSnapshot | null> {
    if (memory) return memory;
    const parsed = parseSnapshot(await storage.read(providerId), providerId, coverage);
    if (parsed && !memory) memory = parsed;
    return memory;
  }

  const good = (snapshot: UnitSnapshot): UnitLoadResult => ({
    status: "available",
    units: snapshot.units,
    retrievedAt: snapshot.manifest.retrievedAt,
    sourceVersion: snapshot.manifest.sourceVersion,
    message: null,
  });

  const failed = (snapshot: UnitSnapshot | null, reason: string): UnitLoadResult =>
    snapshot
      ? {
          status: "stale",
          units: snapshot.units,
          retrievedAt: snapshot.manifest.retrievedAt,
          sourceVersion: snapshot.manifest.sourceVersion,
          message: `Showing the saved copy of ${title} from ${day(snapshot.manifest.retrievedAt)}. The update was not used: ${reason}.`,
        }
      : {
          status: "unavailable",
          units: [],
          retrievedAt: null,
          sourceVersion: null,
          message: `${title} are unavailable: ${reason}.`,
        };

  async function promote(snapshot: UnitSnapshot): Promise<void> {
    memory = snapshot;
    failure = null;
    await storage.write(snapshot);
  }

  async function run(signal: AbortSignal): Promise<UnitLoadResult> {
    const previous = await stored();
    if (previous && isCurrent(previous)) return good(previous);
    const started = now();
    if (failure && started - failure.at < retryMs) return failed(previous, failure.reason);
    let outcome: UnitCandidate | UnitUnchanged;
    try {
      outcome = await options.download({ previous: previous?.manifest ?? null, signal });
    } catch (error) {
      if (signal.aborted) return failed(previous, "loading was cancelled");
      const reason = reasonOf(error);
      failure = { at: started, reason };
      if (error instanceof UnitValidationError) await quarantine({ reason, candidate: null });
      return failed(previous, reason);
    }
    if ("unchanged" in outcome) {
      if (previous && previous.manifest.transform === transform) {
        const renewed = { ...previous, manifest: { ...previous.manifest, checkedAt: now() } };
        await promote(renewed);
        return good(renewed);
      }
      failure = { at: started, reason: "the provider reported no change but no saved copy exists" };
      return failed(previous, failure.reason);
    }
    const reason = checkCandidate(outcome, { providerId, coverage, previous, maxDropRatio });
    if (reason) {
      failure = { at: started, reason };
      await quarantine({ reason, candidate: outcome });
      return failed(previous, reason);
    }
    const at = now();
    const snapshot: UnitSnapshot = {
      manifest: {
        schemaVersion: UNIT_SCHEMA_VERSION,
        providerId,
        retrievedAt: at,
        checkedAt: at,
        sourceVersion: outcome.sourceVersion,
        featureCount: outcome.featureCount,
        expectedCount: outcome.expectedCount,
        unitCount: outcome.units.length,
        transform,
      },
      units: outcome.units,
    };
    await promote(snapshot);
    return good(snapshot);
  }

  async function quarantine({ reason, candidate }: { reason: string; candidate: UnitCandidate | null }) {
    rejection = {
      providerId,
      rejectedAt: now(),
      reason,
      featureCount: candidate?.featureCount ?? null,
      expectedCount: candidate?.expectedCount ?? null,
      unitCount: candidate ? candidate.units.length : null,
      sourceVersion: candidate?.sourceVersion ?? null,
    };
    await storage.quarantine(rejection);
  }

  async function safeRun(signal: AbortSignal): Promise<UnitLoadResult> {
    try {
      return await run(signal);
    } catch (error) {
      // Storage or validation code should not throw; never let it escape as a provider failure.
      return failed(memory, reasonOf(error));
    }
  }

  function load(signal?: AbortSignal): Promise<UnitLoadResult> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let current = job;
    if (!current) {
      const controller = new AbortController();
      const created: Job = { controller, waiting: 0, pinned: false, promise: Promise.resolve(failed(null, "")) };
      created.promise = safeRun(controller.signal).finally(() => {
        if (job === created) job = null;
      });
      job = current = created;
    }
    const shared = current;
    if (!signal) {
      shared.pinned = true;
      return shared.promise;
    }
    shared.waiting += 1;
    return new Promise<UnitLoadResult>((resolve, reject) => {
      const onAbort = () => {
        shared.waiting -= 1;
        if (shared.waiting === 0 && !shared.pinned) {
          shared.controller.abort();
          if (job === shared) job = null;
        }
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void shared.promise.then((result) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return;
        shared.waiting -= 1;
        resolve(result);
      });
    });
  }

  return {
    load,
    async peek() {
      try {
        const snapshot = await stored();
        return snapshot ? { snapshot, current: isCurrent(snapshot) } : null;
      } catch {
        return null;
      }
    },
    lastRejection: () => rejection,
  };
}
