// PRESET NAMES -- pilots pick a name from a safe word list ("SWIFT COMET 42")
// instead of typing one, so a child can play without giving personal
// information. Real game page (harness vm) + the real worker's word lists.
// Server-side enforcement (free text is never shown) is tested with the other
// server checks in test-audit-fixes.mjs and its negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
import * as W from './preset-names.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

async function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(html);
  const bootGame = (init = {}) => {
    const { store, mem } = makeStore(init);
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl: () => Promise.resolve(new Response('{"ok":true}', { status: 200 })) });
    const run = (c) => vm.runInContext(c, g.ctx);
    const el = (id) => g.win.document.getElementById(id);
    return { g, mem, run, el };
  };

  if (!quiet) console.log('== the word lists ==');
  try {
    const b = bootGame();
    const same = (a, x) => JSON.stringify(a) === JSON.stringify(x);
    ck('N1 the game and the server use the same word lists',
      same(b.run('NAME_ADJ'), W.NAME_ADJ) && same(b.run('NAME_NOUN'), W.NAME_NOUN) && same(b.run('NAME_NUMS'), W.NAME_NUMS));
    const nums = b.run('NAME_NUMS');
    ck('N2 no loaded numbers (14, 18, 69, 88) are ever used', ![14, 18, 69, 88].some((n) => nums.includes(n)) && nums.length === 86);
    const longest = Math.max(...W.NAME_ADJ.map((s) => s.length)) + Math.max(...W.NAME_NOUN.map((s) => s.length)) + 4;
    const words = W.NAME_ADJ.concat(W.NAME_NOUN);
    ck('N3 every possible name fits the 16-character limit and uses only A-Z, a space and digits',
      longest <= 16 && words.every((w) => /^[A-Z]+$/.test(w)), 'longest ' + longest);
    ck('N3 no word appears twice', new Set(words).size === words.length);
  } catch (e) { ck('N1-N3 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== the game only ever holds a preset ==');
  try {
    const b = bootGame();
    ck('N4 a new pilot gets a preset name automatically', W.isPresetName(b.mem.fluxCallsign) && b.mem.fluxAutoName === '1', b.mem.fluxCallsign);
    ck('N5 the name boxes cannot be typed into',
      /<input id="callsign"[^>]*\breadonly\b/.test(html) && /<input id="goCallsign"[^>]*\breadonly\b/.test(html));
    const seen = new Set(); let allPreset = true;
    for (let i = 0; i < 20; i++) { b.el('nameShuffle').onclick(); const v = b.el('callsign').value; seen.add(v); if (!W.isPresetName(v) || b.run('callsign') !== v) allPreset = false; }
    ck('N6 the dice button picks another preset name', allPreset && seen.size > 1, [...seen].slice(0, 3).join(', '));
    b.el('goCallsign').value = ''; b.el('goShuffle').onclick();
    ck('N7 the game-over dice button picks a preset name', W.isPresetName(b.el('goCallsign').value), b.el('goCallsign').value);
    b.el('goCallsign').value = ''; b.g.ctx.showNamePrompt();
    ck('N7 the game-over name box opens already filled with a preset (it cannot be typed into)', W.isPresetName(b.el('goCallsign').value), b.el('goCallsign').value);
  } catch (e) { ck('N4-N7 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== existing custom names ==');
  try {
    const b = bootGame({ fluxPlayerId: 'legacy-pilot-0001', fluxCallsign: 'JOHN SMITH', fluxProfileComplete: '1' });
    ck('N8 an old typed name is replaced by the pilot\'s own preset on launch (same one the server shows)',
      b.mem.fluxCallsign === W.presetNameForId('legacy-pilot-0001') && b.run('callsign') === b.mem.fluxCallsign, b.mem.fluxCallsign);
    const k = bootGame({ fluxPlayerId: 'keeper-0001', fluxCallsign: 'SWIFT COMET 42', fluxProfileComplete: '1' });
    ck('N8 a preset the pilot already has is kept', k.mem.fluxCallsign === 'SWIFT COMET 42');
  } catch (e) { ck('N8 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== typed text never gets saved ==');
  try {
    const b = bootGame({ fluxPlayerId: 'typer-0001' });
    b.el('callsign').value = 'Emma Jones'; b.el('country').value = 'PH';
    b.g.ctx.saveProfile();
    ck('N9 saving with text forced into the box stores the pilot\'s preset, not the text',
      b.mem.fluxCallsign === W.presetNameForId('typer-0001'), b.mem.fluxCallsign);
    b.el('callsign').value = 'swift comet 42'; b.g.ctx.saveProfile();
    ck('N9 a real preset is saved as chosen', b.mem.fluxCallsign === 'SWIFT COMET 42', b.mem.fluxCallsign);
    b.el('callsign').onchange({ target: b.el('callsign') && Object.assign(b.el('callsign'), { value: 'my address 12' }) });
    ck('N10 an edited name box snaps back to a preset', W.isPresetName(b.el('callsign').value) && W.isPresetName(b.run('callsign')), b.el('callsign').value);
  } catch (e) { ck('N9-N10 ran', false, String(e.stack || e).slice(0, 200)); }

  try {
    const b = bootGame();
    let agree = true;
    for (let i = 0; i < 300; i++) { const id = 'id-' + i * 7919; if (b.g.ctx.presetNameForId(id) !== W.presetNameForId(id)) agree = false; }
    ck('N11 the game and the server derive the same preset for the same pilot', agree);
  } catch (e) { ck('N11 ran', false, String(e.stack || e).slice(0, 200)); }
  return { F, failed };
}

const main = await suite(GAME_HTML);
console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
async function control(label, expect, mutate) {
  const h = mutate(GAME_HTML);
  if (h === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite(h, true);
  const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('game word list drifts from the server', 'N1', rep("'BADGER','ROBIN'];", "'BADGER','ROBIN','HERO'];"));
await control('a loaded number is allowed', 'N2', rep('i !== 69 && ', ''));
// The launch conversion (N8) also repairs a bad auto name, so remove both layers here.
await control('auto name goes back to PILOT-XXXX (and launch conversion off)', 'N4', (s) => rep('if(callsign && !isPresetName(callsign)){', 'if(false){')(rep('callsign = randomPresetName();', "callsign = 'PILOT-7K2Q';")(s)));
await control('name box can be typed into again', 'N5', rep('placeholder="FLUX ID" readonly', 'placeholder="FLUX ID"'));
await control('dice button does nothing', 'N6', rep("document.getElementById('nameShuffle').onclick=()=>{callsign=randomPresetName();", "document.getElementById('nameShuffle').onclick=()=>{return;"));
await control('game-over name box opens empty', 'N7 the game-over name box', rep("const inp=document.getElementById('goCallsign'); if(inp && !isPresetName(inp.value))", "const inp=null; if(inp && !isPresetName(inp.value))"));
await control('old typed names are kept', 'N8', rep('if(callsign && !isPresetName(callsign)){', 'if(false){'));
await control('typed text is saved', 'N9', rep('  callsign = presetOrMine(typed);', '  callsign = typed.toUpperCase();'));
console.log('==================================================');
if (main.F || NC) { console.log('  ' + main.F + ' FAILED, ' + NC + ' CONTROL(S) NOT CAUGHT'); process.exit(1); }
console.log('  ALL PRESET-NAME TESTS PASSED, ALL CONTROLS CAUGHT');
