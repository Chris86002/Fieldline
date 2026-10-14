const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Azimuth is degrees clockwise from true north. Elevation is degrees above the horizon. */
export function sunPosition(lng: number, lat: number, when: Date): { azimuth: number; elevation: number } {
  const jd = when.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;
  const T = n / 36525;
  const L0 = wrap360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = wrap360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const Mr = M * RAD;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr);
  const omega = 125.04 - 1934.136 * T;
  const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD)) * RAD;
  const eps = (23.439291 - 0.0130042 * T + 0.00256 * Math.cos(omega * RAD)) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = wrap360(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * DEG);
  const gmst = wrap360(280.46061837 + 360.98564736629 * n + 0.000387933 * T * T - (T * T * T) / 38_710_000);
  const hour = wrap360(gmst + lng - ra);
  const H = hour > 180 ? hour - 360 : hour;
  const Hr = H * RAD;
  const latr = lat * RAD;
  const sinEl = Math.sin(latr) * Math.sin(dec) + Math.cos(latr) * Math.cos(dec) * Math.cos(Hr);
  const el = Math.asin(clamp(sinEl, -1, 1));
  const cosEl = Math.cos(el);
  let azimuth = 180;
  if (Math.abs(cosEl) > 1e-6 && Math.abs(Math.cos(latr)) > 1e-6) {
    const cosAz = (Math.sin(dec) - Math.sin(latr) * sinEl) / (Math.cos(latr) * cosEl);
    azimuth = Math.acos(clamp(cosAz, -1, 1)) * DEG;
    if (Math.sin(Hr) > 0) azimuth = 360 - azimuth;
  }
  return { azimuth: wrap360(azimuth), elevation: el * DEG };
}

export function destination(lng: number, lat: number, bearing: number, radiusM: number): [number, number] {
  const theta = (bearing * Math.PI) / 180;
  const mPerDegLat = 111132;
  const mPerDegLng = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  return [lng + (Math.sin(theta) * radiusM) / mPerDegLng, lat + (Math.cos(theta) * radiusM) / mPerDegLat];
}

const UTM_BANDS = "CDEFGHJKLMNPQRSTUVWX";

export function toUtm(lng: number, lat: number): { zone: number; band: string; easting: number; northing: number } | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat <= -80 || lat >= 84) return null;
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const zone = Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1));
  const lon0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const λ = (lng * Math.PI) / 180;
  const sinφ = Math.sin(φ);
  const cosφ = Math.cos(φ);
  const N = a / Math.sqrt(1 - e2 * sinφ * sinφ);
  const T = Math.tan(φ) ** 2;
  const C = ep2 * cosφ * cosφ;
  const A = (λ - lon0) * cosφ;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * φ -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * φ) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * φ) -
      ((35 * e6) / 3072) * Math.sin(6 * φ));
  const easting =
    k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing =
    k0 *
    (M +
      N *
        Math.tan(φ) *
        (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10_000_000;
  const band = UTM_BANDS[Math.min(UTM_BANDS.length - 1, Math.max(0, Math.floor((lat + 80) / 8)))] ?? "N";
  return { zone, band, easting, northing };
}

export function formatUtm(lng: number, lat: number): string {
  const utm = toUtm(lng, lat);
  if (!utm) return "—";
  const east = Math.round(utm.easting).toLocaleString("en-US");
  const north = Math.round(utm.northing).toLocaleString("en-US");
  return `${utm.zone}${utm.band}  ${east} E  ${north} N`;
}

function zoneParts(timeZone: string, date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
}

function zonePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((item) => item.type === type)?.value ?? "";
}

function zoneOffset(timeZone: string, date: Date): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = /([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return "-07:00";
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}

export function localMinutes(timeZone: string, date = new Date()): number {
  const parts = zoneParts(timeZone, date);
  let hour = Number(zonePart(parts, "hour"));
  if (!Number.isFinite(hour)) hour = 0;
  if (hour === 24) hour = 0;
  return (hour % 24) * 60 + Number(zonePart(parts, "minute") || 0);
}

export function localDate(timeZone: string, minutes: number, now = new Date()): Date {
  const parts = zoneParts(timeZone, now);
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  const stamp = `${zonePart(parts, "year")}-${zonePart(parts, "month")}-${zonePart(parts, "day")}T${hh}:${mm}:00`;
  const guess = new Date(`${stamp}${zoneOffset(timeZone, now)}`);
  const fixed = zoneOffset(timeZone, guess);
  const built = new Date(`${stamp}${fixed}`);
  return Number.isNaN(built.getTime()) ? guess : built;
}
