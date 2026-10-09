export type WindHour = {
  at: number;
  time: string;
  tempC: number;
  windMps: number;
  gustMps: number;
  windFrom: number;
  pop: number;
  code: number;
};

export type DayOutlook = {
  date: string;
  code: number;
  highC: number;
  lowC: number;
  pop: number;
  windMps: number;
  windFrom: number;
};

export type PressureTrend = "rising" | "falling" | "steady";

export type FieldWeather = {
  tempC: number;
  apparentC: number;
  humidity: number;
  cloud: number;
  code: number;
  pop: number;
  highC: number;
  lowC: number;
  windMps: number;
  gustMps: number;
  windFrom: number;
  sunrise: string | null;
  sunset: string | null;
  elevationM: number | null;
  slopePct: number | null;
  fallsDeg: number | null;
  moonName: string;
  moonIllum: number;
  days: DayOutlook[];
  hours: WindHour[];
  sunriseAt: number | null;
  sunsetAt: number | null;
  pressureHpa: number | null;
  pressureTrend: PressureTrend | null;
};

type Forecast = {
  utc_offset_seconds?: number;
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    cloud_cover?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
    surface_pressure?: number;
    pressure_msl?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    sunrise?: string[];
    sunset?: string[];
    wind_speed_10m_max?: number[];
    wind_direction_10m_dominant?: number[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
    wind_gusts_10m?: number[];
    precipitation_probability?: number[];
    weather_code?: number[];
    surface_pressure?: number[];
    pressure_msl?: number[];
  };
};

const MOON = ["New", "Waxing crescent", "First quarter", "Waxing gibbous", "Full", "Waning gibbous", "Last quarter", "Waning crescent"];

export function moonOn(date = new Date()): { name: string; illum: number } {
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000, 0, 6, 18, 14, 0);
  const age = (((date.getTime() - knownNew) / 86_400_000) % synodic + synodic) % synodic;
  const illum = (1 - Math.cos((2 * Math.PI * age) / synodic)) / 2;
  const index = Math.floor((age + synodic / 16) / (synodic / 8)) % 8;
  return { name: MOON[index] ?? "Moon", illum };
}

export function weatherLabel(code: number, short = false): string {
  if (code === 0) return short ? "Clear" : "Clear";
  if (code === 1) return short ? "Fair" : "Mostly clear";
  if (code === 2) return short ? "Fair" : "Partly cloudy";
  if (code === 3) return short ? "Cloudy" : "Cloudy";
  if (code <= 49) return "Fog";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 82) return short ? "Rain" : "Showers";
  if (code <= 86) return short ? "Snow" : "Snow showers";
  if (code <= 99) return short ? "Storms" : "Thunderstorms";
  return "Weather";
}

function localToUtc(iso: string, offsetSeconds: number): number {
  const stamp = iso.length === 16 ? `${iso}:00Z` : iso.endsWith("Z") ? iso : `${iso}Z`;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return parsed - offsetSeconds * 1000;
}

function trendFrom(deltaHpa: number): PressureTrend {
  if (deltaHpa >= 1.5) return "rising";
  if (deltaHpa <= -1.5) return "falling";
  return "steady";
}

function pressureNow(
  current: number | undefined,
  times: string[],
  series: number[] | undefined,
  offset: number,
): { pressureHpa: number | null; pressureTrend: PressureTrend | null } {
  if (typeof current !== "number" || !Number.isFinite(current)) return { pressureHpa: null, pressureTrend: null };
  const target = Date.now() - 3 * 60 * 60 * 1000;
  let best: { at: number; p: number } | null = null;
  for (let i = 0; i < times.length; i++) {
    const p = series?.[i];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    const at = localToUtc(times[i], offset);
    if (!Number.isFinite(at)) continue;
    if (!best || Math.abs(at - target) < Math.abs(best.at - target)) best = { at, p };
  }
  const pressureTrend = best && Math.abs(best.at - target) < 90 * 60 * 1000 ? trendFrom(current - best.p) : null;
  return { pressureHpa: current, pressureTrend };
}

function localStamp(iso: string | null | undefined, offset: number): number | null {
  if (!iso) return null;
  const at = localToUtc(iso, offset);
  return Number.isFinite(at) ? at : null;
}

function zonedStamp(iso: string | null | undefined): number | null {
  if (!iso || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function num(value: number | undefined | null, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Ground = Pick<FieldWeather, "elevationM" | "slopePct" | "fallsDeg">;

function slopeFrom(here: number, north: number, east: number): Ground {
  const gN = (north - here) / 180;
  const gE = (east - here) / 180;
  const grade = Math.hypot(gN, gE);
  let fallsDeg: number | null = null;
  if (grade > 0.02) {
    const uphill = (Math.atan2(gE, gN) * 180) / Math.PI;
    fallsDeg = (uphill + 180 + 360) % 360;
  }
  return { elevationM: here, slopePct: grade * 100, fallsDeg };
}

async function usgsElev(lng: number, lat: number, signal?: AbortSignal): Promise<number | null> {
  const url = `https://epqs.nationalmap.gov/v1/json?x=${lng.toFixed(5)}&y=${lat.toFixed(5)}&units=Meters&wkid=4326`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as { value?: string | number };
  const value = typeof json.value === "number" ? json.value : Number(json.value);
  return Number.isFinite(value) ? value : null;
}

async function readTerrain(lng: number, lat: number, signal?: AbortSignal): Promise<Ground> {
  const empty: Ground = { elevationM: null, slopePct: null, fallsDeg: null };
  const dLat = 180 / 111132;
  const dLng = 180 / Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  const spots = [
    { lng, lat },
    { lng, lat: lat + dLat },
    { lng: lng + dLng, lat },
  ];
  try {
    const elevUrl = new URL("https://api.open-meteo.com/v1/elevation");
    elevUrl.searchParams.set("latitude", spots.map((spot) => spot.lat.toFixed(5)).join(","));
    elevUrl.searchParams.set("longitude", spots.map((spot) => spot.lng.toFixed(5)).join(","));
    const elevRes = await fetch(elevUrl, { signal });
    if (elevRes.ok) {
      const elev = (await elevRes.json()) as { elevation?: number[] };
      const [here, north, east] = elev.elevation ?? [];
      if (typeof here === "number" && typeof north === "number" && typeof east === "number") return slopeFrom(here, north, east);
    }
  } catch {
    if (signal?.aborted) return empty;
  }
  const [here, north, east] = await Promise.all(
    spots.map((spot) =>
      usgsElev(spot.lng, spot.lat, signal).catch(() => null),
    ),
  );
  if (here == null) return empty;
  if (north == null || east == null) return { elevationM: here, slopePct: null, fallsDeg: null };
  return slopeFrom(here, north, east);
}

async function fetchOpenMeteo(lng: number, lat: number, signal?: AbortSignal): Promise<Omit<FieldWeather, "elevationM" | "slopePct" | "fallsDeg">> {
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", lat.toFixed(4));
  forecastUrl.searchParams.set("longitude", lng.toFixed(4));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl",
  );
  forecastUrl.searchParams.set(
    "hourly",
    "temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,weather_code,pressure_msl",
  );
  forecastUrl.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,wind_direction_10m_dominant",
  );
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", "4");
  forecastUrl.searchParams.set("wind_speed_unit", "ms");
  const forecastRes = await fetch(forecastUrl, { signal });
  if (!forecastRes.ok) throw new Error("Weather unavailable");
  const forecast = (await forecastRes.json()) as Forecast;
  const current = forecast.current ?? {};
  const offset = forecast.utc_offset_seconds ?? 0;
  const times = forecast.hourly?.time ?? [];
  const now = Date.now() - 20 * 60 * 1000;
  const hours: WindHour[] = [];
  for (let i = 0; i < times.length && hours.length < 16; i++) {
    const at = localToUtc(times[i], offset);
    if (!Number.isFinite(at) || at < now) continue;
    hours.push({
      at,
      time: times[i],
      tempC: num(forecast.hourly?.temperature_2m?.[i]),
      windMps: num(forecast.hourly?.wind_speed_10m?.[i]),
      gustMps: num(forecast.hourly?.wind_gusts_10m?.[i]),
      windFrom: num(forecast.hourly?.wind_direction_10m?.[i]),
      pop: num(forecast.hourly?.precipitation_probability?.[i]),
      code: num(forecast.hourly?.weather_code?.[i]),
    });
  }
  const dailyTimes = forecast.daily?.time ?? [];
  const days: DayOutlook[] = [];
  for (let i = 0; i < dailyTimes.length && days.length < 4; i++) {
    days.push({
      date: dailyTimes[i],
      code: num(forecast.daily?.weather_code?.[i]),
      highC: num(forecast.daily?.temperature_2m_max?.[i]),
      lowC: num(forecast.daily?.temperature_2m_min?.[i]),
      pop: num(forecast.daily?.precipitation_probability_max?.[i]),
      windMps: num(forecast.daily?.wind_speed_10m_max?.[i]),
      windFrom: num(forecast.daily?.wind_direction_10m_dominant?.[i]),
    });
  }
  const moon = moonOn();
  const today = days[0];
  const pressure = pressureNow(current.pressure_msl, times, forecast.hourly?.pressure_msl, offset);
  return {
    tempC: num(current.temperature_2m),
    apparentC: num(current.apparent_temperature, num(current.temperature_2m)),
    humidity: num(current.relative_humidity_2m),
    cloud: num(current.cloud_cover),
    code: num(current.weather_code),
    pop: today?.pop ?? 0,
    highC: today?.highC ?? num(current.temperature_2m),
    lowC: today?.lowC ?? num(current.temperature_2m),
    windMps: num(current.wind_speed_10m),
    gustMps: num(current.wind_gusts_10m),
    windFrom: num(current.wind_direction_10m),
    sunrise: forecast.daily?.sunrise?.[0] ?? null,
    sunset: forecast.daily?.sunset?.[0] ?? null,
    sunriseAt: localStamp(forecast.daily?.sunrise?.[0], offset),
    sunsetAt: localStamp(forecast.daily?.sunset?.[0], offset),
    ...pressure,
    moonName: moon.name,
    moonIllum: moon.illum,
    days,
    hours,
  };
}

const COMPASS: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

function compassDeg(dir: string | undefined): number {
  if (!dir) return 0;
  return COMPASS[dir.trim().toUpperCase()] ?? 0;
}

function parseMph(text: string | undefined): { speed: number; gust: number } {
  const nums = (text?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return { speed: 0, gust: 0 };
  return { speed: nums[0], gust: nums[nums.length - 1] };
}

function fToC(temp: number): number {
  return ((temp - 32) * 5) / 9;
}

function codeFromSky(text: string | undefined): number {
  const sky = (text ?? "").toLowerCase();
  if (sky.includes("thunder")) return 95;
  if (sky.includes("snow") || sky.includes("flurr")) return 71;
  if (sky.includes("sleet") || sky.includes("ice")) return 67;
  if (sky.includes("drizzle")) return 51;
  if (sky.includes("rain") || sky.includes("shower")) return 63;
  if (sky.includes("fog") || sky.includes("mist")) return 45;
  if (sky.includes("mostly cloudy") || sky.includes("overcast")) return 3;
  if (sky.includes("partly")) return 2;
  if (sky.includes("mostly clear") || sky.includes("mostly sunny")) return 1;
  if (sky.includes("clear") || sky.includes("sunny")) return 0;
  if (sky.includes("cloud")) return 3;
  return 2;
}

function cloudFromCode(code: number): number {
  if (code === 0) return 8;
  if (code === 1) return 25;
  if (code === 2) return 55;
  if (code === 3) return 88;
  if (code === 45) return 100;
  return 75;
}

type NwsPeriod = {
  startTime?: string;
  endTime?: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null };
  relativeHumidity?: { value?: number | null };
};

function periodTempC(period: NwsPeriod): number {
  const temp = num(period.temperature);
  return period.temperatureUnit === "C" ? temp : fToC(temp);
}

const NWS_HEADERS = { Accept: "application/geo+json", "User-Agent": "Fieldline/1.0 (hunting map)" };

async function fetchNws(lng: number, lat: number, signal?: AbortSignal): Promise<Omit<FieldWeather, "elevationM" | "slopePct" | "fallsDeg">> {
  const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { signal, headers: NWS_HEADERS });
  if (!pointsRes.ok) throw new Error("Weather unavailable");
  const points = (await pointsRes.json()) as {
    properties?: {
      forecast?: string;
      forecastHourly?: string;
      astronomicalData?: { sunrise?: string; sunset?: string } | string;
    };
  };
  const forecastUrl = points.properties?.forecast;
  const hourlyUrl = points.properties?.forecastHourly;
  if (!forecastUrl || !hourlyUrl) throw new Error("Weather unavailable");
  const safeForecastUrl = new URL(forecastUrl);
  const safeHourlyUrl = new URL(hourlyUrl);
  if (safeForecastUrl.origin !== "https://api.weather.gov" || safeHourlyUrl.origin !== "https://api.weather.gov") {
    throw new Error("Weather unavailable");
  }
  const [dailyRes, hourlyRes] = await Promise.all([
    fetch(safeForecastUrl, { signal, headers: NWS_HEADERS }),
    fetch(safeHourlyUrl, { signal, headers: NWS_HEADERS }),
  ]);
  if (!dailyRes.ok || !hourlyRes.ok) throw new Error("Weather unavailable");
  const daily = (await dailyRes.json()) as { properties?: { periods?: NwsPeriod[] } };
  const hourly = (await hourlyRes.json()) as { properties?: { periods?: NwsPeriod[] } };
  const periods = daily.properties?.periods ?? [];
  const hoursRaw = hourly.properties?.periods ?? [];
  const now = Date.now() - 20 * 60 * 1000;
  const hours: WindHour[] = [];
  for (const period of hoursRaw) {
    if (!period.startTime || hours.length >= 16) break;
    const at = Date.parse(period.startTime);
    const end = period.endTime ? Date.parse(period.endTime) : at + 60 * 60 * 1000;
    if (!Number.isFinite(at) || end < now) continue;
    const wind = parseMph(period.windSpeed);
    hours.push({
      at,
      time: period.startTime,
      tempC: periodTempC(period),
      windMps: wind.speed / 2.236936,
      gustMps: wind.gust / 2.236936,
      windFrom: compassDeg(period.windDirection),
      pop: num(period.probabilityOfPrecipitation?.value),
      code: codeFromSky(period.shortForecast),
    });
  }
  const days: DayOutlook[] = [];
  for (const period of periods) {
    if (!period.isDaytime || !period.startTime || days.length >= 4) continue;
    const start = Date.parse(period.startTime);
    const night = periods.find((item) => {
      if (item.isDaytime || !item.startTime) return false;
      const at = Date.parse(item.startTime);
      return at >= start && at < start + 20 * 60 * 60 * 1000;
    });
    const wind = parseMph(period.windSpeed);
    const pop = Math.max(num(period.probabilityOfPrecipitation?.value), num(night?.probabilityOfPrecipitation?.value));
    days.push({
      date: period.startTime.slice(0, 10),
      code: codeFromSky(period.shortForecast),
      highC: periodTempC(period),
      lowC: night ? periodTempC(night) : periodTempC(period),
      pop,
      windMps: wind.gust / 2.236936,
      windFrom: compassDeg(period.windDirection),
    });
  }
  const current = hours[0];
  const today = days[0];
  const astro = points.properties?.astronomicalData;
  const sun = astro && typeof astro === "object" ? astro : null;
  const moon = moonOn();
  if (!current) throw new Error("Weather unavailable");
  return {
    tempC: current.tempC,
    apparentC: current.tempC,
    humidity: num(hoursRaw.find((period) => period.startTime === current.time)?.relativeHumidity?.value),
    cloud: cloudFromCode(current.code),
    code: current.code,
    pop: today?.pop ?? current.pop,
    highC: today?.highC ?? current.tempC,
    lowC: today?.lowC ?? current.tempC,
    windMps: current.windMps,
    gustMps: current.gustMps,
    windFrom: current.windFrom,
    sunrise: sun?.sunrise ?? null,
    sunset: sun?.sunset ?? null,
    sunriseAt: zonedStamp(sun?.sunrise),
    sunsetAt: zonedStamp(sun?.sunset),
    pressureHpa: null,
    pressureTrend: null,
    moonName: moon.name,
    moonIllum: moon.illum,
    days,
    hours,
  };
}

export async function fetchFieldWeather(lng: number, lat: number, signal?: AbortSignal): Promise<FieldWeather> {
  const terrain = readTerrain(lng, lat, signal);
  try {
    const sky = await fetchOpenMeteo(lng, lat, signal);
    return { ...sky, ...(await terrain) };
  } catch (error) {
    if (signal?.aborted) throw error;
    const sky = await fetchNws(lng, lat, signal);
    return { ...sky, ...(await terrain) };
  }
}
