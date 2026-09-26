// Share card after each run, in the release gate. Real game page in the harness vm.
//   S1 wording: "I added <points> for <flag> <country>!" when the run added to the
//      country's total (same number as the game-over line), else "I scored ...";
//      the link opens the web game (/play/ on this site); no name or player ID;
//   S2 the phone's share sheet gets the card image + text when it can share images;
//      text + link when it can't; clipboard copy when there is no share sheet;
//      cancelling the share sheet is silent;
//   S3 the share sheet is opened directly in the tap (nothing awaited first), as
//      iPhone Safari requires;
//   S4 the button appears only after a run with points, and is a real <button>
//      (the 44px rule reaches it).
// Ends with negative controls. The card image itself is rendered in test-share-card-browser.mjs.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

async function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const bootGame = (extra = {}) => { const { store } = makeStore(Object.assign({ fluxPlayerId: 'pid-SECRET-123', fluxCallsign: 'MARIA', fluxProfileComplete: '1', fluxCountry: 'PH' }, extra));
    const g = boot(scriptsOf(gameHtml), { origin: 'https://flux.example', path: '/play/', store }); return { g, run: (c) => vm.runInContext(c, g.ctx) }; };
  try {
    { const { g, run } = bootGame();
      g.ctx.showGameOverLine(4200, 3000, 3000); const t1 = run('shareText(shareInfo)'), u = run('shareUrl()');
      g.ctx.showGameOverLine(2500, 3000, 3000); const t2 = run('shareText(shareInfo)');
      ck('S1 a run that added to the country: "I added 1,200 for 🇵🇭 Philippines!"', t1.startsWith('I added 1,200 for 🇵🇭 Philippines!'), t1);
      ck('S1 a run that did not: "I scored 2,500 for 🇵🇭 Philippines!" (never a false "added")', t2.startsWith('I scored 2,500 for 🇵🇭 Philippines!'), t2);
      ck('S1 the link opens the web game on this site, and nothing personal is shared', u === 'https://flux.example/play/' && !/MARIA|SECRET/.test(t1 + t2 + u), u); }
    // S2/S3: share paths.
    const tapShare = (setup) => { const { g, run } = bootGame(); const calls = []; let inTap = false;
      run('var File=function(parts,name,o){ this.name=name; this.type=o&&o.type; };');
      setup(g.win.navigator, calls, () => inTap);
      g.ctx.showGameOverLine(4200, 3000, 3000); run("shareFile=new File(['x'],'flux-score.jpg',{type:'image/jpeg'});");
      const btn = g.win.document.getElementById('shareBtn'); inTap = true; btn.onclick(); inTap = false; return { calls, run, btn }; };
    const full = tapShare((n, calls, tap) => { n.canShare = (d) => !!d.files; n.share = (d) => { calls.push({ d, sync: tap() }); return Promise.resolve(); }; });
    ck('S2 phones that can share images get the card + text with the link', full.calls.length === 1 && full.calls[0].d.files && full.calls[0].d.files[0].name === 'flux-score.jpg' && /I added 1,200 for .* https:\/\/flux\.example\/play\/$/.test(full.calls[0].d.text), JSON.stringify(full.calls[0] && full.calls[0].d.text));
    ck('S3 the share sheet opens directly in the tap (nothing awaited first)', full.calls.length === 1 && full.calls[0].sync === true);
    const textOnly = tapShare((n, calls, tap) => { n.canShare = () => false; n.share = (d) => { calls.push({ d, sync: tap() }); return Promise.resolve(); }; });
    ck('S2 browsers that cannot share images get text + link', textOnly.calls.length === 1 && !textOnly.calls[0].d.files && textOnly.calls[0].d.url === 'https://flux.example/play/' && textOnly.calls[0].sync === true);
    const copy = tapShare((n, calls) => { delete n.share; delete n.canShare; n.clipboard = { writeText: (t) => { calls.push(t); return Promise.resolve(); } }; });
    ck('S2 no share sheet: the text and link are copied', copy.calls.length === 1 && /https:\/\/flux\.example\/play\/$/.test(copy.calls[0]));
    let copied = 0; const cancel = tapShare((n, calls) => { n.canShare = () => false; n.share = () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })); n.clipboard = { writeText: () => { copied++; return Promise.resolve(); } }; });
    await new Promise((r) => setTimeout(r, 20));   // let the rejected share settle
    ck('S2 cancelling the share sheet is silent (no copy, no message)', copied === 0);
    { const { g, run } = bootGame(); const btn = g.win.document.getElementById('shareBtn'); let hidden = null; btn.classList = { toggle: (c, on) => { if (c === 'hidden') hidden = on; }, add() {}, remove() {} };
      g.ctx.showGameOverLine(0, 3000, 3000); const h0 = hidden; g.ctx.showGameOverLine(900, 3000, 3000); const h1 = hidden;
      ck('S4 the button shows only after a run with points, and is a real <button>', h0 === true && h1 === false && /<button id="shareBtn" type="button"/.test(gameHtml)); }
  } catch (e) { ck('share section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = await suite(GAME_HTML);
console.log('== negative controls: each part removed MUST be caught ==');
let NC = 0;
async function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = await suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
await control('always says "added"', 'S1', rep("(info.added>0 ? 'I added '+info.added.toLocaleString('en-US')", "(true ? 'I added '+info.score.toLocaleString('en-US')"));
await control('pilot name in the text', 'S1', rep("+' Beat me in FLUX:';", "+' Beat '+callsign+' in FLUX:';"));
await control('no image even when the phone can share it', 'S2', rep('    if(shareFile && navigator.canShare && navigator.canShare({files:[shareFile]})){', '    if(false){'));
await control('share sheet opened after an await (not directly in the tap)', 'S3', rep("navigator.share({files:[shareFile],text:text+' '+url}).then(done,failed);", "Promise.resolve().then(function(){ return navigator.share({files:[shareFile],text:text+' '+url}); }).then(done,failed);"));
await control('no fallback without a share sheet', 'S2', rep('  copyShare(text+\' \'+url,btn);\n}', '}'));
await control('cancelling the share sheet copies anyway', 'S2', rep("if(e && e.name==='AbortError') return; ", ''));
await control('button shown after a zero-point run', 'S4', rep("btn.classList.toggle('hidden', !(sc>0));", "btn.classList.toggle('hidden', false);"));
const total = main.F + NC;
console.log('\n' + (total ? 'SHARE CARD FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SHARE CARD PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
