// FIRST INSTALL: the game page must not reload itself when the service worker first takes control.
// Before: on a first visit the worker's clients.claim() fired 'controllerchange' and the game reloaded --
// the game page was downloaded again and a run started in the first seconds was wiped (worst on slow
// connections, where the Gateway leaves registering the worker to the game). A real update (an older
// worker in control) still reloads once, exactly as before. Runs the game's real handler.
// (Chromium check, not in the gate: test-first-install-reload-browser.mjs.)
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'FLUX-Sparta');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'play', 'index.html'), 'utf8');
function suite(game, quiet) {
  let F = 0; const ck = (l, c, x = '') => { if (!quiet) console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x !== '' ? '  [' + x + ']' : '')); if (!c) F++; };
  const a = game.indexOf('var reloading=false;'), b = game.indexOf('location.reload();', a);
  if (a < 0 || b < 0) { ck('handler found', false); return F; }
  const body = game.slice(a, b + 'location.reload();'.length) + '\n});';
  const run = (controller) => {
    let h = null, reloads = 0;
    const ctx = { navigator: { serviceWorker: { controller, addEventListener: (t, f) => { if (t === 'controllerchange') h = f; } } }, location: { reload: () => reloads++ } };
    vm.createContext(ctx); vm.runInContext(body, ctx);
    return { fire: () => { h && h(); return reloads; } };
  };
  try {
    const first = run(null);
    ck('first visit: the worker taking control does not reload the page', first.fire() === 0);
    ck('first visit: a later real update still reloads, once', first.fire() === 1 && first.fire() === 1);
    const upd = run({});
    ck('update (an older worker was in control): reloads once, as before', upd.fire() === 1 && upd.fire() === 1);
  } catch (e) { ck('handler ran: ' + e.message, false); }
  ck('game listeners still 17', (game.match(/addEventListener\(/g) || []).length === 17, (game.match(/addEventListener\(/g) || []).length);
  ck('requestAnimationFrame(loop) still 2', (game.match(/requestAnimationFrame\(loop\)/g) || []).length === 2);
  return F;
}
console.log('== FIRST INSTALL: NO RELOAD ==');
const F = suite(SRC, false);
console.log('\n-- negative controls --');
let missed = 0;
for (const [name, m] of [
  ['first control reloads again (the old behaviour)', (s) => s.replace('if(!hadController){ hadController=true; return; }', '')],
  ['updates no longer reload', (s) => s.replace('if(reloading) return; reloading=true;', 'return;')],
]) {
  const g = m(SRC); if (g === SRC) { console.log('  FAIL  control did not apply: ' + name); missed++; continue; }
  const f = suite(g, true); console.log((f ? '  PASS  caught: ' : '  FAIL  missed: ') + name); if (!f) missed++;
}
const ok = !F && !missed;
console.log('\n' + (ok ? 'FIRST INSTALL PASSED: all checks and all negative controls' : 'FIRST INSTALL FAILED'));
process.exit(ok ? 0 : 1);
