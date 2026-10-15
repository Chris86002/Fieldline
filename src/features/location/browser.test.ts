import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserLocationSource, errorFromPositionError, fixFromPosition, type BrowserEnv } from "./browser.ts";
import { DEFAULT_START_OPTIONS, type LocationEvent } from "./types.ts";

function position(coords: Partial<GeolocationCoordinates>, timestamp = 1000): GeolocationPosition {
  return {
    timestamp,
    coords: {
      latitude: 45,
      longitude: -110,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...coords,
    } as GeolocationCoordinates,
  } as GeolocationPosition;
}

/** Fake browser: a geolocation whose callbacks the test drives, and plain event targets. */
function fakeEnv(options: { secure?: boolean; wakeLock?: boolean; permission?: string } = {}) {
  let success: PositionCallback | null = null;
  let failure: PositionErrorCallback | null = null;
  const cleared: number[] = [];
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();
  const permissionStatus = Object.assign(new EventTarget(), { state: options.permission ?? "prompt" });
  const released: string[] = [];
  let now = 5000;
  const env: BrowserEnv = {
    geolocation: {
      watchPosition: (ok: PositionCallback, fail?: PositionErrorCallback | null) => {
        success = ok;
        failure = fail ?? null;
        return 7;
      },
      clearWatch: (id: number) => cleared.push(id),
      getCurrentPosition: () => undefined,
    } as Geolocation,
    permissions: { query: async () => permissionStatus },
    wakeLock: options.wakeLock
      ? {
          request: async () => {
            const sentinel = new EventTarget();
            return Object.assign(sentinel, {
              release: async () => {
                released.push("released");
                sentinel.dispatchEvent(new Event("release"));
              },
            });
          },
        }
      : null,
    document: doc,
    window: win,
    isSecureContext: options.secure ?? true,
    onLine: () => true,
    freezeEvents: false,
    now: () => now,
  };
  return {
    env,
    doc,
    win,
    permissionStatus,
    cleared,
    released,
    advance: (ms: number) => (now += ms),
    fix: (pos: GeolocationPosition) => success?.(pos),
    error: (code: number) => failure?.({ code, message: "test" } as GeolocationPositionError),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("browser location source", () => {
  it("converts positions, keeping unknown values null and dropping impossible ones", () => {
    const fix = fixFromPosition(position({ altitude: 1200.5, speed: 1.4, heading: 90, altitudeAccuracy: 4 }, 900), 1000);
    assert.deepEqual(fix, {
      lng: -110,
      lat: 45,
      t: 900,
      receivedAt: 1000,
      accuracy: 8,
      altitude: 1200.5,
      altitudeAccuracy: 4,
      speed: 1.4,
      heading: 90,
      headingSource: "course",
    });
    const still = fixFromPosition(position({ heading: Number.NaN, speed: -1 }), 1000);
    assert.equal(still?.heading, null);
    assert.equal(still?.headingSource, null);
    assert.equal(still?.speed, null);
    assert.equal(fixFromPosition(position({ latitude: 91 }), 1000), null);
    assert.equal(fixFromPosition(position({ accuracy: Number.NaN }), 1000), null);
    assert.equal(fixFromPosition(position({}, 0), 1234)?.t, 1234);
  });

  it("treats lost signal as transient and a denial as final (ADR-009)", () => {
    assert.deepEqual(
      [1, 2, 3].map((code) => {
        const error = errorFromPositionError({ code }, 1);
        return [error.code, error.transient];
      }),
      [
        ["permission-denied", false],
        ["position-unavailable", true],
        ["timeout", true],
      ],
    );
  });

  it("refuses to start outside a secure context", async () => {
    const fake = fakeEnv({ secure: false });
    const source = new BrowserLocationSource(fake.env);
    const events: LocationEvent[] = [];
    source.subscribe((event) => events.push(event));
    await source.start(DEFAULT_START_OPTIONS);
    assert.equal(source.status().running, false);
    assert.equal(events[0]?.type, "error");
    assert.equal(events[0]?.type === "error" && events[0].error.code, "unsupported");
  });

  it("emits fixes, permission, lifecycle and wake-lock signals, and stops on denial", async () => {
    const fake = fakeEnv({ wakeLock: true });
    const source = new BrowserLocationSource(fake.env);
    const events: LocationEvent[] = [];
    source.subscribe((event) => events.push(event));
    await source.start({ ...DEFAULT_START_OPTIONS, keepScreenOn: true });
    await flush();
    assert.equal(source.status().running, true);
    assert.equal(source.status().wakeLock, "held");

    fake.fix(position({}, 4000));
    fake.fix(position({ latitude: 200 }, 4500));
    fake.error(3);
    fake.doc.visibilityState = "hidden";
    fake.doc.dispatchEvent(new Event("visibilitychange"));
    fake.win.dispatchEvent(new Event("offline"));
    fake.permissionStatus.state = "denied";
    fake.permissionStatus.dispatchEvent(new Event("change"));
    fake.error(1);
    await flush();

    const summary = events.map((event) =>
      event.type === "fix"
        ? "fix"
        : event.type === "error"
          ? `error:${event.error.code}`
          : event.type === "permission"
            ? `permission:${event.permission}`
            : event.signal,
    );
    assert.deepEqual(summary, [
      "permission:prompt",
      "wake-lock-acquired",
      "permission:granted",
      "fix",
      "error:invalid-fix",
      "error:timeout",
      "hidden",
      "offline",
      "permission:denied",
      "wake-lock-released",
      "error:permission-denied",
    ]);
    assert.equal(source.status().running, false);
    assert.deepEqual(fake.cleared, [7]);
    assert.equal(source.status().wakeLock, "off");
  });

  it("re-requests the wake lock when the page is shown again", async () => {
    const fake = fakeEnv({ wakeLock: true });
    const source = new BrowserLocationSource(fake.env);
    await source.start({ ...DEFAULT_START_OPTIONS, keepScreenOn: true });
    await flush();
    // The browser releases the lock when the page is hidden.
    fake.doc.visibilityState = "hidden";
    fake.doc.dispatchEvent(new Event("visibilitychange"));
    const sentinel = (source as unknown as { sentinel: EventTarget }).sentinel;
    sentinel.dispatchEvent(new Event("release"));
    assert.equal(source.status().wakeLock, "released");
    fake.doc.visibilityState = "visible";
    fake.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(source.status().wakeLock, "held");
    await source.stop();
    assert.equal(source.status().wakeLock, "off");
    assert.equal(source.status().running, false);
  });
});
