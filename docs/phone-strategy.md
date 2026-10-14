# Phone strategy (REL-02) and field test protocol (REL-03)

**Status: decision open; no device evidence yet.** This document frames the
decision, lists what must be measured, and gives the test protocol and result
template. Nothing here is a claim that any phone behavior works. Platform
statements marked *verify* come from general platform knowledge and must be
checked against current Apple/Google/browser documentation before the
decision is made.

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

## Decision inputs still needed from the owner

- Target phones (iOS/Android versions, specific models available for testing).
- Required recording duration and whether locked-screen recording is a
  release requirement for the first field release.
- Willingness to pay for app-store distribution and signing.

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
first run) for each run:

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
| Desktop (Electron, Windows) | Depends on OS location | n/a | Not implemented (CC-06) | Partial tile cache only | Unverified |
| Android browser / PWA | Expected | Not expected | Not implemented | Partial | Pending device tests |
| iOS Safari / home-screen app | Expected | Not expected | Not implemented | Partial | Pending device tests |
