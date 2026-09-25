# FLUX RC2.8.6 (build 2) — lite graphics, play-first Gateway, install after first game
> **build 2 supersedes build 1**: the install button was removed from the menu (owner decision). Use only `FLUX-RC2.8.6-build2.zip`.

## Store stays closed · no live keys · builds on RC2.8.5 build 3 (live, Cloudflare 2bb8db47 → current)

| ID | Change | Evidence |
|---|---|---|
| D-46 | **Lite graphics for slow devices.** The first seconds of play are timed (after a short warm-up, 60 frames); if most frames take over 25 ms (under 40 fps) the device switches to lite and remembers it: normal (non-Retina) sharpness, canvas glow off, half the particles, and the moving background calmed (star drift frozen, blurred nebula hidden, no FLUX-Mode full-screen filter). Gameplay, speed rules and scoring unchanged. Fast devices never switch. | Owner's iPad mini 4 (iPadOS 15.8) ran in slow motion. Measured here in a slow browser: 217 ms → 17 ms per frame (×12.8); the moving background layers, not the game drawing (<1 ms), were the main cost. |
| D-47 | **PLAY goes straight into the game** on phones and tablets. The Gateway's "get the app first" screen before a first game no longer appears (its markup stays in the page, unused). | Owner: install before playing is friction; Google-search visitors land on the Gateway. |
| D-48 | **Install offered after a run.** A button appears on the **game-over screen only** (never in the menu, never before a first game) and is gone once installed: Android (browser offers install) → **INSTALL NOW** = the phone's own prompt, no instructions; iPhone/iPad → **ADD TO HOME SCREEN** = 3-step picture guide. Never shown before playing, inside the installed app, or where install isn't possible. No pop-ups. | Owner decision. |
| D-49 | **Bring my pilot into the installed app (iPhone).** The guide first offers **COPY MY PILOT** (copies the restore code) when the pilot has scores; the installed app shows **BRING MY PILOT FROM SAFARI** for a brand-new auto pilot, which reads the code and uses the existing restore flow (server check + confirm). Falls back to pasting by hand. | The iPhone TITAN split (Safari and the icon keep separate storage). |

**Unchanged:** server (worker.js), scoring, physics, levels, leaderboard, pilots, restore codes, skins/store (closed), admin, search setup, banner.

## Verification
- Release gate: **31/31 suites pass**. New `test-rc286.mjs`: 36 checks + 14 negative controls, all caught; it fails on RC2.8.5.
- Real Chromium (iPhone user agent, Safari-15 condition): Gateway PLAY → /play/ directly; no install button before playing; after one game, ADD TO HOME SCREEN on the game-over screen and not in the menu; guide shows COPY MY PILOT; zero page errors.
- Slow-device switch proven in a slowed browser (switches during the first run, remembered after reopening); a smooth browser never switches.
- All scripts use only Safari 15 syntax.
- **Not run:** real iPad mini 4, real Android install prompt, real iPhone Add-to-Home-Screen + BRING MY PILOT (clipboard permission prompt), a real child test.

## Files (vs RC2.8.5 build 3)
Changed: `public/index.html`, `public/play/index.html`. Unchanged: everything else (worker.js too).

## Upload order
public/index.html → public/play/index.html. Commit count +2.
