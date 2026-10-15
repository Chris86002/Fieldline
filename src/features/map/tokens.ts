import type { Basemap } from "@/lib/hunt/types";

/**
 * Map design tokens (spec §17 "Shared design system"). Every color and weight
 * the map style uses comes from here, per style family, instead of constants
 * scattered through MapCanvas.
 *
 * Families (MAP-03): `terrain` (the Fieldline Terrain vector style), `imagery`
 * (Fieldline Satellite on Esri or USGS imagery), `topo` (the USGS topo scan,
 * the reference base inside Terrain) and `field` (the high-contrast Field
 * style).
 */
export type StyleFamily = "terrain" | "imagery" | "topo" | "field";

/** The three styles a user picks between; each base map belongs to one. */
export type MapStyleId = "terrain" | "satellite" | "field";

export type LineToken = {
  line: string;
  casing: string;
  /** Opacity of the casing (the dark or light edge drawn under the line). */
  casingOpacity: number;
  lineOpacity: number;
};

export type MapTokens = {
  family: StyleFamily;
  /** Background under everything; the land color of the vector styles. */
  land: string;
  water: string;
  /** Forest and woodland (OpenMapTiles landcover class `wood`). */
  vegetation: string;
  park: string;
  /** Rivers and creeks, line and label. */
  waterway: string;
  /**
   * Land-cover fills from OpenStreetMap (OpenMapTiles `landcover` and
   * `landuse`). Only classes the source actually carries; unmapped ground
   * shows the land color. Drawn on the vector styles only, never on imagery.
   */
  landcover: {
    scrub: string;
    grass: string;
    wetland: string;
    rock: string;
    sand: string;
    ice: string;
    farmland: string;
    /** Built-up land use (residential, commercial, industrial). */
    developed: string;
    /** Fill opacity shared by the land-cover classes. */
    opacity: number;
  };
  roads: {
    freeway: LineToken;
    highway: LineToken;
    minor: LineToken;
  };
  /** Tracks and footpaths: the routes a hunter walks. Emphasis is not a claim of legal access. */
  trail: LineToken;
  /** Hunt-unit lines from state agencies. */
  unit: LineToken;
  /** State and national lines. */
  state: LineToken;
  label: { text: string; halo: string; haloWidth: number };
  unitLabel: { text: string; halo: string };
  /** Contour lines derived from the terrain DEM (minor and index lines, index labels). */
  contour: { minor: string; index: string; minorOpacity: number; indexOpacity: number; label: string; halo: string };
  /** Multiplier on ordinary label sizes (Field reads at arm's length outdoors). */
  textScale: number;
  /**
   * Restrained elevation tint under the land cover, in meters, or null for
   * none. Display only: it does not change any elevation value.
   */
  tint: { opacity: number; stops: [number, string][] } | null;
  /** Reserved for the inspection group (MAP-06): the selected unit, parcel or route. */
  selected: string;
  /** Reserved for closure and alert overlays; never used for ordinary content. */
  warning: string;
  /** Personal content: saved tracks and the live recording. */
  route: { recorded: string; live: string; casing: string };
  /** Navigation aids: measure, GPS accuracy, range rings, sun lines. */
  nav: {
    measure: string;
    measureFill: string;
    casing: string;
    accuracy: string;
    ring: string;
    sunRise: string;
    sunNow: string;
    sunSet: string;
    /** Downloaded offline areas: usable, not finished, and the area being planned. */
    offlineReady: string;
    offlinePartial: string;
    offlinePreview: string;
  };
  /**
   * Relief (hillshade). `strength` scales the sun-linked exaggeration;
   * imagery already contains real shadows, so it gets much less.
   */
  relief: { strength: number; shadowAlpha: number; highlightAlpha: number };
};

/** Personal and navigation colors stay identical across styles so marks and tracks read the same everywhere. */
const ROUTE = { recorded: "#d7e2c8", live: "#f3f1ea", casing: "#121410" } as const;
const NAV = {
  measure: "#f3f1ea",
  measureFill: "#d7e2c8",
  casing: "#121410",
  accuracy: "#d7e2c8",
  ring: "#f3f1ea",
  sunRise: "#f6e7b0",
  sunNow: "#fffdf6",
  sunSet: "#e39455",
  offlineReady: "#d7e2c8",
  offlinePartial: "#e39455",
  offlinePreview: "#f3f1ea",
} as const;

/** Natural-earth land-cover colors (Terrain). */
const NATURAL_LANDCOVER: MapTokens["landcover"] = {
  scrub: "#d2dab0",
  grass: "#e1e4bf",
  wetland: "#c6dcd3",
  rock: "#d9d3c9",
  sand: "#eee1bd",
  ice: "#f4f8fb",
  farmland: "#e9e4ca",
  developed: "#e1dad0",
  opacity: 0.85,
};

const IMAGERY: MapTokens = {
  family: "imagery",
  land: "#1c2418",
  water: "#c5d4e2",
  vegetation: "#d3dcc8",
  park: "#d7e3c4",
  waterway: "#d5e6f2",
  // Never drawn on imagery (no invented detail); kept so every family has a full set.
  landcover: NATURAL_LANDCOVER,
  roads: {
    // Hues kept (orange freeway, gold highway, gray local) so the Layers hint stays true; weight and casing reduced.
    freeway: { line: "#e8823a", casing: "#2a1004", casingOpacity: 0.5, lineOpacity: 0.85 },
    highway: { line: "#e2c96e", casing: "#1a1408", casingOpacity: 0.45, lineOpacity: 0.85 },
    minor: { line: "#c5d2e0", casing: "#12161c", casingOpacity: 0.45, lineOpacity: 0.9 },
  },
  trail: { line: "#fff1c9", casing: "#14120c", casingOpacity: 0.55, lineOpacity: 1 },
  unit: { line: "#f4efe2", casing: "#141910", casingOpacity: 0.4, lineOpacity: 0.85 },
  state: { line: "#fffaf0", casing: "#0c0e0a", casingOpacity: 0.45, lineOpacity: 0.9 },
  label: { text: "#f7f4ea", halo: "#141810", haloWidth: 1.6 },
  unitLabel: { text: "#f3f1ea", halo: "#121410" },
  // Pale lines over imagery, index lines a little stronger; labels with a dark halo.
  contour: { minor: "#fff4dc", index: "#fff4dc", minorOpacity: 0.3, indexOpacity: 0.62, label: "#fff8ea", halo: "#141810" },
  textScale: 1,
  tint: null,
  selected: "#ffd84d",
  warning: "#ff6b4a",
  route: ROUTE,
  nav: NAV,
  relief: { strength: 0.55, shadowAlpha: 0.5, highlightAlpha: 0.2 },
};

const TOPO: MapTokens = {
  ...IMAGERY,
  family: "topo",
  land: "#e9e4d6",
  // Dark lines with a light edge read on the paper-colored USGS scan.
  unit: { line: "#5b2a78", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 0.85 },
  state: { line: "#2b2924", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 0.85 },
  unitLabel: { text: "#3f1d55", halo: "#fbf8f0" },
  label: { text: "#1a1e16", halo: "#f3f0e8", haloWidth: 1.5 },
  // The scan has its own contours; Fieldline's are not drawn over it.
  contour: { minor: "#8a6a45", index: "#6e5232", minorOpacity: 0.35, indexOpacity: 0.7, label: "#5e4426", halo: "#f3efe4" },
  relief: { strength: 0.8, shadowAlpha: 0.6, highlightAlpha: 0.3 },
};

/** Fieldline Terrain: natural earth colors, blue water, clear trails, crisp relief, fine contours. */
const TERRAIN: MapTokens = {
  family: "terrain",
  land: "#ebe5d4",
  water: "#a9c9e1",
  vegetation: "#bcd3a1",
  park: "#d6e4c2",
  waterway: "#3b7db3",
  landcover: NATURAL_LANDCOVER,
  roads: {
    freeway: { line: "#d9673a", casing: "#8a3a1a", casingOpacity: 0.6, lineOpacity: 0.95 },
    highway: { line: "#e8bb5f", casing: "#8f6a2a", casingOpacity: 0.55, lineOpacity: 0.95 },
    minor: { line: "#fffdf8", casing: "#9a9285", casingOpacity: 0.85, lineOpacity: 1 },
  },
  trail: { line: "#8a3412", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 1 },
  unit: { line: "#5b2a78", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 0.85 },
  state: { line: "#2b2924", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 0.85 },
  label: { text: "#20241b", halo: "#f6f3ea", haloWidth: 1.5 },
  unitLabel: { text: "#3f1d55", halo: "#fbf8f0" },
  contour: { minor: "#9c7449", index: "#7f5a33", minorOpacity: 0.4, indexOpacity: 0.75, label: "#6b4a28", halo: "#f4f0e5" },
  textScale: 1,
  // Low ground slightly green, middle heights tan, high ground pale. Restrained: land cover sits above it.
  tint: {
    opacity: 0.5,
    stops: [
      [0, "#dfe8cf"],
      [600, "#e9e8cf"],
      [1500, "#e7dcc1"],
      [2600, "#ddd3c4"],
      [3600, "#ecebe8"],
      [5000, "#ffffff"],
    ],
  },
  selected: "#c2410c",
  warning: "#c62828",
  route: ROUTE,
  nav: NAV,
  // Gallery: Street's 1 / 0.75 made Pennsylvania ridges and shaded Sawtooth slopes near black and hid contours there.
  relief: { strength: 0.85, shadowAlpha: 0.55, highlightAlpha: 0.3 },
};

/**
 * Fieldline Field: high contrast and fewer classes for a phone held outdoors.
 * Pale land, strong dark text, white roads with gray edges, dark-red trails,
 * quiet contours and gentle relief.
 */
const FIELD: MapTokens = {
  family: "field",
  land: "#f5f3ec",
  water: "#79b0db",
  vegetation: "#c9debb",
  park: "#d9e8cc",
  waterway: "#1f66a3",
  landcover: {
    // Fewer distinctions than Terrain: open ground stays near the land color.
    scrub: "#e3e8d2",
    grass: "#ecefdc",
    wetland: "#cfe3e0",
    rock: "#e2ded6",
    sand: "#f1e8cc",
    ice: "#fbfdff",
    farmland: "#f0eedf",
    developed: "#e3ddd5",
    opacity: 0.9,
  },
  roads: {
    freeway: { line: "#d4480f", casing: "#5c1d05", casingOpacity: 0.85, lineOpacity: 1 },
    highway: { line: "#f0b43c", casing: "#6b4a10", casingOpacity: 0.85, lineOpacity: 1 },
    minor: { line: "#ffffff", casing: "#55524c", casingOpacity: 0.95, lineOpacity: 1 },
  },
  trail: { line: "#9b1c0c", casing: "#ffffff", casingOpacity: 0.95, lineOpacity: 1 },
  unit: { line: "#4b1a6b", casing: "#ffffff", casingOpacity: 0.85, lineOpacity: 0.95 },
  state: { line: "#121212", casing: "#ffffff", casingOpacity: 0.85, lineOpacity: 0.95 },
  label: { text: "#0b0d09", halo: "#ffffff", haloWidth: 2 },
  unitLabel: { text: "#35124d", halo: "#ffffff" },
  contour: { minor: "#a8885f", index: "#7b5a32", minorOpacity: 0.3, indexOpacity: 0.65, label: "#5a3e1e", halo: "#ffffff" },
  textScale: 1.15,
  tint: null,
  selected: "#c2410c",
  warning: "#c62828",
  route: ROUTE,
  nav: NAV,
  relief: { strength: 0.6, shadowAlpha: 0.45, highlightAlpha: 0.25 },
};

export const STYLE_TOKENS: Record<StyleFamily, MapTokens> = { terrain: TERRAIN, imagery: IMAGERY, topo: TOPO, field: FIELD };

export function styleFamily(basemap: Basemap): StyleFamily {
  if (basemap === "terrain") return "terrain";
  if (basemap === "field") return "field";
  if (basemap === "topo") return "topo";
  return "imagery";
}

/** Which of the three styles a base map belongs to. */
export function mapStyleOf(basemap: Basemap): MapStyleId {
  if (basemap === "terrain" || basemap === "topo") return "terrain";
  if (basemap === "field") return "field";
  return "satellite";
}

/** True for the vector styles drawn from OpenFreeMap land and water (Terrain, Field). */
export function isVectorBase(basemap: Basemap): boolean {
  return basemap === "terrain" || basemap === "field";
}

export function tokensFor(basemap: Basemap): MapTokens {
  return STYLE_TOKENS[styleFamily(basemap)];
}

/** How strongly unit and state lines draw. "strong" matches the pre-MAP-02 look. */
export type BoundaryStrength = "subtle" | "standard" | "strong";

export type BoundaryWeight = {
  /** Multiplier on line and casing widths. */
  width: number;
  /** Multiplier on casing opacity (capped at 1). */
  casing: number;
  /** Multiplier on line opacity (capped at 1). */
  line: number;
};

export const BOUNDARY_WEIGHTS: Record<BoundaryStrength, BoundaryWeight> = {
  subtle: { width: 0.8, casing: 0.5, line: 0.8 },
  standard: { width: 1, casing: 1, line: 1 },
  strong: { width: 1.3, casing: 1.9, line: 1.15 },
};

/**
 * Relief paint for the hillshade layer. With a sun position the light follows
 * the shade-bar time (a sun-direction hillshade, not cast shadows); without
 * one it uses a fixed southern light. Strength depends on the style family.
 */
export function reliefPaint(basemap: Basemap, sunAz: number | null, sunEl: number | null): Record<string, string | number> {
  const { relief } = tokensFor(basemap);
  const night = sunEl != null && sunEl <= 0;
  const altitude = sunEl == null ? 35 : night ? 3 : Math.min(80, Math.max(4, sunEl));
  const base = sunEl == null ? 0.65 : night ? 0.4 : sunEl < 15 ? 0.85 : 0.42 + (1 - altitude / 90) * 0.35;
  const shadowAlpha = night ? Math.min(0.4, relief.shadowAlpha) : relief.shadowAlpha;
  return {
    "hillshade-method": "basic",
    "hillshade-illumination-anchor": "map",
    "hillshade-illumination-direction": sunAz ?? 180,
    "hillshade-illumination-altitude": altitude,
    "hillshade-exaggeration": round(base * relief.strength),
    "hillshade-shadow-color": `rgba(8, 12, 10, ${round(shadowAlpha)})`,
    "hillshade-highlight-color": `rgba(255, 236, 196, ${round(relief.highlightAlpha)})`,
    "hillshade-accent-color": "rgba(0, 0, 0, 0)",
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
