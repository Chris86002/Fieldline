/**
 * Platform location interface (REL-02; proposed in docs/phone-strategy.md).
 *
 * A `LocationSource` hides how fixes are obtained: the browser Geolocation
 * API today (`browser.ts`), a native background-location service later if the
 * phone field tests require a native shell. Callers get one event stream with
 * fixes, permission and error state, and the lifecycle signals the platform
 * exposes (page visibility, freeze/resume, wake lock, network), so recording
 * code and field tests can tell "the GPS sent nothing" from "the app was
 * suspended" without knowing which platform they run on.
 *
 * This slice (CC-01) is used only by the phone field-test tool; the main
 * app's recording is rewired onto it in CC-06.
 */

/** One position fix as the platform reported it. Unknown values are null, never 0. */
export type LocationFix = {
  lng: number;
  lat: number;
  /** When the platform says the fix was taken, ms since epoch. */
  t: number;
  /** When this code received it (ms since epoch); larger than `t` when delivery was delayed or batched. */
  receivedAt: number;
  /** Horizontal accuracy radius, meters. */
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  /** Ground speed, m/s. */
  speed: number | null;
  /** Degrees clockwise from true north, 0–360, or null. */
  heading: number | null;
  /**
   * What `heading` means. "course" is direction of travel computed from
   * movement (what browsers report); "compass" would be a device compass
   * reading. Null when there is no heading.
   */
  headingSource: "course" | "compass" | null;
};

export type LocationPermission = "granted" | "denied" | "prompt" | "unknown";

export type LocationErrorCode =
  /** The user or OS refused location. Ends the session; never retried silently. */
  | "permission-denied"
  /** No position right now (no signal, canyon, tunnel). Transient. */
  | "position-unavailable"
  /** No fix within the timeout. Transient. */
  | "timeout"
  /** Geolocation is missing, or the page isn't a secure context (HTTPS or localhost). */
  | "unsupported"
  /** The platform returned a fix with impossible values; it was dropped. */
  | "invalid-fix";

export type LocationError = {
  code: LocationErrorCode;
  message: string;
  /** True when the source keeps running and fixes may resume (ADR-009). */
  transient: boolean;
  at: number;
};

export type WakeLockState =
  /** Not requested. */
  | "off"
  /** The screen is being kept on. */
  | "held"
  /** Requested, but released by the platform (page hidden, battery saver); re-requested when visible. */
  | "released"
  /** The platform has no screen wake lock. */
  | "unsupported"
  /** The request was refused. */
  | "error";

/**
 * Lifecycle signals. Browsers expose: `visible`/`hidden` (visibilitychange),
 * `pagehide`/`pageshow` (`persisted` in detail means the back/forward cache),
 * `freeze`/`resume` (Chromium only), `online`/`offline`, and wake-lock
 * changes. A native shell would add its own (for example background-mode
 * entered). Kills and reboots produce no signal: they show up only as an
 * interrupted session found on the next start.
 */
export type LifecycleSignal =
  | "visible"
  | "hidden"
  | "pagehide"
  | "pageshow"
  | "freeze"
  | "resume"
  | "online"
  | "offline"
  | "wake-lock-acquired"
  | "wake-lock-released"
  | "wake-lock-error";

export type LocationEvent =
  | { type: "fix"; fix: LocationFix }
  | { type: "error"; error: LocationError }
  | { type: "permission"; permission: LocationPermission; at: number }
  | { type: "lifecycle"; signal: LifecycleSignal; at: number; detail?: string };

export type LocationStartOptions = {
  /** Ask for the most accurate fixes (GPS). */
  highAccuracy: boolean;
  /** Accept a cached fix up to this old, ms. */
  maximumAgeMs: number;
  /** Report a timeout when no fix arrives within this, ms. */
  timeoutMs: number;
  /** Hold a screen wake lock while running, where supported. */
  keepScreenOn: boolean;
};

/** What this platform can do, checked without asking the user for anything. */
export type LocationCapabilities = {
  geolocation: boolean;
  /** Geolocation only works in a secure context (HTTPS or localhost). */
  secureContext: boolean;
  permissionsApi: boolean;
  wakeLock: boolean;
  /** Page Lifecycle freeze/resume events (Chromium). */
  freezeEvents: boolean;
  /** Whether fixes can continue while the app is hidden or the screen is locked. Unknown until measured. */
  backgroundLocation: "unknown" | "supported" | "unsupported";
};

export type LocationStatus = {
  running: boolean;
  permission: LocationPermission;
  lastError: LocationError | null;
  wakeLock: WakeLockState;
  visible: boolean;
  online: boolean;
};

export type LocationListener = (event: LocationEvent) => void;

export interface LocationSource {
  /** Which implementation this is, for reports ("browser-geolocation", later e.g. "native-shell"). */
  readonly kind: string;
  capabilities(): LocationCapabilities;
  status(): LocationStatus;
  /** Starts watching. Resolves once the watch is requested (not when the first fix arrives). */
  start(options: LocationStartOptions): Promise<void>;
  /** Stops watching and releases the wake lock. Safe to call twice. */
  stop(): Promise<void>;
  /** Adds a listener; returns its remover. */
  subscribe(listener: LocationListener): () => void;
}

/** The main app's watch options (HuntApp), so field tests measure what recording would get. */
export const DEFAULT_START_OPTIONS: LocationStartOptions = {
  highAccuracy: true,
  maximumAgeMs: 2000,
  timeoutMs: 15000,
  keepScreenOn: false,
};
