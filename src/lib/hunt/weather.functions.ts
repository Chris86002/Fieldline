import { createServerFn } from "@tanstack/react-start";
import { fetchFieldWeather, type FieldWeather } from "@/lib/hunt/weather";
import { parseWeatherInput } from "@/lib/hunt/weather-input";

export const loadFieldWeather = createServerFn({ method: "GET" })
  .validator(parseWeatherInput)
  .handler(async ({ data }): Promise<FieldWeather | null> => {
    try {
      return await fetchFieldWeather(data.lng, data.lat, AbortSignal.timeout(20_000));
    } catch {
      return null;
    }
  });
