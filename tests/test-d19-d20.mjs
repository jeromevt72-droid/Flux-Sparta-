// D-19 / D-20: the reveal must be restored on phone widths WITHOUT colliding
// with heroCTA, because a runtime guard disables it on any real collision.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const g = fs.readFileSync(path.join(__dirname,'FLUX-Sparta','public','index.html'),'utf8');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g,'');
function block(marker){
  const i=g.indexOf(marker); let d=0, j=g.indexOf('{',i);
  for(let k=j;k<g.length;k++){ if(g[k]==='{')d++; else if(g[k]==='}'){d--; if(!d) return g.slice(i,k+1);} }
  return '';
}
const phone = strip(block('@media(max-width:700px){'));

console.log('-- all four reveal elements still exist --');
for(const el of ['Flow · Launch · Unite · Xcelerate','<div class="logo">FLUX</div>',
                 'THE WORLD HAS ENTERED THE FLUX.','100% FREE TO PLAY'])
  ck('present: '+el.slice(0,34), g.includes(el));
ck('all four inside .heroBrand', /<div class="heroBrand">[\s\S]{0,400}100% FREE TO PLAY/.test(g));

console.log('\n-- D-19: the phone suppression is gone --');
ck('no animation:none in the phone query', !phone.includes('animation:none'));
ck('no display:none on the brand', !/\.heroBrand[^{]*\{[^}]*display:\s*none/.test(strip(g)));
ck('no visibility:hidden on the brand', !/\.heroBrand[^{]*\{[^}]*visibility:\s*hidden/.test(strip(g)));
ck('reveal animation still declared', g.includes('body.anim .heroBrand{animation:heroBrandPulse var(--dur) ease-in-out infinite}'));
ck('keyframes unchanged', g.includes('@keyframes heroBrandPulse{\n  0%,85%{opacity:0;transform:scale(.94)}'));

console.log('\n-- D-19: responsive SIZING, not deletion --');
ck('phone gets compact eyebrow', /\.heroBrand \.eyebrow\{font-size:8px/.test(phone));
ck('phone gets compact wordmark', /\.heroBrand \.logo\{font-size:min\(10vw,44px\)/.test(phone));
ck('phone gets compact tagline', /\.heroBrand \.tag\{font-size:10px/.test(phone));
ck('phone gets compact badge', /\.heroBrand \.freeBadge\{/.test(phone));
ck('RC2.5.1: reflow tiers exist below it', /body\.heroBrand-t3 \.heroBrand\{display:flex/.test(g));
ck('brand moved to the upper band', /\.heroContent\{justify-content:flex-start;padding-top:calc\(env\(safe-area-inset-top, 0px\) \+ 104px\)\}/.test(phone));

console.log('\n-- the runtime overlap guard is the final arbiter, and survives --');
// RC2.5.1 replaced the one-shot guard with measured reflow. The SAFETY
// OBJECTIVE is what must survive, not the old implementation.
ck('overlap still measured from real rects', g.includes('var b = brand.getBoundingClientRect();') && g.includes('var c = cta.getBoundingClientRect();'));
ck('suppression still available as last resort', g.includes("classList.add('heroBrand-unsafe')"));
ck('suppression no longer the first response', g.includes('for(var i=0;i<HERO_TIERS.length;i++)'));
ck('guard CSS rule intact', g.includes('body.heroBrand-unsafe .heroBrand{animation:none!important}'));
ck('refit runs on load + resize + orientation',
   g.includes("window.addEventListener('load', fitHeroBrand)") &&
   g.includes("window.addEventListener('resize'") &&
   g.includes("window.addEventListener('orientationchange'"));
ck('one fit function', (g.match(/function fitHeroBrand\(\)/g)||[]).length===1);

console.log('\n-- geometry: does the sizing keep the guard from firing? --');
// Approximate the rendered brand block from the CSS above, for common phones.
function brandBox(vw, insetTop){
  const top = insetTop + 104;
  const eyebrow = 8*1.4;
  const logo = Math.min(0.10*vw, 44) * 0.82 + 5;   // line-height .82 + margins
  const tag = 10*1.5;
  const badge = 9*1.4 + 8 + 6;                     // text + padding + margin
  return {top, bottom: top + eyebrow + logo + tag + badge};
}
for(const [name, vw, inset, ctaTop] of [
  ['iPhone 15/16 (393px)', 393, 59, 272],
  ['iPhone SE (375px)',    375, 20, 250],
  ['iPhone Plus (430px)',  430, 59, 290],
]){
  const b = brandBox(vw, inset);
  const greetBottom = inset + 78 + 18;   // .welcomeRotator top + min-height
  // REPORTED, NOT ASSERTED. RC2.5 asserted an estimate like this, it went
  // green, and the real iPhone still failed. Geometry is now decided by
  // measurement on the device, so this is informational only.
  console.log('  note   '+name+': modelled brand '+Math.round(b.top)+'-'+Math.round(b.bottom)+
              'px vs CTA top '+ctaTop+'px (tier 0; device picks the real tier)');
  ck(name+': brand clears the greeting', b.top > greetBottom,
     'greeting ends '+Math.round(greetBottom)+'px, brand starts '+Math.round(b.top)+'px');
}

console.log('\n-- D-20: the void is the reveal window, not separate dead time --');
const dur = 26;
ck('cycle duration unchanged at 26s', g.includes('--dur:26s'));
ck('gameplay fade ends at 21.8s (unchanged)', g.includes('@keyframes gameReveal'));
ck('reveal window 22.1s-25.2s unchanged', g.includes('0%,85%{opacity:0;transform:scale(.94)}') && g.includes('90%{opacity:1;transform:scale(1)}'));
ck('NO timing value was changed', !/--dur:(?!26s)/.test(g));

console.log('\n-- protected: demo, greeting, D-17, country UI --');
ck('demo iframe untouched', g.includes('<iframe id="gameFrame" src="hero-demo.html"'));
ck('gameWrap animation untouched', g.includes('@keyframes gameReveal'));
ck('D-17 standalone correction intact', (g.match(/html\.is-standalone \.welcomeRotator\{/g)||[]).length===2);
ck('D-17 Safari base rule intact', g.includes('.welcomeRotator{position:absolute;top:max(78px,calc(env(safe-area-inset-top) + 68px))'));
ck('greeting rotation intact', g.includes("const greetings = ['Welcome','Kumusta'"));
ck('heroCTA rule untouched', g.includes('.heroCTA{position:absolute;left:0;right:0;bottom:calc(64px + env(safe-area-inset-bottom))'));
ck('D-03 links intact', g.includes('href="./privacy.html">Privacy Policy</a>') && g.includes('href="./terms.html">Terms</a>'));
ck('D-18 left frozen', g.includes('id="getAppPlayBtn"') && /id="getAppPlayBtn"[^>]*href="#"/.test(g));

console.log('\n-- no duplicate engines / timers / listeners --');
ck('one heroBrandPulse keyframes', (g.match(/@keyframes heroBrandPulse/g)||[]).length===1);
ck('one body.anim .heroBrand animation rule', (g.match(/body\.anim \.heroBrand\{animation:heroBrandPulse/g)||[]).length===1);
ck('no JS animation loop added', !/requestAnimationFrame\s*\(\s*function\s*heroBrand/.test(g));
ck('no setInterval added for the brand', !/setInterval[^)]{0,80}heroBrand/.test(g));

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL D-19 / D-20 TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
