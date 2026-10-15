import type {
  LifecycleSignal,
  LocationCapabilities,
  LocationError,
  LocationEvent,
  LocationFix,
  LocationListener,
  LocationPermission,
  LocationSource,
  LocationStartOptions,
  LocationStatus,
  WakeLockState,
} from "./types.ts";

/**
 * `LocationSource` over the browser Geolocation API (`watchPosition`), with
 * the page lifecycle and Screen Wake Lock signals the browser exposes.
 *
 * Follows the main app's rules (ADR-009): a lost or slow signal is a
 * transient error and the watch keeps running; only a denied permission ends
 * it. Fixes with impossible values are dropped and reported, never passed on.
 * What happens while the page is hidden or the screen is locked is up to the
 * browser and is exactly what the phone field tests measure.
 */

type WakeLockSentinelLike = {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
};
type WakeLockLike = { request(type: "screen"): Promise<WakeLockSentinelLike> };
type PermissionStatusLike = {
  state: string;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
};
type PermissionsLike = { query(descriptor: { name: "geolocation" }): Promise<PermissionStatusLike> };
type Target = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};
type DocumentLike = Target & { visibilityState: string };

/** Everything the browser source touches, injectable for tests. */
export type BrowserEnv = {
  geolocation: Geolocation | null;
  permissions: PermissionsLike | null;
  wakeLock: WakeLockLike | null;
  document: DocumentLike | null;
  window: Target | null;
  isSecureContext: boolean;
  onLine: () => boolean;
  /** Whether the document supports Page Lifecycle freeze/resume events. */
  freezeEvents: boolean;
  now: () => number;
};

export function browserEnv(): BrowserEnv {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const doc = typeof document === "undefined" ? null : document;
  return {
    geolocation: nav?.geolocation ?? null,
    permissions: (nav?.permissions as PermissionsLike | undefined) ?? null,
    wakeLock: ((nav as (Navigator & { wakeLock?: WakeLockLike }) | null)?.wakeLock) ?? null,
    document: doc,
    window: typeof window === "undefined" ? null : window,
    isSecureContext: typeof window !== "undefined" && window.isSecureContext === true,
    onLine: () => nav?.onLine !== false,
    freezeEvents: doc != null && "onfreeze" in doc,
    now: Date.now,
  };
}

function known(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Converts a browser position into a fix, or null when the browser returned
 * impossible values. Unknown values stay null; a negative or NaN heading
 * (browsers report NaN when not moving) is null.
 */
export function fixFromPosition(position: GeolocationPosition, receivedAt: number): LocationFix | null {
  const { coords } = position;
  const lng = coords.longitude;
  const lat = coords.latitude;
  const accuracy = coords.accuracy;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0) return null;
  const heading = known(coords.heading);
  const speed = known(coords.speed);
  const altitudeAccuracy = known(coords.altitudeAccuracy);
  const validHeading = heading != null && heading >= 0 && heading < 360 ? heading : null;
  return {
    lng,
    lat,
    t: Number.isFinite(position.timestamp) && position.timestamp > 0 ? position.timestamp : receivedAt,
    receivedAt,
    accuracy,
    altitude: known(coords.altitude),
    altitudeAccuracy: altitudeAccuracy != null && altitudeAccuracy >= 0 ? altitudeAccuracy : null,
    speed: speed != null && speed >= 0 ? speed : null,
    heading: validHeading,
    headingSource: validHeading == null ? null : "course",
  };
}

/** Maps a GeolocationPositionError (codes 1–3) to a typed error. */
export function errorFromPositionError(error: { code: number; message?: string }, at: number): LocationError {
  if (error.code === 1) {
    return { code: "permission-denied", message: "Location permission was denied.", transient: false, at };
  }
  if (error.code === 3) {
    return { code: "timeout", message: "No location fix arrived in time. Still trying.", transient: true, at };
  }
  return {
    code: "position-unavailable",
    message: error.message ? `No position right now (${error.message}). Still trying.` : "No position right now. Still trying.",
    transient: true,
    at,
  };
}

function permissionFrom(state: string): LocationPermission {
  return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
}

export class BrowserLocationSource implements LocationSource {
  readonly kind = "browser-geolocation";
  private env: BrowserEnv;
  private listeners = new Set<LocationListener>();
  private watchId: number | null = null;
  private options: LocationStartOptions | null = null;
  private permission: LocationPermission = "unknown";
  private permissionStatus: PermissionStatusLike | null = null;
  private lastError: LocationError | null = null;
  private wakeState: WakeLockState = "off";
  private sentinel: WakeLockSentinelLike | null = null;
  private wakeRequesting = false;
  private detach: (() => void) | null = null;

  constructor(env: BrowserEnv = browserEnv()) {
    this.env = env;
  }

  capabilities(): LocationCapabilities {
    return {
      geolocation: this.env.geolocation != null,
      secureContext: this.env.isSecureContext,
      permissionsApi: this.env.permissions != null,
      wakeLock: this.env.wakeLock != null,
      freezeEvents: this.env.freezeEvents,
      backgroundLocation: "unknown",
    };
  }

  status(): LocationStatus {
    return {
      running: this.watchId != null,
      permission: this.permission,
      lastError: this.lastError,
      wakeLock: this.wakeState,
      visible: this.env.document ? this.env.document.visibilityState === "visible" : true,
      online: this.env.onLine(),
    };
  }

  subscribe(listener: LocationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: LocationEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not stop the others or the watch.
      }
    }
  }

  private signal(signal: LifecycleSignal, detail?: string) {
    this.emit({ type: "lifecycle", signal, at: this.env.now(), ...(detail ? { detail } : {}) });
  }

  private fail(error: LocationError) {
    this.lastError = error;
    this.emit({ type: "error", error });
  }

  async start(options: LocationStartOptions): Promise<void> {
    if (this.watchId != null) return;
    const geo = this.env.geolocation;
    if (!geo || !this.env.isSecureContext) {
      this.fail({
        code: "unsupported",
        message: !geo
          ? "This browser has no location."
          : "Location needs a secure (https://) address. Open Fieldline from an https:// link.",
        transient: false,
        at: this.env.now(),
      });
      return;
    }
    this.options = options;
    this.lastError = null;
    this.attachLifecycle();
    await this.watchPermission();
    try {
      this.watchId = geo.watchPosition(
        (position) => {
          const receivedAt = this.env.now();
          const fix = fixFromPosition(position, receivedAt);
          if (!fix) {
            this.fail({ code: "invalid-fix", message: "The browser returned an impossible fix; it was ignored.", transient: true, at: receivedAt });
            return;
          }
          this.lastError = null;
          if (this.permission !== "granted") this.setPermission("granted");
          this.emit({ type: "fix", fix });
        },
        (positionError) => {
          const error = errorFromPositionError(positionError, this.env.now());
          if (!error.transient) {
            this.setPermission("denied");
            this.clearWatch();
            void this.releaseWakeLock("off");
          }
          this.fail(error);
        },
        { enableHighAccuracy: options.highAccuracy, maximumAge: options.maximumAgeMs, timeout: options.timeoutMs },
      );
    } catch {
      this.fail({ code: "unsupported", message: "Couldn't start location on this device.", transient: false, at: this.env.now() });
      this.detachLifecycle();
      return;
    }
    if (options.keepScreenOn) {
      if (this.env.wakeLock) this.acquireWakeLock();
      else this.wakeState = "unsupported";
    }
  }

  async stop(): Promise<void> {
    this.clearWatch();
    await this.releaseWakeLock("off");
    this.detachLifecycle();
    this.options = null;
  }

  private clearWatch() {
    if (this.watchId != null) this.env.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
  }

  private setPermission(permission: LocationPermission) {
    if (permission === this.permission) return;
    this.permission = permission;
    this.emit({ type: "permission", permission, at: this.env.now() });
  }

  private onPermissionChange = () => {
    if (this.permissionStatus) this.setPermission(permissionFrom(this.permissionStatus.state));
  };

  private async watchPermission() {
    const permissions = this.env.permissions;
    if (!permissions || this.permissionStatus) return;
    try {
      const status = await permissions.query({ name: "geolocation" });
      this.permissionStatus = status;
      this.setPermission(permissionFrom(status.state));
      status.addEventListener?.("change", this.onPermissionChange);
    } catch {
      // Some browsers don't answer for geolocation; the watch result still tells us.
    }
  }

  private acquireWakeLock() {
    const lock = this.env.wakeLock;
    const doc = this.env.document;
    if (!lock || !this.options?.keepScreenOn || this.sentinel || this.wakeRequesting) return;
    // Browsers only grant a wake lock to a visible page.
    if (doc && doc.visibilityState !== "visible") return;
    this.wakeRequesting = true;
    lock
      .request("screen")
      .then((sentinel) => {
        if (!this.options?.keepScreenOn) {
          void sentinel.release();
          return;
        }
        this.sentinel = sentinel;
        this.wakeState = "held";
        this.signal("wake-lock-acquired");
        sentinel.addEventListener("release", () => {
          // A late release from an older lock must not clear a newer one.
          if (this.sentinel !== sentinel) return;
          this.sentinel = null;
          if (this.wakeState === "held") this.wakeState = "released";
          this.signal("wake-lock-released");
        });
      })
      .catch((error: unknown) => {
        this.wakeState = "error";
        this.signal("wake-lock-error", error instanceof Error ? error.message : "Wake lock refused.");
      })
      .finally(() => {
        this.wakeRequesting = false;
      });
  }

  private async releaseWakeLock(next: WakeLockState) {
    const sentinel = this.sentinel;
    this.sentinel = null;
    this.wakeState = next;
    if (sentinel) {
      this.signal("wake-lock-released", "released by Fieldline");
      try {
        await sentinel.release();
      } catch {
        // Already released by the browser.
      }
    }
  }

  private attachLifecycle() {
    if (this.detach) return;
    const doc = this.env.document;
    const win = this.env.window;
    const removers: (() => void)[] = [];
    const on = (target: Target | null, type: string, handler: (event: Event) => void) => {
      if (!target) return;
      target.addEventListener(type, handler);
      removers.push(() => target.removeEventListener(type, handler));
    };
    on(doc, "visibilitychange", () => {
      const visible = doc?.visibilityState === "visible";
      this.signal(visible ? "visible" : "hidden");
      if (visible) this.acquireWakeLock();
    });
    on(doc, "freeze", () => this.signal("freeze"));
    on(doc, "resume", () => this.signal("resume"));
    on(win, "pagehide", (event) => this.signal("pagehide", (event as PageTransitionEvent).persisted ? "persisted" : undefined));
    on(win, "pageshow", (event) => this.signal("pageshow", (event as PageTransitionEvent).persisted ? "persisted" : undefined));
    on(win, "online", () => this.signal("online"));
    on(win, "offline", () => this.signal("offline"));
    this.detach = () => {
      for (const remove of removers) remove();
      this.permissionStatus?.removeEventListener?.("change", this.onPermissionChange);
      this.permissionStatus = null;
    };
  }

  private detachLifecycle() {
    this.detach?.();
    this.detach = null;
  }
}
