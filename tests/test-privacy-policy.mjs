// Privacy policy matches the game, in the release gate (launch readiness).
//   P1 both published copies (/privacy.html and the retired /welcome/privacy.html,
//      still reachable) are finished: no "not ready" note, no placeholder, identical;
//   P2 what the policy promises is true in the code: no analytics, advertising,
//      tracking pixels or cookies anywhere the site serves, and ads are switched off;
//   P3 what the policy says about names and children matches the game: automatic
//      FLUX ID (PILOT-XXXX), the name rule, a children section for a general
//      audience with a parents' contact;
//   P4 the fields a score upload sends are the ones the policy lists.
// Ends with negative controls: adding a tracker or ads, or leaving a placeholder, MUST fail.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const SITE = () => walk('public').filter((f) => /\.(html|js|webmanifest)$/.test(f)).concat(['worker.js']);
const TRACKERS = /google-analytics\.com|googletagmanager\.com|\bgtag\(|adsbygoogle|pagead2\.googlesyndication|doubleclick\.net|connect\.facebook\.net|\bfbq\(|document\.cookie|plausible\.io|mixpanel|cdn\.segment\.com|hotjar|clarity\.ms|Set-Cookie/;

function suite(files, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) { F++; failed.push(l); } };
  const pv = files['public/privacy.html'], wv = files['public/welcome/privacy.html'], game = files['public/play/index.html'];
  ck('P1 the policy is finished: no "not ready" note, no placeholder, an effective date', !/Not yet ready|OWNER INPUT|class="todo"|\[[A-Z ]+:/.test(pv) && /Effective date: <strong>[A-Z][a-z]+ \d{1,2}, 20\d\d<\/strong>/.test(pv));
  ck('P1 the retired /welcome/ copy (still reachable) is the same finished policy', wv === pv);
  const hits = Object.entries(files).filter(([f, s]) => !/privacy\.html$/.test(f) && TRACKERS.test(s)).map(([f, s]) => f + ': ' + s.match(TRACKERS)[0]);
  ck('P2 no analytics, advertising, tracking pixels or cookies anywhere the site serves (as the policy says)', hits.length === 0 && /no analytics, no advertising, no tracking pixels, and no\s*cookies/.test(pv), hits.slice(0, 3).join(' | '));
  ck('P2 ads are switched off in the game (the revive is free)', /const ADS_ENABLED = false;/.test(game));
  ck('P3 the policy describes the automatic FLUX ID the game really gives (PILOT-XXXX, 4 letters/digits)', /callsign = 'PILOT-' \+ t;/.test(game) && /for \(var j = 0; j < 4; j\+\+\)/.test(game) && /PILOT-7K2Q/.test(pv));
  ck('P3 the policy states the real name rule (letters, numbers, spaces, dots, dashes, underscores; blocked names shown as PILOT)',
    /s\.replace\(\/\[\^\\p\{L\}\\p\{N\} \._-\]\/gu, ""\)/.test(files['worker.js']) && /letters, numbers,\s*spaces, dots, dashes and underscores/.test(pv) && /blocked list are shown as\s*<code>PILOT<\/code>/.test(pv));
  ck('P3 children: general audience, nickname advice, parents can have an entry removed', /general audience, and children may play/.test(pv) && /children should use a nickname/.test(pv) && /Parents and guardians/.test(pv) && /mailto:playfluxofficial@gmail\.com/.test(pv) && !/intended for players aged 13 and older/.test(pv));
  const w = files['worker.js'];
  ck('P4 a score upload carries exactly what the policy lists (player identifier, FLUX ID, score, level, difficulty, country) plus the Cloudflare country',
    /body: JSON\.stringify\(\{ playerId, name, score, level, difficulty, country, detected \}\)/.test(w) && /your player identifier/.test(pv) && /your FLUX ID/.test(pv) && /your score, level, and difficulty/.test(pv) && /your chosen country/.test(pv) && /country code that Cloudflare/.test(pv));
  return { F, failed };
}

const FILES = Object.fromEntries(SITE().map((f) => [f, read(f)]));
const main = suite(FILES);
console.log('== negative controls: each mismatch MUST be caught ==');
let NC = 0;
function control(label, expect, mutate) {
  const f2 = mutate(Object.assign({}, FILES)); const r = suite(f2, true); const h = r.failed.filter((f) => f.startsWith(expect)); const ok = h.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? h[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
const edit = (file, a, b) => (fl) => { if (!fl[file].includes(a)) throw new Error('control did not apply: ' + a); fl[file] = fl[file].replace(a, b); return fl; };
control('Google Analytics added to the game', 'P2', edit('public/play/index.html', '</head>', '<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script></head>'));
control('ads switched on', 'P2', edit('public/play/index.html', 'const ADS_ENABLED = false;', 'const ADS_ENABLED = true;'));
control('a cookie set by the Gateway', 'P2', edit('public/index.html', '</body>', '<script>document.cookie="v=1"</script></body>'));
control('placeholder left in the retired copy', 'P1', edit('public/welcome/privacy.html', 'Effective date:', 'Effective date: [OWNER INPUT REQUIRED: date]'));
control('"not ready" note back', 'P1', edit('public/privacy.html', '<h1>Privacy Policy</h1>', '<h1>Privacy Policy</h1><div class="todo">Not yet ready for publication.</div>'));
control('auto names change format without the policy', 'P3', edit('public/play/index.html', "callsign = 'PILOT-' + t;", "callsign = 'PLAYER-' + t;"));
control('children section back to "13 and older"', 'P3', edit('public/privacy.html', 'FLUX is a game for a general audience, and children may play it.', 'FLUX is intended for players aged 13 and older.'));
control('upload sends a new field', 'P4', edit('worker.js', 'body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected })', 'body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected, ua: request.headers.get("user-agent") })'));
const total = main.F + NC;
console.log('\n' + (total ? 'PRIVACY POLICY FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PRIVACY POLICY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
