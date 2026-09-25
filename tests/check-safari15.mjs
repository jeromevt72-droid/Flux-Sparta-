// RC2.8.7: Safari 15 compatibility check. Every inline <script> in the shipped pages, plus sw.js:
// esbuild output for --target=safari15 must be byte-identical to --target=esnext (nothing had to
// be rewritten for Safari 15). Needs esbuild via npx, so it is not in the gate.
// Run from tests/:  node check-safari15.mjs
import fs from 'fs'; import { execFileSync } from 'child_process';
const P = (f) => new URL('./FLUX-Sparta/' + f, import.meta.url).pathname;
const files = process.argv.length > 2 ? process.argv.slice(2) : ['public/play/index.html','public/index.html','public/admin.html','public/sw.js','public/welcome/index.html','public/hero-demo.html'].map(P); let bad = 0, n = 0;
const esb = (code, target, loader='js') => execFileSync('npx', ['-y','esbuild','--loader='+loader,'--target='+target], { input: code, encoding: 'utf8' });
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const parts = f.endsWith('.html') ? [...src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!/type=["']?application\/ld\+json/.test(m[1]) && !/\bsrc=/.test(m[1])).map(m=>m[2]) : [src];
  parts.forEach((code, i) => { n++;
    try { const a = esb(code,'safari15'), b = esb(code,'esnext');
      if (a !== b) { bad++; console.log('DIFFERS', f, '#'+i); } }
    catch (e) { bad++; console.log('ERROR', f, '#'+i, String(e.stderr||e).slice(0,400)); } });
}
console.log(bad ? `SAFARI15 FAILED: ${bad} of ${n}` : `SAFARI15 OK: ${n} scripts identical for safari15 and esnext`);
process.exit(bad?1:0);
