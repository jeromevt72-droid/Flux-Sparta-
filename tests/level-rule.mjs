// RC2.8.7 (D-50/D-51): the level a score reaches on a difficulty. Test fixtures
// use this so every score they submit carries the level the server now requires.
// test-rc287.mjs checks this copy against BOTH worker.js and play/index.html.
export const LEVEL_SCORE_THRESHOLDS = [2500, 6000, 10000, 15000, 21000, 28000, 36000, 45000];
export const LEVEL_SCORE_MULT = { easy: 1.5, medium: 1, hard: 0.55 };
// MILESTONE LEVELS (owner): from level 10 on, a level every 50,000 Medium-equivalent points, up to 99:
// level n (10-99) at (45,000 + (n - 9) x 50,000) x LEVEL_SCORE_MULT[difficulty].
export const LEVEL_PLAY_MAX = 9, LEVEL_MAX = 99, LEVEL_MILESTONE_BASE = 45000, LEVEL_MILESTONE_STEP = 50000;
export function levelScoreAt(lv, difficulty = 'medium') {
  const m = LEVEL_SCORE_MULT[difficulty] || 1;
  if (lv <= 1) return 0;
  if (lv > LEVEL_PLAY_MAX) return Math.round((LEVEL_MILESTONE_BASE + (lv - LEVEL_PLAY_MAX) * LEVEL_MILESTONE_STEP) * m);
  return Math.round(LEVEL_SCORE_THRESHOLDS[Math.min(8, lv - 2)] * m);
}
export function levelFor(score, difficulty = 'medium') {
  let lv = 1;
  while (lv < LEVEL_MAX && score >= levelScoreAt(lv + 1, difficulty)) lv++;
  return lv;
}
// DIFFICULTY WEIGHT: the ALL board and country totals count a best at its difficulty's weight
// (worker.js DIFF_WEIGHT; test-easy-scoring.mjs W4 checks the game and the server agree).
export const DIFF_WEIGHT = { easy: 0.09, medium: 0.21, hard: 1 };
export const weighted = (score, difficulty = 'medium') => Math.round(score * (DIFF_WEIGHT[difficulty] || 1));
