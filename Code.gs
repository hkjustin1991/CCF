/***************************************
 * CCF Staff Portal (stable + upgrades)
 * File: Code.gs
 * v2026-01-24.staff3
 *
 * SOURCE OF TRUTH: This file is regenerated from the user's pasted baseline
 * (v2026-01-23.staff2) with minimal, explicitly requested changes only.
 *
 * ============================================================
 * CHANGELOG (2026-01-24.staff3) — REQUESTED FEATURES IMPLEMENTED
 * ============================================================
 * [A] Live page:
 *   - api_get_live_page now returns newCount + per-name isNew
 *     (new = PENDING or PROVISIONAL by status in Members)
 *
 * [B] Check-in ALREADY payload enrichment:
 *   - findExistingCheckin_ now returns emailStatus + emailToMasked (from Checkins row)
 *
 * [C] Authorisation strictness (server-side enforcement):
 *   - Normal STAFF/ADMIN session: approver QR must be self-only (same ID as session)
 *   - SUPERUSER session: approver must be ADMIN only (STAFF rejected)
 *   - Target cannot be STAFF/ADMIN (cannot downgrade)
 *   - Cannot self-authorise (target == session staff) with required zh message
 *
 * Notes:
 * - Camera switch feature is UI-only and will be implemented in index.html.
 * - No sheet schema changes. No refactors unless required for these features.
 ***************************************/

/* =========================
 * Constants / Config
 * ========================= */
const APP_VERSION = '2026-01-24.staff3';
const SPREADSHEET_ID = '1hVeWUwt79qIXqQ0R0UTqvFXwOvkcQYDjmSePw5AenPA';

const TZ = 'Europe/London';
const BYPASS_CODE = '@9413';
const SESSION_TTL_SECONDS = 4 * 60 * 60;

// Sheets
const CHECKINS_SHEET_NAME_PRIMARY = 'Checkins';
const CHECKINS_SHEET_NAME_LEGACY = 'CHECKINS';
const ACTIVITY_LOG_SHEET_NAME = 'Activity_log';

// Members schema
const MEMBERS_HEADERS_REQUIRED = [
  'FamilyID','MemberLetter','ID','Key','NameZh','NameEn','Email','Mobile','Status','OptOutEmail','Notes'
];

// Statuses
const STATUS_DISABLED = 'DISABLED';
const STATUS_ACTIVE = 'ACTIVE';
const STATUS_PENDING = 'PENDING';
const STATUS_PROVISIONAL = 'PROVISIONAL';
const STATUS_STAFF = 'STAFF';
const STATUS_ADMIN = 'ADMIN';
const STATUS_HELPER = 'HELPER';
const STATUS_TEMP = 'TEMP';

// check-in allowed (include ADMIN/HELPER/TEMP so they can still be checked-in if scanned)
const ALLOWED_STATUSES_FOR_CHECKIN = [
  STATUS_ACTIVE, STATUS_PENDING, STATUS_PROVISIONAL,
  STATUS_STAFF, STATUS_ADMIN, STATUS_HELPER, STATUS_TEMP
];

// staff-portal login allowed
const ALLOWED_STATUSES_FOR_PORTAL = [STATUS_STAFF, STATUS_ADMIN, STATUS_HELPER, STATUS_TEMP];

// privilege expiry configuration
const HELPER_EXPIRY_DAYS = 7;
const TEMP_EXPIRY_DAYS = 2;

// Optional Members columns
const MEMBERS_OPTIONAL_HEADERS = [
  'VRM','VRM2',
  'RoleExpires' // Date/time when HELPER/TEMP expires (blank for STAFF/ADMIN/ACTIVE/etc.)
];

/******** Web App Router ********/
function doGet(e) {
  const mode = String((e && e.parameter && e.parameter.mode) || '').toLowerCase();

  // Registration portal (public, no sign-in)
  if (mode === 'reg') {
    return doGetReg_(e); // lives in Reg.gs
  }

  // Default: staff portal
  const t = HtmlService.createTemplateFromFile('index');
  t.APP_VERSION = APP_VERSION;
  return t.evaluate()
    .setTitle('CCF Staff Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/******** Helpers ********/
function openSs_(){ return SpreadsheetApp.openById(SPREADSHEET_ID); }
function nowUk_(){ return new Date(); }
function fmtUk_(d, p){ return Utilities.formatDate(d, TZ, p); }
function getDefaultEventKey_(){ return 'SundayService_' + fmtUk_(nowUk_(), 'yyyy-MM-dd'); }

function normalizeStatus_(s){ return String(s || '').trim().toUpperCase(); }
function normalizeVrm_(s){ return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function isOptedOut_(optOutRaw){
  const v = String(optOutRaw || '').trim().toUpperCase();
  if (!v) return false;
  if (v === '0' || v === 'N' || v === 'NO' || v === 'FALSE') return false;
  return ['1','Y','YES','TRUE','OPTOUT'].includes(v) || v.length > 0;
}

function isPrivilegedStaff_(st){
  st = normalizeStatus_(st);
  return (st === STATUS_STAFF || st === STATUS_ADMIN);
}
function isPortalUserAllowed_(st){
  st = normalizeStatus_(st);
  return ALLOWED_STATUSES_FOR_PORTAL.includes(st);
}
function isHelperOrTemp_(st){
  st = normalizeStatus_(st);
  return (st === STATUS_HELPER || st === STATUS_TEMP);
}

/* === PATCH_BOUNDARY: STAFF3_LIVE_NEWFRIEND_RULES_BEGIN ===
 * Rule: New friend = PENDING or PROVISIONAL (Members Status)
 */
function isNewFriendStatus_(st){
  st = normalizeStatus_(st);
  return (st === STATUS_PENDING || st === STATUS_PROVISIONAL);
}
/* === PATCH_BOUNDARY: STAFF3_LIVE_NEWFRIEND_RULES_END === */

function addDays_(d, days){
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + Number(days || 0));
  return x;
}
function isExpired_(expiry){
  if (!expiry) return true;
  const dt = (expiry instanceof Date) ? expiry : new Date(expiry);
  return dt.getTime() < nowUk_().getTime();
}

function safeToDate_(v){
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function maskEmail_(email){
  const s = String(email||'').trim();
  const at = s.indexOf('@');
  if (at <= 0) return '';
  const local = s.slice(0, at);
  const dom = s.slice(at+1);
  if (!dom) return '';
  const L = local.length;
  const head = local.slice(0, Math.min(5, L));
  const tail = (L >= 3) ? local.slice(-2) : '';
  const stars = '*'.repeat(Math.max(3, L - head.length - tail.length));
  return head + stars + tail + '@' + dom;
}

function maskMobile_(mobile){
  const raw = String(mobile||'').trim();
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g,'');
  if (digits.length < 7) return raw;
  const head = digits.slice(0,4);
  const tail = digits.slice(-3);
  const stars = '*'.repeat(Math.max(3, digits.length - 7));
  const plus = raw.startsWith('+') ? '+' : '';
  return plus + head + stars + tail;
}

function maskVrm_(vrm){
  const v = normalizeVrm_(vrm||'');
  if (!v) return '';
  return v.slice(0,4) + ' ***';
}

/* === PATCH_BOUNDARY: STAFF3_EMAILSTATUS_UI_HELPER_BEGIN ===
 * Used to provide consistent UI hints (esp. for ALREADY records).
 * (UI may choose to map statuses itself; this helper is safe and optional.)
 */
function emailUiFromStatus_(status){
  const s = String(status||'').trim().toUpperCase();
  if (s === 'SENT')   return { zh:'已發送電郵簽到證明。', en:'Email proof of check-in sent.' };
  if (s === 'OPTOUT') return { zh:'此會員已選擇不接收電郵。', en:'Email is opted out.' };
  if (s === 'NO_EMAIL') return { zh:'未有電郵資料。', en:'No email on file.' };
  if (s === 'QUOTA')  return { zh:'今日電郵額度已用完。', en:'Daily email quota exceeded.' };
  if (s === 'ERROR')  return { zh:'電郵發送失敗。', en:'Failed to send email.' };
  if (!s)             return { zh:'未有電郵狀態。', en:'No email status.' };
  return { zh:'電郵狀態：' + s, en:'Email status: ' + s };
}
/* === PATCH_BOUNDARY: STAFF3_EMAILSTATUS_UI_HELPER_END === */

/******** Members sheet + optional columns ********/
function getMembersSheet_() {
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

function getMembersIndex_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'membersIndex_staff_v1';
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  ensureMembersOptionalColumns_();

  const sh = getMembersSheet_();
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return { byId: {}, sheetName: sh.getName(), cols: {}, hasVRM: false };

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  const hasVRM = ('VRM' in col) || ('VRM2' in col);

  const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const byId = {};

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const id = String(row[col['ID']] || '').trim().toUpperCase();
    if (!id) continue;

    const vrm1 = hasVRM && ('VRM' in col) ? normalizeVrm_(row[col['VRM']]) : '';
    const vrm2 = hasVRM && ('VRM2' in col) ? normalizeVrm_(row[col['VRM2']]) : '';

    const roleExpires = ('RoleExpires' in col) ? safeToDate_(row[col['RoleExpires']]) : null;

    byId[id] = {
      rowNumber: r + 2,
      id,
      key: String(row[col['Key']] || '').trim(),
      nameZh: String(row[col['NameZh']] || '').trim(),
      nameEn: String(row[col['NameEn']] || '').trim(),
      email: String(row[col['Email']] || '').trim(),
      mobile: String(row[col['Mobile']] || '').trim(),
      status: String(row[col['Status']] || '').trim(),
      optOutEmail: String(row[col['OptOutEmail']] || '').trim(),
      notes: String(row[col['Notes']] || '').trim(),
      vrm: vrm1,
      vrm2: vrm2,
      roleExpires: roleExpires ? roleExpires.toISOString() : '' // store as ISO string for cache
    };
  }

  const payload = { byId, sheetName: sh.getName(), cols: col, hasVRM };
  cache.put(cacheKey, JSON.stringify(payload), 300);
  return payload;
}

function clearMembersIndexCache_(){
  try{ CacheService.getScriptCache().remove('membersIndex_staff_v1'); }catch(e){}
}

/******** System sheets ********/
function ensureCheckinsSheetColumns_(sh) {
  const needCols = 14;
  const lastCol = sh.getLastColumn();
  if (lastCol < needCols) sh.insertColumnsAfter(lastCol, needCols - lastCol);

  const hdr = sh.getRange(1, 1, 1, needCols).getValues()[0];
  const wanted = [
    'Timestamp','EventKey',
    'MemberId','MemberNameZh','MemberNameEn',
    'Method',
    'StaffId','StaffNameZh','StaffNameEn',
    'ReceiptId',
    'EmailTo','EmailStatus',
    'DeviceId','UserAgent'
  ];
  for (let i = 0; i < wanted.length; i++) {
    const v = String(hdr[i] || '').trim();
    if (!v) sh.getRange(1, i + 1).setValue(wanted[i]);
  }
}

function getCheckinsSheet_() {
  const ss = openSs_();
  let sh = ss.getSheetByName(CHECKINS_SHEET_NAME_PRIMARY);
  if (!sh) sh = ss.getSheetByName(CHECKINS_SHEET_NAME_LEGACY);

  if (!sh) {
    sh = ss.insertSheet(CHECKINS_SHEET_NAME_PRIMARY);
    sh.getRange(1, 1, 1, 14).setValues([[
      'Timestamp','EventKey',
      'MemberId','MemberNameZh','MemberNameEn',
      'Method',
      'StaffId','StaffNameZh','StaffNameEn',
      'ReceiptId',
      'EmailTo','EmailStatus',
      'DeviceId','UserAgent'
    ]]);
    sh.getRange(1, 1, 1, 14).setFontWeight('bold');
  } else {
    ensureCheckinsSheetColumns_(sh);
  }
  return sh;
}

function ensureActivityLogSheet_() {
  const ss = openSs_();
  let sh = ss.getSheetByName(ACTIVITY_LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(ACTIVITY_LOG_SHEET_NAME);
    sh.appendRow(['Timestamp','StaffId','StaffNameZh','StaffNameEn','Action','Details','EventKey']);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  return sh;
}

/******** Sessions ********/
function createSession_(staff) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ staff, createdAt: Date.now() }), SESSION_TTL_SECONDS);
  return token;
}

function getSession_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const k = 'sess_' + token;
  const raw = cache.get(k);
  if (!raw) return null;
  cache.put(k, raw, SESSION_TTL_SECONDS); // sliding
  try { return JSON.parse(raw); } catch (e) { cache.remove(k); return null; }
}

function requireSession_(token) {
  const sess = getSession_(token);
  if (!sess) return { ok:false, code:'E401', zh:'登入已過期，請重新登入', en:'Session expired. Please login again.' };
  return { ok:true, sess };
}

function api_ping(token){
  const sess = getSession_(token);
  if (!sess) return { ok:false };
  return { ok:true, staff: sess.staff };
}

function api_logout(token){
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return { ok:true };
}

/******** QR parsing ********/
function parseQrPayloadStrict_(raw) {
  const s = String(raw || '').trim();
  const parts = s.split('|');
  if (parts.length !== 2) {
    return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
  }
  const id = String(parts[0] || '').trim().toUpperCase();
  const key = String(parts[1] || '').trim();

  if (!id || !key) {
    return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
  }
  if (!/^CCF\d{4,}$/.test(id)) {
    return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
  }
  if (!/^k.+/.test(key)) {
    return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
  }
  return { ok:true, id, key };
}

function makeReceiptId_(ts) {
  const stamp = fmtUk_(ts, 'yyMMddHHmmss');
  const tail = Utilities.getUuid().slice(0,6).toUpperCase();
  return 'R' + stamp + '-' + tail;
}

/******** Login ********/
function api_login(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok:false, code:'E401', zh:'請掃描你的個人 QR code 登入', en:'Please scan your personal QR code to log in.' };

  if (raw === BYPASS_CODE) {
    const staff = { id:'SUPERUSER', nameZh:'SUPERUSER', nameEn:'SUPERUSER', status:'SUPERUSER', isSuper:true };
    const token = createSession_(staff);
    return { ok:true, token, staff };
  }

  const parsed = parseQrPayloadStrict_(raw);
  if (!parsed.ok) return parsed;

  const mi = getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此 ID，請聯絡影音同工', en:'Member ID not found. Please contact Media team.' };

  const st = normalizeStatus_(m.status);

  if (!st) return { ok:false, code:'E413', zh:'此會員狀態未設定，請聯絡影音同工', en:'Status not set. Please contact Media team.' };
  if (st === STATUS_DISABLED) return { ok:false, code:'E414', zh:'此帳號已停用，請聯絡接待同工', en:'Account is disabled. Please contact Welcome team.' };

  if (!isPortalUserAllowed_(st)) {
    return { ok:false, code:'E415', zh:'此帳號沒有權限登入同工專頁，請聯絡影音同工', en:'No permission for staff portal. Please contact Media team.' };
  }

  if (!m.key) return { ok:false, code:'E417', zh:'系統缺少 Key，請聯絡影音同工', en:'Key missing in database. Please contact Media team.' };
  if (m.key !== parsed.key) return { ok:false, code:'E418', zh:'Key 不相符，可能是舊 QR 卡，請聯絡影音同工', en:'Key mismatch (possibly old QR badge). Please contact Media team.' };

  // HELPER/TEMP expiry enforcement
  if (isHelperOrTemp_(st)) {
    const exp = m.roleExpires ? safeToDate_(m.roleExpires) : null;
    if (!exp) return { ok:false, code:'E419', zh:'此臨時權限缺少到期日，請聯絡影音同工', en:'Expiry missing. Please contact Media team.' };
    if (isExpired_(exp)) return { ok:false, code:'E420', zh:'此臨時權限已到期，請聯絡影音同工', en:'Temporary privilege expired. Please contact Media team.' };
  }

  const staff = { id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '', status:st, isSuper:false };
  const token = createSession_(staff);
  return { ok:true, token, staff };
}

function api_login_internal(input) {
  const raw = String(input || '').trim();
  if (raw === BYPASS_CODE) {
    const staff = { id:'SUPERUSER', nameZh:'SUPERUSER', nameEn:'SUPERUSER', status:'SUPERUSER', isSuper:true };
    const token = createSession_(staff);
    return { ok:true, token, staff };
  }
  return { ok:false, code:'E401', zh:'請掃描你的個人 QR code 登入', en:'Please scan your personal QR code to log in.' };
}

/******** Activity log (commit-only logging elsewhere uses this) ********/
function api_log_activity(token, action, details) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const sh = ensureActivityLogSheet_();
  const ts = nowUk_();
  const eventKey = getDefaultEventKey_();

  sh.appendRow([ts, staff.id, staff.nameZh || '', staff.nameEn || '', String(action||'').trim(), String(details||'').trim(), eventKey]);
  return { ok:true };
}

/******** Check-in: dedupe lookup ********/
/* === PATCH_BOUNDARY: STAFF3_CHECKIN_ALREADY_EMAILFIELDS_BEGIN ===
 * Enrich ALREADY payload with EmailStatus + masked EmailTo from Checkins row.
 */
function findExistingCheckin_(sh, eventKey, memberId) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  // Read first 12 columns (includes EmailTo + EmailStatus)
  const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const ev = String(row[1] || '').trim();
    const mid = String(row[2] || '').trim();
    if (ev === eventKey && mid === memberId) {
      const ts = row[0] instanceof Date ? row[0] : new Date(row[0]);
      const emailTo = String(row[10] || '').trim();
      const emailStatus = String(row[11] || '').trim();
      return {
        timeUk: fmtUk_(ts, 'HH:mm:ss'),
        eventKey: ev,
        handledBy: { staffId: String(row[6] || ''), nameZh: String(row[7] || ''), nameEn: String(row[8] || '') },
        receiptId: String(row[9] || ''),
        method: String(row[5] || ''),
        emailStatus: emailStatus || '',
        emailToMasked: emailTo ? maskEmail_(emailTo) : '',
        emailUi: emailUiFromStatus_(emailStatus || '')
      };
    }
  }
  return null;
}
/* === PATCH_BOUNDARY: STAFF3_CHECKIN_ALREADY_EMAILFIELDS_END === */

function validateMemberForCheckin_(m, parsedKeyOrNull) {
  const st = normalizeStatus_(m.status);
  if (!st) return { ok:false, code:'E413', zh:'此會員狀態未設定，請聯絡影音同工', en:'Status not set. Please contact Media team.' };
  if (st === STATUS_DISABLED) return { ok:false, code:'E414', zh:'此帳號已停用，請聯絡接待同工', en:'Account is disabled. Please contact Welcome team.' };
  if (!ALLOWED_STATUSES_FOR_CHECKIN.includes(st)) return { ok:false, code:'E413', zh:'此會員狀態不正確，請聯絡影音同工', en:'Invalid status. Please contact Media team.' };

  if (parsedKeyOrNull !== null) {
    if (!m.key) return { ok:false, code:'E417', zh:'系統缺少 Key，請聯絡影音同工', en:'Key missing in database. Please contact Media team.' };
    if (m.key !== parsedKeyOrNull) return { ok:false, code:'E418', zh:'Key 不相符，可能是舊 QR 卡，請聯絡影音同工', en:'Key mismatch (possibly old QR badge). Please contact Media team.' };
  }
  return { ok:true, status: st };
}

/******** Email proof (check-in) ********/
function maybeSendProofEmail_(member, eventKey, receiptId, ts) {
  const emailTo = String(member.email || '').trim();

  if (!emailTo) {
    return { status:'NO_EMAIL', to:'', ui:{ zh:'未有電郵資料。若下次需要電郵簽到證明，請聯絡影音同工。', en:'No email on file. If you want email proof next time, please speak to our Media team.' } };
  }
  if (isOptedOut_(member.optOutEmail)) {
    return { status:'OPTOUT', to:emailTo, ui:{ zh:'此會員已選擇不接收電郵。若下次需要電郵簽到證明，請聯絡影音同工。', en:'Email is opted out. If you want email proof next time, please speak to our Media team.' } };
  }
  const quota = MailApp.getRemainingDailyQuota();
  if (quota <= 0) {
    return { status:'QUOTA', to:emailTo, ui:{ zh:'今日電郵額度已用完。若下次需要電郵簽到證明，請聯絡影音同工。', en:'Daily email quota exceeded. If you want email proof next time, please speak to our Media team.' } };
  }

  const nameEn = String(member.nameEn || '').trim();
  const nameZh = String(member.nameZh || '').trim();
  const greetName = nameEn || nameZh || 'there';
  const dtLine = fmtUk_(ts, 'yyyy-MM-dd HH:mm:ss');

  const subject = `CCF Check-in proof / 簽到證明: ${eventKey} (Receipt ${receiptId})`;
  const body =
`Hi ${greetName},

This is your proof of check-in:
Event: ${eventKey}
Time (UK): ${dtLine}
Receipt ID: ${receiptId}

${nameZh ? nameZh + '，' : ''}你好：

以下為你的簽到證明：
活動：${eventKey}
時間（英國）：${dtLine}
Receipt ID：${receiptId}
`;

  try {
    MailApp.sendEmail(emailTo, subject, body);
    return { status:'SENT', to:emailTo, ui:{ zh:'已發送電郵簽到證明。', en:'Email proof of check-in sent.' } };
  } catch (e) {
    return { status:'ERROR', to:emailTo, ui:{ zh:'電郵發送失敗。若需要協助，請聯絡影音同工。', en:'Failed to send email. Please contact Media team for help.' } };
  }
}

/******** Check-in APIs ********/
function api_checkin_scan(token, qrPayload, eventKeyOptional, deviceId, ua) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;
  const staff = auth.sess.staff;

  const parsed = parseQrPayloadStrict_(qrPayload);
  if (!parsed.ok) return parsed;

  const m = getMembersIndex_().byId[parsed.id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此 ID，請聯絡影音同工', en:'Member ID not found. Please contact Media team.' };

  const v = validateMemberForCheckin_(m, parsed.key);
  if (!v.ok) return v;

  const eventKey = String(eventKeyOptional || '').trim() || getDefaultEventKey_();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sh = getCheckinsSheet_();

    const existing = findExistingCheckin_(sh, eventKey, m.id);
    if (existing) {
      return {
        ok:true,
        result:'ALREADY',
        eventKey,
        status: v.status,
        member:{ id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '' },
        already: existing
      };
    }

    const ts = nowUk_();
    const receiptId = makeReceiptId_(ts);
    const selfCheckin = (m.id === staff.id);

    const email = maybeSendProofEmail_(m, eventKey, receiptId, ts);

    sh.appendRow([
      ts, eventKey,
      m.id, m.nameZh || '', m.nameEn || '',
      'scan',
      staff.id, staff.nameZh || '', staff.nameEn || '',
      receiptId,
      email.to || '',
      email.status,
      String(deviceId || ''),
      String(ua || '')
    ]);

    CacheService.getScriptCache().remove('liveNames_' + eventKey);

    return {
      ok:true,
      result:'OK',
      eventKey,
      timeUk: fmtUk_(ts, 'HH:mm:ss'),
      status: v.status,
      member:{ id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '' },
      staff:{ id:staff.id, nameZh:staff.nameZh || '', nameEn:staff.nameEn || '' },
      receiptId,
      selfCheckin,
      emailUi: email.ui,
      emailStatus: email.status,
      emailToMasked: email.to ? maskEmail_(email.to) : ''
    };
  } finally {
    lock.releaseLock();
  }
}

function api_checkin_manual(token, memberId, eventKeyOptional, deviceId, ua) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;
  const staff = auth.sess.staff;

  const id = String(memberId || '').trim().toUpperCase();
  if (!id) return { ok:false, code:'E416', zh:'請輸入 ID', en:'Please enter an ID' };

  const m = getMembersIndex_().byId[id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此 ID，請聯絡影音同工', en:'Member ID not found. Please contact Media team.' };

  const v = validateMemberForCheckin_(m, null);
  if (!v.ok) return v;

  const eventKey = String(eventKeyOptional || '').trim() || getDefaultEventKey_();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sh = getCheckinsSheet_();

    const existing = findExistingCheckin_(sh, eventKey, m.id);
    if (existing) {
      return {
        ok:true,
        result:'ALREADY',
        eventKey,
        status: v.status,
        member:{ id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '' },
        already: existing
      };
    }

    const ts = nowUk_();
    const receiptId = makeReceiptId_(ts);

    const email = maybeSendProofEmail_(m, eventKey, receiptId, ts);

    sh.appendRow([
      ts, eventKey,
      m.id, m.nameZh || '', m.nameEn || '',
      'manual',
      staff.id, staff.nameZh || '', staff.nameEn || '',
      receiptId,
      email.to || '',
      email.status,
      String(deviceId || ''),
      String(ua || '')
    ]);

    CacheService.getScriptCache().remove('liveNames_' + eventKey);

    return {
      ok:true,
      result:'OK',
      eventKey,
      timeUk: fmtUk_(ts, 'HH:mm:ss'),
      status: v.status,
      member:{ id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '' },
      staff:{ id:staff.id, nameZh:staff.nameZh || '', nameEn:staff.nameEn || '' },
      receiptId,
      emailUi: email.ui,
      emailStatus: email.status,
      emailToMasked: email.to ? maskEmail_(email.to) : ''
    };
  } finally {
    lock.releaseLock();
  }
}

function api_search_members(token, query) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const q = String(query || '').trim();
  if (!q) return { ok:true, results:[] };

  const byId = getMembersIndex_().byId;

  if (/^CCF\d{4,}$/i.test(q)) {
    const id = q.toUpperCase();
    const m = byId[id];
    if (!m) return { ok:true, results:[] };
    if (normalizeStatus_(m.status) === STATUS_DISABLED) return { ok:true, results:[] };
    return { ok:true, results:[ { id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'' } ] };
  }

  const qLower = q.toLowerCase();
  const out = [];

  for (const id in byId) {
    const m = byId[id];
    if (normalizeStatus_(m.status) === STATUS_DISABLED) continue;

    const hay = [m.id, m.nameZh, m.nameEn, m.email, m.mobile]
      .map(x => String(x || '').toLowerCase())
      .join(' | ');

    if (hay.includes(qLower)) out.push({ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'' });
    if (out.length >= 12) break;
  }

  return { ok:true, results: out };
}

/******** Live page (names) ********/
/* === PATCH_BOUNDARY: STAFF3_LIVE_PAYLOAD_NEWFRIENDS_BEGIN === */
function api_get_live_page(token, eventKeyOptional) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const eventKey = String(eventKeyOptional || '').trim() || getDefaultEventKey_();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'liveNames_' + eventKey;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();
  const members = getMembersIndex_().byId;

  const latestById = {};
  let lastSignIn = null;

  if (lastRow >= 2) {
    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const ev = String(row[1] || '').trim();
      if (ev !== eventKey) continue;

      const mid = String(row[2] || '').trim();
      if (!mid) continue;

      const ts = row[0] instanceof Date ? row[0] : new Date(row[0]);
      const t = ts.getTime();

      const nameZh = String(row[3] || '') || (members[mid] ? (members[mid].nameZh || '') : '');
      const nameEn = String(row[4] || '') || (members[mid] ? (members[mid].nameEn || '') : '');

      const prev = latestById[mid];
      if (!prev || t > prev.t) latestById[mid] = { t, nameZh, nameEn };
    }

    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      const ev = String(row[1] || '').trim();
      if (ev !== eventKey) continue;

      const ts = row[0] instanceof Date ? row[0] : new Date(row[0]);
      lastSignIn = { timeUk: fmtUk_(ts, 'HH:mm:ss'), nameZh: String(row[3] || ''), nameEn: String(row[4] || '') };
      break;
    }
  }

  const ids = Object.keys(latestById);
  ids.sort((a,b) => latestById[b].t - latestById[a].t);

  const names = [];
  let newCount = 0;

  for (const id of ids) {
    const n = latestById[id];
    const m = members[id];
    const stNorm = m ? normalizeStatus_(m.status) : '';
    const isNew = isNewFriendStatus_(stNorm);
    if (isNew) newCount++;

    names.push({
      nameZh: n.nameZh || '',
      nameEn: n.nameEn || '',
      id: id,
      isNew: isNew
    });
  }

  const payload = {
    ok:true,
    eventKey,
    checkedInCount: names.length,
    newCount: newCount,
    lastSignIn,
    names
  };

  cache.put(cacheKey, JSON.stringify(payload), 15);
  return payload;
}
/* === PATCH_BOUNDARY: STAFF3_LIVE_PAYLOAD_NEWFRIENDS_END === */

/******** VRM search ********/
function api_search_vrm(token, query, eventKeyOptional) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const q = normalizeVrm_(query);
  const mi = getMembersIndex_();
  if (!q) return { ok:true, results:[], hasVRM: mi.hasVRM };

  const eventKey = String(eventKeyOptional || '').trim() || getDefaultEventKey_();

  // checked set
  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();
  const checkedSet = new Set();

  if (lastRow >= 2) {
    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (String(row[1] || '').trim() !== eventKey) continue;
      const mid = String(row[2] || '').trim();
      if (mid) checkedSet.add(mid);
    }
  }

  const out = [];
  for (const id in mi.byId) {
    const m = mi.byId[id];
    const v1 = m.vrm || '';
    const v2 = m.vrm2 || '';
    if ((v1 && v1.includes(q)) || (v2 && v2.includes(q))) {
      out.push({
        id: m.id,
        nameZh: m.nameZh || '',
        nameEn: m.nameEn || '',
        vrm: v1,
        vrm2: v2,
        checkedInToday: checkedSet.has(m.id)
      });
      if (out.length >= 12) break;
    }
  }

  return { ok:true, results: out, hasVRM: mi.hasVRM, eventKey };
}

/*****************************************************************
 * PENDING STAFF PORTAL FEATURES: backend endpoints
 *****************************************************************/

/******** Authorisation endpoints (UI will do scanning; backend enforces) ********/

/**
 * Validate an approver QR payload (must be STAFF/ADMIN)
 */
/* === PATCH_BOUNDARY: STAFF3_AUTH_STRICT_VALIDATE_APPROVER_BEGIN === */
function api_auth_validate_approver(token, approverQrPayload){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const sessStaff = auth.sess.staff;

  // HELPER/TEMP cannot authorise
  if (!sessStaff.isSuper && !isPrivilegedStaff_(sessStaff.status)) {
    return { ok:false, code:'E403', zh:'此帳號沒有授權權限', en:'No authorisation permission.' };
  }

  const parsed = parseQrPayloadStrict_(approverQrPayload);
  if (!parsed.ok) return parsed;

  const mi = getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

  const st = normalizeStatus_(m.status);

  // SUPERUSER: approver must be ADMIN only
  if (sessStaff.isSuper){
    if (st !== STATUS_ADMIN){
      return {
        ok:false,
        code:'E491',
        zh:'此操作需要管理員（ADMIN）授權。你掃描咗同工卡（STAFF）。請先登出，再用你自己嘅同工卡登入／或請管理員處理。',
        en:'ADMIN authorisation required. You scanned STAFF. Please log out and log in with your own ID, or ask an ADMIN.'
      };
    }
  } else {
    // Normal STAFF/ADMIN: self-only approver (must match session staff)
    if (parsed.id !== String(sessStaff.id||'').trim().toUpperCase()){
      return {
        ok:false,
        code:'E492',
        zh:'普通同工／管理員只可用你自己嘅 QR 作授權（自用）。請先登出，再用你自己嘅同工卡登入。',
        en:'STAFF/ADMIN can only approve using your own QR (self-only). Log out and log in with your own ID.'
      };
    }
  }

  if (!(st === STATUS_STAFF || st === STATUS_ADMIN)) {
    return { ok:false, code:'E415', zh:'此 QR 並非同工/管理員，不能授權', en:'Not STAFF/ADMIN. Cannot authorise.' };
  }
  if (!m.key || m.key !== parsed.key) {
    return { ok:false, code:'E418', zh:'Key 不相符（舊卡/錯誤 QR）', en:'Key mismatch.' };
  }

  return { ok:true, approver:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status:st } };
}
/* === PATCH_BOUNDARY: STAFF3_AUTH_STRICT_VALIDATE_APPROVER_END === */

/**
 * Validate a target QR payload (must exist, not disabled)
 */
/* === PATCH_BOUNDARY: STAFF3_AUTH_STRICT_VALIDATE_TARGET_BEGIN === */
function api_auth_validate_target(token, targetQrPayload){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const sessStaff = auth.sess.staff;
  if (!sessStaff.isSuper && !isPrivilegedStaff_(sessStaff.status)) {
    return { ok:false, code:'E403', zh:'此帳號沒有授權權限', en:'No authorisation permission.' };
  }

  const parsed = parseQrPayloadStrict_(targetQrPayload);
  if (!parsed.ok) return parsed;

  // Cannot self-authorise: when target equals current session staff ID
  // (This also matches “scanned yourself twice” scenario in the 2-step UI flow.)
  const sessId = String(sessStaff.id||'').trim().toUpperCase();
  if (!sessStaff.isSuper && sessId && parsed.id === sessId){
    return {
      ok:false,
      code:'E487',
      zh:'你已經掃描咗自己嘅 QR 兩次…請掃描『暫準同工』QR',
      en:'You scanned your own QR twice. Please scan the TEMP/HELPER target QR.'
    };
  }

  const mi = getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

  const st = normalizeStatus_(m.status);
  if (st === STATUS_DISABLED) return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };

  // cannot downgrade STAFF/ADMIN via HELPER/TEMP authorisation
  if (st === STATUS_STAFF || st === STATUS_ADMIN){
    return { ok:false, code:'E488', zh:'不能更改同工／管理員身份', en:'Cannot change STAFF/ADMIN role.' };
  }

  if (!m.key || m.key !== parsed.key) {
    return { ok:false, code:'E418', zh:'Key 不相符（可能是舊 QR）', en:'Key mismatch (possibly old QR).' };
  }

  return {
    ok:true,
    target:{
      id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status:st,
      roleExpires: m.roleExpires || ''
    }
  };
}
/* === PATCH_BOUNDARY: STAFF3_AUTH_STRICT_VALIDATE_TARGET_END === */

/**
 * Commit privilege change
 * newStatus: 'HELPER' or 'TEMP'
 * Requires:
 *   - Normal STAFF/ADMIN: approver must be self-only (session staff), and must be STAFF/ADMIN
 *   - SUPERUSER: approver must be ADMIN only
 * TEMP expiry = 2 days, HELPER expiry = 7 days.
 */
/* === PATCH_BOUNDARY: STAFF3_AUTH_STRICT_COMMIT_BEGIN === */
function api_auth_commit(token, approverId, targetId, newStatus){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const sessStaff = auth.sess.staff;

  // HELPER/TEMP cannot authorise
  if (!sessStaff.isSuper && !isPrivilegedStaff_(sessStaff.status)) {
    return { ok:false, code:'E403', zh:'此帳號沒有授權權限', en:'No authorisation permission.' };
  }

  const stNew = normalizeStatus_(newStatus);
  if (![STATUS_HELPER, STATUS_TEMP].includes(stNew)) {
    return { ok:false, code:'E422', zh:'授權類別不正確', en:'Invalid authorisation role.' };
  }

  const mi = getMembersIndex_();

  // Approver must exist
  const apId = String(approverId||'').trim().toUpperCase();
  const ap = mi.byId[apId];
  if (!ap) return { ok:false, code:'E412', zh:'找不到授權者', en:'Approver not found.' };
  const apSt = normalizeStatus_(ap.status);

  // SUPERUSER: approver must be ADMIN only
  if (sessStaff.isSuper){
    if (apSt !== STATUS_ADMIN){
      return {
        ok:false,
        code:'E491',
        zh:'此操作需要管理員（ADMIN）授權。你掃描咗同工卡（STAFF）。請先登出，再用你自己嘅同工卡登入／或請管理員處理。',
        en:'ADMIN authorisation required. You scanned STAFF. Please log out and log in with your own ID, or ask an ADMIN.'
      };
    }
  } else {
    // Normal STAFF/ADMIN: approver must be self-only (session staff)
    const sessId = String(sessStaff.id||'').trim().toUpperCase();
    if (!sessId || apId !== sessId){
      return {
        ok:false,
        code:'E492',
        zh:'普通同工／管理員只可用你自己嘅 QR 作授權（自用）。請先登出，再用你自己嘅同工卡登入。',
        en:'STAFF/ADMIN can only approve using your own QR (self-only). Log out and log in with your own ID.'
      };
    }
  }

  if (!(apSt === STATUS_STAFF || apSt === STATUS_ADMIN)) {
    return { ok:false, code:'E415', zh:'授權者必須為同工/管理員', en:'Approver must be STAFF/ADMIN.' };
  }

  // Target
  const tgtId = String(targetId||'').trim().toUpperCase();
  if (!tgtId) return { ok:false, code:'E416', zh:'找不到目標會員', en:'Target not found.' };

  // Cannot self-authorise: approver == target
  if (tgtId === apId){
    return {
      ok:false,
      code:'E487',
      zh:'你已經掃描咗自己嘅 QR 兩次…請掃描『暫準同工』QR',
      en:'You scanned your own QR twice. Please scan the TEMP/HELPER target QR.'
    };
  }

  const tgt = mi.byId[tgtId];
  if (!tgt) return { ok:false, code:'E412', zh:'找不到目標會員', en:'Target not found.' };
  const oldSt = normalizeStatus_(tgt.status);
  if (oldSt === STATUS_DISABLED) return { ok:false, code:'E414', zh:'目標帳號已停用', en:'Target disabled.' };

  // cannot downgrade STAFF/ADMIN
  if (oldSt === STATUS_STAFF || oldSt === STATUS_ADMIN){
    return { ok:false, code:'E488', zh:'不能更改同工／管理員身份', en:'Cannot change STAFF/ADMIN role.' };
  }

  // Update Members sheet: Status + RoleExpires
  const sh = getMembersSheet_();
  const cols = mi.cols;
  const rowNumber = tgt.rowNumber || findMemberRowById_(sh, cols, tgtId);
  if (!rowNumber) return { ok:false, code:'E500', zh:'找不到目標記錄行', en:'Target row not found.' };

  const expDays = (stNew === STATUS_TEMP) ? TEMP_EXPIRY_DAYS : HELPER_EXPIRY_DAYS;
  const expiry = addDays_(nowUk_(), expDays);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try{
    setMemberCell_(sh, cols, rowNumber, 'Status', stNew);
    setMemberCell_(sh, cols, rowNumber, 'RoleExpires', expiry);

    clearMembersIndexCache_();

    // Log commit-only
    const shLog = ensureActivityLogSheet_();
    shLog.appendRow([
      nowUk_(),
      sessStaff.id,
      sessStaff.nameZh||'',
      sessStaff.nameEn||'',
      'AUTHORISE_PRIVILEGE',
      JSON.stringify({
        bySession: { id:sessStaff.id, status:sessStaff.status },
        approver: { id: ap.id, status: apSt },
        target: { id: tgtId, oldStatus: oldSt, newStatus: stNew },
        expiryIso: expiry.toISOString()
      }),
      getDefaultEventKey_()
    ]);

    // Return BOTH roleExpires and roleExpiresIso for UI compatibility
    return {
      ok:true,
      target:{
        id:tgtId,
        oldStatus: oldSt,
        newStatus: stNew,
        roleExpires: expiry.toISOString(),
        roleExpiresIso: expiry.toISOString()
      }
    };
  } finally {
    lock.releaseLock();
  }
}
/* === PATCH_BOUNDARY: STAFF3_AUTH_STRICT_COMMIT_END === */

/******** Live: member detail (tap name) ********/
function api_live_get_member_detail(token, memberId, eventKeyOptional){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const st = normalizeStatus_(staff.status);

  // TEMP/HELPER cannot access
  if (!staff.isSuper && !(st === STATUS_STAFF || st === STATUS_ADMIN)) {
    return { ok:false, code:'E403', zh:'此功能只供同工/管理員使用', en:'Staff/Admin only.' };
  }

  const id = String(memberId||'').trim().toUpperCase();
  const mi = getMembersIndex_().byId;
  const m = mi[id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };
  if (normalizeStatus_(m.status) === STATUS_DISABLED) return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };

  const eventKey = String(eventKeyOptional||'').trim() || getDefaultEventKey_();
  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();

  let today = null;
  const eventKeys = []; // last 4 distinct event keys

  if (lastRow >= 2){
    const data = sh.getRange(2, 1, lastRow-1, 12).getValues();
    const seenEv = new Set();
    for (let i = data.length-1; i>=0; i--){
      const row = data[i];
      const ev = String(row[1]||'').trim();
      const mid = String(row[2]||'').trim();
      if (mid !== id) continue;

      if (!today && ev === eventKey){
        const ts = row[0] instanceof Date ? row[0] : new Date(row[0]);
        today = {
          eventKey: ev,
          timeUk: fmtUk_(ts,'HH:mm:ss'),
          method: String(row[5]||''),
          handledBy: { id:String(row[6]||''), nameZh:String(row[7]||''), nameEn:String(row[8]||'') },
          receiptId: String(row[9]||'')
        };
      }

      if (ev && !seenEv.has(ev)){
        seenEv.add(ev);
        eventKeys.push(ev);
        if (eventKeys.length >= 4) break;
      }
    }
  }

  return {
    ok:true,
    member:{
      id: m.id,
      nameZh: m.nameZh||'',
      nameEn: m.nameEn||'',
      vrm: m.vrm||'',
      vrm2: m.vrm2||'',
      status: normalizeStatus_(m.status)
    },
    today: today,
    last4EventKeys: eventKeys
  };
}

/******** Delete today's attendance endpoint (unchanged) ********/
function api_live_delete_today_checkin(token, memberId, reauthQrPayload, adminQrPayloadOptional){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const st = normalizeStatus_(staff.status);
  const eventKey = getDefaultEventKey_();
  const mi = getMembersIndex_();

  const isPriv = staff.isSuper || (st === STATUS_STAFF || st === STATUS_ADMIN);
  if (!isPriv) return { ok:false, code:'E403', zh:'此功能只供同工/管理員使用', en:'Staff/Admin only.' };

  let auditLabel = staff.id;
  let auditNameZh = staff.nameZh||'';
  let auditNameEn = staff.nameEn||'';

  if (staff.isSuper){
    const parsed = parseQrPayloadStrict_(adminQrPayloadOptional);
    if (!parsed.ok) return { ok:false, code:'E490', zh:'需要掃描管理員（ADMIN）QR 以作記錄', en:'ADMIN QR required for audit.' };

    const admin = mi.byId[parsed.id];
    if (!admin) return { ok:false, code:'E412', zh:'找不到管理員記錄', en:'Admin not found.' };

    const admSt = normalizeStatus_(admin.status);
    if (admSt !== STATUS_ADMIN){
      return {
        ok:false,
        code:'E491',
        zh:'此操作需要管理員（ADMIN）授權。你掃描咗同工卡（STAFF）。請先登出，再用你自己嘅同工卡登入／或請管理員處理。',
        en:'ADMIN authorisation required. You scanned STAFF. Please log out and log in with your own ID, or ask an ADMIN.'
      };
    }
    if (!admin.key || admin.key !== parsed.key){
      return { ok:false, code:'E418', zh:'管理員 Key 不相符（舊卡/錯誤 QR）', en:'Admin key mismatch.' };
    }

    auditLabel = 'SUPERUSER (ADMIN:' + admin.id + ')';
    auditNameZh = admin.nameZh || 'ADMIN';
    auditNameEn = admin.nameEn || 'ADMIN';

  } else {
    const parsed = parseQrPayloadStrict_(reauthQrPayload);
    if (!parsed.ok) return parsed;

    if (parsed.id !== staff.id){
      return {
        ok:false,
        code:'E492',
        zh:'你掃描嘅並非你本人同工卡。請先登出，再用你自己嘅同工卡登入。',
        en:'You did not scan your own staff badge. Log out and log in with your own ID.'
      };
    }

    const staffRec = mi.byId[staff.id];
    if (!staffRec) return { ok:false, code:'E412', zh:'找不到同工記錄', en:'Staff record not found.' };

    const sst = normalizeStatus_(staffRec.status);
    if (!(sst === STATUS_STAFF || sst === STATUS_ADMIN)){
      return { ok:false, code:'E493', zh:'此帳號不是同工/管理員', en:'Not staff/admin.' };
    }
    if (!staffRec.key || staffRec.key !== parsed.key){
      return { ok:false, code:'E418', zh:'Key 不相符（舊卡/錯誤 QR）', en:'Key mismatch.' };
    }

    auditLabel = staff.id;
    auditNameZh = staff.nameZh||'';
    auditNameEn = staff.nameEn||'';
  }

  const targetId = String(memberId||'').trim().toUpperCase();
  const target = mi.byId[targetId];
  if (!target) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try{
    const sh = getCheckinsSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok:false, code:'E404', zh:'今日暫無簽到記錄', en:'No check-ins today.' };

    const data = sh.getRange(2, 1, lastRow-1, 12).getValues();
    let hitIdx = -1;
    for (let i=data.length-1; i>=0; i--){
      const ev = String(data[i][1]||'').trim();
      const mid = String(data[i][2]||'').trim();
      if (ev === eventKey && mid === targetId){
        hitIdx = i;
        break;
      }
    }
    if (hitIdx < 0) return { ok:false, code:'E404', zh:'找不到此會員今日簽到記錄', en:'Today check-in not found.' };

    const deleteRowNumber = hitIdx + 2;
    sh.deleteRow(deleteRowNumber);

    CacheService.getScriptCache().remove('liveNames_' + eventKey);

    const emailRes = maybeSendDeleteNoticeEmail_(target, eventKey, auditLabel, auditNameZh, auditNameEn);

    const logSh = ensureActivityLogSheet_();
    logSh.appendRow([
      nowUk_(),
      auditLabel,
      auditNameZh,
      auditNameEn,
      'DELETE_TODAY_CHECKIN',
      JSON.stringify({
        eventKey: eventKey,
        memberId: targetId,
        memberNameZh: target.nameZh||'',
        memberNameEn: target.nameEn||'',
        emailStatus: emailRes.status,
        emailToMasked: emailRes.toMasked
      }),
      eventKey
    ]);

    return {
      ok:true,
      deleted:{
        eventKey: eventKey,
        memberId: targetId,
        memberNameZh: target.nameZh||'',
        memberNameEn: target.nameEn||'',
        by: auditLabel
      },
      email: emailRes
    };
  } finally {
    lock.releaseLock();
  }
}

function maybeSendDeleteNoticeEmail_(member, eventKey, byLabel, byNameZh, byNameEn){
  const to = String(member.email||'').trim();
  const opted = isOptedOut_(member.optOutEmail);
  const quota = MailApp.getRemainingDailyQuota();

  const out = { status:'', toMasked:'', sent:false };

  if (!to){
    out.status = 'NO_EMAIL';
    return out;
  }
  out.toMasked = maskEmail_(to);

  if (opted){
    out.status = 'OPTOUT';
    return out;
  }
  if (quota <= 0){
    out.status = 'QUOTA';
    return out;
  }

  const nameEn = String(member.nameEn||'').trim();
  const nameZh = String(member.nameZh||'').trim();
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
    MailApp.sendEmail(to, subject, body);
    out.status = 'SENT';
    out.sent = true;
    return out;
  }catch(e){
    out.status = 'ERROR';
    return out;
  }
}

/******** Members sheet row helpers for authorisation ********/
function findMemberRowById_(sh, cols, id){
  const idx = cols['ID'];
  if (idx === undefined) return null;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const data = sh.getRange(2, idx+1, lastRow-1, 1).getValues();
  for (let i=0;i<data.length;i++){
    const v = String(data[i][0]||'').trim().toUpperCase();
    if (v === id) return i+2;
  }
  return null;
}

function setMemberCell_(sh, cols, rowNumber, headerName, value){
  if (!(headerName in cols)) {
    ensureMembersOptionalColumns_();
    clearMembersIndexCache_();
    const mi = getMembersIndex_();
    cols = mi.cols;
  }
  const idx = cols[headerName];
  if (idx === undefined) return;
  sh.getRange(rowNumber, idx+1).setValue(value);
}
