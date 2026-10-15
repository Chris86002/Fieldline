/** Registry of hunt-unit adapters. Add a jurisdiction by adding an adapter here, not by editing the app shell. */
import type { UnitAdapter } from "../types.ts";
import { azgfdUnitAdapter } from "./azgfd.ts";
import { cpwUnitAdapter } from "./cpw.ts";
import { idfgUnitAdapter } from "./idfg.ts";
import { mtfwpUnitAdapter } from "./mtfwp.ts";
import { nmdgfUnitAdapter } from "./nmdgf.ts";
import { udwrUnitAdapter } from "./udwr.ts";

export const UNIT_ADAPTERS: UnitAdapter[] = [azgfdUnitAdapter, idfgUnitAdapter, mtfwpUnitAdapter, cpwUnitAdapter, udwrUnitAdapter, nmdgfUnitAdapter];

export function unitAdapterById(providerId: string): UnitAdapter | null {
  return UNIT_ADAPTERS.find((adapter) => adapter.info.id === providerId) ?? null;
}
