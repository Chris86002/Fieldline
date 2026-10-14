import {
  PREFIX_END,
  STORES,
  StorageError,
  type ReadTx,
  type StorageBackend,
  type StoreName,
  type WriteTx,
} from "./backend.ts";

/**
 * IndexedDB backend for the content repository.
 *
 * Database `fieldline-content`, IndexedDB version 1: one object store per
 * entry in `STORES`, out-of-line string keys. Layout changes bump
 * `IDB_VERSION` and add an ordered step to `UPGRADES`; content-level schema
 * changes are tracked separately in the `meta` store (see migrations.ts).
 *
 * A database created by a newer build (higher IndexedDB version) is never
 * opened or modified; opening fails with a `future-version` StorageError.
 * Write transactions request strict durability so a resolved write survives a
 * crash or power loss where the browser supports it.
 */
export const IDB_NAME = "fieldline-content";

const INACTIVE_MESSAGE =
  "The transaction is no longer active. Inside a transaction, await only its own operations.";
export const IDB_VERSION = 1;

/** Ordered layout upgrades, indexed by the version they upgrade to. */
const UPGRADES: Record<number, (db: IDBDatabase) => void> = {
  1: (db) => {
    for (const store of STORES)
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
  },
};

export type OpenIndexedDbOptions = {
  name?: string;
  factory?: IDBFactory;
};

/** Maps IndexedDB/DOM errors to typed storage errors. Never returns "success". */
export function toStorageError(error: unknown, fallback = "Storage failed."): StorageError {
  if (error instanceof StorageError) return error;
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  switch (name) {
    case "QuotaExceededError":
      return new StorageError(
        "quota",
        `Storage is full. Nothing from this change was saved.${detail}`,
        { cause: error },
      );
    case "VersionError":
      return new StorageError(
        "future-version",
        `Saved content was written by a newer Fieldline and was left untouched.${detail}`,
        { cause: error },
      );
    case "AbortError":
    case "TransactionInactiveError":
      return new StorageError(
        "aborted",
        `The storage transaction was aborted; nothing was saved.${detail}`,
        { cause: error },
      );
    case "ConstraintError":
      return new StorageError("conflict", `A stored record already uses that key.${detail}`, {
        cause: error,
      });
    case "DataCloneError":
    case "DataError":
      return new StorageError("invalid", `A record could not be stored.${detail}`, {
        cause: error,
      });
    default:
      return new StorageError("unavailable", `${fallback}${detail}`, { cause: error });
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toStorageError(req.error));
  });
}

function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix + PREFIX_END);
}

export async function openIndexedDbBackend(
  options: OpenIndexedDbOptions = {},
): Promise<IndexedDbBackend> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) throw new StorageError("unavailable", "This browser has no IndexedDB storage.");
  const name = options.name ?? IDB_NAME;
  let openRequest: IDBOpenDBRequest;
  try {
    openRequest = factory.open(name, IDB_VERSION);
  } catch (error) {
    throw toStorageError(error, "Browser storage could not be opened.");
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    // Once the caller has been told "blocked", a late success must not leave
    // an open, unmanaged connection behind (it would block future upgrades).
    let abandoned = false;
    openRequest.onupgradeneeded = (event) => {
      const upgradeDb = openRequest.result;
      for (let version = event.oldVersion + 1; version <= IDB_VERSION; version += 1)
        UPGRADES[version]?.(upgradeDb);
    };
    openRequest.onsuccess = () => {
      if (abandoned) openRequest.result.close();
      else resolve(openRequest.result);
    };
    openRequest.onerror = () =>
      reject(toStorageError(openRequest.error, "Browser storage could not be opened."));
    openRequest.onblocked = () => {
      abandoned = true;
      reject(
        new StorageError(
          "unavailable",
          "Another Fieldline tab is using an older storage layout. Close other Fieldline tabs and reload.",
        ),
      );
    };
  });
  return new IndexedDbBackend(db);
}

export class IndexedDbBackend implements StorageBackend {
  readonly kind = "indexeddb" as const;
  private db: IDBDatabase;
  private closed = false;

  constructor(db: IDBDatabase) {
    this.db = db;
    // Let a newer build in another tab upgrade instead of being blocked forever.
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
    };
  }

  read<T>(stores: readonly StoreName[], fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return this.run(stores, "readonly", fn as (tx: WriteTx) => Promise<T>);
  }

  write<T>(stores: readonly StoreName[], fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    return this.run(stores, "readwrite", fn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private async run<T>(
    stores: readonly StoreName[],
    mode: IDBTransactionMode,
    fn: (tx: WriteTx) => Promise<T>,
  ): Promise<T> {
    if (this.closed)
      throw new StorageError("unavailable", "The storage connection is closed. Reload Fieldline.");
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction([...stores], mode, {
        durability: mode === "readwrite" ? "strict" : "default",
      });
    } catch (error) {
      throw toStorageError(error, "Browser storage is unavailable.");
    }
    let settled = false;
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        settled = true;
        resolve();
      };
      tx.onabort = () => {
        settled = true;
        reject(toStorageError(tx.error ?? new DOMException("Transaction aborted", "AbortError")));
      };
    });
    // Avoid an unhandled rejection while the callback is still running.
    done.catch(() => undefined);
    let result: T;
    try {
      result = await fn(wrap(tx, stores));
    } catch (error) {
      const finishedEarly = settled;
      if (!settled) {
        try {
          tx.abort();
        } catch {
          // Already finishing; the abort/complete handler reports the outcome.
        }
      }
      await done.catch(() => undefined);
      const isDomError = typeof DOMException !== "undefined" && error instanceof DOMException;
      // The transaction auto-committed because the callback awaited something
      // else; Chromium reports the next request as InvalidStateError.
      if (
        isDomError &&
        finishedEarly &&
        (error.name === "InvalidStateError" || error.name === "TransactionInactiveError")
      ) {
        throw new StorageError("aborted", INACTIVE_MESSAGE, { cause: error });
      }
      // Storage failures become typed errors; the caller's own errors pass through unchanged.
      throw isDomError ? toStorageError(error) : error;
    }
    await done;
    return result;
  }
}

function wrap(tx: IDBTransaction, allowed: readonly StoreName[]): WriteTx {
  const store = (name: StoreName) => {
    if (!allowed.includes(name))
      throw new StorageError("invalid", `Store "${name}" is not part of this transaction.`);
    return tx.objectStore(name);
  };
  return {
    get: <T>(name: StoreName, key: string) =>
      request(store(name).get(key)) as Promise<T | undefined>,
    getAll: <T>(name: StoreName) => request(store(name).getAll()) as Promise<T[]>,
    getAllKeys: async (name: StoreName) => (await request(store(name).getAllKeys())).map(String),
    getRange: <T>(name: StoreName, prefix: string) =>
      request(store(name).getAll(prefixRange(prefix))) as Promise<T[]>,
    count: (name: StoreName) => request(store(name).count()),
    put: async (name, key, value) => {
      await request(store(name).put(value, key));
    },
    delete: async (name, key) => {
      await request(store(name).delete(key));
    },
    deleteRange: async (name, prefix) => {
      await request(store(name).delete(prefixRange(prefix)));
    },
    clear: async (name) => {
      await request(store(name).clear());
    },
  };
}

export type PersistenceResult = "granted" | "denied" | "unsupported";

/**
 * Asks the browser not to evict this origin's storage (spec §8). The answer is
 * reported, not assumed: "denied" means content can still be evicted under
 * storage pressure and the UI should say so.
 */
export async function requestPersistentStorage(): Promise<PersistenceResult> {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) return "unsupported";
  try {
    if (storage.persisted && (await storage.persisted())) return "granted";
    return (await storage.persist()) ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

/** Usage and quota in bytes when the browser reports them. */
export async function estimateStorage(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}
