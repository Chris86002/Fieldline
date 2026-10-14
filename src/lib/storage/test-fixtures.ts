/**
 * TEST FIXTURES ONLY — synthetic records for storage tests. Not real user
 * data and not provider data; never imported by app code.
 */
import type { Track, Waypoint } from "@/lib/hunt/types";
import type { Fix } from "./checkpoints.ts";

export const FIXTURE_WAYPOINTS: Waypoint[] = [
  {
    id: "0b6a3c1e-1d2f-4c2a-9e51-3f8f6d1a0001",
    name: "Fixture ridge stand",
    kind: "stand",
    lng: -111.3,
    lat: 33.7,
    notes: 'North wind only. "Quoted", <b>angle</b> & ünïcode — 🦌',
    hunt: "Fixture Unit 22",
    goodWinds: [0, 22.5, 315],
    createdAt: 1_700_000_000_000,
  },
  {
    id: "0b6a3c1e-1d2f-4c2a-9e51-3f8f6d1a0002",
    name: "Fixture water",
    kind: "water",
    lng: -114.5,
    lat: 44.4,
    notes: "",
    hunt: "",
    goodWinds: [],
    createdAt: 1_700_000_100_000,
  },
];

/** Shape written by Fieldline 1.0.0, before `goodWinds` existed. */
export const FIXTURE_LEGACY_WAYPOINT = {
  id: "0b6a3c1e-1d2f-4c2a-9e51-3f8f6d1a0003",
  name: "Fixture old camp",
  kind: "camp",
  lng: -112.1,
  lat: 36.6,
  notes: "Saved by an old build",
  hunt: "Fixture Kaibab",
  createdAt: 1_690_000_000_000,
};

export function fixtureTrack(id: string, pointCount: number, start = 1_700_000_000_000): Track {
  return {
    id,
    name: `Fixture track ${pointCount}`,
    points: Array.from({ length: pointCount }, (_, i) => ({
      lng: -111.3 + i * 0.0001,
      lat: 33.7 + Math.sin(i / 50) * 0.001,
      t: start + i * 1000,
    })),
    createdAt: start,
    visible: pointCount % 2 === 0,
  };
}

export const FIXTURE_TRACKS: Track[] = [
  fixtureTrack("7d2f0c55-5a1e-4b8e-8f0e-0c6b7a1b0001", 1500),
  fixtureTrack("7d2f0c55-5a1e-4b8e-8f0e-0c6b7a1b0002", 3),
];

/** A populated fieldline-v1 envelope as the current app writes it (content plus frozen legacy preferences). */
export function legacyFixtureString(): string {
  return JSON.stringify({
    state: {
      waypoints: [...FIXTURE_WAYPOINTS, FIXTURE_LEGACY_WAYPOINT],
      tracks: FIXTURE_TRACKS,
      basemap: "topo",
      showPublic: true,
      publicOpacity: 0.5,
      imperial: false,
      huntRegion: "id",
      lastKind: "camp",
      activeHunt: "Fixture Unit 22",
      introDismissed: true,
      lastView: { lng: -111.3, lat: 33.7, zoom: 11, bearing: 0, pitch: 0 },
    },
    version: 0,
  });
}

/** localStorage stand-in that counts writes. */
export function fakeLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes += 1;
      values.set(key, value);
    },
    removeItem: (key: string) => {
      writes += 1;
      values.delete(key);
    },
    writes: () => writes,
  };
}

export function fixtureFix(i: number, overrides: Partial<Fix> = {}): Fix {
  return {
    lng: -111.3 + i * 0.0002,
    lat: 33.7 + i * 0.0001,
    t: 1_700_000_000_000 + i * 1000,
    accuracy: 5 + (i % 7),
    altitude: i % 3 === 0 ? null : 1500 + i,
    altitudeAccuracy: i % 3 === 0 ? null : 8,
    speed: i % 4 === 0 ? null : 1.2,
    heading: i % 5 === 0 ? null : (i * 10) % 360,
    ...overrides,
  };
}
