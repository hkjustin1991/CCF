/***************************************
 * CCF Staff Portal (stable + upgrades)
 * File: Code.gs
 * v2026-01-24.staff4.fullsplit.part1
 *
 * THIS IS PART 1/2
 * Paste PART 1 first (this file), then paste PART 2 after it.
 *
 * CONTRACT (UI relies on these fields)
 * - api_checkin_scan / api_checkin_manual returns:
 *    ok, result: 'OK'|'ALREADY', eventKey, timeUk, receiptId,
 *    isNewMember, member:{id,nameZh,nameEn},
 *    (if ALREADY) already:{timeUk,receiptId,handledBy:{id,nameZh,nameEn},method},
 *    emailUi:{status,toMasked}
 *
 * Sheets:
 * - Members: first 11 headers fixed (see MEMBERS_HEADERS_REQUIRED)
 * - Members optional: VRM, VRM2, RoleExpiresISO ensured
 * - Checkins: 14 columns fixed (Timestamp..UserAgent)
 ***************************************/

const APP_VERSION = '2026-01-24.staff4.fullsplit';
const SPREADSHEET_ID = '1hVeWUwt79qIXqQ0R0UTqvFXwOvkcQYDjmSePw5AenPA';

const TZ = 'Europe/London';
const BYPASS_CODE = '@9413';
const SESSION_TTL_SECONDS = 4 * 60 * 60;

// Sheets
const CHECKINS_SHEET_NAME_PRIMARY = 'Checkins';
const CHECKINS_SHEET_NAME_LEGACY  = 'CHECKINS';
const ACTIVITY_LOG_SHEET_NAME = 'Activity_log';

// Members required headers (first 11 must match your existing schema)
const MEMBERS_HEADERS_REQUIRED = [
  'FamilyID','MemberLetter','ID','Key','NameZh','NameEn','Email','Mobile','Status','OptOutEmail','Notes'
];

// Optional columns we will ensure exist
const MEMBERS_OPTIONAL_HEADERS = ['VRM','VRM2','RoleExpiresISO'];

// Status
const STATUS_DISABLED = 'DISABLED';
const STATUS_ACTIVE = 'ACTIVE';
const STATUS_PENDING = 'PENDING';
const STATUS_PROVISIONAL = 'PROVISIONAL';
const STATUS_STAFF = 'STAFF';
const STATUS_ADMIN = 'ADMIN';
const STATUS_HELPER = 'HELPER';
const STATUS_TEMP = 'TEMP';

const PORTAL_ALLOWED = [STATUS_STAFF, STATUS_ADMIN, STATUS_HELPER, STATUS_TEMP];

// TEMP/HELPER expiry
const TEMP_EXPIRY_DAYS = 2;
const HELPER_EXPIRY_DAYS = 7;

/******** Web App Router ********/
function doGet(e) {
  const mode = String((e && e.parameter && e.parameter.mode) || '').toLowerCase();
  if (mode === 'reg') {
    if (typeof doGetReg_ === 'function') return doGetReg_(e); // served by Reg.gs
  }

  const t = HtmlService.createTemplateFromFile('index');
  t.APP_VERSION = APP_VERSION;
  return t.evaluate()
    .setTitle('CCF Staff Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/******** Basic helpers ********/
function openSs_(){ return SpreadsheetApp.openById(SPREADSHEET_ID); }
function nowUk_(){ return new Date(); }
function fmtUk_(d, p){ return Utilities.formatDate(d, TZ, p); }
function defaultEventKey_(){ return 'SundayService_' + fmtUk_(nowUk_(), 'yyyy-MM-dd'); }
function normalizeStatus_(s){ return String(s || '').trim().toUpperCase(); }
function normalizeVrm_(s){ return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function safeToDate_(v){
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function addDays_(d, days){
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + Number(days||0));
  return x;
}
function isOptedOut_(optOutRaw){
  const v = String(optOutRaw || '').trim().toUpperCase();
  if (!v) return false;
  if (v === '0' || v === 'N' || v === 'NO' || v === 'FALSE') return false;
  return ['1','Y','YES','TRUE','OPTOUT'].includes(v) || v.length > 0;
}
function err_(code, zh, en, detail){
  const out = { ok:false, code:String(code||'E500'), zh:String(zh||'系統錯誤'), en:String(en||'System error') };
  if (detail) out.detail = String(detail);
  return out;
}
function isPrivilegedStaffStatus_(st){
  st = normalizeStatus_(st);
  return (st === STATUS_STAFF || st === STATUS_ADMIN);
}
function isPortalAllowedStatus_(st){
  st = normalizeStatus_(st);
  return PORTAL_ALLOWED.includes(normalizeStatus_(st));
}
function ALLOWED_STATUS_FOR_CHECKIN_(st){
  st = normalizeStatus_(st);
  return [STATUS_ACTIVE,STATUS_PENDING,STATUS_PROVISIONAL,STATUS_STAFF,STATUS_ADMIN,STATUS_HELPER,STATUS_TEMP].includes(st);
}

/******** Members sheet + index ********/
function getMembersSheet_(){
  const ss = openSs_();
  const sheets = ss.getSheets();

  for (const sh of sheets) {
    const lastCol = sh.getLastColumn();
    if (lastCol < MEMBERS_HEADERS_REQUIRED.length) continue;

    const header = sh.getRange(1, 1, 1, MEMBERS_HEADERS_REQUIRED.length).getValues()[0]
      .map(v => String(v || '').trim());

    const matches = MEMBERS_HEADERS_REQUIRED.every((h, i) => header[i] === h);
    if (matches) return sh;
  }
  throw new Error('Members sheet not found (first 11 headers do not match expected schema).');
}

function ensureMembersOptionalColumns_(){
  const sh = getMembersSheet_();
  let lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const col = {};
  headers.forEach((h,i)=>{ if(h) col[h]=i; });

  let cur = lastCol;
  for (const h of MEMBERS_OPTIONAL_HEADERS){
    if (col[h] !== undefined) continue;
    sh.insertColumnAfter(cur);
    cur++;
    sh.getRange(1, cur).setValue(h).setFontWeight('bold');
  }
}

function clearMembersIndexCache_(){
  try{ CacheService.getScriptCache().remove('membersIndex_staff_v4'); }catch(e){}
}

function getMembersIndex_(){
  const cache = CacheService.getScriptCache();
  const key = 'membersIndex_staff_v4';
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  ensureMembersOptionalColumns_();

  const sh = getMembersSheet_();
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const col = {};
  headers.forEach((h,i)=>{ col[h]=i; });

  const data = (lastRow >= 2) ? sh.getRange(2,1,lastRow-1,lastCol).getValues() : [];
  const byId = {};

  for (let r=0; r<data.length; r++){
    const row = data[r];
    const id = String(row[col.ID]||'').trim().toUpperCase();
    if (!id) continue;

    const roleExp = ('RoleExpiresISO' in col) ? String(row[col.RoleExpiresISO]||'').trim() : '';

    byId[id] = {
      rowNumber: r+2,
      id,
      key: String(row[col.Key]||'').trim(),
      nameZh: String(row[col.NameZh]||'').trim(),
      nameEn: String(row[col.NameEn]||'').trim(),
      email: String(row[col.Email]||'').trim(),
      mobile: String(row[col.Mobile]||'').trim(),
      status: String(row[col.Status]||'').trim(),
      optOutEmail: String(row[col.OptOutEmail]||'').trim(),
      notes: String(row[col.Notes]||'').trim(),
      vrm: ('VRM' in col) ? normalizeVrm_(row[col.VRM]) : '',
      vrm2: ('VRM2' in col) ? normalizeVrm_(row[col.VRM2]) : '',
      roleExpiresIso: roleExp
    };
  }

  const payload = { byId, colMap: col, sheetName: sh.getName(), lastCol: lastCol };
  cache.put(key, JSON.stringify(payload), 600);
  return payload;
}

function findMemberRowById_(sh, colMap, memberId){
  const idx = colMap.ID;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const vals = sh.getRange(2, idx+1, lastRow-1, 1).getValues();
  const needle = String(memberId||'').trim().toUpperCase();
  for (let i=0;i<vals.length;i++){
    const v = String(vals[i][0]||'').trim().toUpperCase();
    if (v === needle) return i+2;
  }
  return null;
}

function setMemberCell_(sh, colMap, rowNumber, header, value){
  const idx = colMap[header];
  if (idx === undefined) return;
  sh.getRange(rowNumber, idx+1).setValue(value);
}

/******** Role expiry enforcement (auto revert) ********/
function enforceRoleExpiryById_(memberId){
  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return { changed:false };

  const mi = getMembersIndex_();
  const m = mi.byId[id];
  if (!m) return { changed:false };

  const st = normalizeStatus_(m.status);
  if (!(st === STATUS_TEMP || st === STATUS_HELPER)) return { changed:false };

  const expIso = String(m.roleExpiresIso||'').trim();
  let exp = safeToDate_(expIso);

  const expired = (!exp) || (exp.getTime() < nowUk_().getTime());
  if (!expired) return { changed:false };

  const sh = getMembersSheet_();
  const colMap = getMembersIndex_().colMap;
  const rowNumber = m.rowNumber || findMemberRowById_(sh, colMap, id);
  if (!rowNumber) return { changed:false };

  setMemberCell_(sh, colMap, rowNumber, 'Status', STATUS_ACTIVE);
  setMemberCell_(sh, colMap, rowNumber, 'RoleExpiresISO', '');

  clearMembersIndexCache_();
  return { changed:true };
}

/******** Sessions ********/
function newSession_(id, status){
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({
    id: String(id||'').trim(),
    status: String(status||'').trim().toUpperCase(),
    createdAt: Date.now()
  }), SESSION_TTL_SECONDS);
  return token;
}
function getSession_(token){
  const t = String(token||'').trim();
  if (!t) return null;
  const raw = CacheService.getScriptCache().get('sess_' + t);
  if (!raw) return null;
  CacheService.getScriptCache().put('sess_' + t, raw, SESSION_TTL_SECONDS); // sliding
  try { return JSON.parse(raw); } catch(e){ CacheService.getScriptCache().remove('sess_' + t); return null; }
}
function requireSession_(token){
  const sess = getSession_(token);
  if (!sess) return err_('E401','登入已過期，請重新登入','Session expired. Please login again.');
  return { ok:true, session:sess };
}
function endSession_(token){
  const t = String(token||'').trim();
  if (t) CacheService.getScriptCache().remove('sess_' + t);
}

/******** Activity_log (correct actor) ********/
function ensureActivityLogSheet_(){
  const ss = openSs_();
  let sh = ss.getSheetByName(ACTIVITY_LOG_SHEET_NAME);
  if (!sh){
    sh = ss.insertSheet(ACTIVITY_LOG_SHEET_NAME);
    sh.appendRow(['Timestamp','ActorId','ActorNameZh','ActorNameEn','Action','Details','EventKey']);
    sh.getRange(1,1,1,7).setFontWeight('bold');
  }
  return sh;
}
function actorFromSession_(sess){
  if (!sess) return { id:'', status:'', nameZh:'', nameEn:'' };
  if (sess.id === 'SUPERUSER') return { id:'SUPERUSER', status:'SUPERUSER', nameZh:'SUPERUSER', nameEn:'SUPERUSER' };

  const m = getMembersIndex_().byId[String(sess.id||'').trim().toUpperCase()];
  if (!m) return { id:sess.id, status:String(sess.status||''), nameZh:'', nameEn:'' };
  return { id:m.id, status:normalizeStatus_(m.status), nameZh:m.nameZh||'', nameEn:m.nameEn||'' };
}
function logActionForSession_(sess, action, details, eventKey){
  const a = actorFromSession_(sess);
  const sh = ensureActivityLogSheet_();
  sh.appendRow([
    nowUk_(),
    a.id,
    a.nameZh,
    a.nameEn,
    String(action||''),
    String(details||''),
    String(eventKey||'')
  ]);
}

/******** QR parsing ********/
function parseQrPayloadStrict_(raw){
  const s = String(raw||'').trim();
  const parts = s.split('|');
  if (parts.length !== 2) return err_('E416','QR 格式錯誤，請聯絡影音同工','Invalid QR format. Please contact Media team.');

  const id = String(parts[0]||'').trim().toUpperCase();
  const key = String(parts[1]||'').trim();

  if (!/^CCF\d{4}$/.test(id)) return err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');
  if (!key || !/^k.+/.test(key)) return err_('E416','QR Key 格式錯誤','Invalid QR key.');

  return { ok:true, id, key };
}

/******** Login APIs ********/
function api_login(qrPayload){
  const parsed = parseQrPayloadStrict_(qrPayload);
  if (!parsed.ok) return parsed;

  enforceRoleExpiryById_(parsed.id);

  const m = getMembersIndex_().byId[parsed.id];
  if (!m) return err_('E412','找不到此 ID，請聯絡影音同工','Member ID not found. Please contact Media team.');
  if (String(m.key||'') !== parsed.key) return err_('E418','QR 已失效或不相符','QR invalid or mismatched.');

  const st = normalizeStatus_(m.status);
  if (!isPortalAllowedStatus_(st)) return err_('E403','你沒有同工專頁權限','No permission to access staff portal.');
  if (st === STATUS_DISABLED) return err_('E414','此帳號已停用','Account disabled.');

  // HELPER/TEMP must have valid expiry
  if (st === STATUS_HELPER || st === STATUS_TEMP){
    const exp = safeToDate_(m.roleExpiresIso);
    if (!exp) return err_('E419','此臨時權限缺少到期日，請聯絡影音同工','Expiry missing. Please contact Media team.');
    if (exp.getTime() < nowUk_().getTime()){
      enforceRoleExpiryById_(parsed.id);
      return err_('E420','此臨時權限已到期','Temporary privilege expired.');
    }
  }

  const token = newSession_(m.id, st);
  const staff = { id:m.id, status:st, nameZh:m.nameZh||'', nameEn:m.nameEn||'' };
  logActionForSession_({id:m.id,status:st}, 'LOGIN', JSON.stringify({ id:m.id, status:st }), defaultEventKey_());
  return { ok:true, token, staff };
}

function api_login_internal(code){
  const c = String(code||'').trim();
  if (!c) return err_('E401','請輸入內部代碼','Please enter internal code.');
  if (c !== BYPASS_CODE) return err_('E401','內部代碼錯誤','Invalid internal code.');

  const token = newSession_('SUPERUSER', 'SUPERUSER');
  const staff = { id:'SUPERUSER', status:'SUPERUSER', nameZh:'SUPERUSER', nameEn:'SUPERUSER' };
  logActionForSession_({id:'SUPERUSER',status:'SUPERUSER'}, 'LOGIN_INTERNAL', '{}', defaultEventKey_());
  return { ok:true, token, staff };
}

function api_ping(token){
  const s = requireSession_(token);
  if (!s.ok) return s;

  if (s.session.id !== 'SUPERUSER'){
    enforceRoleExpiryById_(s.session.id);
    const m = getMembersIndex_().byId[String(s.session.id||'').toUpperCase()];
    if (!m) return err_('E401','登入已失效，請重新登入','Session expired. Please log in again.');
    const st = normalizeStatus_(m.status);
    if (!isPortalAllowedStatus_(st)) return err_('E403','你沒有同工專頁權限','No permission to access staff portal.');
    return { ok:true, staff:{ id:m.id, status:st, nameZh:m.nameZh||'', nameEn:m.nameEn||'' } };
  }

  return { ok:true, staff:{ id:'SUPERUSER', status:'SUPERUSER', nameZh:'SUPERUSER', nameEn:'SUPERUSER' } };
}

function api_logout(token){
  endSession_(token);
  return { ok:true };
}

/******** Checkins sheet (stable schema) ********/
function getCheckinsSheet_(){
  const ss = openSs_();
  let sh = ss.getSheetByName(CHECKINS_SHEET_NAME_PRIMARY);
  if (!sh) sh = ss.getSheetByName(CHECKINS_SHEET_NAME_LEGACY);
  if (!sh){
    sh = ss.insertSheet(CHECKINS_SHEET_NAME_PRIMARY);
    sh.getRange(1,1,1,14).setValues([[
      'Timestamp','EventKey',
      'MemberId','MemberNameZh','MemberNameEn',
      'Method',
      'StaffId','StaffNameZh','StaffNameEn',
      'ReceiptId',
      'EmailTo','EmailStatus',
      'DeviceId','UserAgent'
    ]]);
    sh.getRange(1,1,1,14).setFontWeight('bold');
  } else {
    ensureCheckinsSheetColumns_(sh);
  }
  return sh;
}

function ensureCheckinsSheetColumns_(sh){
  const needCols = 14;
  const lastCol = sh.getLastColumn();
  if (lastCol < needCols) sh.insertColumnsAfter(lastCol, needCols - lastCol);

  const hdr = sh.getRange(1,1,1,needCols).getValues()[0];
  const wanted = [
    'Timestamp','EventKey',
    'MemberId','MemberNameZh','MemberNameEn',
    'Method',
    'StaffId','StaffNameZh','StaffNameEn',
    'ReceiptId',
    'EmailTo','EmailStatus',
    'DeviceId','UserAgent'
  ];
  for (let i=0;i<wanted.length;i++){
    const v = String(hdr[i]||'').trim();
    if (!v) sh.getRange(1,i+1).setValue(wanted[i]);
  }
}

function findExistingCheckin_(sh, eventKey, memberId){
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const data = sh.getRange(2,1,lastRow-1,12).getValues();
  for (let i=data.length-1;i>=0;i--){
    const row = data[i];
    const ev = String(row[1]||'').trim();
    const mid = String(row[2]||'').trim().toUpperCase();
    if (ev === eventKey && mid === memberId){
      const ts = row[0] instanceof Date ? row[0] : safeToDate_(row[0]) || new Date();
      return {
        rowNumber: i+2,
        timeUk: fmtUk_(ts,'HH:mm:ss'),
        receiptId: String(row[9]||''),
        handledBy: { id:String(row[6]||''), nameZh:String(row[7]||''), nameEn:String(row[8]||'') },
        method: String(row[5]||'')
      };
    }
  }
  return null;
}

function makeReceiptId_(ts){
  const stamp = fmtUk_(ts,'yyMMddHHmmss');
  const tail = Utilities.getUuid().slice(0,6).toUpperCase();
  return 'R' + stamp + '-' + tail;
}

/******** Email helpers (mask + receipt email) ********/
function maskEmail_(email){
  const s = String(email||'').trim();
  const at = s.indexOf('@');
  if (at <= 0) return '';
  const local = s.slice(0, at);
  const dom = s.slice(at+1);
  if (!dom) return '';
  const head = local.slice(0, Math.min(5, local.length));
  const tail = local.length >= 3 ? local.slice(-2) : '';
  const stars = '*'.repeat(Math.max(3, local.length - head.length - tail.length));
  return head + stars + tail + '@' + dom;
}

/**
 * Send check-in receipt if eligible.
 * Returns { status:'SENT'|'OPTOUT'|'NO_EMAIL'|'QUOTA'|'ERROR', toMasked:'' , to:'' }
 * NOTE: we return masked for UI; you can choose to write actual email to sheet.
 */
function maybeSendProofEmail_(member, eventKey, receiptId, staffLabel){
  const email = String((member && member.email) || '').trim();
  if (!email) return { status:'NO_EMAIL', toMasked:'' };

  const toMasked = maskEmail_(email);
  if (isOptedOut_(member.optOutEmail)) return { status:'OPTOUT', toMasked };

  const quota = MailApp.getRemainingDailyQuota();
  if (quota <= 0) return { status:'QUOTA', toMasked };

  const nameZh = String(member.nameZh||'').trim();
  const nameEn = String(member.nameEn||'').trim();
  const greet = nameEn || nameZh || 'there';

  const subject = 'CCF Check-in Receipt / 出席簽到收據';
  const body =
`Hi ${greet},

Thank you for checking in.
Event: ${eventKey}
Time (UK): ${fmtUk_(nowUk_(),'HH:mm:ss')}
Receipt: ${receiptId}
Handled by: ${staffLabel}

If you have any questions, please contact our staff.

${nameZh ? (nameZh + '，') : ''}你好：
多謝你簽到。
活動：${eventKey}
時間（英國）：${fmtUk_(nowUk_(),'HH:mm:ss')}
收據編號：${receiptId}
經手同工：${staffLabel}

如有疑問，請聯絡同工。`;

  try{
    MailApp.sendEmail(email, subject, body);
    return { status:'SENT', toMasked };
  }catch(e){
    return { status:'ERROR', toMasked };
  }
}

function setCheckinsEmailFields_(sh, rowNumber, emailTo, emailStatus){
  // Columns: EmailTo=11, EmailStatus=12
  try{
    sh.getRange(rowNumber, 11).setValue(String(emailTo||''));
    sh.getRange(rowNumber, 12).setValue(String(emailStatus||''));
  }catch(e){}
}

/******** First-seen index for 🆕 (used by Live in PART 2) ********/
function getFirstSeenIndex_(){
  const cache = CacheService.getScriptCache();
  const key = 'firstSeenIndex_v7';
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();
  const idx = { firstSeenEventKeyById: {}, firstSeenTsById: {} };

  if (lastRow >= 2){
    const data = sh.getRange(2,1,lastRow-1,12).getValues();
    for (let i=0;i<data.length;i++){
      const row = data[i];
      const ts = row[0] instanceof Date ? row[0] : safeToDate_(row[0]) || null;
      const ev = String(row[1]||'').trim();
      const mid = String(row[2]||'').trim().toUpperCase();
      if (!ts || !ev || !mid) continue;

      const t = ts.getTime();
      const prev = idx.firstSeenTsById[mid];
      if (prev === undefined || t < prev){
        idx.firstSeenTsById[mid] = t;
        idx.firstSeenEventKeyById[mid] = ev;
      }
    }
  }

  cache.put(key, JSON.stringify(idx), 900);
  return idx;
}
function clearFirstSeenIndexCache_(){
  try{ CacheService.getScriptCache().remove('firstSeenIndex_v7'); }catch(e){}
}
function updateFirstSeenIndexAfterAppend_(memberId, eventKey, ts){
  const cache = CacheService.getScriptCache();
  const key = 'firstSeenIndex_v7';
  const cached = cache.get(key);
  if (!cached) return;
  try{
    const idx = JSON.parse(cached);
    if (idx.firstSeenTsById && idx.firstSeenTsById[memberId] === undefined){
      idx.firstSeenTsById[memberId] = ts.getTime();
      idx.firstSeenEventKeyById[memberId] = eventKey;
      cache.put(key, JSON.stringify(idx), 900);
    }
  }catch(e){}
}

/**
 * PART 2 defines isNewNonStaffMemberToday_ and live-related APIs.
 * Check-in APIs below call isNewNonStaffMemberToday_ (safe after PART 2 pasted).
 */

/******** Check-in APIs (scan + manual) ********/
function api_checkin_scan(token, qrPayload, eventKeyOptional, deviceId, ua){
  const s = requireSession_(token);
  if (!s.ok) return s;
  if (s.session.id !== 'SUPERUSER') enforceRoleExpiryById_(s.session.id);

  const ek = String(eventKeyOptional||'').trim() || defaultEventKey_();
  const parsed = parseQrPayloadStrict_(qrPayload);
  if (!parsed.ok) return parsed;

  enforceRoleExpiryById_(parsed.id);
  const m = getMembersIndex_().byId[parsed.id];
  if (!m) return err_('E412','找不到此 ID','Member not found.');
  if (String(m.key||'') !== parsed.key) return err_('E418','QR 已失效或不相符','QR invalid or mismatched.');

  const st = normalizeStatus_(m.status);
  if (st === STATUS_DISABLED) return err_('E414','此帳號已停用','Account disabled.');
  if (!ALLOWED_STATUS_FOR_CHECKIN_(st)) return err_('E413','此會員狀態不正確','Invalid member status.');

  const sh = getCheckinsSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try{
    const existing = findExistingCheckin_(sh, ek, m.id);
    if (existing){
      return {
        ok:true,
        result:'ALREADY',
        eventKey:ek,
        member:{id:m.id,nameZh:m.nameZh||'',nameEn:m.nameEn||''},
        already:{ timeUk: existing.timeUk, receiptId: existing.receiptId, handledBy: existing.handledBy, method: existing.method },
        emailUi:{ status:'', toMasked:'' }
      };
    }

    const ts = nowUk_();
    const receiptId = makeReceiptId_(ts);
    const actor = actorFromSession_(s.session);
    const staffLabel = (actor.nameZh || actor.nameEn) ? ((actor.nameZh+' '+actor.nameEn).trim()) : actor.id;

    // append row
    sh.appendRow([
      ts, ek,
      m.id, m.nameZh||'', m.nameEn||'',
      'scan',
      actor.id, actor.nameZh||'', actor.nameEn||'',
      receiptId,
      '', '',
      String(deviceId||''), String(ua||'')
    ]);
    const rowNumber = sh.getLastRow();

    // email receipt
    const emailRes = maybeSendProofEmail_(m, ek, receiptId, staffLabel);
    // write to sheet (choose: write real email or masked; here writes real email)
    const emailTo = (emailRes.status === 'SENT') ? String(m.email||'').trim() : String(m.email||'').trim();
    setCheckinsEmailFields_(sh, rowNumber, emailTo, emailRes.status);

    updateFirstSeenIndexAfterAppend_(m.id, ek, ts);
    CacheService.getScriptCache().remove('liveNames_' + ek);

    logActionForSession_(s.session, 'CHECKIN', JSON.stringify({
      memberId:m.id, method:'scan', receiptId, email: emailRes
    }), ek);

    return {
      ok:true,
      result:'OK',
      eventKey: ek,
      timeUk: fmtUk_(ts,'HH:mm:ss'),
      receiptId: receiptId,
      isNewMember: (typeof isNewNonStaffMemberToday_ === 'function') ? isNewNonStaffMemberToday_(m.id, ek) : false,
      member:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'' },
      emailUi:{ status: emailRes.status, toMasked: emailRes.toMasked||'' }
    };
  } finally {
    lock.releaseLock();
  }
}

function api_checkin_manual(token, memberId, eventKeyOptional, deviceId, ua){
  const s = requireSession_(token);
  if (!s.ok) return s;
  if (s.session.id !== 'SUPERUSER') enforceRoleExpiryById_(s.session.id);

  const ek = String(eventKeyOptional||'').trim() || defaultEventKey_();
  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  enforceRoleExpiryById_(id);
  const m = getMembersIndex_().byId[id];
  if (!m) return err_('E412','找不到此 ID','Member not found.');

  const st = normalizeStatus_(m.status);
  if (st === STATUS_DISABLED) return err_('E414','此帳號已停用','Account disabled.');
  if (!ALLOWED_STATUS_FOR_CHECKIN_(st)) return err_('E413','此會員狀態不正確','Invalid member status.');

  const sh = getCheckinsSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try{
    const existing = findExistingCheckin_(sh, ek, m.id);
    if (existing){
      return {
        ok:true,
        result:'ALREADY',
        eventKey:ek,
        member:{id:m.id,nameZh:m.nameZh||'',nameEn:m.nameEn||''},
        already:{ timeUk: existing.timeUk, receiptId: existing.receiptId, handledBy: existing.handledBy, method: existing.method },
        emailUi:{ status:'', toMasked:'' }
      };
    }

    const ts = nowUk_();
    const receiptId = makeReceiptId_(ts);
    const actor = actorFromSession_(s.session);
    const staffLabel = (actor.nameZh || actor.nameEn) ? ((actor.nameZh+' '+actor.nameEn).trim()) : actor.id;

    sh.appendRow([
      ts, ek,
      m.id, m.nameZh||'', m.nameEn||'',
      'manual',
      actor.id, actor.nameZh||'', actor.nameEn||'',
      receiptId,
      '', '',
      String(deviceId||''), String(ua||'')
    ]);
    const rowNumber = sh.getLastRow();

    const emailRes = maybeSendProofEmail_(m, ek, receiptId, staffLabel);
    const emailTo = (emailRes.status === 'SENT') ? String(m.email||'').trim() : String(m.email||'').trim();
    setCheckinsEmailFields_(sh, rowNumber, emailTo, emailRes.status);

    updateFirstSeenIndexAfterAppend_(m.id, ek, ts);
    CacheService.getScriptCache().remove('liveNames_' + ek);

    logActionForSession_(s.session, 'CHECKIN', JSON.stringify({
      memberId:m.id, method:'manual', receiptId, email: emailRes
    }), ek);

    return {
      ok:true,
      result:'OK',
      eventKey: ek,
      timeUk: fmtUk_(ts,'HH:mm:ss'),
      receiptId: receiptId,
      isNewMember: (typeof isNewNonStaffMemberToday_ === 'function') ? isNewNonStaffMemberToday_(m.id, ek) : false,
      member:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'' },
      emailUi:{ status: emailRes.status, toMasked: emailRes.toMasked||'' }
    };
  } finally {
    lock.releaseLock();
  }
}

/******** Search members (manual) ********/
function api_search_members(token, query){
  const s = requireSession_(token);
  if (!s.ok) return s;
  if (s.session.id !== 'SUPERUSER') enforceRoleExpiryById_(s.session.id);

  const q = String(query||'').trim();
  if (!q) return { ok:true, results:[] };

  const mi = getMembersIndex_().byId;
  const out = [];
  const qU = q.toUpperCase();
  const qL = q.toLowerCase();

  for (const id in mi){
    const m = mi[id];
    const st = normalizeStatus_(m.status);
    if (st === STATUS_DISABLED) continue;

    const hay = [m.id, m.nameZh, m.nameEn, m.email, m.mobile].map(x=>String(x||'')).join(' | ');
    if (hay.toUpperCase().includes(qU) || hay.toLowerCase().includes(qL)){
      out.push({ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'' });
      if (out.length >= 12) break;
    }
  }
  return { ok:true, results: out };
}

/******** Self-test (quick sanity) ********/
function api_selftest(){
  const out = { ok:true, version: APP_VERSION, checks:[] };
  try{
    const mi = getMembersIndex_();
    out.checks.push({ name:'Members index', ok:true, memberCount:Object.keys(mi.byId||{}).length, sheet:mi.sheetName });
  }catch(e){
    out.ok=false; out.checks.push({ name:'Members index', ok:false, detail:String(e) });
  }

  try{
    const sh = getCheckinsSheet_();
    const hdr = sh.getRange(1,1,1,14).getValues()[0].map(x=>String(x||'').trim());
    out.checks.push({ name:'Checkins header', ok:(hdr[0]==='Timestamp' && hdr[13]==='UserAgent'), header:hdr });
  }catch(e){
    out.ok=false; out.checks.push({ name:'Checkins header', ok:false, detail:String(e) });
  }

  out.checks.push({ name:'Part2 present', ok:(typeof api_get_live_page === 'function') });
  return out;
}

/*** END OF PART 1/2 ***/
/*** CCF Staff Portal - Code.gs
 * v2026-01-24.staff4.fullsplit.part2
 * THIS IS PART 2/2
 * Paste this AFTER PART 1 in the same Code.gs file.
 */

/*****************************************************************
 * 🆕 New member detection (non-staff only)
 *****************************************************************/
function isNewNonStaffMemberToday_(memberId, todayEventKey){
  const mi = getMembersIndex_().byId;
  const m = mi[memberId];
  const st = normalizeStatus_(m ? m.status : '');

  // Treat these as NOT "new visitor" signals
  if ([STATUS_STAFF, STATUS_ADMIN, STATUS_PROVISIONAL, STATUS_HELPER, STATUS_TEMP].includes(st)) return false;

  const fs = getFirstSeenIndex_();
  const firstEv = fs.firstSeenEventKeyById[memberId];
  if (!firstEv) return true;               // never seen before
  return firstEv === todayEventKey;        // first seen today
}

/*****************************************************************
 * Live page
 *****************************************************************/
function api_get_live_page(token, eventKeyOptional){
  const s = requireSession_(token);
  if (!s.ok) return s;
  if (s.session.id !== 'SUPERUSER') enforceRoleExpiryById_(s.session.id);

  const ek = String(eventKeyOptional||'').trim() || defaultEventKey_();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'liveNames_' + ek;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();
  const members = getMembersIndex_().byId;

  const latestById = {}; // id -> {t, nameZh, nameEn}
  let lastSignIn = null;

  if (lastRow >= 2){
    const data = sh.getRange(2,1,lastRow-1,12).getValues();
    for (let i=0;i<data.length;i++){
      const row = data[i];
      const ev = String(row[1]||'').trim();
      if (ev !== ek) continue;

      const mid = String(row[2]||'').trim().toUpperCase();
      if (!mid) continue;

      const ts = row[0] instanceof Date ? row[0] : safeToDate_(row[0]) || new Date();
      const t = ts.getTime();

      const nameZh = String(row[3]||'') || (members[mid] ? (members[mid].nameZh||'') : '');
      const nameEn = String(row[4]||'') || (members[mid] ? (members[mid].nameEn||'') : '');

      const prev = latestById[mid];
      if (!prev || t > prev.t){
        latestById[mid] = { t, nameZh, nameEn };
      }
    }

    // last sign-in (most recent row for this eventKey)
    for (let i=data.length-1;i>=0;i--){
      const row = data[i];
      const ev = String(row[1]||'').trim();
      if (ev !== ek) continue;

      const ts = row[0] instanceof Date ? row[0] : safeToDate_(row[0]) || new Date();
      lastSignIn = { timeUk: fmtUk_(ts,'HH:mm:ss'), nameZh:String(row[3]||''), nameEn:String(row[4]||'') };
      break;
    }
  }

  const ids = Object.keys(latestById);
  ids.sort((a,b)=> latestById[b].t - latestById[a].t);

  const names = [];
  const newNames = [];
  for (const id of ids){
    const n = latestById[id];
    const isNew = isNewNonStaffMemberToday_(id, ek);
    names.push({ id, nameZh:n.nameZh||'', nameEn:n.nameEn||'', isNew });
    if (isNew) newNames.push({ nameZh:n.nameZh||'', nameEn:n.nameEn||'' });
  }

  const payload = {
    ok:true,
    eventKey:ek,
    checkedInCount:names.length,
    lastSignIn,
    newCount:newNames.length,
    newNames,
    names
  };
  cache.put(cacheKey, JSON.stringify(payload), 15);
  return payload;
}

/*****************************************************************
 * VRM search
 *****************************************************************/
function api_search_vrm(token, query, eventKeyOptional){
  const s = requireSession_(token);
  if (!s.ok) return s;
  if (s.session.id !== 'SUPERUSER') enforceRoleExpiryById_(s.session.id);

  const mi = getMembersIndex_();
  const byId = mi.byId;

  // Confirm columns exist (ensureMembersOptionalColumns_ already added them; but keep "hasVRM" for UI)
  const hasVRM = (mi.colMap && mi.colMap.VRM !== undefined && mi.colMap.VRM2 !== undefined);
  if (!hasVRM) return { ok:true, results:[], hasVRM:false };

  const q = normalizeVrm_(query);
  if (!q) return { ok:true, results:[], hasVRM:true };

  const ek = String(eventKeyOptional||'').trim() || defaultEventKey_();

  // Build checked set for today (for UI indicator)
  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();
  const checked = new Set();
  if (lastRow >= 2){
    const data = sh.getRange(2,1,lastRow-1,12).getValues();
    for (let i=0;i<data.length;i++){
      const row = data[i];
      if (String(row[1]||'').trim() !== ek) continue;
      const mid = String(row[2]||'').trim().toUpperCase();
      if (mid) checked.add(mid);
    }
  }

  const out = [];
  for (const id in byId){
    const m = byId[id];
    const st = normalizeStatus_(m.status);
    if (st === STATUS_DISABLED) continue;

    const a = m.vrm || '';
    const b = m.vrm2 || '';
    if ((a && a.includes(q)) || (b && b.includes(q))){
      out.push({
        id: m.id,
        nameZh: m.nameZh||'',
        nameEn: m.nameEn||'',
        vrm: a,
        vrm2: b,
        checkedInToday: checked.has(m.id)
      });
      if (out.length >= 12) break;
    }
  }

  return { ok:true, results: out, hasVRM:true, eventKey:ek };
}

/*****************************************************************
 * AUTHORISATION (TEMP/HELPER)
 *****************************************************************/

/**
 * Step 1: validate approver QR
 * - Normal STAFF/ADMIN: must scan own QR (id must match session.id)
 * - SUPERUSER: must scan ADMIN QR only
 */
function api_auth_validate_approver(token, approverQrPayload){
  const s = requireSession_(token);
  if (!s.ok) return s;

  const parsed = parseQrPayloadStrict_(approverQrPayload);
  if (!parsed.ok) return parsed;

  enforceRoleExpiryById_(parsed.id);

  const m = getMembersIndex_().byId[parsed.id];
  if (!m) return err_('E412','找不到此 ID','Member not found.');
  if (String(m.key||'') !== parsed.key) return err_('E418','QR 已失效或不相符','QR invalid or mismatched.');

  const st = normalizeStatus_(m.status);

  if (s.session.id === 'SUPERUSER'){
    if (st !== STATUS_ADMIN) return err_('E440','SUPERUSER 只接受管理員（ADMIN）QR','SUPERUSER requires ADMIN QR (STAFF rejected).');
    return { ok:true, approver:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status:STATUS_ADMIN } };
  }

  // normal: must be self
  if (String(s.session.id||'').toUpperCase() !== parsed.id){
    return err_(
      'E431',
      '請用你本人 QR 授權（已登入：' + String(s.session.id||'') + '）',
      'Please use your own QR to approve (logged in as: ' + String(s.session.id||'') + ').'
    );
  }

  if (!isPrivilegedStaffStatus_(st)){
    return err_('E430','只有同工／管理員可以授權','Only STAFF/ADMIN can approve.');
  }

  return { ok:true, approver:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status:st } };
}

/**
 * Step 2: validate target QR
 * - blocks STAFF/ADMIN targets
 * - blocks scanning own QR again (normal sessions)
 */
function api_auth_validate_target(token, targetQrPayload){
  const s = requireSession_(token);
  if (!s.ok) return s;

  const parsed = parseQrPayloadStrict_(targetQrPayload);
  if (!parsed.ok) return parsed;

  // Normal sessions: if scanned self again, explicit message
  if (s.session.id !== 'SUPERUSER' && String(s.session.id||'').toUpperCase() === parsed.id){
    return err_(
      'E433',
      '你已經掃描咗自己嘅 QR 兩次。請改為掃描「暫準同工」嘅 QR。',
      'You scanned your own QR twice. Please scan the temporary staff member’s QR.'
    );
  }

  enforceRoleExpiryById_(parsed.id);

  const m = getMembersIndex_().byId[parsed.id];
  if (!m) return err_('E412','找不到此 ID','Member not found.');
  if (String(m.key||'') !== parsed.key) return err_('E418','QR 已失效或不相符','QR invalid or mismatched.');

  const st = normalizeStatus_(m.status);
  if (st === STATUS_DISABLED) return err_('E414','此帳號已停用','Account disabled.');

  if (st === STATUS_STAFF || st === STATUS_ADMIN){
    return err_('E442','同工／管理員不可被授權（不可降級）','STAFF/ADMIN cannot be targeted (cannot downgrade).');
  }

  return { ok:true, target:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status:st, roleExpiresIso: m.roleExpiresIso || '' } };
}

/**
 * Step 4: commit
 * - TEMP => 2 days, HELPER => 7 days
 * - blocks self authorisation
 * - blocks STAFF/ADMIN target
 * - approver must match session user (unless SUPERUSER requires ADMIN)
 * - returns expiry in BOTH expiryIso and roleExpiresIso
 */
function api_auth_commit(token, approverId, targetId, newStatus){
  const s = requireSession_(token);
  if (!s.ok) return s;

  const role = normalizeStatus_(newStatus);
  if (![STATUS_TEMP, STATUS_HELPER].includes(role)) return err_('E400','授權類別錯誤','Invalid role.');

  const appr = String(approverId||'').trim().toUpperCase();
  const targ = String(targetId||'').trim().toUpperCase();

  if (!/^CCF\d{4}$/.test(appr)) return err_('E416','授權者 ID 格式錯誤','Invalid approver ID.');
  if (!/^CCF\d{4}$/.test(targ)) return err_('E416','目標 ID 格式錯誤','Invalid target ID.');

  if (appr === targ){
    return err_(
      'E433',
      '你已經掃描咗自己嘅 QR 兩次。請改為掃描「暫準同工」嘅 QR。',
      'You scanned your own QR twice. Please scan the temporary staff member’s QR.'
    );
  }

  // Approver enforcement
  if (s.session.id === 'SUPERUSER'){
    enforceRoleExpiryById_(appr);
    const a = getMembersIndex_().byId[appr];
    if (!a) return err_('E412','找不到管理員 ID','Admin not found.');
    if (normalizeStatus_(a.status) !== STATUS_ADMIN) return err_('E440','SUPERUSER 只接受管理員（ADMIN）授權','SUPERUSER requires ADMIN approval.');
  } else {
    enforceRoleExpiryById_(s.session.id);
    if (String(s.session.id||'').toUpperCase() !== appr){
      return err_(
        'E431',
        '請用你本人 QR 授權（已登入：' + String(s.session.id||'') + '）',
        'Please use your own QR to approve (logged in as: ' + String(s.session.id||'') + ').'
      );
    }
    const me = getMembersIndex_().byId[appr];
    if (!me) return err_('E412','找不到授權者','Approver not found.');
    if (!isPrivilegedStaffStatus_(me.status)) return err_('E430','只有同工／管理員可以授權','Only STAFF/ADMIN can approve.');
  }

  // Target enforcement
  enforceRoleExpiryById_(targ);
  const t = getMembersIndex_().byId[targ];
  if (!t) return err_('E412','找不到目標 ID','Target not found.');
  const oldSt = normalizeStatus_(t.status);
  if (oldSt === STATUS_STAFF || oldSt === STATUS_ADMIN) return err_('E442','同工／管理員不可被授權（不可降級）','STAFF/ADMIN cannot be targeted (cannot downgrade).');
  if (oldSt === STATUS_DISABLED) return err_('E414','此帳號已停用','Account disabled.');

  // Apply sheet update
  const sh = getMembersSheet_();
  const colMap = getMembersIndex_().colMap;
  const rowNumber = t.rowNumber || findMemberRowById_(sh, colMap, targ);
  if (!rowNumber) return err_('E500','找不到記錄行','Row not found.');

  const days = (role === STATUS_TEMP) ? TEMP_EXPIRY_DAYS : HELPER_EXPIRY_DAYS;
  const expiry = addDays_(nowUk_(), days);
  const expiryIso = expiry.toISOString();

  setMemberCell_(sh, colMap, rowNumber, 'Status', role);
  setMemberCell_(sh, colMap, rowNumber, 'RoleExpiresISO', expiryIso);

  clearMembersIndexCache_();

  const detail = {
    bySession: actorFromSession_(s.session),
    approver: { id: appr, status: (s.session.id === 'SUPERUSER' ? STATUS_ADMIN : actorFromSession_(s.session).status) },
    target: { id: targ, oldStatus: oldSt, newStatus: role },
    expiryIso: expiryIso
  };
  if (s.session.id === 'SUPERUSER') detail.superuserAdmin = { id: appr };

  logActionForSession_(s.session, 'AUTHORISE_PRIVILEGE', JSON.stringify(detail), defaultEventKey_());

  return { ok:true, target:{ id:targ, oldStatus: oldSt, newStatus: role, expiryIso: expiryIso, roleExpiresIso: expiryIso } };
}

/*****************************************************************
 * LIVE: detail + delete today
 *****************************************************************/
function api_live_get_member_detail(token, memberId, eventKeyOptional){
  const s = requireSession_(token);
  if (!s.ok) return s;

  // Only STAFF/ADMIN/SUPERUSER
  if (s.session.id !== 'SUPERUSER'){
    enforceRoleExpiryById_(s.session.id);
    const me = getMembersIndex_().byId[String(s.session.id||'').toUpperCase()];
    if (!me || !isPrivilegedStaffStatus_(me.status)) return err_('E403','此功能只供同工/管理員使用','Staff/Admin only.');
  }

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return err_('E416','CCF ID 格式錯誤','Invalid CCF ID format.');

  enforceRoleExpiryById_(id);
  const m = getMembersIndex_().byId[id];
  if (!m) return err_('E412','找不到此會員','Member not found.');
  if (normalizeStatus_(m.status) === STATUS_DISABLED) return err_('E414','此帳號已停用','Account disabled.');

  const ek = String(eventKeyOptional||'').trim() || defaultEventKey_();
  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();

  let today = null;
  const last4 = [];
  const seenEv = new Set();

  if (lastRow >= 2){
    const data = sh.getRange(2,1,lastRow-1,12).getValues();
    for (let i=data.length-1;i>=0;i--){
      const row = data[i];
      const ev = String(row[1]||'').trim();
      const mid = String(row[2]||'').trim().toUpperCase();
      if (mid !== id) continue;

      if (!today && ev === ek){
        const ts = row[0] instanceof Date ? row[0] : safeToDate_(row[0]) || new Date();
        today = {
          eventKey: ev,
          timeUk: fmtUk_(ts,'HH:mm:ss'),
          method: String(row[5]||''),
          receiptId: String(row[9]||''),
          handledBy: { id:String(row[6]||''), nameZh:String(row[7]||''), nameEn:String(row[8]||'') }
        };
      }

      if (ev && !seenEv.has(ev)){
        seenEv.add(ev);
        last4.push(ev);
        if (last4.length >= 4) break;
      }
    }
  }

  return {
    ok:true,
    member:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status: normalizeStatus_(m.status), vrm:m.vrm||'', vrm2:m.vrm2||'' },
    today: today,
    last4EventKeys: last4
  };
}

function api_live_delete_today_checkin(token, memberId, reauthQrPayload, adminQrPayloadOptional){
  const s = requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return err_('E416','CCF ID 格式錯誤','Invalid CCF ID format.');

  enforceRoleExpiryById_(id);
  const m = getMembersIndex_().byId[id];
  if (!m) return err_('E412','找不到此會員','Member not found.');

  const ek = defaultEventKey_();
  const sh = getCheckinsSheet_();

  // Determine audit label
  let byLabel = '';
  let auditActor = actorFromSession_(s.session);

  if (s.session.id === 'SUPERUSER'){
    // Require ADMIN QR (ADMIN only)
    const parsed = parseQrPayloadStrict_(adminQrPayloadOptional);
    if (!parsed.ok) return parsed;

    enforceRoleExpiryById_(parsed.id);
    const admin = getMembersIndex_().byId[parsed.id];
    if (!admin) return err_('E412','找不到管理員記錄','Admin not found.');
    if (String(admin.key||'') !== parsed.key) return err_('E418','管理員 QR 不相符','Admin QR mismatch.');
    if (normalizeStatus_(admin.status) !== STATUS_ADMIN){
      return err_('E491',
        '此操作需要管理員（ADMIN）授權。你掃描咗同工卡（STAFF）。請先登出，再用你自己嘅同工卡登入／或請管理員處理。',
        'ADMIN authorisation required. You scanned STAFF. Please log out and log in with your own ID, or ask an ADMIN.'
      );
    }
    byLabel = 'SUPERUSER (ADMIN:' + admin.id + ')';
    auditActor = { id: byLabel, nameZh: admin.nameZh||'ADMIN', nameEn: admin.nameEn||'ADMIN', status:'SUPERUSER' };
  } else {
    // Must rescan own QR and must be STAFF/ADMIN
    const parsed = parseQrPayloadStrict_(reauthQrPayload);
    if (!parsed.ok) return parsed;

    if (parsed.id !== String(s.session.id||'').toUpperCase()){
      return err_('E492',
        '你掃描嘅並非你本人同工卡。請先登出，再用你自己嘅同工卡登入。',
        'You did not scan your own staff badge. Log out and log in with your own ID.'
      );
    }

    enforceRoleExpiryById_(parsed.id);
    const me = getMembersIndex_().byId[parsed.id];
    if (!me) return err_('E412','找不到同工記錄','Staff record not found.');
    if (String(me.key||'') !== parsed.key) return err_('E418','Key 不相符（舊卡/錯誤 QR）','Key mismatch.');

    if (!isPrivilegedStaffStatus_(me.status)){
      return err_('E403','此功能只供同工/管理員使用','Staff/Admin only.');
    }

    byLabel = me.id;
    auditActor = { id: me.id, nameZh: me.nameZh||'', nameEn: me.nameEn||'', status: normalizeStatus_(me.status) };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try{
    const existing = findExistingCheckin_(sh, ek, id);
    if (!existing) return err_('E404','找不到此會員今日簽到記錄','Today check-in not found.');

    sh.deleteRow(existing.rowNumber);

    // Clear caches
    CacheService.getScriptCache().remove('liveNames_' + ek);
    clearFirstSeenIndexCache_();

    // Send email if possible
    const emailRes = sendDeleteEmailIfPossible_(m, ek, byLabel);

    // Log to activity
    logActionForSession_(s.session, 'DELETE_TODAY_CHECKIN', JSON.stringify({
      eventKey: ek,
      memberId: id,
      by: byLabel,
      auditActor: auditActor,
      email: emailRes
    }), ek);

    return { ok:true, deleted:{ eventKey: ek, memberId: id, by: byLabel }, email: emailRes };
  } finally {
    lock.releaseLock();
  }
}

/*****************************************************************
 * Delete notice email
 *****************************************************************/
function sendDeleteEmailIfPossible_(member, eventKey, byLabel){
  const email = String(member.email||'').trim();
  if (!email) return { status:'NO_EMAIL', toMasked:'' };
  const toMasked = maskEmail_(email);

  if (isOptedOut_(member.optOutEmail)) return { status:'OPTOUT', toMasked: toMasked };

  const quota = MailApp.getRemainingDailyQuota();
  if (quota <= 0) return { status:'QUOTA', toMasked: toMasked };

  const nameZh = String(member.nameZh||'').trim();
  const nameEn = String(member.nameEn||'').trim();
  const greet = nameEn || nameZh || 'there';

  const subject = 'CCF Attendance Update / 出席記錄更新';
  const body =
`Hi ${greet},

Your attendance record for:
Event: ${eventKey}
has been updated by our staff (${byLabel}).

If you have any questions, please contact us as soon as possible.

${nameZh ? nameZh + '，' : ''}你好：
你於以下聚會的出席記錄已被同工更新：
活動：${eventKey}
經手：${byLabel}

如有任何疑問，請盡快聯絡同工。`;

  try{
    MailApp.sendEmail(email, subject, body);
    return { status:'SENT', toMasked: toMasked };
  }catch(e){
    return { status:'ERROR', toMasked: toMasked };
  }
}
