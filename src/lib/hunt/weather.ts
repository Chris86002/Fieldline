export type FieldWeather = {
  tempC: number;
  windMps: number;
  gustMps: number;
  windFrom: number;
  sunrise: string | null;
  sunset: string | null;
  elevationM: number | null;
};

type Forecast = {
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
  };
  daily?: { sunrise?: string[]; sunset?: string[] };
};

export async function fetchFieldWeather(lng: number, lat: number, signal?: AbortSignal): Promise<FieldWeather> {
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", lat.toFixed(4));
  forecastUrl.searchParams.set("longitude", lng.toFixed(4));
  forecastUrl.searchParams.set("current", "temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  forecastUrl.searchParams.set("daily", "sunrise,sunset");
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", "1");
  forecastUrl.searchParams.set("wind_speed_unit", "ms");

  const elevUrl = new URL("https://api.open-meteo.com/v1/elevation");
  elevUrl.searchParams.set("latitude", lat.toFixed(4));
  elevUrl.searchParams.set("longitude", lng.toFixed(4));

  const [forecastRes, elevRes] = await Promise.all([fetch(forecastUrl, { signal }), fetch(elevUrl, { signal })]);
  if (!forecastRes.ok) throw new Error("Weather unavailable");
  const forecast = (await forecastRes.json()) as Forecast;
  let elevationM: number | null = null;
  if (elevRes.ok) {
    const elev = (await elevRes.json()) as { elevation?: number[] };
    const value = elev.elevation?.[0];
    elevationM = typeof value === "number" ? value : null;
  }
  const current = forecast.current ?? {};
  return {
    tempC: current.temperature_2m ?? 0,
    windMps: current.wind_speed_10m ?? 0,
    gustMps: current.wind_gusts_10m ?? 0,
    windFrom: current.wind_direction_10m ?? 0,
    sunrise: forecast.daily?.sunrise?.[0] ?? null,
    sunset: forecast.daily?.sunset?.[0] ?? null,
    elevationM,
  };
}
