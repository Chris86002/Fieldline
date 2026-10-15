# Fieldline data-source register

This register lists every external data provider that Fieldline calls today, plus candidate sources named in the master spec (Sections 6, 8, 10, 13 and 20 REL-04). It records what each provider's own documentation says about viewing, caching, offline use, bulk download, redistribution, authentication, rate limits, commercial use, attribution, coverage and freshness.

- Baseline: branch `feature/master-spec-v4`, commit `6caea69`. File:line references were taken from the working tree on 2026-10-13. `weather.ts` and `land.ts` were being edited in parallel at that time, so their line numbers may drift.
- All provider pages were checked on 2026-10-13 unless a different date is noted.
- **Status in app** values:
  - **in use**: the current code calls the provider.
  - **defined, unused**: the URL exists in code, but no map source or request path uses it.
  - **candidate**: named in the spec but not integrated.
- **Unverified** means the provider's page could not be fetched or does not address the point. It is never a guess.
- **Maintainer** is `unassigned` for every entry. REL-04 forbids assigning a real person on the project's behalf.
- REL-04 also asks for these fields: refresh cadence, last fetch, last successful validation, upstream publication date, license-check date, expiry policy and failure escalation. Only "license-check date" (2026-10-13) and the upstream publication date, where the provider publishes one, are known today. The rest are `not tracked` until health checks exist.

## How the app stores provider data today

- `src/lib/hunt/tiles.ts:23-66`: map sources wrapped in `cachedTile()` go through the `fltile://` protocol. Every tile the user views is written to Cache Storage `fieldline-tiles-v1`, with no expiry. Wrapped sources: Esri World Imagery, USGS Topo and BLM SMA (`MapCanvas.tsx:504-506`).
- Offline map packages (since CC-05 wave 2; `src/lib/offline/`, screens in `src/features/offline/`): Layers → Offline maps downloads a rectangle into IndexedDB from USGS imagery/topo, BLM SMA, OpenFreeMap (TileJSON, vector tiles, fonts) and AWS terrain only (`packageRuleFor` refuses every other host, Esri included), within each provider's limits (OpenFreeMap ≤ 3,000 files / 50 MB per download, ≤ 4 parallel). Packages expire by layer (BLM 90 days, OpenFreeMap 60, USGS 365). The desktop app sends OpenFreeMap an identifying User-Agent. Details: docs/storage.md "Offline packages".
- `tiles.ts` (`packTiles`): the older one-zoom save of up to 220 tiles into Cache Storage, now offered only when durable storage isn't available; templates are `OFFLINE_TEMPLATES` only (USGS imagery, USGS topo, BLM SMA).
- `src/features/catalog/unit-store.ts` (since CC-03): each hunt-unit provider's processed units are stored in Cache Storage `fieldline-units-v3` with a manifest (retrieval time, source version, counts) and a 30-day refresh policy; updates are promoted only after validation. The older `fieldline-units-v2` / `fieldline-units-id-v1` caches are deleted on startup.
- `src/routes/api/dem/$z/$x/$y.ts:20-26`: proxies AWS Terrain Tiles and sets `Cache-Control: public, max-age=604800` (7 days).
- `src/lib/hunt/search-core.ts:18-22`: place-search results are kept in memory for 60 s, with at most 100 entries.
- Weather and search run as server functions (`weather.functions.ts`, `search.functions.ts`). On desktop the local Electron server makes the upstream calls. On a hosted web deployment, every user's requests would come from the host's IP address.
- `public/sw.js` caches only same-origin requests (it checks `url.origin !== self.location.origin`), so it does not cache provider data.
- `desktop/policy.mjs:24-28` is an allowlist of hosts that may be opened in the external browser. It is not a data-fetch list. Hosts listed: openstreetmap.org, openfreemap.org, esri.com, usgs.gov, blm.gov, weather.gov, open-meteo.com, azgfd.com and idfg.idaho.gov.

---

## In use

### 1. OpenFreeMap — vector tiles and glyphs ("planet" style source)
- **Used by:** `src/components/hunt/MapCanvas.tsx:92-93` (constants `OFM`, `GLYPHS`), `:502` (glyphs), `:507` (vector source `ofm`).
- **Endpoint host:** `tiles.openfreemap.org` (`/planet`, `/fonts/{fontstack}/{range}.pbf`).
- **Status:** in use. The Street basemap and the road, track, creek, peak and town overlays depend on it.
- **View:** Free public instance with no registration. Commercial use is allowed ("Yes" on the FAQ).
- **Cache/offline:** Offline downloads are allowed within limits: at most 3,000 tiles or 50 MB per download, at most 4 parallel requests, and a unique User-Agent. Larger downloads need contact with the operator. The terms do not address general caching.
- **Bulk download:** Scraping is prohibited "except for offline downloads". Weekly full-planet downloads (MBTiles / Btrfs) are offered for self-hosting.
- **Redistribution:** Not addressed in the terms. The underlying data is OSM (ODbL).
- **Auth:** None.
- **Rate policy:** No limit on map views. The offline-download limits above apply.
- **Commercial terms:** Allowed. The service is provided as-is with no warranty and may be discontinued without notice.
- **Attribution:** Required. MapLibre shows it automatically. The app shows "© OpenStreetMap, OpenFreeMap".
- **Coverage:** Planet (OSM-derived). AK/HI are included in planet scope. Rendering quality there was not checked.
- **Freshness:** Weekly planet builds.
- **Current app behavior vs terms:** OFM's TileJSON, vector tiles and fonts go through `fltile://` (served from offline packages first; never written to Cache Storage). Offline packages download them within the stated limits: ≤ 3,000 files and ≤ 50 MB per package (planned and enforced on real bytes), ≤ 4 parallel requests tab-wide, one downloading tab at a time. The desktop app sets a unique User-Agent on OFM requests; browsers can't, so web downloads go without one (open; ask the operator if web downloads become common).
- **Maintainer:** unassigned.
- **Fallback/exit:** Self-host the weekly planet download, or use PMTiles.
- **Sources checked:** https://openfreemap.org/ , https://openfreemap.org/tos/

### 2. Esri ArcGIS Online — World Imagery (satellite basemap)
- **Used by:** `src/lib/hunt/tiles.ts:7`, `MapCanvas.tsx:504` (`fltile://`, cached), `HuntApp.tsx:699` (pre-fetch through `packTiles`).
- **Endpoint host:** `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`.
- **Status:** in use.
- **View:** Esri's FAQ for Esri-owned ArcGIS Online items (updated 2025-04-21) says the items may be used "in conjunction with Esri software or an ArcGIS Online subscription". It also says: "If you do not have Esri software, you must purchase an ArcGIS Online subscription."
- **Cache/offline:** Offline only through Esri Content Packages, used exclusively with Esri software. The item's licenseInfo says this layer is not intended for exporting tiles offline and points to "World Imagery (for Export)". The service reports `exportTilesAllowed: false`.
- **Bulk download:** Forbidden: "Systematically harvest basemap tiles through any method other than using Esri Content Packages".
- **Redistribution:** Forbidden: "Redistribute basemap tiles"; "Download, redistribute or self-host any content hosted by Esri."
- **Auth:** The tile endpoint answers without a key. Esri's terms tie use to Esri software or a subscription (see View).
- **Rate policy:** No public figure found (unverified).
- **Commercial terms:** The FAQ prohibits using Living Atlas content "for commercial use in your application or product" without licensing from Esri.
- **Attribution:** "Powered by Esri" plus data-provider attribution, both required by Esri developer docs (via search summary; the docs page did not render for direct fetch). The current service copyrightText is "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community". The app shows "Imagery © Esri, Maxar, Earthstar Geographics": Maxar is outdated, "GIS User Community" is missing, and "Powered by Esri" is missing.
- **Coverage:** Worldwide. 15 m TerraColor at small scales; 30 cm HD across the US (Vantor Vivid Standard). AK/HI are covered within the worldwide mosaic; local resolution was not verified.
- **Freshness:** No fixed cadence. The item says imagery is typically 3–5 years current.
- **Current app behavior vs terms:** Since 2026-10-14 (ADR-006) the app shows this layer live only: tiles are fetched directly, never written to Cache Storage, never pre-fetched, and tiles stored by older builds are deleted on startup. "Save this view offline" stores USGS imagery (entry 4a) instead. **Still open:** keyless use in a non-Esri client without a subscription; resolving that needs an Esri license (ArcGIS Location Platform account with API key) or switching the live layer too.
- **Maintainer:** unassigned.
- **Fallback/exit:** USGS imagery (NAIP, CONUS only) or USGS TNM imagery basemaps for an offline-permitted option. Otherwise a licensed ArcGIS Location Platform key with Esri's offline terms (not reviewed here).
- **Sources checked:** https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9?f=json , https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=pjson , https://goto.arcgis.com/termsofuse/viewsummary (redirects to https://www.esri.com/content/dam/arcgisonline/docs/tou_summary.pdf) , https://developers.arcgis.com/documentation/esri-and-data-attribution/ (did not render; content taken from search results)

### 3. Esri ArcGIS Online — World Hillshade, World Street Map, Reference/World_Transportation, Reference/World_Boundaries_and_Places
- **Used by:** `src/lib/hunt/tiles.ts:8, 10, 11, 12` (`TILES.hillshade`, `.street`, `.roads`, `.places`). No reference was found in `MapCanvas.tsx` sources or in `HuntApp.tsx` pre-fetch; they appear only in `tiles.test.ts`. The `packTiles` allowlist (`tiles.ts:117-119`) would still accept them.
- **Endpoint host:** `server.arcgisonline.com`.
- **Status:** defined, unused.
- **Terms:** The same Esri FAQ as entry 2 applies: Esri software or subscription required, no harvesting, no redistribution, no Living Atlas commercial use. World_Hillshade and World_Street_Map report `exportTilesAllowed: false`. World_Street_Map's documentInfo says "In mature support; no longer updated." The Transportation and Boundaries services were not fetched (unverified).
- **Attribution:** World_Street_Map copyrightText begins "Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan..." and includes OSM contributors. World_Hillshade credits Esri, USGS, NASA, FEMA and others.
- **Coverage:** Worldwide (per service metadata).
- **Maintainer:** unassigned.
- **Fallback/exit:** Remove from `TILES` or keep out of `packTiles`. OFM covers roads and places. Hillshade can be derived from the DEM.
- **Sources checked:** https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer?f=pjson , https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer?f=pjson

### 4. USGS The National Map — USGSTopo basemap tiles
- **Used by:** `tiles.ts:9`, `MapCanvas.tsx:505` (cached), `HuntApp.tsx:698` (pre-fetch).
- **Endpoint host:** `basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}`.
- **Status:** in use.
- **View:** Public domain, with "no restrictions" on use (USGS FAQ). The TNM HowTo says integration into your own applications is encouraged (via search summary).
- **Cache/offline:** No explicit statement found. The service reports `exportTilesAllowed: true` with `maxExportTilesCount: 100000`.
- **Bulk download:** Not restricted in the terms found. Courtesy limits are unverified.
- **Redistribution:** Public domain.
- **Auth:** None.
- **Rate policy:** None published (unverified).
- **Commercial terms:** None (public domain).
- **Attribution:** Requested credit line: "Map services and data available from U.S. Geological Survey, National Geospatial Program." The app shows "Topo © USGS", which does not match the requested wording and is not a copyright claim.
- **Coverage:** United States and territories (TNM help, via search summary). Explicit AK/HI coverage of this service was not stated in its metadata (unverified).
- **Freshness:** copyrightText reads "Data refreshed September 4, 2026-v1.2". No stated cadence.
- **Current app behavior vs terms:** No conflict found.
- **Maintainer:** unassigned.
- **Fallback/exit:** Other TNM basemaps (USGSImageryOnly verified, entry 4a), or self-built tiles from TNM downloads.
- **Sources checked:** https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer?f=pjson , https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map , https://apps.nationalmap.gov/help/HowTo.htm (search summary only)

### 4a. USGS The National Map — USGSImageryOnly basemap tiles
- **Used by:** `tiles.ts` (`TILES.imagery`, in `OFFLINE_TEMPLATES`), `MapCanvas.tsx` (`usgs` source, cached through `fltile://`), "Save this view offline" for every imagery base map.
- **Endpoint host:** `basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`.
- **Status:** in use (added 2026-10-14).
- **View / cache / redistribution:** USGS public domain ("no restrictions", same FAQ as entry 4). Service metadata checked 2026-10-14: `exportTilesAllowed: true`, `maxExportTilesCount: 100000`.
- **Attribution:** copyrightText "USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024.v1.2". The app shows "Imagery: USGS The National Map, USDA".
- **Coverage:** US orthoimagery (6 in–1 m) with Blue Marble outside the US (service description). Visible to 1:9,028 (about zoom 16); the app caps the source at zoom 16 and does not upscale beyond it. AK/HI imagery resolution not verified.
- **Freshness:** "Data refreshed June, 2024".
- **Maintainer:** unassigned.
- **Sources checked:** https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=pjson

### 5. BLM Surface Management Agency (SMA) — tiles and identify
- **Used by:**
  - Tiles: `tiles.ts:13`, `MapCanvas.tsx:506` (cached), `HuntApp.tsx:700` (pre-fetch).
  - Identify: `src/lib/hunt/land.ts:153` (`/MapServer/identify`; line 98 at baseline).
- **Endpoint host:** `gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer`.
- **Status:** in use.
- **View/use limits (layer 1 metadata):** "neither legal documents nor land surveys". "The BLM should be cited as the data source". Do not misrepresent the data or imply BLM endorsement.
- **Cache/offline:** `exportTilesAllowed: true`, `maxExportTilesCount: 100000`.
- **Bulk download:** Not restricted in the metadata found.
- **Redistribution:** Not stated for this service. Data.gov lists related BLM SMA datasets as `us-pd` (search summary). Search results also reported an "INTERNAL USE ONLY ... considered public domain" use-limit note in a *different* BLM SMA service (`BLM_Natl_SMA_Cached_BLM_Only`). That service was not checked directly. Treat redistribution as unverified.
- **Auth:** None.
- **Rate policy:** None published (unverified).
- **Commercial terms:** None stated.
- **Attribution:** Cite BLM. copyrightText is "BLM Energy, Minerals & Realty Management, Headquarters (HQ)". The app shows "Public land © BLM".
- **Coverage:** Service description: CONUS, Alaska, Hawaii, Puerto Rico, Guam, American Samoa, USVI. AK/HI are covered. Layers 4–5 are Alaska Native lands.
- **Freshness:** "may be updated by the BLM without notification". Layer metadata creation date is 2023-02-08. No cadence stated.
- **Current app behavior vs terms:** No conflict found.
- **Maintainer:** unassigned.
- **Fallback/exit:** PAD-US (entry 13) for management context. Downloadable state SMA datasets.
- **Sources checked:** https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer?f=pjson , https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/1/metadata , https://catalog.data.gov/dataset/blm-nv-surface-management-agency-sma (search summary only)

### 6. Arizona Game & Fish Department — Hunt Units (GMU) feature service
- **Used by:** `src/features/catalog/adapters/azgfd.ts` (since CC-03). Metadata, `returnCountOnly`, paginated GeoJSON, and point identify through `adapters/arcgis.ts`; validated copy in Cache Storage `fieldline-units-v3` with a 30-day refresh policy and quarantine of empty/truncated/shrunken updates (`unit-store.ts`). Live check 2026-10-13: 80 features (filter `GMU NOT IN ('N/A',' ')`) → 77 units.
- **Endpoint host:** `services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0`. This is ArcGIS Online hosting; item `7c8d66aa4f3e4e62b243f1216734a581`.
- **Status:** in use.
- **View:** The item licenseInfo says the data are for reference only, and that legal GMU descriptions are in Commission Rule R12-4-108.
- **Cache/offline, bulk download, redistribution:** No license or terms stated (unverified). The `TERMS_COND` attribute is null.
- **Auth:** None (public service).
- **Rate policy:** `maxRecordCount` 2000. No published rate limit.
- **Commercial terms:** Not stated (unverified).
- **Attribution:** "GIS Program, Habitat Branch, Wildlife Management Division, Arizona Game and Fish Department". The app names "Arizona Game and Fish" in its info text (`HuntApp.tsx:1514`) but not in map attribution.
- **Coverage:** Arizona only.
- **Freshness:** lastEditDate / dataLastEditDate is epoch 1588084347257 (2020-04-28). The GMU description says boundaries were finalized in 2011 and edited in 2013.
- **Maintainer:** unassigned.
- **Fallback/exit:** The last cached copy. The official regulations at azgfd.com.
- **Sources checked:** https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0?f=pjson , https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer?f=pjson , https://www.arcgis.com/sharing/rest/content/items/7c8d66aa4f3e4e62b243f1216734a581?f=json

### 7. Idaho Fish & Game — Hunting MapServer, layer 3 "Game Units"
- **Used by:** `src/features/catalog/adapters/idfg.ts` (since CC-03), same validated pipeline as entry 6. Live check 2026-10-13: 100 features → 100 units.
- **Endpoint host:** `gisportal-idfg.idaho.gov/hosting/rest/services/Hunting/MapServer/3`.
- **Status:** in use.
- **License:** copyrightText read "CC-BY Idaho Fish and Game" on 2026-10-13, but the live layer read only "Idaho Fish and Game" on 2026-10-14. Until IDFG confirms the license, the adapter records download/redistribution as "unknown" (no offline packaging of these units). No separate terms page was found.
- **Cache/offline:** `exportTilesAllowed: false`. That flag concerns tile export; the app downloads features, which CC BY permits.
- **Auth:** None.
- **Rate policy:** `maxRecordCount` 2000. No published rate limit.
- **Commercial terms:** CC BY (permits commercial use with attribution).
- **Attribution:** "Idaho Fish and Game" (CC BY). The app mentions it in info text (`HuntApp.tsx:1467, 1514`) but not in map attribution, and gives no license link.
- **Coverage:** Idaho only.
- **Freshness:** Not stated (unverified).
- **Other layers in this service, not used:** elk and wolf zones, controlled hunts, closures, AccessYes!.
- **Maintainer:** unassigned.
- **Fallback/exit:** The last cached copy. IDFG regulations.
- **Sources checked:** https://gisportal-idfg.idaho.gov/hosting/rest/services/Hunting/MapServer?f=pjson

### 7a. Montana Fish, Wildlife & Parks — huntingDistricts MapServer, layer 11 "Deer Elk Lion Hunting Districts"
- **Used by:** `src/features/catalog/adapters/mtfwp.ts` (added in CC-03 through the adapter kit, with no app-shell change), same validated pipeline as entry 6. Labels read "Hunting District <n>".
- **Endpoint host:** `fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer/11`.
- **Status:** in use (since 2026-10-14).
- **Layer:** "This layer depicts the current deer-elk-lion hunting districts." Fields DISTRICT, REG, REGYEAR, AREA_MI and others. maxRecordCount 2000; JSON, geoJSON, PBF. No edit date published, so each 30-day refresh downloads the full set. Live check 2026-10-14: 139 features → 139 districts, regulation year 2026, every label point inside its district.
- **License / terms:** copyrightText "Montana Fish, Wildlife & Parks"; the license field is empty and the layer metadata states no use limits. Download and redistribution: **unknown**. FWP metadata elsewhere disclaims accuracy and completeness.
- **Attribution:** "Montana Fish, Wildlife & Parks".
- **Coverage:** Montana only. Only deer, elk and mountain lion districts; other species' districts in the same service (antelope, moose, sheep, goat, bear, wolf, birds, furbearers) are not included.
- **Maintainer:** unassigned.
- **Fallback/exit:** The last validated copy; FWP's district PDFs and regulations at fwp.mt.gov.
- **Sources checked:** https://fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer?f=pjson , https://fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer/11?f=pjson

### 8. Open-Meteo — Forecast API and Elevation API
- **Used by:**
  - Forecast: `src/lib/hunt/weather.ts:346` (primary weather; fallback to NWS at `weather.ts:577-586`).
  - Elevation: `weather.ts:241` (primary slope/elevation, 3 points per call; fallback to EPQS).
  - Server-side through `weather.functions.ts`.
- **Endpoint host:** `api.open-meteo.com` (`/v1/forecast`, `/v1/elevation`).
- **Status:** in use.
- **View:** The free API is "non-commercial" only. The terms count apps "that do not have subscriptions or advertising" as non-commercial, and apps with "subscriptions or display advertisements" as commercial. Integration into commercial products is commercial use.
- **Cache/offline:** Not addressed in the terms or licence pages (unverified).
- **Bulk download:** Not addressed.
- **Redistribution:** Data is CC BY 4.0: copying and redistribution are allowed with attribution.
- **Auth:** None for the free tier. Paid tiers use an API key and the `customer-` host prefix.
- **Rate policy (free tier):**
  - Under 10,000 calls/day, 5,000/hour, 600/minute, and 300,000/month.
  - May "block applications and IP addresses that misuse our service".
  - The spec (§13) notes that limits must not be evaded by distributing requests across clients.
- **Commercial terms:** A paid plan (Standard / Professional / Enterprise) is required for commercial use.
- **Attribution:**
  - Forecast: "You must include a link next to any location Open-Meteo data are displayed", for example "Weather data by Open-Meteo.com", plus a CC BY licence link.
  - Elevation: credit the Copernicus programme (Copernicus DEM GLO-90, DOI 10.5270/ESA-c5d3d65) and reference Open-Meteo.
  - The app has no linked attribution. It names Open-Meteo only in help text (`HuntApp.tsx:1566`).
- **Coverage:** Forecast "best match" is worldwide; HRRR, NBM and NAM are CONUS models, and AK/HI model selection is not stated. Elevation is worldwide at 90 m (Copernicus GLO-90). AK/HI are covered.
- **Freshness:** Per model, e.g. GFS/HRRR hourly, ICON 3-hourly, ECMWF/GEM 6-hourly.
- **Maintainer:** unassigned.
- **Fallback/exit:** NWS (in place for forecasts), EPQS (in place for elevation), a paid Open-Meteo plan, or self-hosting (AGPLv3 code).
- **Sources checked:** https://open-meteo.com/en/terms , https://open-meteo.com/en/licence , https://open-meteo.com/en/docs/elevation-api , https://open-meteo.com/en/docs

### 9. NOAA / NWS API — api.weather.gov (points, forecast, hourly forecast)
- **Used by:** `weather.ts:543` (`/points/{lat},{lng}`), `:558` (origin check), followed by forecast and forecastHourly URLs. This is the fallback when Open-Meteo fails. Headers are set at `weather.ts` `NWS_HEADERS`: User-Agent "Fieldline/1.0 (hunting map)".
- **Endpoint host:** `api.weather.gov`.
- **Status:** in use (fallback).
- **View/redistribution:** "open and free to use for any purpose". No named licence on the page.
- **Cache/offline:** The API is cache-friendly. The grid mapping from `/points` may be cached, but should be re-checked periodically because office or grid "may occasionally change".
- **Bulk download:** Not addressed. Archives are at NCEI.
- **Auth:** A User-Agent is required. Contact info is recommended. The docs say the UA "will be replaced with an API key in the future". The app's UA has no contact.
- **Rate policy:** Not public. On exceeding it, retry "typically within 5 seconds". Proxies hit the limit more often, which applies to Fieldline's server-side calls.
- **Commercial terms:** None.
- **Attribution:** None required in the docs found. The app records provider in `source`.
- **Coverage:** Verified 2026-10-13 by live `/points` calls. Anchorage returns `gridId` AER and `America/Anchorage`. Honolulu returns `gridId` HFO and `Pacific/Honolulu`. AK and HI are covered. Territories were not tested.
- **Freshness:** Per product. Observations may lag up to 20 min. Docs page updated 2026-03-24.
- **Maintainer:** unassigned.
- **Fallback/exit:** Open-Meteo.
- **Sources checked:** https://www.weather.gov/documentation/services-web-api , https://api.weather.gov/points/61.2181,-149.9003 , https://api.weather.gov/points/21.3069,-157.8583

### 10. USGS Elevation Point Query Service (EPQS)
- **Used by:** `weather.ts:223` (`/v1/json?x=&y=&units=Meters&wkid=4326`). Fallback when Open-Meteo elevation fails; 3 calls per lookup.
- **Endpoint host:** `epqs.nationalmap.gov`.
- **Status:** in use (fallback).
- **Terms:** USGS TNM services are public domain with "no restrictions" (same FAQ as entry 4). The EPQS-specific docs (`/v1/docs`, `/v1/openapi.json`) returned an empty page or HTTP 403, so rate limits, data source and coverage are **unverified**.
- **Cache/offline, redistribution:** Public domain (TNM FAQ).
- **Auth:** None observed.
- **Rate policy:** Unverified.
- **Attribution:** The USGS NGP credit line (entry 4).
- **Coverage:** Third-party documentation (elevatr) calls it US-only. 3DEP 1/3 arc-second covers CONUS, AK, HI and territories (USGS 3DEP page), but EPQS's exact source mix is unverified.
- **Maintainer:** unassigned.
- **Fallback/exit:** Open-Meteo elevation, or DEM tiles.
- **Sources checked:** https://epqs.nationalmap.gov/v1/docs (no content) , https://epqs.nationalmap.gov/v1/openapi.json (403) , https://www.usgs.gov/3d-elevation-program/about-3dep-products-services , https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map

### 11. Nominatim (OSM Foundation public instance)
- **Used by:** `src/lib/hunt/search-core.ts:112-129` (`/search`, `countrycodes=us`, viewbox; in-process throttle of 1 request per 1 s at `:21, :104-110`; UA "Fieldline/1.0 (+https://github.com/Chris86002/Fieldline)" at `:124`). Called server-side when the user submits a search (`HuntApp.tsx:648-656`), not as autocomplete.
- **Endpoint host:** `nominatim.openstreetmap.org`.
- **Status:** in use (primary geocoder).
- **Rate policy:** "an absolute maximum of 1 request per second". Limits apply per app/website. Bulk jobs: 4 requests per minute.
- **Caching:** Results should be cached and proxied. The app caches for 60 s in memory only.
- **Prohibited:** Autocomplete, systematic or grid queries, distributed bulk across machines, reselling.
- **Auth:** None. An identifying UA or Referer is required; library defaults are rejected.
- **App requirement:** Apps must be able to switch off the service at OSMF's request "without a software update".
- **Commercial terms:** No fee. Reselling results is prohibited. OSMF may withdraw access.
- **Attribution/licence:** "as suitable for your medium". The data is ODbL (share-alike). The app shows OSM attribution on the map, but not in the search results UI (not verified in UI).
- **Coverage:** Global OSM. The app restricts results to `us`. AK/HI are included in OSM.
- **Current app behavior vs terms:** **CONFLICT** with the remote-disable requirement: the endpoint is hard-coded and there is no remote kill switch. Multiple desktop installs each enforce 1 req/s locally, but the per-app limit is shared.
- **Maintainer:** unassigned.
- **Fallback/exit:** Photon (in place), self-hosted Nominatim, or a local search index for offline packages (§8).
- **Sources checked:** https://operations.osmfoundation.org/policies/nominatim/

### 12. Photon (komoot public instance)
- **Used by:** `search-core.ts:132-145` (`/api/?q=&limit=6&lat=&lon=`). Fallback when Nominatim fails or returns nothing. No custom User-Agent is set.
- **Endpoint host:** `photon.komoot.io`.
- **Status:** in use (fallback).
- **Terms:** The page asks users to "be fair"; "extensive usage will be throttled". Availability is not guaranteed and terms "might be subject of change".
- **Not stated:** commercial use, attribution, caching and numeric limits (all unverified).
- **Data:** OSM (ODbL).
- **Auth:** None.
- **Coverage:** Global OSM.
- **Maintainer:** unassigned.
- **Fallback/exit:** Self-hosted Photon (open source: github.com/komoot/photon).
- **Sources checked:** https://photon.komoot.io/

### 13. AWS Open Data — Terrain Tiles (Mapzen/Tilezen "joerd", Terrarium PNG)
- **Used by:** `src/routes/api/dem/$z/$x/$y.ts:20` (server proxy, z ≤ 14, `Cache-Control` 7 days), `MapCanvas.tsx:491, 508` (raster-dem, terrarium encoding).
- **Endpoint host:** `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (bucket `elevation-tiles-prod`, us-east-1; EU replica `elevation-tiles-prod-eu`).
- **Status:** in use (3D terrain).
- **View/cache/redistribution:** Open-data bucket; no AWS account is needed. Each source dataset has its own licence: 3DEP and SRTM are public domain; GMTED has no restrictions; ETOPO1 is not copyrighted in the US; ArcticDEM and others are per their own terms.
- **Bulk download:** Permitted by open-bucket design. No AWS-stated limit found.
- **Auth:** None.
- **Rate policy:** None published (unverified).
- **Attribution:** The joerd attribution doc requires per-source credit, e.g. "3DEP data courtesy of the U.S. Geological Survey", SRTM and GMTED2010 lines, and ArcticDEM where used. The app shows "Terrain © AWS Terrain Tiles", which does not match the required credits.
- **Coverage:** Global.
  - US: 3DEP "10 meters outside of Alaska, 3 meter in select" areas.
  - Alaska: ArcticDEM (z10–15 above 60°N).
  - Hawaii: not named in the data-sources doc. Only global sources (SRTM/GMTED) are implied, so HI resolution is unverified.
- **Freshness:** v1.1 was built in 2017 Q3. "Regular updates are not planned."
- **Maintainer:** unassigned. The registry lists Mapzen (Linux Foundation project) as manager.
- **Fallback/exit:** Build terrain-RGB tiles from USGS 3DEP; use Copernicus DEM.
- **Sources checked:** https://registry.opendata.aws/terrain-tiles/ , https://github.com/tilezen/joerd/blob/master/docs/attribution.md , https://github.com/tilezen/joerd/blob/master/docs/data-sources.md

---

## Candidates (not integrated)

### 14. USGS PAD-US (Protected Areas Database of the U.S.)
- **Status:** candidate.
- **Version:** PAD-US 4.1 is listed as the latest (download page). The citation is the 2024 data release, DOI 10.5066/P96WBCHS.
- **Bulk download:** National geodatabase; state and territory extracts in GDB and KMZ (56 areas); analysis rasters/vectors. The USGS calls PAD-US public domain (search summary; the download page itself states no licence).
- **Services:** ArcGIS Online feature-layer views owned by USGS, listed on the PAD-US web services page. Example: "PAD-US Public Access" item `c91a5655a1be428daeb778888e60db24`, URL `https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS_Public_Access/FeatureServer`, item modified 2026-07-30.
  - Feature layers have a minimum visible scale of about 1:500,000. Vector tile layers also exist.
  - A MapServer at `edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer` appeared in search. Its host name suggests staging, so it is unverified.
- **Use caveats:**
  - Public Access values are "largely assigned by" designation type and "not all areas have been locally reviewed".
  - Agencies are the official source.
  - Comparing versions to infer change is discouraged.
  - Spec §6 says PAD-US is not ownership or hunting permission.
- **Terms:** The item licenseInfo is a no-warranty statement and links to the PAD-US data overview.
- **Coverage:** United States and territories (item snippet). AK/HI are included per the 56 state/territory extracts.
- **Maintainer:** unassigned.
- **Sources checked:** https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download , https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-web-services , https://www.arcgis.com/sharing/rest/content/items/c91a5655a1be428daeb778888e60db24?f=json

### 15. USGS NAIP imagery (The National Map ImageServer)
- **Status:** candidate.
- **Endpoint:** `imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer`. The first `?f=pjson` fetch returned HTTP 502; `?f=json` succeeded.
- **Service metadata:**
  - Capabilities: Image, Metadata, Catalog, Mensuration.
  - Copyright: "USGS, USDA, The National Map: Orthoimagery. January 09, 2025".
  - `exportTilesAllowed: false`. No tile cache (tileInfo) was seen.
  - Max image size 4000×4000. Mosaic is sorted by Year.
  - Source is USDA FSA NAIP, primarily 0.6 m, 4-band. CIR and NDVI raster functions are available.
- **Offline:** Not a tile cache. Offline use would mean `exportImage` requests or the free JP2 downloads through the TNM Downloader. Bulk-request etiquette is unverified.
- **Terms:** USGS TNM public domain (entry 4 FAQ).
- **Coverage:** Conterminous U.S. only per the description. The full extent is roughly 124.8°W–66.9°W and 24.5°N–49.5°N in Web Mercator. **AK/HI are not covered.**
- **Freshness:** NAIP cycles are per state (not verified here).
- **Maintainer:** unassigned.
- **Sources checked:** https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer?f=json

### 16. NWS / NOAA conventional radar map services
- **Status:** candidate.
- **mapservices.weather.noaa.gov:** exists today. `/eventdriven/rest/services/radar` lists `radar_base_reflectivity` (MapServer) and `radar_base_reflectivity_time` (ImageServer).
  - MapServer: MRMS-derived 1 km QC'd base reflectivity mosaic ("RIDGE 1x1 km Base Reflectivity").
  - Coverage: "Continental United States, Canada, Alaska, The Caribbean, Guam, and Hawaii".
  - Update: the metadata conflicts between every 5 and every 10 minutes.
  - Not time enabled (the `_time` ImageServer is the time-enabled variant; not inspected).
  - `exportTilesAllowed: false`. KML and WMS extensions are available. Contact nws.mapservices@noaa.gov.
- **opengeo.ncep.noaa.gov GeoServer:** exists.
  - WMS composites for `conus`, `alaska`, `hawaii`, `carib` and `guam`: BREF QCD, CREF QCD, NEET V18, PCPN TYP.
  - Per-site NEXRAD and TDWR WMS layers.
  - WFS/WMS hazards and warnings layers.
  - No WMTS. Update frequency and usage limits are not stated.
- **Terms:** No formal terms beyond NOAA copyright text. NWS data is generally "open and free to use for any purpose" (NWS API page).
- **Caveats:** These are styled images, not numeric intensity (spec §10 C). The IDP-GIS sunset notice SCN23-01 exists but was not read.
- **Maintainer:** unassigned.
- **Sources checked:** https://www.weather.gov/gis/ , https://www.weather.gov/gis/cloudgiswebservices , https://opengeo.ncep.noaa.gov/geoserver/www/index.html , https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar?f=pjson , https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer?f=pjson

### 17. NWS alerts API
- **Status:** candidate.
- **Endpoint:** `api.weather.gov/alerts/active`. Filters include `?area=` (state) and `?point=lat,lon`.
  - `/alerts/active` internally redirects to `/alerts?active=true`. `/alerts` keeps 7 days; the archive is at NCEI.
  - Tornado Watch alerts lack SPC SEL text.
- **Auth and rate policy:** Same as entry 9: User-Agent required, rate limit not public.
- **Coverage:** Live check of `?point=61.2181,-149.9003` (Anchorage) returned a valid FeatureCollection (0 features at check time). Hawaii was not tested separately.
- **Alert polygons:** Also available as OGC layers on opengeo (entry 16).
- **Maintainer:** unassigned.
- **Sources checked:** https://www.weather.gov/documentation/services-web-api , https://api.weather.gov/alerts/active?point=61.2181,-149.9003

### 18. NOAA MRMS (Multi-Radar/Multi-Sensor) quantitative products
- **Status:** candidate.
- **Format:** GRIB2, gzip-compressed (`*.grib2.gz`), e.g. `CONUS/PrecipRate_00.00/20261010/MRMS_PrecipRate_00.00_20261010-000000.grib2.gz`. A 2-minute cycle was observed in object timestamps. The registry says real-time on a 2-minute cycle.
- **Access:**
  - AWS NODD bucket `noaa-mrms-pds` (us-east-1), no account needed. Top-level prefixes: ALASKA, ANC, CARIB, CONUS, CONUS_5KM, ConvectProb, GUAM, HAWAII, ProbSevere, unsupported.
  - NCEP `mrms.ncep.noaa.gov/2D/`. Its ALASKA, HAWAII, CARIB and GUAM directory listings show a last-modified date of 24-Feb-2021, while CONUS products show 14-Oct-2026. The meaning of that is unverified.
  - NSSL project page: TLS certificate error on fetch (unverified).
- **AK/HI:** Not CONUS-only on AWS. `ALASKA/PrecipRate_00.00` and `HAWAII/PrecipRate_00.00` both had objects dated 2026-10-10. The per-domain product set differs, e.g. ALASKA lists BREF/CREF/EchoTop/FLASH/GaugeInflIndex products.
- **Licence (NODD):** Open for any use. NOAA requests attribution for unaltered data. Do not imply NOAA endorsement, and do not present modified data as original.
- **Spec fit:** A numeric product for §10 C/D. It needs a decode, subset and tiling pipeline (§10 F).
- **Maintainer:** unassigned.
- **Sources checked:** https://registry.opendata.aws/noaa-mrms-pds/ , https://noaa-mrms-pds.s3.amazonaws.com/?delimiter=/ , https://noaa-mrms-pds.s3.amazonaws.com/?prefix=ALASKA/&delimiter=/ , https://mrms.ncep.noaa.gov/ , https://mrms.ncep.noaa.gov/2D/ , https://www.nssl.noaa.gov/projects/mrms/ (TLS error)

### 19. OpenStreetMap standard tile service (tile.openstreetmap.org) — policy reference only
- **Status:** not used and not a candidate. Recorded because spec §8 forbids using it for bulk prefetch.
- **Policy:**
  - Bulk downloading, "any pre-emptive fetching of tiles other than those a user is actively viewing", is prohibited, including offline "download area" features.
  - Honour cache headers ("Do not bypass caches"), or keep tiles at least 7 days.
  - Use a distinct UA (no library default) and a valid Referer.
  - Show visible OSM attribution.
  - No SLA. Heavy use is blocked.
- **Sources checked:** https://operations.osmfoundation.org/policies/tiles/

---

## Risks and open questions

1. **Esri World Imagery.** Caching and pre-fetch were removed on 2026-10-14 (ADR-006); offline imagery now comes from USGS. Still open: Esri ties use to Esri software or a subscription, and Fieldline shows the tiles keyless in MapLibre. Options: an ArcGIS Location Platform account and API key (see ADR-006), or replacing the live layer.
2. ~~Esri attribution out of date~~ — fixed 2026-10-14 ("Powered by Esri · Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community").
3. ~~Unused Esri templates in the `packTiles` allowlist~~ — removed 2026-10-14; `packTiles` now accepts only `OFFLINE_TEMPLATES` (USGS imagery, USGS topo, BLM SMA).
4. **Open-Meteo is non-commercial only.** A free app with ads or subscriptions counts as commercial under its terms. A hosted web deployment would pool every user under one server IP against 10k calls/day. The app does not show the required linked "Weather data by Open-Meteo.com" attribution or the Copernicus credit for elevation.
5. **Nominatim:** the policy requires that the app can be switched off at OSMF's request without a software update. The URL is hard-coded and there is no remote kill switch. The 60 s in-memory cache is minimal. The per-app 1 req/s limit is shared across all installs.
6. **Photon** has undefined limits and no custom User-Agent. Commercial and attribution terms are not stated.
7. **NWS User-Agent** lacks the recommended contact information. NWS says UA identification "will be replaced with an API key in the future".
8. **AWS Terrain Tiles:** the attribution does not match joerd's required per-source credits. The data is frozen (v1.1, 2017) with "regular updates are not planned". Hawaii resolution is unverified.
9. **AZGFD hunt units:** no licence is stated, and the data was last edited in 2020. Redistributing it in offline packages needs confirmation from AZGFD.
10. **BLM SMA redistribution** is unverified for the exact service used. Another BLM SMA service reportedly carries "INTERNAL USE ONLY" wording in its use limits.
11. **Coverage gaps for the nationwide goal:**
    - NAIP is CONUS-only.
    - AZGFD and IDFG are single-state.
    - USGS Topo's AK/HI coverage is not stated in its metadata.
    - Open-Meteo's high-resolution US models are CONUS.
    - MRMS AK/HI products exist on AWS, but their product sets differ from CONUS.
12. **Unverified:**
    - EPQS docs (empty page / HTTP 403), so its limits and coverage.
    - NSSL MRMS page (TLS error).
    - Esri developer attribution page (did not render).
    - Rate limits for every ArcGIS-hosted service.
    - The `edits.nationalmap.gov` PAD-US MapServer.
13. **REL-04 fields not yet tracked:** refresh cadence, last fetch, last successful validation, expiry policy and failure escalation. No adapter records them today.
