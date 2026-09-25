# FLUX RC2.8.5 (build 3) — one-tap first play, color hint, level cap, truthful copy, older devices
> **build 3 supersedes** the earlier `FLUX-RC2.8.5.zip` downloads (build 1 had only D-39–D-42; build 2 had the game-over RENAME line). Use only `FLUX-RC2.8.5-build3.zip`; check its fingerprint in `BUILD-MANIFEST.txt`.

## Store stays closed · no live keys · builds on RC2.8.4 (live)

| ID | Change | Evidence |
|---|---|---|
| D-39 | **Play first, name later** (now the safety net behind D-43). An empty name no longer blocks ENTER THE FLUX. Scores stay on the device until the pilot is named; game over shows "PUT YOUR SCORE ON THE WORLD GRID" (name + country + SAVE & UPLOAD). D-16's rule kept: no unnamed "PLAYER" ever reaches the public board. A name typed in the menu still saves as before. | Owner's kid test: a child could not start the game at the name box. |
| D-40 | **First-run color hint:** "HIT ORBS THAT MATCH YOUR BALL'S COLOR", ~3.5 s, first run only, never blocks touches. | The color rule was never explained in the game. |
| D-41 | **Level cap = 9** on the server (the game stops at level 9). A forged submission could claim level 999 and up to 5,000,000 points; the highest possible claim is now 455,000 (9 × 50,000 + 5,000). Real players unaffected. | Found in review: worker accepted MAX_LEVEL 999. |
| D-43 | **Auto name.** A brand-new pilot gets a visible, unique default name (e.g. PILOT-7Q2K) under their detected flag, so there is nothing to fill in. Scores count for the country from the first run. No rename prompt anywhere (owner decision): the name shows in the menu next to EDIT, and renaming there keeps the same pilot and re-uploads so the board shows the new name. **Decision:** replaces D-16's "never auto-name" for new pilots, because the default is shown, unique and changeable, never a silent "PLAYER". Existing pilots untouched. | Owner's kid test: the child asked "what's my FLUX ID?" before playing. |
| D-44 | **Easy first.** Brand-new pilots start on Easy; game over then offers Medium/Hard. Anyone who has played or chosen a difficulty keeps it. | Owner request; first run teaches the rule at a slower speed. |
| D-45 | **Older devices.** `ctx.roundRect()` exists only from Safari 16; on Safari 15 (iPhone 6s/7/SE 1st gen, older iPads) the first frame threw and froze the game. Added a stand-in for browsers without it (game and Gateway preview), and the game loop now schedules its next frame before drawing, so one bad frame can never freeze it. All page scripts verified to use only Safari 15 syntax. | Owner's iPad on iPadOS 15.8: game did not work. Reproduced (frozen on frame 1, "roundRect is not a function"); fixed. |
| D-42 | **Truthful Gateway copy.** Removed four claims that "every run / every game" adds to the country. The server counts each pilot's single best score; the Gateway now says so. | Server: "Each player counts once, at their single best public score." |

**Also:** the start button now has ONE handler. Two older assignments in `play/index.html` were always overwritten before a player could tap (dead code) and were removed; a regression check and a negative control enforce a single handler.

**Unchanged:** gameplay, physics, scoring, combos, levels, difficulty, the World Grid
and leaderboard logic, pilots, restore codes, skins/store (closed), admin, offline play,
search setup, in-app banner. Existing named pilots behave exactly as before.

## Verification
- Release gate: **30/30 suites pass**. New `test-rc285.mjs`: all checks + 11 negative
  controls, all caught; it fails on RC2.8.4 as it should.
- Older tests that used impossible fixture values (level 90/100, 4–5 million points)
  were updated to the real maximum (level 9, ≤ 455,000); what they test is unchanged.
- Real Chromium, phone size: first launch shows PILOT-XXXX + EASY → one tap → hint →
  game over with no rename prompt; renaming via EDIT tested; zero page errors.
- Safari 15 condition (roundRect removed): game and Gateway preview run, zero errors.
- **Not run:** real iPhone/iPad (including your iPadOS 15.8 iPad), a real child re-test.
- Note: a rename right after an upload may wait out the 10-second upload cooldown; it
  is queued and the board shows the new name on the next upload.

## Files (vs RC2.8.4)
Changed: `worker.js`, `public/index.html`, `public/play/index.html`, `public/hero-demo.html`.
Unchanged: everything else, including `public/google5415e96c084db88e.html` (keep it).

## Upload order
worker.js (top level) → public/index.html + public/hero-demo.html (one commit) → public/play/index.html. Commit count +3.
