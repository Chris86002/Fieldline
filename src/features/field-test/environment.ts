import { APP_VERSION } from "@/lib/app-version";
import { MemoryBackend, StorageError } from "@/lib/storage/backend";
import { estimateStorage, openIndexedDbBackend, requestPersistentStorage } from "@/lib/storage/indexeddb";
import { BrowserLocationSource } from "../location/browser.ts";
import { parseUserAgent } from "./device.ts";
import { FieldTestRecorder } from "./recorder.ts";
import { FIELD_TEST_DB, prepareFieldTestBackend, type BatteryReading, type BuildInfo, type Capabilities, type DeviceInfo, type FieldTestStore } from "./run-store.ts";

/**
 * Browser wiring for the field-test recorder: build info, device and
 * capability probes, the Battery Status API, and the field-test database.
 * Nothing here asks the user for anything; location permission is requested
 * only when a run starts.
 */

type BatteryManagerLike = { level: number; charging: boolean };
type NavigatorExtras = Navigator & {
  getBattery?: () => Promise<BatteryManagerLike>;
  standalone?: boolean;
  userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string; platformVersion?: string }> };
};

export function buildInfo(flavor: BuildInfo["flavor"]): BuildInfo {
  const commit = import.meta.env.VITE_FIELDLINE_COMMIT;
  return { version: APP_VERSION, commit: typeof commit === "string" && commit ? commit : "unknown", flavor };
}

export async function readBattery(): Promise<BatteryReading | null> {
  const nav = navigator as NavigatorExtras;
  if (!nav.getBattery) return null;
  try {
    const battery = await nav.getBattery();
    return { at: Date.now(), level: battery.level, charging: battery.charging };
  } catch {
    return null;
  }
}

export async function describeDevice(): Promise<DeviceInfo> {
  const nav = navigator as NavigatorExtras;
  const parsed = parseUserAgent(nav.userAgent);
  let model: string | null = null;
  let platformVersion: string | null = null;
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues?.(["model", "platformVersion"]);
    model = hints?.model || null;
    platformVersion = hints?.platformVersion || null;
  } catch {
    // Not shared by this browser.
  }
  const standalone = nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
  return {
    userAgent: nav.userAgent,
    os: parsed.os,
    osVersion: parsed.osVersion,
    browser: parsed.browser,
    browserVersion: parsed.browserVersion,
    model,
    platformVersion,
    standalone,
    screen: typeof screen === "undefined" ? null : `${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
    notes: parsed.notes,
  };
}

export function canShareFiles(): boolean {
  try {
    const probe = new File(["{}"], "probe.json", { type: "application/json" });
    return typeof navigator.share === "function" && navigator.canShare?.({ files: [probe] }) === true;
  } catch {
    return false;
  }
}

export async function capabilities(source: BrowserLocationSource): Promise<Capabilities> {
  const location = source.capabilities();
  const [persistence, estimate] = await Promise.all([requestPersistentStorage(), estimateStorage()]);
  return {
    secureContext: location.secureContext,
    geolocation: location.geolocation,
    permissionsApi: location.permissionsApi,
    wakeLock: location.wakeLock,
    freezeEvents: location.freezeEvents,
    batteryApi: typeof (navigator as NavigatorExtras).getBattery === "function",
    shareFiles: canShareFiles(),
    persistentStorage: persistence,
    storageQuotaBytes: estimate.quota,
    storageUsageBytes: estimate.usage,
  };
}

async function openStore(): Promise<{ store: FieldTestStore | null; error: string | null }> {
  try {
    const backend = await openIndexedDbBackend({ name: FIELD_TEST_DB });
    return { store: await prepareFieldTestBackend(backend), error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Browser storage is unavailable.";
    // A memory store still lets the screen show live counters, but nothing survives a reload.
    if (error instanceof StorageError && error.code === "future-version") return { store: null, error: reason };
    try {
      const store = await prepareFieldTestBackend(new MemoryBackend());
      return { store, error: `Browser storage couldn't be opened (${reason}). This run is kept in memory only and is lost on reload or kill.` };
    } catch {
      return { store: null, error: reason };
    }
  }
}

let recorder: Promise<FieldTestRecorder> | null = null;

/** One recorder per page, so remounts (and React strict mode) share the running test. */
export function getRecorder(flavor: BuildInfo["flavor"]): Promise<FieldTestRecorder> {
  recorder ??= (async () => {
    const source = new BrowserLocationSource();
    const { store, error } = await openStore();
    const instance = new FieldTestRecorder({
      source,
      store,
      storageError: error,
      build: buildInfo(flavor),
      readBattery,
      describeDevice,
      capabilities: () => capabilities(source),
    });
    await instance.init();
    return instance;
  })();
  return recorder;
}
