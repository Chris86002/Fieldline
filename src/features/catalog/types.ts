/**
 * Shared contracts for the nationwide catalog (packet CC-03). Coordinator
 * owned: workers implement against these types and request changes rather
 * than editing this file. Adapted from spec §6.
 *
 * Runtime modules that tests import must reach each other through relative
 * `.ts` paths; this file holds types only.
 */

/** Lowercase "us-" + USPS code, e.g. "us-az", "us-ak", "us-dc". */
export type JurisdictionId = `us-${string}`;

/**
 * available — data exists and loaded; partial — some of the area or fields;
 * unavailable — no source covers it (or the source is down);
 * unknown — not yet determined or not yet loaded; stale — last good copy
 * past its refresh policy. Never conflate unavailable, empty and not loaded.
 */
export type DataStatus = "available" | "partial" | "unavailable" | "unknown" | "stale";

/**
 * Geographic bounds in degrees. `west > east` means the box crosses the
 * antimeridian (e.g. the Aleutians). Latitudes are south <= north.
 */
export type Bounds = { west: number; south: number; east: number; north: number };

export type LngLat = { lng: number; lat: number };

export type LayerCategory = "land-management" | "hunt-units" | "parcels" | "access" | "legal-hours";

/** Whether a provider's terms allow a use. "unknown" until verified in docs/data-sources.md. */
export type Permission = boolean | "unknown";

export type ProviderCapabilities = {
  view: Permission;
  identify: boolean;
  search: boolean;
  /** Bulk download / device storage for offline packages. */
  download: Permission;
  redistribution: Permission;
};

/** A provider of one layer for one or more jurisdictions. */
export type ProviderInfo = {
  /** Stable, e.g. "azgfd-gmu", "idfg-gmu". */
  id: string;
  title: string;
  category: LayerCategory;
  jurisdictionIds: JurisdictionId[];
  /** Areas the provider covers. More than one box for split areas. */
  coverage: Bounds[];
  attribution: string;
  /** Human-facing official page for the data or regulations. */
  sourceUrl: string;
  licenseUrl: string | null;
  capabilities: ProviderCapabilities;
  /** Short caveat shown with results, e.g. "Reference lines, not the legal description." */
  caveat: string;
};

/** One hunting unit / zone polygon set, from one provider. */
export type HuntUnit = {
  /** `${jurisdictionId}:${providerId}:${sourceFeatureId}`, unique nationwide. */
  id: string;
  jurisdictionId: JurisdictionId;
  providerId: string;
  /** The provider's own identifier for the feature (often the unit code). */
  sourceFeatureId: string;
  /** Unit code as hunters write it, e.g. "22", "27", "6A". */
  code: string;
  /** Display label, e.g. "Unit 22". */
  label: string;
  /** Larger region or zone name from the source, or "". */
  regionName: string;
  speciesTags: string[];
  /** Free-text season/system context, e.g. "Elk zone: Sawtooth", or null. */
  seasonContext: string | null;
  /** Extra source fields worth showing (land ownership summary, forest), or "". */
  landNote: string;
  forest: string;
  sqMiles: number | null;
  bounds: Bounds;
  /** A point inside the polygon for labels; not a vertex average. */
  labelPoint: LngLat;
  /** MultiPolygon coordinates [polygon][ring][point][lng, lat]; holes preserved. */
  polygons: number[][][][];
};

/** Result of loading a provider's full unit set. */
export type UnitLoadResult = {
  status: DataStatus;
  units: HuntUnit[];
  /** When this copy was fetched from the provider (ms), or null if never. */
  retrievedAt: number | null;
  /** Provider's own edit/version marker if it publishes one, else null. */
  sourceVersion: string | null;
  /** Why the status is not "available", in plain words. */
  message: string | null;
};

/** One unit found at a point. */
export type UnitHit = {
  unit: Pick<HuntUnit, "id" | "jurisdictionId" | "providerId" | "code" | "label" | "regionName" | "speciesTags" | "seasonContext" | "landNote" | "forest" | "sqMiles">;
  /** True when answered from the local copy (geometry may be simplified). */
  approximate: boolean;
};

export type UnitIdentifyResult = {
  status: DataStatus;
  /** Every overlapping unit at the point; empty when none. */
  hits: UnitHit[];
  message: string | null;
};

/** A source of hunt units. One adapter per provider. */
export type UnitAdapter = {
  info: ProviderInfo;
  /** Loads (or reads the validated cached copy of) every unit. Never throws for provider failure; reports it in status. */
  load(signal?: AbortSignal): Promise<UnitLoadResult>;
  /** Units at a point from the provider's authoritative query path, falling back to the local copy. Never throws for provider failure. */
  identify(point: LngLat, signal?: AbortSignal): Promise<UnitIdentifyResult>;
};

/** What Fieldline knows about one layer in one jurisdiction. */
export type LayerCoverage = {
  status: DataStatus;
  providerIds: string[];
  /** Plain-language explanation shown in the coverage screen. */
  note: string;
};

/** One of the 50 states or DC, with honest per-layer coverage. */
export type JurisdictionCoverage = {
  id: JurisdictionId;
  name: string;
  usps: string;
  /** Approximate extent for discovery; several boxes for split areas (Alaska). */
  bounds: Bounds[];
  layers: Record<LayerCategory, LayerCoverage>;
  /** Official wildlife agency home page, for regulations and legal hours. */
  agencyUrl: string | null;
  agencyName: string | null;
};
