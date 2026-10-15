/**
 * Coverage register: what Fieldline actually holds for each of the 50 states
 * and the District of Columbia, layer by layer. Territories are not listed;
 * add them here through the same shape when a source is verified.
 *
 * Keep this honest. "available" means a provider integrated in Fieldline
 * covers the jurisdiction (see docs/data-sources.md); everything else is
 * "unavailable" with a plain note. docs/coverage.md mirrors this table.
 *
 * Bounds: per-state envelopes from the US Census Bureau TIGERweb
 * State_County MapServer, layer 0 "States"
 * (https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0),
 * queried 2026-10-13 with returnExtentOnly=true&outSR=4326 per STUSAB, then
 * rounded outward to 2 decimals. Extents include each state's water area, so
 * coastal and Great Lakes boxes reach offshore. Alaska's envelope spans the
 * globe because the Aleutians cross 180°, so its two boxes were measured from
 * the polygon rings (outSR=4326) east and west of the antimeridian. Boxes are
 * for discovery only: neighbors overlap, and a box is not a boundary.
 *
 * Agencies: each URL returned HTTP 200 after redirects on 2026-10-13 and is
 * the agency's own site. Nebraska and Rhode Island answered every automated
 * request with a bot-check page (HTTP 403), so they are null until someone
 * verifies them by hand. Arizona's site also answers automated requests with
 * a bot check; the coordinator confirmed by hand on 2026-10-14 that
 * azgfd.com is the agency's domain (already used as the AZGFD adapter's
 * sourceUrl). New Jersey answered 200 but with a bot-check
 * page; its URL is where the agency's old domain (njfishandwildlife.com)
 * redirects.
 *
 * BLM SMA in DC: spot-checked 2026-10-13; identify at the National Mall
 * returns the National Park Service.
 */
import type {
  Bounds,
  JurisdictionCoverage,
  JurisdictionId,
  LayerCategory,
  LayerCoverage,
} from "@/features/catalog/types";

/** Every layer category, in display order. */
export const LAYER_CATEGORIES: readonly LayerCategory[] = [
  "land-management",
  "hunt-units",
  "parcels",
  "access",
  "legal-hours",
];

/** Hunt-unit providers integrated today, by jurisdiction. */
const HUNT_UNIT_PROVIDERS: Partial<Record<JurisdictionId, { providerId: string; note: string }>> = {
  "us-az": {
    providerId: "azgfd-gmu",
    note: "Arizona Game and Fish hunt units. Reference lines, not the legal description.",
  },
  "us-co": {
    providerId: "cpw-gmu",
    note: "Colorado Parks and Wildlife big-game game management units; bighorn sheep and mountain goat units are not included. Reference boundaries; check the current Colorado big-game brochure and GMU descriptions.",
  },
  "us-id": {
    providerId: "idfg-gmu",
    note: "Idaho Fish and Game game management units. Reference lines, not the legal description.",
  },
  "us-mt": {
    providerId: "mtfwp-deer-elk-lion",
    note: "Montana Fish, Wildlife & Parks deer, elk and mountain lion hunting districts only; districts for other species (antelope, moose, sheep, goat, bear, birds) are not included. Reference boundaries; check current Montana regulations and district descriptions.",
  },
  "us-nm": {
    providerId: "nmdgf-gmu",
    note: "New Mexico Department of Wildlife big-game game management units, including lettered sub-units (e.g. 16D); elk management zones and other special hunt areas are not included. Reference boundaries, not the legal description; check the current New Mexico hunting rules.",
  },
  "us-ut": {
    providerId: "udwr-deer-general",
    note: "Utah Division of Wildlife Resources general-season buck deer hunt units only; elk, limited-entry, once-in-a-lifetime, pronghorn and antlerless boundaries are not included, and limited-entry-only areas show no unit. Reference boundaries; check the Utah Big Game Guidebook boundary descriptions.",
  },
  "us-wy": {
    providerId: "wgfd-elk-areas",
    note: "Wyoming Game and Fish Department elk hunt areas only; deer, pronghorn, moose, bighorn sheep, mountain goat, bison and other species' hunt areas are not included. Reference boundaries at 1:100,000 scale; check the current Wyoming elk regulations' hunt area descriptions.",
  },
};

const LAND_MANAGEMENT: LayerCoverage = {
  status: "available",
  providerIds: ["blm-sma"],
  note: "BLM surface management map. Shows which agency manages the land, not parcel ownership or permission to hunt or enter.",
};

const NO_HUNT_UNITS: LayerCoverage = {
  status: "unavailable",
  providerIds: [],
  note: "No hunt-unit source in Fieldline yet. Use the state wildlife agency's maps.",
};

const NO_PARCELS: LayerCoverage = {
  status: "unavailable",
  providerIds: [],
  note: "No parcel or owner source in Fieldline yet. A blank map does not mean public or private land.",
};

const NO_ACCESS: LayerCoverage = {
  status: "unavailable",
  providerIds: [],
  note: "No access, closure or road-status source in Fieldline yet. Check with the land manager.",
};

const NO_LEGAL_HOURS: LayerCoverage = {
  status: "unavailable",
  providerIds: [],
  note: "Fieldline doesn't hold verified legal shooting-hour rules; check the agency. Sunrise and sunset are shown as daylight only.",
};

function jurisdiction(
  usps: string,
  name: string,
  bounds: Bounds[],
  agencyName: string | null,
  agencyUrl: string | null,
): JurisdictionCoverage {
  const id: JurisdictionId = `us-${usps.toLowerCase()}`;
  const units = HUNT_UNIT_PROVIDERS[id];
  return {
    id,
    name,
    usps,
    bounds,
    layers: {
      "land-management": { ...LAND_MANAGEMENT, providerIds: [...LAND_MANAGEMENT.providerIds] },
      "hunt-units": units
        ? { status: "available", providerIds: [units.providerId], note: units.note }
        : { ...NO_HUNT_UNITS, providerIds: [] },
      parcels: { ...NO_PARCELS, providerIds: [] },
      access: { ...NO_ACCESS, providerIds: [] },
      "legal-hours": { ...NO_LEGAL_HOURS, providerIds: [] },
    },
    agencyName,
    agencyUrl,
  };
}

/** The 50 states and DC, ordered by name. */
export const JURISDICTIONS: readonly JurisdictionCoverage[] = [
  jurisdiction("AL", "Alabama", [{ west: -88.48, south: 30.14, east: -84.88, north: 35.01 }], "Alabama Department of Conservation and Natural Resources", "https://www.outdooralabama.com/"),
  jurisdiction(
    "AK",
    "Alaska",
    [
      // Near and Rat Islands, west of 180° (positive longitudes).
      { west: 172.34, south: 51.29, east: 179.86, north: 53.07 },
      // The rest of the state, east of 180°.
      { west: -179.24, south: 51.17, east: -129.97, north: 71.44 },
    ],
    "Alaska Department of Fish and Game",
    "https://www.adfg.alaska.gov/",
  ),
  jurisdiction("AZ", "Arizona", [{ west: -114.82, south: 31.33, east: -109.04, north: 37.01 }], "Arizona Game and Fish Department", "https://www.azgfd.com/"),
  jurisdiction("AR", "Arkansas", [{ west: -94.62, south: 33.0, east: -89.64, north: 36.5 }], "Arkansas Game and Fish Commission", "https://www.agfc.com/"),
  jurisdiction("CA", "California", [{ west: -124.49, south: 32.52, east: -114.13, north: 42.01 }], "California Department of Fish and Wildlife", "https://wildlife.ca.gov/"),
  jurisdiction("CO", "Colorado", [{ west: -109.07, south: 36.99, east: -102.04, north: 41.01 }], "Colorado Parks and Wildlife", "https://cpw.state.co.us/"),
  jurisdiction("CT", "Connecticut", [{ west: -73.73, south: 40.95, east: -71.78, north: 42.06 }], "Connecticut Department of Energy and Environmental Protection", "https://portal.ct.gov/deep"),
  jurisdiction("DE", "Delaware", [{ west: -75.79, south: 38.45, east: -74.98, north: 39.84 }], "Delaware Division of Fish and Wildlife", "https://dnrec.delaware.gov/fish-wildlife/"),
  jurisdiction("DC", "District of Columbia", [{ west: -77.12, south: 38.79, east: -76.9, north: 39.0 }], "District of Columbia Department of Energy and Environment", "https://doee.dc.gov/"),
  jurisdiction("FL", "Florida", [{ west: -87.64, south: 24.39, east: -79.97, north: 31.01 }], "Florida Fish and Wildlife Conservation Commission", "https://myfwc.com/"),
  jurisdiction("GA", "Georgia", [{ west: -85.61, south: 30.35, east: -80.78, north: 35.01 }], "Georgia Department of Natural Resources, Wildlife Resources Division", "https://georgiawildlife.com/"),
  jurisdiction("HI", "Hawaii", [{ west: -178.45, south: 18.86, east: -154.75, north: 28.52 }], "Hawaii Division of Forestry and Wildlife", "https://dlnr.hawaii.gov/dofaw/"),
  jurisdiction("ID", "Idaho", [{ west: -117.25, south: 41.98, east: -111.04, north: 49.01 }], "Idaho Department of Fish and Game", "https://idfg.idaho.gov/"),
  jurisdiction("IL", "Illinois", [{ west: -91.52, south: 36.97, east: -87.01, north: 42.51 }], "Illinois Department of Natural Resources", "https://dnr.illinois.gov/"),
  jurisdiction("IN", "Indiana", [{ west: -88.1, south: 37.77, east: -84.78, north: 41.77 }], "Indiana Department of Natural Resources, Division of Fish and Wildlife", "https://www.in.gov/dnr/fish-and-wildlife/"),
  jurisdiction("IA", "Iowa", [{ west: -96.64, south: 40.37, east: -90.14, north: 43.51 }], "Iowa Department of Natural Resources", "https://www.iowadnr.gov/"),
  jurisdiction("KS", "Kansas", [{ west: -102.06, south: 36.99, east: -94.58, north: 40.01 }], "Kansas Department of Wildlife and Parks", "https://www.ksoutdoors.gov/"),
  jurisdiction("KY", "Kentucky", [{ west: -89.58, south: 36.49, east: -81.96, north: 39.15 }], "Kentucky Department of Fish and Wildlife Resources", "https://fw.ky.gov/"),
  jurisdiction("LA", "Louisiana", [{ west: -94.05, south: 28.85, east: -88.75, north: 33.02 }], "Louisiana Department of Wildlife and Fisheries", "https://www.wlf.louisiana.gov/"),
  jurisdiction("ME", "Maine", [{ west: -71.09, south: 42.91, east: -66.88, north: 47.46 }], "Maine Department of Inland Fisheries and Wildlife", "https://www.maine.gov/ifw/"),
  jurisdiction("MD", "Maryland", [{ west: -79.49, south: 37.88, east: -74.98, north: 39.73 }], "Maryland Department of Natural Resources", "https://dnr.maryland.gov/"),
  jurisdiction("MA", "Massachusetts", [{ west: -73.51, south: 41.18, east: -69.85, north: 42.89 }], "Massachusetts Division of Fisheries and Wildlife", "https://www.mass.gov/orgs/division-of-fisheries-and-wildlife"),
  jurisdiction("MI", "Michigan", [{ west: -90.42, south: 41.69, east: -82.12, north: 48.31 }], "Michigan Department of Natural Resources", "https://www.michigan.gov/dnr"),
  jurisdiction("MN", "Minnesota", [{ west: -97.24, south: 43.49, east: -89.48, north: 49.39 }], "Minnesota Department of Natural Resources", "https://www.dnr.state.mn.us/"),
  jurisdiction("MS", "Mississippi", [{ west: -91.66, south: 30.13, east: -88.09, north: 35.0 }], "Mississippi Department of Wildlife, Fisheries, and Parks", "https://www.mdwfp.com/"),
  jurisdiction("MO", "Missouri", [{ west: -95.78, south: 35.99, east: -89.09, north: 40.62 }], "Missouri Department of Conservation", "https://mdc.mo.gov/"),
  jurisdiction("MT", "Montana", [{ west: -116.05, south: 44.35, east: -104.03, north: 49.01 }], "Montana Fish, Wildlife & Parks", "https://fwp.mt.gov/"),
  jurisdiction("NE", "Nebraska", [{ west: -104.06, south: 39.99, east: -95.3, north: 43.01 }], null, null),
  jurisdiction("NV", "Nevada", [{ west: -120.01, south: 35.0, east: -114.03, north: 42.01 }], "Nevada Department of Wildlife", "https://www.ndow.org/"),
  jurisdiction("NH", "New Hampshire", [{ west: -72.56, south: 42.69, east: -70.57, north: 45.31 }], "New Hampshire Fish and Game Department", "https://www.wildlife.nh.gov/"),
  jurisdiction("NJ", "New Jersey", [{ west: -75.57, south: 38.78, east: -73.88, north: 41.36 }], "New Jersey Division of Fish and Wildlife", "https://dep.nj.gov/njfw/"),
  jurisdiction("NM", "New Mexico", [{ west: -109.06, south: 31.33, east: -103.0, north: 37.01 }], "New Mexico Department of Wildlife", "https://wildlife.dgf.nm.gov/"),
  jurisdiction("NY", "New York", [{ west: -79.77, south: 40.47, east: -71.77, north: 45.02 }], "New York State Department of Environmental Conservation", "https://dec.ny.gov/"),
  jurisdiction("NC", "North Carolina", [{ west: -84.33, south: 33.75, east: -75.4, north: 36.59 }], "North Carolina Wildlife Resources Commission", "https://www.ncwildlife.gov/"),
  jurisdiction("ND", "North Dakota", [{ west: -104.05, south: 45.93, east: -96.55, north: 49.01 }], "North Dakota Game and Fish Department", "https://gf.nd.gov/"),
  jurisdiction("OH", "Ohio", [{ west: -84.83, south: 38.4, east: -80.51, north: 42.33 }], "Ohio Department of Natural Resources, Division of Wildlife", "https://ohiodnr.gov/discover-and-learn/safety-conservation/about-ODNR/wildlife"),
  jurisdiction("OK", "Oklahoma", [{ west: -103.01, south: 33.61, east: -94.43, north: 37.01 }], "Oklahoma Department of Wildlife Conservation", "https://www.wildlifedepartment.com/"),
  jurisdiction("OR", "Oregon", [{ west: -124.71, south: 41.99, east: -116.46, north: 46.3 }], "Oregon Department of Fish and Wildlife", "https://www.dfw.state.or.us/"),
  jurisdiction("PA", "Pennsylvania", [{ west: -80.52, south: 39.71, east: -74.68, north: 42.52 }], "Pennsylvania Game Commission", "https://www.pa.gov/agencies/pgc"),
  jurisdiction("RI", "Rhode Island", [{ west: -71.91, south: 41.09, east: -71.08, north: 42.02 }], null, null),
  jurisdiction("SC", "South Carolina", [{ west: -83.36, south: 31.99, east: -78.49, north: 35.22 }], "South Carolina Department of Natural Resources", "https://www.dnr.sc.gov/"),
  jurisdiction("SD", "South Dakota", [{ west: -104.06, south: 42.47, east: -96.43, north: 45.95 }], "South Dakota Game, Fish and Parks", "https://gfp.sd.gov/"),
  jurisdiction("TN", "Tennessee", [{ west: -90.32, south: 34.98, east: -81.64, north: 36.68 }], "Tennessee Wildlife Resources Agency", "https://www.tn.gov/twra"),
  jurisdiction("TX", "Texas", [{ west: -106.65, south: 25.83, east: -93.5, north: 36.51 }], "Texas Parks and Wildlife Department", "https://tpwd.texas.gov/"),
  jurisdiction("UT", "Utah", [{ west: -114.06, south: 36.99, east: -109.04, north: 42.01 }], "Utah Division of Wildlife Resources", "https://wildlife.utah.gov/"),
  jurisdiction("VT", "Vermont", [{ west: -73.44, south: 42.72, east: -71.46, north: 45.02 }], "Vermont Fish and Wildlife Department", "https://vtfishandwildlife.com/"),
  jurisdiction("VA", "Virginia", [{ west: -83.68, south: 36.54, east: -75.16, north: 39.47 }], "Virginia Department of Wildlife Resources", "https://dwr.virginia.gov/"),
  jurisdiction("WA", "Washington", [{ west: -124.85, south: 45.54, east: -116.91, north: 49.01 }], "Washington Department of Fish and Wildlife", "https://wdfw.wa.gov/"),
  jurisdiction("WV", "West Virginia", [{ west: -82.65, south: 37.2, east: -77.71, north: 40.64 }], "West Virginia Division of Natural Resources", "https://wvdnr.gov/"),
  jurisdiction("WI", "Wisconsin", [{ west: -92.89, south: 42.49, east: -86.24, north: 47.31 }], "Wisconsin Department of Natural Resources", "https://dnr.wisconsin.gov/"),
  jurisdiction("WY", "Wyoming", [{ west: -111.06, south: 40.99, east: -104.05, north: 45.01 }], "Wyoming Game and Fish Department", "https://wgfd.wyo.gov/"),
];
