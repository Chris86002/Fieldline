import type { LngLat } from "@/lib/hunt/types";

const R = 6371000;

export function haversine(a: LngLat, b: LngLat): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = ((b.lat - a.lat) * Math.PI) / 180;
  const dλ = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pathLength(pts: LngLat[]): number {
  let meters = 0;
  for (let i = 1; i < pts.length; i++) meters += haversine(pts[i - 1], pts[i]);
  return meters;
}

export function ringArea(pts: LngLat[]): number {
  if (pts.length < 3) return 0;
  const lat0 = (pts.reduce((sum, p) => sum + p.lat, 0) / pts.length) * (Math.PI / 180);
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.cos(lat0);
  const xy = pts.map((p) => [p.lng * mPerDegLng, p.lat * mPerDegLat]);
  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    area += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1];
  }
  return Math.abs(area) / 2;
}

export function formatDistance(meters: number, imperial: boolean): string {
  if (!Number.isFinite(meters)) return "—";
  if (!imperial) {
    if (meters < 1000) return `${Math.round(meters)} m`;
    const km = meters / 1000;
    return `${km.toFixed(km < 10 ? 2 : 1)} km`;
  }
  const miles = meters / 1609.344;
  if (miles >= 1) return `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
  return `${Math.round(meters * 1.0936133)} yd`;
}

export function formatArea(m2: number, imperial: boolean): string {
  if (!Number.isFinite(m2) || m2 <= 0) return "—";
  if (!imperial) {
    const ha = m2 / 10000;
    if (ha < 1) return `${Math.round(m2)} m²`;
    return `${ha.toFixed(ha < 10 ? 2 : 1)} ha`;
  }
  const acres = m2 / 4046.8564224;
  if (acres < 0.1) return `${Math.round(m2 * 10.7639104)} ft²`;
  return `${acres.toFixed(acres < 10 ? 2 : 1)} ac`;
}

export function formatElev(meters: number, imperial: boolean): string {
  if (!Number.isFinite(meters)) return "—";
  if (!imperial) return `${Math.round(meters).toLocaleString("en-US")} m`;
  return `${Math.round(meters * 3.28084).toLocaleString("en-US")} ft`;
}

function toDms(value: number, lat: boolean): string {
  const hemi = lat ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return `${deg}°${String(min).padStart(2, "0")}′${sec.toFixed(0).padStart(2, "0")}″${hemi}`;
}

export function formatDd(lng: number, lat: number): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}   ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? "E" : "W"}`;
}

export function formatDms(lng: number, lat: number): string {
  return `${toDms(lat, true)}   ${toDms(lng, false)}`;
}

export function formatPair(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function bearingDeg(a: LngLat, b: LngLat): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function cardinal(deg: number): string {
  const wrapped = ((deg % 360) + 360) % 360;
  return DIRS[Math.round(wrapped / 22.5) % 16];
}

export function formatClock(iso: string | null): string {
  if (!iso) return "—";
  const time = iso.split("T")[1]?.slice(0, 5);
  if (!time) return "—";
  const [hRaw, mRaw] = time.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function circlePolygon(lng: number, lat: number, radiusM: number, steps = 64): number[][] {
  const coords: number[][] = [];
  const mPerDegLat = 111132;
  const mPerDegLng = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const θ = (i / steps) * Math.PI * 2;
    const dx = Math.cos(θ) * radiusM;
    const dy = Math.sin(θ) * radiusM;
    coords.push([lng + dx / mPerDegLng, lat + dy / mPerDegLat]);
  }
  return coords;
}

export function sectorPolygon(
  lng: number,
  lat: number,
  radiusM: number,
  bearing: number,
  spreadDeg: number,
  steps = 28,
): number[][] {
  const start = bearing - spreadDeg / 2;
  const coords: number[][] = [[lng, lat]];
  const mPerDegLat = 111132;
  const mPerDegLng = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const theta = ((start + (spreadDeg * i) / steps) * Math.PI) / 180;
    const east = Math.sin(theta) * radiusM;
    const north = Math.cos(theta) * radiusM;
    coords.push([lng + east / mPerDegLng, lat + north / mPerDegLat]);
  }
  coords.push([lng, lat]);
  return coords;
}

export function angDiff(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

export function windFits(windFrom: number, good: number[] | undefined): boolean | null {
  if (!good || good.length === 0) return null;
  return good.some((dir) => angDiff(windFrom, dir) <= 25);
}

export const WIND_CHOICES: { deg: number; label: string }[] = [
  { deg: 0, label: "N" },
  { deg: 45, label: "NE" },
  { deg: 90, label: "E" },
  { deg: 135, label: "SE" },
  { deg: 180, label: "S" },
  { deg: 225, label: "SW" },
  { deg: 270, label: "W" },
  { deg: 315, label: "NW" },
];

export function scentReach(windMps: number): number {
  return Math.min(1100, Math.max(180, 160 + windMps * 95));
}

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

export function mpsToMph(mps: number): number {
  return mps * 2.236936;
}

export function shiftLocalIso(iso: string | null, deltaMin: number): string | null {
  if (!iso) return null;
  const time = iso.split("T")[1]?.slice(0, 5);
  if (!time) return null;
  const [hRaw, mRaw] = time.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const total = (((h * 60 + m + deltaMin) % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `2000-01-01T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Arizona big game is a half hour either side of sunrise and sunset. */
export const AZ_SHOOT_LEAD_MIN = 30;
