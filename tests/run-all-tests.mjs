// RELEASE GATE (RC2.8.6; D-30). Runs every suite from THIS folder and exits
// nonzero if ANY suite fails -- by exit code, not by whether it finished.
// Usage:  node run-all-tests.mjs
import { spawnSync } from 'child_process';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
fs.copyFileSync(path.join(ROOT,'FLUX-Sparta','worker.js'), path.join(ROOT,'worker.mjs'));   // fuzz imports it
const SUITES = [
  ['python3','regression-suite.py'],
  ...['test-rc286.mjs','test-rc285.mjs','test-d38.mjs','test-d36-d37.mjs','test-d35-restore.mjs','test-rc281.mjs','test-rc28-worker.mjs','test-rc28-client.mjs','test-audit-fixes.mjs','test-one-app-runtime.mjs',
      'test-negative-controls.mjs','test-merge-one-identity.mjs','test-single-identity.mjs','test-checkout-navigation.mjs',
      'test-t9-entitlements.mjs','test-runtime-integration.mjs','test-country-parity.mjs','test-offline-runtime.mjs',
      'test-d19-orientation.mjs','test-d19-d20.mjs','test-d17-d03.mjs','test-d16-fluxid.mjs','test-sw.mjs',
      'test-audio-lifecycle.mjs','test-offline-queue.mjs','test-d09-bestrun.mjs','test-d01-d08-lifecycle.mjs',
      'test-worker.mjs','test-import.mjs','fuzz.mjs'].map(f=>['node',f]),
];
const only = process.argv.includes('--skip-negative-controls');   // used BY the negative controls themselves
const failed = [];
for (const [cmd, file] of SUITES) {
  if (only && file === 'test-negative-controls.mjs') continue;
  const r = spawnSync(cmd, [file], { cwd: ROOT, encoding:'utf8', timeout: 20*60*1000 });
  const ok = r.status === 0;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + file + (ok ? '' : '  (exit ' + r.status + (r.signal?', '+r.signal:'') + ')'));
  if (!ok) failed.push(file);
}
try { fs.unlinkSync(path.join(ROOT,'worker.mjs')); } catch (e) {}
const total = SUITES.length - (only ? 1 : 0);
console.log('\n' + '='.repeat(56));
if (failed.length) { console.log('  RELEASE GATE FAILED: ' + failed.length + ' of ' + total + ' suites failed'); failed.forEach(f=>console.log('   - '+f)); }
else console.log('  RELEASE GATE PASSED: all ' + total + ' suites passed');
console.log('='.repeat(56));
process.exit(failed.length ? 1 : 0);
