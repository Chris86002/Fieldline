import type { MarkKind, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";

const KINDS = new Set<MarkKind>(["stand", "blind", "camp", "camera", "parking", "gate", "water", "glass", "pin"]);

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
      const pts = track.points
        .map((p) => `        <trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
        .join("\n");
      return `  <trk><name>${esc(track.name)}</name><trkseg>\n${pts}\n      </trkseg></trk>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Fieldline" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n${trks}\n</gpx>\n`;
}

export function parseGpx(text: string): { waypoints: Omit<Waypoint, "id" | "createdAt">[]; tracks: Omit<Track, "id" | "createdAt" | "visible">[] } {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file is not GPX.");
  const waypoints = [...doc.getElementsByTagName("wpt")].flatMap((node) => {
    const lat = Number(node.getAttribute("lat"));
    const lng = Number(node.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const kindRaw = (node.getElementsByTagName("type")[0]?.textContent ?? "pin").trim().toLowerCase();
    const kind = KINDS.has(kindRaw as MarkKind) ? (kindRaw as MarkKind) : "pin";
    const windText = node.getElementsByTagName("extensions")[0]?.textContent ?? "";
    const windMatch = /winds:([0-9,\s]+)/.exec(windText);
    const goodWinds = windMatch
      ? windMatch[1]
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isFinite(n) && n >= 0 && n < 360)
      : [];
    return [
      {
        name: (node.getElementsByTagName("name")[0]?.textContent ?? "Mark").trim().slice(0, 60) || "Mark",
        kind,
        lng,
        lat,
        notes: (node.getElementsByTagName("desc")[0]?.textContent ?? "").trim().slice(0, 500),
        hunt: (node.getElementsByTagName("cmt")[0]?.textContent ?? "").trim().slice(0, 40),
        goodWinds,
      },
    ];
  });
  const tracks = [...doc.getElementsByTagName("trk")].flatMap((node) => {
    const points: TrackPoint[] = [...node.getElementsByTagName("trkpt")].flatMap((pt) => {
      const lat = Number(pt.getAttribute("lat"));
      const lng = Number(pt.getAttribute("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const time = pt.getElementsByTagName("time")[0]?.textContent;
      const t = time ? Date.parse(time) : Date.now();
      return [{ lng, lat, t: Number.isFinite(t) ? t : Date.now() }];
    });
    if (points.length < 2) return [];
    return [
      {
        name: (node.getElementsByTagName("name")[0]?.textContent ?? "Track").trim().slice(0, 60) || "Track",
        points,
      },
    ];
  });
  if (waypoints.length === 0 && tracks.length === 0) throw new Error("No waypoints or tracks in that file.");
  return { waypoints, tracks };
}
