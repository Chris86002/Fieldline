/**
 * Storage backend contract for personal content: named object stores with
 * string keys, and atomic multi-store transactions. Two implementations:
 * IndexedDB (`indexeddb.ts`, the browser/desktop store) and in-memory (below,
 * for tests and as an explicit non-durable fallback).
 *
 * Transaction rules (they mirror IndexedDB, so code tested in memory behaves
 * the same in a browser):
 * - Declare every store the transaction touches.
 * - Inside the callback, only await this transaction's own operations. Awaiting
 *   anything else (timers, network, `crypto.subtle`) lets IndexedDB auto-commit
 *   and later operations fail. Do slow work before or after.
 * - `write` resolves only after the transaction has committed. If the callback
 *   throws, or the commit fails (quota, abort), nothing is written and the
 *   error is rethrown, as a `StorageError` when it came from storage.
 */

/** Object stores in content schema 1. */
export const STORES = ["waypoints", "tracks", "trash", "sessions", "chunks", "meta"] as const;
export type StoreName = (typeof STORES)[number];

/**
 * Every store in schema 1 holds personal content or its bookkeeping. Cache
 * eviction (clearing replaceable provider data) must never touch these;
 * replaceable stores (offline package caches, wave 2) will be listed separately.
 */
export const PERSONAL_STORES: readonly StoreName[] = STORES;
export const REPLACEABLE_STORES: readonly StoreName[] = [];

export type StorageErrorCode =
  /** The browser refused the write for lack of space. */
  | "quota"
  /** Storage can't be opened or used (private mode, disabled, blocked upgrade, closed). */
  | "unavailable"
  /** The transaction was aborted before commit. */
  | "aborted"
  /** The stored database or schema is newer than this build understands. */
  | "future-version"
  /** The content repository hasn't been initialized by a completed migration. */
  | "not-ready"
  /** The write would overwrite or collide with existing content. */
  | "conflict"
  /** A record failed validation. */
  | "invalid"
  | "not-found";

export class StorageError extends Error {
  code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export function isStorageError(error: unknown, code?: StorageErrorCode): error is StorageError {
  return error instanceof StorageError && (code === undefined || error.code === code);
}

export interface ReadTx {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  /** All values, in key order. */
  getAll<T>(store: StoreName): Promise<T[]>;
  /** All keys, in order. */
  getAllKeys(store: StoreName): Promise<string[]>;
  /** Values whose keys start with `prefix`, in key order. */
  getRange<T>(store: StoreName, prefix: string): Promise<T[]>;
  count(store: StoreName): Promise<number>;
}

export interface WriteTx extends ReadTx {
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  /** Deletes every key that starts with `prefix`. */
  deleteRange(store: StoreName, prefix: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

export interface StorageBackend {
  readonly kind: "indexeddb" | "memory";
  read<T>(stores: readonly StoreName[], fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  write<T>(stores: readonly StoreName[], fn: (tx: WriteTx) => Promise<T>): Promise<T>;
  close(): void;
}

/** Upper bound for keys sharing a prefix (keys are safe ids; see records.ts). */
export const PREFIX_END = "￿";

export type MemoryOp = { type: "put" | "delete" | "clear"; store: StoreName; key?: string };

/**
 * Test hooks. `onOp` runs before each write operation and `beforeCommit`
 * before a write transaction commits; throwing from either aborts the whole
 * transaction, which is how tests simulate crashes and storage failures.
 */
export type MemoryFaults = {
  onOp?: (op: MemoryOp) => void;
  beforeCommit?: () => void;
};

export type MemoryBackendOptions = {
  /** Simulated quota: a commit that would make the stored JSON larger than this fails with a `quota` StorageError. */
  quotaBytes?: number;
};

/**
 * In-memory backend with the same transaction semantics as IndexedDB:
 * transactions are serialized, writes are staged and applied only on commit,
 * values are structured-cloned in and out. Data lives as long as the object,
 * so tests simulate an app restart by opening a new repository over the same
 * backend.
 */
export class MemoryBackend implements StorageBackend {
  readonly kind = "memory" as const;
  faults: MemoryFaults = {};
  quotaBytes: number | undefined;
  private data = new Map<StoreName, Map<string, unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: MemoryBackendOptions = {}) {
    this.quotaBytes = options.quotaBytes;
    for (const store of STORES) this.data.set(store, new Map());
  }

  /** Approximate stored size: the JSON length of every value. */
  sizeBytes(data: Map<StoreName, Map<string, unknown>> = this.data): number {
    let total = 0;
    for (const [, records] of data) {
      for (const [key, value] of records) total += key.length + JSON.stringify(value).length;
    }
    return total;
  }

  read<T>(stores: readonly StoreName[], fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.checkOpen();
      return fn(this.readTx(this.data, stores));
    });
  }

  write<T>(stores: readonly StoreName[], fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.checkOpen();
      const staged = new Map(this.data);
      for (const store of stores) staged.set(store, new Map(this.data.get(store)));
      const tx = this.writeTx(staged, stores);
      const result = await fn(tx);
      this.faults.beforeCommit?.();
      if (this.quotaBytes !== undefined && this.sizeBytes(staged) > this.quotaBytes) {
        throw new StorageError("quota", "Storage is full. Nothing from this change was saved.");
      }
      this.data = staged;
      return result;
    });
  }

  close() {
    this.closed = true;
  }

  private checkOpen() {
    if (this.closed) throw new StorageError("unavailable", "The storage connection is closed.");
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private access(
    data: Map<StoreName, Map<string, unknown>>,
    allowed: readonly StoreName[],
    store: StoreName,
  ) {
    if (!allowed.includes(store))
      throw new StorageError("invalid", `Store "${store}" is not part of this transaction.`);
    const records = data.get(store);
    if (!records) throw new StorageError("unavailable", `Store "${store}" does not exist.`);
    return records;
  }

  private readTx(
    data: Map<StoreName, Map<string, unknown>>,
    allowed: readonly StoreName[],
  ): ReadTx {
    const sortedKeys = (store: StoreName) =>
      [...this.access(data, allowed, store).keys()].sort(compareKeys);
    return {
      get: async <T>(store: StoreName, key: string) => {
        const records = this.access(data, allowed, store);
        return records.has(key) ? (structuredClone(records.get(key)) as T) : undefined;
      },
      getAll: async <T>(store: StoreName) => {
        const records = this.access(data, allowed, store);
        return sortedKeys(store).map((key) => structuredClone(records.get(key)) as T);
      },
      getAllKeys: async (store: StoreName) => sortedKeys(store),
      getRange: async <T>(store: StoreName, prefix: string) => {
        const records = this.access(data, allowed, store);
        return sortedKeys(store)
          .filter((key) => key.startsWith(prefix))
          .map((key) => structuredClone(records.get(key)) as T);
      },
      count: async (store: StoreName) => this.access(data, allowed, store).size,
    };
  }

  private writeTx(
    data: Map<StoreName, Map<string, unknown>>,
    allowed: readonly StoreName[],
  ): WriteTx {
    const op = (type: MemoryOp["type"], store: StoreName, key?: string) => {
      const records = this.access(data, allowed, store);
      this.faults.onOp?.({ type, store, key });
      return records;
    };
    return {
      ...this.readTx(data, allowed),
      put: async (store, key, value) => {
        if (typeof key !== "string" || !key)
          throw new StorageError("invalid", "Records need a key.");
        op("put", store, key).set(key, structuredClone(value));
      },
      delete: async (store, key) => {
        op("delete", store, key).delete(key);
      },
      deleteRange: async (store, prefix) => {
        const records = op("delete", store, prefix);
        for (const key of [...records.keys()]) if (key.startsWith(prefix)) records.delete(key);
      },
      clear: async (store) => {
        op("clear", store).clear();
      },
    };
  }
}

/** IndexedDB orders string keys by UTF-16 code units, which is what `<` does. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
