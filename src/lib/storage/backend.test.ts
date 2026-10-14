import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryBackend, StorageError } from "./backend.ts";
import { sha256Hex, sha256HexFallback } from "./digest.ts";
import { openIndexedDbBackend, toStorageError } from "./indexeddb.ts";
import { runMigrations } from "./migrations.ts";
import { canonicalJson, isSafeId } from "./records.ts";
import { ContentRepository } from "./repository.ts";
import { fakeLocalStorage, FIXTURE_WAYPOINTS } from "./test-fixtures.ts";

describe("memory backend transactions", () => {
  it("commits all writes of a transaction together, in key order", async () => {
    const backend = new MemoryBackend();
    await backend.write(["waypoints", "meta"], async (tx) => {
      await tx.put("waypoints", "b", { n: 2 });
      await tx.put("waypoints", "a", { n: 1 });
      await tx.put("meta", "x", 1);
    });
    assert.deepEqual(await backend.read(["waypoints"], (tx) => tx.getAll("waypoints")), [
      { n: 1 },
      { n: 2 },
    ]);
    assert.deepEqual(await backend.read(["waypoints"], (tx) => tx.getAllKeys("waypoints")), [
      "a",
      "b",
    ]);
  });

  it("rolls back every write when the callback throws", async () => {
    const backend = new MemoryBackend();
    await backend.write(["waypoints"], (tx) => tx.put("waypoints", "keep", 1));
    await assert.rejects(
      backend.write(["waypoints", "tracks"], async (tx) => {
        await tx.put("waypoints", "new", 2);
        await tx.delete("waypoints", "keep");
        await tx.put("tracks", "t", 3);
        throw new Error("crash");
      }),
      /crash/,
    );
    assert.deepEqual(
      await backend.read(["waypoints", "tracks"], async (tx) => [
        await tx.getAllKeys("waypoints"),
        await tx.count("tracks"),
      ]),
      [["keep"], 0],
    );
  });

  it("rejects use of a store the transaction didn't declare", async () => {
    const backend = new MemoryBackend();
    await assert.rejects(
      backend.write(["waypoints"], (tx) => tx.put("tracks", "t", 1)),
      (error: unknown) => error instanceof StorageError && error.code === "invalid",
    );
  });

  it("clones values so callers can't mutate stored records", async () => {
    const backend = new MemoryBackend();
    const value = { list: [1] };
    await backend.write(["meta"], (tx) => tx.put("meta", "k", value));
    value.list.push(2);
    const read = await backend.read(["meta"], (tx) => tx.get<{ list: number[] }>("meta", "k"));
    assert.deepEqual(read, { list: [1] });
  });

  it("supports prefix ranges", async () => {
    const backend = new MemoryBackend();
    await backend.write(["chunks"], async (tx) => {
      for (const key of ["s1:00000001", "s1:00000000", "s10:00000000", "s2:00000000"])
        await tx.put("chunks", key, key);
    });
    assert.deepEqual(await backend.read(["chunks"], (tx) => tx.getRange("chunks", "s1:")), [
      "s1:00000000",
      "s1:00000001",
    ]);
    await backend.write(["chunks"], (tx) => tx.deleteRange("chunks", "s1:"));
    assert.deepEqual(await backend.read(["chunks"], (tx) => tx.getAllKeys("chunks")), [
      "s10:00000000",
      "s2:00000000",
    ]);
  });

  it("serializes overlapping transactions", async () => {
    const backend = new MemoryBackend();
    await backend.write(["meta"], (tx) => tx.put("meta", "n", 0));
    const bump = () =>
      backend.write(["meta"], async (tx) => {
        const n = (await tx.get<number>("meta", "n")) ?? 0;
        await tx.put("meta", "n", n + 1);
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    assert.equal(await backend.read(["meta"], (tx) => tx.get("meta", "n")), 20);
  });

  it("reports a closed backend as unavailable", async () => {
    const backend = new MemoryBackend();
    backend.close();
    await assert.rejects(
      backend.read(["meta"], (tx) => tx.count("meta")),
      (error: unknown) => error instanceof StorageError && error.code === "unavailable",
    );
  });
});

describe("quota errors", () => {
  it("surface as a typed quota error and write nothing", async () => {
    const backend = new MemoryBackend();
    await runMigrations({ backend, legacy: fakeLocalStorage(), now: () => 1 });
    const repo = new ContentRepository(backend);
    await repo.putWaypoint(FIXTURE_WAYPOINTS[0]);
    backend.quotaBytes = backend.sizeBytes() + 50;
    await assert.rejects(
      repo.putWaypoint({ ...FIXTURE_WAYPOINTS[1], notes: "x".repeat(500) }),
      (error: unknown) => error instanceof StorageError && error.code === "quota",
    );
    assert.equal((await repo.listWaypoints()).length, 1);
  });

  it("surface from an injected commit failure without being turned into success", async () => {
    const backend = new MemoryBackend();
    await runMigrations({ backend, legacy: fakeLocalStorage(), now: () => 1 });
    backend.faults.beforeCommit = () => {
      throw new StorageError("quota", "full");
    };
    await assert.rejects(new ContentRepository(backend).putWaypoint(FIXTURE_WAYPOINTS[0]), {
      name: "StorageError",
      code: "quota",
    });
    backend.faults = {};
    assert.equal((await new ContentRepository(backend).listWaypoints()).length, 0);
  });
});

describe("transaction lifetime (IndexedDB auto-commit)", () => {
  it("fails operations after the callback awaits something other than the transaction", async () => {
    const backend = new MemoryBackend();
    await assert.rejects(
      backend.write(["meta"], async (tx) => {
        await tx.put("meta", "a", 1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        await tx.put("meta", "b", 2);
      }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "aborted" &&
        /no longer active/.test(error.message),
    );
    assert.equal(await backend.read(["meta"], (tx) => tx.count("meta")), 0, "nothing committed");
  });

  it("allows long chains of the transaction's own operations", async () => {
    const backend = new MemoryBackend();
    await backend.write(["meta"], async (tx) => {
      for (let i = 0; i < 2000; i += 1) await tx.put("meta", `k${i}`, i);
    });
    assert.equal(await backend.read(["meta"], (tx) => tx.count("meta")), 2000);
  });
});

describe("IndexedDB open", () => {
  it("closes a connection that succeeds after the open was reported blocked", async () => {
    let closed = false;
    const request: Record<string, any> = { result: { close: () => (closed = true) } };
    const factory = { open: () => request } as unknown as IDBFactory;
    const opening = openIndexedDbBackend({ factory });
    request.onblocked();
    await assert.rejects(opening, { code: "unavailable" });
    request.onsuccess();
    assert.equal(closed, true);
  });
});

describe("IndexedDB error mapping", () => {
  it("maps browser storage exceptions to typed errors", () => {
    const cases = {
      QuotaExceededError: "quota",
      VersionError: "future-version",
      AbortError: "aborted",
      TransactionInactiveError: "aborted",
      InvalidStateError: "unavailable",
      UnknownError: "unavailable",
      DataCloneError: "invalid",
    } as const;
    for (const [name, code] of Object.entries(cases)) {
      const error = toStorageError(new DOMException("x", name));
      assert.equal(error.code, code, name);
      assert.ok(error instanceof StorageError);
    }
  });
});

describe("record helpers", () => {
  it("canonical JSON ignores key order and drops undefined", () => {
    assert.equal(
      canonicalJson({ b: 1, a: [{ d: 1, c: undefined }] }),
      canonicalJson({ a: [{ d: 1 }], b: 1 }),
    );
    assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  });

  it("accepts UUID ids and rejects path-like ids", () => {
    assert.equal(isSafeId("0b6a3c1e-1d2f-4c2a-9e51-3f8f6d1a0001"), true);
    for (const bad of [
      "",
      "../etc",
      "a/b",
      "a\\b",
      "a..b",
      "-x",
      "x y",
      "x\u0000",
      "a".repeat(129),
    ])
      assert.equal(isSafeId(bad), false, bad);
  });

  it("WebCrypto and the fallback SHA-256 agree", async () => {
    for (const text of ["", "abc", "ünïcode 🦌", "x".repeat(1000)]) {
      assert.equal(await sha256Hex(text), sha256HexFallback(new TextEncoder().encode(text)));
    }
    assert.equal(
      sha256HexFallback(new TextEncoder().encode("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
