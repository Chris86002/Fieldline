/**
 * Connects the hunt store's marks and tracks to the durable content
 * repository (IndexedDB, src/lib/storage). The store stays the UI's source of
 * truth in memory; every change to marks or tracks is mirrored to the
 * repository in order, deletions go to the trash, and fieldline-v1's copy is
 * frozen at its pre-migration value (ADR-008).
 *
 * If the repository can't be used (migration refused, newer database, storage
 * unavailable), nothing changes from older builds: fieldline-v1 stays the
 * store of record and the reason is reported.
 */
import { create } from "zustand";
import { exportSettings, type SettingsState } from "../../features/settings/schema.ts";
import { createBackup, parseBackup, planRestore, restoreBackup, type ParsedBackup, type RestorePlan } from "../storage/backup.ts";
import type { StorageBackend } from "../storage/backend.ts";
import type { Fix, RecoveredSession } from "../storage/checkpoints.ts";
import { requestPersistentStorage, type PersistenceResult } from "../storage/indexeddb.ts";
import type { LegacySource } from "../storage/migrations.ts";
import { openContentStorage, type ContentStorage } from "../storage/open.ts";
import type { StoredTrack, TrashEntry } from "../storage/records.ts";
import { freezeLegacyContent, unfreezeLegacyContent, useHunt } from "./store.ts";
import type { Track, Waypoint } from "./types.ts";

export type ContentMode = "starting" | "repository" | "legacy";

type SyncState = {
  mode: ContentMode;
  /** Something the user should know about saved content, or null. */
  message: string | null;
  persistence: PersistenceResult | null;
  /** A recording interrupted by a crash or reload, waiting for a decision. */
  recovered: RecoveredSession | null;
  trash: TrashEntry[];
};

export const useContentSync = create<SyncState>()(() => ({
  mode: "starting",
  message: null,
  persistence: null,
  recovered: null,
  trash: [],
}));

let storage: ContentStorage | null = null;
let queue: Promise<void> = Promise.resolve();
let suppress = false;
let unsubscribe: (() => void) | null = null;
let started: Promise<ContentMode> | null = null;

function report(message: string) {
  useContentSync.setState({ message });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("fieldline:content-error"));
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Saving failed.";
}

/** Newest first, as the store keeps them. */
function byNewest<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

function readLegacyContent(legacy: LegacySource): { waypoints: Waypoint[]; tracks: Track[] } {
  try {
    const raw = legacy.getItem("fieldline-v1");
    const state = raw ? (JSON.parse(raw) as { state?: { waypoints?: unknown; tracks?: unknown } }).state : null;
    return {
      waypoints: Array.isArray(state?.waypoints) ? (state.waypoints as Waypoint[]) : [],
      tracks: Array.isArray(state?.tracks) ? (state.tracks as Track[]) : [],
    };
  } catch {
    return { waypoints: [], tracks: [] };
  }
}

/** Changed or new items (by reference) and removed ids between two lists. */
export function diffById<T extends { id: string }>(prev: readonly T[], next: readonly T[]): { puts: T[]; removed: string[] } {
  const before = new Map(prev.map((item) => [item.id, item]));
  const after = new Set<string>();
  const puts: T[] = [];
  for (const item of next) {
    after.add(item.id);
    if (before.get(item.id) !== item) puts.push(item);
  }
  return { puts, removed: prev.filter((item) => !after.has(item.id)).map((item) => item.id) };
}

/** Runs repository work in order; a failure is reported and doesn't stop later work. */
function enqueue(work: () => Promise<void>): Promise<void> {
  const next = queue.then(work).catch((error: unknown) => {
    report(`A change couldn't be saved on this device: ${errorText(error)}`);
  });
  queue = next;
  return next;
}

/** Waits until every queued write has finished (tests, backups). */
export function flushContentWrites(): Promise<void> {
  return queue;
}

async function loadIntoStore() {
  if (!storage) return;
  const [waypoints, tracks] = await Promise.all([storage.repository.listWaypoints(), storage.repository.listTracks()]);
  suppress = true;
  try {
    useHunt.getState().replaceContent(byNewest(waypoints), byNewest(tracks as Track[]));
  } finally {
    suppress = false;
  }
}

export async function refreshTrash() {
  if (!storage || useContentSync.getState().mode !== "repository") return;
  const trash = await storage.repository.listTrash();
  useContentSync.setState({ trash: [...trash].sort((a, b) => b.deletedAt - a.deletedAt) });
}

function watchStore() {
  unsubscribe?.();
  unsubscribe = useHunt.subscribe((state, prev) => {
    if (suppress || !storage) return;
    if (state.waypoints === prev.waypoints && state.tracks === prev.tracks) return;
    const marks = diffById(prev.waypoints, state.waypoints);
    const tracks = diffById(prev.tracks, state.tracks);
    const repo = storage.repository;
    void enqueue(async () => {
      if (marks.puts.length || tracks.puts.length) await repo.putMany({ waypoints: marks.puts, tracks: tracks.puts as StoredTrack[] });
      for (const id of marks.removed) await repo.deleteWaypoint(id);
      for (const id of tracks.removed) await repo.deleteTrack(id);
      if (marks.removed.length || tracks.removed.length) await refreshTrash();
    });
  });
}

/**
 * Opens durable storage once, after the hunt store has hydrated. Resolves to
 * the mode in use. Safe to call more than once.
 */
export function startContentSync(options: { legacy?: LegacySource; open?: () => Promise<StorageBackend> } = {}): Promise<ContentMode> {
  started ??= (async () => {
    const legacy = options.legacy ?? globalThis.localStorage;
    let opened: ContentStorage;
    try {
      opened = await openContentStorage({ legacy, open: options.open });
    } catch (error) {
      unfreezeLegacyContent();
      useContentSync.setState({ mode: "legacy", message: `Saved content stays in browser storage: ${errorText(error)}` });
      return "legacy";
    }
    const { migration } = opened;
    if (!migration.ok || !opened.durable) {
      unfreezeLegacyContent();
      useContentSync.setState({
        mode: "legacy",
        message: !migration.ok ? migration.message : (opened.warning ?? "Browser storage isn't durable here; marks stay in the older storage."),
      });
      return "legacy";
    }
    storage = opened;
    freezeLegacyContent(readLegacyContent(legacy));
    await loadIntoStore();
    watchStore();
    const notes: string[] = [];
    if (migration.status === "legacy-changed-after-migration") {
      notes.push(
        "Marks saved by an older Fieldline after the upgrade weren't copied. Fieldline is using the upgraded copy; the older copy is unchanged. Export it as GPX from that version and bring it in if you need it.",
      );
    }
    if (migration.normalized?.length) {
      notes.push(`${migration.normalized.length} mark${migration.normalized.length === 1 ? " had an unknown type and is" : "s had unknown types and are"} now shown as pins.`);
    }
    useContentSync.setState({ mode: "repository", message: notes.length ? notes.join(" ") : null });
    void refreshTrash();
    void opened.checkpoints
      .getActiveSession()
      .then((recovered) => useContentSync.setState({ recovered }))
      .catch(() => undefined);
    void requestPersistentStorage().then((persistence) => useContentSync.setState({ persistence }));
    return "repository";
  })();
  return started;
}

/**
 * The durable backend while the repository is the store of record (offline
 * map packages share its database), else null.
 */
export function durableBackend(): StorageBackend | null {
  return useContentSync.getState().mode === "repository" ? (storage?.backend ?? null) : null;
}

/* ---------- Trash ---------- */

export async function restoreFromTrash(trashId: string): Promise<void> {
  if (!storage) throw new Error("Trash isn't available in this browser storage mode.");
  const repo = storage.repository;
  await enqueue(async () => {
    await repo.restoreFromTrash(trashId);
    await loadIntoStore();
    await refreshTrash();
  });
}

export async function deleteForever(trashId: string): Promise<void> {
  if (!storage) return;
  const repo = storage.repository;
  await enqueue(async () => {
    await repo.purgeTrash(trashId);
    await refreshTrash();
  });
}

/* ---------- Backup ---------- */

export async function makeBackup(settings: SettingsState, appVersion: string): Promise<string> {
  if (!storage) throw new Error("Full backups need the upgraded storage, which isn't available in this browser. Export GPX instead.");
  await flushContentWrites();
  return createBackup(storage.repository, { settings, appVersion });
}

export type RestoreCheck = { ok: true; backup: ParsedBackup; plan: RestorePlan } | { ok: false; message: string };

export async function checkBackup(text: string): Promise<RestoreCheck> {
  if (!storage) return { ok: false, message: "Restoring needs the upgraded storage, which isn't available in this browser." };
  const parsed = await parseBackup(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  await flushContentWrites();
  return { ok: true, backup: parsed.backup, plan: await planRestore(storage.repository, parsed.backup) };
}

/**
 * Restores a checked backup: content is added (identical records skipped,
 * records that differ from what's here are kept as they are here), then
 * settings are applied through the settings store's own import validation.
 */
export async function applyBackup(backup: ParsedBackup, applySettings: (text: string) => { ok: boolean; message: string }): Promise<string> {
  if (!storage) throw new Error("Restoring needs the upgraded storage.");
  const repo = storage.repository;
  let summary = "";
  await enqueue(async () => {
    const report = await restoreBackup(repo, backup, { onConflict: "keep-existing" });
    await loadIntoStore();
    await refreshTrash();
    const kept = report.conflicts.length;
    summary = `Restored ${report.add.waypoints} marks, ${report.add.tracks} tracks and ${report.add.trash} trash items.${kept ? ` ${kept} item${kept === 1 ? " that differs" : "s that differ"} from this device kept this device's version.` : ""}`;
    // The settings store validates the import again and saves it.
    if (report.settings) summary += ` ${applySettings(exportSettings(report.settings)).message}`;
  });
  return summary;
}

/* ---------- Recording checkpoints (crash-safe track recording) ---------- */

let sessionId: string | null = null;
/** True from beginRecording until finish/cancel, even while the session is still opening. */
let recordingActive = false;

/** Whether the current recording is being checkpointed to durable storage. */
export function isDurableRecording() {
  return Boolean(storage && recordingActive);
}

/**
 * Starts a durable recording when the repository is in use; otherwise
 * recording stays in memory as before. Fixes recorded right away are queued
 * behind the session start, so none are lost.
 */
export function beginRecording(name: string): Promise<boolean> {
  if (!storage) return Promise.resolve(false);
  const checkpoints = storage.checkpoints;
  recordingActive = true;
  sessionId = null;
  let started = false;
  return enqueue(async () => {
    const session = await checkpoints.startSession({ id: crypto.randomUUID(), name });
    sessionId = session.id;
    started = true;
  }).then(() => {
    if (!started) {
      recordingActive = false;
      report("Recording is only kept in memory on this device until it's stopped.");
    }
    return started;
  });
}

export function recordFix(fix: Fix) {
  if (!storage || !recordingActive) return;
  const checkpoints = storage.checkpoints;
  void enqueue(async () => {
    if (sessionId) await checkpoints.appendFixes(sessionId, [fix]);
  });
}

export function recordGap() {
  if (!storage || !recordingActive) return;
  const checkpoints = storage.checkpoints;
  void enqueue(async () => {
    if (sessionId) await checkpoints.markGap(sessionId);
  });
}

/** Saves the recording as a track (written by the checkpoint store) and adds it to the map. */
export async function finishRecording(name?: string): Promise<{ track: Track | null; message: string | null }> {
  if (!storage || !recordingActive) return { track: null, message: null };
  recordingActive = false;
  await flushContentWrites();
  const id = sessionId;
  sessionId = null;
  if (!id) return { track: null, message: null };
  const result = await storage.checkpoints.finalizeSession(id, { name, acceptDamage: true });
  const track = result.track as Track;
  suppress = true;
  try {
    useHunt.getState().addTrack(track);
  } finally {
    suppress = false;
  }
  return {
    track,
    message: result.lostFixes ? `${result.lostFixes} recorded point${result.lostFixes === 1 ? " was" : "s were"} lost and left out.` : null,
  };
}

export async function cancelRecording(): Promise<void> {
  if (!storage || !recordingActive) return;
  recordingActive = false;
  await flushContentWrites();
  const id = sessionId;
  sessionId = null;
  if (id) await storage.checkpoints.discardSession(id);
}

/** Saves an interrupted recording found at startup. */
export async function saveRecovered(): Promise<string> {
  const recovered = useContentSync.getState().recovered;
  if (!storage || !recovered) return "";
  const result = await storage.checkpoints.finalizeSession(recovered.session.id, { acceptDamage: true });
  suppress = true;
  try {
    useHunt.getState().addTrack(result.track as Track);
  } finally {
    suppress = false;
  }
  useContentSync.setState({ recovered: null });
  return result.lostFixes
    ? `Saved the interrupted track. ${result.lostFixes} point${result.lostFixes === 1 ? "" : "s"} couldn't be recovered.`
    : "Saved the interrupted track.";
}

export async function discardRecovered(): Promise<void> {
  const recovered = useContentSync.getState().recovered;
  if (!storage || !recovered) return;
  await storage.checkpoints.discardSession(recovered.session.id);
  useContentSync.setState({ recovered: null });
}

/** Test hook: forget module state between tests. */
export function resetContentSyncForTests() {
  unsubscribe?.();
  unsubscribe = null;
  unfreezeLegacyContent();
  storage = null;
  started = null;
  sessionId = null;
  recordingActive = false;
  queue = Promise.resolve();
  useContentSync.setState({ mode: "starting", message: null, persistence: null, recovered: null, trash: [] });
}
