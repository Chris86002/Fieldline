import { StorageError, type StorageBackend } from "./backend.ts";
import { sha256Hex } from "./digest.ts";
import { canonicalJson, isMarkKind, trackProblems, waypointProblems } from "./records.ts";
import { CONTENT_SCHEMA_VERSION, readSchema, SCHEMA_KEY, type SchemaMeta } from "./repository.ts";

/**
 * Ordered, idempotent content migrations.
 *
 * The meta store's "schema" record says which content schema the repository
 * holds; it is absent until the first migration completes. Each step moves
 * the repository from `from` to `to`, writes the schema record only after its
 * data has been committed and read back, and can be re-run safely after any
 * interruption. A repository whose schema is newer than this build is never
 * modified.
 */

/** The localStorage key older builds keep personal content in. Read only, never written here. */
export const LEGACY_KEY = "fieldline-v1";

/** Anything with localStorage's `getItem`. Migration never calls a write method on it. */
export type LegacySource = { getItem(key: string): string | null };

export type MigrationContext = {
  backend: StorageBackend;
  legacy: LegacySource;
  now: () => number;
};

export type MigrationCounts = { waypoints: number; tracks: number };

export type MigrationFailure =
  /** fieldline-v1 isn't readable JSON in the expected envelope. */
  | "corrupt-source"
  /** fieldline-v1 was written by a newer build (envelope version other than 0). */
  | "unsupported-source-version"
  /** Some saved records fail validation; listed in `problems`. */
  | "invalid-source-records"
  /** localStorage couldn't be read. */
  | "source-unavailable"
  /** The repository was written by a newer build. */
  | "unsupported-database"
  /** A storage error (quota, unavailable, aborted); see `code`. */
  | "storage-error"
  /** The committed copy didn't read back identical to the source. */
  | "verification-failed";

export type MigrationResult =
  | {
      ok: true;
      /**
       * "legacy-changed-after-migration": the repository is current, but the
       * marks/tracks in fieldline-v1 differ from what was migrated (an older
       * build or the not-yet-rewired app kept saving there). Nothing is merged;
       * surface `message` and let the user decide.
       */
      status:
        "migrated" | "already-complete" | "nothing-to-migrate" | "legacy-changed-after-migration";
      schemaVersion: number;
      counts: MigrationCounts;
      message: string;
      /** Waypoints whose unknown marker kind was mapped to "pin" by this run. */
      normalized?: KindNormalization[];
    }
  | {
      ok: false;
      status: MigrationFailure;
      message: string;
      problems?: string[];
      code?: StorageError["code"];
    };

/** A waypoint whose kind the UI can't draw, imported as "pin". */
export type KindNormalization = {
  id: string;
  field: "kind";
  /** The original value, as text (truncated to 64 characters). */
  from: string;
  to: "pin";
};

/** Record of a completed v0→v1 step (meta key "migration:v0-v1"). */
export type LegacyMigrationMeta = {
  step: "v0-v1";
  completedAt: number;
  source: typeof LEGACY_KEY;
  /** SHA-256 of the fieldline-v1 string that was copied, or null when it was absent. */
  sourceDigest: string | null;
  /**
   * SHA-256 of the canonical `{ waypoints, tracks }` read from fieldline-v1
   * (before kind mapping). Compared on later starts; only content counts, so
   * fieldline-v1's view and preference fields can keep changing.
   */
  contentDigest: string;
  counts: MigrationCounts;
  /** Kind mappings applied (first 1,000) and their total. */
  normalized: KindNormalization[];
  normalizedCount: number;
};

/** Thrown inside a migration transaction when another tab completed it first. */
class MigrationRace extends Error {}

export const LEGACY_MIGRATION_KEY = "migration:v0-v1";

type StepOutcome =
  | {
      ok: true;
      counts: MigrationCounts;
      empty: boolean;
      normalized: KindNormalization[];
      raced?: false;
    }
  /** Another tab completed the step first; nothing was changed by this run. */
  | { ok: true; raced: true }
  | Extract<MigrationResult, { ok: false }>;

type MigrationStep = {
  from: number;
  to: number;
  id: string;
  run: (ctx: MigrationContext) => Promise<StepOutcome>;
};

type ParsedLegacy = {
  /** Records to store (unknown kinds mapped to "pin"). */
  waypoints: Record<string, unknown>[];
  tracks: Record<string, unknown>[];
  normalized: KindNormalization[];
  /** Digest input: the content exactly as read. */
  original: { waypoints: unknown[]; tracks: unknown[] };
};

/** SHA-256 of the canonical `{ waypoints, tracks }`, as stored in `contentDigest`. */
export function legacyContentDigest(content: { waypoints: unknown[]; tracks: unknown[] }) {
  return sha256Hex(canonicalJson({ waypoints: content.waypoints, tracks: content.tracks }));
}

/** Maps a kind the UI can't draw to "pin", recording the change. */
function normalizeKind(record: unknown, normalized: KindNormalization[]): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const waypoint = record as Record<string, unknown>;
  if (isMarkKind(waypoint.kind)) return record;
  const from =
    typeof waypoint.kind === "string" ? waypoint.kind : JSON.stringify(waypoint.kind ?? null);
  normalized.push({ id: String(waypoint.id), field: "kind", from: from.slice(0, 64), to: "pin" });
  return { ...waypoint, kind: "pin" };
}

/** Parses and validates fieldline-v1 without changing anything. */
export function parseLegacyContent(
  raw: string,
): { ok: true; content: ParsedLegacy } | Extract<MigrationResult, { ok: false }> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      status: "corrupt-source",
      message: "Saved marks and tracks couldn't be read. They were left untouched.",
    };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return {
      ok: false,
      status: "corrupt-source",
      message: "Saved marks and tracks couldn't be read. They were left untouched.",
    };
  }
  const { version, state } = envelope as { version?: unknown; state?: unknown };
  if (version !== undefined && version !== 0) {
    return {
      ok: false,
      status: "unsupported-source-version",
      message:
        "Saved marks and tracks were written by a different Fieldline version. They were left untouched.",
    };
  }
  const saved =
    state && typeof state === "object"
      ? (state as { waypoints?: unknown; tracks?: unknown })
      : null;
  if (!saved || !Array.isArray(saved.waypoints) || !Array.isArray(saved.tracks)) {
    return {
      ok: false,
      status: "corrupt-source",
      message: "Saved marks and tracks couldn't be read. They were left untouched.",
    };
  }
  const normalized: KindNormalization[] = [];
  const waypoints = saved.waypoints.map((record) => normalizeKind(record, normalized));
  const problems: string[] = [];
  waypoints.forEach((waypoint, index) =>
    problems.push(...waypointProblems(waypoint, `waypoint #${index + 1}`)),
  );
  saved.tracks.forEach((track, index) =>
    problems.push(...trackProblems(track, `track #${index + 1}`)),
  );
  for (const [label, list] of [
    ["waypoint", waypoints],
    ["track", saved.tracks],
  ] as const) {
    const seen = new Set<string>();
    for (const record of list as { id?: unknown }[]) {
      const id = record && typeof record === "object" ? record.id : undefined;
      if (typeof id !== "string") continue;
      if (seen.has(id)) problems.push(`${label} ${id}: id is used more than once`);
      seen.add(id);
    }
  }
  if (problems.length) {
    return {
      ok: false,
      status: "invalid-source-records",
      message: `${problems.length} saved record problem${problems.length === 1 ? "" : "s"} stopped the move to new storage. Nothing was changed.`,
      problems: problems.slice(0, 50),
    };
  }
  return {
    ok: true,
    content: {
      waypoints: waypoints as Record<string, unknown>[],
      tracks: saved.tracks as Record<string, unknown>[],
      normalized,
      original: { waypoints: saved.waypoints, tracks: saved.tracks },
    },
  };
}

function storageFailure(error: unknown): Extract<MigrationResult, { ok: false }> {
  if (error instanceof StorageError) {
    if (error.code === "future-version")
      return {
        ok: false,
        status: "unsupported-database",
        message: error.message,
        code: error.code,
      };
    return { ok: false, status: "storage-error", message: error.message, code: error.code };
  }
  throw error;
}

/**
 * v0 → v1: copy waypoints and tracks from fieldline-v1 into the repository.
 *
 * 1. Read and validate fieldline-v1 (never written).
 * 2. One transaction makes the waypoint and track stores an exact copy of the
 *    source: records are written verbatim, and leftovers from an earlier
 *    interrupted run that the source no longer has are removed. (Until this
 *    step completes the repository is not authoritative; the app still saves
 *    into fieldline-v1.)
 * 3. Read back: counts, ids and every record must equal the source.
 * 4. Only then write the schema and migration records, in a final transaction.
 */
async function migrateLegacy(ctx: MigrationContext): Promise<StepOutcome> {
  let raw: string | null;
  try {
    raw = ctx.legacy.getItem(LEGACY_KEY);
  } catch {
    return {
      ok: false,
      status: "source-unavailable",
      message: "Browser storage couldn't be read, so saved content wasn't moved.",
    };
  }
  let content: ParsedLegacy = {
    waypoints: [],
    tracks: [],
    normalized: [],
    original: { waypoints: [], tracks: [] },
  };
  if (raw !== null) {
    const parsed = parseLegacyContent(raw);
    if (!parsed.ok) return parsed;
    content = parsed.content;
  }
  const sourceDigest = raw === null ? null : await sha256Hex(raw);
  const contentDigest = await legacyContentDigest(content.original);
  const expected = {
    waypoints: new Map(
      content.waypoints.map((record) => [record.id as string, canonicalJson(record)]),
    ),
    tracks: new Map(content.tracks.map((record) => [record.id as string, canonicalJson(record)])),
  };

  try {
    await ctx.backend.write(["meta", "waypoints", "tracks"], async (tx) => {
      const schema = await readSchema(tx);
      if (schema) throw new MigrationRace("Migration already completed elsewhere.");
      await tx.clear("waypoints");
      await tx.clear("tracks");
      for (const record of content.waypoints)
        await tx.put("waypoints", record.id as string, record);
      for (const record of content.tracks) await tx.put("tracks", record.id as string, record);
    });
  } catch (error) {
    if (error instanceof MigrationRace) return { ok: true, raced: true };
    return storageFailure(error);
  }

  let mismatch: string | null;
  try {
    mismatch = await ctx.backend.read(["waypoints", "tracks"], async (tx) => {
      for (const store of ["waypoints", "tracks"] as const) {
        const want = expected[store];
        const keys = await tx.getAllKeys(store);
        if (keys.length !== want.size)
          return `${store}: expected ${want.size}, found ${keys.length}`;
        const records = await tx.getAll<Record<string, unknown>>(store);
        for (let i = 0; i < keys.length; i += 1) {
          const wanted = want.get(keys[i]);
          if (wanted === undefined) return `${store}: unexpected id ${keys[i]}`;
          if (wanted !== canonicalJson(records[i]) || records[i].id !== keys[i])
            return `${store}: ${keys[i]} differs from the saved copy`;
        }
      }
      return null;
    });
  } catch (error) {
    return storageFailure(error);
  }
  if (mismatch) {
    return {
      ok: false,
      status: "verification-failed",
      message: `The new storage didn't match saved content (${mismatch}). Saved content was left untouched.`,
    };
  }

  const counts = { waypoints: content.waypoints.length, tracks: content.tracks.length };
  try {
    await ctx.backend.write(["meta"], async (tx) => {
      if (await readSchema(tx)) throw new MigrationRace("Migration already completed elsewhere.");
      const now = ctx.now();
      const meta: LegacyMigrationMeta = {
        step: "v0-v1",
        completedAt: now,
        source: LEGACY_KEY,
        sourceDigest,
        contentDigest,
        counts,
        normalized: content.normalized.slice(0, 1000),
        normalizedCount: content.normalized.length,
      };
      const schema: SchemaMeta = { version: 1, createdAt: now, lastStep: "v0-v1" };
      await tx.put("meta", LEGACY_MIGRATION_KEY, meta);
      await tx.put("meta", SCHEMA_KEY, schema);
    });
  } catch (error) {
    if (error instanceof MigrationRace) return { ok: true, raced: true };
    return storageFailure(error);
  }
  return { ok: true, counts, empty: raw === null, normalized: content.normalized };
}

/** Steps in order. Add new steps at the end; never edit a shipped one. */
export const MIGRATIONS: readonly MigrationStep[] = [
  { from: 0, to: 1, id: "v0-v1", run: migrateLegacy },
];

/**
 * Brings the repository to `CONTENT_SCHEMA_VERSION`. Safe to call on every
 * start: a completed repository is a no-op, an interrupted run resumes, and
 * any failure leaves fieldline-v1 untouched and the repository unmarked.
 */
export async function runMigrations(ctx: MigrationContext): Promise<MigrationResult> {
  let schema: SchemaMeta | undefined;
  try {
    schema = await ctx.backend.read(["meta"], readSchema);
  } catch (error) {
    return storageFailure(error);
  }
  let version = schema?.version ?? 0;
  if (!Number.isInteger(version) || version < 0) {
    return {
      ok: false,
      status: "unsupported-database",
      message: "The storage version record is damaged. Saved content was left untouched.",
    };
  }
  if (version > CONTENT_SCHEMA_VERSION) {
    return {
      ok: false,
      status: "unsupported-database",
      message:
        "Saved content was written by a newer Fieldline. It was left untouched; update this app to use it.",
    };
  }
  if (version === CONTENT_SCHEMA_VERSION) {
    let counts: MigrationCounts;
    try {
      counts = await ctx.backend.read(["waypoints", "tracks"], async (tx) => ({
        waypoints: await tx.count("waypoints"),
        tracks: await tx.count("tracks"),
      }));
    } catch (error) {
      return storageFailure(error);
    }
    if (await legacyChangedSinceMigration(ctx)) {
      return {
        ok: true,
        status: "legacy-changed-after-migration",
        schemaVersion: version,
        counts,
        message:
          "Marks or tracks in the old saved copy changed after they were moved to the new storage, probably by an older Fieldline. Those changes are not in the new storage and were not merged.",
      };
    }
    return {
      ok: true,
      status: "already-complete",
      schemaVersion: version,
      counts,
      message: "Saved content is up to date.",
    };
  }
  let counts: MigrationCounts = { waypoints: 0, tracks: 0 };
  let normalized: KindNormalization[] = [];
  let empty = true;
  for (const step of MIGRATIONS) {
    if (step.from !== version) continue;
    const outcome = await step.run(ctx);
    if (!outcome.ok) return outcome;
    if (outcome.raced) return runMigrations(ctx);
    counts = outcome.counts;
    normalized = [...normalized, ...outcome.normalized];
    empty = empty && outcome.empty;
    version = step.to;
  }
  if (version !== CONTENT_SCHEMA_VERSION) {
    return {
      ok: false,
      status: "unsupported-database",
      message: `No migration path from content schema ${version}.`,
    };
  }
  return {
    ok: true,
    status: empty ? "nothing-to-migrate" : "migrated",
    schemaVersion: version,
    counts,
    message: empty
      ? "No saved marks or tracks to move."
      : `Moved ${counts.waypoints} mark${counts.waypoints === 1 ? "" : "s"} and ${counts.tracks} track${counts.tracks === 1 ? "" : "s"} to the new storage.${normalized.length ? ` ${normalized.length} mark${normalized.length === 1 ? " had an unknown type and is" : "s had unknown types and are"} now a pin.` : ""}`,
    ...(normalized.length ? { normalized } : {}),
  };
}

/**
 * Whether fieldline-v1's marks/tracks differ from what v0→v1 copied. An
 * unreadable or removed copy counts as changed when content was migrated.
 * If localStorage can't be read, or the step predates the digest, there is
 * nothing to compare and the answer is false.
 */
async function legacyChangedSinceMigration(ctx: MigrationContext): Promise<boolean> {
  let meta: LegacyMigrationMeta | undefined;
  try {
    meta = await ctx.backend.read(["meta"], (tx) =>
      tx.get<LegacyMigrationMeta>("meta", LEGACY_MIGRATION_KEY),
    );
  } catch {
    return false;
  }
  if (!meta || typeof meta.contentDigest !== "string") return false;
  let raw: string | null;
  try {
    raw = ctx.legacy.getItem(LEGACY_KEY);
  } catch {
    return false;
  }
  let content: { waypoints: unknown[]; tracks: unknown[] } | null = { waypoints: [], tracks: [] };
  if (raw !== null) {
    try {
      const state = (JSON.parse(raw) as { state?: { waypoints?: unknown; tracks?: unknown } })
        ?.state;
      content =
        state && Array.isArray(state.waypoints) && Array.isArray(state.tracks)
          ? { waypoints: state.waypoints, tracks: state.tracks }
          : null;
    } catch {
      content = null;
    }
  }
  if (!content) return true;
  try {
    return (await legacyContentDigest(content)) !== meta.contentDigest;
  } catch {
    return true;
  }
}
