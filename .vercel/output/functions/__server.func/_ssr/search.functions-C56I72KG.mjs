import { n as TSS_SERVER_FUNCTION, t as createServerFn } from "./ssr.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/search.functions-C56I72KG.js
var createServerRpc = (serverFnMeta, splitImportFn) => {
	const url = "/_serverFn/" + serverFnMeta.id;
	return Object.assign(splitImportFn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
function trimQuery(input) {
	return {
		q: (input.q ?? "").trim().slice(0, 80),
		lng: typeof input.lng === "number" ? input.lng : -111.38,
		lat: typeof input.lat === "number" ? input.lat : 33.95
	};
}
async function fromNominatim(q, lng, lat) {
	const url = new URL("https://nominatim.openstreetmap.org/search");
	url.searchParams.set("format", "jsonv2");
	url.searchParams.set("limit", "6");
	url.searchParams.set("q", q);
	url.searchParams.set("countrycodes", "us");
	const delta = 4;
	url.searchParams.set("viewbox", `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`);
	const res = await fetch(url, { headers: {
		Accept: "application/json",
		"User-Agent": "Fieldline/1.0 (free hunting map)"
	} });
	if (!res.ok) return [];
	return (await res.json()).flatMap((row) => {
		const latN = Number(row.lat);
		const lngN = Number(row.lon);
		if (!Number.isFinite(latN) || !Number.isFinite(lngN) || !row.display_name) return [];
		const [name, ...rest] = row.display_name.split(",");
		return [{
			id: `n-${row.place_id ?? name}`,
			name: name.trim(),
			detail: rest.join(",").trim(),
			lng: lngN,
			lat: latN
		}];
	});
}
async function fromPhoton(q, lng, lat) {
	const url = new URL("https://photon.komoot.io/api/");
	url.searchParams.set("q", q);
	url.searchParams.set("limit", "6");
	url.searchParams.set("lat", String(lat));
	url.searchParams.set("lon", String(lng));
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) return [];
	return ((await res.json()).features ?? []).flatMap((feature, index) => {
		const coords = feature.geometry?.coordinates;
		if (!coords) return [];
		const code = (feature.properties?.countrycode ?? "").toUpperCase();
		if (code && code !== "US") return [];
		const name = feature.properties?.name?.trim();
		if (!name) return [];
		const detail = [feature.properties?.city, feature.properties?.state].filter(Boolean).join(", ");
		return [{
			id: `p-${index}-${name}`,
			name,
			detail,
			lng: coords[0],
			lat: coords[1]
		}];
	});
}
var searchPlaces_createServerFn_handler = createServerRpc({
	id: "5ba6f415d28131cd8d41ad398db534ee47cf75a14e79245f88731dee521aef86",
	name: "searchPlaces",
	filename: "src/lib/hunt/search.functions.ts"
}, (opts) => searchPlaces.__executeServer(opts));
var searchPlaces = createServerFn({ method: "GET" }).validator(trimQuery).handler(searchPlaces_createServerFn_handler, async ({ data }) => {
	if (data.q.length < 2) return [];
	try {
		const named = await fromNominatim(data.q, data.lng, data.lat);
		if (named.length > 0) return named;
	} catch {}
	try {
		return await fromPhoton(data.q, data.lng, data.lat);
	} catch {
		return [];
	}
});
//#endregion
export { searchPlaces_createServerFn_handler };
