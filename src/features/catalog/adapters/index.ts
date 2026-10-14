/** Registry of hunt-unit adapters. Add a jurisdiction by adding an adapter here, not by editing the app shell. */
import type { UnitAdapter } from "../types.ts";
import { azgfdUnitAdapter } from "./azgfd.ts";
import { idfgUnitAdapter } from "./idfg.ts";

export const UNIT_ADAPTERS: UnitAdapter[] = [azgfdUnitAdapter, idfgUnitAdapter];

export function unitAdapterById(providerId: string): UnitAdapter | null {
  return UNIT_ADAPTERS.find((adapter) => adapter.info.id === providerId) ?? null;
}
