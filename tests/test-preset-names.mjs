// PILOT NAMES -- a new pilot starts with a preset name from a safe word list
// ("SWIFT COMET 42"). In EDIT a pilot may type a name: one word, letters and
// numbers only, up to 12, nothing that looks like an email, phone number or
// web link. Saved names that break the rules become the pilot's preset, with a
// one-time notice. EDIT closes again after save and after cancel.
// Real game page (harness vm) + the real worker's rules. Server-side
// enforcement and the storage clean-up are tested in test-audit-fixes.mjs.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
import * as W from './preset-names.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'worker.js'), 'utf8');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const rulesBlock = (src) => src.slice(src.indexOf('const NAME_ADJ = '), src.indexOf('function isAllowedName('));
const NOTICE = "Your name didn't fit the new name rules, so we picked one for you. Tap Edit to change it.";

async function suite(html, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const GAME = scriptsOf(html);
  const bootGame = (init = {}) => {
    const { store, mem } = makeStore(init);
    const g = boot(GAME, { origin: ORIGIN, path: '/play/', store, fetchImpl: () => Promise.resolve(new Response('{"ok":true}', { status: 200 })) });
    const run = (c) => vm.runInContext(c, g.ctx);
    const el = (id) => g.win.document.getElementById(id);
    for (const id of ['profileEditor', 'restoreLink', 'startBtn']) el(id).contains = () => false;   // a tap "elsewhere"
    const toast = () => el('fluxNameToast').textContent;
    const edit = () => el('editProfile').onclick();
    const key = (k) => el('callsign').onkeydown({ key: k, preventDefault() {} });
    return { g, mem, run, el, toast, edit, key };
  };
  const named = (name, id = 'pilot-0001', extra = {}) => bootGame(Object.assign({ fluxPlayerId: id, fluxCallsign: name, fluxCountry: 'US', fluxProfileComplete: '1' }, extra));

  if (!quiet) console.log('== the rules are the same in the game and on the server ==');
  try {
    const b = bootGame();
    const same = (a, x) => JSON.stringify(a) === JSON.stringify(x);
    ck('N1 the game and the server use the same word lists and the same typed-name rules',
      same(b.run('NAME_ADJ'), W.NAME_ADJ) && same(b.run('NAME_NOUN'), W.NAME_NOUN) && same(b.run('NAME_NUMS'), W.NAME_NUMS)
      && rulesBlock(html).includes('function typedNameProblem(') && rulesBlock(html) === rulesBlock(WORKER_SRC));
    const nums = b.run('NAME_NUMS');
    ck('N2 no loaded numbers (14, 18, 69, 88) are ever used in presets', ![14, 18, 69, 88].some((n) => nums.includes(n)) && nums.length === 86);
    const words = W.NAME_ADJ.concat(W.NAME_NOUN);
    const longest = Math.max(...W.NAME_ADJ.map((s) => s.length)) + Math.max(...W.NAME_NOUN.map((s) => s.length)) + 4;
    ck('N3 every preset fits 16 characters, words are A-Z and never repeat', longest <= 16 && words.every((w) => /^[A-Z]+$/.test(w)) && new Set(words).size === words.length, 'longest ' + longest);
  } catch (e) { ck('N1-N3 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== new pilots, the menu, and the rules ==');
  try {
    const b = bootGame();
    ck('N4 a new pilot starts with a preset name (and sees no notice)', W.isPresetName(b.mem.fluxCallsign) && b.mem.fluxAutoName === '1' && b.toast() === '', b.mem.fluxCallsign);
    ck('N5 no dice button; the name boxes are ordinary text boxes (menu layout as before), up to 12 characters',
      !/nameShuffle|goShuffle|🎲/.test(html) && /<div id="profileEditor" class="profileRow"><input id="callsign" maxlength="12" placeholder="FLUX ID"><select id="country">/.test(html)
      && /<input id="goCallsign" maxlength="12" placeholder="YOUR NAME" autocomplete="off" autocorrect="off" spellcheck="false"><select id="goCountry"/.test(html));
    const ok = ['TITAN', 'R2D2', 'JUAN', 'ABCDEFGHIJKL', 'PLAYER1', 'SWIFT COMET 42'];
    const bad = ['JOHN SMITH', 'JO.HN', 'ABCDEFGHIJKLM', 'AMY@MAIL', '5551234567', 'A1B2C3D4E5F6G', 'CALL5551234', 'AMYGMAIL', 'WWWAMY', 'HTTPAMY', 'AMYDOTCOM', 'JOSÉ', ''];
    const wrongOk = ok.filter((n) => b.run('isAllowedName(' + JSON.stringify(n) + ')') !== true);
    const wrongBad = bad.filter((n) => b.run('isAllowedName(' + JSON.stringify(n) + ')') !== false);
    ck('N6 one word, A-Z and 0-9, up to 12, no email / phone / link look-alikes (presets always allowed)', !wrongOk.length && !wrongBad.length, wrongOk.concat(wrongBad).join(', '));
  } catch (e) { ck('N4-N6 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== existing names ==');
  try {
    const k = named('TITAN');
    ck('N7 an existing name that follows the rules is kept, with no notice', k.mem.fluxCallsign === 'TITAN' && k.run('callsign') === 'TITAN' && k.mem.fluxNameNotice === undefined && k.toast() === '');
    const b = named('JOHN SMITH', 'legacy-pilot-0001');
    ck('N8 an existing name that breaks the rules becomes the pilot\'s own preset (the one the server shows)',
      b.mem.fluxCallsign === W.presetNameForId('legacy-pilot-0001') && b.run('callsign') === b.mem.fluxCallsign, b.mem.fluxCallsign);
    ck('N8 ...with the one-time notice', b.toast() === NOTICE, b.toast());
    const reload = bootGame(Object.assign({}, b.mem));   // reloaded before the notice went away (service worker update)
    ck('N8 ...still shown if the page reloads before it was seen', reload.toast() === NOTICE);
    reload.el('fluxNameToast').onclick();                 // seen: tapped away (or timed out)
    const again = bootGame(Object.assign({}, reload.mem));
    ck('N8 ...and not again once it has been seen', reload.mem.fluxNameNotice === undefined && again.toast() === '' && again.mem.fluxCallsign === b.mem.fluxCallsign);
  } catch (e) { ck('N7-N8 ran', false, String(e.stack || e).slice(0, 200)); }

  if (!quiet) console.log('== EDIT: save and cancel both return to the normal view ==');
  try {
    const b = named('TITAN'); b.edit();
    ck('N9 EDIT opens the editor', b.run('profileComplete') === false);
    b.el('callsign').value = 'juan'; b.key('Enter');
    ck('N9 a valid name + Enter saves it and returns to the normal view', b.run('profileComplete') === true && b.mem.fluxCallsign === 'JUAN' && b.run('callsign') === 'JUAN');
    const c = named('TITAN'); c.edit(); c.el('callsign').value = 'John Smith'; c.key('Enter');
    ck('N10 a refused name is not saved and never stays in the box: back to the current name, hint under the box, no bottom message',
      c.run('profileComplete') === false && c.mem.fluxCallsign === 'TITAN' && c.run('callsign') === 'TITAN' && c.el('callsign').value === 'TITAN' && c.run('fluxNameHint.on') === true && c.toast() === '', c.el('callsign').value + ' / ' + c.toast());
    c.el('callsign').oninput();
    ck('N10 ...typing again clears the hint', c.run('fluxNameHint.on') === false);
    c.el('callsign').value = 'John Smith'; c.key('Enter');
    c.key('Escape');
    ck('N11 Esc cancels: the old name stays and the normal view returns', c.run('profileComplete') === true && c.mem.fluxCallsign === 'TITAN' && c.el('callsign').value === 'TITAN');
    const d = named('TITAN'); d.edit(); d.el('country').value = 'PH'; d.el('country').onchange({ target: d.el('country') });
    ck('N12 picking a new country saves it and returns to the normal view', d.run('profileComplete') === true && d.mem.fluxCountry === 'PH' && d.mem.fluxCallsign === 'TITAN');
    const e = named('TITAN'); e.edit(); e.el('callsign').value = 'NOVA7'; e.el('start').onpointerdown({ target: {} });
    ck('N12 tapping elsewhere in the menu saves a change and returns to the normal view', e.run('profileComplete') === true && e.mem.fluxCallsign === 'NOVA7');
    const f = named('TITAN'); f.edit(); f.el('start').onpointerdown({ target: {} });
    ck('N12 tapping elsewhere with no change just closes EDIT', f.run('profileComplete') === true && f.mem.fluxCallsign === 'TITAN');
    const r = named('TITAN', 'pilot-0002', { fluxPublicTag: 'ABCDEFG' }); let opened = 0;
    r.g.ctx.openRestoreCode = () => { opened++; }; r.g.ctx.openRestoreEntry = () => { opened++; };
    r.edit(); r.el('restoreLink').onclick();
    ck('N13 the restore code opens from EDIT and the panel is back in the normal view behind it', opened === 1 && r.run('profileComplete') === true);
    const s = named('TITAN'); let started = 0; s.g.ctx.newGame = () => { started++; };
    s.edit(); s.el('callsign').value = 'John Smith'; s.el('startBtn').onclick();
    ck('N14 existing player: ENTER THE FLUX with a refused name still starts the game, keeping the current name (never shown in the box)',
      started === 1 && s.mem.fluxCallsign === 'TITAN' && s.run('callsign') === 'TITAN' && s.el('callsign').value === 'TITAN' && s.toast() === '', 'started ' + started + ', ' + s.el('callsign').value);
    const n = bootGame({ fluxPlayerId: 'fresh-0001' }); const pre = n.mem.fluxCallsign; let nStarted = 0; n.g.ctx.newGame = () => { nStarted++; };
    n.edit(); n.el('callsign').value = 'John Smith'; n.key('Enter');
    ck('N16 brand-new player: a refused name goes back to the preset, with the hint', n.el('callsign').value === pre && n.run('fluxNameHint.on') === true && n.mem.fluxCallsign === pre, n.el('callsign').value);
    n.el('callsign').value = 'John Smith'; n.el('startBtn').onclick();
    ck('N16 brand-new player: ENTER THE FLUX still starts the game with the preset name', nStarted === 1 && n.mem.fluxCallsign === pre && n.run('callsign') === pre && n.el('callsign').value === pre && W.isPresetName(pre), 'started ' + nStarted + ', ' + n.mem.fluxCallsign);
    const q = bootGame({ fluxPlayerId: 'fresh-0002' }); let qStarted = 0; q.g.ctx.newGame = () => { qStarted++; };
    q.edit(); q.el('callsign').value = 'amy@mail.com'; q.el('start').onpointerdown({ target: {} }); q.el('startBtn').onclick();
    ck('N16 brand-new player: refused name, tap away, then ENTER THE FLUX: the game starts', qStarted === 1 && W.isPresetName(q.mem.fluxCallsign));
  } catch (e) { ck('N9-N14 ran', false, String(e.stack || e).slice(0, 200)); }

  try {
    const b = bootGame();
    let agree = true;
    for (let i = 0; i < 300; i++) { const id = 'id-' + i * 7919; if (b.g.ctx.presetNameForId(id) !== W.presetNameForId(id)) agree = false; }
    ck('N15 the game and the server derive the same preset for the same pilot', agree);
  } catch (e) { ck('N15 ran', false, String(e.stack || e).slice(0, 200)); }
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
await control('game allows longer typed names than the server', 'N1', rep('const TYPED_NAME_MAX = 12;', 'const TYPED_NAME_MAX = 14;'));
await control('dice button back', 'N5', rep('<input id="callsign" maxlength="12" placeholder="FLUX ID">', '<input id="callsign" maxlength="12" placeholder="FLUX ID"><button id="nameShuffle">🎲</button>'));
await control('a new pilot starts with PILOT-XXXX', 'N4', rep('callsign = randomPresetName();', "callsign = 'PILOT-7K2Q';"));
await control('old names that break the rules are kept', 'N8', rep("if(callsign && !isAllowedName(callsign)){", 'if(false){'));
await control('no notice for a switched name', 'N8 ...with the one-time notice', rep("fluxNameToast(\"Your name didn't fit the new name rules, so we picked one for you. Tap Edit to change it.\", 9000,", "(function(){})(\"\", 9000,"));
await control('notice cleared before it is seen', 'N8 ...still shown', rep("try{ if(localStorage.fluxNameNotice==='1') fluxNameToast(", "try{ if(localStorage.fluxNameNotice==='1') localStorage.removeItem('fluxNameNotice'), fluxNameToast("));
await control('the game saves a refused name', 'N14', rep('if (!isAllowedName(callsign)) { callsign = isAllowedName(localStorage.fluxCallsign)', 'if (false) { callsign = isAllowedName(localStorage.fluxCallsign)'));
await control('a refused name stays in the box in EDIT', 'N10', rep('else if(!isAllowedName(typed)){ inp.value=was.name; fluxNameRule(); return false; }', 'else if(!isAllowedName(typed)){ fluxNameRule(); return false; }'));
await control('ENTER THE FLUX blocked by a refused name', 'N14', rep("typed = isAllowedName(raw) ? raw : was;   // a refused name never blocks play", "typed = raw; if (!isAllowedName(raw)) return;"));
await control('bottom-of-screen message back instead of the hint', 'N10', rep('function fluxNameRule(){ fluxNameHint(true); }', "function fluxNameRule(){ fluxNameToast('One word only'); }"));
await control('Enter leaves EDIT open', 'N9', rep("if(e.key==='Enter'){ e.preventDefault(); if(closeProfileEditor(true)) try{ this.blur(); }catch(x){} }", "if(e.key==='Enter'){ e.preventDefault(); }"));
await control('cancel leaves EDIT open', 'N11', rep("else if(e.key==='Escape'){ closeProfileEditor(false); }", "else if(e.key==='Escape'){ }"));
await control('restore code leaves EDIT open', 'N13', rep('rl.onclick=function(e){ if(!closeProfileEditor(profileEditChanged())) closeProfileEditor(false); if', 'rl.onclick=function(e){ if'));
console.log('==================================================');
if (main.F || NC) { console.log('  ' + main.F + ' FAILED, ' + NC + ' CONTROL(S) NOT CAUGHT'); process.exit(1); }
console.log('  ALL PILOT-NAME TESTS PASSED, ALL CONTROLS CAUGHT');
