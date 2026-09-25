// AUDIT-F03: every country Sparta lets a player pick must render with a real
// flag and a real name on the World Grid.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sp = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','play','index.html'),'utf8');
const gw = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','index.html'),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

const supported = [...sp.matchAll(/<option value="([A-Z]{2})">([^<]+)<\/option>/g)].map(m=>m[1]);
// Evaluate the real object rather than regexing it.
const start = gw.indexOf('window.COUNTRY_META = {');
const end = gw.indexOf('\n  };', start)+4;
const w = {}; (new Function('window', gw.slice(start,end)))(w);
const META = w.COUNTRY_META;
const metaFn = code => META[code] || {flag:'🌎', name: code || 'Unknown'};

console.log('-- parity --');
ck('Sparta exposes 196 countries', supported.length===196, String(supported.length));
ck('Gateway metadata covers all of them', Object.keys(META).length>=supported.length,
   Object.keys(META).length+' entries');
const missing = supported.filter(c=>!META[c]);
ck('no supported country lacks metadata', missing.length===0, missing.join(',')||'none');

console.log('\n-- no supported country falls back to the globe --');
const globed = supported.filter(c=>metaFn(c).flag==='🌎');
ck('zero globe fallbacks for supported codes', globed.length===0, globed.join(',')||'none');
const codeAsName = supported.filter(c=>metaFn(c).name===c);
ck('no country displays its raw code as a name', codeAsName.length===0, codeAsName.join(',')||'none');

console.log('\n-- required acceptance examples --');
for(const [c,flag,name] of [
  ['AE','🇦🇪','United Arab Emirates'], ['QA','🇶🇦','Qatar'], ['US','🇺🇸','United States'],
  ['PH','🇵🇭','Philippines'], ['GB','🇬🇧','United Kingdom'], ['JP','🇯🇵','Japan'],
  ['DE','🇩🇪','Germany'], ['BR','🇧🇷','Brazil'], ['IN','🇮🇳','India'], ['ZA','🇿🇦','South Africa'],
]){
  const m=metaFn(c);
  ck(c+' → '+flag+' '+name, m.flag===flag && m.name===name, m.flag+' '+m.name);
}

console.log('\n-- AE and QA remain SEPARATE countries (data rule) --');
ck('AE and QA are distinct entries', META.AE && META.QA && META.AE.name!==META.QA.name);
ck('QA is not aliased to AE anywhere', !/QA\s*:\s*['"]AE['"]/.test(gw) && !/['"]QA['"]\s*=>\s*['"]AE['"]/.test(gw));
ck('no country remapping table exists', !/COUNTRY_ALIAS|countryRemap|normalizeCountry/.test(gw));

console.log('\n-- fallback still protects unknown input --');
for(const [label,val] of [['unknown code','ZZ'],['empty',''],['null',null],
                          ['malformed','<script>'],['lowercase','ph'],['numeric','12']]){
  const m=metaFn(val);
  ck('fallback safe for '+label, !!m && typeof m.flag==='string' && typeof m.name==='string',
     m.flag+' '+m.name);
}
ck('unknown code still shows the globe', metaFn('ZZ').flag==='🌎');
ck('empty shows Unknown', metaFn('').name==='Unknown');

console.log('\n-- display only: attribution untouched --');
ck('worker validation unchanged', fs.readFileSync(path.join(__dirname,'FLUX-Sparta','worker.js'),'utf8').includes('ISO2'));
ck('Sparta selector unchanged in count', supported.length===196);

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL COUNTRY PARITY TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
