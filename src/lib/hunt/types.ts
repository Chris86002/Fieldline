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

export type Basemap = "hybrid" | "satellite" | "topo" | "street";

export type MapView = {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

export type LandTone = "public" | "state" | "park" | "refuge" | "tribal" | "restricted" | "private" | "unknown";

export type LandHit = {
  agency: string;
  label: string;
  swatch: string | null;
  tone: LandTone;
  state: string | null;
  unit: string | null;
  note: string;
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

export const DEFAULT_VIEW: MapView = {
  lng: -111.38,
  lat: 33.95,
  zoom: 9,
  bearing: 0,
  pitch: 0,
};
