import type { Basemap, MapView } from "@/lib/hunt/types";
import type { LabelDensity } from "@/features/map/labels";
import type { BoundaryStrength } from "@/features/map/tokens";

export type { BoundaryStrength, LabelDensity };

/**
 * Versioned, validated user preferences. Every field has a default, a
 * validator, a category, and a real effect in the app. Settings never hold
 * marks, tracks, packages, or credentials, so resetting or importing them
 * cannot touch personal content.
 */
export const SETTINGS_VERSION = 1;
export const SETTINGS_KEY = "fieldline-settings";
export const SETTINGS_FORMAT = "fieldline-settings";

export type CoordinateFormat = "dd" | "dms" | "utm";
export type DistanceUnit = "imperial" | "metric";
export type ElevationUnit = "ft" | "m";
export type AreaUnit = "acres" | "hectares";
export type SpeedUnit = "mph" | "kmh" | "mps" | "knots";
export type TemperatureUnit = "F" | "C";
export type PressureUnit = "inHg" | "hPa";
export type StartupView = "last" | "home" | "national";
export type MotionPreference = "system" | "reduce" | "full";
export type WeatherLocation = "pointer" | "center" | "selected";

export type AppSettings = {
  basemap: Basemap;
  showPublic: boolean;
  publicOpacity: number;
  showUnits: boolean;
  showUnitLabels: boolean;
  showBorder: boolean;
  boundaryStrength: BoundaryStrength;
  showRoads: boolean;
  showTracks: boolean;
  showCreeks: boolean;
  showPeaks: boolean;
  showLabels: boolean;
  labelDensity: LabelDensity;
  showMarks: boolean;
  showShade: boolean;
  showSun: boolean;
  showRings: boolean;
  terrain: boolean;
  terrainExaggeration: number;
  coordinateFormat: CoordinateFormat;
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
  areaUnit: AreaUnit;
  speedUnit: SpeedUnit;
  temperatureUnit: TemperatureUnit;
  pressureUnit: PressureUnit;
  startupView: StartupView;
  homeView: MapView | null;
  motion: MotionPreference;
  gpsMinMoveM: number;
  gpsMaxAccuracyM: number;
  keepAwake: boolean;
  weatherLocation: WeatherLocation;
  daylightWindow: boolean;
  daylightBeforeMin: number;
  daylightAfterMin: number;
};

export type SettingKey = keyof AppSettings;

export type Category = "map" | "units" | "field" | "weather" | "hunt" | "access";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "map", label: "Map and display" },
  { id: "units", label: "Units and coordinates" },
  { id: "field", label: "Field and GPS" },
  { id: "weather", label: "Weather" },
  { id: "hunt", label: "Hunt planning" },
  { id: "access", label: "Accessibility" },
];

type Choice<T extends string> = { value: T; label: string };

export type FieldSpec =
  | { kind: "toggle"; category: Category; label: string; help: string }
  | { kind: "choice"; category: Category; label: string; help: string; choices: Choice<string>[] }
  | { kind: "range"; category: Category; label: string; help: string; min: number; max: number; step: number; unit?: string }
  | { kind: "view"; category: Category; label: string; help: string };

const BASEMAPS: Choice<Basemap>[] = [
  { value: "hybrid", label: "Hybrid" },
  { value: "satellite", label: "Satellite" },
  { value: "usgs", label: "USGS imagery" },
  { value: "topo", label: "Topo" },
  { value: "street", label: "Street" },
];

/** UI metadata and validation bounds for every setting, in display order. */
export const FIELDS: Record<SettingKey, FieldSpec> = {
  basemap: {
    kind: "choice",
    category: "map",
    label: "Base map",
    help: "Esri imagery is live only. USGS imagery and the USGS topo scan can be saved for offline use.",
    choices: BASEMAPS,
  },
  showPublic: { kind: "toggle", category: "map", label: "Public land", help: "BLM surface-management agency colors." },
  publicOpacity: { kind: "range", category: "map", label: "Public land strength", help: "How strongly agency colors cover the map.", min: 0.1, max: 0.9, step: 0.05 },
  showUnits: { kind: "toggle", category: "map", label: "Hunt units", help: "Game-management unit lines where Fieldline has them." },
  showUnitLabels: { kind: "toggle", category: "map", label: "Unit numbers", help: "Hidden when zoomed far out." },
  showBorder: { kind: "toggle", category: "map", label: "State border", help: "The state outline for the current hunt state." },
  boundaryStrength: {
    kind: "choice",
    category: "map",
    label: "Boundary strength",
    help: "How heavily hunt-unit and state lines draw. Strong is close to the older, heavier lines.",
    choices: [
      { value: "subtle", label: "Subtle" },
      { value: "standard", label: "Standard" },
      { value: "strong", label: "Strong" },
    ],
  },
  showRoads: { kind: "toggle", category: "map", label: "Roads", help: "A drawn road is not proof of legal access." },
  showTracks: { kind: "toggle", category: "map", label: "Forest tracks", help: "Tracks and trails, from closer zoom." },
  showCreeks: { kind: "toggle", category: "map", label: "Creeks", help: "Rivers and named creeks. A symbol is not proof of water." },
  showPeaks: { kind: "toggle", category: "map", label: "Peaks", help: "Summit names and elevations." },
  showLabels: { kind: "toggle", category: "map", label: "Towns", help: "Cities, towns, and small places." },
  labelDensity: {
    kind: "choice",
    category: "map",
    label: "Label density",
    help: "How many town, peak, creek, and road names show, and how soon as you zoom in. Unit numbers and your own marks are not reduced.",
    choices: [
      { value: "fewer", label: "Fewer" },
      { value: "standard", label: "Standard" },
      { value: "more", label: "More" },
    ],
  },
  showMarks: { kind: "toggle", category: "map", label: "My marks", help: "Your saved waypoints on the map." },
  showShade: { kind: "toggle", category: "map", label: "Sun shade", help: "Shaded faces follow the sun time on the shade bar. Not cast shadows." },
  showSun: { kind: "toggle", category: "map", label: "Sun lines", help: "Sunrise, sunset, and current sun direction from the selected mark." },
  showRings: { kind: "toggle", category: "map", label: "Range rings", help: "100, 200, and 400 yards or meters around the selected mark." },
  terrain: { kind: "toggle", category: "map", label: "3D terrain", help: "Tilted relief. Heavier on a phone." },
  terrainExaggeration: { kind: "range", category: "map", label: "Terrain exaggeration", help: "Display only. Elevation readouts keep real values.", min: 1, max: 3, step: 0.05, unit: "×" },
  coordinateFormat: {
    kind: "choice",
    category: "units",
    label: "Coordinate format",
    help: "WGS84. Tap the coordinate readout to cycle formats.",
    choices: [
      { value: "dd", label: "Decimal degrees" },
      { value: "dms", label: "Degrees, minutes, seconds" },
      { value: "utm", label: "UTM" },
    ],
  },
  distanceUnit: {
    kind: "choice",
    category: "units",
    label: "Distance",
    help: "Measurements, tracks, range rings, and the scale bar.",
    choices: [
      { value: "imperial", label: "Yards / miles" },
      { value: "metric", label: "Meters / km" },
    ],
  },
  elevationUnit: {
    kind: "choice",
    category: "units",
    label: "Elevation",
    help: "Spot elevation and peak labels.",
    choices: [
      { value: "ft", label: "Feet" },
      { value: "m", label: "Meters" },
    ],
  },
  areaUnit: {
    kind: "choice",
    category: "units",
    label: "Area",
    help: "Measured areas.",
    choices: [
      { value: "acres", label: "Acres" },
      { value: "hectares", label: "Hectares" },
    ],
  },
  speedUnit: {
    kind: "choice",
    category: "units",
    label: "Wind speed",
    help: "Wind and gusts.",
    choices: [
      { value: "mph", label: "mph" },
      { value: "kmh", label: "km/h" },
      { value: "mps", label: "m/s" },
      { value: "knots", label: "knots" },
    ],
  },
  temperatureUnit: {
    kind: "choice",
    category: "units",
    label: "Temperature",
    help: "Air and feels-like temperature.",
    choices: [
      { value: "F", label: "°F" },
      { value: "C", label: "°C" },
    ],
  },
  pressureUnit: {
    kind: "choice",
    category: "units",
    label: "Pressure",
    help: "Barometer, reduced to sea level.",
    choices: [
      { value: "inHg", label: "inHg" },
      { value: "hPa", label: "hPa" },
    ],
  },
  startupView: {
    kind: "choice",
    category: "map",
    label: "Open the map at",
    help: "Where Fieldline starts. Your home area is set below.",
    choices: [
      { value: "last", label: "Last view" },
      { value: "home", label: "Home area" },
      { value: "national", label: "National overview" },
    ],
  },
  homeView: { kind: "view", category: "map", label: "Home area", help: "Saved from the current map view." },
  motion: {
    kind: "choice",
    category: "access",
    label: "Motion",
    help: "Reduce animated map moves. System follows your device setting.",
    choices: [
      { value: "system", label: "System" },
      { value: "reduce", label: "Reduce" },
      { value: "full", label: "Full" },
    ],
  },
  gpsMinMoveM: { kind: "range", category: "field", label: "Track point spacing", help: "Minimum movement before a new track point is kept.", min: 2, max: 50, step: 1, unit: "m" },
  gpsMaxAccuracyM: {
    kind: "range",
    category: "field",
    label: "Reject fixes worse than",
    help: "Track points with a larger accuracy circle are skipped, not drawn as your path.",
    min: 10,
    max: 500,
    step: 5,
    unit: "m",
  },
  keepAwake: { kind: "toggle", category: "field", label: "Keep screen on while tracking", help: "Uses the screen wake lock where this browser supports it. Uses more battery." },
  weatherLocation: {
    kind: "choice",
    category: "weather",
    label: "Forecast location",
    help: "Which point the weather card describes. The card always says where.",
    choices: [
      { value: "pointer", label: "Pointer or pinned spot" },
      { value: "center", label: "Map center" },
      { value: "selected", label: "Selected mark" },
    ],
  },
  daylightWindow: {
    kind: "toggle",
    category: "hunt",
    label: "Personal light window",
    help: "Your own minutes around sunrise and sunset. A planning aid, not a legal shooting-hours rule.",
  },
  daylightBeforeMin: { kind: "range", category: "hunt", label: "Minutes before sunrise", help: "Start of your personal window.", min: 0, max: 90, step: 5, unit: "min" },
  daylightAfterMin: { kind: "range", category: "hunt", label: "Minutes after sunset", help: "End of your personal window.", min: 0, max: 90, step: 5, unit: "min" },
};

export const DEFAULT_SETTINGS: AppSettings = {
  basemap: "hybrid",
  showPublic: true,
  // 0.62 before MAP-02. New profiles only: saved and migrated values are kept (see docs/map-design.md).
  publicOpacity: 0.25,
  showUnits: true,
  showUnitLabels: true,
  showBorder: true,
  boundaryStrength: "standard",
  showRoads: true,
  showTracks: true,
  showCreeks: true,
  showPeaks: true,
  showLabels: true,
  labelDensity: "standard",
  showMarks: true,
  showShade: true,
  showSun: true,
  showRings: true,
  terrain: false,
  terrainExaggeration: 1.15,
  coordinateFormat: "dd",
  distanceUnit: "imperial",
  elevationUnit: "ft",
  areaUnit: "acres",
  speedUnit: "mph",
  temperatureUnit: "F",
  pressureUnit: "inHg",
  startupView: "last",
  homeView: null,
  motion: "system",
  gpsMinMoveM: 8,
  gpsMaxAccuracyM: 100,
  keepAwake: false,
  weatherLocation: "pointer",
  daylightWindow: true,
  daylightBeforeMin: 30,
  daylightAfterMin: 30,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseView(value: unknown): MapView | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const view = value as Record<string, unknown>;
  const { lng, lat, zoom, bearing, pitch } = view;
  if (!finite(lng) || !finite(lat) || !finite(zoom) || !finite(bearing) || !finite(pitch)) return undefined;
  if (lng < -180 || lng > 180 || lat < -85.06 || lat > 85.06 || zoom < 0 || zoom > 24 || pitch < 0 || pitch > 85) return undefined;
  const wrapped = ((bearing % 360) + 360) % 360;
  return { lng, lat, zoom, bearing: wrapped > 180 ? wrapped - 360 : wrapped, pitch };
}

/** Validates one setting. Returns undefined when the value is unusable. */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): AppSettings[K] | undefined {
  const spec = FIELDS[key];
  if (spec.kind === "toggle") return (typeof value === "boolean" ? value : undefined) as AppSettings[K] | undefined;
  if (spec.kind === "choice") {
    return (typeof value === "string" && spec.choices.some((choice) => choice.value === value) ? value : undefined) as AppSettings[K] | undefined;
  }
  if (spec.kind === "range") {
    if (!finite(value) || value < spec.min || value > spec.max) return undefined;
    return value as AppSettings[K];
  }
  return parseView(value) as AppSettings[K] | undefined;
}

export type ParsedSettings = { settings: AppSettings; rejected: SettingKey[] };

/** Validates a full or partial settings object field by field, keeping every valid value. */
export function parseSettings(input: unknown, base: AppSettings = DEFAULT_SETTINGS): ParsedSettings {
  const settings: AppSettings = { ...base };
  const rejected: SettingKey[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { settings, rejected };
  const raw = input as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    if (!(key in raw)) continue;
    const parsed = parseSetting(key, raw[key]);
    if (parsed === undefined) rejected.push(key);
    else (settings as Record<SettingKey, unknown>)[key] = parsed;
  }
  return { settings, rejected };
}

/**
 * Builds settings from the preference fields that fieldline-v1 stored before
 * settings were versioned. Established units and map choices carry over; the
 * old single `imperial` switch sets every unit family the same way.
 */
export function migrateLegacy(legacy: unknown): AppSettings {
  const state = legacy && typeof legacy === "object" ? (legacy as Record<string, unknown>) : {};
  const { settings } = parseSettings(state);
  if (typeof state.imperial === "boolean") {
    const imperial = state.imperial;
    settings.distanceUnit = imperial ? "imperial" : "metric";
    settings.elevationUnit = imperial ? "ft" : "m";
    settings.areaUnit = imperial ? "acres" : "hectares";
    settings.speedUnit = imperial ? "mph" : "mps";
    settings.temperatureUnit = imperial ? "F" : "C";
    settings.pressureUnit = imperial ? "inHg" : "hPa";
  }
  // Older builds allowed 0.3–0.9 public-land strength; keep the user's value if it is in range.
  return settings;
}

export type PresetId = "field" | "scouting";

export type Preset = { id: PresetId; label: string; description: string; values: Partial<AppSettings> };

export const PRESETS: Record<PresetId, Preset> = {
  field: {
    id: "field",
    label: "Field / battery saver",
    description: "Flat map, no sun-shade animation, reduced motion, and wider track spacing.",
    values: { terrain: false, showShade: false, motion: "reduce", gpsMinMoveM: 15, keepAwake: false },
  },
  scouting: {
    id: "scouting",
    label: "Scouting / terrain",
    description: "3D terrain with extra relief, sun shade, and unit lines on imagery.",
    values: { basemap: "hybrid", terrain: true, terrainExaggeration: 1.5, showShade: true, showUnits: true },
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as string[]).includes(value);
}

export type PresetEdits = Partial<Record<PresetId, Partial<AppSettings>>>;

/** The settings the user chose, an optional preset, and the user's edits to presets. */
export type SettingsState = {
  prefs: AppSettings;
  preset: PresetId | null;
  presetEdits: PresetEdits;
};

export function presetValues(id: PresetId, edits: PresetEdits): Partial<AppSettings> {
  return { ...PRESETS[id].values, ...(edits[id] ?? {}) };
}

/** Effective values: defaults, then the user's preferences, then the active preset. */
export function resolveSettings(state: SettingsState): AppSettings {
  if (!state.preset) return state.prefs;
  return { ...state.prefs, ...presetValues(state.preset, state.presetEdits) };
}

/** The setting key is currently controlled by the active preset. */
export function presetControls(state: SettingsState, key: SettingKey): boolean {
  return state.preset !== null && key in PRESETS[state.preset].values;
}

/**
 * Applies a change. While a preset controls the key, the change edits that
 * preset, so the user's own preference underneath is never overwritten.
 */
export function applySetting<K extends SettingKey>(state: SettingsState, key: K, value: AppSettings[K]): SettingsState {
  const parsed = parseSetting(key, value);
  if (parsed === undefined) return state;
  if (state.preset && presetControls(state, key)) {
    const id = state.preset;
    return { ...state, presetEdits: { ...state.presetEdits, [id]: { ...(state.presetEdits[id] ?? {}), [key]: parsed } } };
  }
  return { ...state, prefs: { ...state.prefs, [key]: parsed } };
}

/** Keys a category reset leaves alone because the user saved them deliberately. */
const KEPT_ON_RESET: SettingKey[] = ["homeView"];

/**
 * Resets one category's preferences. Values the active preset controls keep
 * coming from the preset until it is turned off.
 */
export function resetCategory(state: SettingsState, category: Category): SettingsState {
  const prefs = { ...state.prefs };
  for (const key of SETTING_KEYS) {
    if (FIELDS[key].category === category && !KEPT_ON_RESET.includes(key)) {
      (prefs as Record<SettingKey, unknown>)[key] = DEFAULT_SETTINGS[key];
    }
  }
  return { ...state, prefs };
}

export function resetPreset(state: SettingsState, id: PresetId): SettingsState {
  const presetEdits = { ...state.presetEdits };
  delete presetEdits[id];
  return { ...state, presetEdits };
}

function parsePresetEdits(input: unknown): PresetEdits {
  const edits: PresetEdits = {};
  if (!input || typeof input !== "object") return edits;
  for (const id of PRESET_IDS) {
    const raw = (input as Record<string, unknown>)[id];
    if (!raw || typeof raw !== "object") continue;
    const controlled: Partial<AppSettings> = {};
    for (const key of Object.keys(PRESETS[id].values) as SettingKey[]) {
      const value = parseSetting(key, (raw as Record<string, unknown>)[key]);
      if (value !== undefined) (controlled as Record<SettingKey, unknown>)[key] = value;
    }
    edits[id] = controlled;
  }
  return edits;
}

export function settingsState(input: { prefs?: unknown; preset?: unknown; presetEdits?: unknown }, base?: AppSettings): ParsedSettings & SettingsState {
  const { settings, rejected } = parseSettings(input.prefs, base);
  return {
    settings,
    rejected,
    prefs: settings,
    preset: isPresetId(input.preset) ? input.preset : null,
    presetEdits: parsePresetEdits(input.presetEdits),
  };
}

export function exportSettings(state: SettingsState, exportedAt = new Date()): string {
  return JSON.stringify(
    { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, exportedAt: exportedAt.toISOString(), prefs: state.prefs, preset: state.preset, presetEdits: state.presetEdits },
    null,
    2,
  );
}

export type ImportResult = { ok: true; state: SettingsState; rejected: SettingKey[] } | { ok: false; error: string };

/** Reads a settings export. Invalid values are rejected one by one; valid ones are kept. */
export function importSettings(text: string, current: SettingsState): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a Fieldline settings export." };
  }
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== SETTINGS_FORMAT) {
    return { ok: false, error: "That file isn't a Fieldline settings export." };
  }
  const { version, prefs } = raw as { version?: unknown; prefs?: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: "That settings file is damaged." };
  }
  if (version > SETTINGS_VERSION) {
    return { ok: false, error: "Those settings come from a newer Fieldline. Update this app first." };
  }
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
    return { ok: false, error: "That settings file is damaged." };
  }
  const parsed = settingsState(raw as { prefs?: unknown; preset?: unknown; presetEdits?: unknown }, current.prefs);
  return { ok: true, state: { prefs: parsed.prefs, preset: parsed.preset, presetEdits: parsed.presetEdits }, rejected: parsed.rejected };
}
