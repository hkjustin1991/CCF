/** Preston Grace October release. Existing CCF IDs remain the storage identity. */
function pgccCanonicalId_(value){
  return String(value || '').trim().replace(/^PGCC(?=\d)/i, 'CCF').toUpperCase();
}
function pgccDisplayText_(value){
  return String(value == null ? '' : value).replace(/\bCCF(?=\d{4,}\b)/g, 'PGCC');
}
function pgccQr_(value){
  return String(value || '').replace(/^(?:CCF|PGCC)(\d{4,})\|/i, 'PGCC$1|');
}
function pgccNormalizeInput_(value){
  // Only identity-shaped values are aliases. Never rewrite the secret after |.
  if (typeof value === 'string'){
    if (/^PGCC\d{0,}$/i.test(value.trim())) return value.trim().replace(/^PGCC/i, 'CCF');
    if (/^PGCC\d{4,}\|/.test(value.trim())) return value.trim().replace(/^PGCC/, 'CCF');
    if (/^(?:(?:PGCC|CCF)\d{4,}\s*[,;]\s*)+(?:PGCC|CCF)\d{4,}$/i.test(value.trim())) return value.replace(/PGCC(?=\d)/gi, 'CCF');
    return value;
  }
  if (Array.isArray(value)) return value.map(pgccNormalizeInput_);
  if (value && typeof value === 'object'){
    const out = {};
    Object.keys(value).forEach(function(k){
      out[k] = /^(id|memberId|memberIds|targetId|qrPayload|authQrPayload|confirmQrPayload|reauthQrPayload|targetQrPayload|value|rows|excludedMemberIds|scrutineerIds)$/i.test(k) ? pgccNormalizeInput_(value[k]) : value[k];
    });
    return out;
  }
  return value;
}
function pgccSchemaApproval_(detail){
  throw new Error('E_SCHEMA_APPROVAL: Spreadsheet structure change requires Justin approval first. ' + String(detail || ''));
}
function pgccRequireSheet_(ss, name, headers){
  const sh = ss.getSheetByName(name);
  if (!sh) return pgccSchemaApproval_('Missing sheet: ' + name);
  const actual = sh.getRange(1,1,1,Math.max(1,sh.getLastColumn())).getValues()[0].map(String);
  if (headers && headers.some(function(h,i){ return String(actual[i] || '').trim() !== h; })) return pgccSchemaApproval_('Unexpected headers: ' + name);
  return sh;
}
function pgccUi_(){ return HtmlService.createHtmlOutputFromFile('PgccUi').getContent(); }
function pgccLogo_(){ return HtmlService.createHtmlOutputFromFile('PgccLogo').getContent().split('<!--')[0].trim(); }
function pgccConfig_(includeLogo){
  let auto = false;
  try{ auto = PropertiesService.getScriptProperties().getProperty('PGCC_AUTO_MOBILE') === 'true'; }catch(e){}
  const config = { url:getLiveWebAppUrl_(), autoMobile:auto, version:APP_VERSION };
  // The logo is a large data URI.  Keep it out of classic portal bootstrap data
  // so that login and check-in can render first on slower mobile connections.
  if (includeLogo) config.logo = pgccLogo_();
  return config;
}
function api_pgcc_branding(){
  return {ok:true, nameZh:'普恩基督教會', nameEn:'Preston Grace Christian Church', logo:pgccLogo_()};
}
function renderPgccMobile_(resume){
  const t = HtmlService.createTemplateFromFile('LiveMobile');
  t.BOOT = safeInlineJson_({ config:pgccConfig_(true), resume:resume || null, scanner:getExternalScannerConfig_() });
  return t.evaluate().setTitle('普恩基督教會 · Live').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function renderPgccEntry_(classic){
  const t=HtmlService.createTemplateFromFile('PgccEntry');
  t.ENTRY=safeInlineJson_({autoMobile:pgccConfig_(false).autoMobile,classic:classic,mobile:renderPgccMobile_(null).getContent()});
  return t.evaluate().setTitle('普恩基督教會 · Preston Grace').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function api_mobile_scanner(token, flow, eventKey){
  if (flow !== 'login' && flow !== 'checkin') return {ok:false, code:'E416'};
  if (flow === 'checkin') { const auth = requireSession_(token); if (!auth.ok) return auth; }
  const state = Utilities.getUuid().replace(/-/g,'');
  CacheService.getScriptCache().put('pgcc_scan_'+state, JSON.stringify({token:flow === 'checkin' ? token : '',flow:flow,eventKey:String(eventKey || '')}), 180);
  return {ok:true,state:state};
}
function pgccScannerPost_(e){
  const p = (e && e.parameter) || {};
  if ((p.returnView !== 'pgccScan' && !(p.returnView === 'mobileScan' && p.mode === 'live-mobile')) || p.scannerReturn !== '1') return null;
  let resume = {error:'Scan expired. Please try again. / 掃描已過期，請重試。'};
  if (/^[a-f0-9]{32}$/.test(String(p.state || ''))){
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try{
      const c = CacheService.getScriptCache(), key = 'pgcc_scan_'+p.state, raw = c.get(key);
      c.remove(key);
      if (raw){
        const ticket = JSON.parse(raw);
        if (ticket.flow === p.flow && ['CCF_QR_RESULT','CCF_QR_CANCEL','CCF_QR_ERROR'].indexOf(p.type) >= 0){
          resume = {token:ticket.token,eventKey:ticket.eventKey,flow:ticket.flow,type:p.type,payload:p.type === 'CCF_QR_RESULT' ? String(p.payload || '').slice(0,1000) : ''};
        }
      }
    }finally{ lock.releaseLock(); }
  }
  return renderPgccMobile_(resume);
}
function pgccTicket_(data){
  const ticket=Utilities.getUuid().replace(/-/g,'');
  CacheService.getScriptCache().put('pgcc_nav_'+ticket,JSON.stringify(data),120);
  return ticket;
}
function pgccTakeTicket_(e,destination){
  const ticket=String(((e||{}).parameter||{}).handoff||'');
  if(!/^[a-f0-9]{32}$/.test(ticket))return null;
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const c=CacheService.getScriptCache(),key='pgcc_nav_'+ticket,raw=c.get(key);
    if(!raw)return null;
    const data=JSON.parse(raw);if(data.destination!==destination)return null;
    c.remove(key);return data;
  }finally{lock.releaseLock();}
}
function api_pgcc_live_switch(token,destination){
  if(['classic','live-mobile'].indexOf(destination)<0)return {ok:false,code:'E416'};
  if(token){const s=requireSession_(token);if(!s.ok)return s;}
  return {ok:true,url:getLiveWebAppUrl_()+'?mode='+destination+'&handoff='+pgccTicket_({token:token||'',destination:destination})};
}
function api_pgcc_open_plan(token,kind){
  let actor, back='live-mobile';
  if(kind==='admin'){
    const s=admin_requireSession_(token);if(!s.ok)return s;actor=s.actor;back='admin';
  }else if(kind==='self'){
    const s=regGetSelfMemberByQr_(token);if(!s.ok)return s;
    const m=admin_getMembersIndex_().byId[s.parsed.id];
    if(!m || ['PENDING','PROVISIONAL','DISABLED'].indexOf(admin_normStatus_(m.status))>=0)return {ok:false,code:'E403'};
    let role=admin_normStatus_(m.status);
    if(m.roleExpires && admin_safeToDate_(m.roleExpires) && admin_safeToDate_(m.roleExpires).getTime()<Date.now())role='ACTIVE';
    actor={id:m.id,role:['STAFF','DEACON','ADMIN'].indexOf(role)>=0?role:((m.servingGLGroups||[]).length?'GL':'MEMBER'),glGroups:m.servingGLGroups||[]};back='reg';
  }else if(kind==='live' || kind==='live-edit'){
    const s=requireSession_(token);if(!s.ok)return s;
    actor={id:s.sess.staff.id,role:'VIEWER'};
    if(kind==='live-edit'){
      const m=admin_getMembersIndex_().byId[actor.id];
      if(!m || ['STAFF','DEACON','ADMIN'].indexOf(admin_normStatus_(m.status))<0 || (m.roleExpires && admin_safeToDate_(m.roleExpires) && admin_safeToDate_(m.roleExpires).getTime()<Date.now()))return {ok:false,code:'E403'};
      actor={id:m.id,role:admin_normStatus_(m.status),glGroups:m.servingGLGroups||[]};
    }
  }else return {ok:false,code:'E416'};
  const planToken=Utilities.getUuid();
  CacheService.getScriptCache().put('pgcc_plan_'+planToken,JSON.stringify({actor:actor}),1800);
  const ticket=pgccTicket_({destination:'service-plan',token:planToken,back:back});
  return {ok:true,url:getLiveWebAppUrl_()+'?mode=service-plan&handoff='+ticket};
}
function renderPgccServicePlan_(e){
  const t=HtmlService.createTemplateFromFile('ServicePlan');
  t.BOOT=safeInlineJson_({config:pgccConfig_(true),session:pgccTakeTicket_(e,'service-plan')});
  return t.evaluate().setTitle('普恩基督教會 · Service planning').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover');
}

// The planning page writes existing Sermon_Info, Worship_Planning and Serving fields only.
function pgccPlanAuth_(token, kind){
  if(kind==='plan'){
    const raw=CacheService.getScriptCache().get('pgcc_plan_'+String(token||''));
    if(!raw)return {ok:false,code:'E401',en:'Please reopen service planning from your portal.',zh:'請從專頁重新開啟崇拜安排。'};
    return {ok:true,actor:JSON.parse(raw).actor};
  }
  const s = kind === 'live' ? requireSession_(token) : admin_requireSession_(token);
  if (!s.ok) return s;
  if (kind === 'live') return {ok:true,actor:{id:s.sess.staff.id,role:'VIEWER'}};
  return s;
}
function pgccPlanRevision_(value){
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(value)));
}
function pgccReadWorshipMap_(eventKey){
  const out={};
  const sh=reg_openSsForWorship_().getSheetByName(REG_WORSHIP_PLANNING_SHEET);
  if(!sh || sh.getLastRow()<2)return out;
  sh.getRange(2,1,sh.getLastRow()-1,10).getValues().forEach(function(r){
    if(String(r[0]||'').trim()!==eventKey || REG_WORSHIP_SECTIONS.indexOf(String(r[1]||'').trim().toUpperCase())<0)return;
    const sec=String(r[1]||'').trim().toUpperCase();
    out[sec]={songTitle:String(r[2]||'').trim(),songKey:String(r[3]||'').trim(),capo:String(r[4]||'').trim(),versionNote:String(r[5]||'').trim(),linkUrl:String(r[6]||'').trim(),linkTitle:String(r[7]||'').trim(),lastUpdatedAt:reg_clientSafeDateTime_(r[8]),lastUpdatedBy:String(r[9]||'').trim().toUpperCase()};
  });
  return out;
}
function pgccPlanData_(actor, ev){
  const sermon = admin_getSermonRecordByEventKey_(ev);
  const songMap = pgccReadWorshipMap_(ev);
  const values = admin_getServingValuesForEvent_(ev);
  const mi = admin_getMembersIndex_();
  const role = String(actor.role || '');
  const member = mi.byId[actor.id] || {};
  const canSongs = role !== 'VIEWER' && (member.servingGroups || []).concat(member.servingGLGroups || []).some(function(g){return admin_normalizeServingGroup_(g) === 'worship';});
  const positions = ADMIN_SERVING_POSITIONS.map(function(pos){
    const group = admin_normalizeServingGroup_(ADMIN_SERVING_POSITION_GROUP[pos]);
    return {position:pos,group:group,label:admin_servingPositionZh_(pos)+' / '+admin_servingPositionLabel_(pos),value:values[pos] || '',canEdit:role !== 'VIEWER' && admin_canEditServingGroup_(actor,group)};
  });
  const assigned={};positions.forEach(function(p){admin_extractMemberIdsFromServingValue_(p.value).forEach(function(id){assigned[id]=true;});});
  const members = Object.keys(mi.byId).filter(function(id){return assigned[id] || positions.some(function(p){return p.canEdit;});}).map(function(id){const m=mi.byId[id];return {id:id,name:[m.displayNameZh || m.nameZh,m.nameEn].filter(Boolean).join(' / '),groups:(m.servingGroups || []).concat(m.servingGLGroups || [])};});
  return {ok:true,eventKey:ev,sermon:sermon,songs:songMap,positions:positions,members:members,
    canSermon:['STAFF','DEACON','ADMIN','SUPERUSER'].indexOf(role)>=0,canSongs:canSongs,
    revision:pgccPlanRevision_({sermon:sermon,songs:songMap,values:values})};
}
function api_service_plan(token, eventKey, kind){
  const s=pgccPlanAuth_(token,kind); if(!s.ok)return s;
  const events=admin_getUpcomingSundayEventKeys_(admin_todayUkYmd_(),6);
  const ev=String(eventKey || (events[0] || {}).eventKey || '');
  if(!admin_isSundayServiceKey_(ev))return {ok:false,code:'E416'};
  const data=pgccPlanData_(s.actor,ev); data.events=events;
  return data;
}
function api_service_plan_save(token, eventKey, revision, section, payload, kind){
  const s=pgccPlanAuth_(token,kind); if(!s.ok)return s;
  if(!admin_isSundayServiceKey_(eventKey))return {ok:false,code:'E416'};
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    const current=pgccPlanData_(s.actor,eventKey);
    if(!revision || revision!==current.revision)return {ok:false,code:'E409',en:'Another edit was saved. Reload before saving your changes.',zh:'資料已被更改，請重新載入再儲存。'};
    if(section==='sermon'){
      if(!current.canSermon)return {ok:false,code:'E403'};
      pgccRequireSheet_(admin_openSs_(),ADMIN_SERMON_SHEET_NAME,['EventKey','Speaker','SermonTitle','SermonPassageRaw','SermonPassageCanonical','SermonPassageStatus','ResponsePassageRaw','ResponsePassageCanonical','ResponsePassageStatus','UpdatedAt','UpdatedBy','UpdatedRole','ResponseSpeaker']);
      const r=admin_saveSermonUnlocked_(admin_newSession_(s.actor),Object.assign({},payload,{eventKey:eventKey})); if(!r.ok)return r;
    }else if(section==='song'){
      if(!current.canSongs)return {ok:false,code:'E403'};
      pgccRequireSheet_(reg_openSsForWorship_(),REG_WORSHIP_PLANNING_SHEET,['EventKey','SongSection','SongTitle','SongKey','Capo','VersionNote','LinkUrl','LinkTitle','LastUpdatedAt','LastUpdatedByCCFID']);
      pgccRequireSheet_(reg_openSsForWorship_(),REG_WORSHIP_AUDIT_SHEET,['Timestamp','ActorCCFID','EventKey','Area','FieldName','OldValue','NewValue','ActionSource','Context']);
      const auth=regGetSelfMemberByIdForAdmin_(s.actor.id);if(!auth.ok)return auth;
      const r=reg_saveWorshipSongUnlocked_(auth,Object.assign({},payload,{eventKey:eventKey}),'SERVICE_PLAN'); if(!r.ok)return r;
    }else if(section==='rota'){
      if(['GL','STAFF','DEACON','ADMIN','SUPERUSER'].indexOf(s.actor.role)<0)return {ok:false,code:'E403'};
      const serving=pgccRequireSheet_(admin_openSs_(),ADMIN_SERVING_SHEET_NAME);
      const map=admin_getServingMatrixHeaderMap_(serving);
      if((payload.rows||[]).some(function(row){return !map[row.position];}))return {ok:false,code:'E_SCHEMA_APPROVAL',en:'The requested Serving column is missing.',zh:'所需的 Serving 欄位不存在。'};
      const r=admin_saveServingEventUnlocked_(admin_newSession_(s.actor),eventKey,payload.rows,false,payload.group,payload.override || null);
      if(!r.ok)return r;
    }else return {ok:false,code:'E416'};
    try{const cache=CacheService.getScriptCache();cache.remove('reg_live_sermon_'+eventKey);cache.remove('reg_live_worship_'+eventKey);cache.remove('liveNames_'+eventKey);}catch(e){}
    return api_service_plan(token,eventKey,kind);
  }finally{lock.releaseLock();}
}
/* ===== END OF Pgcc.gs (COMPLETE) ===== */
