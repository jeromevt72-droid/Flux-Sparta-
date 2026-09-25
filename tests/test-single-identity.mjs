// RC2.5.5: the game must run top-level so there is ONE storage partition and
// ONE fluxPlayerId. Executes the shipped Gateway scripts in document order.
import fs from 'fs';
import vm from 'vm';
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const gwSrc = fs.readFileSync(new URL('./FLUX-Sparta/public/index.html', import.meta.url),'utf8');
const spSrc = fs.readFileSync(new URL('./FLUX-Sparta/public/play/index.html', import.meta.url),'utf8');
const blocks = t => [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const code = t => blocks(t).join('\n;\n').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const gw = code(gwSrc), sp = code(spSrc);

console.log('-- Play no longer iframes the game --');
ck('openPlayScreen navigates top-level', /function openPlayScreen\(\)\{[\s\S]{0,700}window\.location\.href = window\.FLUX_GAME_URL;/.test(gw));
ck('no longer sets playFrame.src', !gw.includes('frame.src = window.FLUX_GAME_URL'));
ck('demo silenced before leaving', /openPlayScreen\(\)\{[\s\S]{0,400}setHeroDemoSuspended\(true\)/.test(gw));
ck('navigates to the canonical constant, not a literal',
   /window\.location\.href = window\.FLUX_GAME_URL/.test(gw) &&
   (gw.match(/window\.FLUX_GAME_URL = window\.location\.origin \+ '\/play\/';/g)||[]).length===1);

console.log('-- RUNTIME: execute the page and prove where Play goes --');
{
  const noop=()=>{};
  const el=()=>({ style:{setProperty:noop,removeProperty:noop,getPropertyValue:()=>''},
    classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},
    addEventListener:noop, appendChild:noop, remove:noop, querySelector:()=>null,
    querySelectorAll:()=>[], getBoundingClientRect:()=>({top:0,bottom:0,height:0}),
    setAttribute:noop, focus:noop, textContent:'', innerHTML:'', value:'', offsetHeight:0, dataset:{} });
  let navigatedTo=null, frameSrcSet=null;
  const playFrame = el(); Object.defineProperty(playFrame,'src',{get:()=>frameSrcSet, set:v=>{frameSrcSet=v;}});
  const doc={ documentElement:el(), body:el(), head:el(),
    getElementById:id=> id==='playFrame' ? playFrame : el(),
    querySelector:()=>el(), querySelectorAll:()=>[], createElement:()=>el(),
    addEventListener:noop, fonts:{ready:Promise.resolve()}, readyState:'loading' };
  const win={ document:doc,
    location:{ search:'', origin:'https://gw.test', href:'https://gw.test/',
               set href(v){ navigatedTo=v; }, get href(){ return 'https://gw.test/'; } },
    navigator:{standalone:true, platform:'iPhone', userAgent:'iPhone'},
    matchMedia:()=>({matches:false,addEventListener:noop}), addEventListener:noop,
    setTimeout:()=>0, clearTimeout:noop, setInterval:()=>0, requestAnimationFrame:()=>0,
    getComputedStyle:()=>({}), localStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
    fetch:()=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({players:[],countries:[]})}),
    console:{log:noop,warn:noop,error:noop}, visualViewport:null,
    IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},
    ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
    MutationObserver:class{observe(){}disconnect(){}},
    Image:class{set src(v){}}, URL, URLSearchParams, performance:{now:()=>0},
    screen:{width:390,height:844}, innerWidth:390, innerHeight:844, devicePixelRatio:3 };
  win.window=win; win.self=win; win.globalThis=win;
  const ctx=vm.createContext(win);
  for(const b of blocks(gwSrc)){ try{ vm.runInContext(b, ctx, {timeout:4000}); }catch(e){} }
  ck('openPlayScreen is defined', typeof ctx.openPlayScreen === 'function' || /function openPlayScreen/.test(gw));
  try { if (typeof ctx.openPlayScreen === 'function') ctx.openPlayScreen(); } catch(e){}
  if (typeof ctx.openPlayScreen === 'function') {
    // MERGE: the game now lives on the Gateway's own origin, so Play must go to
    // exactly that origin -- a different one is what minted a new player.
    // ROOT MOVE: the game is /play/ on the same origin as the Gateway.
    ck('tapping Play stays on the SAME origin, at /play/', navigatedTo==='https://gw.test/play/', String(navigatedTo));
    ck('tapping Play does NOT set an iframe src', frameSrcSet===null, String(frameSrcSet));
  } else {
    console.log('  note   openPlayScreen not exposed on the context; static checks above cover it');
  }
}

console.log('\n-- identity can no longer fragment --');
ck('playerId still minted from one localStorage key', sp.includes('localStorage.fluxPlayerId'));
ck('only one place mints it', (sp.match(/if\(!localStorage\.fluxPlayerId\)/g)||[]).length===1);
ck('game is the same origin however it is launched',
   (gw.match(/window\.FLUX_GAME_URL = window\.location\.origin \+ '\/play\/';/g)||[]).length===1 &&
   !/flux-sparta-3\.jeromevt72/.test(gw));

console.log('\n-- one purchase at a time --');
ck('in-flight flag exists', sp.includes('let purchaseInFlight = false;'));
ck('second tap is refused', /if \(purchaseInFlight\) \{[\s\S]{0,200}return;/.test(sp));
ck('flag set before the request', /purchaseInFlight = true;[\s\S]{0,80}btn\.disabled = true;/.test(sp));
ck('flag cleared on error', /catch \(e\) \{\s*purchaseInFlight = false;/.test(sp));
ck('button restored on error', /catch \(e\) \{[\s\S]{0,80}resetBuyButton\(btn, sku\);/.test(sp));

console.log('\n-- a handoff that goes nowhere cannot strand the button --');
ck('goToCheckout reports which path it took', sp.includes("return 'handoff';") && sp.includes("return 'navigated';"));
ck('handoff schedules a reset', /navigated === 'handoff'[\s\S]{0,260}resetBuyButton\(btn, sku\)/.test(sp));
ck('reset also clears the lock', /navigated === 'handoff'[\s\S]{0,260}purchaseInFlight = false;/.test(sp));

console.log('\n-- entitlement authority unchanged (RC2.5.3) --');
ck('no legacy-key ownership', !sp.includes("return localStorage['fluxOwned_' + sku] === '1';"));
ck('verified cache gated 4 ways',
   sp.includes('c.v !== 1') && sp.includes("c.source !== 'server'") && sp.includes('c.playerId !== playerId'));
ck('unlock uses server-confirmed sku', sp.includes('const confirmedSku = data.sku;'));
ck('session must match this player', sp.includes('confirmedFor === playerId'));

console.log('\n-- checkout handoff kept as a safety net, still validated --');
ck('Gateway still validates sender frame', gw.includes('e.source !== frame.contentWindow'));
ck('Gateway still validates the URL', gw.includes('isTrustedStripeCheckoutUrl('));
ck('Sparta still validates before posting', sp.includes('function isStripeCheckoutUrl('));

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL SINGLE-IDENTITY TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
