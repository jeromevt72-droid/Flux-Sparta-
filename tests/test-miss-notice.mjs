// Miss notice placement and wording, in the release gate. The old
// "MISS 1/3 • NEW RUN" popup was drawn at the launcher (pink over the yellow
// launcher, hard to read) and "NEW RUN" was wrong: the run goes on, with the
// same score and level. Now a miss shows "BALL LOST" + lives left in the HUD
// strip slot the level banner uses. The real game page runs in the harness vm
// with the HUD positions measured in Chromium (same fixtures as
// test-level-banner.mjs). Checks on every device: the notice never overlaps
// the launcher, the danger line, the HUD or the play area; text >= 11px;
// wording per miss; nothing is drawn at the launcher; it fades and clears.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
// The measured HUD layouts, shared with the level banner test.
const DEVICES = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-level-banner.mjs'), 'utf8').match(/const DEVICES = (\[[\s\S]*?\n\]);/)[1]);

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const code = scriptsOf(gameHtml).join('\n;\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('M1 the misleading "NEW RUN" wording is gone', !/NEW RUN/.test(code));
  try {
    for (const d of DEVICES) {
      const { store } = makeStore({ fluxPlayerId: 'mn-1', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1' });
      const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
      const run = (c) => vm.runInContext(c, g.ctx);
      const rectOf = (r) => ({ getBoundingClientRect: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) });
      g.win.document.querySelector = (sel) => sel === '.stats' ? rectOf(d.stats) : sel === '.fluxbar' ? rectOf(d.fluxbar) : g.win.document.getElementById('x');
      const cx = run('ctx'); const texts = [];
      cx.measureText = (t) => ({ width: String(t).length * parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]) * 0.72 });
      cx.fillText = (t, x, y) => { const px = parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]); const w = cx.measureText(t).width;
        const al = String(cx.textAlign || 'start'), bl = String(cx.textBaseline || 'alphabetic');
        const left = al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x;
        const top = bl === 'top' ? y : bl === 'middle' ? y - px / 2 : bl === 'bottom' ? y - px : y - px * 0.8;
        texts.push({ t: String(t), px, alpha: +cx.globalAlpha, box: { left, right: left + w, top, bottom: top + px } }); };
      g.ctx.newGame();
      run('W=' + d.W + ';H=' + d.H + ';paddle.y=H-Math.max(42,Math.min(90,H*.095));paddle.handleH=W<=700?22:28;paddle.x=W/2;cachedHudRects=' + JSON.stringify(d.hud) + ';');
      for (const [m, want] of [[1, 'BALL LOST|2 LIVES LEFT'], [2, 'BALL LOST|LAST LIFE']]) {
        run('misses=' + (m - 1) + ';levelBanner=0;texts=[];ball.x=W/2;ball.y=H+30;');
        g.ctx.registerMiss();
        texts.length = 0; g.ctx.draw();
        const nt = texts.filter((x) => /BALL LOST|LIVES? LEFT|LAST LIFE|MISS/.test(x.t)), ceil = run('maxHudBottom()');
        const r = nt.length ? nt.reduce((a, x) => ({ left: Math.min(a.left, x.box.left), right: Math.max(a.right, x.box.right), top: Math.min(a.top, x.box.top), bottom: Math.max(a.bottom, x.box.bottom) }), nt[0].box) : { left: 0, right: 0, top: 0, bottom: 0 };
        const pad = run('({left:paddle.x-paddle.w*.55-12,right:paddle.x+paddle.w*.55+12,top:paddle.y-paddle.h-12,bottom:paddle.y+paddle.handleH+6})');
        const tag = d.name + ' miss ' + m;
        ck('M2 ' + tag + ': says "' + want.replace('|', ' / ') + '"', nt.map((x) => x.t).join('|') === want, nt.map((x) => x.t).join('|'));
        ck('M3 ' + tag + ': nothing about the miss is drawn at the launcher', !texts.some((x) => hit(x.box, pad)) && !run('texts.some(t=>/MISS|LOST|LIFE|LIVES/.test(t.s))'));
        ck('M4 ' + tag + ': clear of the danger line and out of the play area', r.bottom <= ceil - 4 && r.top >= 0 && r.left >= 0 && r.right <= d.W, Math.round(r.bottom) + ' vs line ' + Math.round(ceil));
        const hudHit = [d.stats, d.fluxbar].concat(d.hud.filter((x) => x.right - x.left < d.W * 0.9)).filter((x) => hit(r, x));
        ck('M5 ' + tag + ': clear of the HUD (score boxes, FLUX row, pause)', hudHit.length === 0, JSON.stringify(hudHit[0] || ''));
        ck('M6 ' + tag + ': text >= 11px and fully visible', nt.length === 2 && nt.every((x) => x.px >= 11 && x.alpha === 1), nt.map((x) => x.px + '@' + x.alpha).join(' '));
      }
      // It fades out and clears while playing; the level banner gets its slot back.
      run('playing=true;paused=false;');
      for (let i = 0; i < 180; i++) { run('ball.x=W/2;ball.y=paddle.y-200;ball.vx=0;ball.vy=-1;playing=true;'); g.ctx.update(1 / 60); }   // keep the ball safe: no new miss
      run('levelBanner=2;'); texts.length = 0; g.ctx.draw();
      ck('M7 ' + d.name + ': the notice clears within 3 s and the level banner shows again', run('missNotice') === 0 && !texts.some((x) => /BALL LOST/.test(x.t)) && texts.some((x) => /^LEVEL /.test(x.t)), run('missNotice+" misses "+misses'));
    }
    // A revive gives a life back: an old "NO LIVES LEFT" notice must not stay up.
    const { store } = makeStore({ fluxPlayerId: 'mn-2', fluxCallsign: 'T', fluxProfileComplete: '1', fluxColorHintSeen: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    g.ctx.newGame(); run('misses=2;revivesUsedThisRun=0;');
    g.ctx.registerMiss();
    const txt = run('missNoticeText.join("|")');
    const btn = g.win.document.getElementById('reviveWatchBtn'); if (btn && typeof btn.onclick === 'function') btn.onclick();
    ck('M8 third miss says "NO LIVES LEFT"; after the free revive the notice is cleared', txt === 'BALL LOST|NO LIVES LEFT' && run('missNotice') === 0, txt + ' / ' + run('missNotice'));
    g.ctx.newGame(); run('missNotice=1;'); g.ctx.newGame();
    ck('M9 a new game starts with no miss notice', run('missNotice') === 0);
  } catch (e) { ck('miss notice section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each part of the fix removed MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
const NOTICE = " missNotice=MISS_NOTICE_S; missNoticeText=['BALL LOST', misses>=3?'NO LIVES LEFT':misses===2?'LAST LIFE':(3-misses)+' LIVES LEFT'];\n";
control('the old popup back at the launcher', 'M3', rep(NOTICE, NOTICE + " popup(W/2,H-65,`MISS ${misses}/3`,'#ff6b98');\n"));
control('"NEW RUN" wording back', 'M1', rep("missNoticeText=['BALL LOST',", "missNoticeText=['NEW RUN',"));
control('lives left counted wrong', 'M2', rep("(3-misses)+' LIVES LEFT'", "misses+' LIVES LEFT'"));
control('notice drawn in the play area (22% of the height)', 'M4', rep("const L=levelBannerLayout(missNoticeText[0],missNoticeText[1]);", "const L=levelBannerLayout(missNoticeText[0],missNoticeText[1]);L.y1=H*.22;L.y2=L.y1+L.f1+3;"));
control('notice drawn over the score boxes', 'M5', rep("const L=levelBannerLayout(missNoticeText[0],missNoticeText[1]);", "const L=levelBannerLayout(missNoticeText[0],missNoticeText[1]);L.cx=W-60;L.y1=4;L.y2=L.y1+L.f1+3;"));
control('notice never times out', 'M7', rep(" if(missNotice>0) missNotice=Math.max(0,missNotice-dt);\n", ''));
control('revive leaves "NO LIVES LEFT" up', 'M8', rep('misses=2;missNotice=0;paused=false;', 'misses=2;paused=false;'));
const total = main.F + NC;
console.log('\n' + (total ? 'MISS NOTICE FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'MISS NOTICE PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
