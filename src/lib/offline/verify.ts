import { StorageError } from "../storage/backend.ts";
import { sha256HexBytes } from "../storage/digest.ts";
import {
  assetKey,
  versionRef,
  workTarget,
  type AssetMeta,
  type OfflinePackageStore,
  type PackageStatus,
} from "./package-store.ts";

export type VerifyResult = {
  ok: boolean;
  status: PackageStatus;
  /** Canonical URLs with no stored copy for this version. */
  missing: string[];
  /** Stored copies whose bytes don't match the recorded SHA-256 or size. */
  corrupt: string[];
};

const BATCH = 32;

/**
 * Re-checks every required asset of a package version: it must exist, with
 * the recorded size and SHA-256 (hashed outside any transaction). Success
 * makes the version ready (for an update, atomically replacing the old
 * version); otherwise the integrity status lists exactly what's missing or
 * corrupt and the state is "failed". Verifies the working version (first
 * download, update, repair), or the active version of a ready package.
 */
export async function verifyPackage(
  store: OfflinePackageStore,
  packageId: string,
  options: { now?: () => number; version?: number } = {},
): Promise<VerifyResult> {
  const now = options.now ?? Date.now;
  store.claim(packageId);
  try {
    const record = await store.getRecord(packageId);
    if (!record) throw new StorageError("not-found", "That offline package no longer exists.");
    const target =
      options.version !== undefined
        ? [record.pending, record.active].find((m) => m?.version === options.version)
        : (workTarget(record) ?? record.active);
    if (!target) throw new StorageError("not-found", "That package version no longer exists.");
    const version = target.version;
    const list = await store.getAssetList(packageId, version);
    if (!target.assetsResolved || !list) {
      throw new StorageError("not-ready", "This package hasn't been downloaded yet.");
    }
    // A ready active version keeps its phase while it is re-checked.
    if (target.phase !== "ready") {
      await store.updateTarget(packageId, version, (m) => {
        m.phase = "verifying";
      });
    }
    const ref = versionRef(packageId, version);
    const missing: string[] = [];
    const corrupt: string[] = [];
    const checksums: Record<string, string> = {};
    const perLayer = target.layers.map(() => ({ verified: 0, missing: 0, corrupt: 0, absent: 0 }));

    for (let start = 0; start < list.urls.length; start += BATCH) {
      const urls = list.urls.slice(start, start + BATCH);
      // Read a batch in one transaction, hash outside it.
      const found = await store.backend.read(["assets", "assetData"], async (tx) => {
        const out: { url: string; meta: AssetMeta | null; data: ArrayBuffer | undefined }[] = [];
        for (const url of urls) {
          const metas = await tx.getRange<AssetMeta>("assets", `${url}#`);
          const meta = metas.find((m) => m.refs.includes(ref)) ?? null;
          const data = meta
            ? await tx.get<ArrayBuffer>("assetData", assetKey(meta.url, meta.sha256))
            : undefined;
          out.push({ url, meta, data });
        }
        return out;
      });
      for (let i = 0; i < found.length; i += 1) {
        const { url, meta, data } = found[i];
        const layer = perLayer[list.layerIndex[start + i]];
        if (!meta || !data) {
          missing.push(url);
          if (layer) layer.missing += 1;
          continue;
        }
        const ok = data.byteLength === meta.bytes && (await sha256HexBytes(data)) === meta.sha256;
        if (!ok) {
          corrupt.push(url);
          if (layer) layer.corrupt += 1;
          continue;
        }
        checksums[url] = meta.sha256;
        if (layer) {
          layer.verified += 1;
          if (meta.status === 404) layer.absent += 1;
        }
      }
    }
    const updated = await store.commitVerification(packageId, version, {
      missing,
      corrupt,
      checksums,
      perLayer,
      checkedAt: now(),
    });
    store.release(packageId);
    const status = store.statusOf(updated, now());
    return { ok: missing.length === 0 && corrupt.length === 0, status, missing, corrupt };
  } finally {
    store.release(packageId);
  }
}
