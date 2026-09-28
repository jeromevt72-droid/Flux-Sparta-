// RC2.8.7 (D-50/D-51): the level a score reaches on a difficulty. Test fixtures
// use this so every score they submit carries the level the server now requires.
// test-rc287.mjs checks this copy against BOTH worker.js and play/index.html.
export const LEVEL_SCORE_THRESHOLDS = [2500, 6000, 10000, 15000, 21000, 28000, 36000, 45000];
export const LEVEL_SCORE_MULT = { easy: 1.5, medium: 1, hard: 0.55 };
export function levelFor(score, difficulty = 'medium') {
  const m = LEVEL_SCORE_MULT[difficulty] || 1; let lv = 1;
  for (const t of LEVEL_SCORE_THRESHOLDS) { if (score >= Math.round(t * m)) lv++; else break; }
  return Math.min(9, lv);
}
// DIFFICULTY WEIGHT: the ALL board and country totals count a best at its difficulty's weight
// (worker.js DIFF_WEIGHT; test-easy-scoring.mjs W4 checks the game and the server agree).
export const DIFF_WEIGHT = { easy: 0.09, medium: 0.21, hard: 1 };
export const weighted = (score, difficulty = 'medium') => Math.round(score * (DIFF_WEIGHT[difficulty] || 1));
