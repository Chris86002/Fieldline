import { create } from "zustand";
import type { MapView } from "@/lib/hunt/types";
import {
  applySetting,
  DEFAULT_SETTINGS,
  exportSettings,
  importSettings,
  migrateLegacy,
  resetCategory,
  resetPreset,
  resolveSettings,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  settingsState,
  type AppSettings,
  type Category,
  type PresetId,
  type SettingKey,
  type SettingsState,
} from "./schema.ts";

const LEGACY_KEY = "fieldline-v1";

type SettingsStore = SettingsState & {
  /** Defaults + preferences + active preset. Read this, not `prefs`. */
  effective: AppSettings;
  hydrated: boolean;
  /** False while saved settings are damaged, from a newer build, or storage is unavailable. */
  writable: boolean;
  /** Why settings can't be saved, when they can't. */
  warning: string | null;
  /** The saved copy is damaged or newer and can be replaced after backing it up. */
  replaceable: boolean;
  /** Backs up the unreadable saved copy under its own key, then saves current settings. */
  replaceSaved: () => { ok: boolean; message: string };
  set: <K extends SettingKey>(key: K, value: AppSettings[K]) => void;
  usePreset: (id: PresetId | null) => void;
  resetPreset: (id: PresetId) => void;
  resetCategory: (category: Category) => void;
  setHome: (view: MapView) => void;
  exportText: () => string;
  importText: (text: string) => { ok: boolean; message: string };
};

let canWrite = false;

function readStorage(key: string): string | null {
  return globalThis.localStorage.getItem(key);
}

function legacyState(): SettingsState {
  try {
    const raw = readStorage(LEGACY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const state = parsed && typeof parsed === "object" ? (parsed as { state?: unknown }).state : null;
    return { prefs: migrateLegacy(state), preset: null, presetEdits: {} };
  } catch {
    return { prefs: { ...DEFAULT_SETTINGS }, preset: null, presetEdits: {} };
  }
}

/** `fresh`: nothing was saved yet, so the state came from fieldline-v1 or defaults. */
type Loaded = { state: SettingsState; writable: boolean; warning: string | null; replaceable: boolean; fresh?: boolean };

export const SETTINGS_BACKUP_PREFIX = `${SETTINGS_KEY}-backup-`;

/**
 * Loads settings. With no settings saved yet, preferences migrate from
 * fieldline-v1, which is left untouched for older builds. A corrupt copy or one
 * from a newer Fieldline is never overwritten.
 */
export function loadSettings(): Loaded {
  let raw: string | null;
  try {
    raw = readStorage(SETTINGS_KEY);
  } catch {
    return {
      state: { prefs: { ...DEFAULT_SETTINGS }, preset: null, presetEdits: {} },
      writable: false,
      warning: "Browser storage is unavailable. Settings changes won't be saved on this device.",
      replaceable: false,
    };
  }
  if (raw === null) return { state: legacyState(), writable: true, warning: null, replaceable: false, fresh: true };
  const damaged: Loaded = {
    state: legacyState(),
    writable: false,
    warning: "Saved settings couldn't be read. Their stored copy was left untouched.",
    replaceable: true,
  };
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return damaged;
  }
  if (!envelope || typeof envelope !== "object") return damaged;
  const { version, state: saved } = envelope as { version?: unknown; state?: { prefs?: unknown; preset?: unknown; presetEdits?: unknown } };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return damaged;
  const parsed = settingsState(saved ?? {});
  const state = { prefs: parsed.prefs, preset: parsed.preset, presetEdits: parsed.presetEdits };
  if (version > SETTINGS_VERSION) {
    return { state, writable: false, warning: "These settings were saved by a newer Fieldline. Changes won't be saved until you update.", replaceable: true };
  }
  return {
    state,
    writable: true,
    warning: parsed.rejected.length ? `Some saved settings were invalid and use defaults: ${parsed.rejected.join(", ")}.` : null,
    replaceable: false,
  };
}

const NOT_SAVED = "Settings changes aren't being saved on this device.";

/** Saves settings. Returns why they weren't saved, or null when they were. */
function persist(state: SettingsState): string | null {
  if (!canWrite) return NOT_SAVED;
  try {
    globalThis.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, state: { prefs: state.prefs, preset: state.preset, presetEdits: state.presetEdits } }));
    return null;
  } catch {
    canWrite = false;
    return "Browser storage is full or unavailable. Settings changes won't be saved on this device.";
  }
}

function withEffective(state: SettingsState) {
  return { prefs: state.prefs, preset: state.preset, presetEdits: state.presetEdits, effective: resolveSettings(state) };
}

export const useSettings = create<SettingsStore>()((set, get) => {
  const commit = (next: SettingsState): string | null => {
    const problem = persist(next);
    // Keep the more specific load-time warning when one is showing.
    set({ ...withEffective(next), writable: canWrite, ...(problem ? { warning: get().warning ?? problem } : {}) });
    return problem;
  };
  return {
    ...withEffective({ prefs: { ...DEFAULT_SETTINGS }, preset: null, presetEdits: {} }),
    hydrated: false,
    writable: false,
    warning: null,
    replaceable: false,
    set: (key, value) => void commit(applySetting(get(), key, value)),
    usePreset: (id) => void commit({ ...get(), preset: id }),
    resetPreset: (id) => void commit(resetPreset(get(), id)),
    resetCategory: (category) => void commit(resetCategory(get(), category)),
    setHome: (view) => void commit(applySetting(get(), "homeView", view)),
    exportText: () => exportSettings(get()),
    importText: (text) => {
      const result = importSettings(text, get());
      if (!result.ok) return { ok: false, message: result.error };
      const problem = commit(result.state);
      const skipped = result.rejected.length ? ` ${result.rejected.length} invalid value${result.rejected.length === 1 ? " was" : "s were"} skipped.` : "";
      if (problem) return { ok: false, message: `Settings applied for now but not saved: ${problem}${skipped}` };
      return { ok: true, message: `Settings imported.${skipped}` };
    },
    replaceSaved: () => {
      if (!get().replaceable) return { ok: false, message: "There is no damaged settings copy to replace." };
      try {
        const raw = readStorage(SETTINGS_KEY);
        if (raw !== null) globalThis.localStorage.setItem(`${SETTINGS_BACKUP_PREFIX}${new Date().toISOString()}`, raw);
      } catch {
        return { ok: false, message: "Couldn't back up the old settings, so they were left as they are." };
      }
      canWrite = true;
      set({ warning: null, replaceable: false });
      const problem = commit(get());
      if (problem) return { ok: false, message: problem };
      return { ok: true, message: "Settings saved. The old copy was kept as a backup in this browser." };
    },
  };
});

/** Reads saved settings into the store. Call once on the client before showing the map. */
export function hydrateSettings() {
  const loaded = loadSettings();
  canWrite = loaded.writable;
  // Save the first result once. Otherwise every later load would re-migrate from
  // fieldline-v1, whose own defaults (written by the content store) would then
  // override newer settings defaults for a brand-new profile.
  const problem = loaded.fresh ? persist(loaded.state) : null;
  useSettings.setState({
    ...withEffective(loaded.state),
    hydrated: true,
    writable: canWrite,
    warning: loaded.warning ?? problem,
    replaceable: loaded.replaceable,
  });
}

export function useSetting<K extends SettingKey>(key: K): AppSettings[K] {
  return useSettings((state) => state.effective[key]);
}
