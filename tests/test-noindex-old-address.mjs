// SEO, OLD ADDRESS OUT OF GOOGLE (owner, anonymity): Google lists only fluxsparta.com. The old address
// flux-sparta-3.<account>.workers.dev keeps working for players (the pilot move too), but every page served there
// carries "X-Robots-Tag: noindex", added by Cloudflare's static-asset layer from public/_headers (a host-specific
// rule, Cloudflare's documented workers.dev example), so HTML never invokes the Worker (free plan).
//   N1 public/_headers: one rule only, for workers.dev hosts (https://:version.:subdomain.workers.dev/*), one header
//      X-Robots-Tag: noindex; Cloudflare's format (unindented URL line, indented "Name: value"), within its limits
//      (100 rules, 2,000 characters a line); the old address is not written out (anonymity);
//   N2 matched as Cloudflare documents it (absolute https URL; protocol and port ignored; a host placeholder
//      matches up to a period; * matches the rest of the path): EVERY page in public/ (and its folder address,
//      e.g. / and /play/) served on flux-sparta-3.<account>.workers.dev, and on a version preview of it, gets the
//      header; on fluxsparta.com and www.fluxsparta.com nothing gets any extra header;
//   N3 nothing else changes: the Worker never sets X-Robots-Tag (API, purchases, the pilot move and the Play app's
//      asset links unchanged); run_worker_first is unchanged (pages stay on the asset layer); only public/_headers
//      is new in public/; no page got a <meta name="robots"> (that would reach fluxsparta.com too);
//   N4 robots.txt does NOT block the old address (Google must read the noindex) and is unchanged; sitemap.xml lists
//      only fluxsparta.com addresses; the canonical links (to fluxsparta.com) are unchanged.
// Ends with negative controls.
import fs from 'fs'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'FLUX-Sparta');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const git = (args) => { try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { return null; } };
const OLD_HOST = 'flux-sparta-3.' + 'jeromevt72' + '.workers.dev';   // built here so the account name is not one more literal in the repo's pages
const HOSTS_OLD = [OLD_HOST, 'a1b2c3d4-flux-sparta-3.' + 'jeromevt72' + '.workers.dev'];   // the old address and a version preview of it
const HOSTS_NEW = ['fluxsparta.com', 'www.fluxsparta.com'];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const PAGES = walk(PUB).filter((f) => f.endsWith('.html')).map((f) => '/' + path.relative(PUB, f).split(path.sep).join('/'));
const PATHS = [...new Set(PAGES.flatMap((p) => (p.endsWith('/index.html') ? [p, p.slice(0, -'index.html'.length)] : [p])))].sort();
const IN = {
  headers: fs.existsSync(path.join(PUB, '_headers')) ? read('public/_headers') : null,
  worker: read('worker.js'), wrangler: read('wrangler.jsonc'), robots: read('public/robots.txt'), sitemap: read('public/sitemap.xml'),
  pages: Object.fromEntries(PAGES.map((p) => [p, read('public' + p)])),
};
const MAIN = { robots: git(['show', 'origin/main:public/robots.txt']), wrangler: git(['show', 'origin/main:wrangler.jsonc']),
  pages: Object.fromEntries(PAGES.map((p) => [p, git(['show', 'origin/main:public' + p])])) };

/* Cloudflare's _headers format and matching, as documented for Workers static assets. */
function parseHeaders(text) {
  const rules = []; let cur = null, bad = [];
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { cur = { url: raw.trim(), headers: [] }; rules.push(cur); continue; }
    const m = raw.trim().match(/^([A-Za-z0-9-]+):\s*(.+)$/);
    if (!cur || !m) { bad.push(raw); continue; }
    cur.headers.push([m[1], m[2]]);
  }
  return { rules, bad };
}
function ruleMatches(url, host, p) {
  let h = null, pathPart = url;
  if (/^[a-z]+:\/\//i.test(url)) {
    const m = url.match(/^https:\/\/([^/]+)(\/.*)$/); if (!m || /:\d+$/.test(m[1])) return false;   // absolute URLs must start with https, no port
    h = m[1]; pathPart = m[2];
  }
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (h !== null) {
    const hr = new RegExp('^' + h.split(/(:[A-Za-z]\w*|\*)/).map((t) => (/^:[A-Za-z]/.test(t) ? '[^.]+' : t === '*' ? '.*' : esc(t))).join('') + '$', 'i');
    if (!hr.test(host)) return false;
  }
  const pr = new RegExp('^' + pathPart.split(/(:[A-Za-z]\w*|\*)/).map((t) => (/^:[A-Za-z]/.test(t) ? '[^/]+' : t === '*' ? '.*' : esc(t))).join('') + '$');
  return pr.test(p);
}
const headersFor = (rules, host, p) => rules.filter((r) => ruleMatches(r.url, host, p)).flatMap((r) => r.headers);

function suite(I, quiet = false) {
  let F = 0; const failed = [];
  const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + String(x).slice(0, 300) + ']' : '')); if (!c) { F++; failed.push(l); } };
  /* N1 */
  const { rules, bad } = I.headers === null ? { rules: [], bad: ['(no file)'] } : parseHeaders(I.headers);
  ck('N1 public/_headers: one rule, for workers.dev hosts only, one header "X-Robots-Tag: noindex"',
    rules.length === 1 && rules[0].url === 'https://:version.:subdomain.workers.dev/*' && rules[0].headers.length === 1 && rules[0].headers[0][0] === 'X-Robots-Tag' && rules[0].headers[0][1] === 'noindex', JSON.stringify(rules));
  ck('N1 Cloudflare\'s format and limits: every non-comment line parses; at most 100 rules; no line over 2,000 characters', bad.length === 0 && rules.length <= 100 && String(I.headers || '').split('\n').every((l) => l.length <= 2000), bad.join(' | '));
  ck('N1 the old address is not written out in the file (anonymity: the rule names no account)', I.headers !== null && !/jeromevt72|flux-sparta-3/.test(I.headers));
  /* N2 */
  const missing = [];
  for (const h of HOSTS_OLD) for (const p of PATHS) if (!headersFor(rules, h, p).some(([n, v]) => n.toLowerCase() === 'x-robots-tag' && /\bnoindex\b/.test(v))) missing.push(h.split('.')[0] + p);
  ck('N2 every page (' + PATHS.length + ' addresses, e.g. / and /play/) on the old workers.dev address and on a version preview of it: X-Robots-Tag: noindex', missing.length === 0 && PATHS.includes('/') && PATHS.includes('/play/'), missing.slice(0, 6).join(', '));
  const extra = [];
  for (const h of HOSTS_NEW) for (const p of PATHS.concat(['/api/leaderboard', '/.well-known/assetlinks.json', '/sitemap.xml'])) if (headersFor(rules, h, p).length) extra.push(h + p);
  ck('N2 on fluxsparta.com and www.fluxsparta.com: no extra header on any page (or anything else)', extra.length === 0, extra.slice(0, 6).join(', '));
  ck('N2 (matcher sanity) the rule ignores protocol and port, and a host placeholder never spans a dot', ruleMatches('https://:version.:subdomain.workers.dev/*', OLD_HOST, '/play/') && !ruleMatches('https://:version.:subdomain.workers.dev/*', 'a.b.c.workers.dev', '/') && !ruleMatches('https://:version.:subdomain.workers.dev/*', 'fluxsparta.com', '/'));
  /* N3 */
  ck('N3 the Worker never sets X-Robots-Tag (API, purchases, the pilot move and the Play app\'s asset links unchanged)', !/x-robots-tag/i.test(I.worker));
  const rwf = (s) => ((s || '').match(/"run_worker_first":\s*\[([^\]]*)\]/) || [])[1];
  ck('N3 pages stay on the asset layer: run_worker_first is only /api/* and /.well-known/assetlinks.json, unchanged', /^\s*"\/api\/\*",\s*"\/\.well-known\/assetlinks\.json"\s*$/.test(rwf(I.wrangler) || '') && (MAIN.wrangler === null || rwf(MAIN.wrangler) === rwf(I.wrangler)), rwf(I.wrangler));
  const metaNow = PAGES.filter((p) => /<meta name="robots"/i.test(I.pages[p])), metaMain = PAGES.filter((p) => MAIN.pages[p] !== null && /<meta name="robots"/i.test(MAIN.pages[p]));
  ck('N3 no page got a <meta name="robots"> (it would reach fluxsparta.com too); only the ones main already had (admin)', JSON.stringify(metaNow) === JSON.stringify(metaMain), metaNow.join(','));
  const changed = (git(['diff', '--name-only', 'origin/main', '--', 'public']) || '').trim().split('\n').filter(Boolean);
  const added = (git(['ls-files', '--others', '--exclude-standard', '--', 'public']) || '').trim().split('\n').filter(Boolean);
  if (I === IN) ck('N3 only public/_headers is new or changed in public/', JSON.stringify(changed.concat(added).filter((f) => f !== 'public/_headers')) === '[]', changed.concat(added).join(','));
  /* N4 */
  ck('N4 robots.txt does not block the old address (Google must read the noindex): the site stays allowed, no workers.dev rule, unchanged',
    /^Allow: \/$/m.test(I.robots) && !/^Disallow: \/\s*$/m.test(I.robots) && !/workers\.dev/.test(I.robots) && (MAIN.robots === null || I.robots === MAIN.robots));
  const locs = [...I.sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ck('N4 sitemap.xml lists only fluxsparta.com addresses', locs.length > 0 && locs.every((u) => /^https:\/\/fluxsparta\.com\//.test(u)), locs.join(' '));
  const canon = (h) => (String(h || '').match(/<link rel="canonical"[^>]*>/g) || []).join('|');
  const canonBad = PAGES.filter((p) => MAIN.pages[p] !== null && canon(I.pages[p]) !== canon(MAIN.pages[p]));
  ck('N4 the canonical links are unchanged (Gateway -> https://fluxsparta.com/, game -> https://fluxsparta.com/play/)', canonBad.length === 0 && canon(I.pages['/index.html']).split('|')[0] === '<link rel="canonical" href="https://fluxsparta.com/">' && canon(I.pages['/play/index.html']).split('|')[0] === '<link rel="canonical" href="https://fluxsparta.com/play/">', canonBad.join(','));
  return { F, failed };
}

const main = suite(IN);
console.log('\n== negative controls: each defect MUST be caught ==');
let NC = 0;
function control(label, expect, edit) {
  const I2 = edit(structuredClone(IN));
  const r = suite(I2, true); const hit = r.failed.filter((f) => f.startsWith(expect)); const ok = hit.length > 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'caught: ' + label + '  [' + (ok ? hit[0] : 'expected ' + expect + '; failed: ' + (r.failed.join(' | ') || 'none')) + ']'); if (!ok) NC++;
}
const H = (fn) => (I) => { I.headers = fn(I.headers); return I; };
control('no _headers file', 'N2 every page', (I) => { I.headers = null; return I; });
control('the rule applies everywhere (a path-only rule)', 'N2 on fluxsparta.com', H((s) => s.replace('https://:version.:subdomain.workers.dev/*', '/*')));
control('a host pattern loose enough to catch www.fluxsparta.com', 'N2 on fluxsparta.com', H((s) => s.replace('https://:version.:subdomain.workers.dev/*', 'https://:a.:b.:c/*')));
control('a rule for fluxsparta.com too', 'N2 on fluxsparta.com', H((s) => s + 'https://fluxsparta.com/*\n  X-Robots-Tag: noindex\n'));
control('only the Gateway page covered', 'N2 every page', H((s) => s.replace('workers.dev/*', 'workers.dev/')));
control('the header misspelled', 'N2 every page', H((s) => s.replace('X-Robots-Tag: noindex', 'X-Robot-Tag: noindex')));
control('a value other than noindex', 'N2 every page', H((s) => s.replace('X-Robots-Tag: noindex', 'X-Robots-Tag: index')));
control('the old address written out', 'N1 the old address', H((s) => s.replace('https://:version.:subdomain.workers.dev/*', 'https://' + OLD_HOST + '/*')));
control('a header line not indented (Cloudflare would read it as a URL)', 'N1 public/_headers', H((s) => s.replace('  X-Robots-Tag: noindex', 'X-Robots-Tag: noindex')));
control('the Worker adds the header (pages through the Worker)', 'N3 the Worker', (I) => { I.worker = I.worker.replace('function json(', 'const XRT = "X-Robots-Tag";\nfunction json('); return I; });
control('every path runs the Worker', 'N3 pages stay', (I) => { I.wrangler = I.wrangler.replace('"/.well-known/assetlinks.json"', '"/.well-known/assetlinks.json", "/*"'); return I; });
control('a meta noindex on the Gateway (fluxsparta.com too)', 'N3 no page got', (I) => { I.pages['/index.html'] = I.pages['/index.html'].replace('<link rel="canonical"', '<meta name="robots" content="noindex"><link rel="canonical"'); return I; });
control('robots.txt blocks the site', 'N4 robots.txt', (I) => { I.robots = I.robots.replace('Allow: /', 'Disallow: /'); return I; });
control('sitemap lists the old address', 'N4 sitemap', (I) => { I.sitemap = I.sitemap.replace('https://fluxsparta.com/play/', 'https://' + OLD_HOST + '/play/'); return I; });
control('Gateway canonical changed', 'N4 the canonical', (I) => { I.pages['/index.html'] = I.pages['/index.html'].replace('<link rel="canonical" href="https://fluxsparta.com/">', '<link rel="canonical" href="https://' + OLD_HOST + '/">'); return I; });
const total = main.F + NC;
console.log('\n' + (total ? 'NOINDEX OLD ADDRESS FAILED: ' + main.F + ' check(s), ' + NC + ' uncaught control(s)' : 'NOINDEX OLD ADDRESS PASSED: all checks and all negative controls'));
process.exit(total ? 1 : 0);
