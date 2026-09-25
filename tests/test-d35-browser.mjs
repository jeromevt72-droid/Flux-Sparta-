// RC2.8.2 -- D-35 in a REAL browser engine (Chromium via Playwright), with the
// real game page, real Gateway files and real worker.js behind a local server.
// Two separate browser contexts stand in for iPhone Safari and the Home Screen
// icon: separate storage, exactly the situation that lost the pilot.
// Not in the release gate (needs a browser binary); run: node test-d35-browser.mjs
import { start, env } from './browser-server.mjs';
import fs from 'fs';
const pw = await import('/home/claude/.npm-global/lib/node_modules/playwright/index.mjs').catch(()=>import('playwright'));
const { chromium } = pw.default || pw;
let F=0; const ck=(l,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'  ['+x+']':''));if(!c)F++;};
const PORT=8787, BASE='http://localhost:'+PORT;
const SHOTS=process.env.SHOTS||'/tmp/shots'; fs.mkdirSync(SHOTS,{recursive:true});
const srv=await start(PORT);
const browser=await chromium.launch();
const phone={ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true };
const errors=[];
async function open(ctx){ const p=await ctx.newPage(); p.on('pageerror',e=>errors.push(String(e))); await p.goto(BASE+'/play/'); await p.waitForTimeout(600); return p; }
const vis=(p,sel)=>p.locator(sel).first().isVisible();
try {
  /* ---- iPhone Safari: the pilot that still exists ---- */
  const safari=await browser.newContext(phone);
  const s=await open(safari);
  await s.fill('#callsign','titan'); await s.selectOption('#country','US');
  await s.evaluate(()=>saveProfile());
  const sid=await s.evaluate(()=>localStorage.fluxPlayerId);
  const sub=await s.evaluate(async(id)=>{ const r=await fetch('/api/submit-score',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({playerId:id,name:'TITAN',score:4878,level:2,difficulty:'hard',country:'US'})}); return r.json(); }, sid);
  await env.LEADERBOARD_DO.get('global').fetch('https://do.internal/grant',{method:'POST',body:JSON.stringify({playerId:sid,sku:'solar',sessionId:'cs_browser'})});
  await s.reload(); await s.waitForTimeout(600);
  ck('B0 Safari pilot uploaded a score', !!sub.tag, JSON.stringify(sub).slice(0,80));
  ck('B1 no restore button in the main menu', (await s.locator('#restoreBtn').count())===0);
  ck('B1 link hidden until EDIT is tapped', !(await vis(s,'#restoreLink')));
  await s.click('#editProfile'); await s.waitForTimeout(150);
  ck('B1 EDIT shows RESTORE CODE under the name editor', await vis(s,'#restoreLink') && /RESTORE CODE/.test(await s.textContent('#restoreLink')) && !/HAVE/.test(await s.textContent('#restoreLink')));
  await s.screenshot({ path:SHOTS+'/0-edit-with-restore.png' });
  await s.click('#restoreLink'); await s.waitForTimeout(200);
  await s.screenshot({ path:SHOTS+'/1-restore-code-hidden.png' });
  ck('B2 code is hidden until SHOW CODE', !(await vis(s,'#restoreCodeBox')));
  await s.click('#restoreReveal'); await s.waitForTimeout(150);
  const code=(await s.textContent('#restoreCodeBox')).trim();
  await s.screenshot({ path:SHOTS+'/2-restore-code-shown.png' });
  ck('B2 pilot that uploaded on an older build (no local tag) is NOT told it has no score', !(await vis(s,'#restoreNoScore')));
  ck('B2 ...and its tag is filled in from the server', ((await s.textContent('.restoreWho'))||'').includes(sub.tag));
  ck('B2 code revealed, correct format', /^FX1-.+-[0-9A-F]{4}$/.test(code) && code.includes(sid), code.slice(0,20)+'...');
  ck('B2 copy button visible', await vis(s,'#restoreCopy'));
  await s.click('#restoreClose');

  /* ---- the old Home Screen icon: empty storage ---- */
  const icon=await browser.newContext(phone);
  const i=await open(icon);
  await i.screenshot({ path:SHOTS+'/3-icon-new-pilot.png' });
  ck('B3 new pilot sees HAVE A RESTORE CODE?', /HAVE A RESTORE CODE/.test(await i.textContent('#restoreLink')));
  ck('B3 icon asks for a FLUX ID (the reported situation)', await vis(i,'#profileEditor'));
  ck('B3 "HAVE A RESTORE CODE?" is offered right there', await vis(i,'#restoreLink'));
  const iconOwnId=await i.evaluate(()=>localStorage.fluxPlayerId);
  await i.click('#restoreLink'); await i.waitForTimeout(150);
  const tryCode=async(c)=>{ await i.fill('#restoreInput',c); await i.click('#restoreGo'); await i.waitForTimeout(400); return (await i.textContent('#restoreMsg'))||''; };
  let m=await tryCode('hello');
  ck('B4 junk -> "not a restore code"', /not a FLUX restore code/.test(m), m);
  const typo=code.slice(0,8)+(code[8]==='a'?'b':'a')+code.slice(9);
  m=await tryCode(typo);
  ck('B4 typo -> "has a typo"', /typo/.test(m), m);
  const nobody=await i.evaluate(()=>makeRestoreCode('nobody-here-0000'));
  m=await tryCode(nobody);
  ck('B4 valid but unknown -> "no pilot found"', /No pilot was found/.test(m), m);
  await i.screenshot({ path:SHOTS+'/4-entry-error.png' });
  ck('B4 nothing changed on the icon', (await i.evaluate(()=>localStorage.fluxPlayerId))===iconOwnId);
  const own=await i.evaluate(()=>makeRestoreCode(playerId));
  m=await tryCode(own);
  ck('B4 own code -> "already the pilot"', /already the pilot/.test(m), m);
  await i.fill('#restoreInput','  '+code+'\n'); await i.click('#restoreGo');
  await i.waitForTimeout(300);
  await i.screenshot({ path:SHOTS+'/5-confirm.png' });
  const confirmText=await i.textContent('.restoreOverlay');
  ck('B5 confirm names the restored pilot and its skin', /TITAN/.test(confirmText) && /SOLAR/.test(confirmText), confirmText.slice(0,120));
  await Promise.all([ i.waitForNavigation(), i.click('#restoreYes') ]);
  await i.waitForTimeout(900);
  await i.screenshot({ path:SHOTS+'/6-restored-menu.png' });
  ck('B6 icon is now the Safari pilot', (await i.evaluate(()=>localStorage.fluxPlayerId))===sid);
  ck('B6 menu shows PILOT TITAN with its tag', (await i.textContent('#profileName'))==='TITAN' && (await i.textContent('#profileTag')).includes(sub.tag));
  ck('B6 name editor and restore link gone', !(await vis(i,'#profileEditor')) && !(await vis(i,'#restoreLink')));
  await i.click('#difficulty button[data-d="hard"]');
  ck('B6 personal best on HARD restored', (await i.textContent('#menuBest')).replace(/,/g,'')==='4878', await i.textContent('#menuBest'));
  ck('B6 no restore journal left behind', await i.evaluate(()=>localStorage.getItem('fluxRestoreJournal')===null));
  ck('B7 restored skin owned (server check)', await i.evaluate(()=>ownsSkin('solar')));
  await i.click('#skinsBtn'); await i.waitForTimeout(250);
  await i.screenshot({ path:SHOTS+'/7-shop.png' });
  const shopTxt=await i.textContent('#shop');
  ck('B7 shop shows SOLAR as owned and the new recovery note', /OWNED|ACTIVE/.test(shopTxt) && /restore code/i.test(shopTxt), shopTxt.slice(0,160));

  /* ---- switching away from a pilot that has scores warns first ---- */
  const other=await browser.newContext(phone);
  const o=await open(other);
  await o.fill('#callsign','flux'); await o.evaluate(()=>saveProfile());
  const oid=await o.evaluate(()=>localStorage.fluxPlayerId);
  const osub=await o.evaluate(async(id)=>{ const r=await fetch('/api/submit-score',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({playerId:id,name:'FLUX',score:3731,level:2,difficulty:'medium',country:'US'})}); return r.json(); }, oid);
  await o.evaluate((t)=>{ localStorage.fluxPublicTag=t; }, osub.tag);
  await o.reload(); await o.waitForTimeout(500);
  await o.click('#editProfile'); await o.click('#restoreLink'); await o.click('#restoreOther');
  await o.fill('#restoreInput',code); await o.click('#restoreGo'); await o.waitForTimeout(500);
  await o.screenshot({ path:SHOTS+'/8-confirm-with-warning.png' });
  const t=await o.textContent('.restoreOverlay');
  ck('B8 replacing a pilot with scores shows its own code to copy first', /switch back/.test(t) && t.includes('FX1-'+oid), t.slice(0,140));
  ck('B8 current pilot shown by name even though EDIT was tapped', /replaces the pilot on this device:FLUX #/.test(t) && !/device:NEW PILOT/.test(t), t.slice(60,140));
  await o.click('#restoreNo');
  ck('B8 cancel changes nothing', (await o.evaluate(()=>localStorage.fluxPlayerId))===oid);

  /* ---- admin: ISSUE RESTORE CODE, then a fresh device uses it ---- */
  const adm=await browser.newContext({ viewport:{width:1024,height:1366} });
  const a=await adm.newPage(); a.on('pageerror',e=>errors.push(String(e)));
  await a.goto(BASE+'/admin.html'); await a.fill('#token','test-admin'); await a.fill('#q','TITAN'); await a.click('#find'); await a.waitForTimeout(400);
  let asked='';
  a.once('dialog', async d=>{ asked=d.message(); await d.accept('Stripe receipt matched (browser test)'); });
  await a.click('text=ISSUE RESTORE CODE'); await a.waitForTimeout(500);
  const issued=((await a.textContent('.rcode'))||'').trim();
  await a.screenshot({ path:SHOTS+'/10-admin-issued.png' });
  ck('B12 admin asks how the player was verified', /How did you verify them/.test(asked));
  ck('B12 admin gets the same code the pilot\'s device shows', issued===code, issued.slice(0,16));
  ck('B12 issue button gone after issuing (shown once)', (await a.locator('text=ISSUE RESTORE CODE').count())===0);
  a.once('dialog', async d=>{ await d.accept('x'); });
  await a.click('#loadEx'); await a.waitForTimeout(400);
  const exTxt=await a.textContent('#exceptions');
  await a.screenshot({ path:SHOTS+'/11-admin-log.png' });
  ck('B13 issue appears in the log under Check Exceptions', /Restore codes issued/.test(exTxt) && /Stripe receipt matched \(browser test\)/.test(exTxt) && /TITAN/.test(exTxt));
  ck('B13 the log does not show the code', !exTxt.includes('FX1-'));
  const newPhone=await browser.newContext(phone); const np=await open(newPhone);
  await np.click('#restoreLink'); await np.fill('#restoreInput',issued); await np.click('#restoreGo'); await np.waitForTimeout(500);
  await Promise.all([ np.waitForNavigation(), np.click('#restoreYes') ]); await np.waitForTimeout(700);
  ck('B14 new phone restored with the admin-issued code', (await np.evaluate(()=>localStorage.fluxPlayerId))===sid && (await np.textContent('#profileName'))==='TITAN');

  /* ---- Gateway copy ---- */
  const gw=await safari.newPage(); await gw.goto(BASE+'/'); await gw.waitForTimeout(400);
  const faq=await gw.textContent('body');
  ck('B9 Gateway FAQ explains the restore code', /RESTORE CODE, and save the code/.test(faq));
  ck('B9 offline card no longer contradicts itself', !/An internet connection is required to play/.test(faq));

  for (const c of [safari, icon, other, adm, newPhone]) { try{ await c.close(); }catch(e){} }
  /* ---- iPad size ---- */
  const pad=await browser.newContext({ viewport:{width:1024,height:1366}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  const pd=await open(pad); await pd.click('#restoreLink'); await pd.waitForTimeout(200);
  await pd.screenshot({ path:SHOTS+'/9-ipad-entry.png', timeout:90000, animations:'disabled' });
  ck('B10 iPad: entry screen fits and is usable', await vis(pd,'#restoreInput') && await vis(pd,'#restoreGo'));

  ck('B11 no page errors anywhere', errors.length===0, errors.join(' | ').slice(0,200));
} catch(e){ ck('browser run completed', false, String(e.stack||e).slice(0,300)); }
await browser.close(); srv.close();
console.log(F? '\nD-35 BROWSER FAILED: '+F : '\nD-35 BROWSER PASSED');
process.exit(F?1:0);
