import { useMemo, useRef, useState } from "react";
import { Badge, Choice, Toggle } from "@/components/hunt/controls";
import type { MapView } from "@/lib/hunt/types";
import { CATEGORIES, FIELDS, PRESET_IDS, PRESETS, presetControls, SETTING_KEYS, type AppSettings, type SettingKey } from "./schema.ts";
import { BackupSection } from "./BackupSection.tsx";
import { useSettings } from "./store.ts";

/** Why a setting can't take effect here, or null when it can. */
function unavailable(key: SettingKey): string | null {
  if (key === "keepAwake" && typeof navigator !== "undefined" && !("wakeLock" in navigator)) {
    return "This browser can't keep the screen on.";
  }
  return null;
}

function describeView(view: MapView | null): string {
  if (!view) return "Not set";
  return `${Math.abs(view.lat).toFixed(3)}° ${view.lat >= 0 ? "N" : "S"}, ${Math.abs(view.lng).toFixed(3)}° ${view.lng >= 0 ? "E" : "W"} · zoom ${view.zoom.toFixed(1)}`;
}

export function SettingsPanel({ currentView, onNotice }: { currentView: MapView; onNotice: (message: string) => void }) {
  const state = useSettings();
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      SETTING_KEYS.filter((key) => {
        if (!needle) return true;
        const spec = FIELDS[key];
        const category = CATEGORIES.find((item) => item.id === spec.category)?.label ?? "";
        return `${spec.label} ${spec.help} ${category}`.toLowerCase().includes(needle);
      }),
    [needle],
  );

  function exportFile() {
    const blob = new Blob([state.exportText()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "fieldline-settings.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    if (file.size > 256 * 1024) {
      onNotice("That file is too big to be Fieldline settings.");
      return;
    }
    onNotice(state.importText(await file.text()).message);
  }

  function control(key: SettingKey) {
    const spec = FIELDS[key];
    const value = state.effective[key];
    const why = unavailable(key);
    const badge = presetControls(state, key) && state.preset ? PRESETS[state.preset].label.split(" /")[0] : null;
    const set = <K extends SettingKey>(name: K, next: AppSettings[K]) => state.set(name, next);
    if (spec.kind === "toggle") {
      return <Toggle key={key} checked={value as boolean} onChange={(next) => set(key, next as never)} label={spec.label} hint={why ?? spec.help} badge={badge} disabled={why != null} />;
    }
    if (spec.kind === "choice") {
      return (
        <div key={key} className="py-2">
          <p>
            {spec.label}
            {badge ? <Badge text={badge} /> : null}
          </p>
          <p className="text-sm text-muted">{spec.help}</p>
          <Choice value={value as string} choices={spec.choices} onChange={(next) => set(key, next as never)} label={spec.label} />
        </div>
      );
    }
    if (spec.kind === "range") {
      const number = value as number;
      const shown = spec.step < 1 ? number.toFixed(2) : String(number);
      return (
        <label key={key} className="block py-2">
          <span className="flex items-baseline justify-between gap-3">
            <span>
              {spec.label}
              {badge ? <Badge text={badge} /> : null}
            </span>
            <span className="font-mono text-sm tabular-nums">
              {shown}
              {spec.unit ? ` ${spec.unit}` : ""}
            </span>
          </span>
          <span className="block text-sm text-muted">{spec.help}</span>
          <input
            type="range"
            className="mt-1 w-full"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={number}
            aria-label={spec.label}
            onChange={(event) => set(key, Number(event.target.value) as never)}
          />
        </label>
      );
    }
    const view = value as MapView | null;
    return (
      <div key={key} className="py-2">
        <p>{spec.label}</p>
        <p className="font-mono text-sm text-muted tabular-nums">{describeView(view)}</p>
        <div className="mt-1 flex gap-2">
          <button type="button" className="h-10 flex-1 rounded-md border border-line text-sm" onClick={() => state.setHome(currentView)}>
            Use current view
          </button>
          <button type="button" className="h-10 flex-1 rounded-md border border-line text-sm disabled:opacity-40" disabled={!view} onClick={() => set("homeView", null)}>
            Clear
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        type="search"
        className="field h-11"
        value={query}
        placeholder="Search settings"
        aria-label="Search settings"
        onChange={(event) => setQuery(event.target.value)}
      />
      {state.warning ? (
        <div role="alert" className="mt-2 rounded-md bg-danger/20 px-3 py-2 text-sm">
          <p>{state.warning}</p>
          {state.replaceable ? (
            <button type="button" className="mt-2 h-10 w-full rounded-md border border-line text-sm" onClick={() => onNotice(state.replaceSaved().message)}>
              Back up the old copy and save these settings
            </button>
          ) : null}
        </div>
      ) : null}

      {!needle ? (
        <section className="mt-3" aria-labelledby="presets-heading">
          <h3 id="presets-heading" className="font-display text-xl tracking-wide">
            Presets
          </h3>
          <p className="text-sm text-muted">A preset sits on top of your own settings. Turning it off brings yours back.</p>
          <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label="Preset">
            {[null, ...PRESET_IDS].map((id) => (
              <button
                key={id ?? "none"}
                type="button"
                role="radio"
                aria-checked={state.preset === id}
                data-on={state.preset === id}
                onClick={() => state.usePreset(id)}
                className="min-h-12 rounded-md border border-line px-3 py-2 text-left data-[on=true]:border-field data-[on=true]:bg-surface-2"
              >
                <span className="block">{id ? PRESETS[id].label : "My settings"}</span>
                <span className="block text-sm text-muted">{id ? PRESETS[id].description : "No preset. Everything below is your own choice."}</span>
              </button>
            ))}
          </div>
          {state.preset ? (
            <p className="mt-2 text-sm text-muted">
              While {PRESETS[state.preset].label} is on, changing a setting marked with its badge edits the preset, and Reset doesn't change those settings.
            </p>
          ) : null}
          {state.preset && state.presetEdits[state.preset] && Object.keys(state.presetEdits[state.preset] ?? {}).length > 0 ? (
            <button type="button" className="mt-2 h-10 w-full rounded-md border border-line text-sm" onClick={() => state.preset && state.resetPreset(state.preset)}>
              Undo my changes to this preset
            </button>
          ) : null}
        </section>
      ) : null}

      {CATEGORIES.map((category) => {
        const keys = visible.filter((key) => FIELDS[key].category === category.id);
        if (keys.length === 0) return null;
        return (
          <section key={category.id} className="mt-4" aria-labelledby={`settings-${category.id}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 id={`settings-${category.id}`} className="font-display text-xl tracking-wide">
                {category.label}
              </h3>
              <button type="button" className="h-9 px-2 text-sm text-muted" onClick={() => state.resetCategory(category.id)}>
                Reset
              </button>
            </div>
            {keys.map(control)}
          </section>
        );
      })}
      {visible.length === 0 ? <p className="py-3 text-sm text-muted">No setting matches “{query.trim()}”.</p> : null}

      {!needle ? (
        <section className="mt-4" aria-labelledby="settings-transfer">
          <h3 id="settings-transfer" className="font-display text-xl tracking-wide">
            Settings file
          </h3>
          <p className="text-sm text-muted">
            Settings only. Marks and tracks travel in GPX from Saved. Resetting settings never deletes marks, tracks, saved map tiles, or your home area.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="h-11 flex-1 rounded-md border border-line text-sm" onClick={exportFile}>
              Export settings
            </button>
            <button type="button" className="h-11 flex-1 rounded-md border border-line text-sm" onClick={() => fileRef.current?.click()}>
              Import settings
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </section>
      ) : null}
      {!needle ? <BackupSection onNotice={onNotice} /> : null}
      {!needle ? (
        <p className="mt-4 text-sm text-muted">
          Testing on a phone?{" "}
          <a href="/field-test" className="underline">
            Phone field test
          </a>{" "}
          measures GPS recording on this device, separately from your saved tracks.
        </p>
      ) : null}
    </div>
  );
}
