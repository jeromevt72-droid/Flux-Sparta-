# FLUX RC2.8.7 — release notes

Built on RC2.8.6 build 2. Changes are visual/clarity only, plus score-based levels.
**Changed deployable files:** `worker.js`, `public/play/index.html`. Nothing else that ships to players changed.
**Not changed:** physics constants, aiming, controls, point scoring, pilots, restore codes,
leaderboard and country math, the store (still closed), admin.

## What changed (D-50 … D-61)

| ID | Change |
|---|---|
| D-50 | **Levels come from score.** Medium thresholds for levels 2–9: 2,500 · 6,000 · 10,000 · 15,000 · 21,000 · 28,000 · 36,000 · 45,000. Easy ×0.75, Hard ×1.35. Perfect catches still score but no longer move the level. When a threshold is reached: the banner adds **NEXT LEVEL: n**, the LEVEL box turns amber, reads **SPEED UP** and counts 5-4-3-2-1 with a soft tick each second, then the new level starts and the speed limit rises smoothly over about 2 s. The LEVEL box's bar shows progress to the next threshold. Levels still come one at a time. |
| D-51 | **Server:** the old "score ≤ level × 50,000 + 5,000" rule is replaced by "the level must be the level this score reaches on this difficulty, ±1". All other checks stay: level 1–9, score 0–5,000,000, valid player ID, 10-second cooldown. **Owner decision:** a hard ceiling is kept as well: any score above **455,000** (the RC2.8.5 maximum) is refused with 422. |
| D-52 | The bottom-right canvas **FLUX LIVES** box is gone. The top box now shows **LIVES** (3, 2, …); on the last life it turns red and says **LAST LIFE**. |
| D-53 | The pause button is now in the FLUX meter row: `[Ⅱ] FLUX ▬▬▬ 100%`. The row is inside the HUD, which already sits below `safe-area-inset-top`, so it moves down with the iPhone notch instead of being pinned at a fixed height. The button is 44 × 44. |
| D-54 | During play the HUD no longer shows the tagline, **SOUND • ON** or **FIELD • STABLE**. The background pressure glow still works. |
| D-55 | Game page: every text is at least 11 px (stylesheet, inline styles and canvas text) and every button is at least 44 px tall (EDIT, leaderboard, skins, EASY/MEDIUM/HARD and all the others). Checked in Chromium at 360 px and 390 px wide. |
| D-56 | Default orb palette starts **#ffd23f #1fb8e0 #ff4f98 #b48cff** (owner decision: cyan darkened from #35e6ff). All four skins were redesigned: every colour has at least 4.5:1 contrast on every level background; the first four differ in hue (≥ 35°) and lightness (L\* ≥ 3 apart); no palette pairs a red with a green. The ball is the brightest object (solid disc with a white core; orbs are translucent). Orb symbols stay as a colour-blind cue but are faint (alpha 0.3). |
| D-57 | Game over: the three headlines (FLUX OVERLOAD / THE FLOW BROKE / FLUX COLLAPSE) are replaced by the score in large type and one line: **NEW BEST!** or **"n from your best"**, then **"🇵🇭 +gain for Philippines"** when the run raised the country total, otherwise **"Beat <best> to add to 🇵🇭"**. The gain matches the server rule: a pilot counts once, at their single best score across all difficulties. |
| D-58 | First launch (no finished run yet): **"Playing for 🇵🇭 Philippines · change"** under ENTER THE FLUX. It is a full-width 44 px button; "change" opens the name/country editor. |
| D-59 | Revive: **"FREE extra life?"** with **YES, FREE** / **END RUN**. |
| D-60 | An auto-named pilot (PILOT-XXXX) who sets a new best on run 2 or later is asked once, at game over: **"Put your name on the board?"** YES opens the name box; NOT NOW dismisses it. Never asked again on that device. |
| D-61 | Sound starts silent and fades in over 1.5 s to 30% master volume (was 52%, immediately). Nothing raises the volume later. Combo sounds rise one semitone per combo step all the way to ×12 (previously they stopped rising at ×7). |

### Decisions and interpretations (please confirm)
1. **Score ceiling (decided).** The level rule alone would let any score through once level 9 is claimed. The owner chose to keep a hard ceiling of 455,000 in addition to D-51. It is tested (S7) and has a negative control.
2. **Default cyan (decided).** #35e6ff was nearly as light as the yellow (L\* 84 vs 86), so it is now #1fb8e0 (L\* 69). The closest pair in the default four is now cyan vs lavender #b48cff (L\* 69 vs 66, a gap of 3.2). The test now requires a gap of at least 3 in every skin: aurora 3.2, cosmic 6.0, solar 7.8, toxic 10.1.
3. **D-55 covers the game page only.** The Gateway (`public/index.html`) still has 6.5–10.5 px text: the hero brand tiers, tags and "scroll". Those sizes are set by the D-19 reflow tests, so they need their own change.
4. **D-50, when the level changes:** the level-up used to freeze play for 0.85 s. Now nothing freezes. The new level (field refresh, narrower paddle, background) starts when the countdown ends, 5 s after the threshold. The level that is saved and uploaded is always the level the score reaches, even if the run ends during the countdown.
5. **D-61, "~30%"** is read as master gain 0.30, which is about 5 dB quieter than before.
6. **Wording edge cases in D-57:** an exact tie reads "Tied your best". A pilot with no name yet reads "Add your name to count for 🇵🇭".
7. **Older saved data.** Best runs and queued uploads saved by earlier versions carry levels from the old perfect-catch system, which the new server would refuse. On start-up the game rewrites only those level numbers and never touches scores. If a phone still has the old page open during the deploy, its next upload can be refused once. The best is sent again after the page reloads and the next game ends.

## Tests

- **New:** `test-rc287.mjs` (in the gate), 92 checks covering every D-item and the score ceiling, plus 52 negative controls. Each control puts an old defect back and requires the matching check to fail. It also fails on the RC2.8.6 files, on every D-item.
- **New, extra (not in the gate, needs Chromium):** `test-rc287-browser.mjs`, 82 checks on the real page at 360 px, 360 px with a 59 px notch inset, and 390 px with a 47 px inset. It covers rendered font sizes, button heights, overlap, fit and the D-58/59/57 screens.
- **New, extra:** `check-safari15.mjs` checks every browser script: esbuild output for `--target=safari15` is identical to `--target=esnext` (16 of 16). `worker.js` is server code and not in this check. Its output differs only on the `\p{C}` regex, and that difference was already there before this release.
- **New helper:** `level-rule.mjs` holds the score-to-level rule for test fixtures. `test-rc287.mjs` checks that it matches both worker.js and the game.
- **Old tests updated only where D-50/D-51 changed the rules.** Score submissions in `test-worker`, `test-import`, `test-rc281`, `test-rc28-worker`, `test-audit-fixes`, `test-d36-d37` and `fuzz` now send the level their score reaches, not a hand-typed level. `test-rc285` A3–A6 now check the new rule instead of the old 455,000 ceiling. No check was removed or loosened.
- **Harness fix (`test-negative-controls.mjs`).** With `tests/FLUX-Sparta` as a symlink to the repo root, this suite copied the link instead of the files. Its injected defects were written into the real `public/` files. Two of them were `if(true){localStorage.fluxPlayerId=…` (a new pilot on every launch) and PLAY pointing at the retired flux-gateway address. That is why the first baseline run showed 28/31. The files were restored from git, and the suite now copies the real files. Baseline after the fix: **31/31 on unchanged app code**.
- **Gate:** `node tests/run-all-tests.mjs`: **RELEASE GATE PASSED: all 32 suites passed**.
