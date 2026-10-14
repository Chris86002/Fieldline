/**
 * Point forecasts for the weather card. Every measurement is nullable: a
 * missing provider value stays `null` ("unknown") and is never replaced with
 * 0 °C, calm wind, a 0% chance, or a clear-sky code.
 */
export type WindHour = {
  at: number;
  time: string;
  tempC: number | null;
  windMps: number | null;
  gustMps: number | null;
  windFrom: number | null;
  pop: number | null;
  code: number | null;
};

export type DayOutlook = {
  date: string;
  code: number | null;
  highC: number | null;
  lowC: number | null;
  /** The day's highest hourly chance of precipitation, in percent. */
  popMax: number | null;
  windMaxMps: number | null;
  windFrom: number | null;
};

export type PressureTrend = "rising" | "falling" | "steady";

export type WeatherProvider = "open-meteo" | "nws";

/** Where a forecast came from and how its "now" values were produced. */
export type WeatherSource = {
  provider: WeatherProvider;
  label: string;
  /** When Fieldline received the forecast. */
  fetchedAt: number;
  /** Provider issue/update time, when the provider publishes one. */
  issuedAt: number | null;
  /** Valid time of the "now" values. */
  currentValidAt: number | null;
  /**
   * "model-now": the provider's model estimate for the current interval.
   * "forecast-hour": the first hourly forecast period, standing in for now.
   * Neither is a station observation.
   */
  currentKind: "model-now" | "forecast-hour";
  /** Cloud cover was inferred from a text forecast, not provided as a number. */
  cloudInferred: boolean;
  /** Sky codes were inferred from forecast text. */
  codeInferred: boolean;
  /** IANA zone the provider used for local times, when known. */
  timeZone: string | null;
};

export type FieldWeather = {
  tempC: number | null;
  apparentC: number | null;
  humidity: number | null;
  cloud: number | null;
  code: number | null;
  /** Chance of precipitation for the hour containing now, in percent. */
  popHour: number | null;
  /** Today's peak hourly chance of precipitation, in percent. Not the chance right now. */
  popDayMax: number | null;
  highC: number | null;
  lowC: number | null;
  /** The forecast point's local date (YYYY-MM-DD) when the forecast was read. */
  today: string | null;
  windMps: number | null;
  gustMps: number | null;
  windFrom: number | null;
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
  source: WeatherSource;
};

export type SkyWeather = Omit<FieldWeather, "elevationM" | "slopePct" | "fallsDeg">;

export type OpenMeteoForecast = {
  utc_offset_seconds?: number;
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number | null;
    apparent_temperature?: number | null;
    relative_humidity_2m?: number | null;
    cloud_cover?: number | null;
    weather_code?: number | null;
    wind_speed_10m?: number | null;
    wind_direction_10m?: number | null;
    wind_gusts_10m?: number | null;
    surface_pressure?: number | null;
    pressure_msl?: number | null;
  };
  daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
    sunrise?: string[];
    sunset?: string[];
    wind_speed_10m_max?: (number | null)[];
    wind_direction_10m_dominant?: (number | null)[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    weather_code?: (number | null)[];
    surface_pressure?: (number | null)[];
    pressure_msl?: (number | null)[];
  };
};

const MOON = ["New", "Waxing crescent", "First quarter", "Waxing gibbous", "Full", "Waning gibbous", "Last quarter", "Waning crescent"];
const HOUR_MS = 60 * 60 * 1000;

export function moonOn(date = new Date()): { name: string; illum: number } {
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000, 0, 6, 18, 14, 0);
  const age = (((date.getTime() - knownNew) / 86_400_000) % synodic + synodic) % synodic;
  const illum = (1 - Math.cos((2 * Math.PI * age) / synodic)) / 2;
  const index = Math.floor((age + synodic / 16) / (synodic / 8)) % 8;
  return { name: MOON[index] ?? "Moon", illum };
}

export function weatherLabel(code: number | null, short = false): string {
  if (code == null) return "Sky unknown";
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
  current: number | null,
  times: string[],
  series: (number | null)[] | undefined,
  offset: number,
  now: number,
): { pressureHpa: number | null; pressureTrend: PressureTrend | null } {
  if (current == null) return { pressureHpa: null, pressureTrend: null };
  const target = now - 3 * HOUR_MS;
  let best: { at: number; p: number } | null = null;
  for (let i = 0; i < times.length; i++) {
    const p = val(series?.[i]);
    if (p == null) continue;
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

/** A finite number, or null. Never substitutes a default for missing data. */
export function val(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

/** Index of the hourly period containing `now`, or -1. */
function hourContaining(starts: number[], now: number): number {
  return starts.findIndex((at) => Number.isFinite(at) && at <= now && now < at + HOUR_MS);
}

export function parseOpenMeteo(forecast: OpenMeteoForecast, fetchedAt: number): SkyWeather {
  const current = forecast.current ?? {};
  const offset = forecast.utc_offset_seconds ?? 0;
  const times = forecast.hourly?.time ?? [];
  const starts = times.map((time) => localToUtc(time, offset));
  const hourly = forecast.hourly;
  const since = fetchedAt - 20 * 60 * 1000;
  const hours: WindHour[] = [];
  for (let i = 0; i < times.length && hours.length < 16; i++) {
    const at = starts[i];
    if (!Number.isFinite(at) || at < since) continue;
    hours.push({
      at,
      time: times[i],
      tempC: val(hourly?.temperature_2m?.[i]),
      windMps: val(hourly?.wind_speed_10m?.[i]),
      gustMps: val(hourly?.wind_gusts_10m?.[i]),
      windFrom: val(hourly?.wind_direction_10m?.[i]),
      pop: val(hourly?.precipitation_probability?.[i]),
      code: val(hourly?.weather_code?.[i]),
    });
  }
  const daily = forecast.daily;
  const dailyTimes = daily?.time ?? [];
  const days: DayOutlook[] = [];
  for (let i = 0; i < dailyTimes.length && days.length < 4; i++) {
    days.push({
      date: dailyTimes[i],
      code: val(daily?.weather_code?.[i]),
      highC: val(daily?.temperature_2m_max?.[i]),
      lowC: val(daily?.temperature_2m_min?.[i]),
      popMax: val(daily?.precipitation_probability_max?.[i]),
      windMaxMps: val(daily?.wind_speed_10m_max?.[i]),
      windFrom: val(daily?.wind_direction_10m_dominant?.[i]),
    });
  }
  const moon = moonOn(new Date(fetchedAt));
  const todayDate = current.time?.slice(0, 10) ?? dailyTimes[0] ?? null;
  const today = days.find((day) => day.date === todayDate);
  const nowIndex = hourContaining(starts, fetchedAt);
  const currentAt = current.time ? localToUtc(current.time, offset) : Number.NaN;
  const pressure = pressureNow(val(current.pressure_msl), times, hourly?.pressure_msl, offset, fetchedAt);
  return {
    tempC: val(current.temperature_2m),
    apparentC: val(current.apparent_temperature),
    humidity: val(current.relative_humidity_2m),
    cloud: val(current.cloud_cover),
    code: val(current.weather_code),
    popHour: nowIndex >= 0 ? val(hourly?.precipitation_probability?.[nowIndex]) : null,
    popDayMax: today?.popMax ?? null,
    highC: today?.highC ?? null,
    lowC: today?.lowC ?? null,
    today: todayDate,
    windMps: val(current.wind_speed_10m),
    gustMps: val(current.wind_gusts_10m),
    windFrom: val(current.wind_direction_10m),
    sunrise: daily?.sunrise?.[0] ?? null,
    sunset: daily?.sunset?.[0] ?? null,
    sunriseAt: localStamp(daily?.sunrise?.[0], offset),
    sunsetAt: localStamp(daily?.sunset?.[0], offset),
    ...pressure,
    moonName: moon.name,
    moonIllum: moon.illum,
    days,
    hours,
    source: {
      provider: "open-meteo",
      label: "Open-Meteo forecast models",
      fetchedAt,
      issuedAt: null,
      currentValidAt: Number.isFinite(currentAt) ? currentAt : null,
      currentKind: "model-now",
      cloudInferred: false,
      codeInferred: false,
      timeZone: typeof forecast.timezone === "string" && forecast.timezone ? forecast.timezone : null,
    },
  };
}

async function fetchOpenMeteo(lng: number, lat: number, signal?: AbortSignal): Promise<SkyWeather> {
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
  return parseOpenMeteo((await forecastRes.json()) as OpenMeteoForecast, Date.now());
}

const COMPASS: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

function compassDeg(dir: string | undefined): number | null {
  if (!dir) return null;
  return COMPASS[dir.trim().toUpperCase()] ?? null;
}

/**
 * NWS wind text is a speed or a speed range ("10 to 15 mph"), not gusts.
 * Returns the low and high ends in m/s; both null when there is no number.
 */
export function parseNwsWind(text: string | undefined): { low: number | null; high: number | null } {
  const nums = (text?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return { low: null, high: null };
  const kmh = /km\/h/i.test(text ?? "");
  const toMps = (n: number) => (kmh ? n / 3.6 : n / 2.236936);
  return { low: toMps(nums[0]), high: toMps(nums[nums.length - 1]) };
}

function fToC(temp: number): number {
  return ((temp - 32) * 5) / 9;
}

/** Best-effort sky code from NWS text. Unknown text stays null instead of "partly cloudy". */
export function codeFromSky(text: string | undefined): number | null {
  const sky = (text ?? "").toLowerCase();
  if (!sky.trim()) return null;
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
  return null;
}

/** Rough cloud percentage implied by a sky code. Only used when labeled as inferred. */
function cloudFromCode(code: number | null): number | null {
  if (code == null) return null;
  if (code === 0) return 8;
  if (code === 1) return 25;
  if (code === 2) return 55;
  if (code === 3) return 88;
  if (code === 45) return 100;
  return null;
}

export type NwsPeriod = {
  startTime?: string;
  endTime?: string;
  isDaytime?: boolean;
  temperature?: number | null;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null };
  relativeHumidity?: { value?: number | null };
};

export type NwsForecast = { properties?: { periods?: NwsPeriod[]; updateTime?: string; generatedAt?: string } };

function periodTempC(period: NwsPeriod | undefined): number | null {
  const temp = val(period?.temperature);
  if (temp == null) return null;
  return period?.temperatureUnit === "C" ? temp : fToC(temp);
}

function maxKnown(...values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? Math.max(...known) : null;
}

export function parseNws(
  daily: NwsForecast,
  hourly: NwsForecast,
  astro: { sunrise?: string; sunset?: string } | null,
  fetchedAt: number,
): SkyWeather {
  const periods = daily.properties?.periods ?? [];
  const hoursRaw = hourly.properties?.periods ?? [];
  const since = fetchedAt - 20 * 60 * 1000;
  const hours: WindHour[] = [];
  let currentPeriod: NwsPeriod | null = null;
  for (const period of hoursRaw) {
    if (!period.startTime || hours.length >= 16) break;
    const at = Date.parse(period.startTime);
    const end = period.endTime ? Date.parse(period.endTime) : at + HOUR_MS;
    if (!Number.isFinite(at) || end < since) continue;
    if (!currentPeriod) currentPeriod = period;
    const wind = parseNwsWind(period.windSpeed);
    hours.push({
      at,
      time: period.startTime,
      tempC: periodTempC(period),
      windMps: wind.low,
      gustMps: null,
      windFrom: compassDeg(period.windDirection),
      pop: val(period.probabilityOfPrecipitation?.value),
      code: codeFromSky(period.shortForecast),
    });
  }
  // Group day and night periods by the forecast point's local date (the date in
  // each period's own offset). In the evening the list starts with "Tonight",
  // which still belongs to today.
  const byDate = new Map<string, { day?: NwsPeriod; night?: NwsPeriod }>();
  for (const period of periods) {
    if (!period.startTime) continue;
    const date = period.startTime.slice(0, 10);
    const slot = byDate.get(date) ?? {};
    if (period.isDaytime) slot.day ??= period;
    else slot.night ??= period;
    byDate.set(date, slot);
  }
  const days: DayOutlook[] = [...byDate.entries()].slice(0, 4).map(([date, { day, night }]) => {
    const lead = day ?? night;
    return {
      date,
      code: codeFromSky(lead?.shortForecast),
      highC: periodTempC(day),
      lowC: periodTempC(night),
      popMax: maxKnown(val(day?.probabilityOfPrecipitation?.value), val(night?.probabilityOfPrecipitation?.value)),
      windMaxMps: parseNwsWind(lead?.windSpeed).high,
      windFrom: compassDeg(lead?.windDirection),
    };
  });
  const current = hours[0];
  if (!current || !currentPeriod?.startTime) throw new Error("Weather unavailable");
  const todayDate = currentPeriod.startTime.slice(0, 10);
  const today = days.find((day) => day.date === todayDate);
  const moon = moonOn(new Date(fetchedAt));
  const issued = zonedStamp(hourly.properties?.updateTime ?? hourly.properties?.generatedAt);
  return {
    tempC: current.tempC,
    apparentC: null,
    humidity: val(currentPeriod.relativeHumidity?.value),
    cloud: cloudFromCode(current.code),
    code: current.code,
    popHour: current.pop,
    popDayMax: today?.popMax ?? null,
    highC: today?.highC ?? null,
    lowC: today?.lowC ?? null,
    today: todayDate,
    windMps: current.windMps,
    gustMps: null,
    windFrom: current.windFrom,
    sunrise: astro?.sunrise ?? null,
    sunset: astro?.sunset ?? null,
    sunriseAt: zonedStamp(astro?.sunrise),
    sunsetAt: zonedStamp(astro?.sunset),
    pressureHpa: null,
    pressureTrend: null,
    moonName: moon.name,
    moonIllum: moon.illum,
    days,
    hours,
    source: {
      provider: "nws",
      label: "National Weather Service forecast",
      fetchedAt,
      issuedAt: issued,
      currentValidAt: current.at,
      currentKind: "forecast-hour",
      cloudInferred: current.code != null,
      codeInferred: true,
      timeZone: null,
    },
  };
}

const NWS_HEADERS = { Accept: "application/geo+json", "User-Agent": "Fieldline/1.0 (hunting map)" };

async function fetchNws(lng: number, lat: number, signal?: AbortSignal): Promise<SkyWeather> {
  const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { signal, headers: NWS_HEADERS });
  if (!pointsRes.ok) throw new Error("Weather unavailable");
  const points = (await pointsRes.json()) as {
    properties?: {
      forecast?: string;
      forecastHourly?: string;
      timeZone?: string;
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
  const astro = points.properties?.astronomicalData;
  const sky = parseNws(
    (await dailyRes.json()) as NwsForecast,
    (await hourlyRes.json()) as NwsForecast,
    astro && typeof astro === "object" ? astro : null,
    Date.now(),
  );
  const zone = points.properties?.timeZone;
  return typeof zone === "string" && zone ? { ...sky, source: { ...sky.source, timeZone: zone } } : sky;
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
