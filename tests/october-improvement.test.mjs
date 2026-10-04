import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import test from 'node:test';
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function context(){
  const values=new Map();let locked=false;
  const c=vm.createContext({console,Date,JSON,Math,Set,Map,Array,String,Number,Object,RegExp,Error,Promise,URL,
    CacheService:{getScriptCache:()=>({get:k=>values.get(k)||null,put:(k,v)=>values.set(k,v),remove:k=>values.delete(k)})},
    LockService:{getScriptLock:()=>({waitLock(){assert.equal(locked,false,'nested lock');locked=true;},releaseLock(){locked=false;}})},
    Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(a,v)=>[...crypto.createHash(a).update(v).digest()],base64EncodeWebSafe:v=>Buffer.from(v).toString('base64url'),formatDate:()=> '2026-10-04'},
  });
  for(const file of ['Code.gs','Admin.gs','Reg.gs','Pgcc.gs'])vm.runInContext(read(file),c,{filename:file});
  c.__cache=values;return c;
}
test('old and new QR prefixes resolve to the same identity without altering their key',()=>{
  const c=context();
  for(const qr of ['CCF0137|kPGCC0034-secret','PGCC0137|kPGCC0034-secret','pgcc0137|kPGCC0034-secret']){
    for(const parse of [c.parseQrPayloadStrict_,c.admin_parseQrStrict_,c.regParseQr_])assert.deepEqual(plain(parse(qr)),{ok:true,id:'CCF0137',key:'kPGCC0034-secret'});
  }
  assert.equal(c.pgccQr_('CCF0137|kCCF0137-PGCC0034'),'PGCC0137|kCCF0137-PGCC0034');
  assert.deepEqual(plain(c.pgccNormalizeInput_({rows:[{position:'Media_AV',value:'PGCC0137, PGCC0002'}],reason:'PGCC0137 is available',key:'PGCC0137'})),{rows:[{position:'Media_AV',value:'CCF0137, CCF0002'}],reason:'PGCC0137 is available',key:'PGCC0137'});
});
test('scanner return uses a single-use server ticket bound to flow and event',()=>{
  const c=context();c.requireSession_=t=>t==='live'?{ok:true}:{ok:false,code:'E401'};c.renderPgccMobile_=x=>x;
  assert.equal(c.api_mobile_scanner('invalid','checkin','event').code,'E401');
  const r=c.api_mobile_scanner('live','checkin','SundayService_2026-10-04');
  const post={parameter:{mode:'live-mobile',returnView:'mobileScan',scannerReturn:'1',state:r.state,flow:'checkin',type:'CCF_QR_RESULT',payload:'PGCC0137|key'}};
  assert.deepEqual(plain(c.pgccScannerPost_(post)),{token:'live',eventKey:'SundayService_2026-10-04',flow:'checkin',type:'CCF_QR_RESULT',payload:'PGCC0137|key'});
  assert.ok(c.pgccScannerPost_(post).error);
  const mismatch=c.api_mobile_scanner('live','checkin','event');post.parameter.state=mismatch.state;post.parameter.flow='login';assert.ok(c.pgccScannerPost_(post).error);
  assert.equal(c.pgccScannerPost_({parameter:{returnView:'mobileScan',scannerReturn:'1'}}),null,'classic scanner path stays separate');
});
test('UI handoffs require a valid session and cannot be consumed for another destination',()=>{
  const c=context();c.requireSession_=()=>({ok:false,code:'E401'});assert.equal(c.api_pgcc_live_switch('bad','classic').code,'E401');
  const ticket=c.pgccTicket_({token:'secret',destination:'classic'}),e={parameter:{handoff:ticket}};
  assert.equal(c.pgccTakeTicket_(e,'live-mobile'),null);assert.equal(c.pgccTakeTicket_(e,'classic').token,'secret');assert.equal(c.pgccTakeTicket_(e,'classic'),null);
});
function allocation(role='GL',existing={Media_AV:'CCF0002'}){
  const c=context(),writes=[],audits=[];
  const positions=vm.runInContext('ADMIN_SERVING_POSITIONS',c),map=Object.fromEntries(positions.map((p,i)=>[p,i+2]));
  const values=['SundayService_2026-10-04',...positions.map(p=>existing[p]||'')];
  const sh={getLastColumn:()=>values.length,getRange:()=>({getValues:()=>[values],setValues:v=>writes.push(v)})};
  c.admin_requireSession_=()=>({ok:true,actor:{id:'CCF0001',role,glGroups:['MEDIA']}});
  c.admin_ensureServingSheet_=()=>sh;c.admin_ensureServingEventKeys_=()=>{};
  c.admin_getMembersIndex_=()=>({byId:{CCF0002:{id:'CCF0002',nameZh:'測試',servingGroups:['MEDIA','WORSHIP'],isMinor:false}}});
  c.admin_getServingValuesForEvent_=()=>existing;c.admin_checkServingAwayConflicts_=()=>[];c.admin_validateMinorServingValues_=()=>({ok:true,warnings:[]});
  c.admin_getServingMatrix_=()=>({eventCol:1});c.admin_findServingEventRowIndex_=()=>2;c.admin_getServingMatrixHeaderMap_=()=>map;
  c.admin_openSs_=()=>({});c.pgccRequireSheet_=()=>({appendRow:r=>audits.push(r)});c.admin_audit_=()=>{};
  const save=(position='Media_PPT',override)=>c.api_admin_serving_event_save('token','SundayService_2026-10-04',[{position,value:'PGCC0002'}],false,'',override);
  return {c,save,writes,audits};
}
test('GL, Staff, Deacon and Admin must review and give a detailed reason before non-Worship override',()=>{
  for(const role of ['GL','STAFF','DEACON','ADMIN','SUPERUSER']){
    const {save,writes,audits}=allocation(role);const conflict=save();assert.equal(conflict.canOverride,true,role);assert.equal(writes.length,0);
    assert.deepEqual(plain(conflict.duplicates[0].existingPositions),['Media_AV']);assert.deepEqual(plain(conflict.duplicates[0].attemptedPositions),['Media_PPT']);
    assert.equal(save('Media_PPT',{confirmed:true,reason:'short',conflictKey:conflict.conflictKey}).ok,false);
    assert.equal(save('Media_PPT',{confirmed:true,reason:'Agreed split of duties for this date',conflictKey:'stale'}).ok,false);
    assert.equal(save('Media_PPT',{confirmed:true,reason:'Agreed split of duties for this date',conflictKey:conflict.conflictKey}).ok,true,role);
    assert.equal(writes.length,1);assert.equal(audits[0][3],'SERVING_DUPLICATE_OVERRIDE');assert.match(audits[0][4],/Agreed split/);
  }
});
test('attempted Worship duplicate is blocked even for Admin, while a non-Worship attempt can be reviewed',()=>{
  const a=allocation('ADMIN');assert.equal(a.save('Worship_Lead').canOverride,false);assert.equal(a.writes.length,0);
  const b=allocation('STAFF',{Worship_Lead:'CCF0002'});assert.equal(b.save('Media_PPT').canOverride,true);
  const gl=allocation('GL');assert.equal(gl.save('Worship_Lead').code,'E403');
});
test('duplicate override cannot bypass leave restrictions or a required audit',()=>{
  const a=allocation('STAFF'),r=a.save();a.c.admin_checkServingAwayConflicts_=()=>[{memberId:'CCF0002',from:'2026-10-04',to:'2026-10-05'}];
  const o={confirmed:true,reason:'A sufficiently detailed reason',conflictKey:r.conflictKey};assert.equal(a.save('Media_PPT',o).subCode,'HOLIDAY_OVERLAP');assert.equal(a.writes.length,0);
  a.c.admin_checkServingAwayConflicts_=()=>[];a.c.pgccRequireSheet_=()=>{throw new Error('E_SCHEMA_APPROVAL');};assert.throws(()=>a.save('Media_PPT',o),/E_SCHEMA_APPROVAL/);assert.equal(a.writes.length,0);
});
test('schema guards reject missing or mismatched structures without writing',()=>{
  const c=context();assert.throws(()=>c.pgccRequireSheet_({getSheetByName:()=>null},'Serving'),/E_SCHEMA_APPROVAL/);
  const sh={getLastColumn:()=>1,getRange:()=>({getValues:()=>[['Old']]})};assert.throws(()=>c.pgccRequireSheet_({getSheetByName:()=>sh},'Sermon_Info',['EventKey']),/E_SCHEMA_APPROVAL/);
  c.admin_getServingMatrixHeaderMap_=()=>({});assert.deepEqual(plain(c.admin_ensureServingHeaders_({})),{});
});
test('stale service plan revision and viewer edits are rejected before any write',()=>{
  const c=context();c.pgccPlanAuth_=()=>({ok:true,actor:{id:'CCF0001',role:'VIEWER'}});c.pgccPlanData_=()=>({revision:'r1',canSermon:false,canSongs:false});
  assert.equal(c.api_service_plan_save('t','SundayService_2026-10-04','old','sermon',{},'plan').code,'E409');
  for(const section of ['sermon','song','rota'])assert.equal(c.api_service_plan_save('t','SundayService_2026-10-04','r1',section,{},'plan').code,'E403');
});
test('service plan exposes only assigned names to viewers and enforces GL group scope',()=>{
  const c=context();c.admin_getSermonRecordByEventKey_=()=>({});c.pgccReadWorshipMap_=()=>({});c.admin_getServingValuesForEvent_=()=>({Media_AV:'CCF0002'});
  c.admin_getMembersIndex_=()=>({byId:{CCF0001:{nameZh:'GL',servingGroups:['MEDIA']},CCF0002:{nameZh:'Assigned'},CCF0003:{nameZh:'Unassigned'}}});
  const v=c.pgccPlanData_({id:'CCF0001',role:'VIEWER'},'SundayService_2026-10-04');assert.deepEqual(plain(v.members.map(m=>m.id)),['CCF0002']);assert.ok(v.positions.every(p=>!p.canEdit));
  const gl=c.pgccPlanData_({id:'CCF0001',role:'GL',glGroups:['MEDIA']},'SundayService_2026-10-04');assert.ok(gl.positions.filter(p=>p.canEdit).every(p=>p.group==='media'));assert.equal(gl.canSermon,false);assert.equal(gl.canSongs,false);
});
test('existing worship import uses one lock when saving both rota and songs',()=>{
  const c=context(),saved=[];
  c.worshipPreviewImportChanges_=()=>({ok:true,changes:[{area:'ROTA',eventKey:'SundayService_2026-10-04',fieldName:'Worship_Lead',newValue:'CCF0002'},{area:'SONG',eventKey:'SundayService_2026-10-04',fieldName:'WORSHIP_MAIN_1.songTitle',newValue:'Grace'}]});
  c.reg_issueTempAdminTokenForWorship_=()=> 'temporary';
  c.admin_saveServingEventUnlocked_=()=>{saved.push('rota');return {ok:true};};
  c.reg_saveWorshipSongUnlocked_=()=>{saved.push('song');return {ok:true};};
  c.reg_getWorshipPlanningMapByEventKeys_=()=>({'SundayService_2026-10-04':{}});c.reg_writeWorshipAuditRows_=()=>{};
  assert.equal(c.worshipCommitImportChanges_({parsed:{id:'CCF0001'}},'sheet',false,'test').ok,true);
  assert.deepEqual(saved,['rota','song']);
});
test('self-service planning handoff preserves GL scope and does not issue an admin bearer token',()=>{
  const c=context();c.regGetSelfMemberByQr_=()=>({ok:true,parsed:{id:'CCF0001'}});c.admin_getMembersIndex_=()=>({byId:{CCF0001:{id:'CCF0001',status:'ACTIVE',servingGLGroups:['MEDIA']}}});c.getLiveWebAppUrl_=()=> 'https://example.test/exec';
  const result=c.api_pgcc_open_plan('PGCC0001|key','self');assert.equal(result.ok,true);
  const handoff=c.pgccTakeTicket_({parameter:{handoff:new URL(result.url).searchParams.get('handoff')}},'service-plan');
  const auth=c.pgccPlanAuth_(handoff.token,'plan');assert.equal(auth.actor.role,'GL');assert.deepEqual(plain(auth.actor.glGroups),['MEDIA']);
  assert.equal(c.admin_requireSession_(handoff.token).ok,false);
});
