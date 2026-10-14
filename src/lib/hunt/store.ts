import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Basemap, HuntRegion, MapView, MarkKind, Track, Waypoint } from "@/lib/hunt/types";
import { isValidPersistedHuntState } from "./persistence.ts";

let canWriteStorage = false;
let storageWarning: string | null = null;

function notifyStorageWarning(message: string) {
  storageWarning = message;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("fieldline:storage-error"));
}

const huntStorage = createJSONStorage(() => ({
  getItem(name: string) {
    try {
      const value = globalThis.localStorage.getItem(name);
      if (!isValidPersistedHuntState(value)) {
        canWriteStorage = false;
        notifyStorageWarning("Saved data couldn't be read. Its stored copy was left untouched.");
        throw new Error("Invalid saved hunt data.");
      }
      canWriteStorage = true;
      storageWarning = null;
      return value;
    } catch (error) {
      canWriteStorage = false;
      if (!storageWarning) {
        notifyStorageWarning("Browser storage is unavailable. Changes may not be saved on this device.");
      }
      throw error;
    }
  },
  setItem(name: string, value: string) {
    if (!canWriteStorage) return;
    try {
      globalThis.localStorage.setItem(name, value);
    } catch {
      canWriteStorage = false;
      notifyStorageWarning("Browser storage is full or unavailable. Changes may not be saved on this device.");
    }
  },
  removeItem(name: string) {
    if (!canWriteStorage) return;
    try {
      globalThis.localStorage.removeItem(name);
    } catch {
      notifyStorageWarning("Browser storage is unavailable.");
    }
  },
}));

export function getHuntStorageWarning() {
  return storageWarning;
}

/**
 * Preference fields fieldline-v1 stored before versioned settings. They are
 * read once to migrate into `fieldline-settings`, then preserved unchanged so
 * an older Fieldline build still opens this profile with its own preferences.
 * Nothing in the app reads or writes them anymore.
 */
type LegacyPreferences = {
  basemap: Basemap;
  showPublic: boolean;
  publicOpacity: number;
  showLabels: boolean;
  showRoads: boolean;
  showTracks: boolean;
  showCreeks: boolean;
  showPeaks: boolean;
  showUnitLabels: boolean;
  showBorder: boolean;
  terrain: boolean;
  showMarks: boolean;
  showUnits: boolean;
  showShade: boolean;
  showSun: boolean;
  showRings: boolean;
  imperial: boolean;
};

type HuntState = LegacyPreferences & {
  waypoints: Waypoint[];
  tracks: Track[];
  huntRegion: HuntRegion;
  lastKind: MarkKind;
  activeHunt: string;
  introDismissed: boolean;
  lastView: MapView | null;
  addWaypoint: (waypoint: Waypoint) => void;
  updateWaypoint: (id: string, patch: Partial<Omit<Waypoint, "id" | "createdAt">>) => void;
  removeWaypoint: (id: string) => void;
  addTrack: (track: Track) => void;
  toggleTrack: (id: string) => void;
  removeTrack: (id: string) => void;
  importAll: (waypoints: Waypoint[], tracks: Track[]) => void;
  setHuntRegion: (huntRegion: HuntRegion) => void;
  setLastKind: (lastKind: MarkKind) => void;
  setActiveHunt: (activeHunt: string) => void;
  dismissIntro: () => void;
  setLastView: (lastView: MapView) => void;
};

export const useHunt = create<HuntState>()(
  persist(
    (set) => ({
      waypoints: [],
      tracks: [],
      basemap: "hybrid",
      showPublic: true,
      publicOpacity: 0.62,
      showLabels: true,
      showRoads: true,
      showTracks: true,
      showCreeks: true,
      showPeaks: true,
      showUnitLabels: true,
      showBorder: true,
      terrain: false,
      showMarks: true,
      showUnits: true,
      showShade: true,
      showSun: true,
      showRings: true,
      imperial: true,
      huntRegion: "az",
      lastKind: "stand",
      activeHunt: "",
      introDismissed: false,
      lastView: null,
      addWaypoint: (waypoint) => set((s) => ({ waypoints: [waypoint, ...s.waypoints] })),
      updateWaypoint: (id, patch) =>
        set((s) => ({
          waypoints: s.waypoints.map((w) => (w.id === id ? { ...w, ...patch } : w)),
        })),
      removeWaypoint: (id) => set((s) => ({ waypoints: s.waypoints.filter((w) => w.id !== id) })),
      addTrack: (track) => set((s) => ({ tracks: [track, ...s.tracks] })),
      toggleTrack: (id) =>
        set((s) => ({
          tracks: s.tracks.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t)),
        })),
      removeTrack: (id) => set((s) => ({ tracks: s.tracks.filter((t) => t.id !== id) })),
      importAll: (waypoints, tracks) =>
        set((s) => ({
          waypoints: [...waypoints, ...s.waypoints],
          tracks: [...tracks, ...s.tracks],
        })),
      setHuntRegion: (huntRegion) => set({ huntRegion }),
      setLastKind: (lastKind) => set({ lastKind }),
      setActiveHunt: (activeHunt) => set({ activeHunt }),
      dismissIntro: () => set({ introDismissed: true }),
      setLastView: (lastView) => set({ lastView }),
    }),
    {
      name: "fieldline-v1",
      storage: huntStorage,
      skipHydration: true,
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          canWriteStorage = false;
          if (!storageWarning) {
            notifyStorageWarning("Browser storage is unavailable. Changes may not be saved on this device.");
          }
        }
      },
      partialize: (s) => ({
        waypoints: s.waypoints,
        tracks: s.tracks,
        basemap: s.basemap,
        showPublic: s.showPublic,
        publicOpacity: s.publicOpacity,
        showLabels: s.showLabels,
        showRoads: s.showRoads,
        showTracks: s.showTracks,
        showCreeks: s.showCreeks,
        showPeaks: s.showPeaks,
        showUnitLabels: s.showUnitLabels,
        showBorder: s.showBorder,
        terrain: s.terrain,
        showMarks: s.showMarks,
        showUnits: s.showUnits,
        showShade: s.showShade,
        showSun: s.showSun,
        showRings: s.showRings,
        imperial: s.imperial,
        huntRegion: s.huntRegion,
        lastKind: s.lastKind,
        activeHunt: s.activeHunt,
        introDismissed: s.introDismissed,
        lastView: s.lastView,
      }),
    },
  ),
);
