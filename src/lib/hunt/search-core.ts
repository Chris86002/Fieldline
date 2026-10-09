export type PlaceHit = { id: string; name: string; detail: string; lng: number; lat: number };
export type SearchInput = { q: string; lng: number; lat: number };

type Fetcher = typeof fetch;
type SearchOptions = {
  fetcher?: Fetcher;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  minNominatimIntervalMs?: number;
};

type NominatimRow = { place_id?: number; display_name?: string; lat?: string; lon?: string };
type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: { name?: string; state?: string; city?: string; countrycode?: string };
};

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 7_000;
const NOMINATIM_INTERVAL_MS = 1_000;
const resultCache = new Map<string, { expiresAt: number; result: Promise<PlaceHit[]> }>();
let nextNominatimRequestAt = 0;

export function parseSearchInput(input: unknown): SearchInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid place search.");
  }
  const value = input as { q?: unknown; lng?: unknown; lat?: unknown };
  if (typeof value.q !== "string") throw new Error("Enter a place to search.");
  const q = value.q.trim().slice(0, 80);
  const lng = value.lng === undefined ? -111.38 : value.lng;
  const lat = value.lat === undefined ? 33.95 : value.lat;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error("Invalid search longitude.");
  }
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("Invalid search latitude.");
  }
  return { q, lng, lat };
}

function validCoords(lng: unknown, lat: unknown): { lng: number; lat: number } | null {
  if (
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180 &&
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90
  ) {
    return { lng, lat };
  }
  return null;
}

function parseNominatim(rows: unknown): PlaceHit[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: NominatimRow) => {
    const point = validCoords(Number(row?.lon), Number(row?.lat));
    if (!point || typeof row.display_name !== "string") return [];
    const [name, ...rest] = row.display_name.split(",");
    const cleanName = name?.trim();
    if (!cleanName) return [];
    return [
      {
        id: `n-${row.place_id ?? cleanName}`,
        name: cleanName,
        detail: rest.join(",").trim(),
        lng: point.lng,
        lat: point.lat,
      },
    ];
  });
}

function parsePhoton(features: unknown): PlaceHit[] {
  if (!Array.isArray(features)) return [];
  return features.flatMap((feature: PhotonFeature, index) => {
    const coords = feature?.geometry?.coordinates;
    const point = validCoords(coords?.[0], coords?.[1]);
    const code = feature?.properties?.countrycode?.toUpperCase();
    const name = feature?.properties?.name?.trim();
    if (!point || (code && code !== "US") || !name) return [];
    return [
      {
        id: `p-${index}-${name}`,
        name,
        detail: [feature.properties?.city, feature.properties?.state].filter(Boolean).join(", "),
        lng: point.lng,
        lat: point.lat,
      },
    ];
  });
}

async function fetchNominatim(
  data: SearchInput,
  fetcher: Fetcher,
  options: SearchOptions,
): Promise<PlaceHit[]> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const interval = options.minNominatimIntervalMs ?? NOMINATIM_INTERVAL_MS;
  const scheduledAt = Math.max(now(), nextNominatimRequestAt);
  nextNominatimRequestAt = scheduledAt + interval;
  const delay = scheduledAt - now();
  if (delay > 0) await wait(delay);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("q", data.q);
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set(
    "viewbox",
    `${Math.max(-180, data.lng - 4)},${Math.min(90, data.lat + 4)},${Math.min(180, data.lng + 4)},${Math.max(-90, data.lat - 4)}`,
  );
  const response = await fetcher(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Fieldline/1.0 (+https://github.com/Chris86002/Fieldline)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  return parseNominatim(await response.json());
}

async function fetchPhoton(data: SearchInput, fetcher: Fetcher): Promise<PlaceHit[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", data.q);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lat", String(data.lat));
  url.searchParams.set("lon", String(data.lng));
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { features?: unknown };
  return parsePhoton(body.features);
}

async function searchUncached(data: SearchInput, options: SearchOptions): Promise<PlaceHit[]> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const places = await fetchNominatim(data, fetcher, options);
    if (places.length > 0) return places;
  } catch {
    // Photon is a fallback when Nominatim is unavailable or has no nearby match.
  }
  try {
    return await fetchPhoton(data, fetcher);
  } catch {
    return [];
  }
}

export function searchPlaceResults(input: unknown, options: SearchOptions = {}): Promise<PlaceHit[]> {
  const data = parseSearchInput(input);
  if (data.q.length < 2) return Promise.resolve([]);
  const now = options.now ?? Date.now;
  const key = `${data.q.toLocaleLowerCase()}|${data.lng.toFixed(2)}|${data.lat.toFixed(2)}`;
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > now()) return cached.result;

  const result = searchUncached(data, options);
  resultCache.delete(key);
  resultCache.set(key, { expiresAt: now() + CACHE_TTL_MS, result });
  while (resultCache.size > CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
  return result;
}

export function clearPlaceSearchCacheForTests() {
  resultCache.clear();
  nextNominatimRequestAt = 0;
}
