import type { Waypoint } from "@/lib/hunt/types";
import {
  DEFAULT_SETTINGS,
  exportSettings,
  importSettings,
  type SettingKey,
  type SettingsState,
} from "../../features/settings/schema.ts";
import { StorageError } from "./backend.ts";
import { sha256Hex } from "./digest.ts";
import {
  canonicalJson,
  LIMITS,
  sameRecord,
  trackProblems,
  trashProblems,
  waypointProblems,
  type StoredTrack,
  type TrashEntry,
} from "./records.ts";
import { assertReady, CONTENT_SCHEMA_VERSION, type ContentRepository } from "./repository.ts";

/**
 * Complete Fieldline backup (spec §8): settings, waypoints, tracks and trash
 * in one JSON file with a SHA-256 integrity digest. GPX stays the
 * interchange format; this is the file that restores a whole profile.
 *
 * {
 *   format: "fieldline-backup", version: 1, createdAt: ISO-8601,
 *   app: { name: "Fieldline", version }, contentSchema: 1,
 *   settings: <fieldline-settings export object> | null,
 *   content: { waypoints: [...], tracks: [...], trash: [...] },
 *   counts: { waypoints, tracks, trash },
 *   integrity: { algorithm: "SHA-256", digest: <hex of canonical JSON of every other member> }
 * }
 *
 * Active recording sessions are not included: finish or discard a recording
 * before backing up.
 */
export const BACKUP_FORMAT = "fieldline-backup";
export const BACKUP_VERSION = 1;

export type BackupLimits = {
  bytes: number;
  waypoints: number;
  tracks: number;
  trash: number;
  pointsPerTrack: number;
  totalPoints: number;
};

export const BACKUP_LIMITS: BackupLimits = {
  /** Characters of backup text (about bytes; content is mostly ASCII). */
  bytes: 150 * 1024 * 1024,
  waypoints: 50_000,
  tracks: 10_000,
  trash: 20_000,
  pointsPerTrack: LIMITS.trackPoints,
  totalPoints: 5_000_000,
};

export type BackupContent = { waypoints: Waypoint[]; tracks: StoredTrack[]; trash: TrashEntry[] };

export type ParsedBackup = {
  version: number;
  createdAt: string;
  appVersion: string;
  content: BackupContent;
  /** Validated settings, ready for the settings store; null when the backup has none. */
  settings: SettingsState | null;
  /** Settings values in the backup that failed validation and were left at their defaults. */
  rejectedSettings: SettingKey[];
};

export type BackupError =
  | "too-large"
  | "damaged"
  | "not-a-backup"
  | "future-version"
  | "checksum-mismatch"
  | "too-many-records"
  | "invalid-records"
  | "invalid-settings";

export type ParseBackupResult =
  | { ok: true; backup: ParsedBackup }
  | { ok: false; error: BackupError; message: string; problems?: string[] };

/** Reads the repository and settings into backup text. One read transaction, so the snapshot is consistent. */
export async function createBackup(
  repo: ContentRepository,
  options: { settings: SettingsState | null; appVersion: string; now?: Date },
): Promise<string> {
  const now = options.now ?? new Date();
  const content = await repo.backend.read(["meta", "waypoints", "tracks", "trash"], async (tx) => {
    await assertReady(tx);
    return {
      waypoints: await tx.getAll<Waypoint>("waypoints"),
      tracks: await tx.getAll<StoredTrack>("tracks"),
      trash: await tx.getAll<TrashEntry>("trash"),
    };
  });
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    app: { name: "Fieldline", version: options.appVersion },
    contentSchema: CONTENT_SCHEMA_VERSION,
    settings: options.settings
      ? (JSON.parse(exportSettings(options.settings, now)) as Record<string, unknown>)
      : null,
    content,
    counts: {
      waypoints: content.waypoints.length,
      tracks: content.tracks.length,
      trash: content.trash.length,
    },
  };
  const digest = await sha256Hex(canonicalJson(payload));
  return JSON.stringify({ ...payload, integrity: { algorithm: "SHA-256", digest } });
}

/** Suggested file name for a backup. */
export function backupFileName(now = new Date()): string {
  return `fieldline-backup-${now.toISOString().slice(0, 10)}.json`;
}

/** Reads a chosen backup file, refusing oversized files before loading them. */
export async function readBackupFile(
  file: Blob,
  limits: BackupLimits = BACKUP_LIMITS,
): Promise<ParseBackupResult> {
  if (file.size > limits.bytes)
    return {
      ok: false,
      error: "too-large",
      message: "That file is too large to be a Fieldline backup.",
    };
  return parseBackup(await file.text(), limits);
}

function fail(error: BackupError, message: string, problems?: string[]): ParseBackupResult {
  return problems
    ? { ok: false, error, message, problems: problems.slice(0, 50) }
    : { ok: false, error, message };
}

const DAMAGED = "That backup is damaged or incomplete. Nothing was restored.";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function duplicateIds(list: { id?: unknown }[], label: string): string[] {
  const seen = new Set<unknown>();
  const problems: string[] = [];
  for (const record of list) {
    if (seen.has(record.id))
      problems.push(`${label} ${String(record.id)}: id is used more than once`);
    seen.add(record.id);
  }
  return problems;
}

/**
 * Validates backup text completely before anything is written: size, format,
 * version, counts, checksum, every record and the settings block. Never
 * touches storage.
 */
export async function parseBackup(
  text: string,
  limits: BackupLimits = BACKUP_LIMITS,
): Promise<ParseBackupResult> {
  if (text.length > limits.bytes)
    return fail("too-large", "That file is too large to be a Fieldline backup.");
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fail("damaged", DAMAGED);
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT)
    return fail("not-a-backup", "That file isn't a Fieldline backup.");
  const { version, contentSchema, integrity, content, counts, createdAt, app, settings } = raw;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    return fail("damaged", DAMAGED);
  if (version > BACKUP_VERSION)
    return fail(
      "future-version",
      "That backup comes from a newer Fieldline. Update this app first.",
    );
  if (typeof contentSchema !== "number" || !Number.isInteger(contentSchema) || contentSchema < 1)
    return fail("damaged", DAMAGED);
  if (contentSchema > CONTENT_SCHEMA_VERSION)
    return fail(
      "future-version",
      "That backup comes from a newer Fieldline. Update this app first.",
    );
  if (typeof createdAt !== "string" || !isObject(app) || typeof app.version !== "string")
    return fail("damaged", DAMAGED);
  if (
    !isObject(integrity) ||
    integrity.algorithm !== "SHA-256" ||
    typeof integrity.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(integrity.digest)
  ) {
    return fail("damaged", DAMAGED);
  }
  if (!isObject(content) || !isObject(counts)) return fail("damaged", DAMAGED);
  const { waypoints, tracks, trash } = content;
  if (!Array.isArray(waypoints) || !Array.isArray(tracks) || !Array.isArray(trash))
    return fail("damaged", DAMAGED);
  if (
    counts.waypoints !== waypoints.length ||
    counts.tracks !== tracks.length ||
    counts.trash !== trash.length
  )
    return fail("damaged", DAMAGED);

  if (
    waypoints.length > limits.waypoints ||
    tracks.length > limits.tracks ||
    trash.length > limits.trash
  ) {
    return fail(
      "too-many-records",
      "That backup has more records than Fieldline can restore at once. Nothing was restored.",
    );
  }
  let totalPoints = 0;
  for (const track of [...tracks, ...trash.map((entry) => (isObject(entry) ? entry.item : null))]) {
    const points = isObject(track) && Array.isArray(track.points) ? track.points.length : 0;
    if (points > limits.pointsPerTrack)
      return fail(
        "too-many-records",
        "A track in that backup is longer than Fieldline supports. Nothing was restored.",
      );
    totalPoints += points;
  }
  if (totalPoints > limits.totalPoints)
    return fail(
      "too-many-records",
      "That backup has more track points than Fieldline can restore. Nothing was restored.",
    );

  const payload: Record<string, unknown> = { ...raw };
  delete payload.integrity;
  if ((await sha256Hex(canonicalJson(payload))) !== integrity.digest) {
    return fail(
      "checksum-mismatch",
      "That backup was changed or damaged after it was made. Nothing was restored.",
    );
  }

  const problems: string[] = [];
  waypoints.forEach((record, index) =>
    problems.push(...waypointProblems(record, `waypoint #${index + 1}`)),
  );
  tracks.forEach((record, index) =>
    problems.push(...trackProblems(record, `track #${index + 1}`, limits.pointsPerTrack)),
  );
  trash.forEach((record, index) =>
    problems.push(...trashProblems(record, `trash entry #${index + 1}`)),
  );
  if (!problems.length) {
    problems.push(
      ...duplicateIds(waypoints, "waypoint"),
      ...duplicateIds(tracks, "track"),
      ...duplicateIds(trash, "trash entry"),
    );
  }
  if (problems.length)
    return fail(
      "invalid-records",
      "Some records in that backup aren't valid. Nothing was restored.",
      problems,
    );

  let parsedSettings: SettingsState | null = null;
  let rejectedSettings: SettingKey[] = [];
  if (settings !== null) {
    if (!isObject(settings))
      return fail(
        "invalid-settings",
        "The settings in that backup are damaged. Nothing was restored.",
      );
    const result = importSettings(JSON.stringify(settings), {
      prefs: { ...DEFAULT_SETTINGS },
      preset: null,
      presetEdits: {},
    });
    if (!result.ok)
      return fail(
        "invalid-settings",
        `The settings in that backup can't be used: ${result.error} Nothing was restored.`,
      );
    parsedSettings = result.state;
    rejectedSettings = result.rejected;
  }

  return {
    ok: true,
    backup: {
      version,
      createdAt,
      appVersion: app.version,
      content: {
        waypoints: waypoints as Waypoint[],
        tracks: tracks as StoredTrack[],
        trash: trash as TrashEntry[],
      },
      settings: parsedSettings,
      rejectedSettings,
    },
  };
}

export type RestoreConflict = { kind: "waypoint" | "track" | "trash"; id: string };

export type RestorePlan = {
  /** Records that will be added. */
  add: { waypoints: number; tracks: number; trash: number };
  /** Records already present with identical content; skipped, never duplicated. */
  identical: { waypoints: number; tracks: number; trash: number };
  /** Records whose id exists here with different content; the existing record is never overwritten. */
  conflicts: RestoreConflict[];
};

export type RestorePolicy = {
  /**
   * "abort" (default): any conflict cancels the restore with nothing written.
   * "keep-existing": add new records, keep this profile's version of each
   * conflicting record, and report every conflict.
   */
  onConflict?: "abort" | "keep-existing";
};

export type RestoreReport = RestorePlan & {
  /** Settings to apply through the settings store, or null when the backup had none. */
  settings: SettingsState | null;
  rejectedSettings: SettingKey[];
};

type Classified = {
  plan: RestorePlan;
  toAdd: { waypoints: Waypoint[]; tracks: StoredTrack[]; trash: TrashEntry[] };
};

async function classify(
  tx: { get<T>(store: "waypoints" | "tracks" | "trash", key: string): Promise<T | undefined> },
  content: BackupContent,
): Promise<Classified> {
  const plan: RestorePlan = {
    add: { waypoints: 0, tracks: 0, trash: 0 },
    identical: { waypoints: 0, tracks: 0, trash: 0 },
    conflicts: [],
  };
  const toAdd: Classified["toAdd"] = { waypoints: [], tracks: [], trash: [] };
  const groups = [
    ["waypoints", "waypoint", content.waypoints],
    ["tracks", "track", content.tracks],
    ["trash", "trash", content.trash],
  ] as const;
  for (const [store, kind, records] of groups) {
    for (const record of records) {
      const existing = await tx.get<unknown>(store, record.id);
      if (existing === undefined) {
        plan.add[store] += 1;
        (toAdd[store] as unknown[]).push(record);
      } else if (sameRecord(existing, record)) {
        plan.identical[store] += 1;
      } else {
        plan.conflicts.push({ kind, id: record.id });
      }
    }
  }
  return { plan, toAdd };
}

/** What restoring would do, without writing anything. */
export function planRestore(repo: ContentRepository, backup: ParsedBackup): Promise<RestorePlan> {
  return repo.backend.read(["meta", "waypoints", "tracks", "trash"], async (tx) => {
    await assertReady(tx);
    return (await classify(tx, backup.content)).plan;
  });
}

/**
 * Restores a parsed backup in one transaction: either every planned record is
 * written or none is. Identical records are skipped; conflicts follow the
 * policy and are always reported. Settings are returned for the caller to
 * apply through the settings store after the content commit.
 */
export async function restoreBackup(
  repo: ContentRepository,
  backup: ParsedBackup,
  policy: RestorePolicy = {},
): Promise<RestoreReport> {
  const onConflict = policy.onConflict ?? "abort";
  const plan = await repo.backend.write(["meta", "waypoints", "tracks", "trash"], async (tx) => {
    await assertReady(tx);
    const { plan, toAdd } = await classify(tx, backup.content);
    if (plan.conflicts.length && onConflict === "abort") {
      throw new StorageError(
        "conflict",
        `${plan.conflicts.length} record${plan.conflicts.length === 1 ? "" : "s"} in the backup differ from ones already here. Nothing was restored.`,
      );
    }
    for (const record of toAdd.waypoints) await tx.put("waypoints", record.id, record);
    for (const record of toAdd.tracks) await tx.put("tracks", record.id, record);
    for (const record of toAdd.trash) await tx.put("trash", record.id, record);
    return plan;
  });
  return { ...plan, settings: backup.settings, rejectedSettings: backup.rejectedSettings };
}
