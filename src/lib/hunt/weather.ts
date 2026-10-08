export type WindHour = {
  at: number;
  time: string;
  tempC: number;
  windMps: number;
  gustMps: number;
  windFrom: number;
};

export type FieldWeather = {
  tempC: number;
  windMps: number;
  gustMps: number;
  windFrom: number;
  sunrise: string | null;
  sunset: string | null;
  elevationM: number | null;
  slopePct: number | null;
  fallsDeg: number | null;
  hours: WindHour[];
};

type Forecast = {
  utc_offset_seconds?: number;
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
  };
  daily?: { sunrise?: string[]; sunset?: string[] };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
    wind_gusts_10m?: number[];
  };
};

function localToUtc(iso: string, offsetSeconds: number): number {
  const stamp = iso.length === 16 ? `${iso}:00Z` : iso.endsWith("Z") ? iso : `${iso}Z`;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return parsed - offsetSeconds * 1000;
}

export async function fetchFieldWeather(lng: number, lat: number, signal?: AbortSignal): Promise<FieldWeather> {
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", lat.toFixed(4));
  forecastUrl.searchParams.set("longitude", lng.toFixed(4));
  forecastUrl.searchParams.set("current", "temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  forecastUrl.searchParams.set("hourly", "temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  forecastUrl.searchParams.set("daily", "sunrise,sunset");
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", "2");
  forecastUrl.searchParams.set("wind_speed_unit", "ms");

  const elevUrl = new URL("https://api.open-meteo.com/v1/elevation");
  const dLat = 180 / 111132;
  const dLng = 180 / Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  elevUrl.searchParams.set("latitude", [lat, lat + dLat, lat].map((n) => n.toFixed(5)).join(","));
  elevUrl.searchParams.set("longitude", [lng, lng, lng + dLng].map((n) => n.toFixed(5)).join(","));

  const [forecastRes, elevRes] = await Promise.all([fetch(forecastUrl, { signal }), fetch(elevUrl, { signal })]);
  if (!forecastRes.ok) throw new Error("Weather unavailable");
  const forecast = (await forecastRes.json()) as Forecast;
  let elevationM: number | null = null;
  let slopePct: number | null = null;
  let fallsDeg: number | null = null;
  if (elevRes.ok) {
    const elev = (await elevRes.json()) as { elevation?: number[] };
    const [here, north, east] = elev.elevation ?? [];
    elevationM = typeof here === "number" ? here : null;
    if (typeof here === "number" && typeof north === "number" && typeof east === "number") {
      const gN = (north - here) / 180;
      const gE = (east - here) / 180;
      const grade = Math.hypot(gN, gE);
      slopePct = grade * 100;
      if (grade > 0.02) {
        const uphill = (Math.atan2(gE, gN) * 180) / Math.PI;
        fallsDeg = (uphill + 180 + 360) % 360;
      }
    }
  }
  const current = forecast.current ?? {};
  const offset = forecast.utc_offset_seconds ?? 0;
  const times = forecast.hourly?.time ?? [];
  const now = Date.now() - 20 * 60 * 1000;
  const hours: WindHour[] = [];
  for (let i = 0; i < times.length && hours.length < 14; i++) {
    const at = localToUtc(times[i], offset);
    if (!Number.isFinite(at) || at < now) continue;
    hours.push({
      at,
      time: times[i],
      tempC: forecast.hourly?.temperature_2m?.[i] ?? 0,
      windMps: forecast.hourly?.wind_speed_10m?.[i] ?? 0,
      gustMps: forecast.hourly?.wind_gusts_10m?.[i] ?? 0,
      windFrom: forecast.hourly?.wind_direction_10m?.[i] ?? 0,
    });
  }
  return {
    tempC: current.temperature_2m ?? 0,
    windMps: current.wind_speed_10m ?? 0,
    gustMps: current.wind_gusts_10m ?? 0,
    windFrom: current.wind_direction_10m ?? 0,
    sunrise: forecast.daily?.sunrise?.[0] ?? null,
    sunset: forecast.daily?.sunset?.[0] ?? null,
    elevationM,
    slopePct,
    fallsDeg,
    hours,
  };
}
