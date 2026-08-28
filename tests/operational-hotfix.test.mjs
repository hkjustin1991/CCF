import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), 'utf8');

function appsScriptContext(extra = {}) {
  const cache = { get(){ return null; }, put(){}, remove(){} };
  return vm.createContext({
    console,
    Date,
    JSON,
    Math,
    Set,
    Map,
    Array,
    String,
    Number,
    Object,
    RegExp,
    Error,
    Promise,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
    CacheService: { getScriptCache(){ return cache; } },
    ...extra
  });
}

test('serving events are appended when historical rows leave no blanks', () => {
  const writes = [];
  const sheet = {
    getLastRow(){ return 4; },
    getMaxRows(){ return 100; },
    getRange(row, col, rows){
      if (row === 2 && col === 1 && rows === 3){
        return {
          getValues(){
            return [
              ['SundayService_2026-05-03'],
              ['SundayService_2026-05-10'],
              ['SundayService_2026-05-17']
            ];
          }
        };
      }
      return {
        setValues(values){ writes.push({ row, col, rows, values }); }
      };
    },
    insertRowsAfter(){ throw new Error('unexpected row expansion'); }
  };
  const context = appsScriptContext({
    Utilities:{ formatDate(){ return '2026-08-06'; } }
  });
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });
  context.admin_getUpcomingSundayEventKeys_ = () => [
    { eventKey:'SundayService_2026-10-04' },
    { eventKey:'SundayService_2026-10-11' },
    { eventKey:'SundayService_2026-10-18' }
  ];
  context.admin_ensureServingEventKeys_(sheet);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{
    row:5,
    col:1,
    rows:3,
    values:[
      ['SundayService_2026-10-04'],
      ['SundayService_2026-10-11'],
      ['SundayService_2026-10-18']
    ]
  }]);
});

test('Live login message and emergency field are outside the hidden camera panel', () => {
  const html = read('index.html');
  const login = html.slice(html.indexOf('function viewLogin()'), html.indexOf('function viewMenu()'));
  assert.ok(login.includes("'<div id=\"loginCam\" class=\"card hide\""));
  assert.ok(login.includes("'</div>'+\n          '<div class=\"divider\">"));
  assert.ok(!login.includes("'</details>'+"));
  assert.ok(login.includes('id="internalField"'));
  assert.ok(login.includes('id="msg" role="alert" aria-live="assertive"'));
});

test('four-function mobile portal is opt-in and keeps the classic portal as the default', () => {
  const html = read('index.html');
  const menu = html.slice(html.indexOf('function viewMenu()'), html.indexOf('function mobileSubviewHeader_'));
  const mobile = html.slice(html.indexOf('function viewMobileHome()'), html.indexOf('function viewCheckinMenu()'));
  const eventKeyHelper = html.slice(html.indexOf('function ensureEventKey_'), html.indexOf('var SERVING_GROUP_LABELS'));

  assert.ok(html.includes("view:'login'"));
  assert.ok(menu.includes('id="goMobileCheckin"'));
  assert.ok(menu.includes('id="goCheckin"'));
  assert.ok(mobile.includes('id="mobileClassic"'));
  assert.ok(mobile.includes('class="mobileMenuGrid"'));
  assert.equal((mobile.match(/class="[^"]*mobileMenuTile/g) || []).length, 4);
  assert.ok(mobile.includes('id="mobileGoScan"'));
  assert.ok(mobile.includes('id="mobileGoManual"'));
  assert.ok(mobile.includes('id="mobileGoLive"'));
  assert.ok(mobile.includes('id="mobileGoVrm"'));
  assert.ok(mobile.includes('id="mobileStartScan"'));
  assert.ok(html.includes("App.view==='mobileHome'"));
  assert.ok(html.includes("App.view==='mobileManual'"));
  assert.ok(html.includes("App.view==='mobileLive'"));
  assert.ok(html.includes("App.view==='mobileVrm'"));
  assert.ok(html.includes("App.view='menu'; render();"));
  assert.ok(html.includes('body.mobilePortalUi .topbar'));
  assert.ok(html.includes('--mobile-tile-size:min(calc((100vw - 34px)/2), calc((100dvh - 156px)/2))'));
  assert.ok(eventKeyHelper.includes("callApi('api_get_checkin_context'"));
  assert.ok(!eventKeyHelper.includes("callApi('api_get_live_page'"));
});

test('mobile scanner returns by same-tab POST while classic opener messaging remains available', () => {
  const liveBackend = read('Code.gs');
  const liveUi = read('index.html');
  const scanner = read('scanner/scanner.js');

  assert.ok(liveUi.includes("returnMode:'post'"));
  assert.ok(liveUi.includes("link.target = '_top'"));
  assert.ok(liveUi.includes("sessionStorage.setItem(MOBILE_SCAN_STATE_KEY, state)"));
  assert.ok(liveUi.includes("returnedState !== expectedState"));
  assert.ok(scanner.includes("form.method = 'POST'"));
  assert.ok(scanner.includes("form.target = '_top'"));
  assert.ok(scanner.includes("scannerReturn:'1'"));
  assert.ok(scanner.includes("postReturn('CCF_QR_RESULT', payload)"));
  assert.ok(scanner.includes('window.opener.postMessage(message, safeOrigin())'));
  assert.ok(!liveUi.includes("target.searchParams.set('payload'"));
  assert.ok(liveBackend.includes('const scannerReturn = scannerReturnFromPost_(e);'));
  assert.ok(liveBackend.includes('if (scannerReturn) return renderLivePortal_(scannerReturn);'));
});

test('scanner POST handoff only accepts the mobile check-in route and valid QR data', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Code.gs'), context, { filename:'Code.gs' });
  const state = '0123456789abcdef0123456789abcdef';
  const valid = context.scannerReturnFromPost_({ parameter:{
    scannerReturn:'1', type:'CCF_QR_RESULT', state, flow:'checkin', returnView:'mobileScan', payload:'CCF0137|kYannie'
  }});
  assert.deepEqual(JSON.parse(JSON.stringify(valid)), {
    type:'CCF_QR_RESULT', state, flow:'checkin', returnView:'mobileScan', payload:'CCF0137|kYannie'
  });
  const invalid = context.scannerReturnFromPost_({ parameter:{
    scannerReturn:'1', type:'CCF_QR_RESULT', state, flow:'checkin', returnView:'mobileScan', payload:'not-a-member-qr'
  }});
  assert.equal(invalid.type, 'CCF_QR_ERROR');
  assert.equal(invalid.payload, undefined);
  assert.equal(context.scannerReturnFromPost_({ parameter:{} }), null);
});

test('Delete check-in reauthentication always binds a scan action', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="btnScanUndo"'));
  assert.ok(html.includes('btnScanUndo.onclick = function()'));
  assert.ok(html.includes("externalFlow:'undo_checkin'"));
  assert.ok(!html.includes("camBindSwitchButton_('btnSwitchCamUndo'"));
});

test('Bible short-book lookup uses the supplied book key', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });
  assert.equal(context.bible_bookShortZhByKey_('JHN'), '約');
  assert.equal(context.bible_bookShortZhByKey_('jhn'), '約');
  assert.equal(context.bible_bookShortZhByKey_('GEN'), '創');
});

test('Member column map is available and PENDING promotion writes ACTIVE', () => {
  const writes = [];
  const sheet = {
    getLastColumn(){ return 3; },
    getLastRow(){ return 2; },
    getRange(row, col){
      if (row === 1) return { getValues(){ return [['ID', 'Status', 'RoleExpires']]; } };
      return {
        getValues(){ return [['CCF0123']]; },
        setValue(value){ writes.push({ row, col, value }); }
      };
    }
  };
  const context = appsScriptContext({
    SpreadsheetApp:{},
    PropertiesService:{ getScriptProperties(){ return { getProperty(){ return ''; } }; } },
    Utilities:{},
    ContentService:{},
    HtmlService:{},
    LockService:{},
    MailApp:{},
    getMembersSheet_(){ return sheet; }
  });
  vm.runInContext(read('Code.gs'), context, { filename:'Code.gs' });
  context.getMembersSheet_ = () => sheet;
  const cols = context.getMembersColMap_(sheet);
  assert.deepEqual({ ...cols }, { ID:0, Status:1, RoleExpires:2 });
  assert.equal(context.promotePendingMemberToActive_({ id:'CCF0123', status:'PENDING', rowNumber:2 }), true);
  assert.deepEqual(writes, [{ row:2, col:2, value:'ACTIVE' }]);
});

test('an existing check-in self-heals a member formerly stuck in PENDING', () => {
  const context = appsScriptContext({
    SpreadsheetApp:{},
    PropertiesService:{ getScriptProperties(){ return { getProperty(){ return ''; } }; } },
    Utilities:{},
    ContentService:{},
    HtmlService:{},
    LockService:{ getScriptLock(){ return { waitLock(){}, releaseLock(){} }; } },
    MailApp:{}
  });
  vm.runInContext(read('Code.gs'), context, { filename:'Code.gs' });
  let promoted = 0;
  context.requireSession_ = () => ({ ok:true, sess:{ staff:{ id:'CCF0001', nameZh:'', nameEn:'' } } });
  context.getMembersIndex_ = () => ({ byId:{ CCF0123:{ id:'CCF0123', key:'k123', status:'PENDING', nameZh:'測試', nameEn:'Test' } } });
  context.getCheckinsSheet_ = () => ({});
  context.getCheckinHistoryIndex_ = () => ({ lastRow:2, firstEventById:{ CCF0123:'SundayService_2026-08-02' }, currentById:{} });
  context.findExistingCheckin_ = () => ({ eventKey:'SundayService_2026-08-02', timeUk:'13:00:00' });
  context.getDefaultEventKey_ = () => 'SundayService_2026-08-02';
  context.promotePendingMemberToActive_ = () => { promoted += 1; return true; };
  context.classifyNewFriend_ = () => ({ isNewFriend:true, reason:'FIRST_EVENT' });
  const result = context.api_checkin_scan('token', 'CCF0123|k123', null, '', '');
  assert.equal(result.ok, true);
  assert.equal(result.result, 'ALREADY');
  assert.equal(result.status, 'ACTIVE');
  assert.equal(promoted, 1);
});

test('check-in history index reuses one whole-sheet read until the row count changes', () => {
  const values = [
    [new Date('2026-08-02T12:00:00Z'), 'SundayService_2026-08-02', 'CCF0101', '甲', 'One', 'scan', 'CCF0001', '同工', 'Staff', 'R1', 'one@example.com', 'SENT'],
    [new Date('2026-08-09T12:05:00Z'), 'SundayService_2026-08-09', 'CCF0101', '甲', 'One', 'scan', 'CCF0001', '同工', 'Staff', 'R2', 'one@example.com', 'SENT']
  ];
  let lastRow = 3;
  let historyReads = 0;
  const cacheValues = new Map();
  const cache = {
    get(key){ return cacheValues.has(key) ? cacheValues.get(key) : null; },
    put(key, value){ cacheValues.set(key, value); },
    remove(key){ cacheValues.delete(key); }
  };
  const sheet = {
    getLastRow(){ return lastRow; },
    getRange(row, col, rows, cols){
      assert.deepEqual([row, col, rows, cols], [2, 1, lastRow - 1, 12]);
      return { getValues(){ historyReads += 1; return values.slice(); } };
    }
  };
  const context = appsScriptContext({
    SpreadsheetApp:{},
    PropertiesService:{ getScriptProperties(){ return { getProperty(){ return ''; } }; } },
    Utilities:{ formatDate(date, zone, pattern){
      assert.equal(zone, 'Europe/London');
      return pattern === 'HH:mm:ss' ? date.toISOString().slice(11, 19) : '2026-08-09';
    } },
    ContentService:{}, HtmlService:{}, LockService:{}, MailApp:{},
    CacheService:{ getScriptCache(){ return cache; } }
  });
  vm.runInContext(read('Code.gs'), context, { filename:'Code.gs' });

  const first = context.getCheckinHistoryIndex_(sheet, 'SundayService_2026-08-09');
  const second = context.getCheckinHistoryIndex_(sheet, 'SundayService_2026-08-09');
  assert.equal(historyReads, 1);
  assert.equal(first.firstEventById.CCF0101, 'SundayService_2026-08-02');
  assert.equal(second.currentById.CCF0101.existing.receiptId, 'R2');

  values.push([new Date('2026-08-09T12:06:00Z'), 'SundayService_2026-08-09', 'CCF0102', '乙', 'Two', 'scan', 'CCF0001', '同工', 'Staff', 'R3', '', 'NO_EMAIL']);
  lastRow = 4;
  const rebuilt = context.getCheckinHistoryIndex_(sheet, 'SundayService_2026-08-09');
  assert.equal(historyReads, 2);
  assert.equal(rebuilt.currentById.CCF0102.existing.receiptId, 'R3');
});

test('valid PROVISIONAL QR login survives an optional snapshot failure', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Reg.gs'), context, { filename:'Reg.gs' });
  context.api_reg_self_lookup_public = () => ({
    ok:true,
    member:{ id:'CCF0099', status:'PROVISIONAL', nameZh:'暫準', nameEn:'Provisional' }
  });
  context.api_reg_self_portal_snapshot_public = () => ({
    ok:false,
    code:'E_SNAPSHOT',
    zh:'附加資料失敗',
    en:'Optional snapshot failed.'
  });
  const result = context.api_reg_self_bootstrap_public('CCF0099|k-test');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.partial, true);
  assert.equal(result.snapshot.member.status, 'PROVISIONAL');
  assert.equal(result.warning.code, 'E_SNAPSHOT');
});

test('PENDING UI hides serving and holiday information and controls', () => {
  const html = read('Reg2.html');
  assert.ok(html.includes("(isPending ? '' : ("));
  assert.ok(html.includes("(!isPending ? '<button id=\"btnSelfServing\""));
  assert.ok(html.includes("(!isPending ? '<button id=\"btnSelfHoliday\""));
  assert.ok(html.includes('if (!holidayBtn && !isPending)'));
});

test('GL/STAFF duplicate conflict carries reason, positions and date', () => {
  const backend = read('Admin.gs');
  const ui = read('Admin2.html');
  assert.ok(backend.includes('duplicates:duplicateDetails'));
  assert.ok(backend.includes('dateYmd:eventDateYmd'));
  assert.ok(backend.includes('canOverride:false'));
  assert.ok(ui.includes('原因 / Reason:'));
  assert.ok(ui.includes('已安排 / Already assigned:'));
  assert.ok(ui.includes('嘗試安排 / Trying to assign:'));
  assert.ok(ui.includes("res2.subCode === 'DUPLICATE_ASSIGNMENT' && !res2.canOverride"));
});

test('group-member serving summary is independent of attendance date limits', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });
  let audited = false;
  let actorRole = 'STAFF';
  context.admin_requireSession_ = () => ({ ok:true, actor:{ id:'CCF0001', role:actorRole, glGroups:['MEDIA'] } });
  context.admin_normalizeServingGroup_ = value => String(value || '').trim().toLowerCase();
  context.admin_getMembersIndex_ = () => ({
    byId:{
      CCF0123:{
        id:'CCF0123', nameZh:'測試', nameEn:'Test', preferredName:'Tester',
        status:'ACTIVE', servingGroups:['MEDIA'], servingGLGroups:[]
      }
    }
  });
  context.admin_memberHasServingGroup_ = () => true;
  context.admin_getServingInsightsForMember_ = id => ({ byGroup:{ media:{ memberId:id } } });
  context.admin_audit_ = () => { audited = true; };
  context.admin_validateRange_ = () => { throw new Error('attendance range must not be consulted'); };

  const result = context.api_admin_serving_group_member_summary('token', 'media', 'CCF0123');
  assert.equal(result.ok, true);
  assert.equal(result.member.id, 'CCF0123');
  assert.equal(result.canManage, true);
  assert.equal(result.servingInsights.byGroup.media.memberId, 'CCF0123');
  assert.equal(audited, true);

  actorRole = 'GL';
  const glResult = context.api_admin_serving_group_member_summary('token', 'media', 'CCF0123');
  assert.equal(glResult.ok, true);

  const ui = read('Admin2.html');
  const flow = ui.slice(
    ui.indexOf('function openServingGroupMemberSummary_'),
    ui.indexOf('function loadServingGroupMembers_')
  );
  assert.ok(flow.includes("callApi('api_admin_serving_group_member_summary', App.token, groupKey, memberId)"));
  assert.ok(!flow.includes("callApi('api_admin_member_detail'"));
  assert.ok(flow.includes('btnCloseMemberSummaryError'));
  assert.ok(ui.includes('function clampAppDateRangeForRole_()'));
  assert.ok(ui.includes('if(App.actor) clampAppDateRangeForRole_();'));
  const showErrFlow = ui.slice(ui.indexOf('function showErr('), ui.indexOf('function bindGasRetryButton_'));
  assert.ok(showErrFlow.includes("code:String(res.code || 'E500')"));
  assert.ok(showErrFlow.includes("renderMsg_(targetId, 'err'"));
  assert.ok(!showErrFlow.includes('withErrorCodeTag_(titles.zh'));

  const clampSource = ui.slice(
    ui.indexOf('function clampAppDateRangeForRole_()'),
    ui.indexOf('function displayMemberStatusLabel')
  );
  const clampContext = vm.createContext({
    App:{ actor:{ role:'STAFF' }, from:'2026-01-11', to:'2026-08-07' },
    Date,
    getTodayYmdUk(){ return '2026-08-07'; },
    parseYmd(value){
      const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return match ? new Date(Date.UTC(+match[1], +match[2]-1, +match[3])) : null;
    },
    maxDaysForRole(){ return 181; },
    daysBetween(a, b){ return Math.floor((b.getTime() - a.getTime()) / 86400000); }
  });
  vm.runInContext(clampSource, clampContext);
  clampContext.clampAppDateRangeForRole_();
  assert.equal(clampContext.App.from, '2026-02-08');
});

test('GL STAFF DEACON and ADMIN group-membership controls follow one permission policy', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });

  assert.equal(context.admin_canManageServingGroupMembership_({ role:'STAFF' }, 'media'), true);
  assert.equal(context.admin_canManageServingGroupMembership_({ role:'DEACON' }, 'finance'), true);
  assert.equal(context.admin_canManageServingGroupMembership_({ role:'ADMIN' }, 'finance'), true);
  assert.equal(context.admin_canManageServingGroupMembership_({ role:'GL', glGroups:['MEDIA'] }, 'media'), true);
  assert.equal(context.admin_canManageServingGroupMembership_({ role:'GL', glGroups:['MEDIA'] }, 'logistic'), false);
  assert.equal(context.admin_canManageServingGroupTarget_({ role:'STAFF' }, { status:'ACTIVE' }), true);
  assert.equal(context.admin_canManageServingGroupTarget_({ role:'STAFF' }, { status:'STAFF' }), false);
  assert.equal(context.admin_canManageServingGroupTarget_({ role:'STAFF' }, { status:'DEACON' }), false);
  assert.equal(context.admin_canManageServingGroupTarget_({ role:'DEACON' }, { status:'ADMIN' }), true);
  assert.equal(context.admin_canManageServingGroupTarget_({ role:'ADMIN' }, { status:'STAFF' }), true);

  let actor = { id:'CCF0001', role:'STAFF', glGroups:[] };
  let target = { id:'CCF0123', status:'ACTIVE', rowNumber:2 };
  let cellValue = '';
  let writeCount = 0;
  const sheet = {
    getRange(){
      return {
        getValue(){ return cellValue; },
        setValue(value){ cellValue = value; writeCount += 1; }
      };
    }
  };
  context.admin_requireSession_ = () => ({ ok:true, actor });
  context.admin_getMembersIndex_ = () => ({ byId:{ CCF0123:target } });
  context.admin_findMembersSheet_ = () => sheet;
  context.admin_getMembersColMap_ = () => ({ ServingGroups:5 });
  context.admin_parseGroupsCsv_ = value => String(value || '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
  context.admin_clearMembersCache_ = () => {};
  context.admin_audit_ = () => {};
  context.admin_parseQrStrict_ = () => ({ ok:true, id:'CCF0123' });

  const staffAdd = context.api_admin_serving_group_member_update('token', 'media', 'CCF0123', 'ADD', '');
  assert.equal(staffAdd.ok, true);
  assert.equal(staffAdd.changed, true);
  assert.equal(cellValue, 'MEDIA');

  const duplicateAdd = context.api_admin_serving_group_member_update('token', 'media', 'CCF0123', 'ADD', '');
  assert.equal(duplicateAdd.ok, true);
  assert.equal(duplicateAdd.changed, false);
  assert.equal(writeCount, 1);

  target.status = 'STAFF';
  cellValue = '';
  const staffBlocked = context.api_admin_serving_group_member_update('token', 'media', 'CCF0123', 'ADD', '');
  assert.equal(staffBlocked.ok, false);
  assert.equal(staffBlocked.code, 'E403');

  actor = { id:'CCF0002', role:'ADMIN', glGroups:[] };
  const adminAdd = context.api_admin_serving_group_member_update('token', 'media', 'CCF0123', 'ADD', '');
  assert.equal(adminAdd.ok, true);

  actor = { id:'CCF0003', role:'GL', glGroups:['MEDIA'] };
  target.status = 'ACTIVE';
  cellValue = '';
  const glOwnGroup = context.api_admin_serving_group_member_update('token', 'media', '', 'ADD', 'CCF0123|key');
  assert.equal(glOwnGroup.ok, true);
  const glOtherGroup = context.api_admin_serving_group_member_update('token', 'logistic', '', 'ADD', 'CCF0123|key');
  assert.equal(glOtherGroup.ok, false);
  assert.equal(glOtherGroup.code, 'E403');

  const ui = read('Admin2.html');
  const addFlow = ui.slice(
    ui.indexOf('function renderGroupMemberManage_'),
    ui.indexOf('function openServingGroupMemberSummary_')
  );
  assert.ok(addFlow.includes("role === 'STAFF' || role === 'DEACON' || role === 'ADMIN' || role === 'SUPERUSER'"));
  assert.ok(addFlow.includes('id="addMemberMsg"'));
  assert.ok(addFlow.includes('STAFF 可管理所有組別的一般會員；STAFF／DEACON／ADMIN 帳戶只可由 DEACON／ADMIN 修改。<br/>STAFF may manage ordinary members in all groups; only DEACON/ADMIN may change STAFF/DEACON/ADMIN accounts.'));
  assert.ok(addFlow.includes('GL must scan target member QR to authorise adding member.'));
  assert.ok(!addFlow.includes("showErr('app', r"));
  assert.ok(ui.includes("(res.canManage ? '<button id=\"btnRemoveThisGroup\""));
});

test('DEACON is distinct in data and receives ADMIN-level access across every portal', () => {
  const live = appsScriptContext();
  vm.runInContext(read('Code.gs'), live, { filename:'Code.gs' });
  assert.equal(live.isAdminLevel_('DEACON'), true);
  assert.equal(live.isPrivilegedStaff_('DEACON'), true);
  assert.equal(vm.runInContext("ALLOWED_STATUSES_FOR_CHECKIN.includes('DEACON')", live), true);
  assert.equal(vm.runInContext("ALLOWED_STATUSES_FOR_PORTAL.includes('DEACON')", live), true);

  const admin = appsScriptContext();
  vm.runInContext(read('Admin.gs'), admin, { filename:'Admin.gs' });
  assert.equal(admin.admin_isAdminStatus_('DEACON'), true);
  assert.equal(admin.admin_isAdminActorRole_('DEACON'), true);
  assert.equal(admin.admin_validateRange_({ role:'DEACON' }, '2026-01-01', '2026-12-31').ok, true);
  admin.admin_parseQrStrict_ = () => ({ ok:true, id:'CCF0101', key:'secret' });
  admin.admin_getMembersIndex_ = () => ({ byId:{ CCF0101:{ id:'CCF0101', key:'secret', status:'DEACON' } } });
  assert.equal(admin.admin_verifyReauth_({ id:'SUPERUSER', role:'SUPERUSER' }, 'qr').ok, true);
  assert.equal(admin.admin_verifyReauth_({ id:'CCF0101', role:'DEACON' }, 'qr').ok, true);

  const reg = appsScriptContext();
  vm.runInContext(read('Reg.gs'), reg, { filename:'Reg.gs' });
  assert.equal(reg.regIsAdminLevel_('DEACON'), true);
  assert.equal(reg.regIsStaffLevel_('DEACON'), true);
  assert.equal(reg.reg_selfCanAccessAdminPortal_('DEACON', []), true);

  assert.ok(read('index.html').includes("st === 'DEACON'"));
  assert.ok(read('Admin2.html').includes("r === 'DEACON' || r === 'ADMIN' || r === 'SUPERUSER'"));
  assert.ok(read('Reg2.html').includes("DEACON:{ zh:'執事', en:'DEACON' }"));
});

test('New Friend remains event-level through rescans and ends on handling or the next event', () => {
  const context = appsScriptContext({
    SpreadsheetApp:{},
    PropertiesService:{ getScriptProperties(){ return { getProperty(){ return ''; } }; } },
    Utilities:{}, ContentService:{}, HtmlService:{}, LockService:{}, MailApp:{}
  });
  vm.runInContext(read('Code.gs'), context, { filename:'Code.gs' });
  let suppressed = false;
  context.isNewFriendSuppressed_ = () => suppressed;

  const first = context.classifyNewFriendFromFirstEvent_('SundayService_2026-08-09', 'CCF0101', 'ACTIVE', 'SundayService_2026-08-09');
  const rescan = context.classifyNewFriendFromFirstEvent_('SundayService_2026-08-09', 'CCF0101', 'ACTIVE', 'SundayService_2026-08-09');
  const next = context.classifyNewFriendFromFirstEvent_('SundayService_2026-08-16', 'CCF0101', 'ACTIVE', 'SundayService_2026-08-09');
  const staff = context.classifyNewFriendFromFirstEvent_('SundayService_2026-08-09', 'CCF0001', 'STAFF', 'SundayService_2026-08-09');
  assert.equal(first.isNewFriend, true);
  assert.equal(rescan.isNewFriend, true);
  assert.equal(next.isNewFriend, false);
  assert.equal(next.reason, 'PRIOR_ATTENDANCE');
  assert.equal(staff.isNewFriend, false);
  assert.equal(staff.reason, 'STAFF_EXCLUDED');

  suppressed = true;
  const handled = context.classifyNewFriendFromFirstEvent_('SundayService_2026-08-09', 'CCF0101', 'ACTIVE', 'SundayService_2026-08-09');
  assert.equal(handled.isNewFriend, false);
  assert.equal(handled.reason, 'SUPPRESSED');

  const sheet = {
    getLastRow(){ return 5; },
    getRange(){ return { getValues(){ return [
      ['SundayService_2026-08-16','CCF0101'],
      ['SundayService_2026-08-09','CCF0101'],
      ['SundayService_2026-08-02','CCF0999'],
      ['SundayService_2026-08-23','CCF0101']
    ]; } }; }
  };
  assert.equal(context.firstAttendedEventForMember_(sheet, 'ccf0101'), 'SundayService_2026-08-09');
});

test('young volunteers require approval, Logistics and an adult in the exact position', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });
  const child = {
    id:'CCF0101', status:'ACTIVE', isMinor:true, familyId:'FAM-1',
    minorServingApprovedGroups:['LOGISTIC'], minorServingSelfSignup:true
  };
  const sameFamilyAdult = { id:'CCF0102', status:'ACTIVE', isMinor:false, familyId:'FAM-1' };
  const otherAdult = { id:'CCF0103', status:'ACTIVE', isMinor:false, familyId:'FAM-2' };
  const members = { CCF0101:child, CCF0102:sameFamilyAdult, CCF0103:otherAdult };

  let result = context.admin_validateMinorServingValues_({ Logistic_Welcome:'CCF0101' }, members, ['Logistic_Welcome']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MINOR_ADULT_PAIR_REQUIRED');

  result = context.admin_validateMinorServingValues_({ Logistic_Welcome:'CCF0101, CCF0102' }, members, ['Logistic_Welcome']);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 0);

  result = context.admin_validateMinorServingValues_({ Logistic_Welcome:'CCF0101, CCF0103' }, members, ['Logistic_Welcome']);
  assert.equal(result.ok, true);
  assert.equal(result.warnings[0].code, 'MINOR_DIFFERENT_FAMILY_ADULT');

  result = context.admin_validateMinorServingValues_({ Media_AV:'CCF0101, CCF0102' }, members, ['Media_AV']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MINOR_GROUP_NOT_ALLOWED');

  child.minorServingApprovedGroups = [];
  result = context.admin_validateMinorServingValues_({ Logistic_Venue:'CCF0101, CCF0102' }, members, ['Logistic_Venue']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'MINOR_NOT_APPROVED');
});

test('Logistics overview uses 8-week children and gaps with rolling 26-week activity', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });
  const members = [
    { id:'CCF0101', status:'ACTIVE', nameEn:'Child', isMinor:true, familyId:'FAM-1', servingGroups:['LOGISTIC'], servingGLGroups:[] },
    { id:'CCF0102', status:'ACTIVE', nameEn:'Parent', isMinor:false, familyId:'FAM-1', servingGroups:['LOGISTIC'], servingGLGroups:[] },
    { id:'CCF0103', status:'ACTIVE', nameEn:'Volunteer', isMinor:false, familyId:'FAM-2', servingGroups:['LOGISTIC'], servingGLGroups:[] },
    { id:'CCF0104', status:'ACTIVE', nameEn:'Idle Member', isMinor:false, familyId:'', servingGroups:['LOGISTIC'], servingGLGroups:[] }
  ];
  const byId = Object.fromEntries(members.map(member => [member.id, member]));
  const rows = [
    ['SundayService_2026-08-09','CCF0102'],
    ['SundayService_2026-08-16','CCF0101, CCF0102'],
    ['SundayService_2026-08-23','CCF0101, CCF0103'],
    ['SundayService_2026-08-30',''],
    ['SundayService_2026-10-18','CCF0101, CCF0102']
  ];
  const sheet = {
    getLastRow(){ return rows.length + 1; },
    getLastColumn(){ return 2; },
    getRange(){ return { getValues(){ return rows; } }; }
  };
  context.admin_getMembersIndex_ = () => ({ all:members, byId });
  context.admin_getServingSheet_ = () => sheet;
  context.admin_getServingMatrix_ = () => ({ positions:[{ group:'logistic', position:'Logistic_Welcome', colIndex:2 }] });
  const result = context.admin_buildServingGroupOverview_('2026-08-11').byGroup.logistic;
  assert.equal(result.upcomingChildren.length, 2);
  assert.equal(result.upcomingChildren[0].sameFamilyAdult, true);
  assert.equal(result.upcomingChildren[1].sameFamilyAdult, false);
  assert.equal(result.upcomingChildren.some(row => row.dateYmd === '2026-10-18'), false);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].dateYmd, '2026-08-30');
  assert.equal(result.activity.top[0].memberId, 'CCF0102');
  assert.equal(result.activity.bottom.some(row => row.memberId === 'CCF0104' && row.count === 0), true);
});

test('family registration enforces the four-record email cap and labels independent rows', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Reg.gs'), context, { filename:'Reg.gs' });
  const ms = {
    dataRows:[
      { Status:'ACTIVE', Email:'family@example.com', NameZh:'一', NameEn:'One' },
      { Status:'PENDING', Email:'family@example.com', NameZh:'二', NameEn:'Two' },
      { Status:'ACTIVE', Email:'family@example.com', NameZh:'三', NameEn:'Three' },
      { Status:'DISABLED', Email:'family@example.com', NameZh:'停', NameEn:'Disabled' }
    ]
  };
  const batch = [
    { email:'family@example.com', nameZh:'四', nameEn:'Four' },
    { email:'family@example.com', nameZh:'五', nameEn:'Five' }
  ];
  const blocked = context.regEnforceFamilyBatchHardStops_(ms, batch);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E452');
  assert.equal(context.regEnforceFamilyBatchHardStops_(ms, batch.slice(0, 1)).ok, true);

  const headers = ['FamilyID','MemberLetter','ID','Key','Status','IsMinor','MinorServingApprovedGroups','MinorServingSelfSignup'];
  const col = Object.fromEntries(headers.map((header, index) => [header, index]));
  const row = context.regBuildAppendRow_({ lastCol:headers.length, col }, {
    familyId:'FAM-XYZ', memberLetter:'B', id:'CCF0102', key:'k2', status:'PENDING', isMinor:true
  });
  assert.deepEqual(Array.from(row), ['FAM-XYZ','B','CCF0102','k2','PENDING','YES','','NO']);
});

test('family registration sends one combined email with labelled QR attachments', () => {
  let sent = null;
  const context = appsScriptContext({
    MailApp:{
      getRemainingDailyQuota(){ return 20; },
      sendEmail(message){ sent = message; }
    }
  });
  vm.runInContext(read('Reg.gs'), context, { filename:'Reg.gs' });
  context.regFetchQrPngBlob_ = (payload, size, filename) => ({ payload, size, filename });
  const result = context.regSendFamilyRegistrationEmail_({
    toEmail:'family@example.com', familyId:'FAM-XYZ', members:[
      { memberId:'CCF0101', memberLetter:'A', nameZh:'甲', nameEn:'One', qrPayload:'CCF0101|k1' },
      { memberId:'CCF0102', memberLetter:'B', nameZh:'乙', nameEn:'Two', qrPayload:'CCF0102|k2' }
    ]
  });
  assert.equal(result.sentToNew, true);
  assert.equal(sent.to, 'family@example.com');
  assert.equal(sent.attachments.length, 3);
  assert.match(sent.htmlBody, /CCF0101/);
  assert.match(sent.htmlBody, /CCF0102/);
  assert.match(sent.body, /change email independently/);
});

test('a later family email change preserves identity, status and approval fields', () => {
  const writes = [];
  const context = appsScriptContext();
  vm.runInContext(read('Reg.gs'), context, { filename:'Reg.gs' });
  context.regReadRow_ = () => ({
    FamilyID:'FAM-XYZ', MemberLetter:'B', ID:'CCF0102', Key:'k2', Status:'PENDING',
    NameZh:'乙', NameEn:'Two', PreferredName:'', Email:'old@example.com', Mobile:'+447700900001',
    Notes:'', OptOutEmail:'', HasCar:'NO', VRM:'', VRM2:'', IsMinor:'YES',
    ParentEmail:'parent@example.com', Gender:'FEMALE', ReferredBy:'',
    MinorServingApprovedGroups:'LOGISTIC', MinorServingSelfSignup:'YES',
    MinorServingApprovedBy:'CCF0001', MinorServingApprovedAt:'2026-08-01T10:00:00Z',
    ServingGroups:'LOGISTIC'
  });
  context.regWriteCell_ = (ms, row, field, value) => writes.push({ field, value });
  context.regSendEmails_ = () => ({ sentToNew:true, reason:'SENT' });
  context.regLogActivity_ = () => {};
  const result = context.regApplyUpdate_({}, 2, 'CCF0102', 'PENDING', false, {
    nameZh:'乙', nameEn:'Two', preferredName:'', email:'new@example.com', mobile:'+447700900001',
    notes:'', optInEmail:true, hasCar:false, vrm:'', vrm2:'', isMinor:true,
    parentEmail:'parent@example.com', gender:'FEMALE', referredBy:''
  }, { keepExistingQr:true, deviceId:'test', ua:'node' });
  const written = Object.fromEntries(writes.map(item => [item.field, item.value]));
  assert.equal(result.qrPayload, 'CCF0102|k2');
  assert.equal(result.keepExistingQr, true);
  assert.equal(written.Status, 'PENDING');
  for (const protectedField of [
    'FamilyID','MemberLetter','ID','Key','MinorServingApprovedGroups','MinorServingSelfSignup',
    'MinorServingApprovedBy','MinorServingApprovedAt','ServingGroups'
  ]) assert.equal(Object.hasOwn(written, protectedField), false, protectedField);
});

test('all non-check-in QR confirmations expose image upload', () => {
  const liveUi = read('index.html');
  const adminUi = read('Admin2.html');
  const regUi = read('Reg2.html');
  const scannerUi = read('scanner/index.html');
  const scannerJs = read('scanner/scanner.js');
  assert.ok(liveUi.includes('id="btnUploadAuth1"'));
  assert.ok(liveUi.includes('id="btnUploadAuth2"'));
  assert.ok(liveUi.includes('id="btnUploadUndo"'));
  assert.ok(liveUi.includes("decodeQrFromImageFile_(file).then(handleScan)"));
  assert.ok(adminUi.includes("bindImageQrFallback_('msg'"));
  assert.ok(adminUi.includes("bindImageQrFallback_('targetQrMsg'"));
  assert.ok(regUi.includes('id="btnDeleteQrUpload"'));
  assert.ok(regUi.includes("decodeQrImageFile_(file).then(submitDeleteQr_)"));
  assert.ok(scannerUi.includes('id="btnUpload"'));
  assert.ok(scannerJs.includes('function decodeUploadedQr(file)'));
});

test('registration UI offers up to three family members and renders every QR', () => {
  const ui = read('Reg2.html');
  assert.ok(ui.includes('一併登記家庭成員 / Add family members'));
  assert.ok(ui.includes("[1,2,3].find"));
  assert.ok(ui.includes("out.familyMembers = Array.prototype.slice.call"));
  assert.ok(ui.includes("res.mode === 'FAMILY_CREATE'"));
  assert.ok(ui.includes("drawQr('qrTargetFamily'+index"));
  assert.ok(ui.includes('You may change your email independently; your CCF ID, current QR, Family ID, attendance and serving history are preserved.'));
});

test('member labels never degrade to only a CCF ID when names are missing', () => {
  const context = appsScriptContext();
  vm.runInContext(read('Admin.gs'), context, { filename:'Admin.gs' });
  const ui = read('Admin2.html');
  const missing = context.admin_memberLabelCompact_({ id:'CCF0199' });
  assert.equal(missing.nameFound, false);
  assert.match(missing.label, /Member name not found/);
  const child = context.admin_memberLabelCompact_({ id:'CCF0101', nameEn:'Child', isMinor:true });
  assert.match(child.label, /^🧒 CCF0101/);
  assert.doesNotMatch(ui, /row\.name\|\|row\.memberId/);
  assert.doesNotMatch(ui, /row\.label\|\|row\.memberId/);
  assert.doesNotMatch(ui, /row\.label\|\|row\.id\|\|/);
});

test('public rota requires the Script Property and has no fallback credential', () => {
  const context = appsScriptContext({
    PropertiesService:{
      getScriptProperties(){
        return { getProperty(){ return ''; } };
      }
    }
  });
  vm.runInContext(read('Reg.gs'), context, { filename:'Reg.gs' });
  assert.equal(context.reg_getPublicRotaPassword_(), '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.api_public_rota_view('', 8))),
    {
      ok:false,
      code:'E503_ROTA_PASSWORD',
      zh:'公開事奉輪值尚未啟用；請聯絡管理員。',
      en:'Public serving rota is not configured; please contact an administrator.'
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.api_public_serving_rota(''))),
    {
      ok:false,
      code:'E503_ROTA_PASSWORD',
      zh:'公開事奉輪值尚未啟用；請聯絡管理員。',
      en:'Public serving rota is not configured; please contact an administrator.'
    }
  );
});

test('browser scripts parse after Apps Script template substitution', () => {
  for (const file of ['index.html','Admin2.html','Reg2.html']){
    const html = read(file);
    const scripts = Array.from(html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi));
    for (const [index, match] of scripts.entries()){
      const js = match[1].replace(/<\?[\s\S]*?\?>/g, 'null');
      assert.doesNotThrow(() => new Function(js), `${file} inline script ${index + 1}`);
    }
  }
  assert.doesNotThrow(() => new vm.Script(read('scanner/scanner.js')));
});

test('source and visible UI version tags identify this hotfix', () => {
  const liveBackend = read('Code.gs');
  const liveUi = read('index.html');
  const adminBackend = read('Admin.gs');
  const adminUi = read('Admin2.html');
  const regBackend = read('Reg.gs');
  const regUi = read('Reg2.html');

  assert.ok(liveBackend.includes("const APP_VERSION = '2026-08-28.staff107';"));
  assert.ok(liveBackend.includes('* v2026-08-28.staff107'));
  assert.ok(liveUi.includes('* UI VERSION: staff-ui-2026-08-28.107'));
  assert.ok(liveUi.includes('ui staff-ui-2026-08-28.107'));

  assert.ok(adminBackend.includes("const ADMIN_VERSION = '2026-08-23.admin121';"));
  assert.ok(adminBackend.includes('* v2026-08-23.admin121'));
  assert.ok(adminUi.includes('UI VERSION TAG: admin2-ui-2026-08-23.123'));
  assert.ok(adminUi.includes('ui admin2-ui-2026-08-23.123'));

  assert.ok(regBackend.includes("const REG_VERSION = '2026-08-23.reg123';"));
  assert.ok(regBackend.includes('* v2026-08-23.reg123'));
  assert.ok(regUi.includes('UI VERSION TAG: reg2-ui-2026-08-23.121'));
  assert.ok(regUi.includes('ui reg2-ui-2026-08-23.121'));
});
