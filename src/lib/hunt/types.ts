export type MarkKind =
  | "stand"
  | "blind"
  | "camp"
  | "camera"
  | "parking"
  | "gate"
  | "water"
  | "glass"
  | "pin";

export type LngLat = { lng: number; lat: number };

export type Waypoint = {
  id: string;
  name: string;
  kind: MarkKind;
  lng: number;
  lat: number;
  notes: string;
  hunt: string;
  goodWinds: number[];
  createdAt: number;
};

export type TrackPoint = { lng: number; lat: number; t: number };

export type Track = {
  id: string;
  name: string;
  points: TrackPoint[];
  createdAt: number;
  visible: boolean;
};

/** "satellite"/"hybrid" use Esri imagery (live only); "usgs" uses USGS imagery, which can be saved offline. */
export type Basemap = "hybrid" | "satellite" | "usgs" | "topo" | "street";

export type MapView = {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

export type LandTone = "public" | "state" | "park" | "refuge" | "tribal" | "restricted" | "private" | "unknown";

export type LandRecord = {
  agency: string;
  label: string;
  swatch: string | null;
  tone: LandTone;
  state: string | null;
  unit: string | null;
};

/**
 * A surface-management answer for one point. `no-record` means the provider
 * answered but had no polygon there: ownership is unknown, not private.
 * Service failures are thrown, never turned into a hit.
 */
export type LandHit = LandRecord & {
  status: "record" | "no-record";
  note: string;
  /** Other overlapping records at the same point, after the primary one. */
  others: LandRecord[];
  source: string;
  checkedAt: number;
};

export const JUMPS: { name: string; hint: string; lng: number; lat: number; zoom: number }[] = [
  { name: "Four Peaks", hint: "Tonto", lng: -111.32, lat: 33.68, zoom: 11 },
  { name: "Mogollon Rim", hint: "Payson", lng: -111.2, lat: 34.42, zoom: 10 },
  { name: "White Mountains", hint: "Eastern AZ", lng: -109.45, lat: 33.9, zoom: 9 },
  { name: "Kaibab Plateau", hint: "North Kaibab", lng: -112.15, lat: 36.6, zoom: 9 },
  { name: "Arizona Strip", hint: "BLM", lng: -113.3, lat: 36.65, zoom: 8 },
  { name: "Wind River", hint: "Wyoming", lng: -109.4, lat: 43.2, zoom: 9 },
  { name: "Pike Forest", hint: "Colorado", lng: -105.2, lat: 39.15, zoom: 9 },
];

export const ID_JUMPS: { name: string; hint: string; lng: number; lat: number; zoom: number }[] = [
  { name: "Frank Church", hint: "River of No Return", lng: -114.8, lat: 45.2, zoom: 8 },
  { name: "Sawtooths", hint: "Stanley", lng: -114.9, lat: 44.1, zoom: 9 },
  { name: "Panhandle", hint: "Coeur d'Alene", lng: -116.6, lat: 47.7, zoom: 8 },
  { name: "Island Park", hint: "Henry's Fork", lng: -111.4, lat: 44.4, zoom: 9 },
  { name: "Owyhee", hint: "Southwest", lng: -116.5, lat: 42.6, zoom: 8 },
  { name: "Salmon River", hint: "North-central", lng: -114.2, lat: 45.4, zoom: 9 },
];

export type HuntRegion = "az" | "id";

export const REGION_VIEW: Record<HuntRegion, MapView> = {
  az: {
    lng: -111.38,
    lat: 33.95,
    zoom: 9,
    bearing: 0,
    pitch: 0,
  },
  id: {
    lng: -114.5,
    lat: 44.4,
    zoom: 6,
    bearing: 0,
    pitch: 0,
  },
};

export const DEFAULT_VIEW: MapView = REGION_VIEW.az;
