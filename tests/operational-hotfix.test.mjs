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
  context.findExistingCheckin_ = () => ({ eventKey:'SundayService_2026-08-02', timeUk:'13:00:00' });
  context.getDefaultEventKey_ = () => 'SundayService_2026-08-02';
  context.promotePendingMemberToActive_ = () => { promoted += 1; return true; };
  const result = context.api_checkin_scan('token', 'CCF0123|k123', null, '', '');
  assert.equal(result.ok, true);
  assert.equal(result.result, 'ALREADY');
  assert.equal(result.status, 'ACTIVE');
  assert.equal(promoted, 1);
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

test('source and visible UI version tags identify this hotfix', () => {
  const liveBackend = read('Code.gs');
  const liveUi = read('index.html');
  const adminBackend = read('Admin.gs');
  const adminUi = read('Admin2.html');
  const regBackend = read('Reg.gs');
  const regUi = read('Reg2.html');

  assert.ok(liveBackend.includes("const APP_VERSION = '2026-08-06.staff103';"));
  assert.ok(liveBackend.includes('* v2026-08-06.staff103'));
  assert.ok(liveUi.includes('* UI VERSION: staff-ui-2026-08-06.103'));
  assert.ok(liveUi.includes('ui staff-ui-2026-08-06.103'));

  assert.ok(adminBackend.includes("const ADMIN_VERSION = '2026-08-07.admin118';"));
  assert.ok(adminBackend.includes('* v2026-08-07.admin118'));
  assert.ok(adminUi.includes('UI VERSION TAG: admin2-ui-2026-08-07.120'));
  assert.ok(adminUi.includes('ui admin2-ui-2026-08-07.120'));

  assert.ok(regBackend.includes("const REG_VERSION = '2026-08-06.reg120';"));
  assert.ok(regBackend.includes('* v2026-08-06.reg120'));
  assert.ok(regUi.includes('UI VERSION TAG: reg2-ui-2026-08-06.119'));
  assert.ok(regUi.includes('ui reg2-ui-2026-08-06.119'));
});
