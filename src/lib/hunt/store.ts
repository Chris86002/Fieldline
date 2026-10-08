import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Basemap, MapView, MarkKind, Track, Waypoint } from "@/lib/hunt/types";

type HuntState = {
  waypoints: Waypoint[];
  tracks: Track[];
  basemap: Basemap;
  showPublic: boolean;
  publicOpacity: number;
  showLabels: boolean;
  terrain: boolean;
  showMarks: boolean;
  showShade: boolean;
  showScent: boolean;
  showRings: boolean;
  imperial: boolean;
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
  setBasemap: (basemap: Basemap) => void;
  setShowPublic: (showPublic: boolean) => void;
  setPublicOpacity: (publicOpacity: number) => void;
  setShowLabels: (showLabels: boolean) => void;
  setTerrain: (terrain: boolean) => void;
  setShowMarks: (showMarks: boolean) => void;
  setShowShade: (showShade: boolean) => void;
  setShowScent: (showScent: boolean) => void;
  setShowRings: (showRings: boolean) => void;
  setImperial: (imperial: boolean) => void;
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
      terrain: false,
      showMarks: true,
      showShade: true,
      showScent: true,
      showRings: true,
      imperial: true,
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
      setBasemap: (basemap) => set({ basemap }),
      setShowPublic: (showPublic) => set({ showPublic }),
      setPublicOpacity: (publicOpacity) => set({ publicOpacity }),
      setShowLabels: (showLabels) => set({ showLabels }),
      setTerrain: (terrain) => set({ terrain }),
      setShowMarks: (showMarks) => set({ showMarks }),
      setShowShade: (showShade) => set({ showShade }),
      setShowScent: (showScent) => set({ showScent }),
      setShowRings: (showRings) => set({ showRings }),
      setImperial: (imperial) => set({ imperial }),
      setLastKind: (lastKind) => set({ lastKind }),
      setActiveHunt: (activeHunt) => set({ activeHunt }),
      dismissIntro: () => set({ introDismissed: true }),
      setLastView: (lastView) => set({ lastView }),
    }),
    {
      name: "fieldline-v1",
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({
        waypoints: s.waypoints,
        tracks: s.tracks,
        basemap: s.basemap,
        showPublic: s.showPublic,
        publicOpacity: s.publicOpacity,
        showLabels: s.showLabels,
        terrain: s.terrain,
        showMarks: s.showMarks,
        showShade: s.showShade,
        showScent: s.showScent,
        showRings: s.showRings,
        imperial: s.imperial,
        lastKind: s.lastKind,
        activeHunt: s.activeHunt,
        introDismissed: s.introDismissed,
        lastView: s.lastView,
      }),
    },
  ),
);
