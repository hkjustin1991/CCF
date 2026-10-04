// Run with Playwright installed: node tests/mobile-ui.smoke.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.cwd(),process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd()]}));
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const config={url:'https://pgcc-test.local/exec',logo:read('PgccLogo.html').split('<!--')[0].trim(),version:'October test'};
const member={id:'CCF0137',nameZh:'測試同工',nameEn:'Test Member',status:'STAFF'};
const eventKey='SundayService_2026-10-04';
const plan={ok:true,eventKey,events:[{eventKey},{eventKey:'SundayService_2026-10-11'}],revision:'r1',canSermon:true,canSongs:true,
  sermon:{speaker:'測試講員',sermonTitle:'恩典與盼望',sermonPassageRaw:'John 3:16'},songs:{WORSHIP_MAIN_1:{songTitle:'Amazing Grace',songKey:'G'}},
  members:[{id:member.id,name:'測試同工 / Test Member',groups:['MEDIA']}],positions:[{position:'Media_AV',label:'影音 / AV',group:'media',value:member.id,canEdit:true}]};
const browser=await chromium.launch({headless:true,executablePath:process.env.PGCC_CHROMIUM_PATH||undefined,args:process.env.PGCC_CHROMIUM_PATH?['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process']:[]});
const browserContext=await browser.newContext({deviceScaleFactor:1});
let screenshots=0;
try{
  for(const [width,height] of [[320,568],[390,844],[430,932]]){
    const page=await browserContext.newPage();await page.setViewportSize({width,height});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({member,eventKey,plan})=>{
      window.testCalls=[];window.failSave=false;
      const response=(fn,args)=>{
        if(fn==='api_ping'||fn==='api_login')return {ok:true,staff:member,token:'live',eventKey};
        if(fn==='api_search_members')return {ok:true,results:[member]};
        if(fn==='api_search_vrm')return {ok:true,results:[{...member,vrm:'AB12 CDE',vrm2:'CD34 EFG',checkedInToday:true}]};
        if(fn==='api_checkin_manual'||fn==='api_checkin_scan')return {ok:true,member,result:'OK',timeUk:'13:00'};
        if(fn==='api_get_live_page')return {ok:true,totalAttendance:42,newFriendCount:3,names:[member],servingToday:[{...member,position:'Media AV'}]};
        if(fn==='api_mobile_scanner')return {ok:true,state:'a'.repeat(32)};
        if(fn==='api_service_plan')return plan;
        if(fn==='api_service_plan_save'){
          if(window.failSave)return {ok:false,code:'E409',en:'Another edit was saved. Reload before saving your changes.'};
          if(args[3]==='sermon')plan.sermon={...plan.sermon,...args[4]};return {...plan,revision:'r2'};
        }
        return {ok:true};
      };
      function runner(){let success,failure;return {withSuccessHandler(f){success=f;return this;},withFailureHandler(f){failure=f;return this;},api_rpc(fn,args){window.testCalls.push({fn,args});setTimeout(()=>{try{success(response(fn,args));}catch(e){failure(e);}},5);}};}
      window.google={script:{get run(){return runner();}}};
      window.jsQR=()=>({data:'PGCC0137|k-test'});
    },{member,eventKey,plan});
    let target='LiveMobile.html';
    await page.route('https://pgcc-test.local/**',route=>{
      const liveBoot={config,resume:{token:'live',eventKey},scanner:{url:'https://scanner-test.local/'}};
      const boot=target==='LiveMobile.html'?liveBoot:{config,session:{token:'plan',back:'admin'}};
      route.fulfill({contentType:'text/html',body:read(target).replace('<?!= BOOT ?>',JSON.stringify(boot)).replace(/<script src="https:\/\/cdn[^>]*><\/script>/g,'')});
    });
    await page.route('https://scanner-test.local/**',r=>r.fulfill({contentType:'text/html',body:'Scanner test landing'}));
    await page.goto(config.url);await page.locator('.tile').last().waitFor();
    assert.equal(await page.locator('.tile').count(),4);
    const tiles=await page.locator('.tile').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};}));
    assert.ok(tiles.every(t=>Math.abs(t.w-t.h)<2),'square menu tiles');assert.ok(tiles[3].bottom<=height,'all four menu buttons fit the initial phone screen');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:'/tmp/pgcc-mobile-'+width+'.png',fullPage:true});screenshots++;
    await page.locator('[data-view="manual"]').click();await page.locator('#query').fill('PGCC0137');await page.locator('#searchForm button').click();await page.locator('[data-pick]').click();await page.locator('#confirm').click();await page.locator('#next').waitFor();assert.match(await page.locator('#app').innerText(),/簽到成功/);
    await page.locator('#home').click();await page.locator('[data-view="car"]').click();await page.locator('#query').fill('AB12');await page.locator('#searchForm button').click();await page.locator('#results .card').waitFor();assert.match(await page.locator('#results').innerText(),/已簽到/);assert.match(await page.locator('#results').innerText(),/CD34 EFG/);
    await page.locator('#back').click();await page.locator('[data-view="live"]').click();await page.locator('#filter').waitFor();await page.locator('#filter').fill('PGCC0137');assert.equal(await page.locator('#people .card').count(),1);
    await page.locator('#back').click();await page.locator('[data-view="scan"]').click();await page.locator('#file').setInputFiles({name:'qr.jpeg',mimeType:'image/jpeg',buffer:Buffer.from(config.logo.split(',')[1],'base64')});await page.locator('#next').waitFor();
    await page.locator('#next').click();await page.locator('#scan').click();await page.waitForURL('https://scanner-test.local/**');const scanUrl=new URL(page.url());assert.equal(scanUrl.searchParams.get('returnMode'),'post');assert.equal(scanUrl.searchParams.get('returnView'),'mobileScan');assert.equal(scanUrl.searchParams.get('returnUrl'),config.url+'?mode=live-mobile');assert.equal(scanUrl.searchParams.has('token'),false);
    target='ServicePlan.html';await page.goto(config.url+'?mode=service-plan');await page.locator('[data-edit="sermon"]').waitFor();if(width===390)await page.screenshot({path:'/tmp/pgcc-planning-390.png',fullPage:true});await page.locator('[data-edit="sermon"]').click();await page.locator('#f-sermonTitle').fill('新講題');await page.locator('#save').click();await page.locator('#message').filter({hasText:'Saved'}).waitFor();assert.match(await page.locator('#content').innerText(),/新講題/);
    await page.locator('[data-edit="sermon"]').click();await page.locator('#f-sermonTitle').fill('Unsaved');await page.evaluate(()=>window.failSave=true);await page.locator('#save').click();await page.locator('#message.error').waitFor();assert.equal(await page.locator('#f-sermonTitle').inputValue(),'Unsaved');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Passed mobile flow/layout checks at 320, 390 and 430px; '+screenshots+' screenshots in /tmp. Camera hardware and deployed Apps Script still require device testing.');
}finally{await browser.close();}
