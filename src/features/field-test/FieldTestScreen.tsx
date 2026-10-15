import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatDuration, resultTemplate, type FieldTestReport } from "./report.ts";
import type { ExportFile, FieldTestRecorder, RecorderState } from "./recorder.ts";
import type { BuildInfo, RunEvent } from "./run-store.ts";
import { FIRST_ROUND, SCENARIOS, scenarioByNumber } from "./scenarios.ts";
import { getRecorder } from "./environment.ts";

/**
 * Phone field-test screen (CC-01). Records test runs through the
 * LocationSource into a separate test database and turns each run into a
 * report the owner sends back. Plain layout, large text and buttons: it is
 * used outdoors, one-handed, often in sun.
 */
export function FieldTestScreen({ flavor }: { flavor: BuildInfo["flavor"] }) {
  const [recorder, setRecorder] = useState<FieldTestRecorder | null>(null);
  useEffect(() => {
    let live = true;
    void getRecorder(flavor).then((instance) => {
      if (live) setRecorder(instance);
    });
    return () => {
      live = false;
    };
  }, [flavor]);

  return (
    <main className="h-dvh overflow-y-auto bg-bg text-fg" data-testid="field-test">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <header>
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-display text-3xl tracking-wide">Phone field test</h1>
            {flavor === "app" ? (
              <a href="/" className="text-sm text-muted underline">
                Back to map
              </a>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            Measures what GPS recording in a web app can do on this phone. Test runs stay on this phone in separate test storage: they never
            appear in your saved tracks, and nothing is uploaded unless you share a report.
          </p>
        </header>
        {recorder ? <Body recorder={recorder} /> : <p className="text-muted">Opening test storage…</p>}
      </div>
    </main>
  );
}

function Body({ recorder }: { recorder: FieldTestRecorder }) {
  const state = useSyncExternalStore(recorder.subscribe, recorder.getState, recorder.getState);
  const [selected, setSelected] = useState<FieldTestReport | null>(null);
  // A new run's report replaces whichever older one was opened.
  useEffect(() => {
    if (state.phase === "running") setSelected(null);
  }, [state.phase]);
  const shown = selected ?? state.lastReport;
  const secure = typeof window === "undefined" || window.isSecureContext;
  const hasGeo = typeof navigator === "undefined" || "geolocation" in navigator;

  return (
    <>
      {!secure ? (
        <Alert>
          This page isn't on a secure (https://) address, so the phone won't share its location. Open it from the https:// link in the
          checklist.
        </Alert>
      ) : null}
      {secure && !hasGeo ? <Alert>This browser has no location service.</Alert> : null}
      {state.storageError ? <Alert>{state.storageError}</Alert> : null}

      {state.phase === "recovered" ? <Recovered state={state} recorder={recorder} /> : null}
      {state.phase === "running" || state.phase === "finishing" ? <Live state={state} recorder={recorder} /> : null}
      {state.events.length && state.phase !== "idle" ? <EventLog events={state.events} /> : null}
      {shown && state.phase === "idle" ? <ReportCard key={shown.run.id} report={shown} recorder={recorder} /> : null}
      {state.phase === "idle" ? <Setup recorder={recorder} /> : null}
      <PastRuns reports={state.reports} current={shown?.run.id ?? null} onShow={setSelected} recorder={recorder} />
    </>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md bg-danger/25 px-3 py-2 text-sm">
      {children}
    </div>
  );
}

function Card({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-label={label ?? title}>
      <h2 className="font-display text-xl tracking-wide">{title}</h2>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </section>
  );
}

const primary = "h-14 w-full rounded-md bg-accent text-lg font-semibold text-accent-fg disabled:opacity-40";
const secondary = "h-12 w-full rounded-md border border-line text-base disabled:opacity-40";

/* ---------- Setup ---------- */

function Setup({ recorder }: { recorder: FieldTestRecorder }) {
  const [scenario, setScenario] = useState<number>(FIRST_ROUND[0]);
  const [keepScreenOn, setKeepScreenOn] = useState(true);
  const [note, setNote] = useState("");
  const [starting, setStarting] = useState(false);
  const chosen = scenarioByNumber(scenario);
  return (
    <Card title="New test run">
      <label className="flex flex-col gap-1">
        <span>Scenario</span>
        <select
          className="field h-12 rounded-md border border-line bg-surface-2 px-2 text-base"
          value={scenario}
          onChange={(event) => setScenario(Number(event.target.value))}
          aria-label="Scenario"
        >
          {SCENARIOS.map((item) => (
            <option key={item.number} value={item.number}>
              {item.number}. {item.title}
              {(FIRST_ROUND as readonly number[]).includes(item.number) ? " (first round)" : ""}
            </option>
          ))}
        </select>
      </label>
      {chosen ? (
        <p className="text-sm text-muted" data-testid="scenario-steps">
          {chosen.steps}
          {chosen.minutes ? ` About ${chosen.minutes} minutes.` : ""}
        </p>
      ) : null}
      <label className="flex min-h-12 items-center gap-3">
        <input type="checkbox" className="size-6" checked={keepScreenOn} onChange={(event) => setKeepScreenOn(event.target.checked)} />
        <span>
          Keep screen on
          <span className="block text-sm text-muted">Stops the screen turning itself off while this page shows. Pressing the side button still locks the phone.</span>
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span>Note (optional)</span>
        <input
          className="field h-12 rounded-md border border-line bg-surface-2 px-2 text-base"
          value={note}
          maxLength={500}
          placeholder="e.g. Low Power Mode on, walking the creek trail"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button
        type="button"
        className={primary}
        disabled={starting}
        onClick={() => {
          setStarting(true);
          void recorder.start({ scenario, keepScreenOn, note }).finally(() => setStarting(false));
        }}
      >
        Start test {scenario}
      </button>
      <p className="text-sm text-muted">The phone will ask to use your location. Allow it, ideally “While using the app” / “Allow”.</p>
    </Card>
  );
}

/* ---------- Live ---------- */

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className={`font-mono text-xl tabular-nums ${warn ? "text-danger" : ""}`}>{value}</div>
    </div>
  );
}

function Live({ state, recorder }: { state: RecorderState; recorder: FieldTestRecorder }) {
  const now = useClock(state.phase === "running");
  const [mark, setMark] = useState("");
  const run = state.run;
  const fixAge = state.lastFix ? now - state.lastFix.receivedAt : null;
  const scenario = run ? scenarioByNumber(run.scenario) : null;
  return (
    <Card title={`Recording test ${run?.scenario ?? ""}`} label="Live test">
      {scenario ? <p className="text-sm text-muted">{scenario.steps}</p> : null}
      <div className="grid grid-cols-2 gap-2" data-testid="live-counters">
        <Stat label="Elapsed" value={run ? formatDuration(now - run.startedAt) : "–"} />
        <Stat label="Fixes saved" value={`${state.saved} / ${state.received}`} />
        <Stat label="Last fix age" value={fixAge == null ? "waiting" : formatDuration(fixAge)} warn={fixAge != null && fixAge > 15_000} />
        <Stat label="Accuracy" value={state.lastFix ? `${Math.round(state.lastFix.accuracy)} m` : "–"} warn={(state.lastFix?.accuracy ?? 0) > 50} />
        <Stat label="Largest gap" value={formatDuration(state.largestGapMs)} warn={state.largestGapMs > 15_000} />
        <Stat label="Hidden / shown" value={String(state.visibilityChanges)} />
        <Stat label="Screen on" value={state.wakeLock} />
        <Stat label="Location" value={state.permission} warn={state.permission === "denied"} />
        <Stat label="Network" value={state.online ? "online" : "offline"} />
        <Stat label="Duplicates" value={String(state.duplicates)} />
      </div>
      {state.lastError ? <p className="text-sm text-danger">{state.lastError}</p> : null}
      <div className="flex gap-2">
        <input
          className="field h-12 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 text-base"
          value={mark}
          maxLength={200}
          placeholder="Note a moment (e.g. locking now)"
          aria-label="Note a moment"
          onChange={(event) => setMark(event.target.value)}
        />
        <button
          type="button"
          className="h-12 rounded-md border border-line px-4"
          onClick={() => {
            recorder.mark(mark);
            setMark("");
          }}
        >
          Add
        </button>
      </div>
      <button type="button" className={primary} disabled={state.phase !== "running"} onClick={() => void recorder.stop()}>
        {state.phase === "finishing" ? "Making report…" : "Stop and make report"}
      </button>
    </Card>
  );
}

/* ---------- Recovery ---------- */

function Recovered({ state, recorder }: { state: RecorderState; recorder: FieldTestRecorder }) {
  const active = state.recovered;
  if (!active || !state.run) return null;
  const recoveredEvent = [...state.events].reverse().find((event) => event.type === "recovered");
  const before = recoveredEvent?.data?.savedBefore;
  const lastAlive = recoveredEvent?.data?.lastAliveAt;
  return (
    <Card title={`Test ${state.run.scenario} was interrupted`} label="Interrupted run">
      <p data-testid="recovered-summary">
        {active.recovered.fixCount} fixes were read back from storage
        {typeof before === "number" ? ` (${before} were saved at the last check before the interruption)` : ""}.
        {typeof lastAlive === "number" ? ` The page last ran ${formatDuration(Date.now() - lastAlive)} ago.` : ""}
      </p>
      {!active.recovered.intact ? <Alert>{active.recovered.lostFixes} saved fixes couldn't be read back.</Alert> : null}
      <p className="text-sm text-muted">For test 10 or 11, tap “Stop and make report”. To keep recording the same run, tap “Continue”.</p>
      <button type="button" className={primary} onClick={() => void recorder.stop()}>
        Stop and make report
      </button>
      <button type="button" className={secondary} onClick={() => void recorder.continueRecovered()}>
        Continue this run
      </button>
    </Card>
  );
}

/* ---------- Event log ---------- */

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function EventLog({ events }: { events: RunEvent[] }) {
  const recent = events.slice(-60).reverse();
  return (
    <Card title="Event log">
      <ol className="flex flex-col gap-1 font-mono text-sm" data-testid="event-log">
        {recent.map((event) => (
          <li key={event.seq} className="flex gap-2">
            <span className="text-muted tabular-nums">{time(event.at)}</span>
            <span>
              {event.type}
              {event.detail ? <span className="text-muted"> · {event.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {events.length > recent.length ? <p className="text-sm text-muted">Showing the last {recent.length} of {events.length}. The report has all of them.</p> : null}
    </Card>
  );
}

/* ---------- Report ---------- */

function saveFile(file: ExportFile) {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function shareable(file: ExportFile): File | null {
  try {
    const shared = new File([file.text], file.name, { type: file.type });
    return typeof navigator.share === "function" && navigator.canShare?.({ files: [shared] }) ? shared : null;
  } catch {
    return null;
  }
}

function FileButtons({ file, label }: { file: ExportFile | null; label: string }) {
  const [note, setNote] = useState<string | null>(null);
  const share = file ? shareable(file) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <button type="button" className={secondary} disabled={!file} onClick={() => file && saveFile(file)}>
          Download {label}
        </button>
        {share ? (
          <button
            type="button"
            className={secondary}
            onClick={() => {
              navigator.share({ files: [share], title: share.name }).catch((error: unknown) => {
                if (!(error instanceof DOMException && error.name === "AbortError")) setNote("Sharing didn't work here; use Download.");
              });
            }}
          >
            Share {label}
          </button>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}

function ReportCard({ report, recorder }: { report: FieldTestReport; recorder: FieldTestRecorder }) {
  const [withCoordinates, setWithCoordinates] = useState(false);
  const [json, setJson] = useState<ExportFile | null>(null);
  const [gpx, setGpx] = useState<ExportFile | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // Files are prepared ahead, so Share runs straight from the tap (browsers require that).
  useEffect(() => {
    let live = true;
    setJson(null);
    void recorder.exportJson(report, withCoordinates).then((file) => live && setJson(file));
    return () => {
      live = false;
    };
  }, [recorder, report, withCoordinates]);
  useEffect(() => {
    let live = true;
    void recorder.exportGpx(report).then((file) => live && setGpx(file));
    return () => {
      live = false;
    };
  }, [recorder, report]);
  const template = resultTemplate(report);
  const accuracy = report.accuracyM.stats;
  return (
    <Card title={`Report: test ${report.run.scenario}, ${report.run.scenarioTitle}`} label="Report">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="report-summary">
        <dt className="text-muted">Started</dt>
        <dd>{new Date(report.run.startedAt).toLocaleString()}</dd>
        <dt className="text-muted">Duration</dt>
        <dd>{formatDuration(report.run.durationMs)}</dd>
        <dt className="text-muted">Fixes</dt>
        <dd>
          {report.counts.fixesSaved} saved{report.counts.fixesReceived != null ? `, ${report.counts.fixesReceived} received` : ""}
          {report.counts.lostFixes ? `, ${report.counts.lostFixes} lost` : ""}
        </dd>
        <dt className="text-muted">Gaps &gt; {formatDuration(report.gaps.thresholdMs)}</dt>
        <dd>
          {report.gaps.count}, longest {formatDuration(report.gaps.longestMs)}, total {formatDuration(report.gaps.totalMs)}
        </dd>
        <dt className="text-muted">Hidden</dt>
        <dd>
          {report.hidden.count}× for {formatDuration(report.hidden.totalMs)}, {report.hidden.periods.reduce((sum, period) => sum + period.fixes, 0)} fixes while hidden
        </dd>
        <dt className="text-muted">Interruptions</dt>
        <dd>
          {report.interruptions.length
            ? report.interruptions.map((item) => `${item.fixesRecovered ?? "?"} fixes recovered after ${formatDuration(item.downMs)} down`).join("; ")
            : "none"}
        </dd>
        <dt className="text-muted">Fix interval</dt>
        <dd>
          median {report.intervalsS.median?.toFixed(1) ?? "–"} s, 95% under {report.intervalsS.p95?.toFixed(1) ?? "–"} s
        </dd>
        <dt className="text-muted">Accuracy</dt>
        <dd>
          median {accuracy.median?.toFixed(0) ?? "–"} m, 90% within {accuracy.p90?.toFixed(0) ?? "–"} m
        </dd>
        <dt className="text-muted">Battery</dt>
        <dd>
          {report.battery.start || report.battery.end
            ? `${report.battery.start ? Math.round(report.battery.start.level * 100) : "?"}% → ${report.battery.end ? Math.round(report.battery.end.level * 100) : "?"}%`
            : report.battery.note}
        </dd>
      </dl>
      <label className="flex min-h-12 items-center gap-3 text-sm">
        <input type="checkbox" className="size-6" checked={withCoordinates} onChange={(event) => setWithCoordinates(event.target.checked)} />
        <span>Include map positions in the report (off: times, accuracy and gap distances only)</span>
      </label>
      <FileButtons file={json} label="report" />
      {gpx === null ? <p className="text-sm text-muted">No GPX: the run kept fewer than two fixes.</p> : <FileButtons file={gpx ?? null} label="GPX" />}
      <details>
        <summary className="cursor-pointer py-2">Result template (for field-test-results.md)</summary>
        <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap" data-testid="result-template">
          {template}
        </pre>
        <button
          type="button"
          className={secondary}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(template)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? "Copied" : "Copy result template"}
        </button>
      </details>
    </Card>
  );
}

/* ---------- Past runs ---------- */

function PastRuns({
  reports,
  current,
  onShow,
  recorder,
}: {
  reports: FieldTestReport[];
  current: string | null;
  onShow: (report: FieldTestReport | null) => void;
  recorder: FieldTestRecorder;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!reports.length) return null;
  return (
    <Card title="Finished runs">
      <ul className="flex flex-col gap-2" data-testid="past-runs">
        {reports.map((report) => (
          <li key={report.run.id} className="rounded-md bg-surface-2 p-3">
            <p>
              Test {report.run.scenario}: {report.run.scenarioTitle}
            </p>
            <p className="text-sm text-muted">
              {new Date(report.run.startedAt).toLocaleString()} · {formatDuration(report.run.durationMs)} · {report.counts.fixesSaved} fixes · longest gap{" "}
              {formatDuration(report.gaps.longestMs)}
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="h-10 flex-1 rounded-md border border-line text-sm disabled:opacity-40" disabled={current === report.run.id} onClick={() => onShow(report)}>
                {current === report.run.id ? "Shown above" : "Show report"}
              </button>
              {confirm === report.run.id ? (
                <button
                  type="button"
                  className="h-10 flex-1 rounded-md bg-danger text-sm"
                  onClick={() => {
                    setConfirm(null);
                    if (current === report.run.id) onShow(null);
                    void recorder.deleteRun(report.run.id);
                  }}
                >
                  Delete this test run
                </button>
              ) : (
                <button type="button" className="h-10 flex-1 rounded-md border border-line text-sm" onClick={() => setConfirm(report.run.id)}>
                  Delete…
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">These are test runs only. Deleting one never touches your saved marks or tracks.</p>
    </Card>
  );
}
