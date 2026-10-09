import { createServerFn } from "@tanstack/react-start";
import { parseSearchInput, searchPlaceResults, type PlaceHit } from "@/lib/hunt/search-core";

export type { PlaceHit } from "@/lib/hunt/search-core";

export const searchPlaces = createServerFn({ method: "GET" })
  .validator(parseSearchInput)
  .handler(async ({ data }): Promise<PlaceHit[]> => searchPlaceResults(data));
