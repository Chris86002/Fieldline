/**
 * Label hierarchy and density (spec §17 "Detail and label hierarchy").
 *
 * Priority: MapLibre places symbols from the top layer down, so the order of
 * the `labels` render group is the priority order. Unit numbers come first,
 * then cities and towns, terrain names (peaks, creeks), small places, road
 * names, and contour elevations last. Navigation labels (sun lines) sit in a
 * higher group and win.
 *
 * Density changes when each kind of label appears and how much room it needs.
 * It never hides unit numbers or the user's own content.
 */
export type LabelDensity = "fewer" | "standard" | "more";

/** Label layers, bottom (lowest priority) to top (highest priority). */
export const LABEL_LAYER_IDS = [
  // Contour elevations: supporting detail, first to give way.
  "contour-labels",
  "vx-road-minor",
  "vx-road-major",
  "vx-shield",
  "vx-place-small",
  "vx-creek",
  "vx-peak",
  "vx-place-town",
  "vx-place-city",
  "unit-labels",
] as const;

export type LabelLayerId = (typeof LABEL_LAYER_IDS)[number];

export type LabelRule = {
  /** First zoom the label shows at. */
  minzoom: number;
  /** Collision padding around the label, in pixels. */
  padding: number;
  /** Repeat distance for labels placed along lines, in pixels. */
  spacing: number | null;
};

const STANDARD: Record<LabelLayerId, LabelRule> = {
  "contour-labels": { minzoom: 12, padding: 2, spacing: 360 },
  "vx-road-minor": { minzoom: 14, padding: 2, spacing: 280 },
  "vx-road-major": { minzoom: 11, padding: 2, spacing: 320 },
  "vx-shield": { minzoom: 8, padding: 2, spacing: 360 },
  "vx-place-small": { minzoom: 11, padding: 4, spacing: null },
  "vx-creek": { minzoom: 12, padding: 2, spacing: 400 },
  "vx-peak": { minzoom: 11, padding: 4, spacing: null },
  "vx-place-town": { minzoom: 7, padding: 5, spacing: null },
  "vx-place-city": { minzoom: 4, padding: 6, spacing: null },
  "unit-labels": { minzoom: 8, padding: 3, spacing: null },
};

/** Layers whose first zoom stays fixed at every density: major context and the unit numbers. */
const FIXED_MINZOOM: readonly LabelLayerId[] = ["vx-place-city", "unit-labels"];

const SHIFT: Record<LabelDensity, { zoom: number; padding: number; spacing: number }> = {
  fewer: { zoom: 1, padding: 2, spacing: 1.6 },
  standard: { zoom: 0, padding: 1, spacing: 1 },
  more: { zoom: -1, padding: 0.5, spacing: 0.75 },
};

export function labelRules(density: LabelDensity): Record<LabelLayerId, LabelRule> {
  const shift = SHIFT[density];
  const out = {} as Record<LabelLayerId, LabelRule>;
  for (const id of LABEL_LAYER_IDS) {
    const rule = STANDARD[id];
    out[id] = {
      minzoom: FIXED_MINZOOM.includes(id) ? rule.minzoom : Math.max(0, rule.minzoom + shift.zoom),
      padding: Math.max(1, Math.round(rule.padding * shift.padding)),
      spacing: rule.spacing == null ? null : Math.round(rule.spacing * shift.spacing),
    };
  }
  return out;
}
