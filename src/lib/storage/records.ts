import type { MarkKind, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";

/**
 * Record shapes and validation for personal content stored by the content
 * repository (IndexedDB) and carried by full backups.
 *
 * One validator serves migration from `fieldline-v1` (after it maps unknown
 * marker kinds to "pin"), repository writes and backup restore, so anything
 * the repository can hold can also be backed up and restored. It tolerates
 * optional fields older builds never wrote (for example `goodWinds`, added
 * after 1.0.0) and keeps unknown fields verbatim within a nesting limit, but it
 * is strict about what storage and the UI depend on: safe ids, known marker
 * kinds, text names, finite in-range coordinates, typed known fields, bounds.
 */

/** Optional raw-fix detail kept on recorded track points (spec §9). */
export type StoredTrackPoint = TrackPoint & {
  /** Horizontal accuracy radius in meters. */
  accuracy?: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
};

/**
 * A track as stored. Compatible with `Track`: extra fields are optional and
 * ignored by code that only knows `Track`.
 */
export type StoredTrack = Omit<Track, "points"> & {
  points: StoredTrackPoint[];
  /**
   * Indices into `points` where a new segment starts after a recording gap.
   * Absent or empty means one continuous segment. Never includes 0.
   */
  segmentStarts?: number[];
};

export type ContentKind = "waypoint" | "track";

/** A deleted waypoint or track, kept until permanently deleted (DATA-02). */
export type TrashEntry = {
  /** `${kind}:${itemId}:${deletedAt}` — also the trash store key. */
  id: string;
  kind: ContentKind;
  itemId: string;
  deletedAt: number;
  /** The whole record as it was, including its relationships (hunt label, segments). */
  item: Waypoint | StoredTrack;
};

export const LIMITS = {
  idLength: 128,
  nameLength: 500,
  huntLength: 500,
  notesLength: 20_000,
  goodWinds: 36,
  trackPoints: 200_000,
} as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Ids become IndexedDB keys today and may become file or archive names for
 * attachments later, so path-like ids (`/`, `\`, `..`) and control characters
 * are rejected. Every id Fieldline has generated is a UUID, which passes.
 */
export function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LIMITS.idLength &&
    SAFE_ID.test(value) &&
    !value.includes("..")
  );
}

function okCoord(lng: unknown, lat: unknown): boolean {
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  max: number,
  problems: string[],
  label: string,
) {
  if (!(key in record) || record[key] === undefined) return;
  const value = record[key];
  if (typeof value !== "string") problems.push(`${label}: ${key} is not text`);
  else if (value.length > max) problems.push(`${label}: ${key} is longer than ${max} characters`);
}

function optionalNullableNumber(
  record: Record<string, unknown>,
  key: string,
  problems: string[],
  label: string,
  min = -Infinity,
  max = Infinity,
) {
  if (!(key in record) || record[key] === undefined || record[key] === null) return;
  const value = record[key];
  if (!finite(value) || value < min || value > max)
    problems.push(`${label}: ${key} is not a valid number`);
}

/**
 * Marker kinds the UI can draw (`MarkKind` in src/lib/hunt/types.ts). The map
 * indexes its marker table by `kind`, so any other value would break
 * rendering; it is rejected on every write and restore path.
 */
export const MARK_KINDS = [
  "stand",
  "blind",
  "camp",
  "camera",
  "parking",
  "gate",
  "water",
  "glass",
  "pin",
] as const satisfies readonly MarkKind[];

/** Compile-time check that MARK_KINDS lists every MarkKind. */
const _allKinds: [Exclude<MarkKind, (typeof MARK_KINDS)[number]>] extends [never] ? true : false =
  true;

export function isMarkKind(value: unknown): value is MarkKind {
  return typeof value === "string" && (MARK_KINDS as readonly string[]).includes(value);
}

/** Nesting allowed inside one record, including unknown fields kept verbatim. */
export const MAX_RECORD_DEPTH = 16;

/**
 * Whether a JSON-like value nests deeper than `max` levels. Iterative, so a
 * hostile value can't overflow the stack while being checked.
 */
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [item, depth] = stack.pop() as [unknown, number];
    if (!item || typeof item !== "object") continue;
    if (depth > max) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item)) {
      if (child && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return false;
}

/**
 * Problems with a waypoint record; empty when it can be stored. Required:
 * safe `id`, text `name`, a known `kind`, in-range `lng`/`lat`. Optional but
 * typed when present: `notes`, `hunt`, `goodWinds`, `createdAt` (records from
 * the first builds have no `goodWinds`).
 */
export function waypointProblems(value: unknown, label = "waypoint"): string[] {
  if (!isPlainObject(value)) return [`${label}: not an object`];
  const problems: string[] = [];
  const id = value.id;
  const where = isSafeId(id) ? `${label} ${id}` : label;
  if (!isSafeId(id)) problems.push(`${label}: missing or unsafe id`);
  if (nestsDeeperThan(value, MAX_RECORD_DEPTH)) return [`${where}: nested too deeply`];
  if (!okCoord(value.lng, value.lat))
    problems.push(`${where}: coordinates are missing or out of range`);
  if (typeof value.name !== "string") problems.push(`${where}: name is missing`);
  else optionalString(value, "name", LIMITS.nameLength, problems, where);
  if (!isMarkKind(value.kind)) problems.push(`${where}: kind is not a known marker type`);
  optionalString(value, "notes", LIMITS.notesLength, problems, where);
  optionalString(value, "hunt", LIMITS.huntLength, problems, where);
  if ("createdAt" in value && value.createdAt !== undefined && !finite(value.createdAt))
    problems.push(`${where}: createdAt is not a number`);
  if ("goodWinds" in value && value.goodWinds !== undefined) {
    const winds = value.goodWinds;
    if (
      !Array.isArray(winds) ||
      winds.length > LIMITS.goodWinds ||
      winds.some((wind) => !finite(wind) || wind < 0 || wind >= 360)
    ) {
      problems.push(`${where}: goodWinds is not a list of bearings`);
    }
  }
  return problems;
}
/** Problems with one track point. Only coordinates are required. */
function pointProblem(point: unknown): string | null {
  if (!isPlainObject(point)) return "point is not an object";
  if (nestsDeeperThan(point, 4)) return "point is nested too deeply";
  if (!okCoord(point.lng, point.lat)) return "point coordinates are missing or out of range";
  if ("t" in point && point.t !== undefined && !finite(point.t))
    return "point time is not a number";
  const extras: string[] = [];
  optionalNullableNumber(point, "accuracy", extras, "point", 0);
  optionalNullableNumber(point, "altitude", extras, "point");
  optionalNullableNumber(point, "altitudeAccuracy", extras, "point", 0);
  optionalNullableNumber(point, "speed", extras, "point", 0);
  optionalNullableNumber(point, "heading", extras, "point", 0, 360);
  return extras[0] ?? null;
}

/** Problems with a track record; empty when it can be stored. */
export function trackProblems(
  value: unknown,
  label = "track",
  maxPoints: number = LIMITS.trackPoints,
): string[] {
  if (!isPlainObject(value)) return [`${label}: not an object`];
  const problems: string[] = [];
  const id = value.id;
  const where = isSafeId(id) ? `${label} ${id}` : label;
  if (!isSafeId(id)) problems.push(`${label}: missing or unsafe id`);
  // Points are checked one by one below; the rest of the record must stay shallow.
  const { points: _points, ...rest } = value;
  if (nestsDeeperThan(rest, MAX_RECORD_DEPTH)) return [`${where}: nested too deeply`];
  if (typeof value.name !== "string") problems.push(`${where}: name is missing`);
  else optionalString(value, "name", LIMITS.nameLength, problems, where);
  if ("createdAt" in value && value.createdAt !== undefined && !finite(value.createdAt))
    problems.push(`${where}: createdAt is not a number`);
  if ("visible" in value && value.visible !== undefined && typeof value.visible !== "boolean")
    problems.push(`${where}: visible is not true/false`);
  const points = value.points;
  if (!Array.isArray(points)) {
    problems.push(`${where}: points is not a list`);
    return problems;
  }
  if (points.length > maxPoints) problems.push(`${where}: more than ${maxPoints} points`);
  for (let i = 0; i < points.length; i += 1) {
    const problem = pointProblem(points[i]);
    if (problem) {
      problems.push(`${where}: ${problem} (point ${i})`);
      break;
    }
  }
  if ("segmentStarts" in value && value.segmentStarts !== undefined) {
    const starts = value.segmentStarts;
    let ok = Array.isArray(starts);
    if (ok) {
      let prev = 0;
      for (const start of starts as unknown[]) {
        if (
          !Number.isInteger(start) ||
          (start as number) <= prev ||
          (start as number) >= points.length
        ) {
          ok = false;
          break;
        }
        prev = start as number;
      }
    }
    if (!ok) problems.push(`${where}: segmentStarts is not an increasing list of point indices`);
  }
  return problems;
}

export function trashKey(kind: ContentKind, itemId: string, deletedAt: number): string {
  return `${kind}:${itemId}:${deletedAt}`;
}

/** Problems with a trash entry, including its item. */
export function trashProblems(value: unknown, label = "trash entry"): string[] {
  if (!isPlainObject(value)) return [`${label}: not an object`];
  const { kind, itemId, deletedAt, id, item } = value;
  if (kind !== "waypoint" && kind !== "track") return [`${label}: unknown kind`];
  if (!isSafeId(itemId)) return [`${label}: missing or unsafe item id`];
  if (!finite(deletedAt) || deletedAt < 0) return [`${label} ${itemId}: deletedAt is not a time`];
  if (id !== trashKey(kind, itemId, deletedAt))
    return [`${label} ${itemId}: id does not match its item`];
  const problems =
    kind === "waypoint"
      ? waypointProblems(item, `${label} ${itemId}`)
      : trackProblems(item, `${label} ${itemId}`);
  if (!problems.length && (item as { id: unknown }).id !== itemId)
    problems.push(`${label} ${itemId}: item id does not match`);
  return problems;
}

/** Guard for `canonicalJson`; validated records and backups are far shallower. */
const MAX_CANONICAL_DEPTH = 64;

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped (as in
 * JSON.stringify). Used for read-back verification, identical-record checks
 * and backup checksums, so key order never makes equal records look different.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new RangeError("Value is nested too deeply to store.");
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    return text === undefined ? "null" : text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined || typeof item === "function" ? "null" : canonicalJson(item, depth + 1))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

export function sameRecord(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
