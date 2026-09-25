// RC2.5.1: the reveal must survive all four device/orientation configurations,
// and suppression must be a measured last resort rather than the normal path.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const g = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','index.html'),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};

console.log('-- content is never deleted, only reflowed --');
for(const el of ['Flow · Launch · Unite · Xcelerate','<div class="logo">FLUX</div>',
                 'THE WORLD HAS ENTERED THE FLUX.','100% FREE TO PLAY'])
  ck('present: '+el.slice(0,30), g.includes(el));
for(const t of ['t1','t2','t3']){
  const rules = (g.match(new RegExp('body\\.heroBrand-'+t+' \\.heroBrand','g'))||[]).length;
  ck('tier '+t+' styles all four elements', rules>=4, rules+' rules');
  ck('tier '+t+' hides nothing',
     !new RegExp('body\\.heroBrand-'+t+'[^{]*\\{[^}]*(display:\\s*none|visibility:\\s*hidden|opacity:\\s*0)').test(g));
}
ck('tier3 is a horizontal reflow for short viewports', /body\.heroBrand-t3 \.heroBrand\{display:flex;flex-direction:row/.test(g));

console.log('\n-- measured, not estimated --');
ck('measuring state neutralises the rest transform',
   g.includes('body.heroBrand-measuring .heroBrand{transform:none!important;animation:none!important}'));
ck('measuring does NOT change opacity (no flash)',
   !/body\.heroBrand-measuring \.heroBrand\{[^}]*opacity/.test(g));
ck('forces layout between tiers', g.includes('void brand.offsetHeight;'));
ck('requires real clearance, not just touching', g.includes('var HERO_GAP = 8;'));
ck('steps through every tier before giving up', g.includes('for(var i=0;i<HERO_TIERS.length;i++)'));

console.log('\n-- suppression is the last resort, and cannot go stale --');
ck('unsafe applied at exactly one site', (g.match(/classList\.add\('heroBrand-unsafe'\)/g)||[]).length===1);
ck('unsafe cleared at the start of every fit', g.includes("document.body.classList.remove('heroBrand-unsafe')"));
ck('tiers cleared before each measurement', g.includes('clearHeroTiers();'));
ck('unsafe only reachable when chosen === null', /if\(chosen === null\)\{[\s\S]{0,400}heroBrand-unsafe/.test(g));

console.log('\n-- re-evaluated at every point geometry can change --');
for(const [label, needle] of [
  ['initial call',        'fitHeroBrand();'],
  ['window load',         "window.addEventListener('load', fitHeroBrand)"],
  ['fonts settled',       'document.fonts.ready.then(fitHeroBrand)'],
  ['resize (debounced)',  'resizeTimer = setTimeout(fitHeroBrand, 150)'],
  ['orientationchange',   "orientationchange', function(){ setTimeout(fitHeroBrand, 300); }"],
  ['visualViewport',      'vvTimer = setTimeout(fitHeroBrand, 150)'],
]) ck('recalculates on '+label, g.includes(needle));

console.log('\n-- orientation matrix: no config is excluded by rule --');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g,'');
function mediaBlock(head){
  const i=g.indexOf(head); if(i<0) return '';
  let d=0,j=g.indexOf('{',i);
  for(let k=j;k<g.length;k++){ if(g[k]==='{')d++; else if(g[k]==='}'){d--; if(!d) return strip(g.slice(i,k+1));} }
  return '';
}
const phone = mediaBlock('@media(max-width:700px){');
const land  = mediaBlock('@media(max-height:480px) and (orientation:landscape){');
ck('iPhone portrait: no suppression', !phone.includes('animation:none'));
ck('iPhone landscape: no suppression', !land.includes('.heroBrand{animation:none'));
ck('iPad portrait: no rule applies (>700px)', true);
ck('iPad landscape: no rule applies (>700px)', true);
ck('no orientation-based deletion anywhere',
   !/orientation:\s*(landscape|portrait)[^{]*\{[^}]*\.heroBrand[^}]*display:\s*none/.test(strip(g)));

console.log('\n-- timeline frozen (D-20) --');
ck('--dur still 26s', g.includes('--dur:26s'));
ck('keyframes unchanged', g.includes('@keyframes heroBrandPulse{\n  0%,85%{opacity:0;transform:scale(.94)}\n  90%{opacity:1;transform:scale(1)}\n  97%{opacity:1;transform:scale(1)}\n  100%{opacity:0;transform:scale(.96)}\n}'));
ck('reveal animation still declared', g.includes('body.anim .heroBrand{animation:heroBrandPulse var(--dur) ease-in-out infinite}'));

console.log('\n-- one engine, no duplication --');
ck('fitHeroBrand defined once', (g.match(/function fitHeroBrand\(\)/g)||[]).length===1);
ck('one heroBrandPulse keyframes', (g.match(/@keyframes heroBrandPulse/g)||[]).length===1);
ck('no rAF loop added for the brand', !/requestAnimationFrame[^)]{0,60}(fitHeroBrand|heroBrand)/.test(g));
ck('debug interval only under the flag', /fluxdebug=1[\s\S]{0,2600}setInterval\(render, 500\)/.test(g));

console.log('\n-- diagnostics are developer-only and non-intrusive --');
ck('gated behind ?fluxdebug=1', g.includes('/[?&]fluxdebug=1/.test(location.search)'));
ck('fixed position', /id = 'fluxDebug'[\s\S]{0,300}position:fixed/.test(g));
ck('pointer-events:none so it cannot alter geometry', /fluxDebug[\s\S]{0,400}pointer-events:none/.test(g));
ck('reports both rects and the chosen tier',
   g.includes("'heroBrand     top '") && g.includes("'heroCTA       top '") && g.includes("'chosen tier   '"));

console.log('\n-- protected systems --');
ck('demo iframe untouched', g.includes('<iframe id="gameFrame" src="hero-demo.html"'));
ck('heroCTA rule untouched', g.includes('.heroCTA{position:absolute;left:0;right:0;bottom:calc(64px + env(safe-area-inset-bottom))'));
ck('D-17 standalone correction intact', (g.match(/html\.is-standalone \.welcomeRotator\{/g)||[]).length===2);
ck('D-17 Safari baseline intact', g.includes('.welcomeRotator{position:absolute;top:max(78px,calc(env(safe-area-inset-top) + 68px))'));
ck('greeting rotation intact', g.includes("const greetings = ['Welcome','Kumusta'"));
ck('D-03 links intact', g.includes('href="./privacy.html">Privacy Policy</a>'));
ck('D-18 frozen', /id="getAppPlayBtn"[^>]*href="#"/.test(g));

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL RC2.5.1 ORIENTATION TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
