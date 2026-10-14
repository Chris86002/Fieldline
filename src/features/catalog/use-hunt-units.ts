import { useEffect, useMemo, useRef, useState } from "react";
import { UNIT_ADAPTERS, unitAdapterById } from "./adapters/index.ts";
import { providersForView } from "./discovery.ts";
import type { Bounds, HuntUnit, ProviderInfo, UnitLoadResult } from "./types.ts";

export type ProviderLoad = { info: ProviderInfo; result: UnitLoadResult | null };

/**
 * Loads hunt units for whichever providers cover the current view, across
 * state lines, with no state mode. Providers load once and stay loaded; a
 * provider that came back "unavailable" is asked again on a later move (the
 * unit store applies its own retry backoff).
 */
export function useHuntUnits(view: Bounds | null, enabled: boolean, everywhere = false) {
  const [results, setResults] = useState<Record<string, UnitLoadResult>>({});
  const requested = useRef(new Set<string>());
  const viewKey = view ? [view.west, view.south, view.east, view.north].map((value) => value.toFixed(2)).join(",") : "";

  useEffect(() => {
    if (!enabled || (!view && !everywhere)) return;
    // Search reaches every provider, so a code from another state can be found from anywhere.
    const wanted = everywhere || !view ? UNIT_ADAPTERS.map((adapter) => adapter.info) : providersForView(view, UNIT_ADAPTERS.map((adapter) => adapter.info), "hunt-units");
    for (const info of wanted) {
      if (requested.current.has(info.id)) continue;
      const adapter = unitAdapterById(info.id);
      if (!adapter) continue;
      requested.current.add(info.id);
      void adapter
        .load()
        .then((result) => {
          if (result.status === "unavailable") requested.current.delete(info.id);
          setResults((current) => ({ ...current, [info.id]: result }));
        })
        .catch(() => requested.current.delete(info.id));
    }
    // viewKey stands in for `view`, so a new object with the same edges doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewKey, everywhere]);

  const units = useMemo<HuntUnit[]>(() => Object.values(results).flatMap((result) => result.units), [results]);

  /** Providers covering the view, with their load result (null while loading). */
  const inView = useMemo<ProviderLoad[]>(() => {
    if (!view) return [];
    return providersForView(view, UNIT_ADAPTERS.map((adapter) => adapter.info), "hunt-units").map((info) => ({
      info,
      result: results[info.id] ?? null,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, results]);

  return { units, inView };
}

/** Deletes the unit caches written before the catalog (replaceable provider data). */
export async function deleteLegacyUnitCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  for (const name of ["fieldline-units-v2", "fieldline-units-id-v1"]) {
    try {
      await caches.delete(name);
    } catch {
      /* storage unavailable; nothing to clean */
    }
  }
}
