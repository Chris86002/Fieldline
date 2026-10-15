# Phone strategy (REL-02) and field test protocol (REL-03)

**Status: decision open; field-test tool built (CC-01), no device evidence
yet.** This document frames the decision, lists what must be measured, and
gives the test protocol and result template. Nothing here is a claim that any
phone behavior works. Platform statements marked *verify* come from general
platform knowledge and must be checked against current Apple/Google/browser
documentation before the decision is made.

**Run the tests with:** the [owner checklist](field-test-checklist.md) and the
[field-test tool](#field-test-tool-cc-01).

## What the field experience needs

| Requirement | Why | Source in spec |
| --- | --- | --- |
| Record a track for hours, including with the screen locked | Core field use | §9, REL-01, REL-03 |
| Recover committed points after the app is killed or the phone restarts | No silent data loss | §9, REL-08 |
| Open and use downloaded maps with no network | Offline packages | §8, REL-01 |
| Keep large offline packages without the OS evicting them | Offline packages | §8 |
| Show location, fix age and accuracy honestly | Boundary uncertainty | REL-06, REL-07 |

## Options

1. **PWA only (today's app).** Shared code with desktop, no store fees.
   Expected limits (*verify*): mobile browsers suspend page JavaScript and
   `watchPosition` when the page is hidden or the screen locks, so locked-screen
   recording is not expected to work; storage for home-screen web apps can be
   evicted under pressure, and `navigator.storage.persist()` behavior differs
   by browser. The Screen Wake Lock API (now wired to the "Keep screen on while
   tracking" setting) can keep the screen on while recording, which is a
   workaround, not background recording.
2. **Native-capable shell around the same web app** (for example Capacitor,
   *verify current options*). Reuses the React app and domain code; adds a
   native background-location service and native file storage behind
   platform interfaces. Costs: Apple developer program and Play Console fees,
   signing, store review, and maintaining a location plugin.
3. **Fully native app.** Highest control, highest cost; duplicates UI. Not
   recommended unless options 1–2 fail measured requirements.

**Working recommendation (to confirm with evidence):** keep the PWA for
planning and foreground use, and plan for option 2 if locked-screen recording
is a release requirement. Keep location and storage behind interfaces now so
either choice can plug in:

- `LocationSource`: `start(options)`, `stop()`, emits fixes with timestamp,
  horizontal accuracy, nullable altitude/vertical accuracy, speed, heading
  and source (GPS movement vs compass); emits permission and error state.
- `TrackCheckpointStore`: append fixes in chunks transactionally, read the
  active session after restart, finalize or discard it.
- `PackageStore`: write/read package assets with byte budgets and integrity
  checks (CC-05).

## Field-test tool (CC-01)

A recording prototype that measures, on a real phone, what browser GPS
recording delivers. It does not change the app's own recording (rewiring
`HuntApp` onto `LocationSource` is CC-06).

- **`LocationSource`** (`src/features/location/types.ts`) and its browser
  implementation (`browser.ts`): `watchPosition` fixes with timestamp,
  horizontal accuracy, nullable altitude / vertical accuracy / speed /
  heading (marked as GPS course), receive time; permission and typed errors
  (ADR-009: only a denial ends it); lifecycle signals the browser gives
  (visibilitychange, pagehide/pageshow, freeze/resume where supported,
  online/offline, wake lock acquired/released/error). Pure helpers in
  `analysis.ts` (gaps from fix times, interval and accuracy statistics,
  hidden/frozen/offline periods). A native shell would add a second
  implementation of the same interface.
- **Field-test screen** (`src/features/field-test/`): at `/field-test` in the
  app (also linked at the bottom of Settings) and as a standalone static page
  (`npm run field-test:build` → `dist/field-test/`). The owner picks the
  scenario number (1–13 below), optionally keeps the screen on, and starts.
  Every delivered fix is kept (no accuracy or distance filter) and written
  through the real `TrackCheckpointStore`, so kills and reloads test the app's
  recovery, but into a **separate IndexedDB database, `fieldline-field-test`**:
  test runs never mix with saved tracks or appear as the app's interrupted
  recording. Live counters: fixes saved/received, last-fix age, accuracy,
  largest gap, hidden/shown count, wake-lock state, permission, network.
  A heartbeat logs when page code stopped running ("timers-paused") and saves
  a last-alive record every 15 s and on hide, so a kill shows up on reopening
  as an interruption with the fixes saved before it.
- **Report** (on stop, or after an interrupted run is reopened): gaps over
  15 s with time and distance and how much of each fell while the page was
  hidden / not running / offline / frozen; fix-interval and accuracy
  statistics; hidden, frozen, offline and paused periods with the fixes
  received in each; interruptions; error counts; battery start/end where the
  Battery Status API exists (not in Safari or any iPhone browser: the owner
  notes battery % by hand); device and browser from the user agent (plus model
  from Client Hints on Chromium); build version and commit; the full event
  log. Exports: JSON report (coordinates only when the owner ticks the box),
  GPX (split at gaps), through download or the share sheet where
  `navigator.share` accepts files; a "Copy result template" button fills the
  template below.
- **Verified so far:** unit tests, and `npm run field-test:check` (headless
  Chromium with emulated geolocation, a hidden period, a reload mid-run,
  continue, report, downloads, offline reopen) for both the app route and the
  static page. Desktop Chromium is not a phone: these checks prove the tool,
  not phone behavior.

### Getting the tool onto the phones

Geolocation needs a secure context, so `http://<LAN IP>:8080` does not work on
a phone. Findings (2026-10-14):

- The repository is public on GitHub (`Chris86002/Fieldline`); GitHub Pages is
  not enabled and nothing is hosted. The release workflow builds desktop
  installers only. The app's server functions (weather, search) and
  `/api/dem` need a Node server, so a static host can't serve the whole app.
- The field test needs only the browser (location, IndexedDB, service
  worker), so it also builds as a static page.
- **Recommended: GitHub Pages** via `.github/workflows/field-test-pages.yml`
  (manual run). Free, stable HTTPS address
  (`https://chris86002.github.io/Fieldline/`), no computer left running, no
  install, and the same origin every visit so runs persist and the page
  reopens offline. Owner steps (needs their GitHub sign-in): enable Pages with
  source "GitHub Actions", then run the workflow from `main` (the
  `github-pages` environment normally only deploys the default branch,
  *verify*). The page is public but holds no data.
- Alternatives, each needing a download or account (owner's call): a quick
  tunnel such as Cloudflare's `cloudflared tunnel --url` (no account per
  Cloudflare's docs, *verify*; serves the whole app; computer must stay on;
  new address and so new storage each time); Chrome USB port forwarding
  (Pixel only; `localhost` counts as secure); a self-signed LAN certificate
  (certificate tool needed; iPhone must install the profile and enable full
  trust under Certificate Trust Settings; Android must install a user CA;
  home Wi-Fi only). Hosted platforms (Netlify, Vercel, Cloudflare Pages) need
  accounts.

## Target devices (owner, 2026-10-14)

- **iPhone 13 and newer** (current iOS versions on those models).
- **Google Pixel** (specific model still to name).

## Decision inputs still needed from the owner

- Which Pixel model(s) are available for testing.
- Required recording duration and whether locked-screen recording is a
  release requirement for the first field release.
- Willingness to pay for app-store distribution and signing (Apple developer
  program; Google Play Console).

## Field test protocol

Run every scenario on each physical device in the matrix. Use a consented test
route; keep raw tracks local or export them redacted.

Before each run: record device, OS version, browser or shell version, app
build/commit, settings (track spacing, reject-fix threshold, keep-screen-on),
battery level, battery saver state, free storage.

| # | Scenario | Steps | Pass condition |
| --- | --- | --- | --- |
| 1 | Foreground recording | Start track, walk 30 min with screen on | Continuous points; distance within expected range |
| 2 | Screen locked | Start, lock screen 15 min while walking, unlock | Report gap length; pass only if no gap (PWA expected to fail) |
| 3 | App backgrounded | Start, switch to another app 10 min | Report gap length |
| 4 | Interruption | Receive or place a call during recording | Recording resumes; gap reported |
| 5 | Weak/stale location | Walk into dense cover or a canyon | Poor fixes not drawn as path; UI shows uncertainty |
| 6 | Permission denied / revoked | Deny, then revoke mid-session | Clear message; committed points kept |
| 7 | Battery saver | Enable OS battery saver, record 30 min | Report gaps and battery use |
| 8 | Low storage | Fill storage near full, record | Visible storage error; no corruption |
| 9 | Network loss | Airplane mode during recording | Recording continues; offline maps usable |
| 10 | Process killed | Force-stop during recording, reopen | Report recovered points vs. points before kill |
| 11 | Phone restart | Restart during recording, reopen | Report recovered points |
| 12 | Long session | Record 4+ hours (overnight optional) | Report gaps, battery start/end |
| 13 | Upgrade | Install new build over one with saved content | Marks, tracks, settings intact |

Agree measurable thresholds (maximum acceptable gap, checkpoint loss, battery
use per hour) with the owner before certifying. Do not publish battery-life
promises from these runs.

## Result template

Copy into [field-test-results.md](field-test-results.md) (created with the
first run) for each run. The field-test tool's **Copy result template** fills
the measured lines; tester, battery saver and the result stay manual:

```text
Run ID:
Date:
Tester:
Device / OS:
Browser or shell + version:
App build / commit:
Settings (spacing, reject threshold, keep screen on, battery saver):
Scenario #:
Duration:
Battery start → end:
Points recorded / expected:
Gaps (count, longest, cause if known):
Typical fix accuracy:
Recovered points after kill/restart:
Storage errors:
Exact steps and notes:
Result: pass / fail / limited
```

## Supported-capability matrix

| Platform | Foreground recording | Locked-screen recording | Kill/restart recovery | Offline maps | Status |
| --- | --- | --- | --- | --- | --- |
| Desktop (Electron, Windows) | Depends on OS location | n/a | Checkpoints implemented; verified in desktop Chromium only | Offline map packages | Unverified in Electron |
| Google Pixel, Chrome / PWA | Expected | Not expected | Checkpoints implemented; unverified on device | Offline map packages; eviction unverified | Field-test tool ready; device results pending |
| iPhone 13+, Safari / home-screen app | Expected | Not expected | Checkpoints implemented; unverified on device | Offline map packages; eviction unverified | Field-test tool ready; device results pending |

"Expected" and "Not expected" are platform assumptions, not measurements;
each cell changes only with a field-test report.
