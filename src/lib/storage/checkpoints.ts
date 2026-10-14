import { StorageError, type ReadTx, type StorageBackend } from "./backend.ts";
import { isSafeId, LIMITS, type StoredTrack, type StoredTrackPoint } from "./records.ts";
import { assertReady } from "./repository.ts";

/**
 * Active-recording checkpoints (spec §9; the `TrackCheckpointStore` proposed
 * in docs/phone-strategy.md, for CC-06).
 *
 * A recording session is one record in `sessions`; its fixes live in bounded
 * chunks in `chunks`, keyed `${sessionId}:${seq}`. Session ids can't contain
 * ":", so one session's key range never overlaps another's. Each append tops
 * up the session's last chunk (same segment, below the cap) and adds new
 * chunks as needed, together with the updated session, in one transaction:
 * after a crash or restart the session reads back with exactly the fixes
 * whose append had resolved. Gaps (signal loss, pause) start a new segment
 * instead of joining points across the gap.
 *
 * The session record counts its chunks and fixes, so a chunk that disappears
 * or is damaged is detected and reported, never silently dropped.
 */

/** One accepted location fix. Unknown values are null, never 0. */
export type Fix = {
  lng: number;
  lat: number;
  /** Fix time, ms since epoch. */
  t: number;
  /** Horizontal accuracy radius, meters. */
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  /** m/s */
  speed: number | null;
  /** Degrees clockwise from true north (GPS course), 0–360. */
  heading: number | null;
};

export type RecordingSession = {
  id: string;
  name: string;
  startedAt: number;
  updatedAt: number;
  status: "recording" | "paused";
  /** Next chunk sequence number; chunks 0..nextSeq-1 must exist. */
  nextSeq: number;
  /** Fixes committed in total; the chunks must add up to this. */
  fixCount: number;
  /** Current segment index; fixes appended now belong to it. */
  segment: number;
  /** Whether the current segment already has fixes (a gap only starts a new segment after one). */
  segmentHasFixes: boolean;
};

export type FixChunk = { sessionId: string; seq: number; segment: number; fixes: Fix[] };

/** What is missing from a session compared with what it says it committed. */
export type RecordingDamage = {
  /** Chunks present but unreadable or inconsistent (left out). */
  damagedChunks: number;
  /** Chunks the session committed that are no longer stored. */
  missingChunks: number;
  /** Committed fixes that can't be recovered (session count minus recovered count). */
  lostFixes: number;
};

export type RecoveredSession = RecordingDamage & {
  session: RecordingSession;
  /** Recovered fixes, split at gaps. Empty segments are omitted. */
  segments: Fix[][];
  /** Fixes recovered. */
  fixCount: number;
  /** True when every committed fix was recovered. */
  intact: boolean;
};

export type FinalizedRecording = RecordingDamage & {
  track: StoredTrack;
};

export const CHECKPOINT_LIMITS = {
  /** Fixes per stored chunk. */
  fixesPerChunk: 250,
  /** Fixes per `appendFixes` call. */
  fixesPerAppend: 2_000,
  /** Fixes per session (48 h at one fix per second, below the track point limit). */
  fixesPerSession: 172_800,
} as const;

const SEQ_WIDTH = 8;

/** Session ids are safe ids without ":", the chunk-key delimiter. */
export function isSafeSessionId(value: unknown): value is string {
  return isSafeId(value) && !value.includes(":");
}

export function chunkKey(sessionId: string, seq: number): string {
  return `${sessionId}:${String(seq).padStart(SEQ_WIDTH, "0")}`;
}

function chunkPrefix(sessionId: string): string {
  return `${sessionId}:`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableInRange(value: unknown, min: number, max: number): boolean {
  return value === null || (finite(value) && value >= min && value <= max);
}

export function fixProblem(fix: unknown): string | null {
  if (!fix || typeof fix !== "object") return "fix is not an object";
  const f = fix as Record<string, unknown>;
  if (!finite(f.lng) || !finite(f.lat) || Math.abs(f.lat) > 90 || Math.abs(f.lng) > 180)
    return "fix coordinates are missing or out of range";
  if (!finite(f.t) || f.t <= 0) return "fix time is missing";
  if (!finite(f.accuracy) || f.accuracy < 0) return "fix accuracy is missing";
  if (!nullableInRange(f.altitude, -Infinity, Infinity))
    return "fix altitude must be a number or null";
  if (!nullableInRange(f.altitudeAccuracy, 0, Infinity))
    return "fix altitude accuracy must be a number or null";
  if (!nullableInRange(f.speed, 0, Infinity)) return "fix speed must be a number or null";
  if (!nullableInRange(f.heading, 0, 360)) return "fix heading must be 0–360 or null";
  return null;
}

function cleanFix(fix: Fix): Fix {
  return {
    lng: fix.lng,
    lat: fix.lat,
    t: fix.t,
    accuracy: fix.accuracy,
    altitude: fix.altitude,
    altitudeAccuracy: fix.altitudeAccuracy,
    speed: fix.speed,
    heading: fix.heading,
  };
}

function validChunk(chunk: unknown, session: RecordingSession): chunk is FixChunk {
  if (!chunk || typeof chunk !== "object") return false;
  const c = chunk as FixChunk;
  return (
    c.sessionId === session.id &&
    Number.isInteger(c.seq) &&
    c.seq >= 0 &&
    c.seq < session.nextSeq &&
    Number.isInteger(c.segment) &&
    Array.isArray(c.fixes) &&
    c.fixes.length > 0 &&
    c.fixes.length <= CHECKPOINT_LIMITS.fixesPerChunk &&
    c.fixes.every((fix) => fixProblem(fix) === null)
  );
}

function damageMessage(damage: RecordingDamage): string {
  return `${damage.lostFixes} recorded point${damage.lostFixes === 1 ? "" : "s"} can't be recovered (${damage.missingChunks} missing and ${damage.damagedChunks} damaged chunk${damage.damagedChunks === 1 ? "" : "s"}).`;
}

export class TrackCheckpointStore {
  readonly backend: StorageBackend;
  private now: () => number;

  constructor(backend: StorageBackend, options: { now?: () => number } = {}) {
    this.backend = backend;
    this.now = options.now ?? Date.now;
  }

  /** Starts a session. Only one session can be open; finalize or discard it first. */
  async startSession(input: {
    id: string;
    name: string;
    startedAt?: number;
  }): Promise<RecordingSession> {
    if (!isSafeSessionId(input.id))
      throw new StorageError("invalid", "Recording id is missing or unsafe.");
    const name = input.name.trim().slice(0, LIMITS.nameLength) || "Track";
    const startedAt = input.startedAt ?? this.now();
    return this.backend.write(["meta", "sessions"], async (tx) => {
      await assertReady(tx);
      if ((await tx.count("sessions")) > 0)
        throw new StorageError(
          "conflict",
          "A recording is already open. Finish or discard it first.",
        );
      const session: RecordingSession = {
        id: input.id,
        name,
        startedAt,
        updatedAt: startedAt,
        status: "recording",
        nextSeq: 0,
        fixCount: 0,
        segment: 0,
        segmentHasFixes: false,
      };
      await tx.put("sessions", session.id, session);
      return session;
    });
  }

  /**
   * Appends fixes (in time order) to the current segment. All of them are
   * committed together or none are. Resolves after commit; a quota or storage
   * failure rejects with a StorageError and the caller must tell the user.
   */
  async appendFixes(sessionId: string, fixes: Fix[]): Promise<RecordingSession> {
    if (!fixes.length) throw new StorageError("invalid", "No fixes to save.");
    if (fixes.length > CHECKPOINT_LIMITS.fixesPerAppend)
      throw new StorageError(
        "invalid",
        `Save at most ${CHECKPOINT_LIMITS.fixesPerAppend} fixes at a time.`,
      );
    for (const fix of fixes) {
      const problem = fixProblem(fix);
      if (problem) throw new StorageError("invalid", problem);
    }
    const clean = fixes.map(cleanFix);
    const cap = CHECKPOINT_LIMITS.fixesPerChunk;
    return this.backend.write(["meta", "sessions", "chunks"], async (tx) => {
      await assertReady(tx);
      const session = await tx.get<RecordingSession>("sessions", sessionId);
      if (!session) throw new StorageError("not-found", "That recording is no longer open.");
      if (session.fixCount + clean.length > CHECKPOINT_LIMITS.fixesPerSession) {
        throw new StorageError(
          "invalid",
          "This recording reached its maximum length. Finish it and start a new one.",
        );
      }
      let remaining = clean;
      // Top up the last chunk when it belongs to the current segment and has room.
      if (session.nextSeq > 0 && session.segmentHasFixes) {
        const lastKey = chunkKey(sessionId, session.nextSeq - 1);
        const last = await tx.get<FixChunk>("chunks", lastKey);
        if (
          validChunk(last, session) &&
          last.segment === session.segment &&
          last.fixes.length < cap
        ) {
          const room = cap - last.fixes.length;
          await tx.put("chunks", lastKey, {
            ...last,
            fixes: [...last.fixes, ...remaining.slice(0, room)],
          });
          remaining = remaining.slice(room);
        }
      }
      for (let start = 0; start < remaining.length; start += cap) {
        const chunk: FixChunk = {
          sessionId,
          seq: session.nextSeq,
          segment: session.segment,
          fixes: remaining.slice(start, start + cap),
        };
        await tx.put("chunks", chunkKey(sessionId, chunk.seq), chunk);
        session.nextSeq += 1;
      }
      session.fixCount += clean.length;
      session.segmentHasFixes = true;
      session.updatedAt = this.now();
      await tx.put("sessions", sessionId, session);
      return session;
    });
  }

  /** Marks a gap: fixes appended after this start a new segment. */
  markGap(sessionId: string): Promise<RecordingSession> {
    return this.updateSession(sessionId, (session) => {
      if (session.segmentHasFixes) {
        session.segment += 1;
        session.segmentHasFixes = false;
      }
    });
  }

  /** Pauses (which also breaks the segment) or resumes recording. */
  setPaused(sessionId: string, paused: boolean): Promise<RecordingSession> {
    return this.updateSession(sessionId, (session) => {
      session.status = paused ? "paused" : "recording";
      if (paused && session.segmentHasFixes) {
        session.segment += 1;
        session.segmentHasFixes = false;
      }
    });
  }

  private updateSession(
    sessionId: string,
    change: (session: RecordingSession) => void,
  ): Promise<RecordingSession> {
    return this.backend.write(["meta", "sessions"], async (tx) => {
      await assertReady(tx);
      const session = await tx.get<RecordingSession>("sessions", sessionId);
      if (!session) throw new StorageError("not-found", "That recording is no longer open.");
      change(session);
      session.updatedAt = this.now();
      await tx.put("sessions", sessionId, session);
      return session;
    });
  }

  /**
   * The open session, if any, with every recoverable fix — call on startup to
   * recover after a crash. Check `intact`; when false, `lostFixes`,
   * `missingChunks` and `damagedChunks` say what can't be recovered.
   */
  async getActiveSession(): Promise<RecoveredSession | null> {
    return this.backend.read(["sessions", "chunks"], async (tx) => {
      const sessions = await tx.getAll<RecordingSession>("sessions");
      if (!sessions.length) return null;
      const session = sessions.sort((a, b) => b.startedAt - a.startedAt)[0];
      return recover(tx, session);
    });
  }

  /**
   * Turns the session into a saved track and removes the session, in one
   * transaction. Gaps become `segmentStarts`; each point keeps its accuracy,
   * altitude, speed and heading. Needs at least two fixes; discard otherwise.
   *
   * If any committed fix can't be recovered, nothing is changed and an
   * `invalid` StorageError explains the loss, unless the caller passes
   * `acceptDamage: true` after the user agreed to keep what remains. The
   * result always reports what was lost.
   */
  async finalizeSession(
    sessionId: string,
    options: { trackId?: string; name?: string; acceptDamage?: boolean } = {},
  ): Promise<FinalizedRecording> {
    const trackId = options.trackId ?? sessionId;
    if (!isSafeId(trackId)) throw new StorageError("invalid", "Track id is missing or unsafe.");
    return this.backend.write(["meta", "sessions", "chunks", "tracks"], async (tx) => {
      await assertReady(tx);
      const session = await tx.get<RecordingSession>("sessions", sessionId);
      if (!session) throw new StorageError("not-found", "That recording is no longer open.");
      const recovered = await recover(tx, session);
      if (!recovered.intact && !options.acceptDamage) {
        throw new StorageError(
          "invalid",
          `${damageMessage(recovered)} Nothing was changed; finish it only if you accept that loss.`,
        );
      }
      if (recovered.fixCount < 2)
        throw new StorageError(
          "invalid",
          "A track needs at least two points. Discard this recording instead.",
        );
      if (await tx.get("tracks", trackId))
        throw new StorageError("conflict", "A track with that id already exists.");
      const points: StoredTrackPoint[] = [];
      const segmentStarts: number[] = [];
      for (const segment of recovered.segments) {
        if (points.length) segmentStarts.push(points.length);
        for (const fix of segment) points.push({ ...fix });
      }
      const track: StoredTrack = {
        id: trackId,
        name: options.name?.trim().slice(0, LIMITS.nameLength) || session.name,
        points,
        createdAt: session.startedAt,
        visible: true,
        ...(segmentStarts.length ? { segmentStarts } : {}),
      };
      await tx.put("tracks", trackId, track);
      await tx.deleteRange("chunks", chunkPrefix(sessionId));
      await tx.delete("sessions", sessionId);
      return {
        track,
        lostFixes: recovered.lostFixes,
        missingChunks: recovered.missingChunks,
        damagedChunks: recovered.damagedChunks,
      };
    });
  }

  /** Deletes the session and all its fixes. */
  async discardSession(sessionId: string): Promise<void> {
    if (!isSafeSessionId(sessionId)) throw new StorageError("invalid", "Recording id is unsafe.");
    return this.backend.write(["meta", "sessions", "chunks"], async (tx) => {
      await assertReady(tx);
      if (!(await tx.get("sessions", sessionId)))
        throw new StorageError("not-found", "That recording is no longer open.");
      await tx.deleteRange("chunks", chunkPrefix(sessionId));
      await tx.delete("sessions", sessionId);
    });
  }
}

async function recover(tx: ReadTx, session: RecordingSession): Promise<RecoveredSession> {
  const chunks = await tx.getRange<unknown>("chunks", chunkPrefix(session.id));
  const bySeq = new Map<number, FixChunk>();
  const damagedSeqs = new Set<unknown>();
  let damagedChunks = 0;
  for (const chunk of chunks) {
    if (validChunk(chunk, session) && !bySeq.has(chunk.seq)) {
      bySeq.set(chunk.seq, chunk);
    } else {
      damagedChunks += 1;
      if (chunk && typeof chunk === "object") damagedSeqs.add((chunk as { seq?: unknown }).seq);
    }
  }
  let missingChunks = 0;
  const bySegment = new Map<number, Fix[]>();
  let fixCount = 0;
  for (let seq = 0; seq < session.nextSeq; seq += 1) {
    const chunk = bySeq.get(seq);
    if (!chunk) {
      // A chunk present but damaged is counted once, as damaged.
      if (!damagedSeqs.has(seq)) missingChunks += 1;
      continue;
    }
    const list = bySegment.get(chunk.segment) ?? [];
    list.push(...chunk.fixes);
    bySegment.set(chunk.segment, list);
    fixCount += chunk.fixes.length;
  }
  const lostFixes = Math.max(0, session.fixCount - fixCount);
  const segments = [...bySegment.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, fixes]) => fixes)
    .filter((fixes) => fixes.length);
  return {
    session,
    segments,
    fixCount,
    damagedChunks,
    missingChunks,
    lostFixes,
    intact:
      damagedChunks === 0 &&
      missingChunks === 0 &&
      lostFixes === 0 &&
      fixCount === session.fixCount,
  };
}
