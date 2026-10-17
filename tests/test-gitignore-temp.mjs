// GITIGNORE: temporary files the tests write into tests/ (".nc-…mjs", ".fp-…mjs", ".twa-worker-…mjs"…)
// can never be committed by mistake, and no real test file is ignored. In the release gate.
//   G1 a sample of every temporary name the tests use is ignored by git;
//   G2 every test file in tests/ (test-*.mjs, the harness, run-all-tests.mjs …) is NOT ignored;
//   G3 no ignored temporary file is tracked in the repo.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let F = 0; const ck = (l, c, x = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) F++; };
const git = (args) => { try { return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || null; } };
if (git(['rev-parse', '--is-inside-work-tree']) === null) { console.log('  PASS  git not available here: nothing to check'); console.log('\nGITIGNORE PASSED'); process.exit(0); }
const ignored = (names) => (git(['check-ignore', '--no-index', ...names]) || '').split('\n').filter(Boolean);
// G1: every temporary prefix the tests use (taken from the tests themselves), plus the known fixed ones
const src = fs.readdirSync(__dirname).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const prefixes = [...new Set([...src.matchAll(/join\([^,]+,\s*'(\.[a-z0-9]+(?:-[a-z0-9]+)*-?)'/gi)].map((m) => m[1]))].filter((p) => p.length > 2);
const samples = [...new Set(prefixes.concat(['.nc-wg-', '.twa-worker-', '.day1-worker-', '.fp-main-'])).values()].map((p) => p + 'abc123.mjs');
const ig = new Set(ignored(samples));
const missed = samples.filter((s) => !ig.has(s));
ck('G1 every temporary test file name is ignored (' + samples.length + ' patterns)', missed.length === 0 && samples.length >= 10, missed.join(','));
// G2: real files stay tracked/trackable
const real = fs.readdirSync(__dirname).filter((f) => !f.startsWith('.') && /\.(mjs|py|txt|md)$/.test(f));
const wrongly = ignored(real);
ck('G2 no real test file is ignored (' + real.length + ' files)', wrongly.length === 0 && real.length > 50, wrongly.join(','));
// G3: nothing temporary is committed
const tracked = (git(['ls-files', '.']) || '').split('\n').filter((f) => /(^|\/)\.[^/]*\.mjs$/.test(f));
ck('G3 no temporary .*.mjs file is tracked', tracked.length === 0, tracked.join(','));
console.log('\n' + (F ? 'GITIGNORE FAILED' : 'GITIGNORE PASSED'));
process.exit(F ? 1 : 0);
