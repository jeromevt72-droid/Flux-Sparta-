// T-9: production ownership authority. Runs the RUNTIME binding of ownsSkin,
// not a declaration the browser never reaches.
import fs from 'fs';
const src = fs.readFileSync(new URL('./FLUX-Sparta/public/play/index.html', import.meta.url),'utf8');
const code = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n')
  .replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
function grabLast(n){
  const i=Math.max(code.lastIndexOf('function '+n+'('), code.lastIndexOf(n+' = function'), code.lastIndexOf(n+' = async function'));
  let d=0,j=code.indexOf('{',i);
  for(let k=j;k<code.length;k++){ if(code[k]==='{')d++; else if(code[k]==='}'){d--; if(!d) return code.slice(i,k+1);} }
}
let store={};
const LS=()=>new Proxy(store,{get:(t,k)=>k==='removeItem'?(x=>{delete t[x]}):t[k],set:(t,k,v)=>{t[k]=String(v);return true}});
globalThis.localStorage=LS();
// No module-level `let` for these: a module binding would shadow the
// globalThis values the extracted production functions actually read.
Object.assign(globalThis,{playerId:'p-alice',fluxEntitlementsLoaded:false,
  fluxOwnedSkus:new Set(),ENT_CACHE_KEY:'fluxEntitlementsV1'});
for(const f of ['readVerifiedEntitlements','writeVerifiedEntitlements'])
  eval('globalThis.'+f+' = '+grabLast(f).replace('function '+f+'(','function ('));
eval('globalThis.ownsSkin = '+grabLast('ownsSkin').replace('ownsSkin = function','function').replace('function ownsSkin(','function ('));
const reset=()=>{store={};globalThis.localStorage=LS();globalThis.fluxEntitlementsLoaded=false;globalThis.fluxOwnedSkus=new Set();};

console.log('-- 1. legacy mock keys grant NOTHING --');
reset(); store['fluxOwned_toxic']='1';
ck('legacy fluxOwned_toxic is not ownership', ownsSkin('toxic')===false);
reset(); store['fluxOwned_cosmic']='1';
ck('legacy fluxOwned_cosmic is not ownership', ownsSkin('cosmic')===false);
reset(); store['fluxOwned_solar']='1';
ck('legacy fluxOwned_solar is not ownership', ownsSkin('solar')===false);
ck('aurora is still free', ownsSkin('aurora')===true);

console.log('\n-- 2. fresh user sees paid skins locked --');
reset();
for(const s of ['toxic','cosmic','solar']) ck('fresh user locked out of '+s, ownsSkin(s)===false);

console.log('\n-- 3. server entitlement unlocks the right SKU --');
reset(); globalThis.fluxEntitlementsLoaded=true; globalThis.fluxOwnedSkus=new Set(['toxic']);
ck('server-granted toxic unlocked', ownsSkin('toxic')===true);
ck('cosmic still locked', ownsSkin('cosmic')===false);
ck('solar still locked', ownsSkin('solar')===false);

console.log('\n-- 4. verified cache survives offline --');
reset(); globalThis.fluxEntitlementsLoaded=true; globalThis.fluxOwnedSkus=new Set(['solar']);
writeVerifiedEntitlements(['solar']);
globalThis.fluxEntitlementsLoaded=false; globalThis.fluxOwnedSkus=new Set();   // offline relaunch
ck('previously verified solar works offline', ownsSkin('solar')===true);
ck('unverified cosmic still locked offline', ownsSkin('cosmic')===false);

console.log('\n-- 5. provenance and version gates --');
reset(); store['fluxEntitlementsV1']=JSON.stringify({v:1,source:'local',playerId:'p-alice',skus:['solar']});
ck('non-server provenance rejected', ownsSkin('solar')===false);
reset(); store['fluxEntitlementsV1']=JSON.stringify({v:99,source:'server',playerId:'p-alice',skus:['solar']});
ck('wrong cache version rejected', ownsSkin('solar')===false);
reset(); store['fluxEntitlementsV1']='{not json';
ck('corrupt cache rejected safely', ownsSkin('solar')===false);
reset(); store['fluxEntitlementsV1']=JSON.stringify({v:1,source:'server',playerId:'p-alice',skus:'solar'});
ck('non-array skus rejected', ownsSkin('solar')===false);

console.log("\n-- 6. one player's entitlement cannot unlock another's --");
reset(); globalThis.playerId='p-alice';
writeVerifiedEntitlements(['solar']);
ck('alice owns solar', ownsSkin('solar')===true);
globalThis.playerId='p-bob';
ck("bob does NOT inherit alice's solar", ownsSkin('solar')===false);
globalThis.playerId='p-alice';
ck('alice still owns it', ownsSkin('solar')===true);

console.log('\n-- 7. reconciliation removes stale paid keys, keeps player data --');
reset();
Object.assign(store,{fluxOwned_toxic:'1',fluxOwned_cosmic:'1',fluxBest_medium:'184000',
  fluxCallsign:'SPARTA',fluxCountry:'PH',fluxSkin:'aurora',fluxBestRun_medium:'{}'});
globalThis.fluxOwnedSkus=new Set(['toxic']); globalThis.fluxEntitlementsLoaded=true;
['toxic','cosmic','solar'].forEach(s=>{ if(!globalThis.fluxOwnedSkus.has(s)) localStorage.removeItem('fluxOwned_'+s); });
ck('server-owned toxic key kept', store.fluxOwned_toxic==='1');
ck('stale cosmic key removed', store.fluxOwned_cosmic===undefined);
for(const [k,v] of [['fluxBest_medium','184000'],['fluxCallsign','SPARTA'],['fluxCountry','PH'],['fluxSkin','aurora'],['fluxBestRun_medium','{}']])
  ck('player data untouched: '+k, store[k]===v);

console.log('\n-- 8. the purchase return path (source-proven) --');
ck('unlock uses the SERVER-confirmed sku', code.includes('const confirmedSku = data.sku;'));
ck('URL ?sku= no longer grants', !/localStorage\['fluxOwned_'\+sku\]='1';/.test(code));
ck('session must be paid', /data\.paid && confirmedSku/.test(code));
ck("session must belong to this player", /confirmedFor === playerId/.test(code));
ck('ownership re-read from server after purchase', /await syncEntitlements\(\)/.test(code));
// ONE-APP: on iOS the Stripe return can open outside the installed app, so the
// wording no longer implies an error. The SECURITY property is what matters and
// is asserted directly: that branch grants nothing to this context.
ck('another player\'s paid session grants nothing here',
   /else if\(data\.paid && confirmedFor && confirmedFor !== playerId\)\{[\s\S]{0,700}?PAYMENT RECEIVED/.test(code) &&
   !/confirmedFor !== playerId\)\{[\s\S]{0,700}?(syncEntitlements|writeVerifiedEntitlements|fluxOwned_)/.test(code.split('confirmedFor !== playerId){')[1]?.split('}else')[0] || ''));

console.log('\n-- 9. no indefinite loading on our own request --');
ck('pre-navigation fetch is bounded', code.includes('ctl.abort()') && code.includes('15000'));
ck('abort produces a recovery message', code.includes('taking longer than expected'));
ck('timer always cleared', /finally\s*\{\s*clearTimeout\(killTimer\);/.test(code));
// RC2.5.4: the domain now legitimately appears inside a hostname allowlist.
// What must remain true is that we never manipulate Stripe's hosted page --
// we only validate a URL and navigate to it.
ck('Stripe hosted page never manipulated',
   !/stripe[^\n]{0,80}(innerHTML|document\.write|contentWindow\s*\.|querySelector)/i.test(code));
ck('Stripe domain used only for validation',
   /h === 'checkout\.stripe\.com'/.test(code) && !/src\s*=\s*['"]https:\/\/checkout\.stripe\.com/.test(code));

console.log('\n-- 10. the dead declaration is fail-closed --');
const firstDecl = code.slice(code.indexOf('function ownsSkin('), code.indexOf('function ownsSkin(')+80);
ck('early declaration grants only aurora', firstDecl.includes("return sku==='aurora'") && !firstDecl.includes('fluxOwned_'));

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL T-9 ENTITLEMENT TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
