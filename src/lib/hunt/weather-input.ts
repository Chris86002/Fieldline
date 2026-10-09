export type WeatherInput = { lng: number; lat: number };

export function parseWeatherInput(input: unknown): WeatherInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid weather location.");
  }
  const value = input as { lng?: unknown; lat?: unknown };
  const lng = value.lng === undefined ? -111.38 : value.lng;
  const lat = value.lat === undefined ? 33.95 : value.lat;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error("Invalid weather longitude.");
  }
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("Invalid weather latitude.");
  }
  return { lng, lat };
}
