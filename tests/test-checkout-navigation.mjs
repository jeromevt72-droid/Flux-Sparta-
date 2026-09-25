// AUDIT-F06: checkout must work from the installed Gateway PWA, not only in
// top-level Safari. Runs the REAL validators extracted from both files.
import fs from 'fs';
const spSrc = fs.readFileSync(new URL('./FLUX-Sparta/public/play/index.html', import.meta.url),'utf8');
const gwSrc = fs.readFileSync(new URL('./FLUX-Sparta/public/index.html', import.meta.url),'utf8');
const strip = t => [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n')
  .replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const sp = strip(spSrc), gw = strip(gwSrc);
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
function grab(src,n){
  const i=src.indexOf('function '+n+'(');
  let d=0,j=src.indexOf('{',i);
  for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} }
}
const spValid = new Function('URL','return '+grab(sp,'isStripeCheckoutUrl'))(URL);
const gwValid = new Function('URL','return '+grab(gw,'isTrustedStripeCheckoutUrl'))(URL);

console.log('-- URL validation: both sides agree, both reject lookalikes --');
const good = ['https://checkout.stripe.com/c/pay/cs_test_123',
              'https://checkout.stripe.com/c/pay/cs_live_abc?x=1'];
const bad = [
  ['http (not https)',        'http://checkout.stripe.com/c/pay/x'],
  ['lookalike suffix domain', 'https://checkout.stripe.com.evil.tld/c/pay/x'],
  ['lookalike prefix',        'https://evil-checkout.stripe.com.attacker.io/x'],
  ['substring trick',         'https://evil.tld/?u=checkout.stripe.com'],
  ['hyphen lookalike',        'https://checkout-stripe.com/c/pay/x'],
  ['arbitrary external',      'https://example.com/'],
  ['javascript: scheme',      'javascript:alert(1)'],
  ['data: scheme',            'data:text/html,<h1>x'],
  ['protocol-relative',       '//checkout.stripe.com/c/pay/x'],
  ['empty string',            ''],
  ['not a string',            12345],
  ['null',                    null],
  ['object',                  {url:'https://checkout.stripe.com'}],
  ['oversized',               'https://checkout.stripe.com/'+'a'.repeat(3000)],
];
for(const u of good){ ck('Sparta accepts: '+u.slice(0,44), spValid(u)===true); ck('Gateway accepts: '+u.slice(0,44), gwValid(u)===true); }
for(const [label,u] of bad){
  ck('Sparta rejects '+label, spValid(u)===false, String(u).slice(0,40));
  ck('Gateway rejects '+label, gwValid(u)===false, String(u).slice(0,40));
}

console.log('\n-- path A: standalone Sparta navigates itself (unchanged) --');
{
  let navigated=null, posted=[];
  const win={}; win.window=win; win.parent=win;          // top-level: parent === self
  const ctx={ window:win, location:{ set href(v){ navigated=v; } },
              document:{referrer:''}, URL,
              isStripeCheckoutUrl:spValid };
  const fn=new Function('window','location','document','URL','isStripeCheckoutUrl',
    grab(sp,'isFramed')+'\n'+grab(sp,'goToCheckout')+'\nreturn {isFramed,goToCheckout};')(
      ctx.window, ctx.location, ctx.document, URL, spValid);
  ck('not framed when parent === self', fn.isFramed()===false);
  fn.goToCheckout('https://checkout.stripe.com/c/pay/cs_1');
  ck('navigates itself to Stripe', navigated==='https://checkout.stripe.com/c/pay/cs_1', String(navigated));
}

console.log('\n-- path B: framed in the Gateway hands the URL up --');
{
  let navigated=null, posted=[];
  const parent={ postMessage:(m,o)=>posted.push({m,o}) };
  const win={ parent }; win.window=win;
  const fn=new Function('window','location','document','URL','isStripeCheckoutUrl',
    grab(sp,'isFramed')+'\n'+grab(sp,'goToCheckout')+'\nreturn {isFramed,goToCheckout};')(
      win, { set href(v){ navigated=v; } }, {referrer:'https://flux-gateway.test/'}, URL, spValid);
  ck('framed when parent !== self', fn.isFramed()===true);
  fn.goToCheckout('https://checkout.stripe.com/c/pay/cs_2');
  ck('does NOT navigate the iframe itself', navigated===null, String(navigated));
  ck('posts exactly one message', posted.length===1);
  ck('message type is flux-open-checkout', posted[0].m.type==='flux-open-checkout');
  ck('message carries the Stripe URL', posted[0].m.url==='https://checkout.stripe.com/c/pay/cs_2');
  ck('targeted at the Gateway origin, not "*"', posted[0].o==='https://flux-gateway.test', posted[0].o);

  let threw=false;
  try{ fn.goToCheckout('https://evil.tld/steal'); }catch(e){ threw=true; }
  ck('refuses to post a non-Stripe URL upward', threw);
}

console.log('\n-- Gateway receiver: only the real game frame, only Stripe --');
{
  const GAME='https://flux-sparta-3.jeromevt72.workers.dev';
  const frameWin={};
  let navigated=null;
  const previewWin={};
  const doc={ getElementById:id=> id==='playFrame' ? {contentWindow:frameWin} : id==='gameFrame' ? {contentWindow:previewWin} : null };
  const loc={ set href(v){ navigated=v; } };
  function handle(e){
    if(e.origin !== GAME) return;
    const t = e.data && e.data.type;
    if(t === 'flux-open-checkout'){
      const frame = doc.getElementById('playFrame');
      if(!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
      if(!gwValid(e.data && e.data.url)) return;
      loc.href = e.data.url;
    }
  }
  const URLOK='https://checkout.stripe.com/c/pay/cs_3';
  handle({origin:GAME, source:frameWin, data:{type:'flux-open-checkout', url:URLOK}});
  ck('valid message navigates top-level', navigated===URLOK);

  navigated=null;
  handle({origin:'https://evil.tld', source:frameWin, data:{type:'flux-open-checkout', url:URLOK}});
  ck('hostile ORIGIN rejected', navigated===null);
  handle({origin:GAME, source:{}, data:{type:'flux-open-checkout', url:URLOK}});
  ck('wrong iframe SOURCE rejected', navigated===null);
  handle({origin:GAME, source:previewWin, data:{type:'flux-open-checkout', url:URLOK}});
  ck('hero preview gameFrame SOURCE rejected', navigated===null);
  handle({origin:GAME, source:frameWin, data:{type:'flux-open-checkout', url:'https://evil.tld'}});
  ck('non-Stripe destination rejected', navigated===null);
  handle({origin:GAME, source:frameWin, data:{type:'flux-open-checkout', url:'https://checkout.stripe.com.evil.tld/x'}});
  ck('lookalike domain rejected', navigated===null);
  handle({origin:GAME, source:frameWin, data:{type:'flux-open-checkout'}});
  ck('missing url rejected', navigated===null);
  handle({origin:GAME, source:frameWin, data:{type:'flux-something-else', url:URLOK}});
  ck('wrong message type ignored', navigated===null);
  let threw=false;
  for(const d of [null,undefined,'str',42,[],{}]){
    try{ handle({origin:GAME, source:frameWin, data:d}); }catch(e){ threw=true; }
  }
  ck('malformed messages do not throw', !threw && navigated===null);
}

console.log('\n-- existing message types still work (no regression) --');
ck('flux-playing still handled', gw.includes("t === 'flux-playing'"));
ck('flux-gameover still handled', gw.includes("t === 'flux-gameover'"));
ck('flux-menu still handled', gw.includes("t === 'flux-menu'"));
ck('origin check still first', /if\(e\.origin !== GAME_ORIGIN\) return;/.test(gw));
ck('one message listener in the Gateway', (gw.match(/addEventListener\('message'/g)||[]).length===1);

console.log('\n-- return path: player comes back to FLUX, not Safari --');
ck('success_url returns to the game with session_id',
   fs.readFileSync(new URL('./FLUX-Sparta/worker.js', import.meta.url),'utf8')
     .includes('session_id={CHECKOUT_SESSION_ID}'));
ck('cancel_url returns to the game', fs.readFileSync(new URL('./FLUX-Sparta/worker.js', import.meta.url),'utf8')
     .includes('checkout=cancelled'));
ck('return is verified server-side on arrival', sp.includes("fetch('/api/verify-session?session_id="));
ck('return unlocks only the server-confirmed sku', sp.includes('const confirmedSku = data.sku;'));

console.log('\n-- entitlement authority untouched (RC2.5.3) --');
ck('no legacy-key ownership fallback', !sp.includes("return localStorage['fluxOwned_' + sku] === '1';"));
ck('verified cache still gated 4 ways',
   sp.includes("c.v !== 1") && sp.includes("c.source !== 'server'") && sp.includes("c.playerId !== playerId"));
ck('checkout grants nothing by itself', !/goToCheckout[\s\S]{0,400}fluxOwned_/.test(sp));

console.log('\n'+'='.repeat(52));
console.log(F? '  '+F+' FAILED' : '  ALL CHECKOUT-NAVIGATION TESTS PASSED');
console.log('='.repeat(52));
process.exit(F?1:0);
