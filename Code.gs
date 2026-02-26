/***************************************
 * CCF Live Service Portal (stable + upgrades)
 * File: Code.gs
 * v2026-02-02.staff8
 *
 * ============================================================
 * CHANGELOG (staff8)
 * ============================================================
 * [1] SECURITY: staff secret stored in Script Properties (no hardcode)
 *
 * [2] SEARCH: optimised CCF ID behaviour
 *     - "CCF" alone => no results
 *     - Full CCF#### => exact match only
 *     - Partial CCF digits (CCF0/CCF00/CCF000) => max 4 closest matches (ID-only)
 *
 * [3] SELF-TEST: discrete endpoints + Healthcheck sheet
 *     - api_selfcheck_readonly()          (no writes; safe)
 *     - api_selfcheck_write_test()        (writes to Healthcheck sheet only)
 *     - api_selfcheck_mark_completed()    (writes STAFF_CONFIRM to Healthcheck)
 *     - doGet(?mode=healthping) returns plain "OK staff <version>"
 *
 * [4] NOTE: No changes to QR parsing, scan stability, check-in dedupe, authorisation rules.
 *     Core check-in behaviour preserved.
 ***************************************/

const APP_VERSION = '2026-02-15.staff95';
const SPREADSHEET_ID = '1hVeWUwt79qIXqQ0R0UTqvFXwOvkcQYDjmSePw5AenPA';

const TZ = 'Europe/London';
const SESSION_TTL_SECONDS = 4 * 60 * 60;
const EXTERNAL_SCANNER_TIMEOUT_MS = 120000;

// Sheets
const CHECKINS_SHEET_NAME_PRIMARY = 'Checkins';
const CHECKINS_SHEET_NAME_LEGACY = 'CHECKINS';
const ACTIVITY_LOG_SHEET_NAME = 'Activity_log';
const NEW_FRIEND_HANDLED_SHEET_NAME = 'NewFriendHandled';

// Healthcheck (self-test) sheet (NEW)
const HEALTHCHECK_SHEET_NAME = 'Healthcheck';

// Members required headers (order-insensitive in staff7+)
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

// Check-in allowed
const ALLOWED_STATUSES_FOR_CHECKIN = [
  STATUS_ACTIVE, STATUS_PENDING, STATUS_PROVISIONAL,
  STATUS_STAFF, STATUS_ADMIN, STATUS_HELPER, STATUS_TEMP
];

// Staff portal login allowed
const ALLOWED_STATUSES_FOR_PORTAL = [STATUS_STAFF, STATUS_ADMIN, STATUS_HELPER, STATUS_TEMP];

// Privilege expiry configuration
const HELPER_EXPIRY_DAYS = 31;
const TEMP_EXPIRY_DAYS = 2;

// Optional Members columns used by Live Service Portal (auto-added if missing)
const MEMBERS_OPTIONAL_HEADERS = [
  'VRM','VRM2',
  'RoleExpires',
  'PreferredName',
  'IsMinor',
  'ServingGroups',
  'ServingGLGroups',
  'AwayFrom1',
  'AwayTo1',
  'AwayFrom2',
  'AwayTo2'
];

// Serving sheet (read-only in Live Service Portal)
const SERVING_SHEET_NAME = 'Serving';
const SERVING_POSITION_GROUPS = {
  Worship_Lead: 'WORSHIP',
  Worship_Singer_1: 'WORSHIP',
  Worship_Singer_2: 'WORSHIP',
  Worship_Pianist: 'WORSHIP',
  Worship_Drum: 'WORSHIP',
  Worship_Instrument_1: 'WORSHIP',
  Worship_Instrument_2: 'WORSHIP',
  Media_AV: 'MEDIA',
  Media_PPT: 'MEDIA',
  Media_PPTBuild: 'MEDIA',
  Support_BibleReader: 'SUPPORT',
  Support_Prayer: 'SUPPORT',
  Support_Communion: 'SUPPORT',
  Support_Care: 'SUPPORT',
  Logistic_Welcome: 'LOGISTIC',
  Logistic_Venue: 'LOGISTIC',
  Logistic_Refreshment: 'LOGISTIC',
  Finance_Offering: 'FINANCE',
  Other: 'OTHER'
};

/******** Web App Router ********/
function doGet(e) {
  const mode = String((e && e.parameter && e.parameter.mode) || '').toLowerCase();

  // Public health ping for uptime/deployment checks (NEW)
  if (mode === 'healthping') {
    return ContentService.createTextOutput('OK staff ' + APP_VERSION)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  if (mode === 'reg') return doGetReg_(e); // Reg.gs
  if (mode === 'admin') return doGetAdmin_(e); // Admin.gs

  const t = HtmlService.createTemplateFromFile('index');
  t.APP_VERSION = APP_VERSION;
  const scannerCfg = getExternalScannerConfig_();
  t.EXTERNAL_SCANNER_URL = scannerCfg.url;
  t.EXTERNAL_SCANNER_ORIGIN = scannerCfg.origin;
  t.EXTERNAL_SCANNER_TIMEOUT_MS = scannerCfg.timeoutMs;
  return t.evaluate()
    .setTitle('CCF Live Service Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getExternalScannerConfig_(){
  try{
    const p = PropertiesService.getScriptProperties();
    return {
      url: String(p.getProperty('EXTERNAL_SCANNER_URL') || '').trim(),
      origin: String(p.getProperty('EXTERNAL_SCANNER_ORIGIN') || '').trim(),
      timeoutMs: EXTERNAL_SCANNER_TIMEOUT_MS
    };
  }catch(e){
    return { url:'', origin:'', timeoutMs: EXTERNAL_SCANNER_TIMEOUT_MS };
  }
}


function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const body = JSON.parse(raw);
    const fn = String(body.fn || '').trim();
    const args = Array.isArray(body.args) ? body.args : [];
    const result = invokeRpcFunction_(fn, args);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, result: result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: {
        message: String(err && err.message ? err.message : err),
        name: String(err && err.name ? err.name : 'Error')
      }
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function invokeRpcFunction_(fn, args){
  if (!/^[a-zA-Z0-9_]+$/.test(fn)) {
    throw new Error('Invalid function name.');
  }

  const allowedPrefixes = ['api_', 'admin_', 'reg_'];
  const isAllowed = allowedPrefixes.some(prefix => fn.indexOf(prefix) === 0);
  if (!isAllowed) {
    throw new Error('Function not exposed over RPC.');
  }

  const target = this[fn];
  if (typeof target !== 'function') {
    throw new Error('Function not found: ' + fn);
  }

  return target.apply(null, args || []);
}

/******** Helpers ********/
function openSs_(){ return SpreadsheetApp.openById(SPREADSHEET_ID); }
function nowUk_(){ return new Date(); }
function fmtUk_(d, p){ return Utilities.formatDate(d, TZ, p); }
function getDefaultEventKey_(){ return 'SundayService_' + fmtUk_(nowUk_(), 'yyyy-MM-dd'); }

function normalizeStatus_(s){ return String(s || '').trim().toUpperCase(); }
function normalizeVrm_(s){ return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function normalizeServingGroupToken_(token){
  const t = String(token || '').trim().toUpperCase();
  if (!t) return '';
  const alias = {
    'MEDIA':'MEDIA','MEDIA MASTER':'MEDIA','MEDIA-MASTER':'MEDIA','影像大師':'MEDIA',
    'WORSHIP':'WORSHIP','WORSHIP ALLIANCE':'WORSHIP','敬拜聯盟':'WORSHIP',
    'LOGISTIC':'LOGISTIC','LOGISTICS':'LOGISTIC','LOGISTIC SPECIALIST':'LOGISTIC','後勤特工':'LOGISTIC',
    'SUPPORT':'SUPPORT','DIVINE SUPPORTER':'SUPPORT','聖工支援隊':'SUPPORT',
    'FINANCE':'FINANCE','FINANCE DEPT':'FINANCE','財務公司':'FINANCE'
  };
  return alias[t] || t;
}
function parseGroupsCsv_(value){
  return Array.from(new Set(
    String(value || '')
      .split(/[;,\n|]+/)
      .map(v => normalizeServingGroupToken_(v))
      .filter(Boolean)
  ));
}
function isServingNaValue_(value){
  const v = String(value || '').trim().toUpperCase();
  return (v === 'N/A' || v === 'NA');
}

// Staff secret from Script Properties (NEW)
function getStaffBypassCode_(){
  try{
    const p = PropertiesService.getScriptProperties();
    return String(p.getProperty('STAFF_BYPASS_CODE') || '').trim();
  }catch(e){
    return '';
  }
}

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

function maskVrm_(vrm){
  const v = normalizeVrm_(vrm||'');
  if (!v) return '';
  return v.slice(0,4) + ' ***';
}

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


/******** Members sheet detection (order-insensitive) ********/
function getMembersSheet_() {
  const ss = openSs_();
  const sheets = ss.getSheets();
  const req = MEMBERS_HEADERS_REQUIRED.slice();

  let best = null; // { sh, score }

  for (const sh of sheets) {
    const lastCol = sh.getLastColumn();
    if (lastCol < req.length) continue;

    const header = sh.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(v => String(v || '').trim());

    const present = new Set(header.filter(Boolean));
    const hasAll = req.every(h => present.has(h));
    if (!hasAll) continue;

    const nameBonus = /^members$/i.test(String(sh.getName()||'')) ? 50 : 0;
    const first11 = header.slice(0, req.length);
    const exactFirst11 = req.every((h, i) => first11[i] === h);
    const orderBonus = exactFirst11 ? 5 : 0;
    const score = nameBonus + orderBonus;

    if (!best || score > best.score) best = { sh, score };
  }

  if (best) return best.sh;
  throw new Error('Members sheet not found (required headers missing).');
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
  headers.forEach((h, i) => { if (h) col[h] = i; });

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

    const preferredName = ('PreferredName' in col) ? String(row[col['PreferredName']] || '').trim() : '';
    const isMinorRaw = ('IsMinor' in col) ? String(row[col['IsMinor']] || '').trim().toUpperCase() : '';
    const isMinor = (isMinorRaw === 'YES');
    const servingGroups = ('ServingGroups' in col) ? parseGroupsCsv_(row[col['ServingGroups']]) : [];
    const servingGlGroups = ('ServingGLGroups' in col) ? parseGroupsCsv_(row[col['ServingGLGroups']]) : [];

    byId[id] = {
      rowNumber: r + 2,
      id,
      key: String(row[col['Key']] || '').trim(),
      nameZh: String(row[col['NameZh']] || '').trim(),
      nameEn: String(row[col['NameEn']] || '').trim(),
      preferredName: preferredName,
      isMinor: !!isMinor,
      email: String(row[col['Email']] || '').trim(),
      mobile: String(row[col['Mobile']] || '').trim(),
      status: String(row[col['Status']] || '').trim(),
      optOutEmail: String(row[col['OptOutEmail']] || '').trim(),
      notes: String(row[col['Notes']] || '').trim(),
      vrm: vrm1,
      vrm2: vrm2,
      roleExpires: roleExpires ? roleExpires.toISOString() : '',
      familyId: ('FamilyID' in col) ? String(row[col['FamilyID']] || '').trim() : '',
      servingGroups: servingGroups,
      servingGlGroups: servingGlGroups
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

function getServingSheet_(){
  const ss = openSs_();
  return ss.getSheetByName(SERVING_SHEET_NAME) || null;
}

function getServingMatrix_(sh){
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const positions = [];
  for (let i=1;i<headers.length;i++){
    const parsed = parseServingHeader_(headers[i]);
    positions.push({
      colIndex: i + 1,
      key: headers[i],
      group: parsed.group,
      position: parsed.position
    });
  }
  return { eventCol: 1, positions: positions };
}
function parseServingHeader_(header){
  const raw = String(header||'').trim();
  if (!raw) return { group:'', position:'' };
  if (raw.includes('::')){
    const parts = raw.split('::');
    return { group: String(parts[0]||'').trim().toUpperCase(), position: String(parts.slice(1).join('::')||'').trim() };
  }
  if (raw.includes(' - ')){
    const parts = raw.split(' - ');
    return { group: String(parts[0]||'').trim().toUpperCase(), position: String(parts.slice(1).join(' - ')||'').trim() };
  }
  if (raw.includes('/')){
    const parts = raw.split('/').map(p => String(p||'').trim()).filter(Boolean);
    if (parts.length){
      const key = parts[0];
      const groupFromKey = SERVING_POSITION_GROUPS[key] || '';
      if (groupFromKey){
        return { group: groupFromKey, position: key };
      }
    }
    return { group: String(parts[0]||'').trim().toUpperCase(), position: String(parts.slice(1).join('/')||'').trim() };
  }
  const groupFromKey = SERVING_POSITION_GROUPS[raw] || '';
  return { group: groupFromKey, position: raw };
}
function parseServingMemberIds_(raw){
  const s = String(raw||'').trim();
  if (!s) return [];
  return s.split(',').map(v => String(v||'').trim()).filter(Boolean);
}
function findServingEventRowIndex_(sh, eventKey){
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i=0;i<values.length;i++){
    if (String(values[i][0]||'').trim() === eventKey) return i + 2;
  }
  return null;
}
function getServingForEvent_(eventKey, membersById, checkedInSet){
  const sh = getServingSheet_();
  if (!sh) return [];
  const rowIndex = findServingEventRowIndex_(sh, eventKey);
  if (!rowIndex) return [];

  const lastCol = sh.getLastColumn();
  if (lastCol < 2) return [];
  const matrix = getServingMatrix_(sh);
  const row = sh.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  const out = [];

  matrix.positions.forEach(function(pos){
    const raw = String(row[pos.colIndex-1] || '').trim();
    if (!raw) return;
    if (isServingNaValue_(raw)) return;
    const entries = parseServingMemberIds_(raw);
    if (!entries.length) return;
    entries.forEach(function(entry){
      if (!entry) return;
      if (isServingNaValue_(entry)) return;
      const matched = String(entry || '').trim().match(/CCF\d{4}/i);
      const memberId = matched ? matched[0].toUpperCase() : String(entry || '').trim().toUpperCase();
      if (!memberId) return;
      const m = membersById[memberId] || {};
      out.push({
        eventKey: eventKey,
        group: pos.group,
        position: pos.position,
        slot: '',
        memberId: memberId || entry,
        nameZh: String(m.nameZh || ''),
        nameEn: String(m.nameEn || ''),
        checkedIn: checkedInSet.has(memberId)
      });
    });
  });

  out.sort((a,b)=> {
    const g = a.group.localeCompare(b.group);
    if (g !== 0) return g;
    const p = a.position.localeCompare(b.position);
    if (p !== 0) return p;
    return a.memberId.localeCompare(b.memberId);
  });
  return out;
}

// Healthcheck sheet ensure (NEW)
function ensureHealthcheckSheet_(){
  const ss = openSs_();
  let sh = ss.getSheetByName(HEALTHCHECK_SHEET_NAME);
  if (!sh){
    sh = ss.insertSheet(HEALTHCHECK_SHEET_NAME);
    sh.appendRow(['Timestamp','StaffId','StaffNameZh','StaffNameEn','Action','Details','EventKey','DeviceId','UserAgent']);
    sh.getRange(1,1,1,9).setFontWeight('bold');
  }
  return sh;
}

/******** New-friend handled (persistent) ********/
function ensureNewFriendHandledSheet_(){
  const ss = openSs_();
  let sh = ss.getSheetByName(NEW_FRIEND_HANDLED_SHEET_NAME);
  if (!sh){
    sh = ss.insertSheet(NEW_FRIEND_HANDLED_SHEET_NAME);
    sh.appendRow(['Timestamp','EventKey','MemberId','StaffId','StaffNameZh','StaffNameEn']);
    sh.getRange(1,1,1,6).setFontWeight('bold');
  }
  return sh;
}
function newFriendHandledKey_(eventKey, memberId){
  return 'newHandled_' + String(eventKey||'').trim() + '_' + String(memberId||'').trim().toUpperCase();
}
function isNewFriendSuppressed_(eventKey, memberId){
  const key = newFriendHandledKey_(eventKey, memberId);
  try{
    if (CacheService.getScriptCache().get(key)) return true;
  }catch(e){}
  const sh = ensureNewFriendHandledSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  const data = sh.getRange(2,1,lastRow-1,3).getValues();
  const ev = String(eventKey||'').trim();
  const mid = String(memberId||'').trim().toUpperCase();
  for (let i=0;i<data.length;i++){
    if (String(data[i][1]||'').trim() === ev && String(data[i][2]||'').trim().toUpperCase() === mid){
      try{ CacheService.getScriptCache().put(key, '1', 12 * 60 * 60); }catch(e){}
      return true;
    }
  }
  return false;
}
function setNewFriendSuppressed_(eventKey, memberId, staff){
  const sh = ensureNewFriendHandledSheet_();
  sh.appendRow([
    nowUk_(),
    String(eventKey||'').trim(),
    String(memberId||'').trim().toUpperCase(),
    staff && staff.id ? staff.id : '',
    staff && staff.nameZh ? staff.nameZh : '',
    staff && staff.nameEn ? staff.nameEn : ''
  ]);
  try{ CacheService.getScriptCache().put(newFriendHandledKey_(eventKey, memberId), '1', 12 * 60 * 60); }catch(e){}
}
function clearNewFriendSuppressed_(eventKey, memberId){
  try{ CacheService.getScriptCache().remove(newFriendHandledKey_(eventKey, memberId)); }catch(e){}
  const sh = ensureNewFriendHandledSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const data = sh.getRange(2,1,lastRow-1,3).getValues();
  const ev = String(eventKey||'').trim();
  const mid = String(memberId||'').trim().toUpperCase();
  for (let i=data.length-1;i>=0;i--){
    if (String(data[i][1]||'').trim() === ev && String(data[i][2]||'').trim().toUpperCase() === mid){
      sh.deleteRow(i+2);
    }
  }
}

/******** New friend history helper ********/
function hasAnyCheckinEver_(sh, memberId){
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  const id = String(memberId||'').trim();
  if (!id) return false;
  const rng = sh.getRange(2, 3, lastRow - 1, 1); // MemberId col
  const hit = rng.createTextFinder(id).matchEntireCell(true).findNext();
  return !!hit;
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
  cache.put(k, raw, SESSION_TTL_SECONDS);
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

  if (!id || !key) return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
  if (!/^CCF\d{4,}$/.test(id)) return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
  if (!/^k.+/.test(key)) return { ok:false, code:'E416', zh:'QR 格式錯誤，請聯絡影音同工', en:'Invalid QR format. Please contact Media team.' };
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

  // SUPERUSER via Script Properties (hidden)
  const bypass = getStaffBypassCode_();
  if (bypass && raw === bypass) {
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

  // enforce RoleExpires for any status with expiry; auto-downgrade to ACTIVE on expiry
  if (m.roleExpires){
    const exp = safeToDate_(m.roleExpires);
    if (!exp){
      return { ok:false, code:'E419', zh:'權限到期日格式錯誤，請聯絡影音同工', en:'Invalid expiry format. Please contact Media team.' };
    }
    if (isExpired_(exp)){
      try{
        const sh = getMembersSheet_();
        const cols = getMembersColMap_(sh);
        const rowNumber = m.rowNumber || findMemberRowById_(sh, cols, parsed.id);
        if (rowNumber){
          setMemberCell_(sh, cols, rowNumber, 'Status', STATUS_ACTIVE);
          setMemberCell_(sh, cols, rowNumber, 'RoleExpires', '');
          clearMembersIndexCache_();
        }
      }catch(e){}
      const stNow = STATUS_ACTIVE;
      if (!isPortalUserAllowed_(stNow)) {
        return { ok:false, code:'E415', zh:'此帳號沒有權限登入同工專頁，請聯絡影音同工', en:'No permission for staff portal. Please contact Media team.' };
      }
      const staff = { id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '', status:stNow, isSuper:false };
      const token = createSession_(staff);
      return { ok:true, token, staff };
    }
  }

  const staff = { id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '', status:st, isSuper:false };
  const token = createSession_(staff);
  return { ok:true, token, staff };
}

function api_login_internal(input) {
  const raw = String(input || '').trim();
  const bypass = getStaffBypassCode_();
  if (bypass && raw === bypass) {
    const staff = { id:'SUPERUSER', nameZh:'SUPERUSER', nameEn:'SUPERUSER', status:'SUPERUSER', isSuper:true };
    const token = createSession_(staff);
    return { ok:true, token, staff };
  }
  return { ok:false, code:'E401', zh:'請掃描你的個人 QR code 登入', en:'Please scan your personal QR code to log in.' };
}

/******** Activity log ********/
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


function api_log_scanner_e420(payload){
  try{
    const sh = ensureActivityLogSheet_();
    const ts = nowUk_();
    const eventKey = getDefaultEventKey_();
    const p = payload || {};
    const details = {
      stage: String(p.stage || ''),
      diagnostics: p.diagnostics || {},
      deviceId: String(p.deviceId || ''),
      ua: String(p.ua || '')
    };
    sh.appendRow([ts, 'PUBLIC', 'PUBLIC', 'PUBLIC', 'SCANNER_E420', JSON.stringify(details), eventKey]);
    return { ok:true };
  }catch(e){
    return { ok:false, code:'E500', zh:'系統錯誤', en:'System error', detail:String(e&&e.message||e) };
  }
}

/******** Check-in dedupe lookup ********/
function findExistingCheckin_(sh, eventKey, memberId) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

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
  const pref = String(member.preferredName || '').trim();
  const greetName = pref || nameEn || nameZh || 'there';

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

  const mi = getMembersIndex_();
  const m = mi.byId[parsed.id];
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
        member:{
          id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '',
          preferredName: m.preferredName || '',
          isMinor: !!m.isMinor,
          isNewFriend: false
        },
        already: existing
      };
    }

    // New friend = no prior check-in ever and not STAFF/ADMIN
    const hadAny = hasAnyCheckinEver_(sh, m.id);
    const stNorm = normalizeStatus_(m.status);
    const isNewFriend = (!hadAny && !(stNorm === STATUS_STAFF || stNorm === STATUS_ADMIN));

    const ts = nowUk_();
    const receiptId = makeReceiptId_(ts);

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
      member:{
        id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '',
        preferredName: m.preferredName || '',
        isMinor: !!m.isMinor,
        isNewFriend: !!isNewFriend
      },
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

function api_checkin_manual(token, memberId, eventKeyOptional, deviceId, ua) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;

  const id = String(memberId || '').trim().toUpperCase();
  if (!id) return { ok:false, code:'E416', zh:'請輸入 ID', en:'Please enter an ID' };

  const mi = getMembersIndex_();
  const m = mi.byId[id];
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
        member:{
          id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '',
          preferredName: m.preferredName || '',
          isMinor: !!m.isMinor,
          isNewFriend: false
        },
        already: existing
      };
    }

    const hadAny = hasAnyCheckinEver_(sh, m.id);
    const stNorm = normalizeStatus_(m.status);
    const isNewFriend = (!hadAny && !(stNorm === STATUS_STAFF || stNorm === STATUS_ADMIN));

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
      member:{
        id:m.id, nameZh:m.nameZh || '', nameEn:m.nameEn || '',
        preferredName: m.preferredName || '',
        isMinor: !!m.isMinor,
        isNewFriend: !!isNewFriend
      },
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

/******** Manual search (optimised) ********/
function api_checkin_manual_bulk(token, memberIds, eventKeyOptional, deviceId, ua){
  const ids = Array.isArray(memberIds) ? memberIds : [];
  const out = [];
  for (let i=0;i<ids.length;i++){
    const id = String(ids[i] || '').trim().toUpperCase();
    if (!id) continue;
    const res = api_checkin_manual(token, id, eventKeyOptional, deviceId, ua);
    out.push({ id:id, ok: !!(res && res.ok), result: res });
  }
  return { ok:true, results: out };
}


function api_search_members(token, query) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const q = String(query || '').trim();
  if (!q) return { ok:true, results:[] };

  const byId = getMembersIndex_().byId;
  const qUpper = q.toUpperCase();

  // "CCF" alone => no results
  if (qUpper === 'CCF') return { ok:true, results:[] };

  // Full ID exact match only
  if (/^CCF\d{4,}$/i.test(qUpper)) {
    const m = byId[qUpper];
    if (!m) return { ok:true, results:[] };
    if (normalizeStatus_(m.status) === STATUS_DISABLED) return { ok:true, results:[] };
    return { ok:true, results:[ { id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', preferredName:m.preferredName||'' } ] };
  }

  // Partial CCF digits => show up to 4 closest matches (ID-only)
  if (/^CCF\d{1,3}$/i.test(qUpper)) {
    const digits = qUpper.replace(/^CCF/i,'');
    const out = [];

    // 1) padded “closest” first (e.g. CCF2 -> CCF0002)
    const num = parseInt(digits,10);
    if (!isNaN(num)) {
      const padded = 'CCF' + String(num).padStart(4,'0');
      if (byId[padded] && normalizeStatus_(byId[padded].status) !== STATUS_DISABLED) {
      const m0 = byId[padded];
      out.push({ id:m0.id, nameZh:m0.nameZh||'', nameEn:m0.nameEn||'', preferredName:m0.preferredName||'' });
    }
    }

    // 2) prefix matches (e.g. CCF00)
    const starts = [];
    for (const id in byId) {
      if (!id.startsWith(qUpper)) continue;
      const m = byId[id];
      if (normalizeStatus_(m.status) === STATUS_DISABLED) continue;
      if (out.some(x => x.id === m.id)) continue;
      starts.push(m);
    }
    starts.sort((a,b)=> a.id.localeCompare(b.id));
    starts.slice(0, 4 - out.length).forEach(m=>{
      out.push({ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', preferredName:m.preferredName||'' });
    });

    return { ok:true, results: out.slice(0,4) };
  }

  // Generic search (same behaviour, cap 12)
  const qLower = q.toLowerCase();
  const out = [];

  for (const id in byId) {
    const m = byId[id];
    if (normalizeStatus_(m.status) === STATUS_DISABLED) continue;

    const hay = [m.id, m.nameZh, m.nameEn, m.preferredName, m.email, m.mobile]
      .map(x => String(x || '').toLowerCase())
      .join(' | ');

    if (hay.includes(qLower)) out.push({ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', preferredName:m.preferredName||'' });
    if (out.length >= 12) break;
  }

  return { ok:true, results: out };
}

/******** Live page ********/
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
  const hadPriorEvent = new Set(); // any check-in with eventKey != current
  let lastSignIn = null;

  if (lastRow >= 2) {
    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const ev = String(row[1] || '').trim();
      const mid = String(row[2] || '').trim();
      if (!mid) continue;

      if (ev !== eventKey) {
        hadPriorEvent.add(mid);
        continue;
      }

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

    const isNewHistory = (!hadPriorEvent.has(id) && !(stNorm === STATUS_STAFF || stNorm === STATUS_ADMIN));
    const suppressed = isNewHistory ? isNewFriendSuppressed_(eventKey, id) : false;
    const isNew = isNewHistory && !suppressed;

    if (isNew) newCount++;

    names.push({
      nameZh: n.nameZh || '',
      nameEn: n.nameEn || '',
      preferredName: m ? (m.preferredName || '') : '',
      id: id,
      isNew: isNew,
      isMinor: !!(m && m.isMinor)
    });
  }

  const checkedInSet = new Set(ids);
  const servingToday = getServingForEvent_(eventKey, members, checkedInSet);

  const payload = {
    ok:true,
    eventKey,
    checkedInCount: names.length,
    newCount: newCount,
    lastSignIn,
    names,
    servingToday
  };

  cache.put(cacheKey, JSON.stringify(payload), 15);
  return payload;
}

/******** VRM search ********/
function api_search_vrm(token, query, eventKeyOptional) {
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const q = normalizeVrm_(query);
  const mi = getMembersIndex_();
  if (!q) return { ok:true, results:[], hasVRM: mi.hasVRM };

  const eventKey = String(eventKeyOptional || '').trim() || getDefaultEventKey_();

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
        preferredName: m.preferredName || '',
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
 * Authorisation endpoints (strict enforcement preserved)
 *****************************************************************/
function api_auth_validate_approver(token, approverQrPayload){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const sessStaff = auth.sess.staff;
  if (!sessStaff.isSuper && !isPrivilegedStaff_(sessStaff.status)) {
    return { ok:false, code:'E403', zh:'此帳號沒有授權權限', en:'No authorisation permission.' };
  }

  const parsed = parseQrPayloadStrict_(approverQrPayload);
  if (!parsed.ok) return parsed;

  const mi = getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

  const st = normalizeStatus_(m.status);

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

function api_auth_validate_target(token, targetQrPayload){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const sessStaff = auth.sess.staff;
  if (!sessStaff.isSuper && !isPrivilegedStaff_(sessStaff.status)) {
    return { ok:false, code:'E403', zh:'此帳號沒有授權權限', en:'No authorisation permission.' };
  }

  const parsed = parseQrPayloadStrict_(targetQrPayload);
  if (!parsed.ok) return parsed;

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
  if (st === STATUS_STAFF || st === STATUS_ADMIN) return { ok:false, code:'E488', zh:'不能更改同工／管理員身份', en:'Cannot change STAFF/ADMIN role.' };

  if (!m.key || m.key !== parsed.key) return { ok:false, code:'E418', zh:'Key 不相符（可能是舊 QR）', en:'Key mismatch (possibly old QR).' };

  return { ok:true, target:{ id:m.id, nameZh:m.nameZh||'', nameEn:m.nameEn||'', status:st, roleExpires: m.roleExpires || '' } };
}

function api_auth_commit(token, approverId, targetId, newStatus){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const sessStaff = auth.sess.staff;
  if (!sessStaff.isSuper && !isPrivilegedStaff_(sessStaff.status)) return { ok:false, code:'E403', zh:'此帳號沒有授權權限', en:'No authorisation permission.' };

  const stNew = normalizeStatus_(newStatus);
  if (![STATUS_HELPER, STATUS_TEMP].includes(stNew)) return { ok:false, code:'E422', zh:'授權類別不正確', en:'Invalid authorisation role.' };
  if (stNew === STATUS_HELPER) {
    return { ok:false, code:'E403', zh:'HELPER 只可於管理員平台授權', en:'HELPER can only be granted via the Admin portal.' };
  }

  const mi = getMembersIndex_();

  const apId = String(approverId||'').trim().toUpperCase();
  const ap = mi.byId[apId];
  if (!ap) return { ok:false, code:'E412', zh:'找不到授權者', en:'Approver not found.' };
  const apSt = normalizeStatus_(ap.status);

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

  if (!(apSt === STATUS_STAFF || apSt === STATUS_ADMIN)) return { ok:false, code:'E415', zh:'授權者必須為同工/管理員', en:'Approver must be STAFF/ADMIN.' };

  const tgtId = String(targetId||'').trim().toUpperCase();
  if (!tgtId) return { ok:false, code:'E416', zh:'找不到目標會員', en:'Target not found.' };
  if (tgtId === apId) return { ok:false, code:'E487', zh:'你已經掃描咗自己嘅 QR 兩次…請掃描『暫準同工』QR', en:'You scanned your own QR twice. Please scan the TEMP/HELPER target QR.' };

  const tgt = mi.byId[tgtId];
  if (!tgt) return { ok:false, code:'E412', zh:'找不到目標會員', en:'Target not found.' };
  const oldSt = normalizeStatus_(tgt.status);
  if (oldSt === STATUS_DISABLED) return { ok:false, code:'E414', zh:'目標帳號已停用', en:'Target disabled.' };
  if (oldSt === STATUS_STAFF || oldSt === STATUS_ADMIN) return { ok:false, code:'E488', zh:'不能更改同工／管理員身份', en:'Cannot change STAFF/ADMIN role.' };

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

    return { ok:true, target:{ id:tgtId, oldStatus: oldSt, newStatus: stNew, roleExpires: expiry.toISOString(), roleExpiresIso: expiry.toISOString() } };
  } finally {
    lock.releaseLock();
  }
}

/******** Live: member detail (tap name) ********/
function api_live_get_member_detail(token, memberId, eventKeyOptional){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const st = normalizeStatus_(staff.status);
  if (!staff.isSuper && !ALLOWED_STATUSES_FOR_PORTAL.includes(st)) return { ok:false, code:'E403', zh:'此功能只供同工使用', en:'Staff portal accounts only.' };

  const id = String(memberId||'').trim().toUpperCase();
  const mi = getMembersIndex_().byId;
  const m = mi[id];
  if (!m) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };
  if (normalizeStatus_(m.status) === STATUS_DISABLED) return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };

  const eventKey = String(eventKeyOptional||'').trim() || getDefaultEventKey_();
  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();

  let today = null;
  const eventKeys = [];
  let hadPriorEvent = false;

  if (lastRow >= 2){
    const data = sh.getRange(2, 1, lastRow-1, 12).getValues();
    const seenEv = new Set();
    for (let i = data.length-1; i>=0; i--){
      const row = data[i];
      const ev = String(row[1]||'').trim();
      const mid = String(row[2]||'').trim();
      if (mid !== id) continue;

      if (ev && ev !== eventKey) hadPriorEvent = true;
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

  const familyId = String(m.familyId || '').trim();
  const familyMembers = [];
  if (familyId){
    Object.keys(mi).forEach(function(fid){
      const fm = mi[fid];
      if (!fm) return;
      if (normalizeStatus_(fm.status) === STATUS_DISABLED) return;
      if (String(fm.familyId||'').trim() !== familyId) return;
      familyMembers.push({
        id: fm.id,
        nameZh: fm.nameZh||'',
        nameEn: fm.nameEn||'',
        preferredName: fm.preferredName||''
      });
    });
    familyMembers.sort(function(a,b){ return String(a.id||'').localeCompare(String(b.id||'')); });
  }

  return {
    ok:true,
    member:{
      id: m.id,
      nameZh: m.nameZh||'',
      nameEn: m.nameEn||'',
      preferredName: m.preferredName||'',
      isMinor: !!m.isMinor,
      vrm: m.vrm||'',
      vrm2: m.vrm2||'',
      familyId: familyId,
      status: normalizeStatus_(m.status),
      isNewFriend: (function(){
        const stNorm = normalizeStatus_(m.status);
        const isNewHistory = (!hadPriorEvent && !(stNorm === STATUS_STAFF || stNorm === STATUS_ADMIN));
        if (!isNewHistory) return false;
        return !isNewFriendSuppressed_(eventKey, id);
      })()
    },
    familyMembers: familyMembers,
    today: today,
    last4EventKeys: eventKeys
  };
}

/******** Session-only suppression of 🆕 (same audit flow as delete; no email) ********/
function api_live_suppress_new_friend(token, memberId, reauthQrPayload, adminQrPayloadOptional){
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

  let byId = staff.id;
  let byNameZh = staff.nameZh||'';
  let byNameEn = staff.nameEn||'';

  if (staff.isSuper){
    if (adminQrPayloadOptional){
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

      byId = admin.id;
      byNameZh = admin.nameZh || '';
      byNameEn = admin.nameEn || '';
    } else {
      auditLabel = 'SUPERUSER';
      auditNameZh = staff.nameZh || 'SUPERUSER';
      auditNameEn = staff.nameEn || 'SUPERUSER';
      byId = staff.id;
      byNameZh = staff.nameZh || '';
      byNameEn = staff.nameEn || '';
    }

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
    if (!(sst === STATUS_STAFF || sst === STATUS_ADMIN)) return { ok:false, code:'E493', zh:'此帳號不是同工/管理員', en:'Not staff/admin.' };
    if (!staffRec.key || staffRec.key !== parsed.key) return { ok:false, code:'E418', zh:'Key 不相符（舊卡/錯誤 QR）', en:'Key mismatch.' };

    byId = staff.id;
    byNameZh = staffRec.nameZh || staff.nameZh || '';
    byNameEn = staffRec.nameEn || staff.nameEn || '';
  }

  const targetId = String(memberId||'').trim().toUpperCase();
  const target = mi.byId[targetId];
  if (!target) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };

  setNewFriendSuppressed_(eventKey, targetId, { id: byId, nameZh: byNameZh, nameEn: byNameEn });
  CacheService.getScriptCache().remove('liveNames_' + eventKey);

  const logSh = ensureActivityLogSheet_();
  logSh.appendRow([
    nowUk_(),
    auditLabel,
    auditNameZh,
    auditNameEn,
    'SUPPRESS_NEW_FRIEND',
    JSON.stringify({
      eventKey: eventKey,
      memberId: targetId,
      memberNameZh: target.nameZh||'',
      memberNameEn: target.nameEn||'',
      byId: byId,
      byNameZh: byNameZh,
      byNameEn: byNameEn,
      note: 'Suppress 🆕 for this event only; no email'
    }),
    eventKey
  ]);

  return {
    ok:true,
    eventKey: eventKey,
    target:{
      id: targetId,
      nameZh: target.nameZh||'',
      nameEn: target.nameEn||'',
      byId: byId,
      byNameZh: byNameZh,
      byNameEn: byNameEn
    }
  };
}

function deleteCheckinsForEventMember_(eventKey, memberId){
  const sh = getCheckinsSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const data = sh.getRange(2, 1, lastRow-1, 12).getValues();
  const rowsToDelete = [];
  for (let i=0;i<data.length;i++){
    const ev = String(data[i][1]||'').trim();
    const mid = String(data[i][2]||'').trim();
    if (ev === eventKey && mid === memberId){
      rowsToDelete.push(i + 2);
    }
  }
  for (let i=rowsToDelete.length-1;i>=0;i--){
    sh.deleteRow(rowsToDelete[i]);
  }
  return rowsToDelete.length;
}

/******** Delete today's attendance ********/
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

  let byId = staff.id;
  let byNameZh = staff.nameZh||'';
  let byNameEn = staff.nameEn||'';

  if (staff.isSuper){
    if (adminQrPayloadOptional){
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

      byId = admin.id;
      byNameZh = admin.nameZh || '';
      byNameEn = admin.nameEn || '';
    } else {
      auditLabel = 'SUPERUSER';
      auditNameZh = staff.nameZh || 'SUPERUSER';
      auditNameEn = staff.nameEn || 'SUPERUSER';
      byId = staff.id;
      byNameZh = staff.nameZh || '';
      byNameEn = staff.nameEn || '';
    }

  } else {
    const parsed = parseQrPayloadStrict_(reauthQrPayload);
    if (!parsed.ok) return parsed;

    if (parsed.id !== staff.id){
      return { ok:false, code:'E492', zh:'你掃描嘅並非你本人同工卡。請先登出，再用你自己嘅同工卡登入。', en:'You did not scan your own staff badge. Log out and log in with your own ID.' };
    }

    const staffRec = mi.byId[staff.id];
    if (!staffRec) return { ok:false, code:'E412', zh:'找不到同工記錄', en:'Staff record not found.' };

    const sst = normalizeStatus_(staffRec.status);
    if (!(sst === STATUS_STAFF || sst === STATUS_ADMIN)) return { ok:false, code:'E493', zh:'此帳號不是同工/管理員', en:'Not staff/admin.' };
    if (!staffRec.key || staffRec.key !== parsed.key) return { ok:false, code:'E418', zh:'Key 不相符（舊卡/錯誤 QR）', en:'Key mismatch.' };

    byId = staff.id;
    byNameZh = staffRec.nameZh || staff.nameZh || '';
    byNameEn = staffRec.nameEn || staff.nameEn || '';
  }

  const targetId = String(memberId||'').trim().toUpperCase();
  const target = mi.byId[targetId];
  if (!target) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try{
    const deletedCount = deleteCheckinsForEventMember_(eventKey, targetId);
    if (!deletedCount) return { ok:false, code:'E404', zh:'找不到此會員今日簽到記錄', en:'Today check-in not found.' };

    clearNewFriendSuppressed_(eventKey, targetId);
    CacheService.getScriptCache().remove('liveNames_' + eventKey);

    const emailRes = maybeSendDeleteNoticeEmail_(target, eventKey, auditLabel);

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
        byId: byId,
        byNameZh: byNameZh,
        byNameEn: byNameEn,
        deletedCount: deletedCount,
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
        by: auditLabel,
        byId: byId,
        byNameZh: byNameZh,
        byNameEn: byNameEn
      },
      email: emailRes
    };
  } finally {
    lock.releaseLock();
  }
}

/******** Live: mark new friend handled (no QR reauth) ********/
function api_newfriend_mark_handled(token, memberId, eventKeyOptional){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const st = normalizeStatus_(staff.status);
  const isPriv = staff.isSuper || (st === STATUS_STAFF || st === STATUS_ADMIN);
  if (!isPriv) return { ok:false, code:'E403', zh:'此功能只供同工/管理員使用', en:'Staff/Admin only.' };

  const eventKey = String(eventKeyOptional||'').trim() || getDefaultEventKey_();
  const targetId = String(memberId||'').trim().toUpperCase();
  if (!targetId) return { ok:false, code:'E416', zh:'找不到此會員', en:'Member not found.' };

  const mi = getMembersIndex_();
  const target = mi.byId[targetId];
  if (!target) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };

  setNewFriendSuppressed_(eventKey, targetId, { id: staff.id, nameZh: staff.nameZh||'', nameEn: staff.nameEn||'' });
  CacheService.getScriptCache().remove('liveNames_' + eventKey);

  const logSh = ensureActivityLogSheet_();
  logSh.appendRow([
    nowUk_(),
    staff.id,
    staff.nameZh||'',
    staff.nameEn||'',
    'NEWFRIEND_HANDLED',
    JSON.stringify({
      eventKey: eventKey,
      memberId: targetId,
      memberNameZh: target.nameZh||'',
      memberNameEn: target.nameEn||'',
      byId: staff.id,
      byNameZh: staff.nameZh||'',
      byNameEn: staff.nameEn||''
    }),
    eventKey
  ]);

  return { ok:true, eventKey: eventKey, memberId: targetId };
}

/******** Live: delete checkin (no QR reauth) ********/
function api_checkin_delete(token, memberId, eventKeyOptional){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const st = normalizeStatus_(staff.status);
  const isPriv = staff.isSuper || (st === STATUS_STAFF || st === STATUS_ADMIN);
  if (!isPriv) return { ok:false, code:'E403', zh:'此功能只供同工/管理員使用', en:'Staff/Admin only.' };

  const eventKey = String(eventKeyOptional||'').trim() || getDefaultEventKey_();
  const targetId = String(memberId||'').trim().toUpperCase();
  if (!targetId) return { ok:false, code:'E416', zh:'找不到此會員', en:'Member not found.' };

  const mi = getMembersIndex_();
  const target = mi.byId[targetId];
  if (!target) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const deletedCount = deleteCheckinsForEventMember_(eventKey, targetId);
    if (!deletedCount) return { ok:false, code:'E404', zh:'找不到此會員今日簽到記錄', en:'Today check-in not found.' };

    clearNewFriendSuppressed_(eventKey, targetId);
    CacheService.getScriptCache().remove('liveNames_' + eventKey);

    const logSh = ensureActivityLogSheet_();
    logSh.appendRow([
      nowUk_(),
      staff.id,
      staff.nameZh||'',
      staff.nameEn||'',
      'DELETE_CHECKIN',
      JSON.stringify({
        eventKey: eventKey,
        memberId: targetId,
        memberNameZh: target.nameZh||'',
        memberNameEn: target.nameEn||'',
        byId: staff.id,
        byNameZh: staff.nameZh||'',
        byNameEn: staff.nameEn||'',
        deletedCount: deletedCount
      }),
      eventKey
    ]);

    return { ok:true, eventKey: eventKey, memberId: targetId, deletedCount: deletedCount };
  } finally {
    lock.releaseLock();
  }
}

function maybeSendDeleteNoticeEmail_(member, eventKey, byLabel){
  const to = String(member.email||'').trim();
  const opted = isOptedOut_(member.optOutEmail);
  const quota = MailApp.getRemainingDailyQuota();

  const out = { status:'', toMasked:'', sent:false };

  if (!to){ out.status = 'NO_EMAIL'; return out; }
  out.toMasked = maskEmail_(to);

  if (opted){ out.status = 'OPTOUT'; return out; }
  if (quota <= 0){ out.status = 'QUOTA'; return out; }

  const nameEn = String(member.nameEn||'').trim();
  const nameZh = String(member.nameZh||'').trim();
  const pref = String(member.preferredName||'').trim();
  const greet = pref || nameEn || nameZh || 'there';

  const subject = 'CCF Attendance Deleted / 出席記錄已刪除';
  const body =
`Hi ${greet},

Your attendance record has been DELETED:
Event: ${eventKey}

Handled by: ${byLabel}

If you believe this is a mistake, please contact CCF staff as soon as possible.

${nameZh ? nameZh + '，' : ''}你好：
你於以下聚會的出席記錄已被刪除：
活動：${eventKey}

經手：${byLabel}

如你認為有誤，請盡快聯絡同工。`;

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

/******** Self-test APIs (discrete) ********/
function api_selfcheck_readonly(token){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const eventKey = getDefaultEventKey_();
  const out = { ok:true, eventKey:eventKey, timeIso: nowUk_().toISOString(), checks:[] };

  function add(ok, zh, en, detail){
    out.checks.push({ ok: !!ok, zh:String(zh||''), en:String(en||''), detail:String(detail||'') });
  }

  // Members sheet
  try{
    const shM = getMembersSheet_();
    add(!!shM, 'Members 表正常', 'Members sheet OK', shM ? shM.getName() : '');
  }catch(e){
    add(false, 'Members 表異常', 'Members sheet ERROR', String(e && e.message || e));
  }

  // Members index
  try{
    const mi = getMembersIndex_();
    const n = mi && mi.byId ? Object.keys(mi.byId).length : 0;
    add(true, 'Members 索引正常', 'Members index OK', 'count=' + n);
  }catch(e){
    add(false, 'Members 索引異常', 'Members index ERROR', String(e && e.message || e));
  }

  // Checkins sheet structure
  try{
    const shC = getCheckinsSheet_();
    ensureCheckinsSheetColumns_(shC);
    add(true, 'Checkins 表正常', 'Checkins sheet OK', shC ? shC.getName() : '');
  }catch(e){
    add(false, 'Checkins 表異常', 'Checkins sheet ERROR', String(e && e.message || e));
  }

  // Activity log ensure
  try{
    ensureActivityLogSheet_();
    add(true, 'Activity log 正常', 'Activity log OK', ACTIVITY_LOG_SHEET_NAME);
  }catch(e){
    add(false, 'Activity log 異常', 'Activity log ERROR', String(e && e.message || e));
  }

  // Lock test
  try{
    const lock = LockService.getScriptLock();
    lock.waitLock(1500);
    lock.releaseLock();
    add(true, '鎖定機制正常', 'Lock OK', '');
  }catch(e){
    add(false, '鎖定機制異常', 'Lock ERROR', String(e && e.message || e));
  }

  // Email quota (read)
  try{
    const q = MailApp.getRemainingDailyQuota();
    add(true, '電郵額度可讀取', 'Email quota readable', 'quota=' + q);
  }catch(e){
    add(false, '電郵額度異常', 'Email quota ERROR', String(e && e.message || e));
  }

  return out;
}

function api_selfcheck_write_test(token, deviceId, ua){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const eventKey = getDefaultEventKey_();

  try{
    const sh = ensureHealthcheckSheet_();
    sh.appendRow([nowUk_(), staff.id, staff.nameZh||'', staff.nameEn||'', 'WRITE_TEST', 'ok', eventKey, String(deviceId||''), String(ua||'')]);
    return { ok:true, eventKey:eventKey, zh:'✅ 已完成寫入測試', en:'✅ Write test completed' };
  }catch(e){
    return { ok:false, code:'E500', zh:'寫入測試失敗', en:'Write test failed', detail:String(e && e.message || e) };
  }
}

function api_selfcheck_mark_completed(token, deviceId, ua){
  const auth = requireSession_(token);
  if (!auth.ok) return auth;

  const staff = auth.sess.staff;
  const eventKey = getDefaultEventKey_();

  try{
    const sh = ensureHealthcheckSheet_();
    sh.appendRow([nowUk_(), staff.id, staff.nameZh||'', staff.nameEn||'', 'STAFF_CONFIRM', 'Self-check completed by staff', eventKey, String(deviceId||''), String(ua||'')]);
    return { ok:true, eventKey:eventKey, zh:'✅ 已記錄「同工已確認」', en:'✅ Staff confirmation logged' };
  }catch(e){
    return { ok:false, code:'E500', zh:'記錄失敗', en:'Log failed', detail:String(e && e.message || e) };
  }
}

/******** Members sheet row helpers ********/
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

/* ===== END OF Code.gs (COMPLETE) ===== */
