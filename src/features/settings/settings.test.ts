import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import {
  applySetting,
  DEFAULT_SETTINGS,
  exportSettings,
  FIELDS,
  importSettings,
  migrateLegacy,
  parseSettings,
  presetControls,
  resetCategory,
  resolveSettings,
  SETTING_KEYS,
  type SettingsState,
} from "./schema.ts";
import { hydrateSettings, loadSettings, useSettings } from "./store.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  return values;
}

after(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const base = (): SettingsState => ({ prefs: { ...DEFAULT_SETTINGS }, preset: null, presetEdits: {} });

// An older fieldline-v1 profile: metric user, topo map, faint public land, some layers off.
const legacyProfile = {
  state: {
    waypoints: [{ id: "w1", name: "Saddle", kind: "glass", lng: -114.9, lat: 44.1, notes: "", hunt: "", goodWinds: [], createdAt: 1 }],
    tracks: [],
    basemap: "topo",
    showPublic: true,
    publicOpacity: 0.35,
    showRoads: false,
    showPeaks: false,
    terrain: true,
    imperial: false,
    huntRegion: "id",
    lastView: { lng: -114.9, lat: 44.1, zoom: 11, bearing: 0, pitch: 0 },
  },
  version: 0,
};

describe("settings schema", () => {
  it("gives every setting a default that passes its own validator", () => {
    const { settings, rejected } = parseSettings(DEFAULT_SETTINGS);
    assert.deepEqual(rejected, []);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    for (const key of SETTING_KEYS) assert.ok(FIELDS[key].label, `${key} needs a label`);
  });

  it("migrates old preferences without changing units or map choices", () => {
    const settings = migrateLegacy(legacyProfile.state);
    assert.equal(settings.basemap, "topo");
    assert.equal(settings.publicOpacity, 0.35);
    assert.equal(settings.showRoads, false);
    assert.equal(settings.showPeaks, false);
    assert.equal(settings.terrain, true);
    assert.equal(settings.distanceUnit, "metric");
    assert.equal(settings.elevationUnit, "m");
    assert.equal(settings.temperatureUnit, "C");
    assert.equal(settings.pressureUnit, "hPa");
    assert.equal(settings.startupView, "last");
  });

  it("keeps valid values and rejects invalid ones individually", () => {
    const { settings, rejected } = parseSettings({ basemap: "moon", publicOpacity: 4, terrain: true, speedUnit: "knots", gpsMinMoveM: Number.NaN });
    assert.deepEqual(rejected.sort(), ["basemap", "gpsMinMoveM", "publicOpacity"]);
    assert.equal(settings.terrain, true);
    assert.equal(settings.speedUnit, "knots");
    assert.equal(settings.basemap, DEFAULT_SETTINGS.basemap);
  });

  it("applies a preset without erasing the preferences underneath", () => {
    let state = applySetting(base(), "terrain", false);
    state = { ...state, preset: "scouting" };
    assert.equal(resolveSettings(state).terrain, true);
    state = applySetting(state, "terrainExaggeration", 2);
    assert.equal(resolveSettings(state).terrainExaggeration, 2);
    assert.equal(state.prefs.terrainExaggeration, DEFAULT_SETTINGS.terrainExaggeration, "editing a preset leaves preferences alone");
    assert.equal(presetControls(state, "terrain"), true);
    assert.equal(presetControls(state, "speedUnit"), false);
    state = applySetting(state, "speedUnit", "kmh");
    assert.equal(state.prefs.speedUnit, "kmh", "keys the preset doesn't control still change preferences");
    state = { ...state, preset: null };
    assert.equal(resolveSettings(state).terrain, false);
    assert.equal(resolveSettings(state).terrainExaggeration, DEFAULT_SETTINGS.terrainExaggeration);
  });

  it("resets one category without touching another", () => {
    let state = applySetting(base(), "speedUnit", "knots");
    state = applySetting(state, "showRoads", false);
    state = resetCategory(state, "units");
    assert.equal(state.prefs.speedUnit, DEFAULT_SETTINGS.speedUnit);
    assert.equal(state.prefs.showRoads, false);
  });

  it("round-trips through export and import", () => {
    let state = applySetting(base(), "temperatureUnit", "C");
    state = applySetting(state, "homeView", { lng: -150, lat: 61.2, zoom: 8, bearing: 0, pitch: 0 });
    state = { ...state, preset: "field" };
    state = applySetting(state, "gpsMinMoveM", 20);
    const result = importSettings(exportSettings(state), base());
    assert.ok(result.ok);
    assert.deepEqual(result.state, state);
    assert.deepEqual(result.rejected, []);
  });

  it("rejects foreign files and settings from a newer version", () => {
    assert.equal(importSettings("{", base()).ok, false);
    assert.equal(importSettings(JSON.stringify({ format: "other" }), base()).ok, false);
    const newer = JSON.stringify({ format: "fieldline-settings", version: 99, prefs: {} });
    const result = importSettings(newer, base());
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /newer Fieldline/);
  });

  it("rejects exports without preferences or with an impossible version", () => {
    for (const body of [
      { format: "fieldline-settings", version: 1 },
      { format: "fieldline-settings", version: 1, prefs: "x" },
      { format: "fieldline-settings", version: 0, prefs: {} },
      { format: "fieldline-settings", version: 0.5, prefs: {} },
    ]) {
      const result = importSettings(JSON.stringify(body), base());
      assert.equal(result.ok, false, JSON.stringify(body));
    }
  });

  it("keeps the home area when its category is reset", () => {
    const home = { lng: -150, lat: 61.2, zoom: 8, bearing: 0, pitch: 0 };
    let state = applySetting(base(), "homeView", home);
    state = applySetting(state, "basemap", "topo");
    state = resetCategory(state, "map");
    assert.deepEqual(state.prefs.homeView, home);
    assert.equal(state.prefs.basemap, DEFAULT_SETTINGS.basemap);
  });

  it("imports valid values from a partly invalid export", () => {
    const text = JSON.stringify({ format: "fieldline-settings", version: 1, prefs: { speedUnit: "knots", basemap: 3 }, preset: "bogus" });
    const result = importSettings(text, base());
    assert.ok(result.ok);
    assert.equal(result.state.prefs.speedUnit, "knots");
    assert.equal(result.state.prefs.basemap, DEFAULT_SETTINGS.basemap);
    assert.equal(result.state.preset, null);
    assert.deepEqual(result.rejected, ["basemap"]);
  });
});

describe("settings persistence", () => {
  beforeEach(() => {
    useSettings.setState({ hydrated: false, warning: null });
  });

  it("migrates from fieldline-v1 on first load and leaves the old copy untouched", () => {
    const legacyText = JSON.stringify(legacyProfile);
    const storage = installStorage({ "fieldline-v1": legacyText });
    hydrateSettings();
    const { effective } = useSettings.getState();
    assert.equal(effective.distanceUnit, "metric");
    assert.equal(effective.basemap, "topo");
    useSettings.getState().set("speedUnit", "kmh");
    assert.equal(storage.get("fieldline-v1"), legacyText, "personal data and legacy preferences stay as they were");
    const saved = JSON.parse(storage.get("fieldline-settings") ?? "null");
    assert.equal(saved.version, 1);
    assert.equal(saved.state.prefs.speedUnit, "kmh");
    assert.equal(saved.state.prefs.distanceUnit, "metric");
  });

  it("survives a restart", () => {
    const storage = installStorage({});
    hydrateSettings();
    useSettings.getState().set("coordinateFormat", "utm");
    useSettings.getState().usePreset("scouting");
    installStorage(Object.fromEntries(storage));
    hydrateSettings();
    const state = useSettings.getState();
    assert.equal(state.effective.coordinateFormat, "utm");
    assert.equal(state.preset, "scouting");
    assert.equal(state.effective.terrain, true);
  });

  it("does not overwrite corrupt or newer settings", () => {
    const storage = installStorage({ "fieldline-settings": "{" });
    hydrateSettings();
    assert.match(useSettings.getState().warning ?? "", /left untouched/);
    useSettings.getState().set("speedUnit", "kmh");
    assert.equal(storage.get("fieldline-settings"), "{");

    const newer = JSON.stringify({ version: 7, state: { prefs: { speedUnit: "knots" } } });
    const later = installStorage({ "fieldline-settings": newer });
    hydrateSettings();
    assert.equal(useSettings.getState().effective.speedUnit, "knots", "still reads what it understands");
    useSettings.getState().set("speedUnit", "mph");
    assert.equal(later.get("fieldline-settings"), newer);
  });

  it("recovers from damaged settings only after backing them up", () => {
    const storage = installStorage({ "fieldline-settings": "{" });
    hydrateSettings();
    assert.equal(useSettings.getState().replaceable, true);
    const result = useSettings.getState().replaceSaved();
    assert.equal(result.ok, true);
    const backups = [...storage.keys()].filter((key) => key.startsWith("fieldline-settings-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(storage.get(backups[0]), "{", "the damaged copy is preserved byte for byte");
    useSettings.getState().set("speedUnit", "kmh");
    assert.equal(JSON.parse(storage.get("fieldline-settings") ?? "null").state.prefs.speedUnit, "kmh");
  });

  it("treats saved settings without a version as damaged, not newer", () => {
    installStorage({ "fieldline-settings": JSON.stringify({ state: { prefs: {} } }) });
    const loaded = loadSettings();
    assert.equal(loaded.writable, false);
    assert.match(loaded.warning ?? "", /couldn't be read/);
  });

  it("says when an import could not be saved", () => {
    installStorage({ "fieldline-settings": JSON.stringify({ version: 9, state: { prefs: {} } }) });
    hydrateSettings();
    const result = useSettings.getState().importText(exportSettings(base()));
    assert.equal(result.ok, false);
    assert.match(result.message, /not saved/);
  });

  it("reports invalid saved values instead of hiding them", () => {
    installStorage({ "fieldline-settings": JSON.stringify({ version: 1, state: { prefs: { basemap: "moon" } } }) });
    const loaded = loadSettings();
    assert.equal(loaded.writable, true);
    assert.match(loaded.warning ?? "", /basemap/);
    assert.equal(loaded.state.prefs.basemap, DEFAULT_SETTINGS.basemap);
  });
});
