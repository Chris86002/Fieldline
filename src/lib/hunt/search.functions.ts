import { createServerFn } from "@tanstack/react-start";

export type PlaceHit = { id: string; name: string; detail: string; lng: number; lat: number };

type NominatimRow = { place_id?: number; display_name?: string; lat?: string; lon?: string };
type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: { name?: string; state?: string; city?: string; country?: string; countrycode?: string };
};

function trimQuery(input: { q?: string; lng?: number; lat?: number }) {
  return {
    q: (input.q ?? "").trim().slice(0, 80),
    lng: typeof input.lng === "number" ? input.lng : -111.38,
    lat: typeof input.lat === "number" ? input.lat : 33.95,
  };
}

async function fromNominatim(q: string, lng: number, lat: number): Promise<PlaceHit[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("q", q);
  url.searchParams.set("countrycodes", "us");
  const delta = 4;
  url.searchParams.set("viewbox", `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Fieldline/1.0 (free hunting map)",
    },
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as NominatimRow[];
  return rows.flatMap((row) => {
    const latN = Number(row.lat);
    const lngN = Number(row.lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN) || !row.display_name) return [];
    const [name, ...rest] = row.display_name.split(",");
    return [{ id: `n-${row.place_id ?? name}`, name: name.trim(), detail: rest.join(",").trim(), lng: lngN, lat: latN }];
  });
}

async function fromPhoton(q: string, lng: number, lat: number): Promise<PlaceHit[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const body = (await res.json()) as { features?: PhotonFeature[] };
  return (body.features ?? []).flatMap((feature, index) => {
    const coords = feature.geometry?.coordinates;
    if (!coords) return [];
    const code = (feature.properties?.countrycode ?? "").toUpperCase();
    if (code && code !== "US") return [];
    const name = feature.properties?.name?.trim();
    if (!name) return [];
    const detail = [feature.properties?.city, feature.properties?.state].filter(Boolean).join(", ");
    return [{ id: `p-${index}-${name}`, name, detail, lng: coords[0], lat: coords[1] }];
  });
}

export const searchPlaces = createServerFn({ method: "GET" })
  .validator(trimQuery)
  .handler(async ({ data }): Promise<PlaceHit[]> => {
    if (data.q.length < 2) return [];
    try {
      const named = await fromNominatim(data.q, data.lng, data.lat);
      if (named.length > 0) return named;
    } catch {
      /* try the fallback geocoder */
    }
    try {
      return await fromPhoton(data.q, data.lng, data.lat);
    } catch {
      return [];
    }
  });
