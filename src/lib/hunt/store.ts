import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Basemap, HuntRegion, MapView, MarkKind, Track, Waypoint } from "@/lib/hunt/types";

type HuntState = {
  waypoints: Waypoint[];
  tracks: Track[];
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
  setBasemap: (basemap: Basemap) => void;
  setShowPublic: (showPublic: boolean) => void;
  setPublicOpacity: (publicOpacity: number) => void;
  setShowLabels: (showLabels: boolean) => void;
  setShowRoads: (showRoads: boolean) => void;
  setShowTracks: (showTracks: boolean) => void;
  setShowCreeks: (showCreeks: boolean) => void;
  setShowPeaks: (showPeaks: boolean) => void;
  setShowUnitLabels: (showUnitLabels: boolean) => void;
  setShowBorder: (showBorder: boolean) => void;
  setTerrain: (terrain: boolean) => void;
  setShowMarks: (showMarks: boolean) => void;
  setShowUnits: (showUnits: boolean) => void;
  setShowShade: (showShade: boolean) => void;
  setShowSun: (showSun: boolean) => void;
  setShowRings: (showRings: boolean) => void;
  setImperial: (imperial: boolean) => void;
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
      setBasemap: (basemap) => set({ basemap }),
      setShowPublic: (showPublic) => set({ showPublic }),
      setPublicOpacity: (publicOpacity) => set({ publicOpacity }),
      setShowLabels: (showLabels) => set({ showLabels }),
      setShowRoads: (showRoads) => set({ showRoads }),
      setShowTracks: (showTracks) => set({ showTracks }),
      setShowCreeks: (showCreeks) => set({ showCreeks }),
      setShowPeaks: (showPeaks) => set({ showPeaks }),
      setShowUnitLabels: (showUnitLabels) => set({ showUnitLabels }),
      setShowBorder: (showBorder) => set({ showBorder }),
      setTerrain: (terrain) => set({ terrain }),
      setShowMarks: (showMarks) => set({ showMarks }),
      setShowUnits: (showUnits) => set({ showUnits }),
      setShowShade: (showShade) => set({ showShade }),
      setShowSun: (showSun) => set({ showSun }),
      setShowRings: (showRings) => set({ showRings }),
      setImperial: (imperial) => set({ imperial }),
      setHuntRegion: (huntRegion) => set({ huntRegion }),
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
