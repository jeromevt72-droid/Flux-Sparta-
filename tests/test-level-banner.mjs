// Level-up banner placement (RC2.8.7 fix), in the release gate.
// The real game page runs in the harness vm with the HUD positions MEASURED in
// Chromium on each device (iPhone notch/island/SE/landscape, iPad, iPad mini 4
// on iPadOS 15.8, iPad mini 6; portrait and landscape -- regenerate with
// FIXTURES=1 node test-level-banner-browser.mjs). The game's own layout code
// then places the banner, and this checks that "LEVEL X" / "NEXT LEVEL: X"
// never overlaps the launcher, the danger (ceiling) line, the HUD or the play
// area, stays >= 11px, and that the "LEVEL SECURED • FIELD ..." line is gone.
// Ends with negative controls. The same checks run on real rendering in
// test-level-banner-browser.mjs (needs Chromium, not in the gate).
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML = fs.readFileSync(path.join(__dirname, 'FLUX-Sparta', 'public', 'play', 'index.html'), 'utf8');
const scriptsOf = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const DEVICES = [
  {"name":"iPhone 14 (notch 47)","W":390,"H":844,"stats":{"left":150.73,"top":55,"right":380,"bottom":98},"fluxbar":{"left":10,"top":113,"right":217.64,"bottom":157},"hud":[{"left":10,"top":113,"right":54,"bottom":157},{"left":0,"top":47,"right":390,"bottom":106},{"left":10,"top":113,"right":217.64,"bottom":157}]},
  {"name":"iPhone 15 Pro (island 59)","W":393,"H":852,"stats":{"left":153.73,"top":67,"right":383,"bottom":110},"fluxbar":{"left":10,"top":125,"right":217.64,"bottom":169},"hud":[{"left":10,"top":125,"right":54,"bottom":169},{"left":0,"top":59,"right":393,"bottom":118},{"left":10,"top":125,"right":217.64,"bottom":169}]},
  {"name":"iPhone SE","W":375,"H":667,"stats":{"left":135.73,"top":28,"right":365,"bottom":71},"fluxbar":{"left":10,"top":86,"right":217.64,"bottom":130},"hud":[{"left":10,"top":86,"right":54,"bottom":130},{"left":0,"top":20,"right":375,"bottom":79},{"left":10,"top":86,"right":217.64,"bottom":130}]},
  {"name":"iPhone landscape","W":844,"H":390,"stats":{"left":530.22,"top":26,"right":828,"bottom":80},"fluxbar":{"left":16,"top":92,"right":304.28,"bottom":136},"hud":[{"left":16,"top":92,"right":60,"bottom":136},{"left":0,"top":16,"right":844,"bottom":90},{"left":16,"top":92,"right":304.28,"bottom":136}]},
  {"name":"iPad","W":820,"H":1180,"stats":{"left":506.22,"top":34,"right":804,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":820,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]},
  {"name":"iPad landscape","W":1180,"H":820,"stats":{"left":866.22,"top":34,"right":1164,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":1180,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]},
  {"name":"iPad mini 4 (iPadOS 15.8)","W":768,"H":1024,"stats":{"left":454.22,"top":30,"right":752,"bottom":84},"fluxbar":{"left":16,"top":96,"right":304.28,"bottom":140},"hud":[{"left":16,"top":96,"right":60,"bottom":140},{"left":0,"top":20,"right":768,"bottom":94},{"left":16,"top":96,"right":304.28,"bottom":140}]},
  {"name":"iPad mini 4 landscape","W":1024,"H":768,"stats":{"left":710.22,"top":30,"right":1008,"bottom":84},"fluxbar":{"left":16,"top":96,"right":304.28,"bottom":140},"hud":[{"left":16,"top":96,"right":60,"bottom":140},{"left":0,"top":20,"right":1024,"bottom":94},{"left":16,"top":96,"right":304.28,"bottom":140}]},
  {"name":"iPad mini 6","W":744,"H":1133,"stats":{"left":430.22,"top":34,"right":728,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":744,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]},
  {"name":"iPad mini 6 landscape","W":1133,"H":744,"stats":{"left":819.22,"top":34,"right":1117,"bottom":88},"fluxbar":{"left":16,"top":100,"right":304.28,"bottom":144},"hud":[{"left":16,"top":100,"right":60,"bottom":144},{"left":0,"top":24,"right":1133,"bottom":98},{"left":16,"top":100,"right":304.28,"bottom":144}]}
];

function suite(gameHtml, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const code = scriptsOf(gameHtml).join('\n;\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('B1 the "LEVEL SECURED • FIELD ..." line is gone', !/LEVEL SECURED|'FIELD '\+/.test(code));
  const drawBody = (code.match(/function draw\(\)\{[\s\S]*?\n\}\n/) || [''])[0];
  const lastRestore = drawBody.lastIndexOf('\n ctx.restore();'), bannerAt = drawBody.indexOf('if(levelBanner>0){');
  ck('B2 the banner is drawn after the screen-shake transform is undone (it never moves onto the line)', bannerAt > 0 && lastRestore > 0 && bannerAt > lastRestore);
  ck('B3 the banner is canvas-drawn: no DOM element, so it can never take a touch', !/id="levelBanner"|levelBanner\b[^;]*createElement/.test(gameHtml) && /\.hud\{[^}]*pointer-events:none/.test(gameHtml));
  for (const d of DEVICES) {
    const { store } = makeStore({ fluxPlayerId: 'bn-1', fluxCallsign: 'T', fluxProfileComplete: '1' });
    const g = boot(scriptsOf(gameHtml), { origin: 'https://x.test', path: '/play/', store });
    const run = (c) => vm.runInContext(c, g.ctx);
    const rectOf = (r) => ({ getBoundingClientRect: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) });
    g.win.document.querySelector = (sel) => sel === '.stats' ? rectOf(d.stats) : sel === '.fluxbar' ? rectOf(d.fluxbar) : g.win.document.getElementById('x');
    const cx = run('ctx'); const texts = [];
    // Conservative width for heavy (900) system-font caps: 0.72 em per character.
    cx.measureText = (t) => ({ width: String(t).length * parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]) * 0.72 });
    // Record what is really drawn: text, size, anchor and alignment -> its box on screen.
    cx.fillText = (t, x, y) => { const px = parseFloat(String(cx.font).match(/(\d+(?:\.\d+)?)px/)[1]); const w = cx.measureText(t).width;
      const al = String(cx.textAlign || 'start'), bl = String(cx.textBaseline || 'alphabetic');
      const left = al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x;
      const top = bl === 'top' ? y : bl === 'middle' ? y - px / 2 : bl === 'bottom' ? y - px : y - px * 0.8;
      texts.push({ t: String(t), px, box: { left, right: left + w, top, bottom: top + px } }); };
    g.ctx.newGame();
    run('W=' + d.W + ';H=' + d.H + ';paddle.y=H-Math.max(42,Math.min(90,H*.095));paddle.handleH=W<=700?22:28;paddle.x=W/2;cachedHudRects=' + JSON.stringify(d.hud) + ';');
    for (const lv of [1, 8]) {
      texts.length = 0;
      run('level=' + lv + ';score=' + (lv === 1 ? 2500 : 45000) + ';pendingLevel=0;checkScoreLevel();');
      g.ctx.draw();
      const bt = texts.filter((x) => /LEVEL/.test(x.t)), ceil = run('maxHudBottom()');
      const r = bt.length ? bt.reduce((a, x) => ({ left: Math.min(a.left, x.box.left), right: Math.max(a.right, x.box.right), top: Math.min(a.top, x.box.top), bottom: Math.max(a.bottom, x.box.bottom) }), bt[0].box) : { left: 0, right: 0, top: 0, bottom: 0 };
      const pad = run('({left:paddle.x-paddle.w*.55-12,right:paddle.x+paddle.w*.55+12,top:paddle.y-paddle.h-12,bottom:paddle.y+paddle.handleH+6})');
      const tag = d.name + ' L' + lv;
      ck('B4 ' + tag + ': banner shows "LEVEL ' + lv + '" and "NEXT LEVEL: ' + (lv + 1) + '" only', bt.map((x) => x.t).join('|') === 'LEVEL ' + lv + '|NEXT LEVEL: ' + (lv + 1), bt.map((x) => x.t).join('|'));
      ck('B5 ' + tag + ': clear of the danger line', r.bottom <= ceil - 4, Math.round(r.bottom) + ' vs line ' + Math.round(ceil));
      ck('B6 ' + tag + ': not in the play area (above the line), on screen', r.top >= 0 && r.bottom < ceil && r.left >= 0 && r.right <= d.W);
      ck('B7 ' + tag + ': clear of the launcher', !hit(r, pad));
      const hudHit = [d.stats, d.fluxbar].concat(d.hud.filter((x) => x.right - x.left < d.W * 0.9)).filter((x) => hit(r, x));
      ck('B8 ' + tag + ': clear of the HUD (score boxes, FLUX row, pause)', hudHit.length === 0, JSON.stringify(hudHit[0] || ''));
      ck('B9 ' + tag + ': text >= 11px', bt.length === 2 && bt.every((x) => x.px >= 11), bt.map((x) => x.px).join('/'));
    }
  }
  return { F, failed };
}

const main = suite(GAME_HTML);
console.log('== negative controls: each re-inserted defect MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const g2 = mutate(GAME_HTML);
  if (g2 === GAME_HTML) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(g2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']');
  if (!ok) NC++;
}
const rep = (a, b) => (s) => (s.includes(a) ? s.replace(a, b) : s);
control('old position (22% of the screen height) back', 'B5', rep('const cx=left+w/2, y1=top+Math.max(0,(h-th)/2);', 'const cx=W/2, y1=H*.22-f1;'));
control('banner allowed onto the danger line', 'B5', rep('bottom=maxHudBottom()-8;', 'bottom=maxHudBottom()+40;'));
control('banner ignores the FLUX row and pause button', 'B8', rep('const left=fb.right+12,', 'const left=12,'));
control('banner ignores the score boxes', 'B8', rep('top=st.bottom+6,', 'top=st.top,'));
control('"LEVEL SECURED • FIELD" line back', 'B1', rep("ctx.fillText(L.t1,L.cx,L.y1);", "ctx.fillText(L.t1,L.cx,L.y1);ctx.fillText('LEVEL SECURED • FIELD '+(level>=7?'CRITICAL':'STABLE'),L.cx,L.y1);"));
control('banner drawn inside the shake transform again', 'B2', (s) => {
  const a = s.indexOf(' // Level-up banner: drawn after the shake transform is undone, so it never moves.'); if (a < 0) return s;
  const b = s.indexOf('\n}\n', a); const block = s.slice(a, b + 1);
  const t = s.slice(0, a) + s.slice(b + 1); const k = t.indexOf(' if(perfectFlash>0){'); return t.slice(0, k) + block.replace(/^\n/, '') + '\n' + t.slice(k);
});
control('font floor removed (text can shrink below 11px)', 'B9', (s) => s
  .replace("f1=Math.max(11,f1); f2=Math.max(11,Math.round(f1*.72));", "f1=Math.max(5,f1-6); f2=Math.max(5,Math.round(f1*.5));")
  .replace("ctx.font='900 '+Math.max(11,L.f1)+'px", "ctx.font='900 '+L.f1+'px")
  .replace("ctx.font='900 '+Math.max(11,L.f2)+'px", "ctx.font='900 '+L.f2+'px"));
const total = main.F + NC;
console.log('\n' + (total ? 'LEVEL BANNER FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'LEVEL BANNER PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
