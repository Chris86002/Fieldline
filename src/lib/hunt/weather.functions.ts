import { createServerFn } from "@tanstack/react-start";
import { fetchFieldWeather, type FieldWeather } from "@/lib/hunt/weather";

function coords(input: { lng?: number; lat?: number }) {
  const lng = typeof input?.lng === "number" && Number.isFinite(input.lng) ? input.lng : -111.38;
  const lat = typeof input?.lat === "number" && Number.isFinite(input.lat) ? input.lat : 33.95;
  return { lng, lat };
}

export const loadFieldWeather = createServerFn({ method: "GET" })
  .validator(coords)
  .handler(async ({ data }): Promise<FieldWeather | null> => {
    try {
      return await fetchFieldWeather(data.lng, data.lat);
    } catch {
      return null;
    }
  });
