import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fix } from "../../lib/storage/checkpoints.ts";
import { parseUserAgent } from "./device.ts";
import { buildReport, formatDuration, resultTemplate } from "./report.ts";
import type { RunEvent } from "./run-store.ts";
import { FIRST_ROUND, SCENARIOS } from "./scenarios.ts";

const T0 = 1_760_000_000_000;

function fixAt(t: number, accuracy = 5): Fix {
  return { lng: -110, lat: 45, t, accuracy, altitude: null, altitudeAccuracy: null, speed: null, heading: null };
}

function event(seq: number, at: number, type: string, data?: RunEvent["data"]): RunEvent {
  return { seq, at, type, received: 0, saved: 0, ...(data ? { data } : {}) };
}

describe("field-test report", () => {
  it("attributes gaps to frozen, offline and paused periods, and works without a setup record", () => {
    const report = buildReport({
      sessionId: "s",
      meta: null,
      sessionStartedAt: T0,
      events: [
        event(0, T0 + 1000, "offline"),
        event(1, T0 + 2000, "freeze"),
        event(2, T0 + 32_000, "resume"),
        event(3, T0 + 32_000, "timers-paused", { from: T0 + 2000, to: T0 + 32_000 }),
        event(4, T0 + 40_000, "online"),
        event(5, T0 + 41_000, "error:timeout"),
        event(6, T0 + 42_000, "error:timeout"),
      ],
      segments: [[fixAt(T0 + 500), fixAt(T0 + 1500, 40)], [fixAt(T0 + 35_000, 200)]],
      damage: { lostFixes: 2, missingChunks: 1, damagedChunks: 0 },
      endedAt: T0 + 60_000,
      batteryEnd: null,
      fixesReceived: null,
      gapThresholdMs: 15_000,
    });
    assert.equal(report.run.scenario, 0);
    assert.equal(report.run.scenarioTitle, "Unknown scenario");
    assert.equal(report.run.firstFixAfterMs, 500);
    assert.equal(report.counts.fixesSaved, 3);
    assert.equal(report.counts.lostFixes, 2);
    assert.equal(report.counts.segments, 2);
    assert.deepEqual(report.counts.errors, { timeout: 2 });
    assert.equal(report.gaps.count, 1);
    const gap = report.gaps.list[0];
    assert.equal(gap.durationMs, 33_500);
    assert.equal(gap.frozenMs, 30_000);
    assert.equal(gap.offlineMs, 33_500);
    assert.equal(report.timersPaused.totalMs, 30_000);
    assert.equal(report.offline.periods[0].fixes, 2);
    assert.match(report.battery.note, /Safari/);
    assert.deepEqual(
      report.accuracyM.buckets.map((bucket) => bucket.count),
      [1, 0, 0, 1, 0, 1],
    );
    const text = resultTemplate(report);
    assert.match(text, /^Run ID: s$/m);
    assert.match(text, /Gaps \(count, longest, cause if known\): 1 over 15 s, longest 34 s/);
    assert.match(text, /Result: pass \/ fail \/ limited/);
  });

  it("formats durations for people", () => {
    assert.equal(formatDuration(null), "–");
    assert.equal(formatDuration(4_400), "4 s");
    assert.equal(formatDuration(125_000), "2 min 5 s");
    assert.equal(formatDuration(3 * 3600_000 + 7 * 60_000), "3 h 7 min");
  });

  it("numbers the 13 protocol scenarios and a first round drawn from them", () => {
    assert.deepEqual(
      SCENARIOS.map((scenario) => scenario.number),
      Array.from({ length: 13 }, (_, i) => i + 1),
    );
    for (const number of FIRST_ROUND) assert.ok(SCENARIOS.some((scenario) => scenario.number === number));
  });
});

describe("user agent description", () => {
  it("reads iPhone Safari, iPhone Chrome and Pixel Chrome", () => {
    const safari = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    );
    assert.deepEqual([safari.os, safari.osVersion, safari.browser, safari.browserVersion], ["iOS", "18.6", "Safari", "26.0"]);
    assert.ok(safari.notes.some((note) => /frozen/.test(note)));
    const chromeIos = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
    );
    assert.deepEqual([chromeIos.os, chromeIos.browser, chromeIos.browserVersion], ["iOS", "Chrome (iOS)", "126.0.6478.54"]);
    const homeScreen = parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");
    assert.match(homeScreen.browser, /WebKit view/);
    const pixel = parseUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36");
    assert.deepEqual([pixel.os, pixel.osVersion, pixel.browser, pixel.browserVersion], ["Android", "10", "Chrome", "140.0.0.0"]);
    assert.ok(pixel.notes.some((note) => /hides the model/.test(note)));
  });
});
