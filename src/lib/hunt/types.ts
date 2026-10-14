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

/** Quick jumps shown under the search box. Any place in the country works the same way. */
export const JUMPS: { name: string; hint: string; lng: number; lat: number; zoom: number }[] = [
  { name: "Four Peaks", hint: "Arizona", lng: -111.32, lat: 33.68, zoom: 11 },
  { name: "Mogollon Rim", hint: "Arizona", lng: -111.2, lat: 34.42, zoom: 10 },
  { name: "Kaibab Plateau", hint: "Arizona", lng: -112.15, lat: 36.6, zoom: 9 },
  { name: "Frank Church", hint: "Idaho", lng: -114.8, lat: 45.2, zoom: 8 },
  { name: "Sawtooths", hint: "Idaho", lng: -114.9, lat: 44.1, zoom: 9 },
  { name: "Bob Marshall", hint: "Montana", lng: -113.1, lat: 47.6, zoom: 8 },
  { name: "Wind River", hint: "Wyoming", lng: -109.4, lat: 43.2, zoom: 9 },
  { name: "Pike Forest", hint: "Colorado", lng: -105.2, lat: 39.15, zoom: 9 },
  { name: "Brooks Range", hint: "Alaska", lng: -152.5, lat: 67.9, zoom: 6 },
  { name: "Mauna Kea", hint: "Hawaii", lng: -155.47, lat: 19.82, zoom: 9 },
];

/** The old Arizona/Idaho mode. Only kept as a saved legacy field; the app no longer has state modes. */
export type HuntRegion = "az" | "id";

/** Lower-48 overview, used when a profile has no saved view. */
export const NATIONAL_VIEW: MapView = { lng: -98.6, lat: 39.8, zoom: 3.6, bearing: 0, pitch: 0 };

export const DEFAULT_VIEW: MapView = NATIONAL_VIEW;
