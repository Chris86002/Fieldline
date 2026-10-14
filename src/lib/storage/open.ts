import { MemoryBackend, StorageError, type StorageBackend } from "./backend.ts";
import { TrackCheckpointStore } from "./checkpoints.ts";
import { openIndexedDbBackend } from "./indexeddb.ts";
import { runMigrations, type LegacySource, type MigrationResult } from "./migrations.ts";
import { ContentRepository } from "./repository.ts";

export type ContentStorage = {
  backend: StorageBackend;
  repository: ContentRepository;
  checkpoints: TrackCheckpointStore;
  migration: MigrationResult;
  /**
   * False when IndexedDB couldn't be opened and an in-memory fallback is in
   * use: nothing written to it survives a reload, and the UI must say so and
   * keep fieldline-v1 as the store of record.
   */
  durable: boolean;
  /** Why storage isn't durable, when it isn't. */
  warning: string | null;
};

/**
 * Opens IndexedDB and runs pending migrations. When IndexedDB is missing or
 * refuses to open, falls back to memory with `durable: false`, except when the
 * database is from a newer build: that is reported as a failed migration and
 * nothing is written anywhere.
 */
export async function openContentStorage(options: {
  legacy: LegacySource;
  now?: () => number;
  open?: () => Promise<StorageBackend>;
}): Promise<ContentStorage> {
  const now = options.now ?? Date.now;
  let backend: StorageBackend;
  let durable = true;
  let warning: string | null = null;
  try {
    backend = await (options.open ?? openIndexedDbBackend)();
  } catch (error) {
    if (error instanceof StorageError && error.code === "future-version") {
      backend = new MemoryBackend();
      return {
        backend,
        repository: new ContentRepository(backend),
        checkpoints: new TrackCheckpointStore(backend, { now }),
        migration: {
          ok: false,
          status: "unsupported-database",
          message: error.message,
          code: error.code,
        },
        durable: false,
        warning: error.message,
      };
    }
    backend = new MemoryBackend();
    durable = false;
    warning = error instanceof Error ? error.message : "Browser storage is unavailable.";
  }
  const migration = await runMigrations({ backend, legacy: options.legacy, now });
  return {
    backend,
    repository: new ContentRepository(backend),
    checkpoints: new TrackCheckpointStore(backend, { now }),
    migration,
    durable,
    warning,
  };
}
