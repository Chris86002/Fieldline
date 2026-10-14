import type { Waypoint } from "@/lib/hunt/types";
import {
  REPLACEABLE_STORES,
  StorageError,
  type ReadTx,
  type StorageBackend,
  type StoreName,
  type WriteTx,
} from "./backend.ts";
import {
  trashKey,
  trackProblems,
  waypointProblems,
  type ContentKind,
  type StoredTrack,
  type TrashEntry,
} from "./records.ts";

/** Content schema version this build reads and writes (meta store, key "schema"). */
export const CONTENT_SCHEMA_VERSION = 1;

export type SchemaMeta = {
  version: number;
  /** When the schema record was first written (the completed migration). */
  createdAt: number;
  /** Which migration step wrote it last, e.g. "v0-v1". */
  lastStep: string;
};

export const SCHEMA_KEY = "schema";

export async function readSchema(tx: ReadTx): Promise<SchemaMeta | undefined> {
  return tx.get<SchemaMeta>("meta", SCHEMA_KEY);
}

/**
 * Throws unless the repository was initialized by a completed migration with
 * this build's schema. Called inside every content write transaction, so a
 * write can never land in an unmigrated or newer-schema database.
 */
export async function assertReady(tx: ReadTx): Promise<void> {
  const schema = await readSchema(tx);
  if (!schema)
    throw new StorageError("not-ready", "Saved content hasn't been moved to the new storage yet.");
  if (schema.version > CONTENT_SCHEMA_VERSION) {
    throw new StorageError(
      "future-version",
      "Saved content was written by a newer Fieldline. It was left untouched; update this app.",
    );
  }
}

const STORE_OF: Record<ContentKind, StoreName> = { waypoint: "waypoints", track: "tracks" };

function assertWaypoint(value: unknown): asserts value is Waypoint {
  const problems = waypointProblems(value);
  if (problems.length) throw new StorageError("invalid", problems.join("; "));
}

function assertTrack(value: unknown): asserts value is StoredTrack {
  const problems = trackProblems(value);
  if (problems.length) throw new StorageError("invalid", problems.join("; "));
}

/**
 * Personal content (waypoints, tracks, trash) over a storage backend. Every
 * method is one transaction: it either commits completely or throws a
 * `StorageError` with nothing written. Reads work on any schema this build
 * can parse; writes require a completed migration (see migrations.ts).
 */
export class ContentRepository {
  readonly backend: StorageBackend;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /** Stored schema version, or null before the first migration completed. */
  async schemaVersion(): Promise<number | null> {
    const schema = await this.backend.read(["meta"], readSchema);
    return schema?.version ?? null;
  }

  async isReady(): Promise<boolean> {
    try {
      await this.backend.read(["meta"], assertReady);
      return true;
    } catch (error) {
      if (
        error instanceof StorageError &&
        (error.code === "not-ready" || error.code === "future-version")
      )
        return false;
      throw error;
    }
  }

  listWaypoints(): Promise<Waypoint[]> {
    return this.backend.read(["waypoints"], (tx) => tx.getAll<Waypoint>("waypoints"));
  }

  listTracks(): Promise<StoredTrack[]> {
    return this.backend.read(["tracks"], (tx) => tx.getAll<StoredTrack>("tracks"));
  }

  getWaypoint(id: string): Promise<Waypoint | undefined> {
    return this.backend.read(["waypoints"], (tx) => tx.get<Waypoint>("waypoints", id));
  }

  getTrack(id: string): Promise<StoredTrack | undefined> {
    return this.backend.read(["tracks"], (tx) => tx.get<StoredTrack>("tracks", id));
  }

  async counts(): Promise<{ waypoints: number; tracks: number; trash: number }> {
    return this.backend.read(["waypoints", "tracks", "trash"], async (tx) => ({
      waypoints: await tx.count("waypoints"),
      tracks: await tx.count("tracks"),
      trash: await tx.count("trash"),
    }));
  }

  /** Adds or replaces one waypoint. */
  async putWaypoint(waypoint: Waypoint): Promise<void> {
    assertWaypoint(waypoint);
    return this.backend.write(["meta", "waypoints"], async (tx) => {
      await assertReady(tx);
      await tx.put("waypoints", waypoint.id, waypoint);
    });
  }

  /** Adds or replaces one track. */
  async putTrack(track: StoredTrack): Promise<void> {
    assertTrack(track);
    return this.backend.write(["meta", "tracks"], async (tx) => {
      await assertReady(tx);
      await tx.put("tracks", track.id, track);
    });
  }

  /** Adds or replaces several records in one transaction (e.g. a GPX import). */
  async putMany(content: { waypoints?: Waypoint[]; tracks?: StoredTrack[] }): Promise<void> {
    const waypoints = content.waypoints ?? [];
    const tracks = content.tracks ?? [];
    waypoints.forEach(assertWaypoint);
    tracks.forEach(assertTrack);
    return this.backend.write(["meta", "waypoints", "tracks"], async (tx) => {
      await assertReady(tx);
      for (const waypoint of waypoints) await tx.put("waypoints", waypoint.id, waypoint);
      for (const track of tracks) await tx.put("tracks", track.id, track);
    });
  }

  /** Moves a waypoint to the trash. Returns the trash entry. */
  deleteWaypoint(id: string, now = Date.now()): Promise<TrashEntry> {
    return this.moveToTrash("waypoint", id, now);
  }

  /** Moves a track to the trash. Returns the trash entry. */
  deleteTrack(id: string, now = Date.now()): Promise<TrashEntry> {
    return this.moveToTrash("track", id, now);
  }

  private moveToTrash(kind: ContentKind, id: string, now: number): Promise<TrashEntry> {
    const store = STORE_OF[kind];
    return this.backend.write(["meta", store, "trash"], async (tx) => {
      await assertReady(tx);
      const item = await tx.get<Waypoint | StoredTrack>(store, id);
      if (!item) throw new StorageError("not-found", `That ${kind} no longer exists.`);
      const entry: TrashEntry = {
        id: trashKey(kind, id, now),
        kind,
        itemId: id,
        deletedAt: now,
        item,
      };
      if (await tx.get("trash", entry.id))
        throw new StorageError("conflict", `That ${kind} is already in the trash.`);
      await tx.put("trash", entry.id, entry);
      await tx.delete(store, id);
      return entry;
    });
  }

  /** Trash entries, newest deletion first. */
  async listTrash(): Promise<TrashEntry[]> {
    const entries = await this.backend.read(["trash"], (tx) => tx.getAll<TrashEntry>("trash"));
    return entries.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /**
   * Puts a trashed item back with its original id and content. Fails with
   * `conflict` (nothing changed) if a live item already uses that id.
   */
  restoreFromTrash(trashId: string): Promise<Waypoint | StoredTrack> {
    return this.backend.write(["meta", "waypoints", "tracks", "trash"], async (tx) => {
      await assertReady(tx);
      const entry = await tx.get<TrashEntry>("trash", trashId);
      if (!entry) throw new StorageError("not-found", "That item is no longer in the trash.");
      const store = STORE_OF[entry.kind];
      if (await tx.get(store, entry.itemId)) {
        throw new StorageError(
          "conflict",
          `A ${entry.kind} with the same id already exists, so the trashed copy was kept in the trash.`,
        );
      }
      await tx.put(store, entry.itemId, entry.item);
      await tx.delete("trash", trashId);
      return entry.item;
    });
  }

  /** Permanently deletes one trash entry. This cannot be undone. */
  purgeTrash(trashId: string): Promise<void> {
    return this.backend.write(["meta", "trash"], async (tx) => {
      await assertReady(tx);
      if (!(await tx.get("trash", trashId)))
        throw new StorageError("not-found", "That item is no longer in the trash.");
      await tx.delete("trash", trashId);
    });
  }

  /** Permanently deletes everything in the trash. Only for an explicit user action. */
  emptyTrash(): Promise<number> {
    return this.backend.write(["meta", "trash"], async (tx) => {
      await assertReady(tx);
      const count = await tx.count("trash");
      await tx.clear("trash");
      return count;
    });
  }

  /**
   * Clears replaceable data only (provider caches, once wave 2 adds stores for
   * them). Personal content, the trash and recording sessions are never in
   * that list, so cache eviction can't delete them. Returns the stores cleared.
   */
  async clearReplaceableData(): Promise<StoreName[]> {
    const stores = [...REPLACEABLE_STORES];
    if (!stores.length) return [];
    await this.backend.write(stores, async (tx: WriteTx) => {
      for (const store of stores) await tx.clear(store);
    });
    return stores;
  }
}
