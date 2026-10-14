import { StorageError, type StorageBackend } from "./backend.ts";
import { isSafeId, LIMITS, type StoredTrack, type StoredTrackPoint } from "./records.ts";
import { assertReady } from "./repository.ts";

/**
 * Active-recording checkpoints (spec §9; the `TrackCheckpointStore` proposed
 * in docs/phone-strategy.md, for CC-06).
 *
 * A recording session is one record in `sessions`; its fixes live in bounded
 * chunks in `chunks`, keyed `${sessionId}:${seq}`. Each append writes its
 * chunk(s) and the updated session in one transaction, so after a crash or
 * restart the session reads back with exactly the fixes whose append had
 * resolved. Gaps (signal loss, pause) start a new segment instead of joining
 * points across the gap.
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
  /** Next chunk sequence number. */
  nextSeq: number;
  fixCount: number;
  /** Current segment index; fixes appended now belong to it. */
  segment: number;
  /** Whether the current segment already has fixes (a gap only starts a new segment after one). */
  segmentHasFixes: boolean;
};

export type FixChunk = { sessionId: string; seq: number; segment: number; fixes: Fix[] };

export type RecoveredSession = {
  session: RecordingSession;
  /** Committed fixes, split at gaps. Empty segments are omitted. */
  segments: Fix[][];
  fixCount: number;
  /** Chunks that failed validation and were left out (reported, never silently dropped). */
  damagedChunks: number;
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

export function chunkKey(sessionId: string, seq: number): string {
  return `${sessionId}:${String(seq).padStart(SEQ_WIDTH, "0")}`;
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
    if (!isSafeId(input.id))
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
      for (let start = 0; start < clean.length; start += CHECKPOINT_LIMITS.fixesPerChunk) {
        const chunk: FixChunk = {
          sessionId,
          seq: session.nextSeq,
          segment: session.segment,
          fixes: clean.slice(start, start + CHECKPOINT_LIMITS.fixesPerChunk),
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

  /** The open session, if any, with every committed fix — call on startup to recover after a crash. */
  async getActiveSession(): Promise<RecoveredSession | null> {
    return this.backend.read(["sessions", "chunks"], async (tx) => {
      const sessions = await tx.getAll<RecordingSession>("sessions");
      if (!sessions.length) return null;
      const session = sessions.sort((a, b) => b.startedAt - a.startedAt)[0];
      const chunks = await tx.getRange<FixChunk>("chunks", `${session.id}:`);
      return assemble(session, chunks);
    });
  }

  /**
   * Turns the session into a saved track and removes the session, in one
   * transaction. Gaps become `segmentStarts`; each point keeps its accuracy,
   * altitude, speed and heading. Needs at least two fixes; discard otherwise.
   */
  async finalizeSession(
    sessionId: string,
    options: { trackId?: string; name?: string } = {},
  ): Promise<StoredTrack> {
    const trackId = options.trackId ?? sessionId;
    if (!isSafeId(trackId)) throw new StorageError("invalid", "Track id is missing or unsafe.");
    return this.backend.write(["meta", "sessions", "chunks", "tracks"], async (tx) => {
      await assertReady(tx);
      const session = await tx.get<RecordingSession>("sessions", sessionId);
      if (!session) throw new StorageError("not-found", "That recording is no longer open.");
      const recovered = assemble(session, await tx.getRange<FixChunk>("chunks", `${sessionId}:`));
      if (recovered.damagedChunks)
        throw new StorageError(
          "invalid",
          "Part of this recording is damaged. Export it before finishing.",
        );
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
      await tx.deleteRange("chunks", `${sessionId}:`);
      await tx.delete("sessions", sessionId);
      return track;
    });
  }

  /** Deletes the session and all its fixes. */
  discardSession(sessionId: string): Promise<void> {
    return this.backend.write(["sessions", "chunks"], async (tx) => {
      await tx.deleteRange("chunks", `${sessionId}:`);
      await tx.delete("sessions", sessionId);
    });
  }
}

function assemble(session: RecordingSession, chunks: FixChunk[]): RecoveredSession {
  const bySegment = new Map<number, Fix[]>();
  let damagedChunks = 0;
  let fixCount = 0;
  for (const chunk of [...chunks].sort((a, b) => a.seq - b.seq)) {
    const ok =
      chunk &&
      chunk.sessionId === session.id &&
      Number.isInteger(chunk.segment) &&
      Array.isArray(chunk.fixes) &&
      chunk.fixes.length <= CHECKPOINT_LIMITS.fixesPerChunk &&
      chunk.fixes.every((fix) => fixProblem(fix) === null);
    if (!ok) {
      damagedChunks += 1;
      continue;
    }
    const list = bySegment.get(chunk.segment) ?? [];
    list.push(...chunk.fixes);
    bySegment.set(chunk.segment, list);
    fixCount += chunk.fixes.length;
  }
  const segments = [...bySegment.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, fixes]) => fixes)
    .filter((fixes) => fixes.length);
  return { session, segments, fixCount, damagedChunks };
}
