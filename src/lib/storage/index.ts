/**
 * Durable personal-content storage: backend abstraction (IndexedDB and
 * in-memory), content repository with trash, ordered migrations from
 * `fieldline-v1`, active-recording checkpoints and full backups.
 * See docs/storage.md.
 */
export {
  isStorageError,
  MemoryBackend,
  PERSONAL_STORES,
  REPLACEABLE_STORES,
  StorageError,
  STORES,
  type StorageBackend,
  type StorageErrorCode,
  type StoreName,
} from "./backend.ts";
export {
  estimateStorage,
  IDB_NAME,
  IDB_VERSION,
  openIndexedDbBackend,
  requestPersistentStorage,
  type PersistenceResult,
} from "./indexeddb.ts";
export { CONTENT_SCHEMA_VERSION, ContentRepository } from "./repository.ts";
export {
  LEGACY_KEY,
  runMigrations,
  type LegacySource,
  type MigrationResult,
} from "./migrations.ts";
export {
  CHECKPOINT_LIMITS,
  TrackCheckpointStore,
  type Fix,
  type RecordingSession,
  type RecoveredSession,
} from "./checkpoints.ts";
export { openContentStorage, type ContentStorage } from "./open.ts";
export {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  createBackup,
  parseBackup,
  planRestore,
  readBackupFile,
  restoreBackup,
  type ParseBackupResult,
  type ParsedBackup,
  type RestorePlan,
  type RestoreReport,
} from "./backup.ts";
export type { StoredTrack, StoredTrackPoint, TrashEntry } from "./records.ts";
