import type { MarkKind, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";
import { trackSegments } from "./track-segments.ts";

const KINDS = new Set<MarkKind>(["stand", "blind", "camp", "camera", "parking", "gate", "water", "glass", "pin"]);

const GENERIC_HUNT =
  /^(export|exported|download|downloads|waypoints?|tracks?|routes?|areas?|saved|gaia|gaiagps|gps|fieldline|data|untitled|my places|places|all|file|folder|temporary|default)$/i;

export type ParsedTrails = {
  waypoints: Omit<Waypoint, "id" | "createdAt">[];
  tracks: Omit<Track, "id" | "createdAt" | "visible">[];
  trimmed: boolean;
};

const MAX_MARKS = 2000;
const MAX_TRACKS = 250;
const MAX_POINTS = 4000;

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    return "&" + "quot;";
  });
}

export function toGpx(waypoints: Waypoint[], tracks: Track[]): string {
  const wpts = waypoints
    .map(
      (w) =>
        `  <wpt lat="${w.lat}" lon="${w.lng}"><name>${esc(w.name)}</name><desc>${esc(w.notes)}</desc><type>${w.kind}</type>${w.hunt ? `<cmt>${esc(w.hunt)}</cmt>` : ""}${w.goodWinds?.length ? `<extensions>winds:${w.goodWinds.join(",")}</extensions>` : ""}</wpt>`,
    )
    .join("\n");
  const trks = tracks
    .map((track) => {
      // Recording gaps become separate segments, so other apps don't draw a line across them.
      const segs = trackSegments(track)
        .map((segment) => {
          const pts = segment
            .map((p) => `        <trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
            .join("\n");
          return `<trkseg>\n${pts}\n      </trkseg>`;
        })
        .join("");
      return `  <trk><name>${esc(track.name)}</name>${segs}</trk>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Fieldline" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n${trks}\n</gpx>\n`;
}

export function huntLabel(folder: string, hint: string): string {
  const name = folder.trim();
  if (name && !GENERIC_HUNT.test(name)) return name.slice(0, 40);
  return hint.trim().slice(0, 40);
}

export function clipText(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function plainText(value: string): string {
  return clipText(value.replace(/<[^>]+>/g, " "), 500);
}

export function elements(root: Document | Element, name: string): Element[] {
  const listed = root.getElementsByTagNameNS("*", name);
  return listed.length ? [...listed] : [...root.getElementsByTagName(name)];
}

export function childText(node: Element, name: string): string {
  for (const child of node.children) {
    if (child.localName === name) return child.textContent ?? "";
  }
  return "";
}

export function guessKind(text: string): MarkKind {
  const hay = text.toLowerCase();
  if (/\b(tree\s*stands?|treestands?|hang-?ons?|stands?)\b/.test(hay)) return "stand";
  if (/\b(blinds?|hides?)\b/.test(hay)) return "blind";
  if (/\b(trail\s*cams?|game\s*cams?|cameras?)\b/.test(hay)) return "camera";
  if (/\b(springs?|guzzlers?|troughs?|tanks?|water|ponds?)\b/.test(hay)) return "water";
  if (/\b(gates?)\b/.test(hay)) return "gate";
  if (/\b(parking|trail\s*heads?|trailheads?)\b/.test(hay)) return "parking";
  if (/\b(camps?|campgrounds?|tents?|spike)\b/.test(hay)) return "camp";
  if (/\b(glass(?:ing)?|overlooks?|viewpoints?|binoculars?)\b/.test(hay)) return "glass";
  return "pin";
}

export function kindFrom(typeText: string, sym: string, name: string): MarkKind {
  const raw = typeText.trim().toLowerCase();
  if (KINDS.has(raw as MarkKind)) return raw as MarkKind;
  return guessKind(`${sym} ${typeText} ${name}`);
}

export function okCoord(lng: number, lat: number): boolean {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function thinPoints(points: TrackPoint[], max = MAX_POINTS): { points: TrackPoint[]; thinned: boolean } {
  if (points.length <= max) return { points, thinned: false };
  const step = Math.ceil(points.length / max);
  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  const last = points[points.length - 1];
  const end = out[out.length - 1];
  if (!end || end.lng !== last.lng || end.lat !== last.lat) out.push(last);
  return { points: out, thinned: true };
}

export function emptyBag(): ParsedTrails {
  return { waypoints: [], tracks: [], trimmed: false };
}

export function pushMark(bag: ParsedTrails, mark: ParsedTrails["waypoints"][number]) {
  if (bag.waypoints.length >= MAX_MARKS) {
    bag.trimmed = true;
    return;
  }
  bag.waypoints.push(mark);
}

export function pushTrack(bag: ParsedTrails, name: string, points: TrackPoint[]) {
  if (points.length < 2) return;
  const thin = thinPoints(points);
  if (thin.thinned) bag.trimmed = true;
  if (bag.tracks.length >= MAX_TRACKS) {
    bag.trimmed = true;
    return;
  }
  bag.tracks.push({ name: clipText(name, 60) || "Track", points: thin.points });
}

export function finishBag(bag: ParsedTrails): ParsedTrails {
  if (bag.waypoints.length === 0 && bag.tracks.length === 0) {
    throw new Error("No marks, tracks, or areas in that file.");
  }
  return bag;
}

function pointFrom(node: Element): TrackPoint | null {
  const lat = Number(node.getAttribute("lat"));
  const lng = Number(node.getAttribute("lon"));
  if (!okCoord(lng, lat)) return null;
  const time = childText(node, "time");
  const t = time ? Date.parse(time) : Date.now();
  return { lng, lat, t: Number.isFinite(t) ? t : Date.now() };
}

function addLine(bag: ParsedTrails, node: Element, pointTag: "trkpt" | "rtept", fallback: string) {
  const name = clipText(childText(node, "name"), 60) || fallback;
  const groups =
    pointTag === "trkpt" && elements(node, "trkseg").length
      ? elements(node, "trkseg").map((seg) => elements(seg, "trkpt"))
      : [elements(node, pointTag)];
  let part = 0;
  for (const group of groups) {
    const points = group.flatMap((pt) => {
      const point = pointFrom(pt);
      return point ? [point] : [];
    });
    if (points.length < 2) continue;
    part += 1;
    pushTrack(bag, part === 1 ? name : `${name} ${part}`, points);
  }
}

export function parseGpx(text: string, huntHint = ""): ParsedTrails {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName.toLowerCase() !== "gpx") {
    throw new Error("That file isn't a map export Fieldline can read.");
  }
  const meta = [...doc.documentElement.children].find((el) => el.localName === "metadata");
  const hint = huntLabel(meta ? childText(meta, "name") : "", huntHint);
  const bag = emptyBag();
  for (const node of elements(doc, "wpt")) {
    const lat = Number(node.getAttribute("lat"));
    const lng = Number(node.getAttribute("lon"));
    if (!okCoord(lng, lat)) continue;
    const name = clipText(childText(node, "name"), 60) || "Mark";
    const windText = childText(node, "extensions");
    const windMatch = /winds:([0-9,\s]+)/.exec(windText);
    const goodWinds = windMatch
      ? windMatch[1]
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isFinite(n) && n >= 0 && n < 360)
      : [];
    pushMark(bag, {
      name,
      kind: kindFrom(childText(node, "type"), childText(node, "sym"), name),
      lng,
      lat,
      notes: plainText(childText(node, "desc")),
      hunt: huntLabel(childText(node, "cmt"), hint),
      goodWinds,
    });
  }
  for (const node of elements(doc, "trk")) addLine(bag, node, "trkpt", "Track");
  for (const node of elements(doc, "rte")) addLine(bag, node, "rtept", "Route");
  return finishBag(bag);
}
