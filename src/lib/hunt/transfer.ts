import {
  childText,
  clipText,
  elements,
  emptyBag,
  finishBag,
  huntLabel,
  kindFrom,
  okCoord,
  parseGpx,
  plainText,
  pushMark,
  pushTrack,
  type ParsedTrails,
} from "@/lib/hunt/gpx";
import type { HuntRegion, TrackPoint } from "@/lib/hunt/types";

const MAX_BYTES = 28 * 1024 * 1024;

export function huntFromName(filename: string): string {
  return huntLabel(filename.replace(/\.[^.]+$/i, "").replace(/[_]+/g, " "), "");
}

export function waypointKey(mark: { name: string; lng: number; lat: number }): string {
  return `${mark.name.trim().toLowerCase()}|${mark.lat.toFixed(5)}|${mark.lng.toFixed(5)}`;
}

export function trackKey(track: { name: string; points: { lng: number; lat: number }[] }): string {
  const start = track.points[0];
  const end = track.points[track.points.length - 1];
  return `${track.name.trim().toLowerCase()}|${track.points.length}|${start?.lat.toFixed(4)}|${start?.lng.toFixed(4)}|${end?.lat.toFixed(4)}|${end?.lng.toFixed(4)}`;
}

export function guessRegion(points: { lng: number; lat: number }[]): HuntRegion | null {
  let az = 0;
  let id = 0;
  for (const point of points) {
    if (point.lat >= 31.2 && point.lat <= 37.1 && point.lng >= -114.9 && point.lng <= -109) az += 1;
    else if (point.lat >= 41.9 && point.lat <= 49.1 && point.lng >= -117.3 && point.lng <= -111) id += 1;
  }
  const count = points.length;
  if (count === 0) return null;
  if (id > az && id / count >= 0.5) return "id";
  if (az > id && az / count >= 0.5) return "az";
  return null;
}

export async function readTrailFile(file: File): Promise<ParsedTrails> {
  if (file.size > MAX_BYTES) throw new Error("That file is too big. Export one Gaia folder at a time.");
  const lower = file.name.toLowerCase();
  const hint = huntFromName(file.name);
  if (lower.endsWith(".kmz") || lower.endsWith(".zip")) {
    return parseKml(await kmlFromZip(await file.arrayBuffer()), hint);
  }
  const text = (await file.text()).replace(/^\uFEFF/, "");
  return parseTrailText(text, hint);
}

export function parseTrailText(text: string, hint = ""): ParsedTrails {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("That file is empty.");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseGeoJson(trimmed, hint);
  if (trimmed.startsWith("<") || trimmed.startsWith("<?")) {
    const doc = new DOMParser().parseFromString(trimmed, "application/xml");
    const root = doc.documentElement?.localName?.toLowerCase() ?? "";
    if (doc.querySelector("parsererror")) throw new Error("That file isn't a map export Fieldline can read.");
    if (root === "gpx") return parseGpx(trimmed, hint);
    if (root === "kml" || root === "document") return parseKmlDoc(doc, hint);
    throw new Error("That file isn't a map export Fieldline can read. Gaia uses GPX, KML, or GeoJSON.");
  }
  return parseCsv(trimmed, hint);
}

function parseKml(text: string, hint: string): ParsedTrails {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file isn't a map export Fieldline can read.");
  return parseKmlDoc(doc, hint);
}

function parseKmlDoc(doc: Document, hint: string): ParsedTrails {
  const bag = emptyBag();
  const root = doc.documentElement;
  if (!root) throw new Error("That file isn't a map export Fieldline can read.");
  walkKml(root, "", hint, bag);
  return finishBag(bag);
}

function walkKml(node: Element, folder: string, hint: string, bag: ParsedTrails) {
  for (const child of node.children) {
    const tag = child.localName;
    if (tag === "Folder" || tag === "Document") {
      walkKml(child, childText(child, "name"), hint, bag);
    } else if (tag === "Placemark") {
      readPlacemark(child, huntLabel(folder, hint), bag);
    }
  }
}

function readPlacemark(node: Element, hunt: string, bag: ParsedTrails) {
  const name = clipText(childText(node, "name"), 60) || "Mark";
  const notes = plainText(childText(node, "description"));
  const kind = kindFrom("", "", name);
  let points = 0;
  const visit = (el: Element) => {
    const tag = el.localName;
    if (tag === "Point") {
      const coord = parseCoordList(childText(el, "coordinates"))[0];
      if (!coord) return;
      points += 1;
      pushMark(bag, {
        name: points === 1 ? name : `${name} ${points}`.slice(0, 60),
        kind,
        lng: coord.lng,
        lat: coord.lat,
        notes,
        hunt,
        goodWinds: [],
      });
      return;
    }
    if (tag === "LineString" || tag === "LinearRing") {
      pushTrack(bag, name, trackFromCoords(parseCoordList(childText(el, "coordinates"))));
      return;
    }
    if (tag === "Polygon") {
      const ring = elements(el, "LinearRing")[0];
      if (ring) pushTrack(bag, name, trackFromCoords(parseCoordList(childText(ring, "coordinates"))));
      return;
    }
    if (tag === "Track") {
      pushTrack(bag, name, trackFromGx(el));
      return;
    }
    if (tag === "MultiGeometry" || tag === "MultiTrack") {
      for (const child of el.children) visit(child);
      return;
    }
    for (const child of el.children) {
      if (["Point", "LineString", "LinearRing", "Polygon", "MultiGeometry", "Track", "MultiTrack"].includes(child.localName)) {
        visit(child);
      }
    }
  };
  visit(node);
}

function parseCoordList(text: string): { lng: number; lat: number }[] {
  const out: { lng: number; lat: number }[] = [];
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    const [lngText, latText] = token.split(",");
    const lng = Number(lngText);
    const lat = Number(latText);
    if (okCoord(lng, lat)) out.push({ lng, lat });
  }
  return out;
}

function trackFromCoords(coords: { lng: number; lat: number }[]): TrackPoint[] {
  const now = Date.now();
  const points: TrackPoint[] = [];
  for (const coord of coords) {
    const prev = points[points.length - 1];
    if (prev && prev.lng === coord.lng && prev.lat === coord.lat) continue;
    points.push({ lng: coord.lng, lat: coord.lat, t: now });
  }
  return points;
}

function trackFromGx(node: Element): TrackPoint[] {
  const coords = [...node.children].filter((child) => child.localName === "coord");
  const whens = [...node.children].filter((child) => child.localName === "when");
  const points: TrackPoint[] = [];
  coords.forEach((coord, index) => {
    const parts = (coord.textContent ?? "").trim().split(/\s+/);
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!okCoord(lng, lat)) return;
    const when = whens[index]?.textContent ?? "";
    const t = when ? Date.parse(when) : Date.now();
    const prev = points[points.length - 1];
    if (prev && prev.lng === lng && prev.lat === lat) return;
    points.push({ lng, lat, t: Number.isFinite(t) ? t : Date.now() });
  });
  return points;
}

function parseGeoJson(text: string, hint: string): ParsedTrails {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a map export Fieldline can read.");
  }
  const bag = emptyBag();
  absorbGeo(data, {}, hint, bag);
  return finishBag(bag);
}

function stringProp(props: Record<string, unknown>, keys: string[]): string {
  const lower = new Map(Object.entries(props).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lower.get(key.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function absorbGeo(node: unknown, props: Record<string, unknown>, hint: string, bag: ParsedTrails) {
  if (!node || typeof node !== "object") return;
  const geo = node as {
    type?: string;
    features?: unknown[];
    geometries?: unknown[];
    coordinates?: unknown;
    geometry?: unknown;
    properties?: unknown;
  };
  if (geo.type === "FeatureCollection" && Array.isArray(geo.features)) {
    for (const feature of geo.features) absorbGeo(feature, {}, hint, bag);
    return;
  }
  if (Array.isArray(node)) {
    for (const feature of node) absorbGeo(feature, {}, hint, bag);
    return;
  }
  if (geo.type === "Feature") {
    const featureProps = geo.properties && typeof geo.properties === "object" ? (geo.properties as Record<string, unknown>) : {};
    absorbGeo(geo.geometry, featureProps, hint, bag);
    return;
  }
  if (geo.type === "GeometryCollection" && Array.isArray(geo.geometries)) {
    for (const child of geo.geometries) absorbGeo(child, props, hint, bag);
    return;
  }
  const name = clipText(stringProp(props, ["name", "title", "label"]) || "Mark", 60);
  const notes = plainText(stringProp(props, ["description", "desc", "notes", "comment", "cmt"]));
  const hunt = huntLabel(stringProp(props, ["folder", "hunt", "cmt"]), hint);
  const kind = kindFrom(stringProp(props, ["type", "symbol", "sym", "icon"]), "", name);
  if (geo.type === "Point") {
    const coord = pair(geo.coordinates);
    if (coord) pushMark(bag, { name, kind, lng: coord.lng, lat: coord.lat, notes, hunt, goodWinds: [] });
    return;
  }
  if (geo.type === "MultiPoint" && Array.isArray(geo.coordinates)) {
    geo.coordinates.forEach((value, index) => {
      const coord = pair(value);
      if (!coord) return;
      pushMark(bag, {
        name: index === 0 ? name : `${name} ${index + 1}`.slice(0, 60),
        kind,
        lng: coord.lng,
        lat: coord.lat,
        notes,
        hunt,
        goodWinds: [],
      });
    });
    return;
  }
  if (geo.type === "LineString") {
    pushTrack(bag, name, trackFromCoords(listPairs(geo.coordinates)));
    return;
  }
  if (geo.type === "MultiLineString" && Array.isArray(geo.coordinates)) {
    for (const line of geo.coordinates) pushTrack(bag, name, trackFromCoords(listPairs(line)));
    return;
  }
  if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) {
    pushTrack(bag, name, trackFromCoords(listPairs(geo.coordinates[0])));
    return;
  }
  if (geo.type === "MultiPolygon" && Array.isArray(geo.coordinates)) {
    for (const poly of geo.coordinates) {
      if (Array.isArray(poly)) pushTrack(bag, name, trackFromCoords(listPairs(poly[0])));
    }
  }
}

function pair(value: unknown): { lng: number; lat: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  return okCoord(lng, lat) ? { lng, lat } : null;
}

function listPairs(value: unknown): { lng: number; lat: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const coord = pair(item);
    return coord ? [coord] : [];
  });
}

function parseCsv(text: string, hint: string): ParsedTrails {
  const sample = text.slice(0, 2000);
  const commas = sample.split(",").length;
  const semis = sample.split(";").length;
  const rows = splitCsv(semis > commas ? text.replace(/;/g, ",") : text);
  if (rows.length < 2) throw new Error("That spreadsheet needs latitude and longitude columns.");
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const latI = header.findIndex((cell) => cell === "lat" || cell === "latitude" || cell.includes("latitude"));
  const lngI = header.findIndex((cell) => /^(lon|lng|long|longitude|x)$/.test(cell) || cell.includes("longitude") || cell === "lon" || cell === "lng");
  if (latI < 0 || lngI < 0) throw new Error("That spreadsheet needs latitude and longitude columns.");
  const nameI = header.findIndex((cell) => /^(name|title|label|waypoint)$/.test(cell));
  const noteI = header.findIndex((cell) => /^(desc|description|notes|comment|cmt)$/.test(cell));
  const typeI = header.findIndex((cell) => /^(type|symbol|sym|icon)$/.test(cell));
  const bag = emptyBag();
  for (const row of rows.slice(1)) {
    const lat = Number(row[latI]);
    const lng = Number(row[lngI]);
    if (!okCoord(lng, lat)) continue;
    const name = clipText((nameI >= 0 ? row[nameI] : "") || "Mark", 60) || "Mark";
    pushMark(bag, {
      name,
      kind: kindFrom(typeI >= 0 ? row[typeI] || "" : "", "", name),
      lng,
      lat,
      notes: plainText(noteI >= 0 ? row[noteI] || "" : ""),
      hunt: hint,
      goodWinds: [],
    });
  }
  return finishBag(bag);
}

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((part) => part.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((part) => part.trim())) rows.push(row);
  return rows;
}

async function kmlFromZip(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 0x10000);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That KMZ isn't a zip file. Export GPX or KML instead.");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  let kml = "";
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOff = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, "/");
    pos += 46 + nameLen + extraLen + commentLen;
    const lower = name.toLowerCase();
    if (!lower.endsWith(".kml") || lower.includes("__macosx") || lower.split("/").some((part) => part.startsWith("."))) continue;
    if (compSize === 0xffffffff) throw new Error("That KMZ is too large. Export GPX or KML instead.");
    if (method !== 0 && method !== 8) throw new Error("That KMZ is compressed in a way Fieldline can't open. Export GPX or KML.");
    if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) continue;
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const slice = bytes.subarray(dataStart, dataStart + compSize);
    const text = method === 0 ? new TextDecoder().decode(slice) : await inflateRaw(slice);
    kml = text;
    if (lower.endsWith("doc.kml")) break;
  }
  if (!kml.trim()) throw new Error("No map data in that KMZ.");
  return kml;
}

async function inflateRaw(slice: Uint8Array): Promise<string> {
  try {
    const copy = slice.slice();
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  } catch {
    throw new Error("That KMZ couldn't be opened. Export GPX or KML instead.");
  }
}
