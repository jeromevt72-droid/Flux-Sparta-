# FLUX Sparta on Google Play: Android release guide

This folder holds everything needed to put FLUX on Google Play as a
**Trusted Web Activity** (TWA): a small Android app that opens
https://fluxsparta.com full screen in Chrome. The game itself is not copied
into the app; every update to the website reaches Android players too.

Nothing in this folder is deployed to players. Cloudflare only publishes
`public/`. Gameplay is frozen and unchanged by this work.

| File | What it is |
|---|---|
| `twa-manifest.json` | The Android app settings (package name, launch URL, colours, icons). Same values as the PWABuilder form below. |
| `assetlinks.template.json` | The website-ownership file, **not finished yet**. It needs the Play App Signing fingerprint (step 4). |
| `.gitignore` (here and at the repo root) | Stops signing keys and app builds from being committed anywhere in the repo. The repo is public. |
| `../tests/test-android-twa.mjs` | Release-gate test for all of the above, plus "store closed" and the `?src=playstore` tag. |

---

## 1. Decisions (owner)

- **Package name: `com.fluxsparta.app`.** This is **permanent** once uploaded to
  Play and can never change. It contains no personal name. If you want a
  different one, change it in `twa-manifest.json` and
  `assetlinks.template.json` before the first upload (the test checks they match).
- **Launch URL:** `https://fluxsparta.com/play/?src=playstore`. New players
  who arrive through the Play app are counted as `playstore` in FLUX COMMAND.
  A pilot that already has a stored source keeps it. A pilot from before
  source tracking began, opening the Play app first, is counted as `playstore`.
- **Display:** standalone, the same as today's installed app, so the #75/#78
  full-screen behaviour during runs is exactly what you already tested.
- **Notifications, location, Play Billing:** all **off**.

## 2. Target API level

Google Play requires **Android 16 (API level 36)** for new apps and updates
from **August 31, 2026** (an extension to November 1, 2026 can be requested in
Play Console).

- Google's own TWA tool (Bubblewrap) targets 36 in its current template.
- **PWABuilder:** its public tracker had open requests in July 2026 to move from
  35 to 36, and this could not be confirmed from here. **Check it** after
  uploading (step 4: App bundle explorer → Target SDK). If Play refuses the
  upload or shows 35, see **Plan B** at the end.

## 3. Build the app with PWABuilder (on the iPad, about 15 minutes)

1. In Safari, go to **pwabuilder.com**, enter `https://fluxsparta.com` and tap **Start**.
2. Tap **Package for stores → Android → Generate package**, then **All settings**:

   | Field | Value |
   |---|---|
   | Package ID | `com.fluxsparta.app` |
   | App name | `FLUX Sparta` |
   | Launcher name | `FLUX` |
   | App version / version code | `1.0.0` / `1` |
   | Host | `fluxsparta.com` |
   | Start URL | `/play/?src=playstore` |
   | Theme colour / Dark theme colour | `#07091D` |
   | Background colour | `#050719` |
   | Nav colour / divider colour (and dark) | `#050719` |
   | Icon URL | `https://fluxsparta.com/icon-512.png` |
   | Maskable icon URL | `https://fluxsparta.com/icon-maskable-512.png` |
   | Splash fade-out | `300` ms |
   | Display mode | **Standalone** |
   | Notification delegation | **Off** |
   | Location delegation | **Off** |
   | Google Play billing | **Off** |
   | Fallback behaviour | **Custom Tabs** |
   | Settings shortcut, ChromeOS only, Meta Quest | **Off** |
   | Signing key | **Create new** |

3. **Signing key fields:** for the key's name, organisation and city, use
   **FLUX Sparta**, not your own name. These details are written inside the app
   file, and anyone can read them.
4. Tap **Download**. In the Files app, open the zip. It contains:
   - `*.aab`: the file you upload to Play.
   - `signing.keystore` + `signing-key-info.txt`: your **upload key, its alias
     and its passwords**. Save both somewhere safe and private (a password manager or a
     private cloud folder). **Never upload them to GitHub, email or chat.**
     Losing them means asking Google for an upload-key reset.
   - `assetlinks.json`: it holds the **upload key** fingerprint only. **Do not
     publish it as-is**; see step 5.

## 4. Play Console: internal testing

1. **Create app:** name *FLUX Sparta*, default language, **Game**, **Free**, accept the declarations.
2. **Testing → Internal testing → Create new release.** Accept **Play App
   Signing** (Google keeps the final signing key). Upload the `.aab`, add a short
   release note, then **Save → Review → Start rollout**.
3. **Testers:** create an email list (up to 100 Gmail addresses), then copy the
   **opt-in link** and send it to your testers.
4. **Check the target API:** *App bundle explorer* → the bundle → **Target SDK** must say **36**.
5. **Get the fingerprint:** *Test and release → App integrity → App signing* →
   **App signing key certificate → SHA-256**. Copy that one, **not** the
   *Upload key certificate*.

Internal testing has no review wait and **does not count** toward the 14-day
rule below. Use it to test on the BLU right away.

## 5. Finish website verification (Digital Asset Links)

Until this is live, the Android app works but shows a **browser address bar** at
the top. That's how you can tell verification failed.

Give Claude Code this, with the real SHA-256 pasted in:

```
Finalize Digital Asset Links for the Play app (package com.fluxsparta.app).
Play App Signing SHA-256 (App signing key certificate): <PASTE HERE>
Replace the [] in public/.well-known/assetlinks.json with the contents of
android/assetlinks.template.json, with the placeholder replaced by this
fingerprint (uppercase, colon-separated), and put the same text in
ASSETLINKS_BODY in worker.js. Do not use the upload-key fingerprint in place of
it. tests/test-android-twa.mjs must pass (T3, T7). Run the full gate, open a PR,
don't merge or deploy.
```

After you merge and it deploys, check in Safari:

1. `https://fluxsparta.com/.well-known/assetlinks.json` shows the JSON with
   `com.fluxsparta.app` and your fingerprint (not a 404 page).
2. Google's checker:
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://fluxsparta.com&relation=delegate_permission/common.handle_all_urls`
   lists `com.fluxsparta.app` with the same fingerprint.
3. On the BLU, **uninstall and reinstall** the Play test app: **no address bar**
   at the top means verification passed.

`/.well-known/assetlinks.json` is answered by `worker.js` (that one exact path is
in `run_worker_first` in `wrangler.jsonc`): always `200`, `Content-Type:
application/json`, **no redirect**, whether or not Cloudflare's static file layer
serves a folder whose name starts with a dot. Until the fingerprint is added it
is an empty list, `[]`.

## 6. Closed testing: the 14-day rule (for production)

Personal developer accounts created after November 13, 2023 must run a **closed
test with at least 12 testers who stay opted in for 14 days in a row** before
they can apply for production. Internal testing does not count.

- **Testing → Closed testing → Create track.** Promote the same release, add
  testers, and share the opt-in link.
- Aim for **15–20** testers. If anyone leaves, you still have 12.
- Ask them to actually play a few times a week. When you apply, Google asks
  about the test and your testers' feedback.
- After 14 days: **Dashboard → Apply for production**. Google's review comes after that.

## 7. Play Console declarations (based on how FLUX is actually built)

| Section | Answer, from the code and `privacy.html` |
|---|---|
| **Privacy policy URL** | `https://fluxsparta.com/privacy.html` |
| **App access** | All functionality is available without special access. No login. |
| **Ads** | No ads. |
| **Content rating** (IARC questionnaire) | Arcade colour-match game, no violence, no gambling. Players' pilot names, country and scores are **shown publicly** on leaderboards (names are word-list or one-word, filtered). No chat, no messaging. No purchases while the store is closed. |
| **Target audience** | **Owner decision.** FLUX is for all ages. If you include **under-13** age groups, Google's **Families policy** applies (stricter data, ads and content rules). Pick the ages FLUX really targets. Don't pick 18+ just to avoid the rules. |
| **Data safety: collected** | **App activity** (gameplay stats: runs, levels, sessions) for analytics and app functionality. **HELP topics** (topic + pilot name and tag, deleted within 90 days) for app functionality / support. **App info and performance** is not collected. **Device or other IDs**: the random player identifier (made by the app, not by the device) for app functionality and analytics. **Name**: the public pilot nickname, for app functionality. **Approximate location**: country (chosen by the player, or Cloudflare's country for the connection). Declaring it is the cautious answer; check Google's definition. |
| **Data safety: not collected** | Precise location, email, phone, contacts, photos, payment info (store closed), advertising ID. |
| **Data safety: shared** | None. Cloudflare is the hosting provider (a service provider, not "sharing"). Stripe only applies once the store opens. |
| **Security** | Encrypted in transit (HTTPS): yes. Deletion: by email request (no accounts exist). |
| **Government, financial, health, news** | No. |

**Before submitting, fix in `privacy.html`:** it still shows two
*"For lawyer review before launch"* notes publicly; it names the operator by
personal name in sections 1 and 17, and shows the old address containing
`jeromevt72` in section 5 (see the anonymity checklist); it says deleting the
app removes all stored data, which is **not true for the Play app** (uninstalling
it does not clear Chrome's site data; the player clears it in Chrome's site
settings); and it should mention that FLUX is also available on Google Play. Google
requires the policy to name the developer and a privacy contact. Decide what
name to use there; the Play developer name can be *FLUX Sparta*.

**Store listing assets:**

- **App icon** 512×512, 32-bit PNG ≤1 MB: `public/icon-maskable-512.png` qualifies.
- **Feature graphic** 1024×500, JPEG or 24-bit PNG: **missing, needs making.**
- **Phone screenshots:** at least 2, longest side ≤ twice the shortest side.
  BLU screenshots (720×1600) are **too tall**. Crop to 720×1440 or less (trim the
  status bar). Show no personal name.
- Short description (≤80 characters), full description (≤4000), category **Arcade**,
  contact email `playfluxofficial@gmail.com`.

**Account:** identity verification (government ID), phone and email
verification, and Android device verification through the **Play Console app**
on the BLU.

## 8. Purchases on Android

- **Today the Play app cannot start a Stripe checkout.** The Play app opens the
  game (`/play/`) directly, so **two locks** protect it:
  `STORE_OPEN = false` in the game (the BUY path shows *COMING SOON* and sends
  nothing), and `"STORE_OPEN": "false"` on the server (403 `STORE_CLOSED`, so
  no Stripe page can be created). The Gateway's own Stripe check does not apply
  inside the Play app.
  `test-android-twa.mjs` (T5) and `test-audit-fixes.mjs` (A-4) check this in
  every gate.
- **Before the website store opens, an Android guard IS needed.** The Play app
  runs the same web code, so opening the store on the website would also open
  Stripe checkout inside the Play app. Google Play's payments policy generally
  requires **Google Play Billing** for digital items like skins in Play apps
  (rules vary by region; check the policy at that time). The options: keep the
  store hidden whenever FLUX runs inside the Play app (it can tell from
  `document.referrer` = `android-app://com.fluxsparta.app` on launch), or add
  Play Billing (PWABuilder's *Google Play billing* option plus the Digital Goods
  API). This needs its own PR and decision.

## 9. BLU G45 acceptance checklist (real device; nothing here is verified yet)

Install from the **internal testing** opt-in link, signed in with a tester Gmail.

| # | Check | Pass when |
|---|---|---|
| 1 | Install | Installs from Play; the icon shows the FLUX logo and the name **FLUX** (not a gray "F"). |
| 2 | Launch | Opens straight into the game menu, dark splash, **no address bar** (after step 5). |
| 3 | Same pilot | If this phone already played FLUX in Chrome, the same pilot and best scores appear. (Only when Chrome is the browser that runs the Play app; another default browser keeps separate storage.) |
| 4 | First run | A new pilot's first run is smooth from the start (needs the first-run fix PR). |
| 5 | Touch | Launcher drag, aiming and release work; nothing scrolls or zooms. |
| 6 | Full screen | During a run the system buttons hide. A slide along the bottom never pauses or ends the run. |
| 7 | Back button | During a run: the run continues. On pause/game over/menu: goes back as in the installed app. It never closes the app mid-run. |
| 8 | Restart | Game over → RUN IT BACK starts a new run with the same pilot. |
| 9 | Background / resume | Home button mid-run → reopen: paused, nothing lost, sound returns. |
| 10 | Swipe away / reopen | Close from Recents, reopen: same pilot, same bests. |
| 11 | Offline reopen | After **one complete run** online (so the offline copy is certainly installed, whichever release is live), turn Wi-Fi off, swipe the app away, reopen: the game loads and plays. The score uploads when back online. |
| 12 | Leaderboard | World Grid and your country show; a new best appears after a run. |
| 13 | Store | Skins show **COMING SOON**; nothing opens a payment page. |
| 14 | Rotation | Turn the phone sideways mid-run: nothing breaks. |
| 15 | Heat / speed | A 5–10 minute session: no stutter, the phone is only mildly warm. |

## 10. Plan B: build with Google's Bubblewrap if PWABuilder isn't on API 36

Use this if Play rejects the PWABuilder bundle for its target API. Bubblewrap's
current template targets 36, and this folder's `twa-manifest.json` is already in
Bubblewrap's format. It needs a computer with Java and the Android SDK, or a
GitHub Actions job set up by Claude Code (signing key stored as GitHub
**Secrets**, never in the repo). `twa-manifest.json` expects PWABuilder's key
file name, `signing.keystore`; set its `alias` from `signing-key-info.txt`. Ask Claude Code to
set it up as its own PR.
