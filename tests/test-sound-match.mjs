// SOUND MATCH (owner): one master volume (0.30) for the game and the Gateway demo; on Android Chrome and
// Samsung Internet ONLY, +8.5 dB after the compressor, then a safety ceiling; every other browser exactly as today.
//   S1 one shared block, identical in the game and the Gateway demo; SOUND_LEVEL .30 in both (demo was .52),
//      the demo's mute toggle restores SOUND_LEVEL;
//   S2 who gets the boost: Android Chrome and Samsung Internet only -- never iPhone, iPad, desktop, Android
//      in-app browsers (wv), Firefox, Edge, Opera, other Android browsers;
//   S3 without the boost the output is exactly today's: compressor -> speakers, no node created;
//   S4 with it: compressor -> gain (+8.5 dB, halved for the curve) -> safety curve -> speakers; the curve is
//      exactly linear up to 85% of full scale, smooth above, never past 96.6% (-0.3 dBFS), symmetric;
//   S5 unchanged around it: the game's fade-in to SOUND_LEVEL, the compressor settings, the PR #58 resume.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const SRC = { game: fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8'), demo: fs.readFileSync(path.join(ROOT, 'public', 'hero-demo.html'), 'utf8') };
const UA = {
  android_chrome: ['Mozilla/5.0 (Linux; Android 12; BLU G45) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', true],
  samsung: ['Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36', true],
  iphone: ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', false],
  iphone_chrome: ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1', false],
  ipad: ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', false],
  desktop_chrome: ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', false],
  android_inapp: ['Mozilla/5.0 (Linux; Android 12; BLU G45; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 Instagram 300', false],
  android_firefox: ['Mozilla/5.0 (Android 12; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0', false],
  android_edge: ['Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0', false],
  android_opera: ['Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 OPR/80.0', false],
  android_miui: ['Mozilla/5.0 (Linux; U; Android 12; Redmi) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0 Mobile Safari/537.36 XiaoMi/MiuiBrowser/17.0', false],
  empty: ['', false] };
const block = (h) => { const a = h.indexOf('/* SOUND MATCH (owner).'), z = h.indexOf('function initAudio(){', a); return a < 0 || z < 0 ? '' : h.slice(a, z); };
function run(h, ua) {
  const made = [], links = [];
  const node = (kind) => { const n = { kind, gain: { value: 1 }, curve: null, oversample: 'x', connect(to) { links.push([kind, to.kind]); } }; made.push(n); return n; };
  const ctx = { destination: { kind: 'speakers' }, createGain: () => node('gain'), createWaveShaper: () => node('shaper') };
  const g = { navigator: { userAgent: ua }, Math, Float32Array };
  vm.createContext(g); vm.runInContext(block(h) + '\nthis.__on = soundBoostOn(); soundConnectOutput(this.__ctx, this.__lim);', Object.assign(g, { __ctx: ctx, __lim: { kind: 'compressor', connect(to) { links.push(['compressor', to.kind]); } } }));
  return { on: g.__on, made, links: links.map((x) => x.join('>')).join(' '), curve: made.find((n) => n.kind === 'shaper') && made.find((n) => n.kind === 'shaper').curve, boost: made.find((n) => n.kind === 'gain') };
}
function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 200) + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const bg = block(src.game), bd = block(src.demo);
    ck('S1 one sound block, identical in the game and the Gateway demo', bg.length > 500 && bg === bd);
    const lvl = (h) => (h.match(/const SOUND_LEVEL=([.\d]+)/) || [])[1];
    ck('S1 one master volume: SOUND_LEVEL .30 in the game and the demo (demo was .52); the demo\'s mute toggle restores it', lvl(src.game) === '.30' && lvl(src.demo) === '.30' && /masterGain\.gain\.value=SOUND_LEVEL;/.test(src.demo)
      && /masterGain\.gain\.value = on \? SOUND_LEVEL : 0;/.test(src.demo) && !/masterGain\.gain\.value\s*=\s*[^;]*\.52/.test(src.demo), [lvl(src.game), lvl(src.demo)].join(' / '));
    const wrong = [];
    for (const [k, [ua, want]] of Object.entries(UA)) for (const h of [src.game, src.demo]) { const r = run(h, ua); if (r.on !== want) wrong.push(k); }
    ck('S2 the boost is on for Android Chrome and Samsung Internet only (not iPhone, iPad, desktop, in-app, Firefox, Edge, Opera, MIUI)', wrong.length === 0, [...new Set(wrong)].join(', '));
    const off = ['iphone', 'ipad', 'desktop_chrome', 'android_inapp'].map((k) => run(src.game, UA[k][0]));
    ck('S3 without the boost the output is exactly today\'s: compressor -> speakers, no node created', off.every((r) => r.links === 'compressor>speakers' && r.made.length === 0), off.map((r) => r.links).join(' | '));
    const on = run(src.game, UA.android_chrome[0]), c = on.curve, n = c ? c.length : 0;
    ck('S4 with it: compressor -> gain (+8.5 dB, halved) -> safety curve (no oversampling) -> speakers', on.links === 'compressor>gain gain>shaper shaper>speakers' && Math.abs(on.boost.gain.value - Math.pow(10, 8.5 / 20) / 2) < 1e-9 && on.made[1].oversample === 'none', on.links);
    let lin = true, mono = true, max = 0, sym = true;
    for (let i = 0; i < n; i++) { const x = 2 * (i * 2 / (n - 1) - 1); if (Math.abs(x) <= .85 && Math.abs(c[i] - x) > 1e-6) lin = false; if (i && c[i] < c[i - 1] - 1e-9) mono = false; max = Math.max(max, Math.abs(c[i])); if (Math.abs(c[i] + c[n - 1 - i]) > 1e-6) sym = false; }
    ck('S4 the curve: exactly linear up to 85% of full scale, rising, symmetric, never past 96.6% (-0.3 dBFS)', n > 1000 && lin && mono && sym && max <= .966 + 1e-6 && max > .96, JSON.stringify({ n, lin, mono, sym, max: +max.toFixed(4) }));
    ck('S5 unchanged around it: the game fades in to SOUND_LEVEL over 1.5 s; same compressor settings in both; the PR #58 resume', /masterGain\.gain\.linearRampToValueAtTime\(SOUND_LEVEL,audioCtx\.currentTime\+SOUND_FADE_IN_S\)/.test(src.game) && /const SOUND_LEVEL=\.30, SOUND_FADE_IN_S=1\.5;/.test(src.game)
      && [src.game, src.demo].every((h) => /audioLimiter\.threshold\.value=-12;\s*audioLimiter\.knee\.value=8;\s*audioLimiter\.ratio\.value=12;\s*audioLimiter\.attack\.value=\.003;\s*audioLimiter\.release\.value=\.12;\s*masterGain\.connect\(audioLimiter\);\s*soundConnectOutput\(audioCtx,audioLimiter\);/.test(h))
      && /if\(audioCtx\.state!=='running' && audioCtx\.state!=='closed'\)\{ const p=audioCtx\.resume\(\);/.test(src.game));
  } catch (e) { ck('section ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}
const res = suite(SRC);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, file, a, b) {
  const s2 = Object.assign({}, SRC); if (!s2[file].includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  s2[file] = s2[file].split(a).join(b); if (file === 'both') {}
  const r = suite(s2, true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
control('the demo keeps its own louder volume', 'S1 one master', 'demo', 'const SOUND_LEVEL=.30;', 'const SOUND_LEVEL=.52;');
control('the boost reaches the iPhone (no Android check)', 'S2', 'game', "    if(!/Android/.test(ua)) return false;\n", '');
control('in-app browsers boosted too', 'S2', 'game', '; wv\\)|', '');
control('a pass-through node on every browser', 'S3', 'game', "  if(!soundBoostOn()){ limiter.connect(ctx.destination); return; }", "  if(!soundBoostOn()){ const g0=ctx.createGain(); limiter.connect(g0); g0.connect(ctx.destination); return; }");
control('no safety ceiling', 'S4 with it', 'game', 'limiter.connect(boost); boost.connect(safe); safe.connect(ctx.destination);', 'limiter.connect(boost); boost.connect(ctx.destination);');
control('the ceiling at full scale', 'S4 the curve', 'game', 'SOUND_SAFE_MAX=.966', 'SOUND_SAFE_MAX=1');
control('the curve shapes normal sounds too', 'S4 the curve', 'game', 'SOUND_SAFE_KNEE=.85,', 'SOUND_SAFE_KNEE=.5,');
const total = res.F + NC;
console.log('\n' + (total ? 'SOUND MATCH FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'SOUND MATCH PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
