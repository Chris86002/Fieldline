import type { Basemap } from "@/lib/hunt/types";

/**
 * Map design tokens (spec §17 "Shared design system"). Every color and weight
 * the map style uses comes from here, per style family, instead of constants
 * scattered through MapCanvas. The five base maps share three families:
 * imagery (Hybrid, Satellite, USGS imagery), the USGS topo scan, and Street.
 * The three signature styles (MAP-03) will add their own token sets.
 */
export type StyleFamily = "imagery" | "topo" | "street";

export type LineToken = {
  line: string;
  casing: string;
  /** Opacity of the casing (the dark or light edge drawn under the line). */
  casingOpacity: number;
  lineOpacity: number;
};

export type MapTokens = {
  family: StyleFamily;
  /** Background under every raster; only visible on Street or while tiles load. */
  land: string;
  water: string;
  vegetation: string;
  park: string;
  /** Rivers and creeks, line and label. */
  waterway: string;
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
} as const;

const IMAGERY: MapTokens = {
  family: "imagery",
  land: "#1c2418",
  water: "#c5d4e2",
  vegetation: "#d3dcc8",
  park: "#d7e3c4",
  waterway: "#d5e6f2",
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
  relief: { strength: 0.8, shadowAlpha: 0.6, highlightAlpha: 0.3 },
};

const STREET: MapTokens = {
  family: "street",
  land: "#e4dfd4",
  water: "#c5d4e2",
  vegetation: "#d3dcc8",
  park: "#d7e3c4",
  waterway: "#3e6278",
  roads: {
    freeway: { line: "#e0702a", casing: "#7a3410", casingOpacity: 0.7, lineOpacity: 0.9 },
    highway: { line: "#d4a04a", casing: "#8a6230", casingOpacity: 0.6, lineOpacity: 0.9 },
    minor: { line: "#fffcf7", casing: "#b7b1a6", casingOpacity: 0.9, lineOpacity: 1 },
  },
  trail: { line: "#5c4a2e", casing: "#f3f0e8", casingOpacity: 0.6, lineOpacity: 1 },
  unit: { line: "#5b2a78", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 0.85 },
  state: { line: "#2b2924", casing: "#fbf8f0", casingOpacity: 0.7, lineOpacity: 0.85 },
  label: { text: "#1a1e16", halo: "#f3f0e8", haloWidth: 1.5 },
  unitLabel: { text: "#3f1d55", halo: "#fbf8f0" },
  selected: "#c2410c",
  warning: "#c62828",
  route: ROUTE,
  nav: NAV,
  relief: { strength: 1, shadowAlpha: 0.75, highlightAlpha: 0.38 },
};

export const STYLE_TOKENS: Record<StyleFamily, MapTokens> = { imagery: IMAGERY, topo: TOPO, street: STREET };

export function styleFamily(basemap: Basemap): StyleFamily {
  if (basemap === "topo") return "topo";
  if (basemap === "street") return "street";
  return "imagery";
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
