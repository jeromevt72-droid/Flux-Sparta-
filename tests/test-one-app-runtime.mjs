// ONE-APP AUDIT — RUNTIME. Boots the REAL shipped Gateway and game scripts.
// No FLUX logic is reimplemented here; harness.mjs only supplies a browser.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boot, makeStore } from './harness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname,'FLUX-Sparta','public');
const ORIGIN = 'https://flux-sparta-3.jeromevt72.workers.dev';
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const scriptsOf = f => [...fs.readFileSync(f,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const GAME = scriptsOf(path.join(PUB,'play','index.html'));
// STORE SWITCH: the shipped game has STORE_OPEN = false (COMING SOON). The
// purchase-chain tests below must keep protecting the path players get once the
// store reopens after T-9, so they boot the REAL game with only that one line
// flipped. Anything else would not be the shipped code.
const SWITCH_LINE = 'const STORE_OPEN = false;';
const SWITCH_FOUND = GAME.filter(b=>b.includes(SWITCH_LINE)).length;
const GAME_STORE_OPEN = GAME.map(b=>b.replace(SWITCH_LINE,'const STORE_OPEN = true;'));
const GATEWAY = scriptsOf(path.join(PUB,'index.html'));
const DEMO = scriptsOf(path.join(PUB,'hero-demo.html'));
const tick = () => new Promise(r=>setTimeout(r,20));

// ------------------------------------------------------------------------
console.log('== SHIPPED STORE SWITCH ==');
ck('shipped game has the store switch set to CLOSED, exactly once', SWITCH_FOUND===1, 'found '+SWITCH_FOUND);

console.log('\n== IDENTITY: install -> Gateway -> Play -> register -> 10 relaunches ==');
{
  const { store, mem } = makeStore();
  let minted = 0;
  const uuid = () => { minted++; return 'player-'+minted; };

  // Launch 1: installed app opens the Gateway (start_url /welcome/).
  const gw1 = boot(GATEWAY, { origin:ORIGIN, path:'/', store, uuid });
  ck('Gateway boots without error', gw1.errors.length===0, gw1.errors.join('|'));
  ck('Gateway does NOT create a player', mem.fluxPlayerId===undefined, String(mem.fluxPlayerId));
  gw1.ctx.openPlayScreen && gw1.ctx.openPlayScreen();
  // ROOT MOVE: the game is /play/ on the SAME origin as the Gateway at "/".
ck('Play navigates within the same origin', gw1.nav.to===ORIGIN+'/play/', String(gw1.nav.to));
  ck('Play opens no new window', gw1.nav.opened.length===0);

  // The game loads at that address and registers TITAN via the REAL saveProfile.
  const g1 = boot(GAME, { origin:ORIGIN, path:'/play/', store, uuid });
  ck('game boots without error', g1.errors.length===0, g1.errors.join('|'));
  const firstId = mem.fluxPlayerId;
  ck('exactly one player created on first game load', minted===1 && firstId==='player-1', firstId);
  g1.els.callsign.value = 'titan';
  g1.els.country.value = 'PH';
  const ok = g1.ctx.saveProfile();
  ck('real saveProfile registers the FLUX ID', ok===true && mem.fluxCallsign==='TITAN', mem.fluxCallsign);
  mem.fluxBest_medium = '3623';            // a saved best, as endGame would record

  // 10 kill/relaunch cycles, each: Gateway -> Play -> game.
  const ids = new Set([firstId]);
  let navOk = true, gwClean = true;
  for (let i=0; i<10; i++){
    const before = JSON.stringify(mem);
    const gw = boot(GATEWAY, { origin:ORIGIN, path:'/', store, uuid });
    if (JSON.stringify(mem) !== before) gwClean = false;          // Gateway must not touch identity
    gw.ctx.openPlayScreen && gw.ctx.openPlayScreen();
    if (gw.nav.to !== ORIGIN+'/play/' || gw.nav.opened.length) navOk = false;
    boot(GAME, { origin:ORIGIN, path:'/play/', store, uuid });
    ids.add(mem.fluxPlayerId);
  }
  ck('10 relaunches: every Play stayed same-origin, no new window', navOk);
  ck('10 relaunches: Gateway never changed player storage', gwClean);
  ck('10 relaunches: still exactly ONE playerId ever created', minted===1, 'minted='+minted);
  ck('10 relaunches: playerId never changed', ids.size===1 && [...ids][0]==='player-1', [...ids].join(','));
  ck('FLUX ID survived every relaunch', mem.fluxCallsign==='TITAN');
  ck('country survived', mem.fluxCountry==='PH');
  ck('personal best survived', mem.fluxBest_medium==='3623');
  ck('profile marked complete (no re-registration prompt)', mem.fluxProfileComplete==='1');
}

// ------------------------------------------------------------------------
console.log('\n== DEMO IS STERILE: run the ENTIRE real demo against poisoned storage ==');
{
  const poison = { fluxPlayerId:'REAL-PLAYER', fluxCallsign:'TITAN', fluxCountry:'PH',
    fluxDifficulty:'hard', fluxBest_medium:'3623', fluxBestRun_medium:'{"score":3623,"level":4}',
    fluxSkin:'solar', fluxOwned_solar:'1',
    fluxEntitlementsV1:'{"v":1,"source":"server","playerId":"REAL-PLAYER","skus":["solar"]}' };
  const { store, mem } = makeStore(poison);
  const snapshot = JSON.stringify(mem);
  const apiCalls = [];
  const fetchImpl = (u)=>{ apiCalls.push(String(u)); return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}) }); };
  // Real browsers put localStorage on window as a configurable accessor; model that.
  const r = boot([], { origin:ORIGIN, path:'/hero-demo.html', store, fetchImpl });
  delete r.win.localStorage; delete r.win.sessionStorage;
  Object.defineProperty(r.win,'localStorage',{ get:()=>store, configurable:true });
  Object.defineProperty(r.win,'sessionStorage',{ get:()=>store, configurable:true });
  const vm = await import('vm');
  const errs=[];
  for (const s of DEMO){ try{ vm.runInContext(s, r.ctx, {timeout:5000}); }catch(e){ errs.push(String(e).slice(0,90)); } }
  ck('whole demo executed (not just the shim)', DEMO.length>1 && errs.length===0, errs.join('|'));
  ck('demo was NOT blocked (isolation took effect)', r.ctx.__FLUX_DEMO_BLOCKED__!==true);
  // Give the demo's async paths (autoplay end-of-run submit, sync) a chance.
  for (const k of ['submitScore','syncEntitlements','verifyPendingPurchase']) { try{ r.ctx[k] && r.ctx[k](); }catch(e){} }
  try { r.ctx.buySkin && r.ctx.buySkin('toxic', r.els.x || {}); } catch(e){}
  await tick();
  ck('production storage byte-for-byte unchanged', JSON.stringify(mem)===snapshot);
  ck('real playerId still REAL-PLAYER', mem.fluxPlayerId==='REAL-PLAYER');
  ck('real entitlement cache untouched', mem.fluxEntitlementsV1===poison.fluxEntitlementsV1);
  ck('ZERO requests reached the network from the demo', apiCalls.length===0, JSON.stringify(apiCalls));
  ck('demo cannot see IndexedDB', r.ctx.indexedDB===undefined);
  ck('demo cannot see the Cache API', r.ctx.caches===undefined);
}

// ------------------------------------------------------------------------
console.log('\n== STRIPE (store-open config, post-T-9): the installed app resolves its OWN purchase ==');
{
  const { store, mem } = makeStore();
  let entSkus = [];
  const calls = [];
  const fetchImpl = (u, o) => {
    const url = String(u); calls.push(url);
    const J = (b,st=200)=>Promise.resolve({ ok:st<400, status:st, json:()=>Promise.resolve(b) });
    if (url.includes('/api/create-checkout-session')) return J({ url:'https://checkout.stripe.com/c/pay/cs_test_1', sessionId:'cs_test_1', mode:'test' });
    if (url.includes('/api/verify-session')) { entSkus=['toxic']; return J({ paid:true, sku:'toxic', playerId:mem.fluxPlayerId }); }
    if (url.includes('/api/entitlements')) return J({ skus:entSkus });
    return J({});
  };
  const g = boot(GAME_STORE_OPEN, { origin:ORIGIN, path:'/play/', store, fetchImpl, uuid:()=>'buyer-1' });
  await tick();
  const btn = { disabled:false, textContent:'BUY $1.99' };
  await g.ctx.buySkin('toxic', btn);
  ck('checkout left for Stripe (same window)', String(g.nav.to).startsWith('https://checkout.stripe.com/'), String(g.nav.to));
  const pend = JSON.parse(mem.fluxPendingCheckout||'null');
  ck('app remembered ITS OWN pending checkout', pend && pend.sessionId==='cs_test_1' && pend.playerId==='buyer-1');
  ck('toxic NOT owned before server confirmation', g.ctx.ownsSkin('toxic')===false);
  // Player taps Done / swipes back: the page is restored, not reloaded.
  g.fire('pageshow');
  await tick(); await tick();
  ck('return triggered server verification', calls.some(u=>u.includes('/api/verify-session?session_id=cs_test_1')));
  ck('entitlements re-synced from the server', calls.some(u=>u.includes('/api/entitlements')));
  ck('toxic OWNED only after server confirmation', g.ctx.ownsSkin('toxic')===true);
  ck('pending checkout cleared', mem.fluxPendingCheckout===undefined);
  // purchaseInFlight is a lexical `let`, not a global, so it cannot be read
  // directly. Prove the lock is released by BEHAVIOUR: a new purchase must not
  // be refused with ONE AT A TIME. (An earlier draft of this check ended in
  // "|| true" and could never fail -- removed.)
  let lockRefused = false;
  const realShow = g.ctx.showInfo;
  g.ctx.showInfo = (t)=>{ if (/ONE AT A TIME/.test(t)) lockRefused = true; };
  await g.ctx.buySkin('cosmic', { disabled:false, textContent:'' });
  g.ctx.showInfo = realShow;
  ck('purchase lock released (next BUY not refused)', lockRefused===false);
  const verifies = calls.filter(u=>u.includes('/api/verify-session')).length;
  g.fire('pageshow'); g.fire('doc:visibilitychange'); await tick();
  ck('no double verification on repeated foregrounds', calls.filter(u=>u.includes('/api/verify-session')).length===verifies);
}

// ------------------------------------------------------------------------
console.log('\n== STRIPE: cancelled / unpaid return restores the UI, grants nothing ==');
{
  const { store, mem } = makeStore();
  const fetchImpl = (u)=>{ const url=String(u);
    const J=(b)=>Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(b) });
    if (url.includes('/api/create-checkout-session')) return J({ url:'https://checkout.stripe.com/c/pay/cs_x', sessionId:'cs_x' });
    if (url.includes('/api/verify-session')) return J({ paid:false, sku:'cosmic', playerId:mem.fluxPlayerId });
    if (url.includes('/api/entitlements')) return J({ skus:[] });
    return J({}); };
  const g = boot(GAME_STORE_OPEN, { origin:ORIGIN, path:'/play/', store, fetchImpl, uuid:()=>'p2' });
  await tick();
  await g.ctx.buySkin('cosmic', { disabled:false, textContent:'' });
  g.fire('pageshow'); await tick(); await tick();
  ck('unpaid return grants nothing', g.ctx.ownsSkin('cosmic')===false);
  // A second BUY must be allowed now -- the lock cannot be left held.
  let refused=false;
  const origInfo = g.ctx.showInfo; g.ctx.showInfo = (t)=>{ if(/ONE AT A TIME/.test(t)) refused=true; };
  await g.ctx.buySkin('toxic', { disabled:false, textContent:'' });
  ck('after returning, another purchase is NOT refused (lock released)', refused===false);
}

// ------------------------------------------------------------------------
console.log('\n== STRIPE: a session paid by ANOTHER player can never be claimed ==');
{
  const { store, mem } = makeStore();
  const fetchImpl = (u)=>{ const url=String(u);
    const J=(b)=>Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(b) });
    if (url.includes('/api/verify-session')) return J({ paid:true, sku:'solar', playerId:'SOMEONE-ELSE' });
    if (url.includes('/api/entitlements')) return J({ skus:[] });
    return J({}); };
  const g = boot(GAME_STORE_OPEN, { origin:ORIGIN, path:'/play/', store, fetchImpl, uuid:()=>'me' });
  mem.fluxPendingCheckout = JSON.stringify({ sessionId:'cs_other', sku:'solar', playerId:'me', at:Date.now() });
  g.fire('pageshow'); await tick(); await tick();
  ck('another player\'s paid session grants me nothing', g.ctx.ownsSkin('solar')===false);
  mem.fluxPendingCheckout = JSON.stringify({ sessionId:'cs_forged', sku:'solar', playerId:'NOT-ME', at:Date.now() });
  const before = mem.fluxPendingCheckout;
  g.fire('pageshow'); await tick();
  ck('a pending record for a different playerId is ignored', g.ctx.ownsSkin('solar')===false);
}

// ------------------------------------------------------------------------
console.log('\n== ROOT MOVE: Stripe returns to "/" and must reach the game ==');
{
  // The worker (frozen) sends Stripe's success_url / cancel_url to the site
  // root, which is now the Gateway. The Gateway must forward to /play/ with the
  // query intact, so the game can verify the session.
  for (const q of ['?session_id=cs_live_abc&sku=toxic', '?checkout=cancelled']) {
    const { store } = makeStore();
    const r = boot(GATEWAY, { origin:ORIGIN, path:'/', search:q, store });
    ck('Stripe return '+q.slice(0,22)+'… forwarded to the game', r.nav.to===ORIGIN+'/play/'+q, String(r.nav.to));
  }
  const { store } = makeStore();
  const plain = boot(GATEWAY, { origin:ORIGIN, path:'/', search:'', store });
  ck('an ordinary Gateway visit is NOT forwarded', plain.nav.to===null, String(plain.nav.to));
  const junk = boot(GATEWAY, { origin:ORIGIN, path:'/', search:'?utm=ad&ref=x', store });
  ck('unrelated query strings are NOT forwarded', junk.nav.to===null, String(junk.nav.to));
}

console.log('\n== ROOT MOVE: API calls stay at the origin, never under /play/ ==');
{
  const { store } = makeStore();
  const hits=[];
  const fetchImpl=(u)=>{ hits.push(String(u)); return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({players:[],countries:[]}) }); };
  boot(GATEWAY, { origin:ORIGIN, path:'/', store, fetchImpl });
  ck('Gateway leaderboard request hits the origin API', hits[0]===ORIGIN+'/api/leaderboard?limit=50', hits[0]);
  ck('no request was sent under /play/api/', !hits.some(u=>u.includes('/play/api/')), hits.join(' | '));
}

// ------------------------------------------------------------------------
console.log('\n== SHIPPED CONFIG: store closed -- COMING SOON, nothing can be bought ==');
// Records what the REAL buildShopUI renders as [skin name -> its button].
// Matched by NAME, not position: Aurora (free) is added to SKINS at runtime and
// renders first, and the backdrop list follows the skins. (An earlier draft of
// this test matched by position and misread Aurora's ACTIVE as a paid skin.)
function renderShop(g){
  const log=[];
  g.win.document.createElement=(tag)=>{ const el={ tag, innerHTML:'', textContent:'', disabled:false, onclick:null, className:'',
    appendChild(){}, style:{}, classList:{add(){},remove(){},toggle(){}} }; log.push(el); return el; };
  g.els.shopList = { set innerHTML(v){}, appendChild(){} };
  g.ctx.buildShopUI();
  const shop={};
  for (let k=0; k<log.length-1; k++){
    if (log[k].tag==='div' && log[k+1].tag==='button'){
      const name=(log[k].innerHTML.match(/<b>([^<]+)<\/b>/)||[])[1];
      const label=log[k].innerHTML.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if (name && !(name in shop)) shop[name]={ btn:log[k+1], label };
    }
  }
  return shop;
}
const PAID=['TOXIC','COSMIC','SOLAR INFERNO'];
{
  const { store, mem } = makeStore();
  const calls=[];
  const fetchImpl=(u)=>{ calls.push(String(u)); return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ skus:[] }) }); };
  const g = boot(GAME, { origin:ORIGIN, path:'/play/', store, fetchImpl, uuid:()=>'player' });
  await tick();
  const shop = renderShop(g);
  ck('shop lists all three paid skins', PAID.every(n=>shop[n]), Object.keys(shop).join(', '));
  ck('every paid skin shows SOON, disabled', PAID.every(n=>shop[n] && shop[n].btn.textContent==='SOON' && shop[n].btn.disabled===true),
     PAID.map(n=>n+':'+(shop[n]&&shop[n].btn.textContent)).join(' '));
  ck('no paid skin has a BUY action', PAID.every(n=>shop[n] && shop[n].btn.onclick===null));
  ck('every paid skin is labelled COMING SOON', PAID.every(n=>shop[n] && /COMING SOON/.test(shop[n].label)));
  ck('no price is shown to players', !Object.values(shop).some(r=>/\$\d/.test(r.label)));
  ck('free Aurora stays usable (never locked)', shop['AURORA'] && ['ACTIVE','USE'].includes(shop['AURORA'].btn.textContent),
     shop['AURORA'] && shop['AURORA'].btn.textContent);
  let msg=null; g.ctx.showInfo=(t)=>{ msg=t; };
  const before = calls.length;
  await g.ctx.buySkin('solar', { disabled:false, textContent:'' });
  ck('direct buySkin() refuses with COMING SOON', msg==='COMING SOON', String(msg));
  ck('no checkout request was ever sent', !calls.slice(before).some(u=>u.includes('create-checkout-session')), calls.slice(before).join(' | '));
  ck('no pending checkout recorded', mem.fluxPendingCheckout===undefined);
}

console.log('\n== SHIPPED CONFIG: skins a player already owns stay owned and usable ==');
{
  const { store } = makeStore();
  const fetchImpl=(u)=>Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ skus: String(u).includes('/api/entitlements') ? ['solar'] : [] }) });
  const g = boot(GAME, { origin:ORIGIN, path:'/play/', store, fetchImpl, uuid:()=>'owner' });
  await tick(); await tick();
  const shop = renderShop(g);
  ck('a server-verified owned skin is still owned', g.ctx.ownsSkin('solar')===true);
  ck('owned Solar Inferno keeps USE while the store is closed', shop['SOLAR INFERNO'] && shop['SOLAR INFERNO'].btn.textContent==='USE',
     shop['SOLAR INFERNO'] && shop['SOLAR INFERNO'].btn.textContent);
  ck('unowned skins still show SOON', ['TOXIC','COSMIC'].every(n=>shop[n] && shop[n].btn.textContent==='SOON'));
}

console.log('\n'+'='.repeat(56));
console.log(F? '  '+F+' FAILED' : '  ALL ONE-APP RUNTIME TESTS PASSED');
console.log('='.repeat(56));
process.exit(F?1:0);
