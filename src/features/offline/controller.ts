/**
 * Runs offline map packages for the app (CC-05 wave 2 wiring): opens the
 * package store on the durable database, plugs it into the `fltile://`
 * protocol, and runs one download, check or repair at a time with progress
 * the screens can show. The library is src/lib/offline (docs/storage.md
 * "Offline packages").
 */
import { create } from "zustand";
import { setPackageTileSource, type PackageTileSource } from "../../lib/hunt/tiles.ts";
import { downloadPackage, repairPackage, type DownloadOptions, type DownloadProgress, type DownloadResult } from "../../lib/offline/download.ts";
import { OfflinePackageStore, type CoverageResult, type PackageStatus } from "../../lib/offline/package-store.ts";
import type { PackageBounds, PackagePlan } from "../../lib/offline/plan.ts";
import { createPackageTileSource } from "../../lib/offline/serve.ts";
import { verifyPackage } from "../../lib/offline/verify.ts";
import type { StorageBackend } from "../../lib/storage/backend.ts";
import type { PersistenceResult } from "../../lib/storage/indexeddb.ts";
import { formatCount, type OfflineTaskName } from "./model.ts";

export type OfflineTask = OfflineTaskName;

export type OfflineNotice = { packageId: string | null; text: string; tone: "info" | "error" };

type OfflineState = {
  status: "starting" | "ready" | "unavailable";
  /** Why downloads aren't available, when they aren't. */
  reason: string | null;
  /** Oldest first. */
  packages: PackageStatus[];
  /** Bytes stored per package (shared files count toward each package using them). */
  bytes: Record<string, number>;
  /** Bytes on disk for all packages, shared files counted once. */
  totalBytes: number;
  /** The one operation running in this tab. */
  busy: { packageId: string; task: OfflineTask; progress: DownloadProgress | null } | null;
  notice: OfflineNotice | null;
  persistence: PersistenceResult | null;
};

const INITIAL: OfflineState = {
  status: "starting",
  reason: null,
  packages: [],
  bytes: {},
  totalBytes: 0,
  busy: null,
  notice: null,
  persistence: null,
};

export const useOffline = create<OfflineState>()(() => ({ ...INITIAL }));

let store: OfflinePackageStore | null = null;
let tileSource: PackageTileSource | null = null;
let abort: AbortController | null = null;
/** Extra download options: tests inject a fake network; desktop could add headers. */
let downloadDefaults: Partial<DownloadOptions> = {};

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function notify(packageId: string | null, text: string, tone: OfflineNotice["tone"] = "info") {
  useOffline.setState({ notice: { packageId, text, tone } });
}

/**
 * Opens offline packages on the durable database. With no backend (storage
 * isn't durable here, or the upgrade was refused) downloads stay off and
 * `reason` says why. Safe to call again (tests).
 */
export async function startOfflinePackages(
  backend: StorageBackend | null,
  options: { reason?: string | null; download?: Partial<DownloadOptions> } = {},
): Promise<void> {
  downloadDefaults = options.download ?? {};
  abort?.abort();
  abort = null;
  if (!backend) {
    store = null;
    tileSource = null;
    setPackageTileSource(null);
    useOffline.setState({
      ...INITIAL,
      status: "unavailable",
      reason: `Offline map downloads need this device's durable storage. ${options.reason ?? "It isn't available in this browser."}`.trim(),
    });
    return;
  }
  store = new OfflinePackageStore(backend);
  tileSource = createPackageTileSource(store);
  useOffline.setState({ ...INITIAL, status: "ready" });
  try {
    const packages = await store.listPackages();
    setPackageTileSource(packages.some((p) => p.servable) ? tileSource : null);
    useOffline.setState({ packages });
  } catch {
    // Can't tell whether anything is downloaded: keep reading packages (a
    // failed read is a miss) rather than lose them all session.
    setPackageTileSource(tileSource);
  }
  // The map can start once the list is in; sizes follow.
  void refreshPackages();
}

/** Re-reads the package list and storage use. */
export async function refreshPackages(): Promise<void> {
  if (!store) return;
  try {
    let packages: PackageStatus[];
    try {
      packages = await store.listPackages();
    } catch (error) {
      setPackageTileSource(tileSource);
      throw error;
    }
    // Map tiles look in packages only while one can serve them: no database read per tile otherwise.
    setPackageTileSource(packages.some((p) => p.servable) ? tileSource : null);
    useOffline.setState({ packages });
    // Sizes read every file's metadata: after the list, so startup isn't held up by it.
    const usage = await store.storageUsage();
    useOffline.setState({
      bytes: Object.fromEntries(usage.packages.map((p) => [p.packageId, p.bytes])),
      totalBytes: usage.uniqueBytes,
    });
  } catch (error) {
    notify(null, `Couldn't read downloaded maps: ${errorText(error)}`, "error");
  }
}

/** Which downloaded areas cover a point, at which zooms (FIELD-01). */
export async function coverageAt(point: { lng: number; lat: number } | PackageBounds): Promise<CoverageResult | null> {
  if (!store) return null;
  try {
    return await store.coverage(point);
  } catch {
    return null;
  }
}

function resultText(result: DownloadResult, task: OfflineTask): { text: string; tone: OfflineNotice["tone"] } {
  const m = result.status.update ?? result.status.manifest;
  if (result.state === "ready" || result.state === "stale") {
    const files = formatCount(m.requiredAssetCount);
    const kept =
      result.persistence === "granted"
        ? ""
        : " The browser didn't promise to keep site data, so it could clear downloads if the device runs low on space. Installing Fieldline to the home screen helps.";
    const absent = m.integrityStatus.absentCount ? ` ${formatCount(m.integrityStatus.absentCount)} tiles had no data at the source.` : "";
    const verb = task === "update" ? "Updated" : task === "repair" ? "Repaired" : "Ready offline";
    return { text: `${verb}: all ${files} files downloaded and checked.${absent}${kept}`, tone: "info" };
  }
  if (result.state === "paused") return { text: "Paused. Files already downloaded are kept; resume any time.", tone: "info" };
  const error = m.lastError?.message;
  if (error) return { text: error, tone: "error" };
  if (result.failed.length) {
    return {
      text: `${formatCount(result.failed.length)} file${result.failed.length === 1 ? "" : "s"} didn't download. Resume to fetch only those.`,
      tone: "error",
    };
  }
  return { text: "The download didn't finish. Resume to try again.", tone: "error" };
}

/**
 * Runs one operation with progress. Only one runs at a time in this tab
 * (another tab downloading makes the library reject with `conflict`). The
 * slot is taken synchronously, before any await, so two clicks can't both
 * start; `target` may create the package inside the slot. Resolves to the
 * package id, or null when nothing ran.
 */
async function run(
  target: string | (() => Promise<string>),
  task: OfflineTask,
  work: (options: DownloadOptions, packageId: string) => Promise<{ text: string; tone: OfflineNotice["tone"] }>,
): Promise<string | null> {
  if (!store) return null;
  if (useOffline.getState().busy) {
    notify(typeof target === "string" ? target : null, "Another download is running. Pause it first.", "error");
    return null;
  }
  const controller = new AbortController();
  abort = controller;
  let packageId = typeof target === "string" ? target : "";
  useOffline.setState({ busy: { packageId, task, progress: null }, notice: null });
  let last = 0;
  const options: DownloadOptions = {
    ...downloadDefaults,
    signal: controller.signal,
    onProgress: (progress) => {
      const now = Date.now();
      // A few updates a second is plenty for a progress bar.
      if (now - last < 200 && progress.done < progress.total) return;
      last = now;
      useOffline.setState((state) => (state.busy ? { busy: { ...state.busy, progress } } : {}));
    },
  };
  try {
    if (typeof target !== "string") {
      packageId = await target();
      useOffline.setState((state) => (state.busy ? { busy: { ...state.busy, packageId } } : {}));
      await refreshPackages();
    }
    const outcome = await work(options, packageId);
    notify(packageId, outcome.text, outcome.tone);
  } catch (error) {
    notify(packageId || null, errorText(error), "error");
  } finally {
    if (abort === controller) abort = null;
    useOffline.setState({ busy: null });
    await refreshPackages();
  }
  return packageId || null;
}

/** Creates a package from an `ok` plan and downloads it. Resolves to its id, or null if it couldn't be created. */
export async function downloadArea(plan: PackagePlan, name: string): Promise<string | null> {
  const s = store;
  if (!s) return null;
  return run(
    async () => (await s.createPackage(plan, { name })).packageId,
    "download",
    async (options, packageId) => {
      const result = await downloadPackage(s, packageId, options);
      useOffline.setState({ persistence: result.persistence });
      return resultText(result, "download");
    },
  );
}

/** Continues a first download or an update; if its check found damage, fetches only the bad files. */
export async function resumePackage(packageId: string): Promise<void> {
  const s = store;
  if (!s) return;
  const status = await s.getPackage(packageId);
  if (!status) return;
  const work = status.update ?? status.manifest;
  const damaged = work.integrityStatus.status === "damaged";
  const task: OfflineTask = status.update ? "update" : "download";
  await run(packageId, task, async (options) => {
    const result = damaged ? await repairPackage(s, packageId, options) : await downloadPackage(s, packageId, options);
    useOffline.setState({ persistence: result.persistence });
    return resultText(result, task);
  });
}

/** Pauses the running download; finished files are kept. */
export function pauseDownload(): void {
  abort?.abort();
}

/** Re-checks every file of a downloaded area. */
export async function checkPackage(packageId: string): Promise<void> {
  const s = store;
  if (!s) return;
  await run(packageId, "verify", async () => {
    const result = await verifyPackage(s, packageId);
    if (result.ok) return { text: `Checked: all ${formatCount(result.status.manifest.requiredAssetCount)} files are intact.`, tone: "info" };
    return {
      text: `${formatCount(result.missing.length)} missing and ${formatCount(result.corrupt.length)} damaged file${result.missing.length + result.corrupt.length === 1 ? "" : "s"}. Repair downloads only those.`,
      tone: "error",
    };
  });
}

/** Re-downloads only what the last check found missing or damaged. */
export async function repairArea(packageId: string): Promise<void> {
  const s = store;
  if (!s) return;
  await run(packageId, "repair", async (options) => resultText(await repairPackage(s, packageId, options), "repair"));
}

/** Downloads a fresh copy; the current one stays in use until the new one checks out. */
export async function updateArea(packageId: string): Promise<void> {
  const s = store;
  if (!s) return;
  await run(packageId, "update", async (options) => {
    await s.startUpdate(packageId);
    return resultText(await downloadPackage(s, packageId, options), "update");
  });
}

/** Drops an unfinished update and keeps the current copy. */
export async function discardUpdate(packageId: string): Promise<void> {
  if (!store || useOffline.getState().busy) return;
  try {
    await store.discardPending(packageId);
    notify(packageId, "Update dropped. The earlier copy is still offline.");
  } catch (error) {
    notify(packageId, errorText(error), "error");
  }
  await refreshPackages();
}

/** Deletes a downloaded area. Files other areas share stay. */
export async function deleteArea(packageId: string): Promise<void> {
  if (!store) return;
  if (useOffline.getState().busy?.packageId === packageId) {
    notify(packageId, "Pause the download before deleting it.", "error");
    return;
  }
  const name = useOffline.getState().packages.find((p) => p.packageId === packageId)?.name ?? "the area";
  try {
    const { deletedAssets } = await store.deletePackage(packageId);
    notify(null, `Deleted “${name}” (${formatCount(deletedAssets)} files). Files another downloaded area uses are kept.`);
  } catch (error) {
    notify(packageId, errorText(error), "error");
  }
  await refreshPackages();
}

/** @internal Tests only. */
export function resetOfflineForTests() {
  abort?.abort();
  abort = null;
  store = null;
  tileSource = null;
  downloadDefaults = {};
  setPackageTileSource(null);
  useOffline.setState({ ...INITIAL });
}
