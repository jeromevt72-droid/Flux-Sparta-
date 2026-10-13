// GATEWAY PLAY NOW BUTTON + ANDROID NAVIGATION BAR (owner, BLU G45).
//   P1 the PLAY NOW buttons say a country the short way ("DEFEND THE USA'S LEAD", THE UK, CHINA,
//      THE PHILIPPINES' LEAD); every other country keeps its usual name; all three wordings (defend / help /
//      put on the board) and the World Grid button use it;
//   P2 a PLAY NOW text that needs two lines breaks evenly (never one lone word on the second line), keeps the
//      same number of lines, stays centered, and the white button keeps the size it had; it is re-balanced
//      at every point the headline fit runs and after the World Grid redraws;
//   N1 the Android navigation bar: an installed FLUX app takes it from the manifest theme_color, a Chrome tab
//      from the page background -- all of them stay FLUX's dark colour.
// Ends with negative controls.
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const GW = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), GAME = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8');

// Fake layout: words of 8 px per letter + 8 px per space, wrapped greedily inside min(maxWidth, avail).
function fakeBtn(text, avail) {
  const lay = (t, maxW) => {
    const lim = Math.min(maxW == null ? Infinity : maxW, avail), words = t.split(' '), lines = [];
    let cur = '';
    for (const w of words) { const n = cur ? cur + ' ' + w : w; if (cur && n.length * 8 > lim) { lines.push(cur); cur = w; } else cur = n; }
    if (cur) lines.push(cur);
    return lines;
  };
  const sp = { className: '', textContent: '', style: { maxWidth: '' }, parentNode: null,
    getBoundingClientRect() { const mw = this.style.maxWidth ? parseFloat(this.style.maxWidth) : null; const L = lay(this.textContent, mw); return { width: Math.max(...L.map((l) => l.length * 8)), height: L.length * 18 }; } };
  const btn = { _t: text, childNodes: [], style: { minWidth: '' },
    get textContent() { return this.childNodes.length ? this.childNodes.map((c) => c.textContent).join('') : this._t; },
    set textContent(v) { this._t = v; this.childNodes = []; },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); },
    querySelector() { return this.childNodes.find((c) => c.className === 'ctaText') || null; },
    getBoundingClientRect() { return { width: avail + 48, height: 60 }; } };
  return { btn, sp, lines: () => { const s = btn.querySelector(); return lay(s.textContent, s.style.maxWidth ? parseFloat(s.style.maxWidth) : null); }, natural: () => lay(text, null) };
}
function boot(src, { pref = null, standing = 'leader' } = {}) {
  const a = src.indexOf('  window.COUNTRY_META = {'), z = src.indexOf('  window.fmtScore', a);
  const made = [];
  const play = { textContent: '' };
  const g = { window: {}, document: {
    createElement: () => { const s = { className: '', textContent: '', style: { maxWidth: '' } }; s.getBoundingClientRect = () => ({ width: 0, height: 0 }); made.push(s); return s; },
    getElementById: (id) => (id === 'heroPlayBtn' ? play : null), querySelectorAll: () => [] },
    getComputedStyle: () => ({ boxSizing: 'content-box', paddingLeft: '24px', paddingRight: '24px', borderLeftWidth: '0px', borderRightWidth: '0px' }), Math, parseFloat };
  vm.createContext(g); vm.runInContext(src.slice(a, z), g);
  const b = src.indexOf('  window.applyPreferredCountryUI = function(){'), e = src.indexOf('  var heroFlagBarEl', b);
  g.window.getPreferredCountry = () => pref; g.window.countryStanding = () => standing;
  play.querySelector = () => null; play.childNodes = []; play.appendChild = () => {};
  vm.runInContext(src.slice(b, e), g);
  return { w: g.window, g, play };
}
function suite(src, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  try {
    const { w } = boot(src);
    const nm = (c) => w.ctaPossessive(w.ctaCountryName(c));
    ck("P1 short names: THE USA'S, THE UK'S, CHINA'S, THE PHILIPPINES' (a plural name takes only the apostrophe)",
      nm('US') === "THE USA'S" && nm('GB') === "THE UK'S" && nm('CN') === "CHINA'S" && nm('PH') === "THE PHILIPPINES'", [nm('US'), nm('GB'), nm('CN'), nm('PH')].join(' | '));
    ck('P1 every other country keeps its usual name (in capitals)', w.ctaCountryName('BR') === 'BRAZIL' && w.ctaCountryName('JP') === 'JAPAN' && w.ctaCountryName('KR') === 'SOUTH KOREA', w.ctaCountryName('BR'));
    const texts = ['leader', 'chasing', 'unranked'].map((st) => { const r = boot(src, { pref: 'US', standing: st }); r.w.fluxBalanceCta = () => {}; r.w.applyPreferredCountryUI(); return r.play.textContent; });
    ck('P1 the hero button: all three wordings use the short name', texts[0] === "PLAY NOW — DEFEND THE USA'S LEAD" && texts[1] === 'PLAY NOW — HELP THE USA CLOSE THE GAP' && texts[2] === 'PLAY NOW — PUT THE USA ON THE BOARD', texts.join(' | '));
    ck('P1 the World Grid PLAY NOW button uses the short name too', /var ctaNm = window\.ctaCountryName\(preferred\);[\s\S]{0,120}'PLAY NOW — DEFEND ' \+ window\.escapeHtml2\(window\.ctaPossessive\(ctaNm\)\) \+ ' LEAD'[\s\S]{0,120}'PLAY NOW — HELP ' \+ window\.escapeHtml2\(ctaNm\) \+ ' CLOSE THE GAP'/.test(src));

    // P2: the BLU G45 case. At 230 px the plain wrap leaves "LEAD" alone.
    const T = "PLAY NOW — DEFEND BRAZIL'S LEAD", f = fakeBtn(T, 230);
    const r2 = boot(src); r2.g.document.createElement = () => f.sp;
    r2.w.fluxBalanceCta(f.btn);
    const L = f.lines(), N = f.natural();
    ck('P2 (rig) the plain wrap leaves one lone word on the second line', N.length === 2 && N[1] === 'LEAD', N.join(' / '));
    ck('P2 balanced: same number of lines, and no lone word on the last line', L.length === N.length && L[L.length - 1].split(' ').length > 1, L.join(' / '));
    ck('P2 the lines are about the same length', Math.abs(L[0].length - L[1].length) <= 6, L.join(' / '));
    ck('P2 the white button keeps the size it had (min-width = old width less the padding)', f.btn.style.minWidth === (230 + 48 - 48) + 'px', f.btn.style.minWidth);
    ck('P2 the text itself is unchanged', f.btn.textContent === T, f.btn.textContent);
    const one = fakeBtn("PLAY NOW — DEFEND CHINA'S LEAD", 600); const r3 = boot(src); r3.g.document.createElement = () => one.sp; r3.w.fluxBalanceCta(one.btn);
    ck('P2 a text that fits on one line is left exactly as today', one.sp.style.maxWidth === '' && one.btn.style.minWidth === '' && one.lines().length === 1);
    r2.w.fluxBalanceCta(f.btn);
    ck('P2 balancing again (resize) gives the same result', f.lines().join('/') === L.join('/') && f.btn.childNodes.length === 1);
    ck('P2 the button text is centered', /\.actions \.btn\{text-align:center\}/.test(src) && /\.ctaText\{display:inline-block;vertical-align:top\}/.test(src));
    ck('P2 both PLAY NOW buttons are balanced (hero and World Grid)', /id="heroPlayBtn" data-cta-balance /.test(src) && /class="btn primary" data-cta-balance style="display:block;text-align:center/.test(src));
    ck('P2 re-balanced when the country changes, at every headline fit (load, fonts, resize, rotation), and after the World Grid redraws',
      /window\.fluxBalanceCta\(playBtn\);/.test(src) && /function fitHeroBrand\(\)\{[\s\S]{0,200}window\.fluxBalanceAllCtas\(\);[\s\S]{0,60}fitHeroCta\(\);/.test(src) && /sideArea\.innerHTML = sideHtml;\n    window\.fluxBalanceAllCtas\(\);/.test(src));
    ck('P2 no new listeners on the Gateway (still 23)', (src.match(/addEventListener\(/g) || []).length === 23, (src.match(/addEventListener\(/g) || []).length);

    // N1: dark everywhere Chrome takes the navigation bar colour from.
    const lum = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return ((n >> 16) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) / 255; };
    const man = JSON.parse(MANIFEST);
    ck('N1 installed app: the manifest theme_color (what Chrome paints the navigation bar with) is FLUX dark', /^#[0-9a-f]{6}$/i.test(man.theme_color || '') && lum(man.theme_color) < 0.08, man.theme_color);
    ck('N1 installed app: the splash background_color is FLUX dark', lum(man.background_color || '#ffffff') < 0.08, man.background_color);
    const gwBg = (src.match(/html\{scroll-behavior:smooth;background:(#[0-9a-f]{6})\}/i) || [])[1], gmBg = (GAME.match(/html,body\{[^}]*background:(#[0-9a-f]{6})/i) || [])[1];
    ck('N1 Chrome tab: the page background (what Chrome tints the bar with) is dark on the Gateway and the game', !!gwBg && !!gmBg && lum(gwBg) < 0.08 && lum(gmBg) < 0.08, gwBg + ' ' + gmBg);
    ck('N1 both pages use the one manifest', /<link rel="manifest" href="\/manifest\.webmanifest">/.test(src) && /<link rel="manifest" href="\/manifest\.webmanifest">/.test(GAME));
  } catch (e) { ck('suite ran', false, String(e.stack || e).slice(0, 300)); }
  return { F, failed };
}

const res = suite(GW);
console.log('\n== negative controls: each defect re-inserted MUST be caught ==');
let NC = 0;
function control(label, expect, a, b) {
  if (!GW.includes(a)) { console.log('  FAIL  control did not apply: ' + label); NC++; return; }
  const r = suite(GW.split(a).join(b), true); const hit = r.failed.filter((x) => x.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
control('long names again', 'P1 short names', "US:'THE USA', GB:'THE UK',", '');
control("PHILIPPINES'S", 'P1 short names', 'return /^THE .*S$/.test(nm) ?', 'return false ?');
control('hero button back to the full name', 'P1 the hero button', 'var NM=window.ctaCountryName(code);', 'var NM=window.countryMeta(code).name.toUpperCase();');
control('no balancing', 'P2 balanced', "if(sp.getBoundingClientRect().height > h + 1) lo = mid; else hi = mid;", 'lo = mid;');
control('the button shrinks to the text', 'P2 the white button keeps', "btn.style.minWidth = (box.width - extra) + 'px';", '');
control('text left-aligned', 'P2 the button text is centered', '.actions .btn{text-align:center}', '.actions .btn{}');
control('not re-balanced on resize', 'P2 re-balanced', 'window.fluxBalanceAllCtas();   // EVEN LINES first', '');
control('a light status/navigation colour', 'N1 Chrome tab', 'html{scroll-behavior:smooth;background:#03030b}', 'html{scroll-behavior:smooth;background:#ffffff}');
const total = res.F + NC;
console.log('\n' + (total ? 'GATEWAY CTA FAILED: ' + res.F + ' check(s), ' + NC + ' uncaught control(s)' : 'GATEWAY CTA PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
