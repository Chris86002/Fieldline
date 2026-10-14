import { useRef, useState } from "react";
import { APP_VERSION } from "@/lib/app-version";
import { applyBackup, checkBackup, makeBackup, useContentSync, type RestoreCheck } from "@/lib/hunt/content-sync";
import { backupFileName } from "@/lib/storage";
import { useSettings } from "./store.ts";

const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** Full backup (settings, marks, tracks, recently deleted) and restore, plus where content is kept. */
export function BackupSection({ onNotice }: { onNotice: (message: string) => void }) {
  const mode = useContentSync((state) => state.mode);
  const persistence = useContentSync((state) => state.persistence);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Extract<RestoreCheck, { ok: true }> | null>(null);
  const [busy, setBusy] = useState(false);

  async function exportBackup() {
    setBusy(true);
    try {
      const { prefs, preset, presetEdits } = useSettings.getState();
      const text = await makeBackup({ prefs, preset, presetEdits }, APP_VERSION);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFileName(new Date());
      link.click();
      URL.revokeObjectURL(url);
      onNotice("Backup saved. Keep it somewhere other than this device.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't make a backup.");
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    if (file.size > MAX_BACKUP_BYTES) {
      onNotice("That file is too big to be a Fieldline backup.");
      return;
    }
    const checked = await checkBackup(await file.text());
    if (!checked.ok) {
      onNotice(checked.message);
      return;
    }
    setPending(checked);
  }

  async function restore() {
    if (!pending) return;
    setBusy(true);
    try {
      onNotice(await applyBackup(pending.backup, (text) => useSettings.getState().importText(text)));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't restore that backup. Nothing was changed.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const where =
    mode === "repository"
      ? persistence === "granted"
        ? "Marks and tracks are kept in this browser's database, and the browser has agreed not to clear it on its own."
        : "Marks and tracks are kept in this browser's database. The browser may still clear it if the device runs low on space, so keep a backup."
      : mode === "legacy"
        ? "Marks and tracks are kept in this browser's basic storage. Full backups need the upgraded storage, which isn't available here; use Export GPX in Saved."
        : "Opening saved content…";

  return (
    <section className="mt-4" aria-labelledby="settings-backup">
      <h3 id="settings-backup" className="font-display text-xl tracking-wide">
        Backup and restore
      </h3>
      <p className="text-sm text-muted">{where}</p>
      <p className="mt-1 text-sm text-muted">A backup holds settings, marks, tracks, and recently deleted items in one file. GPX is still the way to share with other apps.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={mode !== "repository" || busy} className="h-11 flex-1 rounded-md border border-line text-sm disabled:opacity-40" onClick={() => void exportBackup()}>
          Make backup
        </button>
        <button type="button" disabled={mode !== "repository" || busy} className="h-11 flex-1 rounded-md border border-line text-sm disabled:opacity-40" onClick={() => fileRef.current?.click()}>
          Restore…
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
          if (file) void readFile(file);
        }}
      />
      {pending ? (
        <div role="alertdialog" aria-label="Confirm restore" className="mt-2 rounded-md border border-line bg-bg px-3 py-2 text-sm">
          <p>
            This backup adds {pending.plan.add.waypoints} marks, {pending.plan.add.tracks} tracks and {pending.plan.add.trash} recently deleted items.
            {pending.plan.identical.waypoints + pending.plan.identical.tracks > 0
              ? ` ${pending.plan.identical.waypoints + pending.plan.identical.tracks} are already here and will be skipped.`
              : ""}
            {pending.plan.conflicts.length
              ? ` ${pending.plan.conflicts.length} differ from what's on this device; this device's versions are kept.`
              : ""}{" "}
            Its settings replace your current settings. Nothing on this device is deleted.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} className="h-10 flex-1 rounded-md bg-accent text-sm font-medium text-accent-fg" onClick={() => void restore()}>
              Restore
            </button>
            <button type="button" className="h-10 flex-1 rounded-md border border-line text-sm" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
