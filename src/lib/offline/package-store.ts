import {
  StorageError,
  type ReadTx,
  type StorageBackend,
  type WriteTx,
} from "../storage/backend.ts";
import type { PersistenceResult } from "../storage/indexeddb.ts";
import {
  boundsContain,
  boundsContainPoint,
  boundsIntersect,
  boundsProblems,
  type PackageBounds,
  type PackagePlan,
  type TileRange,
} from "./plan.ts";
import { PACKAGE_LAYERS, type PackageLayerId, type ProviderId } from "./sources.ts";

/**
 * Offline package records and the shared asset store (IndexedDB layout 2).
 *
 * Stores:
 * - `packages`      packageId → PackageRecord (state, active + pending manifest summaries)
 * - `packageAssets` `${packageId}@${version}` → AssetList (required canonical URLs, checksums, last verification)
 * - `assets`        `${url}#${sha256}` → AssetMeta (bytes, content type, references)
 * - `assetData`     same key → ArrayBuffer
 *
 * Assets are content-addressed under their canonical URL: two versions of one
 * URL (before and after an update) are separate records, so an update never
 * overwrites what the ready version serves. Each asset lists the package
 * versions that reference it (`refs`, the reference count is its length); an
 * asset is deleted only when its last reference goes. Hashing happens outside
 * transactions; every multi-record change is one transaction.
 */

export const PACKAGE_SCHEMA_VERSION = 1;

export type ManifestPhase = "planned" | "downloading" | "paused" | "failed" | "verifying" | "ready";

/** Spec §8 states. A package is "ready" only after every required asset verified. */
export type PackageState =
  "planned" | "downloading" | "paused" | "failed" | "verifying" | "ready" | "stale" | "updating";

export type ManifestLayer = {
  layerId: PackageLayerId;
  label: string;
  provider: ProviderId;
  minZoom: number;
  maxZoom: number;
  ranges: TileRange[];
  /** Resolved tile template (OFM's comes from its TileJSON); null until resolved. */
  template: string | null;
  assetCount: number;
  estimatedBytes: number;
  attribution: string;
  maxAgeDays: number;
  /** Assets of this layer stored for this version. */
  done: number;
  /** From the last verification. */
  verified: number;
  missing: number;
  corrupt: number;
  /** Tiles the provider doesn't have (HTTP 404): complete, nothing to draw. */
  absent: number;
};

export type IntegrityStatus = {
  status: "unverified" | "ok" | "damaged";
  checkedAt: number | null;
  missingCount: number;
  corruptCount: number;
  /**
   * Tiles the provider confirmed it doesn't have (HTTP 404 twice): complete,
   * nothing to draw. For "N tiles had no data at the source".
   */
  absentCount: number;
  /** First entries (display only); the full lists are in the version's asset list. */
  missing: string[];
  corrupt: string[];
};

export type PackageError = { code: string; message: string; at: number };
export type AssetFailure = { url: string; reason: string };

/** Manifest fields stored in the package record (asset lists live separately). */
export type ManifestSummary = {
  packageId: string;
  version: number;
  schemaVersion: number;
  phase: ManifestPhase;
  bounds: PackageBounds;
  createdAt: number;
  downloadStartedAt: number | null;
  verifiedAt: number | null;
  sourceVersions: Record<string, string | null>;
  zoomRange: { min: number; max: number };
  layerIds: PackageLayerId[];
  layers: ManifestLayer[];
  assetsResolved: boolean;
  requiredAssetCount: number;
  expectedBytes: number;
  actualBytes: number;
  progress: { done: number; total: number; failed: number };
  integrityStatus: IntegrityStatus;
  expiryPolicy: { maxAgeDays: number; expiresAt: number | null };
  attribution: string[];
  lastError: PackageError | null;
  failures: AssetFailure[];
};

/** The complete manifest (spec §8): summary + required assets + checksums. */
export type PackageManifest = ManifestSummary & {
  requiredAssets: string[];
  checksums: Record<string, string>;
};

export type PackageRecord = {
  packageId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The verified version the map serves (ready/stale), kept during an update. */
  active: ManifestSummary | null;
  /** A version being downloaded or verified (first download or update). */
  pending: ManifestSummary | null;
  /** Answer to navigator.storage.persist() at the last download start. */
  persistence: PersistenceResult | null;
  /**
   * Providers that asked us to stop until a time (Retry-After beyond the wait
   * cap). No request goes to them before then, even after a restart.
   */
  providerNotBefore?: Partial<Record<ProviderId, number>>;
};

export type AssetList = {
  key: string;
  urls: string[];
  /** Index into the manifest's `layers` for each URL. */
  layerIndex: number[];
  checksums: Record<string, string> | null;
  missing: string[];
  corrupt: string[];
};

export type AssetMeta = {
  url: string;
  sha256: string;
  bytes: number;
  contentType: string;
  /** 200, or 404 for a tile the provider doesn't have (stored empty). */
  status: number;
  fetchedAt: number;
  /** Package versions (`${packageId}@${version}`) referencing this asset. */
  refs: string[];
};

export type PackageStatus = {
  packageId: string;
  name: string;
  /**
   * The current operation's state. During an update this describes the new
   * version ("updating", "verifying", "paused", "failed"); `activeState` says
   * whether the old version is still ready or stale.
   */
  state: PackageState;
  /** State of the verified version the map serves, or null when there is none. */
  activeState: "ready" | "stale" | "failed" | null;
  /** A verified version exists and the map serves it (ready, stale, updating, or damaged-but-intact parts). */
  servable: boolean;
  /** A provider asked us to wait until this time; resume after it. */
  waitUntil: number | null;
  /** A download stopped without pausing (app closed, tab crashed); resume it. */
  interrupted: boolean;
  activeVersion: number | null;
  stale: boolean;
  expiresAt: number | null;
  /** The manifest the state describes: pending during a first download, else the active one. */
  manifest: ManifestSummary;
  /** During an update: the new version's progress (the old version stays usable). */
  update: ManifestSummary | null;
  persistence: PersistenceResult | null;
};

/** Result of a download step, written in one transaction. */
export type FetchedAsset = {
  url: string;
  layerIndex: number;
  sha256: string;
  bytes: number;
  contentType: string;
  status: number;
  data: ArrayBuffer;
  fetchedAt: number;
};

export type LayerCoverage = {
  layerId: PackageLayerId;
  label: string;
  minZoom: number;
  maxZoom: number;
  assetCount: number;
  stored: number;
  missing: number;
  corrupt: number;
  absent: number;
  complete: boolean;
};

export type PackageCoverage = {
  packageId: string;
  name: string;
  state: PackageState;
  servable: boolean;
  /** The package rectangle contains the whole target (point or bounds). */
  contains: boolean;
  zoomRange: { min: number; max: number };
  layers: LayerCoverage[];
  verifiedAt: number | null;
  expiresAt: number | null;
};

export type CoverageResult = {
  /** Some ready or stale package contains the target. */
  covered: boolean;
  /** Ready/stale packages touching the target, per layer and zoom. */
  packages: PackageCoverage[];
  /** Packages touching the target that aren't usable yet (downloading, paused, failed). */
  incomplete: PackageCoverage[];
  /** Usable zoom ranges per layer across ready/stale packages that contain the target. */
  layers: Partial<Record<PackageLayerId, { minZoom: number; maxZoom: number }[]>>;
};

const STORES_ALL = ["packages", "packageAssets", "assets", "assetData"] as const;
const OFM_VERSIONED_TILE =
  /^https:\/\/tiles\.openfreemap\.org\/planet\/([A-Za-z0-9_.-]{1,64})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.pbf$/;
const DAY_MS = 86_400_000;
const LIST_PREVIEW = 50;

export function versionRef(packageId: string, version: number): string {
  return `${packageId}@${version}`;
}

export function assetKey(url: string, sha256: string): string {
  return `${url}#${sha256}`;
}

function assetPrefix(url: string): string {
  return `${url}#`;
}

function isSafePackageId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

function newPackageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyIntegrity(): IntegrityStatus {
  return {
    status: "unverified",
    checkedAt: null,
    missingCount: 0,
    corruptCount: 0,
    absentCount: 0,
    missing: [],
    corrupt: [],
  };
}

function assertUnderstood(record: PackageRecord) {
  for (const manifest of [record.active, record.pending]) {
    if (manifest && manifest.schemaVersion > PACKAGE_SCHEMA_VERSION) {
      throw new StorageError(
        "future-version",
        "This offline package was saved by a newer Fieldline and was left untouched.",
      );
    }
  }
}

function expiresAt(manifest: ManifestSummary): number | null {
  const start = manifest.downloadStartedAt ?? manifest.verifiedAt;
  return start === null ? null : start + manifest.expiryPolicy.maxAgeDays * DAY_MS;
}

/** Removes `ref` from every stored asset of the given URLs, deleting assets nobody references. */
async function releaseRefs(tx: WriteTx, urls: readonly string[], ref: string): Promise<number> {
  let deleted = 0;
  for (const url of new Set(urls)) {
    const metas = await tx.getRange<AssetMeta>("assets", assetPrefix(url));
    for (const meta of metas) {
      if (!meta.refs.includes(ref)) continue;
      meta.refs = meta.refs.filter((r) => r !== ref);
      const key = assetKey(meta.url, meta.sha256);
      if (meta.refs.length) {
        await tx.put("assets", key, meta);
      } else {
        await tx.delete("assets", key);
        await tx.delete("assetData", key);
        deleted += 1;
      }
    }
  }
  return deleted;
}

export class OfflinePackageStore {
  readonly backend: StorageBackend;
  private readonly live = new Set<string>();
  private readonly now: () => number;

  constructor(backend: StorageBackend, options: { now?: () => number } = {}) {
    this.backend = backend;
    this.now = options.now ?? Date.now;
  }

  // ---- lifecycle -------------------------------------------------------

  /**
   * Creates a package in state "planned" from an `ok` plan. Nothing is
   * downloaded; call `downloadPackage`.
   */
  async createPackage(
    plan: PackagePlan,
    options: { name: string; packageId?: string; now?: number },
  ): Promise<PackageStatus> {
    if (!plan.ok) {
      throw new StorageError(
        "invalid",
        `This area can't be downloaded: ${plan.violations.map((v) => v.message).join(" ")}`,
      );
    }
    const problems = boundsProblems(plan.bounds);
    if (problems.length) throw new StorageError("invalid", problems.join("; "));
    const name = String(options.name ?? "")
      .trim()
      .slice(0, 120);
    if (!name) throw new StorageError("invalid", "A package needs a name.");
    const packageId = options.packageId ?? newPackageId();
    if (!isSafePackageId(packageId)) throw new StorageError("invalid", "Unsafe package id.");
    const now = options.now ?? this.now();
    const manifest = manifestFromPlan(plan, packageId, 1, now);
    const record: PackageRecord = {
      packageId,
      name,
      createdAt: now,
      updatedAt: now,
      active: null,
      pending: manifest,
      persistence: null,
    };
    await this.backend.write(["packages"], async (tx) => {
      if (await tx.get("packages", packageId))
        throw new StorageError("conflict", "A package with that id already exists.");
      await tx.put("packages", packageId, record);
    });
    return this.statusOf(record, now);
  }

  /**
   * Starts an update of a ready or stale package: a new pending version that
   * re-downloads every asset. The old version stays servable until the new
   * one verifies and `commitVerification` swaps them in one transaction.
   */
  async startUpdate(packageId: string, options: { now?: number } = {}): Promise<PackageStatus> {
    const now = options.now ?? this.now();
    const record = await this.backend.write(["packages"], async (tx) => {
      const record = await this.mustGet(tx, packageId);
      if (!record.active || record.active.phase !== "ready")
        throw new StorageError("conflict", "Only a ready or stale package can be updated.");
      if (record.pending) throw new StorageError("conflict", "An update is already in progress.");
      const base = record.active;
      const next: ManifestSummary = {
        ...structuredClone(base),
        version: base.version + 1,
        phase: "planned",
        createdAt: now,
        downloadStartedAt: null,
        verifiedAt: null,
        assetsResolved: false,
        actualBytes: 0,
        progress: { done: 0, total: base.requiredAssetCount, failed: 0 },
        integrityStatus: emptyIntegrity(),
        expiryPolicy: { maxAgeDays: base.expiryPolicy.maxAgeDays, expiresAt: null },
        lastError: null,
        failures: [],
        layers: base.layers.map((layer) => ({
          ...layer,
          // OFM's tile URL is versioned: re-read its TileJSON.
          template: PACKAGE_LAYERS[layer.layerId].template,
          done: 0,
          verified: 0,
          missing: 0,
          corrupt: 0,
          absent: 0,
        })),
      };
      record.pending = next;
      record.updatedAt = now;
      await tx.put("packages", packageId, record);
      return record;
    });
    return this.statusOf(record, now);
  }

  /** Abandons a pending update (or a first download), releasing its assets. The active version is kept. */
  async discardPending(packageId: string): Promise<PackageStatus | null> {
    this.assertIdle(packageId);
    const now = this.now();
    const record = await this.backend.write(STORES_ALL, async (tx) => {
      const record = await this.mustGet(tx, packageId);
      if (!record.pending) return record;
      const ref = versionRef(packageId, record.pending.version);
      const list = await tx.get<AssetList>("packageAssets", ref);
      if (list) await releaseRefs(tx, list.urls, ref);
      await tx.delete("packageAssets", ref);
      record.pending = null;
      record.updatedAt = now;
      if (!record.active) {
        await tx.delete("packages", packageId);
        return null;
      }
      await tx.put("packages", packageId, record);
      return record;
    });
    return record ? this.statusOf(record, now) : null;
  }

  /**
   * Deletes a package and every asset only it references, in one
   * transaction. Assets shared with other packages stay (their reference
   * counts drop by one). Stop its download first.
   */
  async deletePackage(packageId: string): Promise<{ deletedAssets: number }> {
    this.assertIdle(packageId);
    return this.backend.write(STORES_ALL, async (tx) => {
      const record = await this.mustGet(tx, packageId);
      let deletedAssets = 0;
      for (const manifest of [record.active, record.pending]) {
        if (!manifest) continue;
        const ref = versionRef(packageId, manifest.version);
        const list = await tx.get<AssetList>("packageAssets", ref);
        if (list) deletedAssets += await releaseRefs(tx, list.urls, ref);
        await tx.delete("packageAssets", ref);
      }
      await tx.delete("packages", packageId);
      return { deletedAssets };
    });
  }

  // ---- reads -----------------------------------------------------------

  async getRecord(packageId: string): Promise<PackageRecord | undefined> {
    return this.backend.read(["packages"], (tx) => tx.get<PackageRecord>("packages", packageId));
  }

  async getPackage(packageId: string, now = this.now()): Promise<PackageStatus | null> {
    const record = await this.getRecord(packageId);
    return record ? this.statusOf(record, now) : null;
  }

  async listPackages(now = this.now()): Promise<PackageStatus[]> {
    const records = await this.backend.read(["packages"], (tx) =>
      tx.getAll<PackageRecord>("packages"),
    );
    return records
      .map((record) => this.statusOf(record, now))
      .sort((a, b) => a.manifest.createdAt - b.manifest.createdAt);
  }

  /** The full manifest (spec §8) of the active version, or of `version`. */
  async getManifest(packageId: string, version?: number): Promise<PackageManifest | null> {
    return this.backend.read(["packages", "packageAssets"], async (tx) => {
      const record = await tx.get<PackageRecord>("packages", packageId);
      if (!record) return null;
      const manifest =
        [record.active, record.pending].find(
          (m) => m && (version === undefined || m.version === version),
        ) ?? null;
      if (!manifest) return null;
      const list = await tx.get<AssetList>(
        "packageAssets",
        versionRef(packageId, manifest.version),
      );
      return {
        ...manifest,
        requiredAssets: list?.urls ?? [],
        checksums: list?.checksums ?? {},
      };
    });
  }

  async getAssetList(packageId: string, version: number): Promise<AssetList | undefined> {
    return this.backend.read(["packageAssets"], (tx) =>
      tx.get<AssetList>("packageAssets", versionRef(packageId, version)),
    );
  }

  /** Asset metadata for a canonical URL (all stored versions of it). */
  async assetsFor(url: string): Promise<AssetMeta[]> {
    return this.backend.read(["assets"], (tx) =>
      tx.getRange<AssetMeta>("assets", assetPrefix(url)),
    );
  }

  /** Bytes per package, and unique bytes on disk (shared assets counted once). */
  async storageUsage(): Promise<{
    uniqueBytes: number;
    assetCount: number;
    sharedAssets: number;
    packages: { packageId: string; bytes: number }[];
  }> {
    const [records, metas] = await this.backend.read(
      ["packages", "assets"],
      async (tx) =>
        [await tx.getAll<PackageRecord>("packages"), await tx.getAll<AssetMeta>("assets")] as const,
    );
    const perRef = new Map<string, number>();
    let uniqueBytes = 0;
    let sharedAssets = 0;
    for (const meta of metas) {
      uniqueBytes += meta.bytes;
      if (new Set(meta.refs.map((ref) => ref.slice(0, ref.lastIndexOf("@")))).size > 1)
        sharedAssets += 1;
      for (const ref of meta.refs) perRef.set(ref, (perRef.get(ref) ?? 0) + meta.bytes);
    }
    return {
      uniqueBytes,
      assetCount: metas.length,
      sharedAssets,
      packages: records.map((record) => ({
        packageId: record.packageId,
        bytes: [record.active, record.pending]
          .filter((m): m is ManifestSummary => Boolean(m))
          .reduce((sum, m) => sum + (perRef.get(versionRef(record.packageId, m.version)) ?? 0), 0),
      })),
    };
  }

  /**
   * Coverage for FIELD-01, read from verified manifests (never from cached
   * tile counts): which packages cover a point or rectangle, at which zooms,
   * and how complete each layer is.
   */
  async coverage(
    target: { lng: number; lat: number } | PackageBounds,
    now = this.now(),
  ): Promise<CoverageResult> {
    const statuses = await this.listPackages(now);
    const isPoint = "lng" in target;
    const packages: PackageCoverage[] = [];
    const incomplete: PackageCoverage[] = [];
    const layers: CoverageResult["layers"] = {};
    for (const status of statuses) {
      // status.manifest is the active version whenever one exists. Usable =
      // verified and not found damaged since (ready, stale, or being updated).
      const manifest = status.manifest;
      const usable = status.servable && manifest.integrityStatus.status === "ok";
      const bounds = manifest.bounds;
      const touches = isPoint
        ? boundsContainPoint(bounds, target.lng, target.lat)
        : boundsIntersect(bounds, target);
      if (!touches) continue;
      const contains = isPoint ? true : boundsContain(bounds, target);
      const entry: PackageCoverage = {
        packageId: status.packageId,
        name: status.name,
        state: status.state,
        servable: status.servable,
        contains,
        zoomRange: manifest.zoomRange,
        layers: manifest.layers.map((layer) => {
          const verifiedOk = manifest.integrityStatus.status === "ok";
          return {
            layerId: layer.layerId,
            label: layer.label,
            minZoom: layer.minZoom,
            maxZoom: layer.maxZoom,
            assetCount: layer.assetCount,
            stored: layer.done,
            missing: verifiedOk ? 0 : Math.max(layer.missing, layer.assetCount - layer.done),
            corrupt: verifiedOk ? 0 : layer.corrupt,
            absent: layer.absent,
            complete: verifiedOk && layer.verified === layer.assetCount,
          };
        }),
        verifiedAt: manifest.verifiedAt,
        expiresAt: status.expiresAt,
      };
      if (usable) {
        packages.push(entry);
        if (contains) {
          for (const layer of entry.layers) {
            if (!layer.complete || layer.layerId === "glyphs") continue;
            (layers[layer.layerId] ??= []).push({ minZoom: layer.minZoom, maxZoom: layer.maxZoom });
          }
        }
      } else {
        incomplete.push(entry);
      }
    }
    return {
      covered: packages.some((p) => p.contains),
      packages,
      incomplete,
      layers,
    };
  }

  /**
   * Reads a packaged asset for the map, from the active (verified) version of
   * any package, newest verification first. Assets the last verification
   * found corrupt (the complete list) are skipped. Returns null when no
   * package has it.
   *
   * OpenFreeMap tile URLs carry a data version. With `substituteVersions`
   * (used offline), a vector tile requested under one version is answered
   * from a package downloaded under another, so every package's tiles stay
   * reachable whichever packaged TileJSON the map loaded.
   */
  async readServableAsset(
    url: string,
    options: { substituteVersions?: boolean } = {},
  ): Promise<{ data: ArrayBuffer; contentType: string; status: number } | null> {
    const stores = ["packages", "packageAssets", "assets", "assetData"] as const;
    return this.backend.read(stores, async (tx) => {
      const metas = await tx.getRange<AssetMeta>("assets", assetPrefix(url));
      const ofm = OFM_VERSIONED_TILE.exec(url);
      if (!metas.length && !(options.substituteVersions && ofm)) return null;
      const records = (await tx.getAll<PackageRecord>("packages"))
        .filter(
          (record) =>
            record.active &&
            record.active.verifiedAt !== null &&
            record.active.schemaVersion <= PACKAGE_SCHEMA_VERSION,
        )
        .sort((a, b) => (b.active!.verifiedAt ?? 0) - (a.active!.verifiedAt ?? 0));
      const servable: { ref: string; record: PackageRecord; corrupt: Set<string> | null }[] = [];
      for (const record of records) {
        const active = record.active!;
        const ref = versionRef(record.packageId, active.version);
        let corrupt: Set<string> | null = null;
        if (active.integrityStatus.corruptCount > 0) {
          const list = await tx.get<AssetList>("packageAssets", ref);
          corrupt = new Set(list?.corrupt ?? active.integrityStatus.corrupt);
        }
        servable.push({ ref, record, corrupt });
      }
      const pick = async (candidate: string, candidates: AssetMeta[]) => {
        for (const entry of servable) {
          if (entry.corrupt?.has(candidate)) continue;
          const meta = candidates.find((m) => m.refs.includes(entry.ref));
          if (!meta) continue;
          const data = await tx.get<ArrayBuffer>("assetData", assetKey(meta.url, meta.sha256));
          if (!data || data.byteLength !== meta.bytes) continue;
          return { data, contentType: meta.contentType, status: meta.status };
        }
        return null;
      };
      const exact = metas.length ? await pick(url, metas) : null;
      if (exact || !options.substituteVersions || !ofm) return exact;
      const tried = new Set([ofm[1]]);
      for (const entry of servable) {
        const version = entry.record.active!.sourceVersions["ofm-vector"];
        if (!version || tried.has(version)) continue;
        tried.add(version);
        const alternative = `https://tiles.openfreemap.org/planet/${version}/${ofm[2]}/${ofm[3]}/${ofm[4]}.pbf`;
        const hit = await pick(
          alternative,
          await tx.getRange<AssetMeta>("assets", assetPrefix(alternative)),
        );
        if (hit) return hit;
      }
      return null;
    });
  }

  // ---- used by the downloader and verifier ------------------------------

  /** @internal Marks a package as being worked on by this store (download/verify). */
  claim(packageId: string) {
    if (this.live.has(packageId))
      throw new StorageError("conflict", "This package is already downloading or verifying.");
    this.live.add(packageId);
  }

  /** @internal */
  release(packageId: string) {
    this.live.delete(packageId);
  }

  isLive(packageId: string): boolean {
    return this.live.has(packageId);
  }

  private assertIdle(packageId: string) {
    if (this.live.has(packageId))
      throw new StorageError("conflict", "Pause the package's download before changing it.");
  }

  /** @internal Updates the target version's summary with `change` in one transaction. */
  async updateTarget(
    packageId: string,
    version: number,
    change: (manifest: ManifestSummary, record: PackageRecord) => void,
  ): Promise<PackageRecord> {
    const now = this.now();
    return this.backend.write(["packages"], async (tx) => {
      const record = await this.mustGet(tx, packageId);
      const manifest = targetOf(record, version);
      change(manifest, record);
      record.updatedAt = now;
      await tx.put("packages", packageId, record);
      return record;
    });
  }

  /** @internal Saves the resolved asset list of a version and marks it resolved. */
  async saveAssetList(
    packageId: string,
    version: number,
    list: { urls: string[]; layerIndex: number[] },
    resolved: {
      templates: Partial<Record<PackageLayerId, string>>;
      sourceVersions: Record<string, string | null>;
    },
  ): Promise<void> {
    await this.backend.write(["packages", "packageAssets"], async (tx) => {
      const record = await this.mustGet(tx, packageId);
      const manifest = targetOf(record, version);
      manifest.assetsResolved = true;
      manifest.requiredAssetCount = list.urls.length;
      manifest.progress.total = list.urls.length;
      manifest.sourceVersions = { ...manifest.sourceVersions, ...resolved.sourceVersions };
      manifest.layers.forEach((layer, index) => {
        const template = resolved.templates[layer.layerId];
        if (template) layer.template = template;
        layer.assetCount = list.layerIndex.filter((i) => i === index).length;
      });
      record.updatedAt = this.now();
      const key = versionRef(packageId, version);
      const previous = await tx.get<AssetList>("packageAssets", key);
      await tx.put("packageAssets", key, {
        key,
        urls: list.urls,
        layerIndex: list.layerIndex,
        checksums: previous?.checksums ?? null,
        missing: [],
        corrupt: [],
      } satisfies AssetList);
      await tx.put("packages", packageId, record);
    });
  }

  /**
   * @internal Which required assets of a version are already stored (with
   * this version's reference), with their bytes. This is the persisted
   * per-asset progress a resumed download starts from.
   */
  async storedAssets(
    packageId: string,
    version: number,
    urls: readonly string[],
  ): Promise<Map<string, { bytes: number; sha256: string }>> {
    const ref = versionRef(packageId, version);
    return this.backend.read(["assets"], async (tx) => {
      const stored = new Map<string, { bytes: number; sha256: string }>();
      for (const url of urls) {
        const metas = await tx.getRange<AssetMeta>("assets", assetPrefix(url));
        const meta = metas.find((m) => m.refs.includes(ref));
        if (meta) stored.set(url, { bytes: meta.bytes, sha256: meta.sha256 });
      }
      return stored;
    });
  }

  /**
   * @internal Shares assets other packages already stored: for each URL with
   * a copy fetched at or after `fetchedSince`, adds this version's reference
   * (no download). Returns the adopted URLs with their bytes. Verification
   * still re-hashes every adopted asset before the package can be ready.
   */
  async adoptExisting(
    packageId: string,
    version: number,
    jobs: readonly { url: string; layerIndex: number }[],
    fetchedSince: number,
  ): Promise<Map<string, number>> {
    const ref = versionRef(packageId, version);
    const now = this.now();
    return this.backend.write(["packages", "assets"], async (tx) => {
      const record = await this.mustGet(tx, packageId);
      const manifest = targetOf(record, version);
      const adopted = new Map<string, number>();
      for (const job of jobs) {
        const metas = await tx.getRange<AssetMeta>("assets", assetPrefix(job.url));
        if (metas.some((m) => m.refs.includes(ref))) continue;
        const candidate = metas
          .filter((m) => m.fetchedAt >= fetchedSince && m.refs.length > 0)
          .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
        if (!candidate) continue;
        candidate.refs = [...candidate.refs, ref];
        await tx.put("assets", assetKey(candidate.url, candidate.sha256), candidate);
        manifest.progress.done += 1;
        manifest.actualBytes += candidate.bytes;
        const layer = manifest.layers[job.layerIndex];
        if (layer) layer.done += 1;
        adopted.set(job.url, candidate.bytes);
      }
      if (adopted.size) {
        record.updatedAt = now;
        await tx.put("packages", packageId, record);
      }
      return adopted;
    });
  }

  /**
   * @internal Stores fetched assets for a version in one transaction: bytes,
   * metadata and this version's reference together, plus progress. A
   * different stored copy of the same URL loses this version's reference
   * (and is deleted when nobody else uses it). Throws `not-found` if the
   * package or version is gone (deleted or cleared meanwhile).
   */
  async commitAssets(
    packageId: string,
    version: number,
    assets: readonly FetchedAsset[],
  ): Promise<PackageRecord> {
    const ref = versionRef(packageId, version);
    const now = this.now();
    return this.backend.write(["packages", "assets", "assetData"], async (tx) => {
      const record = await this.mustGet(tx, packageId);
      const manifest = targetOf(record, version);
      for (const asset of assets) {
        const metas = await tx.getRange<AssetMeta>("assets", assetPrefix(asset.url));
        const previous = metas.find((m) => m.refs.includes(ref));
        for (const meta of metas) {
          if (meta.sha256 === asset.sha256 || !meta.refs.includes(ref)) continue;
          meta.refs = meta.refs.filter((r) => r !== ref);
          const key = assetKey(meta.url, meta.sha256);
          if (meta.refs.length) await tx.put("assets", key, meta);
          else {
            await tx.delete("assets", key);
            await tx.delete("assetData", key);
          }
        }
        const key = assetKey(asset.url, asset.sha256);
        const same = metas.find((m) => m.sha256 === asset.sha256);
        const meta: AssetMeta = {
          url: asset.url,
          sha256: asset.sha256,
          bytes: asset.bytes,
          contentType: asset.contentType,
          status: asset.status,
          fetchedAt: asset.fetchedAt,
          refs: same ? [...new Set([...same.refs, ref])] : [ref],
        };
        await tx.put("assets", key, meta);
        // Always rewrite the bytes: a fresh copy with the same checksum repairs corruption for every sharer.
        await tx.put("assetData", key, asset.data);
        if (!previous) {
          manifest.progress.done += 1;
          const layer = manifest.layers[asset.layerIndex];
          if (layer) layer.done += 1;
        }
        manifest.actualBytes += asset.bytes - (previous?.bytes ?? 0);
      }
      record.updatedAt = now;
      await tx.put("packages", packageId, record);
      return record;
    });
  }

  /**
   * @internal Applies a verification result. On success the version becomes
   * ready: for an update it replaces the active version and the old
   * version's references are released, all in this one transaction. Every
   * required asset's presence is re-checked inside the transaction, so a
   * concurrent deletion can't slip through.
   */
  async commitVerification(
    packageId: string,
    version: number,
    result: {
      missing: string[];
      corrupt: string[];
      checksums: Record<string, string>;
      perLayer: { verified: number; missing: number; corrupt: number; absent: number }[];
      checkedAt: number;
    },
  ): Promise<PackageRecord> {
    const ref = versionRef(packageId, version);
    return this.backend.write(STORES_ALL, async (tx) => {
      const record = await this.mustGet(tx, packageId);
      const manifest = targetOf(record, version);
      const listKey = ref;
      const list = await tx.get<AssetList>("packageAssets", listKey);
      if (!list) throw new StorageError("not-found", "The package's asset list is missing.");
      const missing = [...result.missing];
      const corrupt = [...result.corrupt];
      // Re-check inside this transaction: every asset must still be stored for
      // this version with exactly the checksum that was just verified (another
      // tab may have replaced or removed it after hashing).
      const reported = new Set([...missing, ...corrupt]);
      for (const url of list.urls) {
        if (reported.has(url)) continue;
        const metas = await tx.getRange<AssetMeta>("assets", assetPrefix(url));
        const meta = metas.find((m) => m.refs.includes(ref));
        if (!meta) missing.push(url);
        else if (meta.sha256 !== result.checksums[url]) corrupt.push(url);
      }
      const ok = missing.length === 0 && corrupt.length === 0;
      manifest.integrityStatus = {
        status: ok ? "ok" : "damaged",
        checkedAt: result.checkedAt,
        missingCount: missing.length,
        corruptCount: corrupt.length,
        absentCount: result.perLayer.reduce((sum, layer) => sum + layer.absent, 0),
        missing: missing.slice(0, LIST_PREVIEW),
        corrupt: corrupt.slice(0, LIST_PREVIEW),
      };
      manifest.layers.forEach((layer, index) => {
        const counts = result.perLayer[index] ?? { verified: 0, missing: 0, corrupt: 0, absent: 0 };
        Object.assign(layer, counts);
      });
      await tx.put("packageAssets", listKey, {
        ...list,
        checksums: ok ? result.checksums : list.checksums,
        missing,
        corrupt,
      } satisfies AssetList);
      record.updatedAt = result.checkedAt;
      if (!ok) {
        manifest.phase = "failed";
        manifest.lastError = {
          code: "integrity",
          message: `${missing.length} missing and ${corrupt.length} damaged map files. Repair downloads only those.`,
          at: result.checkedAt,
        };
        await tx.put("packages", packageId, record);
        return record;
      }
      manifest.phase = "ready";
      manifest.verifiedAt = result.checkedAt;
      manifest.lastError = null;
      manifest.failures = [];
      manifest.progress.failed = 0;
      manifest.expiryPolicy = { ...manifest.expiryPolicy, expiresAt: expiresAt(manifest) };
      if (record.pending && record.pending.version === version) {
        const old = record.active;
        if (old && old.version !== version) {
          const oldRef = versionRef(packageId, old.version);
          const oldList = await tx.get<AssetList>("packageAssets", oldRef);
          if (oldList) await releaseRefs(tx, oldList.urls, oldRef);
          await tx.delete("packageAssets", oldRef);
        }
        record.active = manifest;
        record.pending = null;
      }
      await tx.put("packages", packageId, record);
      return record;
    });
  }

  // ---- helpers -----------------------------------------------------------

  private async mustGet(tx: ReadTx, packageId: string): Promise<PackageRecord> {
    const record = await tx.get<PackageRecord>("packages", packageId);
    if (!record) throw new StorageError("not-found", "That offline package no longer exists.");
    assertUnderstood(record);
    return record;
  }

  statusOf(record: PackageRecord, now = this.now()): PackageStatus {
    const live = this.live.has(record.packageId);
    const phaseOf = (m: ManifestSummary): { phase: ManifestPhase; interrupted: boolean } =>
      (m.phase === "downloading" || m.phase === "verifying") && !live
        ? { phase: "paused", interrupted: true }
        : { phase: m.phase, interrupted: false };
    const { active, pending } = record;
    const exp = active ? expiresAt(active) : null;
    const stale = Boolean(active && active.phase === "ready" && exp !== null && now >= exp);
    let state: PackageState;
    let interrupted = false;
    if (!active) {
      const p = phaseOf(pending!);
      state = p.phase;
      interrupted = p.interrupted;
    } else if (pending) {
      // The update's own state; the old version's is in `activeState`.
      const p = phaseOf(pending);
      interrupted = p.interrupted;
      state =
        p.phase === "planned" || p.phase === "downloading" || p.phase === "ready"
          ? "updating"
          : p.phase;
    } else if (active.phase !== "ready") {
      const p = phaseOf(active);
      interrupted = p.interrupted;
      state = p.phase;
    } else {
      state = stale ? "stale" : "ready";
    }
    const waits = Object.values(record.providerNotBefore ?? {}).filter(
      (until): until is number => typeof until === "number" && until > now,
    );
    return {
      packageId: record.packageId,
      name: record.name,
      state,
      activeState:
        !active || active.verifiedAt === null
          ? null
          : active.phase !== "ready"
            ? "failed"
            : stale
              ? "stale"
              : "ready",
      waitUntil: waits.length ? Math.max(...waits) : null,
      servable: Boolean(active && active.verifiedAt !== null),
      interrupted,
      activeVersion: active?.verifiedAt != null ? active.version : null,
      stale,
      expiresAt: exp,
      manifest: (active ?? pending)!,
      update: active && pending ? pending : null,
      persistence: record.persistence,
    };
  }
}

/** The version a download/verify works on: pending, or a damaged active version being repaired. */
export function targetOf(record: PackageRecord, version: number): ManifestSummary {
  const manifest = [record.pending, record.active].find((m) => m?.version === version);
  if (!manifest) throw new StorageError("not-found", "That package version no longer exists.");
  return manifest;
}

/** The version a download should work on now, or null if the package is ready. */
export function workTarget(record: PackageRecord): ManifestSummary | null {
  if (record.pending) return record.pending;
  if (record.active && record.active.phase !== "ready") return record.active;
  return null;
}

function manifestFromPlan(
  plan: PackagePlan,
  packageId: string,
  version: number,
  now: number,
): ManifestSummary {
  const layers: ManifestLayer[] = plan.layers.map((layer) => {
    const def = PACKAGE_LAYERS[layer.layerId];
    return {
      layerId: layer.layerId,
      label: layer.label,
      provider: layer.provider,
      minZoom: layer.minZoom,
      maxZoom: layer.maxZoom,
      ranges: layer.ranges,
      template: def.template,
      assetCount: layer.assetCount,
      estimatedBytes: layer.estimatedBytes,
      attribution: layer.attribution,
      maxAgeDays: def.maxAgeDays,
      done: 0,
      verified: 0,
      missing: 0,
      corrupt: 0,
      absent: 0,
    };
  });
  const sourceVersions: Record<string, string | null> = {};
  for (const layer of layers)
    sourceVersions[layer.layerId] = PACKAGE_LAYERS[layer.layerId].sourceVersion;
  return {
    packageId,
    version,
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    phase: "planned",
    bounds: { ...plan.bounds },
    createdAt: now,
    downloadStartedAt: null,
    verifiedAt: null,
    sourceVersions,
    zoomRange: { min: plan.minZoom, max: plan.maxZoom },
    layerIds: layers.map((layer) => layer.layerId),
    layers,
    assetsResolved: false,
    requiredAssetCount: plan.totals.assets,
    expectedBytes: plan.totals.estimatedBytes,
    actualBytes: 0,
    progress: { done: 0, total: plan.totals.assets, failed: 0 },
    integrityStatus: emptyIntegrity(),
    expiryPolicy: {
      maxAgeDays: Math.min(...layers.map((layer) => layer.maxAgeDays)),
      expiresAt: null,
    },
    attribution: [...new Set(layers.map((layer) => layer.attribution))],
    lastError: null,
    failures: [],
  };
}
