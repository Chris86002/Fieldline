# Phone field test: owner checklist

This checklist is for testing Fieldline's GPS recording on your **iPhone (13 or
newer)** and **Google Pixel**. The results decide whether Fieldline can stay a
web app on phones or needs an app-store app. Nothing is known yet about how your
phones behave: that is what these tests find out.

The test page records a GPS track while you walk and writes a report. Test
tracks stay on the phone, apart from your saved marks and tracks. Nothing is
uploaded unless you share a report.

## 1. Put the test page online (one time, about 5 minutes)

Phones only share location with pages on a secure `https://` address, so the
page has to be online. The simplest free way uses the GitHub account that
already holds Fieldline. **You do these steps; they need your GitHub sign-in.**

1. Wait until the lead engineer has merged the field-test work into `main`.
2. On a computer, open <https://github.com/Chris86002/Fieldline> and sign in.
3. Click **Settings** → **Pages** (left menu). Under **Build and deployment** →
   **Source**, choose **GitHub Actions**. Nothing else on that page needs to
   change.
4. Click **Actions** (top menu) → **Field test page** (left list) → **Run
   workflow** → keep branch `main` → **Run workflow**.
5. Wait for the green check mark (about 2–3 minutes). Click the run, then the
   link under **deploy**. It will be
   **<https://chris86002.github.io/Fieldline/>**.

Note: anyone with that link can open the test page. It holds no data; your test
runs stay on your phones. To take it down later: **Settings** → **Pages** →
**Unpublish site** (or set **Source** back to *None*).

Run step 4 again whenever the lead says there's a new version.

## 2. Open it on each phone

**iPhone:** open **Safari** (not another browser for this round), go to
`https://chris86002.github.io/Fieldline/`, and tap the **reload** button (↻)
in the address bar once (this lets the page reopen later without signal). In
**Settings** → **Privacy & Security** → **Location Services**, make sure
Location Services is on; under **Safari Websites**, choose **While Using the
App** and turn **Precise Location** on.

**Pixel:** open **Chrome**, go to the same address, and reload it once
(**⋮** → ↻). In **Settings** → **Location**, make sure **Use location** is on.

The first time you start a test, the phone asks to share your location:
**Allow**.

Also note down once per phone: the model (iPhone: **Settings** → **General** →
**About**; Pixel: **Settings** → **About phone**) and the iOS / Android version
from the same screen.

## 3. Before each test

- Battery above 30%, and **Low Power Mode / Battery Saver off** (unless the test
  says otherwise).
- Write down the **battery %**. The iPhone never tells web pages its battery
  level, so for the iPhone this note is the only record. The Pixel's report
  includes it.
- Walk outdoors with a clear sky. Standing still can look like a gap: keep
  walking during every test.
- On the test page: pick the **Scenario** number, leave **Keep screen on**
  ticked, then tap **Start test**.

## 4. First round: six tests per phone (about 1½ hours each)

These answer "can a web app record a hunt on this phone?" in the order that
matters most. Run them on **both phones**.

| Order | Test | Why it matters |
| --- | --- | --- |
| 1 | **1. Screen on, app open** | The baseline. If this doesn't record steadily, nothing else will. |
| 2 | **2. Screen locked** | The deciding test. Hunters lock their phones; if recording stops, a web app can't record a hunt. |
| 3 | **3. Other app in front** | Checking a text or a photo mid-hunt is normal. |
| 4 | **9. Airplane mode** | Hunting country often has no signal; recording must not need the network. |
| 5 | **10. App closed by force** | Shows whether points recorded before a crash are kept. |
| 6 | **4. Phone call** | A common interruption; run it if you have time. |

Exact steps (the page shows the same short steps for the chosen test):

1. **Test 1 — Screen on.** Start, walk **10 minutes** with the page showing
   (the full protocol's 30 minutes can wait for round two). Tap **Stop and make
   report**.
2. **Test 2 — Screen locked.** Start, walk 2 minutes, type "locking now" in
   **Note a moment** and tap **Add**, press the side button to lock the phone,
   keep walking **15 minutes**, unlock, walk 1 more minute, stop.
3. **Test 3 — Other app.** Start, walk 2 minutes, add the note "switching",
   open another app (Camera, Messages…) for **10 minutes** while walking, come
   back to the browser, walk 1 minute, stop.
4. **Test 9 — Airplane mode.** Start, walk 2 minutes, turn on **Airplane
   mode** (leave Location on), walk **10 minutes**, turn Airplane mode off,
   walk 1 minute, stop.
5. **Test 10 — Closed by force.** Start, walk **5 minutes**. Look at **Fixes
   saved** and note the number. Close the browser completely (iPhone: swipe up
   from the bottom and hold, then swipe Safari's card up; Pixel: open recent
   apps and swipe Chrome away). Wait 1 minute. Open the browser and the test
   page again. It shows **"Test 10 was interrupted"** and how many fixes it read
   back. Tap **Stop and make report**.
6. **Test 4 — Phone call.** Start, walk 2 minutes, take or make a call of 2–3
   minutes, come back to the browser, walk 1 minute, stop.

If something unexpected happens (an error message, the page reloads by itself,
the screen goes dark in test 1), add a **Note a moment** and take a screenshot.

## 5. What to send back

For each test, on the report shown after **Stop**:

1. Tap **Share report** (or **Download report**) and send the file to the lead
   engineer by email, Messages or AirDrop. Leave **Include map positions**
   unticked unless the lead asks: the report then has times and accuracy but
   not where you walked.
2. Send the **GPX** only if the lead asks (it does contain where you walked).
3. Add in your message: phone model, iOS/Android version, battery % at start
   and end (iPhone), Low Power Mode on/off, and anything odd you noticed.

Every finished test also stays in **Finished runs** on the page, so you can
send reports later. **Delete…** there removes only test runs, never your saved
marks or tracks.

## Second round (later, as the lead requests)

Tests 5 (weak signal), 6 (location permission off), 7 (battery saver),
8 (storage nearly full), 11 (phone restart), 12 (4-hour session) and the full
30-minute test 1, plus repeating test 2 from a **home-screen icon** (Safari:
**Share** → **Add to Home Screen**; Chrome: **⋮** → **Add to Home screen**)
because home-screen web apps can behave differently. Test 13 (app update) isn't
run in this page.

## If the page can't be put online this way

These need extra accounts or downloads; ask the lead before using them.

- **The full Fieldline app** has the same test at `/field-test` (and in
  **Settings** → *Phone field test*) wherever it is served over `https://`.
- **Quick tunnel from your computer** (for example Cloudflare's `cloudflared`,
  a download): gives a temporary `https://` address to the app running on your
  computer. The computer must stay on, and the address changes every time, so
  earlier test runs don't show at the new address.
- **Pixel only, with a USB cable**: Chrome's remote debugging can forward
  `localhost` from a computer to the phone. Needs Android developer options; no
  iPhone equivalent.
- **Home Wi-Fi with a home-made certificate**: needs a certificate tool, and
  installing and fully trusting a certificate on each phone (iPhone:
  **Settings** → **General** → **VPN & Device Management**, then **About** →
  **Certificate Trust Settings**). It only works on your home Wi-Fi.
  Not recommended.
