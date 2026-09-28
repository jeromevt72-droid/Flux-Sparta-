// Privacy policy matches the game, in the release gate (launch readiness).
//   P1 both published copies (/privacy.html and the retired /welcome/privacy.html,
//      still reachable) are finished: no "not ready" note, no placeholder, identical;
//   P2 what the policy promises is true in the code: no analytics, advertising,
//      tracking pixels or cookies anywhere the site serves, and ads are switched off;
//   P3 what the policy says about names and children matches the game: a preset
//      name to start, typed names one word / A-Z 0-9 / up to 12 / no email, phone
//      or link look-alikes, enforced by the server, old text erased; a children
//      section for a general audience, marked for lawyer review, with a parents' contact;
//   P4 the fields a score upload sends are the ones the policy lists;
//   P5 country only: nothing in the site or worker reads a precise location, as the policy says;
//   P6 the player identifier is described as internal-only, and future stats as anonymous and in-house;
//   T1 the Terms match: kids may play, no "13 and older", children section marked
//      for lawyer review, both published copies identical and finished.
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
  const tm = files['public/terms.html'], wt = files['public/welcome/terms.html'];
  ck('P1 the policy is finished: no "not ready" note, no placeholder, an effective date', !/Not yet ready|OWNER INPUT|class="todo"|\[[A-Z ]+:/.test(pv) && /Effective date: <strong>[A-Z][a-z]+ \d{1,2}, 20\d\d<\/strong>/.test(pv));
  ck('P1 the retired /welcome/ copy (still reachable) is the same finished policy', wv === pv);
  // FLUX COMMAND: the one cookie allowed is the OWNER's admin login -- set only by commandCookie(), only after the
  // admin password, HttpOnly and scoped to /api/admin, so it never reaches a player. Any other Set-Cookie still fails.
  const ownerOnly = (f, s) => f === 'worker.js' && /function commandCookie\(token, maxAgeSec\) \{\n  return COMMAND_COOKIE \+ "=" \+ token \+ "; Path=\/api\/admin; HttpOnly;/.test(s)
    ? s.replace(/\{ "Set-Cookie": commandCookie\(/g, '{ commandCookie(') : s;
  const hits = Object.entries(files).map(([f, s]) => [f, ownerOnly(f, s)]).filter(([f, s]) => !/privacy\.html$/.test(f) && TRACKERS.test(s)).map(([f, s]) => f + ': ' + s.match(TRACKERS)[0]);
  ck('P2 no third-party analytics, advertising, tracking pixels or cookies anywhere the site serves (as the policy says)', hits.length === 0 && /no third-party analytics, no advertising, no tracking pixels, and no\s*cookies for players/.test(pv) && /only cookie is a <strong>security cookie for the owner's admin login<\/strong>[\s\S]{0,200}never set for players/.test(pv) && !/and no\s*cookies<\/strong>/.test(pv), hits.slice(0, 3).join(' | '));
  ck('P2 ads are switched off in the game (the revive is free)', /const ADS_ENABLED = false;/.test(game));
  const rule = /if \(!\/\^\[A-Z0-9\]\+\$\/\.test\(s\) \|\| s\.length > TYPED_NAME_MAX\)/;
  ck('P3 the policy describes the names the game really allows (preset to start; typed: one word, letters and numbers, up to 12; no email, phone or link)',
    /callsign = randomPresetName\(\);/.test(game) && /const TYPED_NAME_MAX = 12;/.test(game) && rule.test(game) && /GMAIL/.test(game) && /\.length >= 7\) return/.test(game)
    && /SWIFT COMET 42/.test(pv) && /<strong>one\s+word<\/strong>, letters and numbers only, up to 12 characters/.test(pv)
    && /a full\s+name cannot be entered/.test(pv) && /look like an email address, a phone\s+number or a web link are refused/.test(pv) && !/PILOT-7K2Q|Names cannot be typed|dice/.test(pv));
  ck('P3 the policy says the server only accepts names that follow the rules and erased old text; the worker does both',
    /const name = presetOrOwn\(cleanName\(body\.name\), playerId\);/.test(files['worker.js']) && /function presetOrOwn\(name, playerId\) \{ return isAllowedName\(name\)/.test(files['worker.js'])
    && /await this\.migrateNames\(\);/.test(files['worker.js']) && /only accepts names that follow these rules/.test(pv) && /old\s+text has been deleted from our server/.test(pv));
  ck('P3 children: general audience, no personal information needed, marked for lawyer review, parents can have an entry removed',
    /general audience, and children may play/.test(pv) && /nobody, of any age, has to give personal information to\s*play/.test(pv)
    && /<h2>14\. Children<\/h2>\s*<div class="review"><strong>For lawyer review before launch\.<\/strong>/.test(pv)
    && /Parents and guardians/.test(pv) && /mailto:playfluxofficial@gmail\.com/.test(pv) && !/intended for players aged 13 and older/.test(pv));
  const w = files['worker.js'];
  ck('P4 a score upload carries exactly what the policy lists (player identifier, FLUX ID, score, level, difficulty, country) plus the Cloudflare country',
    /body: JSON\.stringify\(\{ playerId, name, score, level, difficulty, country, detected \}\)/.test(w) && /your player identifier/.test(pv) && /your FLUX ID/.test(pv) && /your score, level, and difficulty/.test(pv) && /your chosen country/.test(pv) && /country code that Cloudflare/.test(pv));
  const site = Object.entries(files).filter(([f]) => !/\.html$/.test(f) || /play\/index\.html$|^public\/index\.html$/.test(f));
  const LOCATION = /navigator\.geolocation|\bcf\.(city|region|regionCode|postalCode|latitude|longitude|metroCode|timezone)\b|request\.cf\.(city|region|regionCode|postalCode|latitude|longitude|metroCode|timezone)\b/;
  const loc = site.filter(([, t]) => LOCATION.test(t)).map(([f, t]) => f + ': ' + t.match(LOCATION)[0]);
  ck('P5 country only: nothing reads a precise location (no geolocation, no Cloudflare city/region/coordinates), as the policy says',
    loc.length === 0 && /only ever uses a country,\s*never a precise location/.test(pv), loc.join(' | '));
  ck('P6 the player identifier is described as used only to run the game, never for ads or tracking',
    /<strong>The player identifier is used only to run the game:<\/strong>/.test(pv) && /<strong>never<\/strong> used for advertising/.test(pv));
  const g = files['public/play/index.html'], wk = files['worker.js'];
  ck('P6 the in-house statistics are described the way they are built (own server, one-way code, country only, src tag, 90 days, lawyer review)',
    /const FLUX_STATS_URL='\/api\/events';/.test(g) && /const AN_KEEP_DAYS = 90;/.test(wk) && /"flux-stats:" \+ String\(playerId\)/.test(wk)
    && /<h3 id="stats">Anonymous gameplay statistics \(in-house\)<\/h3>\s*<div class="review"><strong>For lawyer review before launch\.<\/strong>/.test(pv)
    && /<strong>our own server<\/strong>/.test(pv) && /one-way code, different from the\s+leaderboard's tag/.test(pv) && /<strong>90 days<\/strong>/.test(pv) && /\?src=tiktok/.test(pv) && !/Future gameplay statistics/.test(pv));
  const evs = [...g.matchAll(/fluxTrack\('([a-z_]+)'/g)].map((m) => m[1]).sort().join(',');
  ck('P6 ...the events the game sends are exactly the ones the policy lists', evs === 'first_run,level_up,open,play,run_end,share' && /the app being opened[\s\S]{0,120}first run, each finished run[\s\S]{0,120}level-ups, and taps on the share button/.test(pv)
    && /For each finished run we also count, for each speed of the ball reached in\s+that run: the seconds played at that speed, the orbs hit, the wrong-colour\s+orbs hit and the balls lost\./.test(pv), evs);
  ck('T1 Terms: kids may play, no "13 and older", children section marked for lawyer review',
    /Anyone may play FLUX, including children/.test(tm) && !/at least 13/.test(tm) && /<div class="review"><strong>For lawyer review before launch\.<\/strong>/.test(tm));
  ck('T1 Terms describe the name rules (one word, letters and numbers, up to 12, no full names)', /a typed name must be one word, letters and numbers\s+only, up to 12 characters/.test(tm) && /Full names/.test(tm) && !/up to 14 characters|dice|Names cannot be typed/.test(tm));
  ck('T1 both published Terms copies are identical and finished', wt === tm && !/Not yet ready|OWNER INPUT|class="todo"/.test(tm));
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
control('a cookie set on a player API response', 'P2', edit('worker.js', 'return withCors(await submitScore(request, env));', 'return withCors(json({ ok: true }, 200, { "Set-Cookie": "pid=1" }));'));
control('the admin cookie opened to the whole site', 'P2', edit('worker.js', '"; Path=/api/admin; HttpOnly;', '"; Path=/; HttpOnly;'));
control('placeholder left in the retired copy', 'P1', edit('public/welcome/privacy.html', 'Effective date:', 'Effective date: [OWNER INPUT REQUIRED: date]'));
control('"not ready" note back', 'P1', edit('public/privacy.html', '<h1>Privacy Policy</h1>', '<h1>Privacy Policy</h1><div class="todo">Not yet ready for publication.</div>'));
control('auto names go back to PILOT-XXXX without the policy', 'P3', edit('public/play/index.html', "callsign = randomPresetName();", "callsign = 'PILOT-' + t;"));
control('game allows longer typed names than the policy says', 'P3', edit('public/play/index.html', 'const TYPED_NAME_MAX = 12;', 'const TYPED_NAME_MAX = 20;'));
control('server stops erasing old name text', 'P3', edit('worker.js', 'await this.migrateNames();', ';'));
control('Terms go back to 14-character names', 'T1', edit('public/terms.html', 'up to 12 characters', 'up to 14 characters'));
control('server shows free text again', 'P3', edit('worker.js', 'function presetOrOwn(name, playerId) { return isAllowedName(name)', 'function presetOrOwn(name, playerId) { return true'));
control('lawyer-review mark dropped from the children section', 'P3', edit('public/privacy.html', '<h2>14. Children</h2>\n<div class="review">', '<h2>14. Children</h2>\n<div>'));
control('the game asks for GPS', 'P5', edit('public/play/index.html', '</body>', '<script>navigator.geolocation.getCurrentPosition(function(){})</script></body>'));
control('the worker reads the Cloudflare city', 'P5', edit('worker.js', 'const cc = (request.cf && request.cf.country) || "";', 'const cc = (request.cf && request.cf.country) || ""; const city = request.cf.city;'));
control('policy stops limiting the player identifier', 'P6', edit('public/privacy.html', '<strong>The player identifier is used only to run the game:</strong>', '<strong>The player identifier is used to run the game:</strong>'));
control('Terms back to 13 and older', 'T1', edit('public/terms.html', 'Anyone may play FLUX, including children.', 'You must be at least 13 years old to play FLUX.'));
control('retired Terms copy left behind', 'T1', edit('public/welcome/terms.html', 'Effective date:', 'Effective date: [OWNER INPUT REQUIRED: date]'));
control('children section back to "13 and older"', 'P3', edit('public/privacy.html', 'FLUX is a game for a general audience, and children may play it.', 'FLUX is intended for players aged 13 and older.'));
control('the game counts a new event the policy does not list', 'P6', edit('public/play/index.html', "fluxTrack('share');", "fluxTrack('share'); fluxTrack('scroll');"));
control('policy says plain "no cookies" again (admin cookie not disclosed)', 'P2', (f) => { let o = f; for (const q of ['public/privacy.html', 'public/welcome/privacy.html']) o = edit(q, 'cookies for players</strong>', 'cookies</strong>')(o); return o; });
control('admin cookie sentence dropped', 'P2', edit('public/privacy.html', "The only cookie is a <strong>security cookie for the owner's admin login</strong>.", ''));
control('stats kept longer than the policy says', 'P6', edit('worker.js', 'const AN_KEEP_DAYS = 90;', 'const AN_KEEP_DAYS = 365;'));
control('upload sends a new field', 'P4', edit('worker.js', 'body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected })', 'body: JSON.stringify({ playerId, name, score, level, difficulty, country, detected, ua: request.headers.get("user-agent") })'));
const total = main.F + NC;
console.log('\n' + (total ? 'PRIVACY POLICY FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'PRIVACY POLICY PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
