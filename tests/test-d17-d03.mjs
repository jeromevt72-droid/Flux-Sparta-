// D-17 (standalone greeting) and D-03 (legal pages). Static checks only —
// D-17 cannot be closed without a real-device A/B test.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GW = path.join(__dirname,'FLUX-Sparta','public');
const g = fs.readFileSync(path.join(GW,'index.html'),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

console.log('-- D-17: the greeting still exists and still rotates --');
ck('greeting element present', g.includes('id="welcomeRotator"'));
ck('rotation interval intact', /setInterval\(\(\)=>\{\s*welcomeEl\.style\.opacity = 0/.test(g));
const langs=['Welcome','Kumusta','欢迎','Willkommen','Bem-vindo','ようこそ','Bienvenido',"G\\'day",'Bonjour'];
ck('all 9 languages retained', langs.every(l=>g.includes(l)), String(langs.filter(l=>g.includes(l)).length));
ck('not hidden with display:none', !/\.welcomeRotator\{[^}]*display:\s*none/.test(g));
ck('not hidden with visibility', !/\.welcomeRotator\{[^}]*visibility:\s*hidden/.test(g));
ck('not zeroed opacity in CSS', !/\.welcomeRotator\{[^}]*opacity:\s*0[;}]/.test(g));
ck('not shrunk to hide clipping', !/html\.is-standalone \.welcomeRotator\{[^}]*font-size/.test(g));

console.log('\n-- D-17: Safari baseline preserved --');
ck('base rule byte-identical to RC2.3',
   g.includes('.welcomeRotator{position:absolute;top:max(78px,calc(env(safe-area-inset-top) + 68px));left:0;right:0;z-index:6;text-align:center;font-size:13px'));
ck('correction is scoped to standalone only', (g.match(/html\.is-standalone \.welcomeRotator\{/g)||[]).length===2,
   String((g.match(/html\.is-standalone \.welcomeRotator\{/g)||[]).length));
const unscoped = (g.match(/(^|[^ ])\.welcomeRotator\{/gm)||[]).filter(x=>!x.startsWith('e'));
ck('only the 2 pre-existing unscoped rules remain',
   (g.match(/(?<!is-standalone )\.welcomeRotator\{/g)||[]).length===2,
   String((g.match(/(?<!is-standalone )\.welcomeRotator\{/g)||[]).length));

console.log('\n-- D-17: the standalone flag --');
ck('flag set before first paint (in head)', g.indexOf("classList.add('is-standalone')") < g.indexOf('</head>'));
ck('covers iOS navigator.standalone', /navigator\.standalone === true/.test(g.slice(0,g.indexOf('</head>'))));
ck('covers display-mode media query', /display-mode: standalone/.test(g.slice(0,g.indexOf('</head>'))));
ck('wrapped in try/catch', /try\{[\s\S]{0,300}is-standalone[\s\S]{0,60}\}catch/.test(g));

console.log('\n-- D-17: unrelated hero elements untouched --');
const rc23 = fs.existsSync(path.join(__dirname,'..','rc23')) ? null : null;
for(const sel of ['.hero{height:100svh','.heroCTA{position:absolute','.logo{font-size:clamp(78px','.eyebrow{font-size:12px'])
  ck('unchanged: '+sel, g.includes(sel));
ck('install-prompt detector unchanged',
   g.includes("return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;"));

console.log('\n-- D-03: legal pages exist and are wired --');
ck('privacy.html exists', fs.existsSync(path.join(GW,'privacy.html')));
ck('terms.html exists', fs.existsSync(path.join(GW,'terms.html')));
ck('Privacy link points to the page', g.includes('href="./privacy.html">Privacy Policy</a>'));
ck('Terms link points to the page', g.includes('href="./terms.html">Terms</a>'));
ck('no legal link left as #', !/href="#">(Privacy|Terms)/.test(g));

const pv = fs.readFileSync(path.join(GW,'privacy.html'),'utf8');
const tm = fs.readFileSync(path.join(GW,'terms.html'),'utf8');
console.log('\n-- D-03: pages are navigable and honest --');
for(const [n,d] of [['privacy',pv],['terms',tm]]){
  ck(n+': has back link to Gateway', d.includes('href="./index.html"'));
  ck(n+': mobile viewport + safe area', d.includes('viewport-fit=cover') && d.includes('env(safe-area-inset'));
  ck(n+': no third-party dependency', !/<script src=|<link[^>]*href="http/.test(d));
  // D-03 RESOLVED: the owner filled every input. No placeholder may ship.
  ck(n+': no owner placeholder left', !d.includes('OWNER INPUT'));
}
console.log('\n-- D-03: no unsupported claims --');
for(const bad of ['100% secure','completely anonymous','we collect no information','GDPR compliant','COPPA compliant','fully compliant'])
  ck('does not claim "'+bad+'"', !pv.toLowerCase().includes(bad.toLowerCase()) || pv.includes('do not claim'));
ck('states FLUX never receives card numbers', pv.includes('never receives your card number'));
ck('states leaderboard is public', pv.includes('public'));
ck('states no IP stored', pv.includes('do not store your IP address'));
ck('states no analytics/cookies', /no analytics,[\s\S]{0,80}no\s*\ncookies|no analytics[\s\S]{0,80}cookies/.test(pv));

console.log('\n'+'='.repeat(50));
console.log(F? '  '+F+' FAILED' : '  ALL D-17 / D-03 TESTS PASSED');
console.log('='.repeat(50));
process.exit(F?1:0);
