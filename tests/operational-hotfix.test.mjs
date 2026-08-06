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

  assert.ok(adminBackend.includes("const ADMIN_VERSION = '2026-08-06.admin117';"));
  assert.ok(adminBackend.includes('* v2026-08-06.admin117'));
  assert.ok(adminUi.includes('UI VERSION TAG: admin2-ui-2026-08-06.119'));
  assert.ok(adminUi.includes('ui admin2-ui-2026-08-06.119'));

  assert.ok(regBackend.includes("const REG_VERSION = '2026-08-06.reg120';"));
  assert.ok(regBackend.includes('* v2026-08-06.reg120'));
  assert.ok(regUi.includes('UI VERSION TAG: reg2-ui-2026-08-06.119'));
  assert.ok(regUi.includes('ui reg2-ui-2026-08-06.119'));
});
