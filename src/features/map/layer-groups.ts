/**
 * Named render groups (MAP-01, spec §17 "Render stack and loading"). The map
 * draws groups bottom to top in this order; inside a group, layers keep the
 * order they are listed in. Adding or removing a layer only affects its own
 * group's list, so nothing else changes relative order.
 */
export const RENDER_GROUPS = [
  /** Base imagery or land: background, rasters, street land fills. */
  "base",
  /** Relief and (later) contours. */
  "relief",
  /** Thematic fills: public land. */
  "thematic",
  /** Roads, trails and water detail. */
  "detail",
  /** State lines and hunt-unit lines. */
  "boundaries",
  /** Ordinary labels. Higher in the list wins label collisions. */
  "labels",
  /** The user's own content: saved and live tracks. */
  "personal",
  /** Navigation aids: range rings, sun lines, GPS accuracy, measure. */
  "navigation",
  /** Inspection highlights (selected unit, parcel or route). Reserved for MAP-06. */
  "inspection",
] as const;

export type RenderGroup = (typeof RENDER_GROUPS)[number];

export type GroupedLayers<L extends { id: string }> = Partial<Record<RenderGroup, readonly L[]>>;

/**
 * Flattens groups into the draw order MapLibre expects. Throws on a duplicate
 * layer id, because MapLibre would reject the whole style.
 */
export function orderLayers<L extends { id: string }>(groups: GroupedLayers<L>): L[] {
  const out: L[] = [];
  const seen = new Set<string>();
  for (const group of RENDER_GROUPS) {
    for (const layer of groups[group] ?? []) {
      if (seen.has(layer.id)) throw new Error(`Duplicate map layer id "${layer.id}"`);
      seen.add(layer.id);
      out.push(layer);
    }
  }
  return out;
}

/** Which group each layer id belongs to. */
export function groupOf<L extends { id: string }>(groups: GroupedLayers<L>, id: string): RenderGroup | null {
  for (const group of RENDER_GROUPS) {
    if ((groups[group] ?? []).some((layer) => layer.id === id)) return group;
  }
  return null;
}

/**
 * The first layer drawn above `group`: the `beforeId` to use when re-adding a
 * layer at the top of that group at runtime. `present` filters to layers the
 * live map actually has. Returns undefined when nothing sits above the group.
 */
export function firstLayerAbove<L extends { id: string }>(
  groups: GroupedLayers<L>,
  group: RenderGroup,
  present: (id: string) => boolean = () => true,
): string | undefined {
  const start = RENDER_GROUPS.indexOf(group) + 1;
  for (const next of RENDER_GROUPS.slice(start)) {
    for (const layer of groups[next] ?? []) {
      if (present(layer.id)) return layer.id;
    }
  }
  return undefined;
}
