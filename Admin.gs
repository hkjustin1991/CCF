/***************************************
 * CCF Admin Portal (attendance & stats)
 * File: Admin.gs
 * v2026-08-28.admin122
 * CHANGELOG: carry the optional exact Chinese display name through shared member indexes.
 *
 * Route: ?mode=admin  -> doGetAdmin_() renders Admin2.html
 *
 * Login:
 * - STAFF/DEACON/ADMIN via personal QR (CCF####|k...)
 * - SUPERUSER via secret stored in Script Properties.
 *
 * IMPORTANT:
 * - Secret is NOT hard-coded in this file.
 * - UI must not display the secret.
 *
 * Data sources:
 * - Members sheet (existing schema; required headers may be in any order)
 * - Checkins sheet (existing)
 *
 * Limits:
 * - STAFF: max 181 days range
 * - DEACON/ADMIN/SUPERUSER: max 366 days range
 *
 * Extra requirements:
 * - DISABLED members:
 *    • appear in member search
 *    • included in attendance totals/stats (attendance comes from Checkins)
 *    • hidden from matrix columns (not returned in members[] for matrix)
 * - Low attendance flag 〽️ (today-based, join-aware):
 *    • rolling 6 months ending today (UK time)
 *    • denominator starts at max(joinDate, windowStart)
 *    • suppressed before 2026-04-01 and if too few services in window
 * - Monthly + seasonal stats with UNIQUE attendance + UNIQUE new attendees
 * - Service stats dialog support:
 *    • api_admin_event_detail() returns per-service totals + expandable lists
 *      (reserved placeholders for offering/serving later)
 * - Contact/VRM reveal:
 *    • confirmation reason + QR re-scan (must match current session actor)
 *    • SUPERUSER must scan a DEACON/ADMIN QR (and it must match that member)
 * - Status change (STAFF also allowed):
 *    • dropdown STAFF/ACTIVE/DISABLED/PROVISIONAL/TEMP/HELPER
 *    • TEMP via admin portal = 2 days (RoleExpires)
 *    • HELPER via admin portal = 31 days (RoleExpires)
 *    • QR re-scan confirmation (same rules as contact reveal)
 *    • Hard-stop: cannot change another DEACON/ADMIN account's status
 * - Separate audit sheet: Admin_Activity logs actions
 ***************************************/

// ---- Config ----
const ADMIN_VERSION = '2026-08-28.admin122';
const ADMIN_TEMPLATE = 'Admin2'; // Admin2.html

// Uses main project spreadsheet if present; else fallback.
const ADMIN_SPREADSHEET_ID = (typeof SPREADSHEET_ID !== 'undefined')
  ? SPREADSHEET_ID
  : '1hVeWUwt79qIXqQ0R0UTqvFXwOvkcQYDjmSePw5AenPA';

const ADMIN_TZ = (typeof TZ !== 'undefined') ? TZ : 'Europe/London';

// Session
const ADMIN_SESSION_TTL_SECONDS = 4 * 60 * 60;
const ADMIN_SESSION_PREFIX = 'admin_sess_';

// Sheets
const ADMIN_CHECKINS_SHEET_NAME_PRIMARY = (typeof CHECKINS_SHEET_NAME_PRIMARY !== 'undefined') ? CHECKINS_SHEET_NAME_PRIMARY : 'Checkins';
const ADMIN_CHECKINS_SHEET_NAME_LEGACY  = (typeof CHECKINS_SHEET_NAME_LEGACY  !== 'undefined') ? CHECKINS_SHEET_NAME_LEGACY  : 'CHECKINS';
const ADMIN_AUDIT_SHEET_NAME = 'Admin_Activity';

// Members required headers (must all exist in header row)
const ADMIN_MEMBERS_HEADERS_REQUIRED = [
  'FamilyID','MemberLetter','ID','Key','NameZh','NameEn','Email','Mobile','Status','OptOutEmail','Notes'
];
const ADMIN_MINOR_SERVING_HEADERS = [
  'IsMinor',
  'MinorServingApprovedGroups',
  'MinorServingSelfSignup',
  'MinorServingApprovedBy',
  'MinorServingApprovedAt'
];
const ADMIN_MINOR_SERVING_GROUP = 'LOGISTIC';
const ADMIN_LOGISTICS_DASHBOARD_DAYS = 56;
const ADMIN_ACTIVITY_WINDOW_DAYS = 182;

// Range limits
const ADMIN_MAX_DAYS_STAFF = 181;
const ADMIN_MAX_DAYS_ADMIN = 366;

// Low attendance flag
const ADMIN_FLAG_START_DATE_UTC = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01 UTC
const ADMIN_FLAG_MIN_SERVICES = 6; // suppress if fewer services in denominator
const ADMIN_FLAG_THRESHOLD = 0.5;  // <50%

// TEMP/HELPER via Admin portal
const ADMIN_TEMP_DAYS = 2;
const ADMIN_HELPER_DAYS = 31;

// GL helper grant allowed groups
const ADMIN_GL_HELPER_ALLOWED_GROUPS = ['MEDIA','LOGISTIC','SUPPORT','WORSHIP'];

// Serving planning
const ADMIN_SERVING_MONTHS_AHEAD = 7;
const ADMIN_SERVING_SHEET_NAME = 'Serving';
const ADMIN_SERVING_AWAY_SHEET_NAME = 'Serving_Away';
const ADMIN_SERMON_SHEET_NAME = 'Sermon_Info';
const ADMIN_FINANCE_OFFERING_SHEET_NAME = 'Finance_Offering';
const ADMIN_SERVING_POSITIONS = [
  'Worship_Lead',
  'Worship_Singer',
  'Worship_Pianist',
  'Worship_Drum',
  'Worship_Instrument',
  'Media_AV',
  'Media_PPT',
  'Media_PPTBuild',
  'Support_BibleReader',
  'Support_Testimony',
  'Support_Prayer',
  'Support_Communion',
  'Support_Care',
  'Logistic_Welcome',
  'Logistic_Venue',
  'Logistic_Refreshment',
  'Finance_Offering',
  'Other'
];
const ADMIN_SERVING_POSITION_LABELS = {
  Worship_Lead:         { zh:'敬拜主領', en:'Worship Lead' },
  Worship_Singer:       { zh:'和唱', en:'Singer' },
  Worship_Pianist:      { zh:'司琴', en:'Pianist' },
  Worship_Drum:         { zh:'鼓手', en:'Drummer' },
  Worship_Instrument:   { zh:'樂器', en:'Instrument' },
  Media_AV:             { zh:'影音', en:'Audio Visual' },
  Media_PPT:            { zh:'投影', en:'PPT' },
  Media_PPTBuild:       { zh:'PPT製作', en:'PPT Preparation' },
  Support_BibleReader:  { zh:'讀經員', en:'Bible Reader' },
  Support_Testimony:   { zh:'見證', en:'Testimony' },
  Support_Prayer:       { zh:'祈禱', en:'Prayer (Monthly)' },
  Support_Communion:    { zh:'聖餐襄禮', en:'Communion Assist (Monthly)' },
  Support_Care:         { zh:'關顧組', en:'Newcomer Care' },
  Logistic_Welcome:     { zh:'接待', en:'Welcome / Seating' },
  Logistic_Venue:       { zh:'場務', en:'Venue / Setup / Cleanup' },
  Logistic_Refreshment: { zh:'茶水', en:'Refreshments' },
  Finance_Offering:     { zh:'財務', en:'Offering / Finance' },
  Other:                { zh:'其他', en:'Other' }
};
const ADMIN_SERVING_POSITION_GROUP = {
  Worship_Lead:         'worship',
  Worship_Singer:       'worship',
  Worship_Pianist:      'worship',
  Worship_Drum:         'worship',
  Worship_Instrument:   'worship',
  Media_AV:             'media',
  Media_PPT:            'media',
  Media_PPTBuild:       'media',
  Support_BibleReader:  'support',
  Support_Testimony:   'support',
  Support_Prayer:       'support',
  Support_Communion:    'support',
  Support_Care:         'support',
  Logistic_Welcome:     'logistic',
  Logistic_Venue:       'logistic',
  Logistic_Refreshment: 'logistic',
  Finance_Offering:     'finance',
  Other:                'other'
};
const ADMIN_SERVING_POSITION_MAX = {
  Worship_Singer: 2,
  Worship_Pianist: 2,
  Worship_Instrument: 2,
  Media_AV: 2,
  Media_PPTBuild: 2,
  Support_Communion: 2,
  Support_Care: 2,
  Logistic_Welcome: 2,
  Logistic_Venue: 2,
  Logistic_Refreshment: 2,
  Finance_Offering: 3
};
const ADMIN_SERVING_POSITION_MIN = {
  Worship_Pianist: 1,
  Finance_Offering: 2,
  Support_Communion: 2,
  Logistic_Refreshment: 2
};
const ADMIN_SERVING_DUPLICATE_EXEMPT_POSITIONS = {
  Media_PPTBuild: true
};

const ADMIN_SERVING_GROUP_LABELS = {
  worship: { zh:'敬拜聯盟', en:'Worship Alliance' },
  media: { zh:'影像大師', en:'Media Master' },
  logistic: { zh:'後勤特工', en:'Logistic Specialist' },
  support: { zh:'聖工支援隊', en:'Divine Supporter' },
  finance: { zh:'財務公司', en:'Finance Dept' },
  other: { zh:'其他', en:'Other' }
};

function admin_filterDuplicateConflictPositions_(positions){
  const list = Array.isArray(positions) ? positions : [];
  return list.filter(function(pos){
    return !ADMIN_SERVING_DUPLICATE_EXEMPT_POSITIONS[pos];
  });
}
function admin_servingMinRequired_(position){
  const key = String(position||'').trim();
  if (Object.prototype.hasOwnProperty.call(ADMIN_SERVING_POSITION_MIN, key)){
    return Number(ADMIN_SERVING_POSITION_MIN[key] || 0);
  }
  if (key === 'Other') return 0;
  return 1;
}

function admin_servingPositionLabel_(pos){
  const label = ADMIN_SERVING_POSITION_LABELS[pos];
  if (label) return label.en + ' / ' + label.zh;
  return String(pos || '');
}
function admin_servingPositionZh_(pos){
  const label = ADMIN_SERVING_POSITION_LABELS[pos];
  if (label) return label.zh;
  return String(pos || '');
}

// Cache
const ADMIN_CACHE_FIRSTSEEN_KEY = 'admin_firstSeen_v3';
const ADMIN_CACHE_FIRSTSEEN_TTL = 10 * 60;

const ADMIN_CACHE_LOWATT_KEY = 'admin_lowatt_v1';
const ADMIN_CACHE_LOWATT_TTL = 10 * 60;
const ADMIN_CACHE_CHECKINS_MANIFEST_KEY = 'admin_checkins_manifest_v1';
const ADMIN_CACHE_CHECKINS_PART_PREFIX = 'admin_checkins_part_v1_';
const ADMIN_CACHE_CHECKINS_TTL = 60;
const ADMIN_CACHE_CHECKINS_PART_CHARS = 85000;
const ADMIN_CACHE_CHECKINS_MAX_PARTS = 12;

function admin_clearCheckinsDerivedCache_(){
  try{
    const cache = CacheService.getScriptCache();
    let partCount = ADMIN_CACHE_CHECKINS_MAX_PARTS;
    try{
      const raw = cache.get(ADMIN_CACHE_CHECKINS_MANIFEST_KEY);
      const manifest = raw ? JSON.parse(raw) : null;
      if (manifest && Number(manifest.nParts) > 0) partCount = Math.min(ADMIN_CACHE_CHECKINS_MAX_PARTS, Number(manifest.nParts));
    }catch(e){}
    cache.remove(ADMIN_CACHE_CHECKINS_MANIFEST_KEY);
    cache.remove(ADMIN_CACHE_FIRSTSEEN_KEY);
    for (let i=0;i<partCount;i++) cache.remove(ADMIN_CACHE_CHECKINS_PART_PREFIX + i);
  }catch(e){}
}
const ADMIN_CACHE_CHECKINS_TELEMETRY_THROTTLE = 60;

// ---- Page ----
function doGetAdmin_(e){
  const t = HtmlService.createTemplateFromFile(ADMIN_TEMPLATE);
  t.ADMIN_VERSION = ADMIN_VERSION;
  const scannerCfg = getExternalScannerConfig_();
  t.EXTERNAL_SCANNER_URL = scannerCfg.url;
  t.EXTERNAL_SCANNER_ORIGIN = scannerCfg.origin;
  t.EXTERNAL_SCANNER_TIMEOUT_MS = scannerCfg.timeoutMs;
  t.ADMIN_SERVING_CONFIG = {
    labels: ADMIN_SERVING_POSITION_LABELS,
    groupMap: ADMIN_SERVING_POSITION_GROUP,
    maxMap: ADMIN_SERVING_POSITION_MAX,
    minMap: ADMIN_SERVING_POSITION_MIN
  };

  // Official portal naming
  t.ADMIN_TITLE_ZH = '粵語基督徒團契 - ❤️爱使我们相聚在一起❤️';
  t.ADMIN_TITLE_EN = 'CCF - ❤️When Love Brings Us Together❤️';

  var out = t.evaluate().setTitle('CCF Admin Portal');
  var xfo = (HtmlService && HtmlService.XFrameOptionsMode) ? HtmlService.XFrameOptionsMode : null;
  var mode = xfo ? (xfo.SAMEORIGIN || xfo.DEFAULT || xfo.ALLOWALL || null) : null;
  if (mode) return out.setXFrameOptionsMode(mode);
  return out;
}


function admin_actorFlagsForMember_(member){
  const serving = Array.isArray(member && member.servingGroups) ? member.servingGroups : [];
  const gl = Array.isArray(member && member.servingGLGroups) ? member.servingGLGroups : [];
  const merged = serving.concat(gl).map(function(g){ return admin_normalizeServingGroup_(g); }).filter(Boolean);
  const canAccessWorshipPlanning = merged.indexOf('worship') >= 0;
  const canEditWorshipRota = gl.map(function(g){ return admin_normalizeServingGroup_(g); }).indexOf('worship') >= 0;
  return { canAccessWorshipPlanning: canAccessWorshipPlanning, canEditWorshipRota: canEditWorshipRota };
}

/**
 * Admin portal login:
 * - QR: must be STAFF, DEACON or ADMIN (DISABLED/ACTIVE/etc rejected)
 * - SUPERUSER via Script Properties secret key
 *
 * IMPORTANT: if secret login fails and input is NOT a QR payload, return E401
 * (do NOT return QR-format error E416 for wrong secret attempts).
 */
function api_admin_login(input){
  const raw = String(input || '').trim();
  if (!raw) return admin_err_('E401','請掃描你自己的同工 QR 登入','Please scan your own staff QR to login.');

  // SUPERUSER via secret stored in Script Properties (NOT hard-coded)
  const bypass = admin_getBypassCode_();
  if (bypass && raw === bypass){
    const token = admin_newSession_({ id:'SUPERUSER', role:'SUPERUSER' });
    admin_audit_({id:'SUPERUSER', role:'SUPERUSER'}, 'LOGIN', JSON.stringify({ via:'BYPASS' }), '');
    return { ok:true, token, actor:{ id:'SUPERUSER', role:'SUPERUSER' } };
  }

  // If it's not a QR payload, treat as invalid login (not QR format error)
  if (raw.indexOf('|') < 0){
    return admin_err_('E401','請掃描你自己的同工 QR 登入','Please scan your own staff QR to login.');
  }

  const parsed = admin_parseQrStrict_(raw);
  if (!parsed.ok) return parsed;

  const mi = admin_getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return admin_err_('E412','找不到此 ID','Member not found.');

  let st = admin_normStatus_(m.status);
  if (st === 'DISABLED') return admin_err_('E414','此帳號已停用','Account disabled.');

  // enforce RoleExpires for all statuses; auto-downgrade expired to ACTIVE
  if (m.roleExpires){
    const exp = admin_safeToDate_(m.roleExpires);
    if (exp && exp.getTime() < Date.now()){
      const ms = admin_findMembersSheet_();
      const col = admin_getMembersColMap_(ms);
      const rowNumber = m.rowNumber || admin_findMemberRowById_(ms, col, parsed.id);
      if (rowNumber){
        ms.getRange(rowNumber, col.Status+1).setValue('ACTIVE');
        const roleCol = admin_ensureRoleExpiresColumn_(ms, col);
        if (roleCol !== null) ms.getRange(rowNumber, roleCol+1).setValue('');
      }
      admin_clearMembersCache_();
      st = 'ACTIVE';
    }
  }

  const glGroups = Array.isArray(m.servingGLGroups) ? m.servingGLGroups : [];
  if (!(admin_isStaffOrAdminStatus_(st) || glGroups.length)) {
    return { ok:false, code:'E_HANDOFF_UNAUTHORISED', zh:'此管理平台只限已授權同工使用', en:'Admin portal for authorised staff only.' };
  }
  if (!m.key || String(m.key) !== parsed.key){
    return admin_err_('E418','Key 不相符（可能是舊 QR）','Key mismatch (possibly old QR).');
  }

  const role = admin_isStaffOrAdminStatus_(st) ? st : 'GL';
  const actor = {
    id:m.id,
    role:role,
    servingGroups: Array.isArray(m.servingGroups) ? m.servingGroups : [],
    servingGLGroups: Array.isArray(m.servingGLGroups) ? m.servingGLGroups : [],
    flags: admin_actorFlagsForMember_(m)
  };
  if (role === 'GL') actor.glGroups = glGroups;
  const token = admin_newSession_(actor);
  admin_audit_(actor, 'LOGIN', JSON.stringify({ via:'QR' }), '');
  return { ok:true, token, actor: actor };
}

function api_admin_login_with_handoff(handoffToken){
  const consume = (typeof reg_consumeAdminHandoffToken_ === 'function')
    ? reg_consumeAdminHandoffToken_(handoffToken)
    : { ok:false, code:'E_HANDOFF_BRIDGE_FAILED', zh:'管理登入橋接失敗', en:'Admin handoff bridge failed.' };
  if (!consume || !consume.ok) return consume || { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };

  const id = String(consume.memberId || '').trim().toUpperCase();
  if (!id) return { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };

  const mi = admin_getMembersIndex_();
  const m = mi.byId[id];
  if (!m) return admin_err_('E412','找不到此 ID','Member not found.');

  let st = admin_normStatus_(m.status);
  if (st === 'DISABLED') return admin_err_('E414','此帳號已停用','Account disabled.');

  if (m.roleExpires){
    const exp = admin_safeToDate_(m.roleExpires);
    if (exp && exp.getTime() < Date.now()){
      const ms = admin_findMembersSheet_();
      const col = admin_getMembersColMap_(ms);
      const rowNumber = m.rowNumber || admin_findMemberRowById_(ms, col, id);
      if (rowNumber){
        ms.getRange(rowNumber, col.Status+1).setValue('ACTIVE');
        const roleCol = admin_ensureRoleExpiresColumn_(ms, col);
        if (roleCol !== null) ms.getRange(rowNumber, roleCol+1).setValue('');
      }
      admin_clearMembersCache_();
      st = 'ACTIVE';
    }
  }

  const glGroups = Array.isArray(m.servingGLGroups) ? m.servingGLGroups : [];
  if (!(admin_isStaffOrAdminStatus_(st) || glGroups.length)) {
    return { ok:false, code:'E_HANDOFF_UNAUTHORISED', zh:'此管理平台只限已授權同工使用', en:'Admin portal for authorised staff only.' };
  }

  const role = admin_isStaffOrAdminStatus_(st) ? st : 'GL';
  const actor = {
    id:m.id,
    role:role,
    servingGroups: Array.isArray(m.servingGroups) ? m.servingGroups : [],
    servingGLGroups: glGroups,
    flags: admin_actorFlagsForMember_(m)
  };
  if (role === 'GL') actor.glGroups = glGroups;

  const token = admin_newSession_(actor);
  if (typeof reg_removeAdminHandoffToken_ === 'function') reg_removeAdminHandoffToken_(handoffToken);
  admin_audit_(actor, 'LOGIN', JSON.stringify({ via:'HANDOFF', source:consume.source || '' }), '');
  return { ok:true, token, actor: actor };
}


function api_admin_log_scanner_e420_public(payload){
  try{
    const p = payload || {};
    const actor = { id:'PUBLIC', role:'PUBLIC' };
    const details = {
      stage: String(p.stage || ''),
      diagnostics: p.diagnostics || {},
      deviceId: String(p.deviceId || ''),
      ua: String(p.ua || '')
    };
    admin_audit_(actor, 'SCANNER_E420', JSON.stringify(details), 'scanner');
    return { ok:true };
  }catch(e){
    return { ok:false, code:'E500', zh:'系統錯誤', en:'System error', detail:String(e&&e.message||e) };
  }
}

function api_admin_ping(token){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const actorInfo = admin_getActorNames_(s.actor);
  return { ok:true, actor: actorInfo, version: ADMIN_VERSION };
}

/**
 * Client-side logging hook (log button presses, selections, etc.)
 */
function api_admin_log(token, action, details, context){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  admin_audit_(s.actor, String(action||''), String(details||''), String(context||''));
  return { ok:true };
}


function api_admin_sermon_page(token, ym){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  if (!(admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER')){
    return admin_err_('E403','沒有權限','No permission');
  }

  let month = String(ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) month = admin_fmtYm_(admin_parseYmd_(admin_todayUkYmd_()) || new Date());

  const sh = admin_ensureSermonInfoSheet_();
  const events = admin_ensureSermonRowsForMonth_(sh, month);
  const map = admin_getSermonInfoForMonth_(events.map(function(ev){ return ev.eventKey; }));

  const base = admin_parseYmd_(admin_todayUkYmd_()) || new Date();
  const months = [];
  for (let i=0;i<=ADMIN_SERVING_MONTHS_AHEAD;i++){
    months.push(admin_fmtYm_(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1))));
  }
  if (months.indexOf(month) < 0){ months.unshift(month); }

  const rows = events.map(function(ev){ return map[ev.eventKey] || admin_sermonBlankFromEventKey_(ev.eventKey); });
  const viewer = admin_getActorNames_(s.actor);
  admin_audit_(s.actor, 'SERMON_PAGE', JSON.stringify({ month: month, rows: rows.length }), 'sermon_info');
  return { ok:true, viewer: viewer, month: month, months: months, rows: rows };
}

function api_admin_sermon_save(token, payload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  if (!(admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER')){
    return admin_err_('E403','沒有權限','No permission');
  }

  const p = payload || {};
  const eventKey = String(p.eventKey || '').trim();
  const m = eventKey.match(/^SundayService_(\d{4}-\d{2}-\d{2})$/);
  if (!m){
    return admin_err_('E416','活動格式錯誤（只支援 SundayService_YYYY-MM-DD）','Invalid eventKey (SundayService_YYYY-MM-DD only).');
  }
  const dateYmd = m[1];
  const speaker = String(p.speaker || '').trim();
  const sermonTitle = String(p.sermonTitle || p.title || '').trim();
  const sermonPassageRaw = String(p.sermonPassageRaw || p.sermonPassage || '').trim();
  const responsePassageRaw = String(p.responsePassageRaw || p.responsePassage || '').trim();
  const responseSpeaker = String(p.responseSpeaker || '').trim();
  const sermonParsed = bible_parseReference_(sermonPassageRaw);
  const responseParsed = bible_parseReference_(responsePassageRaw);
  const row = admin_upsertSermonInfoRow_(eventKey, {
    Speaker: speaker,
    SermonTitle: sermonTitle,
    SermonPassageRaw: sermonPassageRaw,
    SermonPassageCanonical: sermonParsed.canonical || '',
    SermonPassageStatus: sermonParsed.status || 'EMPTY',
    ResponsePassageRaw: responsePassageRaw,
    ResponsePassageCanonical: responseParsed.canonical || '',
    ResponsePassageStatus: responseParsed.status || 'EMPTY',
    ResponseSpeaker: responseSpeaker,
    UpdatedAt: admin_nowIso_(),
    UpdatedBy: String(s.actor.id || ''),
    UpdatedRole: String(s.actor.role || '')
  });
  row.dateYmd = dateYmd;
  row.sermonParsed = sermonParsed;
  row.responseParsed = responseParsed;
  admin_audit_(s.actor, 'SERMON_SAVE', JSON.stringify({ eventKey: eventKey, actorId: String(s.actor.id || '') }), 'sermon_info');
  return { ok:true, row: row };
}


function sermonImportErr_(code, zh, en, detail, subCode){
  const out = { ok:false, code:String(code||'SERMON_IMPORT_ERROR'), zh:String(zh||'講道資料匯入錯誤'), en:String(en||'Sermon import error') };
  if (subCode) out.subCode = String(subCode);
  if (detail !== undefined && detail !== null && String(detail) !== '') out.detail = String(detail);
  return out;
}

function sermonImportRequireAuth_(token){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  if (!(admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER')) return admin_err_('E403','沒有權限','No permission');
  return s;
}

function sermonImportXmlText_(xml){
  return String(xml||'')
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sermonImportNormalize_(v){
  return String(v||'')
    .replace(/[\u3000\t\r\n]+/g, ' ')
    .replace(/[：:]/g, ':')
    .replace(/[（）]/g, function(ch){ return ch === '（' ? '(' : ')'; })
    .replace(/\s+/g, ' ')
    .trim();
}

function sermonImportHeaderKey_(header){
  const h = sermonImportNormalize_(header).toLowerCase().replace(/[\s:：_\-\/\\()（）]+/g, '');
  if (!h) return '';
  if (/^(date|servicedate|sunday|日期|主日|崇拜日期)$/.test(h) || /日期|主日/.test(h)) return 'date';
  if (/eventkey/.test(h)) return 'eventKey';
  if (/回[應应].*(講員|讲员|speaker)|responsespeaker/.test(h)) return 'responseSpeaker';
  if (/回[應应].*(經文|经文|詩|诗)|response(passage|scripture)/.test(h)) return 'responsePassageRaw';
  if (/講題|讲题|題目|题目|sermontitle|topic|^title$/.test(h)) return 'sermonTitle';
  if (/講員|讲员|preacher|speaker/.test(h)) return 'speaker';
  if (/講道.*(經文|经文)|^(經文|经文)$|biblepassage|scripture|passage/.test(h)) return 'sermonPassageRaw';
  return '';
}

function sermonImportExtractDocx_(file){
  const f = file || {};
  const name = String(f.name || f.filename || '').trim();
  const mime = String(f.mimeType || '').trim();
  const b64 = String(f.base64 || '').replace(/^data:.*?;base64,/, '');
  if (!b64) return sermonImportErr_('SERMON_IMPORT_NO_FILE','請先選擇 .docx Word 檔案','Please choose a .docx Word file.');
  if (name && !/\.docx$/i.test(name)) return sermonImportErr_('SERMON_IMPORT_UNSUPPORTED_FILE_TYPE','只支援 .docx Word 檔案','Only .docx Word files are supported.', name);
  try{
    const bytes = Utilities.base64Decode(b64);
    const blob = Utilities.newBlob(bytes, 'application/zip', name || 'sermon.docx');
    const files = Utilities.unzip(blob);
    let docXml = '';
    files.forEach(function(part){ if (String(part.getName()).replace(/^\//,'') === 'word/document.xml') docXml = part.getDataAsString('UTF-8'); });
    if (!docXml) return sermonImportErr_('SERMON_IMPORT_DOCX_PARSE_FAILED','無法讀取 Word 文件內容','Could not read Word document content.', 'word/document.xml missing');
    const tables = [];
    const tableMatches = docXml.match(/<w:tbl[\s\S]*?<\/w:tbl>/g) || [];
    tableMatches.forEach(function(tbl){
      const rows = [];
      (tbl.match(/<w:tr[\s\S]*?<\/w:tr>/g) || []).forEach(function(tr){
        const cells = [];
        (tr.match(/<w:tc[\s\S]*?<\/w:tc>/g) || []).forEach(function(tc){ cells.push(sermonImportXmlText_(tc)); });
        if (cells.some(function(c){ return String(c||'').trim(); })) rows.push(cells);
      });
      if (rows.length) tables.push(rows);
    });
    const bodyText = sermonImportXmlText_(docXml);
    return { ok:true, name:name, text:bodyText, tables:tables };
  }catch(e){ return sermonImportErr_('SERMON_IMPORT_DOCX_PARSE_FAILED','Word 檔案解析失敗','Word document parsing failed.', String(e && e.message || e)); }
}

function sermonImportMonthNameToNumber_(raw){
  const s = String(raw||'').trim().toLowerCase();
  const names = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };
  if (names[s]) return names[s];
  const zh = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12 };
  return zh[s.replace(/月/g,'')] || 0;
}
function sermonImportYm_(year, month){
  const y = Number(year), m = Number(month);
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12)) return '';
  return y + '-' + ('0'+m).slice(-2);
}
function sermonImportDetectMonth_(text, source){
  const src = String(text||'');
  const patterns = [
    /(20\d{2})\s*年\s*(\d{1,2}|一|二|三|四|五|六|七|八|九|十|十一|十二)\s*月/,
    /(\d{1,2}|一|二|三|四|五|六|七|八|九|十|十一|十二)\s*月\s*(20\d{2})/,
    /\b(20\d{2})[-_\.\/ ](0?[1-9]|1[0-2])\b/,
    /\b(20\d{2})(0[1-9]|1[0-2])\b/,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[-_ ,]*(20\d{2})\b/i,
    /\b(20\d{2})[-_ ,]*(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/i
  ];
  for (let i=0;i<patterns.length;i++){
    const m = src.match(patterns[i]);
    if (!m) continue;
    let ym = '';
    if (i === 1) ym = sermonImportYm_(m[2], sermonImportMonthNameToNumber_(m[1]) || m[1]);
    else if (i === 4) ym = sermonImportYm_(m[2], sermonImportMonthNameToNumber_(m[1]));
    else if (i === 5) ym = sermonImportYm_(m[1], sermonImportMonthNameToNumber_(m[2]));
    else ym = sermonImportYm_(m[1], sermonImportMonthNameToNumber_(m[2]) || m[2]);
    if (ym) return { ym:ym, source:source, raw:m[0] };
  }
  return null;
}
function sermonImportResolveMonth_(doc, filename, options){
  const opt = options || {};
  const contentMonth = sermonImportDetectMonth_(doc.text || '', 'content');
  const filenameMonth = sermonImportDetectMonth_(filename || '', 'filename');
  const manual = /^\d{4}-\d{2}$/.test(String(opt.manualMonth||'')) ? { ym:String(opt.manualMonth), source:'manual', raw:String(opt.manualMonth) } : null;
  if (contentMonth && filenameMonth && contentMonth.ym !== filenameMonth.ym && !opt.confirmMonth){
    const err = sermonImportErr_('SERMON_IMPORT_MONTH_CONFLICT','Word 內容和檔名月份不一致，請選擇要匯入的月份','Word content and filename months differ; please choose the import month.', 'content=' + contentMonth.ym + ', filename=' + filenameMonth.ym, 'CONTENT_FILENAME'); err.contentMonth = contentMonth.ym; err.filenameMonth = filenameMonth.ym; return err;
  }
  const chosen = manual || contentMonth || filenameMonth;
  if (!chosen){ const err = sermonImportErr_('SERMON_IMPORT_MONTH_NOT_FOUND','未能辨認月份/年份，請手動選擇','Could not detect month/year; please choose manually.'); err.manualRequired = true; return err; }
  const portalMonth = String(opt.portalMonth||'').trim();
  if (/^\d{4}-\d{2}$/.test(portalMonth) && chosen.ym !== portalMonth && !opt.confirmPortalMonth){
    const err = sermonImportErr_('SERMON_IMPORT_MONTH_CONFLICT','Word 檔月份與目前頁面月份不同，請確認','Word document month differs from the selected portal month; please confirm.', 'detected=' + chosen.ym + ', portal=' + portalMonth, 'PORTAL_MONTH'); err.detectedMonth = chosen.ym; err.portalMonth = portalMonth; return err;
  }
  return { ok:true, ym:chosen.ym, source:chosen.source, raw:chosen.raw, contentMonth:contentMonth, filenameMonth:filenameMonth };
}

function sermonImportParseDate_(raw, ym){
  const s = sermonImportNormalize_(raw).replace(/\s+/g, '');
  if (!s) return '';
  let m = s.match(/SundayService_(\d{4}-\d{2}-\d{2})/i);
  if (m) return m[1];
  m = s.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return sermonImportYmd_(m[1], m[2], m[3]);
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (m) return sermonImportYmd_(String(m[3]).length === 2 ? '20'+m[3] : m[3], m[2], m[1]);
  m = s.match(/(\d{1,2})月(\d{1,2})(?:日|號|号)?/);
  if (m && /^\d{4}-\d{2}$/.test(ym)) return sermonImportYmd_(ym.slice(0,4), m[1], m[2]);
  m = s.match(/^(\d{1,2})(?:日|號|号)?$/);
  if (m && /^\d{4}-\d{2}$/.test(ym)) return sermonImportYmd_(ym.slice(0,4), ym.slice(5,7), m[1]);
  return '';
}

function sermonImportYmd_(y,m,d){
  const yy=Number(y), mm=Number(m), dd=Number(d);
  const dt = new Date(Date.UTC(yy, mm-1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm-1 || dt.getUTCDate() !== dd) return '';
  return yy + '-' + ('0'+mm).slice(-2) + '-' + ('0'+dd).slice(-2);
}

function sermonImportFindRows_(doc, ym){
  const out = [];
  let ignoredColumns = 0;
  (doc.tables || []).forEach(function(table, tableIdx){
    for (let r=0;r<table.length;r++){
      const headers = table[r] || [];
      const map = {};
      headers.forEach(function(h, idx){ const key = sermonImportHeaderKey_(h); if (key && map[key] === undefined) map[key] = idx; else if (!key) ignoredColumns++; });
      const hasDate = map.date !== undefined || map.eventKey !== undefined;
      const hasSermon = map.speaker !== undefined || map.sermonPassageRaw !== undefined || map.sermonTitle !== undefined || map.responsePassageRaw !== undefined || map.responseSpeaker !== undefined;
      if (!hasDate || !hasSermon) continue;
      for (let rr=r+1; rr<table.length; rr++){
        const row = table[rr] || [];
        if (!row.some(function(c){ return String(c||'').trim(); })) continue;
        const item = { sourceRow:rr+1, sourceTable:tableIdx+1, dateRaw:'', eventKey:'', speaker:'', sermonTitle:'', sermonPassageRaw:'', responsePassageRaw:'', responseSpeaker:'' };
        Object.keys(map).forEach(function(k){ item[k] = sermonImportNormalize_(row[map[k]] || ''); });
        if (!item.dateRaw) item.dateRaw = item.date || item.eventKey || row[0] || '';
        if (item.eventKey && /^SundayService_/.test(item.eventKey)) item.dateYmd = item.eventKey.replace('SundayService_','');
        else item.dateYmd = sermonImportParseDate_(item.dateRaw, ym);
        if (item.dateYmd) item.eventKey = 'SundayService_' + item.dateYmd;
        if ([item.speaker,item.sermonTitle,item.sermonPassageRaw,item.responsePassageRaw,item.responseSpeaker,item.dateYmd].some(Boolean)) out.push(item);
      }
      break;
    }
  });
  if (!out.length) return { ok:false, rows:[], ignoredColumns:ignoredColumns };
  return { ok:true, rows:out, ignoredColumns:ignoredColumns };
}


function sermonImportBuildPreview_(actor, file, options){
  const doc = sermonImportExtractDocx_(file);
  if (!doc.ok) return doc;
  const month = sermonImportResolveMonth_(doc, doc.name, options || {});
  if (!month.ok) return month;
  const parsed = sermonImportFindRows_(doc, month.ym);
  if (!parsed.ok) return sermonImportErr_('SERMON_IMPORT_NO_SERMON_COLUMNS','找不到講道資料表格/欄位','No sermon information table/columns found.');
  const events = admin_getMonthSundayEvents_(month.ym);
  const eventSet = {};
  events.forEach(function(e){ eventSet[e.eventKey] = true; });
  const current = admin_getSermonInfoForMonth_(events.map(function(e){ return e.eventKey; }));
  const seen = {}, errors = [], warnings = [], rows = [], changes = [];
  parsed.rows.forEach(function(r){
    const rowErrors = [], rowWarnings = [];
    if (!r.dateYmd || !admin_parseYmd_(r.dateYmd)) rowErrors.push('Cannot determine row date / 未能辨認列日期');
    if (r.dateYmd && r.dateYmd.slice(0,7) !== month.ym) rowErrors.push('Date outside import month / 日期不屬於匯入月份');
    if (r.eventKey && !eventSet[r.eventKey]) rowErrors.push('Event not found for selected month / 找不到該月份主日活動');
    if (!r.speaker && !r.sermonPassageRaw) rowErrors.push('Missing sermon speaker and passage / 缺少講員及講道經文');
    if (!r.sermonTitle) rowWarnings.push('Optional sermon title blank / 講題留空');
    if (!r.responsePassageRaw) rowWarnings.push('Optional response passage blank / 回應經文留空');
    if (!r.responseSpeaker) rowWarnings.push('Optional response speaker blank / 回應講員留空');
    const sig = [r.speaker,r.sermonTitle,r.sermonPassageRaw,r.responsePassageRaw,r.responseSpeaker].join('|');
    if (r.eventKey){
      if (seen[r.eventKey] && seen[r.eventKey] !== sig) rowErrors.push('Duplicate conflicting row for same EventKey / 同一活動有不同匯入資料');
      seen[r.eventKey] = sig;
    }
    const old = current[r.eventKey] || admin_sermonBlankFromEventKey_(r.eventKey);
    const fields = ['speaker','sermonTitle','sermonPassageRaw','responsePassageRaw','responseSpeaker'];
    fields.forEach(function(f){
      const nv = String(r[f]||'').trim();
      const ov = String((old && old[f]) || '').trim();
      if (!nv && ov) return;
      if (nv && nv !== ov){
        changes.push({ eventKey:r.eventKey, fieldName:f, oldValue:ov, newValue:nv });
        if (ov) rowWarnings.push('Will overwrite existing ' + f + ' / 將覆寫現有 ' + f);
      }
    });
    const status = rowErrors.length ? 'ERROR' : (rowWarnings.length ? 'WARNING' : 'OK');
    rows.push({ dateYmd:r.dateYmd||'', eventKey:r.eventKey||'', speaker:r.speaker||'', sermonTitle:r.sermonTitle||'', sermonPassageRaw:r.sermonPassageRaw||'', responsePassageRaw:r.responsePassageRaw||'', responseSpeaker:r.responseSpeaker||'', status:status, message:rowErrors.concat(rowWarnings).join(' | '), sourceRow:r.sourceRow, sourceTable:r.sourceTable });
    rowErrors.forEach(function(msg){ errors.push({ code:'SERMON_IMPORT_ROW_DATE_INVALID', eventKey:r.eventKey||'', detail:'table ' + (r.sourceTable||'') + ' row ' + r.sourceRow + ': ' + msg }); });
    rowWarnings.forEach(function(msg){ warnings.push({ code:'SERMON_IMPORT_WARNING', eventKey:r.eventKey||'', detail:'table ' + (r.sourceTable||'') + ' row ' + r.sourceRow + ': ' + msg }); });
  });
  if (parsed.ignoredColumns) warnings.push({ code:'SERMON_IMPORT_IGNORED_COLUMNS', detail:String(parsed.ignoredColumns) + ' unrelated/unknown columns ignored' });
  return { ok:true, month:month.ym, monthSource:month.source, monthRaw:month.raw, rows:rows, changes:changes, warnings:warnings, errors:errors, hasHardErrors:errors.length > 0, canCommit:errors.length === 0 };
}

function api_admin_sermon_docx_import_preview(token, file, options){
  try{
    const s = sermonImportRequireAuth_(token);
    if (!s.ok) return s;
    return sermonImportBuildPreview_(s.actor, file, options || {});
  }catch(e){ return sermonImportErr_('SERMON_IMPORT_DOCX_PARSE_FAILED','講道資料預覽失敗','Sermon import preview failed.', String(e && e.message || e)); }
}

function api_admin_sermon_docx_import_commit(token, file, options){
  try{
    const s = sermonImportRequireAuth_(token);
    if (!s.ok) return s;
    const preview = sermonImportBuildPreview_(s.actor, file, options || {});
    if (!preview.ok) return preview;
    if (preview.hasHardErrors) return sermonImportErr_('SERMON_IMPORT_COMMIT_FAILED','匯入仍有錯誤，請先修正 Word 檔','Import still has errors; please correct the Word file first.');
    const byEvent = {};
    (preview.changes || []).forEach(function(c){ if (!byEvent[c.eventKey]) byEvent[c.eventKey] = {}; byEvent[c.eventKey][c.fieldName] = c.newValue; });
    const now = admin_nowIso_();
    const written = [];
    Object.keys(byEvent).forEach(function(ev){
      const old = admin_getSermonRecordByEventKey_(ev);
      const patch = byEvent[ev];
      const nextSpeaker = Object.prototype.hasOwnProperty.call(patch,'speaker') ? patch.speaker : old.speaker;
      const nextTitle = Object.prototype.hasOwnProperty.call(patch,'sermonTitle') ? patch.sermonTitle : old.sermonTitle;
      const nextSermonPassage = Object.prototype.hasOwnProperty.call(patch,'sermonPassageRaw') ? patch.sermonPassageRaw : old.sermonPassageRaw;
      const nextResponsePassage = Object.prototype.hasOwnProperty.call(patch,'responsePassageRaw') ? patch.responsePassageRaw : old.responsePassageRaw;
      const nextResponseSpeaker = Object.prototype.hasOwnProperty.call(patch,'responseSpeaker') ? patch.responseSpeaker : old.responseSpeaker;
      const sermonParsed = bible_parseReference_(nextSermonPassage);
      const responseParsed = bible_parseReference_(nextResponsePassage);
      const row = admin_upsertSermonInfoRow_(ev, { Speaker:nextSpeaker, SermonTitle:nextTitle, SermonPassageRaw:nextSermonPassage, SermonPassageCanonical:sermonParsed.canonical||'', SermonPassageStatus:sermonParsed.status||'EMPTY', ResponsePassageRaw:nextResponsePassage, ResponsePassageCanonical:responseParsed.canonical||'', ResponsePassageStatus:responseParsed.status||'EMPTY', ResponseSpeaker:nextResponseSpeaker, UpdatedAt:now, UpdatedBy:String(s.actor.id||''), UpdatedRole:String(s.actor.role||'') });
      written.push(row);
    });
    (preview.changes || []).forEach(function(c){ admin_audit_(s.actor, 'SERMON_DOCX_IMPORT', JSON.stringify({ eventKey:c.eventKey, fieldName:c.fieldName, oldValue:c.oldValue, newValue:c.newValue, source:'SERMON_DOCX_IMPORT' }), 'sermon_info'); });
    return { ok:true, month:preview.month, changed:(preview.changes||[]).length, rows:written };
  }catch(e){ return sermonImportErr_('SERMON_IMPORT_COMMIT_FAILED','講道資料匯入寫入失敗','Sermon import commit failed.', String(e && e.message || e)); }
}

function admin_actorInFinance_(actor){
  const a = actor || {};
  const role = String((a.role || '')).trim().toUpperCase();
  if (role === 'SUPERUSER') return true;
  const groups = []
    .concat(Array.isArray(a.servingGroups) ? a.servingGroups : [])
    .concat(Array.isArray(a.servingGLGroups) ? a.servingGLGroups : [])
    .concat(Array.isArray(a.glGroups) ? a.glGroups : [])
    .map(function(g){ return admin_normalizeServingGroup_(g); });
  return groups.indexOf('finance') >= 0;
}
function admin_requireFinanceEditor_(actor){
  if (admin_actorInFinance_(actor)) return null;
  return admin_err_('E403','只有財務同工/GL可以修改奉獻','Only finance team members/GL can edit offering.');
}
function admin_ensureFinanceOfferingSheet_(){
  const ss = admin_openSs_();
  let sh = ss.getSheetByName(ADMIN_FINANCE_OFFERING_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(ADMIN_FINANCE_OFFERING_SHEET_NAME);
  const headers = ['EventKey','OfferingAmount','UpdatedAtIso','UpdatedByCCFID'];
  const current = (sh.getLastRow() >= 1) ? sh.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  const need = headers.some(function(h, i){ return String(current[i] || '').trim() !== h; });
  if (need) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}
function admin_getOfferingMap_(){
  const sh = admin_ensureFinanceOfferingSheet_();
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();
  rows.forEach(function(r){
    const ev = String(r[0] || '').trim();
    if (!/^SundayService_\d{4}-\d{2}-\d{2}$/.test(ev)) return;
    const amt = Number(r[1]);
    out[ev] = isFinite(amt) ? Number(amt.toFixed(2)) : null;
  });
  return out;
}
function admin_upsertOfferingAmount_(eventKey, amount, actorId){
  const sh = admin_ensureFinanceOfferingSheet_();
  const ev = String(eventKey || '').trim();
  const amt = Number(amount);
  const fixed = Number(amt.toFixed(2));
  const last = sh.getLastRow();
  const nowIso = admin_nowIso_();
  let rowNumber = 0;
  if (last >= 2){
    const vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i=0;i<vals.length;i++){
      if (String(vals[i][0] || '').trim() === ev){
        rowNumber = i + 2;
        break;
      }
    }
  }
  if (!rowNumber){
    rowNumber = last + 1;
    sh.getRange(rowNumber, 1, 1, 4).setValues([[ev, fixed, nowIso, String(actorId || '')]]);
  }else{
    sh.getRange(rowNumber, 2, 1, 3).setValues([[fixed, nowIso, String(actorId || '')]]);
  }
  return { eventKey: ev, amount: fixed, updatedAtIso: nowIso, updatedBy: String(actorId || '') };
}
function admin_listSundayServiceEventKeysDesc_(){
  const check = admin_getCheckinsDataCached_();
  if (!check.ok) return check;
  const set = new Set();
  check.rows.forEach(function(r){
    const ev = String(r.eventKey || '').trim();
    if (admin_isSundayServiceKey_(ev)) set.add(ev);
  });
  const events = Array.from(set).sort(function(a,b){ return a.localeCompare(b); }).reverse();
  return { ok:true, events: events };
}
function api_admin_finance_offering_list(token){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const list = admin_listSundayServiceEventKeysDesc_();
  if (!list.ok) return list;
  const offeringMap = admin_getOfferingMap_();
  const rows = list.events.map(function(ev){
    return { eventKey: ev, amount: (typeof offeringMap[ev] === 'number') ? offeringMap[ev] : null };
  });
  admin_audit_(s.actor, 'FINANCE_OFFERING_LIST', JSON.stringify({ rows: rows.length }), 'finance');
  return { ok:true, canEdit: admin_actorInFinance_(s.actor), rows: rows };
}
function api_admin_finance_offering_save(token, payload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const can = admin_requireFinanceEditor_(s.actor);
  if (can) return can;
  const p = payload || {};
  const ev = String(p.eventKey || '').trim();
  if (!admin_isSundayServiceKey_(ev)){
    return admin_err_('E416','活動格式錯誤（只支援 SundayService_YYYY-MM-DD）','Invalid eventKey (SundayService_YYYY-MM-DD only).');
  }
  const raw = String(p.amount);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)){
    return admin_err_('E422','金額格式錯誤（最多兩位小數，不可負數）','Invalid amount format (max 2 decimals, non-negative).');
  }
  const amt = Number(raw);
  if (!isFinite(amt) || amt < 0){
    return admin_err_('E422','金額必須為非負數字','Amount must be a non-negative number.');
  }
  const saved = admin_upsertOfferingAmount_(ev, amt, (s.actor && s.actor.id) || '');
  admin_audit_(s.actor, 'FINANCE_OFFERING_SAVE', JSON.stringify({ eventKey: ev, amount: saved.amount }), 'finance');
  return { ok:true, row: saved };
}


function api_admin_sermon_speaker_suggest(token, speakerName){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  if (!(admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER' || role === 'GL')){
    return admin_err_('E403','沒有權限','No permission');
  }

  const q = String(speakerName || '').trim();
  if (!q) return { ok:true, query:'', matches:[] };
  const qLower = q.toLowerCase();
  const mi = admin_getMembersIndex_();
  const all = Array.isArray(mi && mi.all) ? mi.all : [];

  const matches = all.filter(function(m){
    const id = String(m.id || '').trim().toUpperCase();
    if (!/^CCF\d{4}$/.test(id)) return false;
    const names = [m.nameZh, m.nameEn, m.preferredName].map(function(v){ return String(v || '').trim(); }).filter(Boolean);
    return names.some(function(n){
      const lower = n.toLowerCase();
      return lower === qLower || lower.indexOf(qLower) >= 0;
    });
  }).slice(0, 5).map(function(m){
    return {
      ccfId: String(m.id || '').trim().toUpperCase(),
      nameZh: String(m.nameZh || '').trim(),
      nameEn: String(m.nameEn || '').trim(),
      preferredName: String(m.preferredName || '').trim()
    };
  });

  return { ok:true, query:q, matches:matches };
}

/**
 * Serving planning: upcoming Sunday event keys.
 */
function api_admin_serving_event_keys(token, fromDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const sh = admin_ensureServingSheet_();
  admin_ensureServingEventKeys_(sh);
  const events = admin_getUpcomingSundayEventKeys_(fromDate, ADMIN_SERVING_MONTHS_AHEAD);
  admin_audit_(s.actor, 'SERVING_EVENT_KEYS', JSON.stringify({ from: String(fromDate||''), count: events.length }), 'serving');
  return { ok:true, events: events, maxMonths: ADMIN_SERVING_MONTHS_AHEAD };
}

/**
 * Serving planning matrix: events (rows) x positions (columns).
 */
function api_admin_serving_plan_matrix(token, fromDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const sh = admin_ensureServingSheet_();
  admin_ensureServingEventKeys_(sh);
  const events = admin_getUpcomingSundayEventKeys_(fromDate, ADMIN_SERVING_MONTHS_AHEAD);
  const matrix = admin_getServingPlanMatrix_(events);
  admin_audit_(
    s.actor,
    'SERVING_PLAN_MATRIX',
    JSON.stringify({ from: String(fromDate||''), events: events.length, positions: matrix.positions.length }),
    'serving'
  );
  return {
    ok:true,
    events: matrix.events,
    positions: matrix.positions,
    cells: matrix.cells,
    canEditByGroup: admin_getServingPlanEditMap_(s.actor, matrix.positions),
    maxMonths: ADMIN_SERVING_MONTHS_AHEAD
  };
}

function admin_canEditServingGroup_(actor, groupKey){
  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return false;
  const role = String((actor && actor.role) || '').trim().toUpperCase();
  if (admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER') return true;
  if (role !== 'GL') return false;
  const glGroups = Array.isArray(actor.glGroups) ? actor.glGroups : [];
  return glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; });
}

/**
 * Group-membership management policy:
 * - DEACON/ADMIN/SUPERUSER: every serving group.
 * - STAFF: every serving group, but privileged targets are blocked separately.
 * - GL: only groups they lead.
 */
function admin_canManageServingGroupMembership_(actor, groupKey){
  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return false;
  const role = String((actor && actor.role) || '').trim().toUpperCase();
  if (admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER') return true;
  if (role !== 'GL') return false;
  const glGroups = Array.isArray(actor && actor.glGroups) ? actor.glGroups : [];
  return glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; });
}

function admin_canManageServingGroupTarget_(actor, target){
  const role = String((actor && actor.role) || '').trim().toUpperCase();
  if (admin_isAdminActorRole_(role)) return true;
  if (!(role === 'STAFF' || role === 'GL')) return false;
  const targetStatus = admin_normStatus_((target && target.status) || '');
  return !admin_isStaffOrAdminStatus_(targetStatus);
}

function admin_getServingPlanEditMap_(actor, positions){
  const out = {};
  const list = Array.isArray(positions) ? positions : [];
  list.forEach(function(pos){
    const groupKey = admin_normalizeServingGroup_((pos && pos.group) || '');
    if (!groupKey || Object.prototype.hasOwnProperty.call(out, groupKey)) return;
    out[groupKey] = admin_canEditServingGroup_(actor, groupKey);
  });
  return out;
}
function api_admin_serving_group_overview(token, fromDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const fromYmd = String(fromDate || admin_todayUkYmd_()).trim();
  return { ok:true, fromDate: fromYmd, overview: admin_buildServingGroupOverview_(fromYmd) };
}

function api_admin_serving_group_members(token, groupKey){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return admin_err_('E416','組別格式錯誤','Invalid group key.');

  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  if (role === 'GL'){
    const allowed = admin_actorCanAccessServingGroup_(s.actor, key);
    if (!allowed){
      return admin_err_('E403','沒有權限查看此組別','No permission to view this group.');
    }
  }

  const mi = admin_getMembersIndex_();
  const all = (mi && mi.all) ? mi.all : [];
  const members = all
    .filter(function(m){ return admin_memberHasServingGroup_(m, key); })
    .map(admin_memberLabelCompact_)
    .sort(function(a,b){ return String(a.label||'').localeCompare(String(b.label||'')); });

  const canManage = admin_canManageServingGroupMembership_(s.actor, key);

  return { ok:true, group:key, count:members.length, members:members, canManage:canManage };
}

/**
 * Serving-only member summary for the group-management UI.
 * This deliberately has no attendance date range: the previous UI reused
 * api_admin_member_detail(), so an unrelated STAFF/GL range limit (E424)
 * could prevent group members from being opened.
 */
function api_admin_serving_group_member_summary(token, groupKey, memberId){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return admin_err_('E416','組別格式錯誤','Invalid group key.');
  if (!admin_actorCanAccessServingGroup_(s.actor, key)){
    return admin_err_('E403','沒有權限查看此組別','No permission to view this group.');
  }

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)){
    return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');
  }

  const mi = admin_getMembersIndex_();
  const member = (mi && mi.byId) ? mi.byId[id] : null;
  if (!member) return admin_err_('E412','找不到此會員','Member not found.');
  if (!admin_memberHasServingGroup_(member, key)){
    return admin_err_('E412','此會員不在所選組別','Member is not in the selected group.');
  }

  const result = {
    ok:true,
    group:key,
    member:{
      id:member.id,
      nameZh:member.nameZh||'',
      nameEn:member.nameEn||'',
      preferredName:String(member.preferredName||'').trim(),
      status:admin_normStatus_(member.status||''),
      isMinor:!!member.isMinor,
      familyId:String(member.familyId||''),
      minorServingApprovedGroups:member.minorServingApprovedGroups||[],
      minorServingSelfSignup:!!member.minorServingSelfSignup,
      minorServingApprovedBy:String(member.minorServingApprovedBy||''),
      minorServingApprovedAt:String(member.minorServingApprovedAt||''),
      servingGroups:member.servingGroups||[],
      servingGLGroups:member.servingGLGroups||[]
    },
    servingInsights:admin_getServingInsightsForMember_(id),
    canManage:admin_canManageServingGroupMembership_(s.actor, key) && admin_canManageServingGroupTarget_(s.actor, member)
  };
  admin_audit_(s.actor, 'SERVING_GROUP_MEMBER_SUMMARY', JSON.stringify({ group:key, memberId:id }), 'serving_group');
  return result;
}

function admin_actorCanAccessServingGroup_(actor, groupKey){
  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return false;
  const role = String((actor && actor.role) || '').trim().toUpperCase();
  if (admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER') return true;
  if (role !== 'GL') return false;

  const glGroups = Array.isArray(actor.glGroups) ? actor.glGroups : [];
  const isGlOfGroup = glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; });
  if (isGlOfGroup) return true;

  const actorId = String((actor && actor.id) || '').trim().toUpperCase();
  if (!actorId) return false;
  const mi = admin_getMembersIndex_();
  const member = (mi && mi.byId) ? mi.byId[actorId] : null;
  if (!member) return false;
  return admin_memberHasServingGroup_(member, key);
}

function api_admin_serving_group_member_update(token, groupKey, memberId, action, targetQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return admin_err_('E416','組別格式錯誤','Invalid group key.');

  let id = String(memberId||'').trim().toUpperCase();

  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  const up = String(action||'').trim().toUpperCase();
  if (!(up === 'ADD' || up === 'REMOVE')) return admin_err_('E416','操作格式錯誤','Invalid action.');

  if (up === 'ADD' && role === 'GL'){
    const parsed = admin_parseQrStrict_(String(targetQrPayload||'').trim());
    if (!parsed.ok) return parsed;
    id = String(parsed.id||'').trim().toUpperCase();
  }
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  if (!admin_canManageServingGroupMembership_(s.actor, key)){
    return admin_err_('E403','沒有權限修改此組別','No permission to modify this group.');
  }

  const mi = admin_getMembersIndex_();
  const target = (mi && mi.byId) ? mi.byId[id] : null;
  if (!target) return admin_err_('E412','找不到此會員','Member not found.');

  if (!admin_canManageServingGroupTarget_(s.actor, target)){
    return admin_err_('E403','只有 DEACON／ADMIN 可修改 STAFF／DEACON／ADMIN 的事奉組別','Only DEACON/ADMIN can modify STAFF/DEACON/ADMIN serving groups.');
  }
  if (up === 'ADD' && target.isMinor){
    const eligibility = admin_minorServingEligibility_(target, key);
    if (!eligibility.ok) return eligibility;
  }

  const sh = admin_findMembersSheet_();
  if (!sh) return admin_err_('E500','找不到 Members 表','Members sheet not found.');
  const col = admin_getMembersColMap_(sh);
  if (col.ServingGroups === undefined) return admin_err_('E500','缺少 ServingGroups 欄位','ServingGroups column missing.');
  const rowNumber = target.rowNumber || admin_findMemberRowById_(sh, col, id);
  if (!rowNumber) return admin_err_('E500','找不到會員列','Member row not found.');

  const nowGroups = admin_parseGroupsCsv_(sh.getRange(rowNumber, col.ServingGroups+1).getValue());
  let next = nowGroups.slice();
  const keyUpper = key.toUpperCase();
  let changed = false;
  if (up === 'ADD'){
    if (next.indexOf(keyUpper) < 0){
      next.push(keyUpper);
      changed = true;
    }
  } else if (up === 'REMOVE'){
    next = next.filter(function(g){ return g !== keyUpper; });
    changed = (next.length !== nowGroups.length);
  }

  if (changed){
    sh.getRange(rowNumber, col.ServingGroups+1).setValue(next.join(', '));
    admin_clearMembersCache_();
  }
  admin_audit_(s.actor, 'SERVING_GROUP_MEMBER_UPDATE', JSON.stringify({ group:key, action:up, memberId:id, changed:changed, viaTargetQr:(up==='ADD' && role==='GL') }), 'serving_group');
  return { ok:true, group:key, action:up, memberId:id, changed:changed, servingGroups:next };
}

/**
 * Remove a member from serving group with reauth (must scan current authenticated account QR).
 */
function api_admin_member_remove_from_group(token, memberId, groupKey, reauthQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return admin_err_('E416','組別格式錯誤','Invalid group key.');

  const auth = admin_verifyReauth_(s.actor, reauthQrPayload);
  if (!auth.ok) return auth;

  if (!admin_canManageServingGroupMembership_(s.actor, key)){
    return admin_err_('E403','沒有權限修改此組別','No permission to modify this group.');
  }

  const mi = admin_getMembersIndex_();
  const target = (mi && mi.byId) ? mi.byId[id] : null;
  if (!target) return admin_err_('E412','找不到此會員','Member not found.');

  if (!admin_canManageServingGroupTarget_(s.actor, target)){
    return admin_err_('E403','只有 DEACON／ADMIN 可修改 STAFF／DEACON／ADMIN 的事奉組別','Only DEACON/ADMIN can modify STAFF/DEACON/ADMIN serving groups.');
  }

  const sh = admin_findMembersSheet_();
  if (!sh) return admin_err_('E500','找不到 Members 表','Members sheet not found.');
  const col = admin_getMembersColMap_(sh);
  if (col.ServingGroups === undefined) return admin_err_('E500','缺少 ServingGroups 欄位','ServingGroups column missing.');
  const rowNumber = target.rowNumber || admin_findMemberRowById_(sh, col, id);
  if (!rowNumber) return admin_err_('E500','找不到會員列','Member row not found.');

  const nowGroups = admin_parseGroupsCsv_(sh.getRange(rowNumber, col.ServingGroups+1).getValue());
  const keyUpper = key.toUpperCase();
  const next = nowGroups.filter(function(g){ return g !== keyUpper; });
  const removed = (next.length !== nowGroups.length);

  if (removed){
    sh.getRange(rowNumber, col.ServingGroups+1).setValue(next.join(', '));
    admin_clearMembersCache_();
  }

  const effectiveFrom = admin_todayUkYmd_();
  admin_audit_(
    s.actor,
    'SERVING_GROUP_MEMBER_REMOVE_REAUTH',
    JSON.stringify({ memberId:id, group:key, removed:removed, confirmedBy:auth.confirmedBy, effectiveFrom:effectiveFrom }),
    'serving_group'
  );

  return { ok:true, memberId:id, group:key, removed:removed, servingGroups:next, effectiveFrom:effectiveFrom, confirmedBy:auth.confirmedBy };
}

/**
 * Serving event rows (for per-event edit UI).
 */
function api_admin_serving_event_rows(token, eventKey){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const sh = admin_ensureServingSheet_();
  admin_ensureServingEventKeys_(sh);
  const ev = String(eventKey||'').trim();
  if (!admin_isSundayServiceKey_(ev)){
    return admin_err_('E416','活動格式錯誤（只支援 SundayService_YYYY-MM-DD）','Invalid eventKey (SundayService_YYYY-MM-DD only).');
  }
  const positions = ADMIN_SERVING_POSITIONS.slice();
  const values = admin_getServingValuesForEvent_(ev);
  const mi = admin_getMembersIndex_();
  const members = Object.keys(mi.byId).map(function(id){
    const m = mi.byId[id];
    const groups = (m.servingGroups || []).concat(m.servingGLGroups || []).filter(Boolean);
    return { id: m.id, nameZh: m.nameZh||'', nameEn: m.nameEn||'', preferredName: m.preferredName||'', isMinor:!!m.isMinor, familyId:String(m.familyId||''), groups: groups };
  });
  members.sort(function(a,b){ return a.id.localeCompare(b.id); });
  return { ok:true, eventKey: ev, positions: positions, values: values, members: members };
}

/**
 * Serving event save (replace rows for one event).
 * rows: [{position, value}]
 */
function api_admin_serving_event_save(token, eventKey, rows, overrideAway, scopeGroupKey){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const sh = admin_ensureServingSheet_();
  admin_ensureServingEventKeys_(sh);
  const ev = String(eventKey||'').trim();
  if (!admin_isSundayServiceKey_(ev)){
    return admin_err_('E416','活動格式錯誤（只支援 SundayService_YYYY-MM-DD）','Invalid eventKey (SundayService_YYYY-MM-DD only).');
  }
  const scopeGroup = admin_normalizeServingGroup_(scopeGroupKey || '');
  if (scopeGroup && !admin_canEditServingGroup_(s.actor, scopeGroup)){
    return admin_err_('E403','你沒有權限編輯此組別','No permission to edit this serving group.');
  }
  const eventDateYmd = ev.replace('SundayService_', '');

  const list = Array.isArray(rows) ? rows : [];
  const cleaned = [];
  const allowed = new Set(ADMIN_SERVING_POSITIONS);
  for (const r of list){
    const position = String(r.position||'').trim();
    const valueRaw = String(r.value||'').trim();
    if (!position && !valueRaw) continue;
    if (!allowed.has(position)) continue;
    const normalizedValue = admin_normalizeServingValue_(valueRaw, ADMIN_SERVING_POSITION_MAX[position] || 1);
    cleaned.push({ position, value: normalizedValue });
  }

  const duplicateMap = {};
  const duplicateDetails = [];
  const memberIdsForAway = [];
  const invalidGroupAssignments = [];
  const mi = admin_getMembersIndex_();
  const membersById = mi.byId || {};
  const existingValues = admin_getServingValuesForEvent_(ev);
  const existingDupMap = admin_getDuplicatePositionMapFromValues_(existingValues);
  const mergedValues = Object.assign({}, existingValues);

  const changedPositions = new Set();
  const changedMembers = new Set();

  for (const r of cleaned){
    const oldValue = String(existingValues[r.position] || '').trim();
    const newValue = String(r.value || '').trim();
    const isChanged = (oldValue !== newValue);
    if (isChanged){
      const positionGroup = admin_normalizeServingGroup_(ADMIN_SERVING_POSITION_GROUP[r.position] || '');
      if (!admin_canEditServingGroup_(s.actor, positionGroup)){
        return admin_err_('E403','你沒有權限編輯此組別','No permission to edit this serving group.');
      }
    }
    if (isChanged) changedPositions.add(r.position);
    mergedValues[r.position] = newValue;

    const ids = admin_extractMemberIdsFromServingValue_(r.value);
    const maxAllowed = ADMIN_SERVING_POSITION_MAX[r.position] || 1;
    if (ids.length > maxAllowed){
      return admin_err_(
        'E409',
        '崗位人數超出上限',
        'Too many people for this position.',
        admin_servingPositionLabel_(r.position) + ': ' + ids.join(', ')
      );
    }
    ids.forEach(function(id){
      const groupKey = ADMIN_SERVING_POSITION_GROUP[r.position] || '';
      if (!admin_memberHasServingGroup_(membersById[id], groupKey)){
        invalidGroupAssignments.push({ memberId: id, position: r.position, group: groupKey });
      }
      if (isChanged){
        memberIdsForAway.push(id);
        changedMembers.add(id);
      }
    });
  }

  ADMIN_SERVING_POSITIONS.forEach(function(pos){
    const raw = String(mergedValues[pos] || '').trim();
    if (!raw) return;
    const ids = admin_extractMemberIdsFromServingValue_(raw);
    ids.forEach(function(id){
      if (!duplicateMap[id]) duplicateMap[id] = [];
      duplicateMap[id].push(pos);
    });
  });

  Object.keys(duplicateMap).forEach(function(id){
    if (!changedMembers.has(id)) return;
    const positions = duplicateMap[id] || [];
    const effectivePositions = admin_filterDuplicateConflictPositions_(positions);
    if (effectivePositions.length <= 1) return;
    if (scopeGroup){
      const touchesScopedGroup = positions.some(function(p){ return (ADMIN_SERVING_POSITION_GROUP[p] || '') === scopeGroup; });
      if (!touchesScopedGroup) return;
    }
    const normalized = effectivePositions.slice().sort();
    const existing = admin_filterDuplicateConflictPositions_(existingDupMap[id] || []);
    const isNewDup = (existing.join('|') !== normalized.join('|'));
    if (!isNewDup) return;
    const attemptedPositions = normalized.filter(function(p){ return existing.indexOf(p) < 0; });
    duplicateDetails.push({
      memberId: id,
      positions: effectivePositions.slice(0, 2),
      existingPositions: existing.slice(0, 2),
      attemptedPositions: attemptedPositions.slice(0, 2),
      dateYmd: eventDateYmd,
      newlyIntroduced:true
    });
  });

  const evDate = admin_eventDateFromKey_(ev);
  let conflicts = [];
  if (memberIdsForAway.length){
    conflicts = admin_checkServingAwayConflicts_(evDate, memberIdsForAway.map(function(id){
      return { memberId: id };
    }));
  }
  const role = String(s.actor.role||'').trim().toUpperCase();
  const canOverride = admin_isAdminActorRole_(role);
  if (invalidGroupAssignments.length){
    const detail = invalidGroupAssignments.map(function(x){
      const m = membersById[String(x.memberId||'').toUpperCase()] || null;
      const compact = admin_memberLabelCompact_(m || { id:String(x.memberId||'') });
      return [compact.label, String(x.position||''), String(x.group||'')].filter(Boolean).join(' → ');
    }).join(' | ');
    return admin_conflict_('成員不屬於該事奉組別','Member is NOT a member of this serving group.', detail, 'MEMBER_NOT_IN_SERVING_GROUP', 'SERVING_ASSIGNMENT');
  }
  const minorValidation = admin_validateMinorServingValues_(mergedValues, membersById, Array.from(changedPositions));
  if (!minorValidation.ok){
    const firstMinorError = minorValidation.errors[0] || {};
    return {
      ok:false,
      code:'E409',
      subCode:String(firstMinorError.code || 'MINOR_SERVING_INVALID'),
      subGroup:'MINOR_SERVING',
      zh:String(firstMinorError.zh || '未成年事奉安排不符合規則'),
      en:String(firstMinorError.en || 'Young-volunteer assignment does not meet the rules.'),
      detail:(minorValidation.errors || []).map(function(err){
        return [err.memberId, admin_servingPositionLabel_(err.position), err.zh + ' / ' + err.en].filter(Boolean).join(' · ');
      }).join(' | '),
      minorErrors:minorValidation.errors
    };
  }
  if (duplicateDetails.length){
    if (!canOverride){
      const detail = duplicateDetails.map(function(d){
        const labels = (d.positions || []).map(admin_servingPositionLabel_);
        return d.memberId + ': ' + labels.join(', ');
      }).join(' | ');
      return {
        ok:false,
        code:'E409',
        subCode:'DUPLICATE_ASSIGNMENT',
        subGroup:'SERVING_ASSIGNMENT',
        zh:'同一會員在同一次聚會被安排到多個崗位',
        en:'The same member is assigned to multiple positions in this service.',
        detail:detail,
        duplicates:duplicateDetails,
        dateYmd:eventDateYmd,
        canOverride:false
      };
    }
    if (!overrideAway){
      return { ok:false, code:'E409', subCode:'DUPLICATE_ASSIGNMENT', subGroup:'SERVING_ASSIGNMENT', zh:'該會員已在此崗位事奉', en:'They are already serving this position.', duplicates: duplicateDetails, dateYmd: eventDateYmd, canOverride:true };
    }
  }
  if (conflicts.length){
    const detail = conflicts.map(function(c){
      return (c.memberId||'') + ' ' + String(c.from||'') + ' - ' + String(c.to||'');
    }).join(' | ');
    return { ok:false, code:'E409', subCode:'HOLIDAY_OVERLAP', subGroup:'SERVING_ASSIGNMENT', zh:'事奉安排與假期重疊。請組員先刪除/更改假期，再安排事奉。', en:'Serving assignment overlaps holiday period. Please ask the member to clear/update holiday before assignment.', detail:detail, conflicts:conflicts };
  }


  const matrix = admin_getServingMatrix_(sh);
  if (!matrix.eventCol){
    return admin_err_('E500','Serving 表格欄位錯誤','Serving sheet headers missing.');
  }
  const rowIndex = admin_findServingEventRowIndex_(sh, ev);
  if (rowIndex === null){
    return admin_err_('E500','找不到活動列','Event row not found.');
  }

  const updatedHeaderMap = admin_getServingMatrixHeaderMap_(sh);
  const lastCol = sh.getLastColumn();
  const rowValues = sh.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  cleaned.forEach(function(r){
    const colIdx = updatedHeaderMap[r.position];
    if (colIdx) rowValues[colIdx-1] = r.value || '';
  });
  sh.getRange(rowIndex, 1, 1, lastCol).setValues([rowValues]);

  admin_audit_(
    s.actor,
    'SERVING_EVENT_SAVE',
    JSON.stringify({ eventKey: ev, rows: cleaned.length, overrideAway: !!overrideAway, scopeGroup: scopeGroup||'' }),
    'serving'
  );

  return {
    ok:true,
    eventKey: ev,
    rows: cleaned.length,
    warnings:{
      conflicts: [],
      duplicates: [],
      minorPairing: minorValidation.warnings || []
    }
  };
}

function admin_isYmdWithinAnyPeriods_(ymd, periods){
  const d = admin_parseYmd_(ymd);
  if (!d) return false;
  const list = Array.isArray(periods) ? periods : [];
  for (let i=0;i<list.length;i++){
    const p = list[i] || {};
    const from = admin_parseYmd_(p.from || p.fromYmd || '');
    const to = admin_parseYmd_(p.to || p.toYmd || '');
    if (!from || !to) continue;
    if (from.getTime() <= d.getTime() && d.getTime() <= to.getTime()) return true;
  }
  return false;
}
function admin_getServingAssignmentsForMemberInPeriods_(memberId, periods){
  const id = String(memberId||'').trim().toUpperCase();
  if (!id) return [];
  const list = Array.isArray(periods) ? periods : [];
  if (!list.length) return [];

  const sh = admin_getServingSheet_();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return [];

  const matrix = admin_getServingMatrix_(sh);
  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const out = [];

  rows.forEach(function(row){
    const eventKey = String(row[0] || '').trim();
    if (!admin_isSundayServiceKey_(eventKey)) return;
    const dateYmd = eventKey.replace('SundayService_', '');
    if (!admin_isYmdWithinAnyPeriods_(dateYmd, list)) return;
    matrix.positions.forEach(function(pos){
      if (!pos || !pos.colIndex) return;
      const raw = String(row[pos.colIndex - 1] || '').trim();
      if (!raw) return;
      const ids = admin_extractMemberIdsFromServingValue_(raw);
      if (ids.indexOf(id) < 0) return;
      out.push({ eventKey:eventKey, dateYmd:dateYmd, position:String(pos.position||'') });
    });
  });

  out.sort(function(a,b){
    const d = String(a.dateYmd||'').localeCompare(String(b.dateYmd||''));
    if (d !== 0) return d;
    return String(a.position||'').localeCompare(String(b.position||''));
  });
  return out;
}

/**
 * Away period management (DD/MM/YYYY) x2.
 */
function api_admin_set_away_period(token, memberId, fromDmy1, toDmy1, fromDmy2, toDmy2){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const fromYmd1 = admin_parseDmyToYmd_(fromDmy1);
  const toYmd1 = admin_parseDmyToYmd_(toDmy1);
  const fromYmd2 = admin_parseDmyToYmd_(fromDmy2);
  const toYmd2 = admin_parseDmyToYmd_(toDmy2);

  function validatePair(fromYmd, toYmd, labelZh, labelEn){
    if (!fromYmd && !toYmd) return { ok:true };
    if (!fromYmd || !toYmd){
      return admin_err_('E422', labelZh, labelEn);
    }
    const from = admin_parseYmd_(fromYmd);
    const to = admin_parseYmd_(toYmd);
    if (!from || !to) return admin_err_('E422', labelZh, labelEn);
    if (to.getTime() < from.getTime()){
      return admin_err_('E423','結束日期不可早於開始日期','End date cannot be before start date.');
    }
    return { ok:true };
  }

  const v1 = validatePair(fromYmd1, toYmd1, '第 1 期日期格式錯誤（DD/MM/YYYY）', 'Period 1 date format invalid (DD/MM/YYYY).');
  if (!v1.ok) return v1;
  const v2 = validatePair(fromYmd2, toYmd2, '第 2 期日期格式錯誤（DD/MM/YYYY）', 'Period 2 date format invalid (DD/MM/YYYY).');
  if (!v2.ok) return v2;

  const mi = admin_getMembersIndex_();
  const m = mi.byId[id];
  if (!m) return admin_err_('E412','找不到此會員','Member not found.');

  const sh = admin_findMembersSheet_();
  if (!sh) return admin_err_('E500','找不到 Members 表','Members sheet not found.');
  const col = admin_getMembersColMap_(sh);
  admin_ensureAwayColumns_(sh, col);
  const rowNumber = m.rowNumber || admin_findMemberRowById_(sh, col, id);
  if (!rowNumber) return admin_err_('E500','找不到會員列','Member row not found.');

  const periods = [];
  if (fromYmd1 && toYmd1) periods.push({ from: fromYmd1, to: toYmd1 });
  if (fromYmd2 && toYmd2) periods.push({ from: fromYmd2, to: toYmd2 });
  periods.sort(function(a,b){
    const da = admin_parseYmd_(a.from); const db = admin_parseYmd_(b.from);
    if (!da || !db) return 0;
    return da.getTime() - db.getTime();
  });

  const p1 = periods[0] || { from:'', to:'' };
  const p2 = periods[1] || { from:'', to:'' };
  if (p1.from && p2.from){
    const aFrom = admin_parseYmd_(p1.from), aTo = admin_parseYmd_(p1.to);
    const bFrom = admin_parseYmd_(p2.from), bTo = admin_parseYmd_(p2.to);
    if (aFrom && aTo && bFrom && bTo && aFrom.getTime() <= bTo.getTime() && bFrom.getTime() <= aTo.getTime()){
      return admin_conflict_('兩段假期不可重疊','Holiday periods cannot overlap.', '', 'HOLIDAY_PERIOD_OVERLAP', 'HOLIDAY');
    }
  }

  const assignmentConflicts = admin_getServingAssignmentsForMemberInPeriods_(id, [p1, p2].filter(function(x){ return x.from && x.to; }));
  if (assignmentConflicts.length){
    const detail = assignmentConflicts.map(function(it){
      return (it.dateYmd || '') + ' ' + (admin_servingPositionZh_(it.position || '') || it.position || '');
    }).join(' | ');
    return admin_conflict_('設定假期前，請先取消該時段已編排的事奉。','Please cancel existing serving assignments in the selected holiday period before saving holiday.', detail, 'HOLIDAY_HAS_SERVING_ASSIGNMENTS', 'HOLIDAY');
  }

  const awayCols = [col.AwayFrom1, col.AwayTo1, col.AwayFrom2, col.AwayTo2];
  const minAwayCol = Math.min.apply(null, awayCols);
  const maxAwayCol = Math.max.apply(null, awayCols);
  if ((maxAwayCol - minAwayCol) === 3){
    sh.getRange(rowNumber, minAwayCol+1, 1, 4).setValues([[p1.from || '', p1.to || '', p2.from || '', p2.to || '']]);
  } else {
    sh.getRange(rowNumber, col.AwayFrom1+1).setValue(p1.from || '');
    sh.getRange(rowNumber, col.AwayTo1+1).setValue(p1.to || '');
    sh.getRange(rowNumber, col.AwayFrom2+1).setValue(p2.from || '');
    sh.getRange(rowNumber, col.AwayTo2+1).setValue(p2.to || '');
  }
  admin_appendAwayHistory_(id, [p1, p2].filter(function(x){ return x.from && x.to; }), s.actor);

  admin_audit_(
    s.actor,
    'SERVING_AWAY_SET',
    JSON.stringify({ memberId: id, from1: p1.from||'', to1: p1.to||'', from2: p2.from||'', to2: p2.to||'' }),
    'serving'
  );

  admin_clearMembersCache_();
  return { ok:true, memberId: id, from1: p1.from||'', to1: p1.to||'', from2: p2.from||'', to2: p2.to||'' };
}


function admin_isInAwayOnDate_(awayPeriods, dateObj){
  const periods = (awayPeriods && Array.isArray(awayPeriods.periods)) ? awayPeriods.periods : [];
  if (!dateObj || !periods.length) return false;
  for (let i=0;i<periods.length;i++){
    const p = periods[i] || {};
    const from = admin_parseYmd_(p.fromYmd || p.from || '');
    const to = admin_parseYmd_(p.toYmd || p.to || '');
    if (!from || !to) continue;
    if (dateObj.getTime() >= from.getTime() && dateObj.getTime() <= to.getTime()) return true;
  }
  return false;
}

/**
 * Service stats series within date range (SundayService only).
 * Contract:
 * {
 *   ok:true,
 *   range:{from:'YYYY-MM-DD', to:'YYYY-MM-DD'},
 *   events:[{eventKey,total,new,existing},...],
 *   cache:{used:true, rebuilt:false, updatedAt:'...'}
 * }
 */
function api_admin_stats(token, fromDate, toDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const glBlock = admin_requireNonGl_(s.actor);
  if (glBlock) return glBlock;

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const firstSeenRes = admin_getFirstSeenIndexCached_();
  const firstSeen = firstSeenRes.map;
  const statsMembersById = admin_getMembersIndex_().byId || {};

  const check = admin_getCheckinsDataCached_();
  if (!check.ok) return check;

  // eventKey -> Set(memberId) (dedupe per service)
  const evAttendees = new Map();

  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;

    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;

    const mid = r.memberId;
    if (!mid) continue;

    let set = evAttendees.get(ev);
    if (!set){ set = new Set(); evAttendees.set(ev, set); }
    set.add(mid);
  }

  const events = Array.from(evAttendees.keys()).sort(function(a,b){
    const da = admin_eventDateFromKey_(a); const db = admin_eventDateFromKey_(b);
    return (da && db) ? (da.getTime() - db.getTime()) : a.localeCompare(b);
  });

  const allMemberIds = new Set();
  for (const ev of events){
    const set = evAttendees.get(ev) || new Set();
    set.forEach(function(mid){ allMemberIds.add(mid); });
  }
  const awayMap = admin_getAwayPeriodsMap_(Array.from(allMemberIds));

  const out = [];
  for (const ev of events){
    const set = evAttendees.get(ev);
    const total = set ? set.size : 0;
    let newCount = 0;
    let holidayCount = 0;
    const d = admin_eventDateFromKey_(ev);

    if (set){
      for (const mid of set){
        if (admin_isNewFriendForEvent_(ev, mid, firstSeen, statsMembersById)) newCount++;
        if (admin_isInAwayOnDate_(awayMap[mid], d)) holidayCount++;
      }
    }
    const existing = Math.max(0, total - newCount);
    out.push({ eventKey: ev, total: total, new: newCount, existing: existing, holiday: holidayCount });
  }

  admin_audit_(s.actor, 'STATS_LOAD', JSON.stringify({from:String(fromDate||''), to:String(toDate||''), events: out.length}), 'stats');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    events: out,
    cache:{ used: firstSeenRes.usedCache, rebuilt:false, updatedAt: admin_nowIso_() }
  };
}

/**
 * DEACON/ADMIN/SUPERUSER only: rebuild firstSeen cache immediately.
 */
function api_admin_stats_rebuild(token){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const glBlock = admin_requireNonGl_(s.actor);
  if (glBlock) return glBlock;

  if (!admin_isAdminActorRole_(s.actor.role)){
    return admin_err_('E403','只有執事／管理員可以重建統計快取','Only DEACON/ADMIN can rebuild cache.');
  }

  CacheService.getScriptCache().remove(ADMIN_CACHE_FIRSTSEEN_KEY);
  const rebuilt = admin_buildFirstSeenIndex_();
  CacheService.getScriptCache().put(ADMIN_CACHE_FIRSTSEEN_KEY, JSON.stringify(rebuilt.map), ADMIN_CACHE_FIRSTSEEN_TTL);

  admin_audit_(s.actor, 'STATS_REBUILD', JSON.stringify({rows:rebuilt.rows, updatedAt:rebuilt.updatedAt}), 'stats');

  return { ok:true, cache:{ rebuilt:true, updatedAt: rebuilt.updatedAt } };
}

/**
 * Service stats dialog payload for one SundayService event.
 * Includes expandable lists (preferredName-first display supported by UI).
 * Placeholders for future: offering, serving.
 */
function api_admin_event_detail(token, eventKey){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const glBlock = admin_requireNonGl_(s.actor);
  if (glBlock) return glBlock;

  const ev = String(eventKey||'').trim();
  if (!admin_isSundayServiceKey_(ev)){
    admin_audit_(s.actor, 'EVENT_DETAIL_DENY', JSON.stringify({eventKey: ev}), 'event');
    return admin_err_('E416','活動格式錯誤（只支援 SundayService_YYYY-MM-DD）','Invalid eventKey (SundayService_YYYY-MM-DD only).');
  }

  const check = admin_getCheckinsDataCached_();
  if (!check.ok) return check;

  const set = new Set();
  for (const r of check.rows){
    if (r.eventKey === ev && r.memberId) set.add(r.memberId);
  }

  const mi = admin_getMembersIndex_();
  const fs = admin_getFirstSeenIndexCached_().map;

  const newMembers = [];
  const existingMembers = [];

  set.forEach(function(mid){
    const m = mi.byId[mid] || {};
    const obj = {
      id: mid,
      nameZh: String(m.nameZh||'').trim(),
      nameEn: String(m.nameEn||'').trim(),
      preferredName: String(m.preferredName||'').trim(),
      status: admin_normStatus_(m.status||'')
    };
    if (admin_isNewFriendForEvent_(ev, mid, fs, mi.byId || {})) newMembers.push(obj);
    else existingMembers.push(obj);
  });

  function sortKey_(o){
    return (o.preferredName || o.nameZh || o.nameEn || o.id || '').toLowerCase();
  }
  newMembers.sort((a,b)=> (sortKey_(a).localeCompare(sortKey_(b)) || a.id.localeCompare(b.id)));
  existingMembers.sort((a,b)=> (sortKey_(a).localeCompare(sortKey_(b)) || a.id.localeCompare(b.id)));

  const total = set.size;
  const newCount = newMembers.length;
  const existingCount = Math.max(0, total - newCount);

  const servingRows = admin_getServingForEvent_(ev, mi.byId, set);
  const sermon = admin_getSermonRecordByEventKey_(ev);
  const offeringMap = admin_getOfferingMap_();
  const offeringAmount = (typeof offeringMap[ev] === 'number') ? offeringMap[ev] : null;

  admin_audit_(s.actor, 'EVENT_DETAIL', JSON.stringify({eventKey: ev, total, new: newCount, existing: existingCount}), 'event');

  return {
    ok:true,
    eventKey: ev,
    dateYmd: ev.replace('SundayService_',''),
    counts:{ total: total, new: newCount, existing: existingCount },
    lists:{ newMembers: newMembers, existingMembers: existingMembers },
    extras:{
      sermon:{
        speaker: String(sermon.speaker || '').trim(),
        title: String(sermon.sermonTitle || '').trim(),
        sermonPassage: String(sermon.sermonPassageCanonical || sermon.sermonPassageRaw || '').trim(),
        responsePassage: String(sermon.responsePassageCanonical || sermon.responsePassageRaw || '').trim()
      },
      offering: offeringAmount,
      serving: servingRows
    }
  };
}

/**
 * Period stats by month + season within date range.
 */
function api_admin_period_stats(token, fromDate, toDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const glBlock = admin_requireNonGl_(s.actor);
  if (glBlock) return glBlock;

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const check = admin_getCheckinsDataCached_();
  if (!check.ok) return check;

  const evAttendees = new Map();
  const evDate = new Map();

  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;

    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;

    const mid = r.memberId;
    if (!mid) continue;

    evDate.set(ev, d);
    let set = evAttendees.get(ev);
    if (!set){ set = new Set(); evAttendees.set(ev, set); }
    set.add(mid);
  }

  const events = Array.from(evAttendees.keys()).sort((a,b)=> evDate.get(a).getTime() - evDate.get(b).getTime());

  const month = {};
  for (const ev of events){
    const d = evDate.get(ev);
    const key = admin_fmtYm_(d);
    if (!month[key]) month[key] = { month:key, services:0, total:0, uniqueSet:new Set() };
    month[key].services += 1;
    const set = evAttendees.get(ev);
    month[key].total += set.size;
    set.forEach(mid => month[key].uniqueSet.add(mid));
  }

  const fs = admin_getFirstSeenIndexCached_().map;
  const periodMembersById = admin_getMembersIndex_().byId || {};
  const newByMonth = {};
  for (const mid in fs){
    const fev = fs[mid];
    if (!fev || !admin_isSundayServiceKey_(fev)) continue;
    const d = admin_eventDateFromKey_(fev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;
    const mk = admin_fmtYm_(d);
    if (admin_isNewFriendForEvent_(fev, mid, fs, periodMembersById)){
      if (!newByMonth[mk]) newByMonth[mk] = new Set();
      newByMonth[mk].add(mid);
    }
  }

  const monthsOut = Object.keys(month).sort().map(k => {
    const o = month[k];
    const newSet = newByMonth[k] || new Set();
    return {
      month: o.month,
      services: o.services,
      totalAttendance: o.total,
      uniqueAttendance: o.uniqueSet.size,
      newUnique: newSet.size,
      meanAttendance: o.services ? Number((o.total / o.services).toFixed(2)) : 0
    };
  });

  function seasonLabel_(d){
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth()+1;
    if (m<=3) return y+' Jan–Mar';
    if (m<=6) return y+' Apr–Jun';
    if (m<=9) return y+' Jul–Sep';
    return y+' Oct–Dec';
  }

  const seasonBuckets = {};
  for (const ev of events){
    const d = evDate.get(ev);
    const sk = seasonLabel_(d);
    if (!seasonBuckets[sk]) seasonBuckets[sk] = { season: sk, services:0, total:0, uniqueSet:new Set(), newSet:new Set() };
    seasonBuckets[sk].services += 1;
    const set = evAttendees.get(ev);
    seasonBuckets[sk].total += set.size;
    set.forEach(mid => seasonBuckets[sk].uniqueSet.add(mid));
  }

  for (const mid in fs){
    const fev = fs[mid];
    if (!fev || !admin_isSundayServiceKey_(fev)) continue;
    const d = admin_eventDateFromKey_(fev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;
    const sk = seasonLabel_(d);
    if (!seasonBuckets[sk]) seasonBuckets[sk] = { season: sk, services:0, total:0, uniqueSet:new Set(), newSet:new Set() };
    if (admin_isNewFriendForEvent_(fev, mid, fs, periodMembersById)) seasonBuckets[sk].newSet.add(mid);
  }

  const seasonsOut = Object.keys(seasonBuckets).sort().map(k => {
    const o = seasonBuckets[k];
    return {
      season: o.season,
      services: o.services,
      totalAttendance: o.total,
      uniqueAttendance: o.uniqueSet.size,
      newUnique: o.newSet.size,
      meanAttendance: o.services ? Number((o.total / o.services).toFixed(2)) : 0
    };
  });

  admin_audit_(s.actor, 'PERIOD_STATS', JSON.stringify({from:String(fromDate||''), to:String(toDate||''), months:monthsOut.length, seasons:seasonsOut.length}), 'period');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    months: monthsOut,
    seasons: seasonsOut
  };
}

/**
 * Attendance matrix (SundayService only) within date range.
 * - q filters members (CCF ID / zh / en)
 * - returns ONLY non-DISABLED members in matrix columns (hide DISABLED)
 * - includes low attendance flag
 */
function api_admin_matrix(token, fromDate, toDate, q){
  let stage = 'READ_CHECKINS';
  try{
    const s = admin_requireSession_(token);
    if (!s.ok) return s;
    const glBlock = admin_requireNonGl_(s.actor);
    if (glBlock) return glBlock;

    const range = admin_validateRange_(s.actor, fromDate, toDate);
    if (!range.ok) return range;

  const query = String(q||'').trim();
  const qU = query.toUpperCase();
  const qL = query.toLowerCase();

    stage = 'READ_CHECKINS';
    const check = admin_getCheckinsDataCached_();
    if (!check || !check.ok) return check || { ok:false, code:'E_ATT_MATRIX_LOAD', zh:'未能載入出席資料', en:'Unable to load attendance data.' };

  stage = 'BUILD_EVENTS';
  const evSet = new Set();
  const attendanceSet = {};
  const attendeeIds = new Set();

  for (const r of (Array.isArray(check.rows) ? check.rows : [])){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;

    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;

    const mid = r.memberId;
    if (!mid) continue;

    evSet.add(ev);
    attendeeIds.add(mid);

    attendanceSet[ev + '|' + mid] = 1;
  }

  const events = Array.from(evSet).sort((a,b)=>{
    const da = admin_eventDateFromKey_(a); const db = admin_eventDateFromKey_(b);
    return (da && db) ? (da.getTime() - db.getTime()) : a.localeCompare(b);
  });

  stage = 'BUILD_MEMBERS';
  const mi = admin_getMembersIndex_() || { byId:{} };
  const flags = admin_getLowAttendanceFlagsCached_() || { flagById:{} };
  const memberIndexById = mi.byId || {};

  const members = [];
  for (const id of attendeeIds){
    const m = memberIndexById[id];
    if (!m) continue;

    const st = admin_normStatus_(m.status);
    if (st === 'DISABLED') continue;

    if (query){
      const hay = (m.id + ' | ' + (m.nameZh||'') + ' | ' + (m.nameEn||'')).toLowerCase();
      if (!(m.id.toUpperCase().includes(qU) || hay.includes(qL))) continue;
    }

    members.push({
      id: m.id,
      nameZh: m.nameZh || '',
      nameEn: m.nameEn || '',
      lowFlag: !!flags.flagById[m.id],
      lowFlagZh: flags.flagById[m.id] ? '出席偏低：建議關顧跟進' : '',
      lowFlagEn: flags.flagById[m.id] ? 'Low attendance — consider pastoral care.' : '',
      familyKey: String((m.familyId || m.FamilyID || '')).trim() || ('INDIVIDUAL_' + m.id)
    });
  }

  members.sort(function(a,b){
    const fa = String(a.familyKey||''); const fb = String(b.familyKey||'');
    if (fa !== fb) return fa.localeCompare(fb);
    const sa = memberIndexById[a.id] || {}; const sb = memberIndexById[b.id] || {};
    const la = String(sa.memberLetter || sa.MemberLetter || ''); const lb = String(sb.memberLetter || sb.MemberLetter || '');
    if (la !== lb) return la.localeCompare(lb);
    const na = (a.nameZh || a.nameEn || a.id); const nb = (b.nameZh || b.nameEn || b.id);
    if (na !== nb) return String(na).localeCompare(String(nb));
    return a.id.localeCompare(b.id);
  });
  const familiesByKey = {};
  members.forEach(function(m){
    const src = memberIndexById[m.id] || {};
    const familyIdRaw = String(src.familyId || src.FamilyID || '').trim();
    const familyKey = familyIdRaw ? familyIdRaw : ('INDIVIDUAL_' + m.id);
    if (!familiesByKey[familyKey]){
      familiesByKey[familyKey] = {
        familyKey: familyKey,
        familyId: familyIdRaw || '',
        displayLabel: familyIdRaw ? ('Family ' + familyIdRaw) : 'Individual',
        members: [],
        summary: { memberCount:0, attendanceCount:0, possibleCount:0, percent:0 }
      };
    }
    const letter = String(src.memberLetter || src.MemberLetter || '').trim();
    familiesByKey[familyKey].members.push({
      id: m.id,
      memberLetter: letter,
      nameZh: m.nameZh || '',
      nameEn: m.nameEn || '',
      status: String(src.status || ''),
      lowFlag: !!m.lowFlag,
      attendedByEvent: {}
    });
  });

  stage = 'BUILD_AWAY';
  const away = {};
  const memberIds = members.map(function(m){ return m.id; });
  const currentAwayMap = admin_getAwayPeriodsMap_(memberIds);
  const historyMap = admin_getAwayHistoryPeriodsMap_(memberIds);
  events.forEach(function(ev){
    const d = admin_eventDateFromKey_(ev);
    if (!d) return;
    members.forEach(function(m){
      const ap = currentAwayMap[m.id] || {};
      var periods = (ap && ap.periods) ? ap.periods.slice() : [];
      var hist = historyMap[m.id] || [];
      periods = periods.concat(hist);
      const hit = periods.some(function(p){
        const from = admin_parseYmd_(p.fromYmd || p.from || '');
        const to = admin_parseYmd_(p.toYmd || p.to || '');
        if (!from || !to) return false;
        return d.getTime() >= from.getTime() && d.getTime() <= to.getTime();
      });
      if (!hit) return;
      if (!away[m.id]) away[m.id] = {};
      away[m.id][ev] = 1;
    });
  });

  stage = 'BUILD_FAMILIES';
  const familyList = Object.keys(familiesByKey).map(function(k){ return familiesByKey[k]; });
  familyList.forEach(function(fam){
    fam.members.sort(function(a,b){
      const la = String(a.memberLetter||'').trim();
      const lb = String(b.memberLetter||'').trim();
      if (la && lb && la !== lb) return la.localeCompare(lb);
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      const na = (a.nameZh || a.nameEn || a.id);
      const nb = (b.nameZh || b.nameEn || b.id);
      return String(na).localeCompare(String(nb));
    });
    var attendedCount = 0;
    fam.members.forEach(function(m){
      events.forEach(function(ev){
        const hit = !!attendanceSet[ev + '|' + m.id];
        if (hit) attendedCount++;
        m.attendedByEvent[ev] = hit;
      });
    });
    const possible = fam.members.length * events.length;
    fam.summary = {
      memberCount: fam.members.length,
      attendanceCount: attendedCount,
      possibleCount: possible,
      percent: possible ? Math.round((attendedCount / possible) * 1000) / 10 : 0
    };
  });
  familyList.sort(function(a,b){ return String(a.familyKey||'').localeCompare(String(b.familyKey||'')); });

  admin_audit_(s.actor, 'MATRIX_LOAD', JSON.stringify({from:String(fromDate||''), to:String(toDate||''), members:members.length, events:events.length, families:familyList.length}), 'matrix');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    events: events.map(function(ev){ return { eventKey:ev, dateYmd: admin_fmtYmd_(admin_eventDateFromKey_(ev) || new Date()), label: ev.replace('SundayService_','') }; }),
    members: members,
    attended: attendanceSet,
    away: away,
    families: familyList,
    totals: { eventCount: events.length, familyCount: familyList.length, memberCount: members.length, checkinCount: Object.keys(attendanceSet).length }
  };
  }catch(e){
    return { ok:false, code:'E_ATT_MATRIX_LOAD', zh:'出席矩陣載入失敗', en:'Attendance matrix load failed.', detail:String(e&&e.message||e), stage:stage };
  }
}

/**
 * Member search (includes DISABLED).
 */
function api_admin_member_search(token, q){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const query = String(q||'').trim();
  if (!query) return { ok:true, results:[] };

  const mi = admin_getMembersIndex_();
  const flags = admin_getLowAttendanceFlagsCached_();
  const qU = query.toUpperCase();
  const qL = query.toLowerCase();
  const scored = [];

  for (const id in mi.byId){
    const m = mi.byId[id];
    const idU = String(m.id||'').toUpperCase();
    const nameZh = String(m.nameZh||'');
    const nameEn = String(m.nameEn||'');
    const email = String(m.email||'');
    const hay = (idU + ' | ' + nameZh + ' | ' + nameEn + ' | ' + email).toLowerCase();
    if (!(idU.includes(qU) || hay.includes(qL))) continue;

    let score = 0;
    if (idU === qU) score += 3000;
    else if (idU.indexOf(qU) === 0) score += 2000;
    else if (idU.includes(qU)) score += 1500;
    if (nameZh.toLowerCase().indexOf(qL) === 0 || nameEn.toLowerCase().indexOf(qL) === 0) score += 900;
    else if (hay.includes(qL)) score += 600;

    const st = admin_normStatus_(m.status);
    scored.push({
      score: score,
      row: {
        id: m.id,
        nameZh: m.nameZh||'',
        nameEn: m.nameEn||'',
        status: st,
        isMinor: !!m.isMinor,
        familyId: String(m.familyId||''),
        minorServingApprovedGroups: m.minorServingApprovedGroups || [],
        minorServingSelfSignup: !!m.minorServingSelfSignup,
        servingGroups: m.servingGroups || [],
        servingGLGroups: m.servingGLGroups || [],
        lowFlag: !!flags.flagById[m.id],
        lowFlagZh: flags.flagById[m.id] ? '出席偏低：建議關顧跟進' : '',
        lowFlagEn: flags.flagById[m.id] ? 'Low attendance — consider pastoral care.' : '',
        email: email || ''
      }
    });
  }

  scored.sort(function(a,b){
    if (b.score !== a.score) return b.score - a.score;
    return String(a.row.id||'').localeCompare(String(b.row.id||''));
  });
  const out = scored.slice(0,12).map(function(x){ return x.row; });

  admin_audit_(s.actor, 'MEMBER_SEARCH', JSON.stringify({q:query, results:out.length}), 'member_search');

  return { ok:true, results: out };
}

/**
 * Member detail + stats (no contact/VRM by default).
 * Shows preferredName + Member_Since.
 * Denominator start = max(fromDate, Member_Since) for %.
 */
function api_admin_member_detail(token, memberId, fromDate, toDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const mi = admin_getMembersIndex_();
  const m = mi.byId[id];
  if (!m) return admin_err_('E412','找不到此會員','Member not found.');

  const pref = String(m.preferredName||'').trim();
  const memberSinceYmd = admin_memberSinceAsYmd_(m.memberSinceRaw);

  // Denominator start date = max(range.from, memberSince)
  let denomFrom = range.from;
  if (memberSinceYmd){
    const ms = admin_parseYmd_(memberSinceYmd);
    if (ms && ms.getTime() > denomFrom.getTime()) denomFrom = ms;
  }

  const check = admin_getCheckinsDataCached_();
  if (!check.ok) return check;

  const allEvents = new Set();
  const attendedEvents = new Set();

  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;

    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < denomFrom || d > range.to) continue;

    allEvents.add(ev);
    if (r.memberId === id) attendedEvents.add(ev);
  }

  const attendedSorted = Array.from(attendedEvents).sort((a,b)=>{
    const da = admin_eventDateFromKey_(a); const db = admin_eventDateFromKey_(b);
    return (da && db) ? (da.getTime() - db.getTime()) : a.localeCompare(b);
  });

  const attended = attendedSorted.length;
  const total = allEvents.size;
  const percent = (total > 0) ? Math.round((attended / total) * 1000) / 10 : 0;

  // low attendance (today-based)
  const low = admin_getLowAttendanceFlagsCached_();
  const lowEnabled = !!low.enabled;
  const lowFlag = !!low.flagById[id];
  const away = admin_getAwayPeriodForMember_(id);
  const servingInsights = admin_getServingInsightsForMember_(id);

  admin_audit_(s.actor, 'MEMBER_DETAIL', JSON.stringify({id:id, from:String(fromDate||''), to:String(toDate||'')}), 'member_detail');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    member:{
      id: m.id,
      nameZh: m.nameZh||'',
      nameEn: m.nameEn||'',
      preferredName: pref || '',
      status: admin_normStatus_(m.status||''),
      isMinor: !!m.isMinor,
      familyId: String(m.familyId||''),
      minorServingApprovedGroups: m.minorServingApprovedGroups || [],
      minorServingSelfSignup: !!m.minorServingSelfSignup,
      minorServingApprovedBy: String(m.minorServingApprovedBy||''),
      minorServingApprovedAt: String(m.minorServingApprovedAt||''),
      memberSince: memberSinceYmd || '',
      servingGroups: m.servingGroups || [],
      servingGLGroups: m.servingGLGroups || []
    },
    attendance:{ attendedEventKeys: attendedSorted },
    stats:{
      attended: attended,
      total: total,
      percent: percent,
      denomStart: admin_fmtYmd_(denomFrom)
    },
    lowAttendance:{
      enabled: lowEnabled,
      flag: lowFlag
    },
    away:{
      from1: away.fromYmd || '',
      to1: away.toYmd || '',
      from2: away.from2Ymd || '',
      to2: away.to2Ymd || ''
    },
    servingInsights: servingInsights
  };
}

/**
 * Contact/VRM reveal (gated by reason + reauth scan in UI)
 * Returns member contact details (including VRM) ONLY after verification.
 */
function api_admin_member_contact_reveal(token, memberId, reason, reauthQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  if (String(s.actor.role||'').toUpperCase() === 'GL'){
    return admin_err_('E403','群組長模式不可查看聯絡資料','GL mode cannot access contact details.');
  }

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const why = String(reason||'').trim();
  if (!why) return admin_err_('E430','請填寫原因','Reason required.');

  const auth = admin_verifyReauth_(s.actor, reauthQrPayload);
  if (!auth.ok){
    admin_audit_(s.actor, 'CONTACT_REVEAL_DENY', JSON.stringify({memberId:id, deny:auth.code||''}), 'contact');
    return auth;
  }

  const mi = admin_getMembersIndex_();
  const m = mi.byId[id];
  if (!m) return admin_err_('E412','找不到此會員','Member not found.');

  const full = admin_getMemberRowFull_(id);
  if (!full.ok) return full;

  admin_audit_(s.actor, 'CONTACT_REVEAL', JSON.stringify({memberId:id, reason:why, confirmedBy:auth.confirmedBy||''}), 'contact');

  return {
    ok:true,
    member:{
      id:id,
      nameZh: full.member.nameZh||'',
      nameEn: full.member.nameEn||'',
      preferredName: full.member.preferredName||'',
      status: admin_normStatus_(full.member.status||''),
      email: full.member.email||'',
      mobile: full.member.mobile||'',
      vrm: full.member.vrm||'',
      vrm2: full.member.vrm2||''
    }
  };
}

/**
 * Status change (gated by reauth scan in UI).
 * Allowed: STAFF / ACTIVE / DISABLED / PROVISIONAL / TEMP (2 days) / HELPER (31 days)
 *
 * Hard-stop:
 * - cannot change another DEACON/ADMIN account's status
 */
function api_admin_member_status_change(token, memberId, newStatus, reauthQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const ns = admin_normStatus_(newStatus);
  const allowed = ['STAFF','ACTIVE','DISABLED','PROVISIONAL','TEMP','HELPER'];
  if (!allowed.includes(ns)){
    return admin_err_('E431','狀態不正確','Invalid status.');
  }

  const auth = admin_verifyReauth_(s.actor, reauthQrPayload);
  if (!auth.ok){
    admin_audit_(s.actor, 'STATUS_CHANGE_DENY', JSON.stringify({memberId:id, to:ns, deny:auth.code||''}), 'status');
    return auth;
  }

  const ss = admin_openSs_();
  const ms = admin_findMembersSheet_();
  if (!ms) return admin_err_('E500','找不到 Members 表','Members sheet not found.');

  const col = admin_getMembersColMap_(ms);
  const rowNumber = admin_findMemberRowById_(ms, col, id);
  if (!rowNumber) return admin_err_('E412','找不到此會員','Member not found.');

  const oldStatusRaw = ms.getRange(rowNumber, col.Status+1).getValue();
  const oldStatus = admin_normStatus_(oldStatusRaw);
  const actorRole = String(s.actor.role||'').trim().toUpperCase();

  if (actorRole === 'GL' && ns !== 'HELPER'){
    return admin_err_('E403','群組長只可授權 HELPER','GL can only grant HELPER.');
  }

  if (actorRole === 'GL'){
    const actorGroups = Array.isArray(s.actor.glGroups) ? s.actor.glGroups : [];
    const allowedActorGroups = actorGroups.filter(g => ADMIN_GL_HELPER_ALLOWED_GROUPS.includes(g));
    if (!allowedActorGroups.length){
      return admin_err_('E403','此群組長不允許授權 HELPER','This GL group cannot grant HELPER.');
    }

    const targetGroups = (col.ServingGroups !== undefined)
      ? admin_parseGroupsCsv_(ms.getRange(rowNumber, col.ServingGroups+1).getValue())
      : [];

    if (!admin_hasGroupOverlap_(allowedActorGroups, targetGroups)){
      return admin_err_('E403','只能授權本組成員','GL can only grant HELPER within their group.');
    }
  }

  // effective confirmer:
  // - normal: self id
  // - SUPERUSER: scanned DEACON/ADMIN id
  const effectiveActorId = String(auth.confirmedBy || s.actor.id || '').trim().toUpperCase();

  if (admin_isAdminStatus_(oldStatus) && id !== effectiveActorId){
    const zh = '帳號目前使用中，請稍後再試；如問題持續請聯絡影音同工。';
    const en = 'Account currently in use. Please try again later. If the problem persists, contact Media team.';
    admin_audit_(s.actor, 'STATUS_CHANGE_BLOCK_ADMIN', JSON.stringify({
      memberId:id, oldStatus:oldStatus, requestedTo:ns, effectiveActorId:effectiveActorId
    }), 'status');
    return admin_conflict_(zh, en, '', 'CONFLICT_GENERIC', 'RULE');
  }

  // Ensure RoleExpires column exists (for TEMP/HELPER expiry)
  const roleCol = admin_ensureRoleExpiresColumn_(ms, col);

  // Apply Status
  ms.getRange(rowNumber, col.Status+1).setValue(ns);

  let expiryIso = '';
  if (ns === 'TEMP' || ns === 'HELPER'){
    const days = (ns === 'TEMP') ? ADMIN_TEMP_DAYS : ADMIN_HELPER_DAYS;
    const expiry = new Date(Date.now() + days*24*60*60*1000);
    expiryIso = expiry.toISOString();
    ms.getRange(rowNumber, roleCol+1).setValue(expiryIso);
  } else {
    // leaving TEMP/HELPER -> clear expiry
    if (roleCol !== null) ms.getRange(rowNumber, roleCol+1).setValue('');
  }

  admin_clearMembersCache_();
  try{ CacheService.getScriptCache().remove(ADMIN_CACHE_LOWATT_KEY); }catch(e){}

  admin_audit_(s.actor, 'STATUS_CHANGE', JSON.stringify({
    memberId:id, from: oldStatusRaw, to: ns, expiryIso: expiryIso, effectiveActorId: effectiveActorId
  }), 'status');

  return { ok:true, memberId:id, fromStatus: oldStatusRaw, toStatus: ns, expiryIso: expiryIso };
}

/**
 * Record or revoke the safeguarding approval used by the serving rules.
 * STAFF/DEACON/ADMIN may approve; GL can see the state but cannot change it.
 * markAdult is the separate, reauthenticated transition once the member is 18.
 */
function api_admin_member_minor_serving_update(token, memberId, options, reauthQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  if (!(admin_isStaffOrAdminStatus_(role) || role === 'SUPERUSER')){
    return admin_err_('E403','只有 STAFF／DEACON／ADMIN 可更改未成年事奉批准','Only STAFF/DEACON/ADMIN may change young-volunteer approval.');
  }
  const id = String(memberId || '').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');
  const auth = admin_verifyReauth_(s.actor, reauthQrPayload);
  if (!auth.ok) return auth;

  const opts = options || {};
  const markAdult = !!opts.markAdult;
  const approved = !markAdult && !!opts.approved;
  const selfSignup = approved && !!opts.selfSignup;
  const ms = admin_findMembersSheet_();
  if (!ms) return admin_err_('E500','找不到 Members 表','Members sheet not found.');
  const col = admin_getMembersColMap_(ms);
  admin_ensureMemberColumns_(ms, col, ADMIN_MINOR_SERVING_HEADERS.concat(['ParentEmail']));
  const rowNumber = admin_findMemberRowById_(ms, col, id);
  if (!rowNumber) return admin_err_('E412','找不到此會員','Member not found.');
  const isMinorNow = String(ms.getRange(rowNumber, col.IsMinor + 1).getValue() || '').trim().toUpperCase() === 'YES';
  if (!isMinorNow && !markAdult){
    return admin_conflict_('此會員未標示為未滿 18 歲','This member is not marked as under 18.','', 'MEMBER_NOT_MINOR','MINOR_SERVING');
  }

  const by = String(auth.confirmedBy || s.actor.id || '').trim().toUpperCase();
  const at = admin_nowIso_();
  if (markAdult){
    ms.getRange(rowNumber, col.IsMinor + 1).setValue('NO');
    ms.getRange(rowNumber, col.MinorServingApprovedGroups + 1).setValue('');
    ms.getRange(rowNumber, col.MinorServingSelfSignup + 1).setValue('NO');
    ms.getRange(rowNumber, col.MinorServingApprovedBy + 1).setValue('');
    ms.getRange(rowNumber, col.MinorServingApprovedAt + 1).setValue('');
    if (opts.removeParentEmail && col.ParentEmail !== undefined){
      ms.getRange(rowNumber, col.ParentEmail + 1).setValue('');
    }
  }else{
    ms.getRange(rowNumber, col.MinorServingApprovedGroups + 1).setValue(approved ? ADMIN_MINOR_SERVING_GROUP : '');
    ms.getRange(rowNumber, col.MinorServingSelfSignup + 1).setValue(selfSignup ? 'YES' : 'NO');
    ms.getRange(rowNumber, col.MinorServingApprovedBy + 1).setValue(approved ? by : '');
    ms.getRange(rowNumber, col.MinorServingApprovedAt + 1).setValue(approved ? at : '');
  }
  admin_clearMembersCache_();
  if (typeof clearMembersIndexCache_ === 'function') clearMembersIndexCache_();
  admin_audit_(s.actor, markAdult ? 'MEMBER_CONFIRMED_ADULT' : 'MINOR_SERVING_APPROVAL_UPDATE', JSON.stringify({
    memberId:id,
    approved:approved,
    selfSignup:selfSignup,
    markAdult:markAdult,
    removeParentEmail:!!opts.removeParentEmail,
    confirmedBy:by
  }), 'minor_serving');
  return {
    ok:true,
    memberId:id,
    isMinor:!markAdult,
    approved:approved,
    selfSignup:selfSignup,
    approvedBy:approved ? by : '',
    approvedAt:approved ? at : '',
    parentEmailRemoved:!!(markAdult && opts.removeParentEmail)
  };
}

/* ===========================
   ===== Internals below =====
   =========================== */

function admin_openSs_(){ return SpreadsheetApp.openById(ADMIN_SPREADSHEET_ID); }
function admin_nowIso_(){ return new Date().toISOString(); }
function admin_normStatus_(s){ return String(s||'').trim().toUpperCase(); }
function admin_isAdminStatus_(s){
  const st = admin_normStatus_(s);
  return st === 'DEACON' || st === 'ADMIN';
}
function admin_isAdminActorRole_(s){
  const role = admin_normStatus_(s);
  return role === 'SUPERUSER' || admin_isAdminStatus_(role);
}
function admin_isStaffOrAdminStatus_(s){
  const st = admin_normStatus_(s);
  return st === 'STAFF' || admin_isAdminStatus_(st);
}
function admin_normalizeServingGroupToken_(token){
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
function admin_parseGroupsCsv_(value){
  return Array.from(new Set(
    String(value || '')
      .split(/[;,\n|]+/)
      .map(v => admin_normalizeServingGroupToken_(v))
      .filter(Boolean)
  ));
}
function admin_cellToYmd_(value){
  if (!value) return '';
  if (value instanceof Date){
    return Utilities.formatDate(value, ADMIN_TZ, 'yyyy-MM-dd');
  }
  const s = String(value||'').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, ADMIN_TZ, 'yyyy-MM-dd');
  return admin_parseDmyToYmd_(s) || '';
}
function admin_hasGroupOverlap_(a, b){
  const set = new Set(a || []);
  return (b || []).some(g => set.has(g));
}

function admin_err_(code, zh, en, detail, subCode, subGroup){
  const out = { ok:false, code:String(code||'E500'), zh:String(zh||'系統錯誤'), en:String(en||'System error') };
  if (detail) out.detail = String(detail);
  if (subCode) out.subCode = String(subCode);
  if (subGroup) out.subGroup = String(subGroup);
  return out;
}
function admin_conflict_(zh, en, detail, subCode, subGroup){
  return admin_err_('E409', zh, en, detail, subCode || 'CONFLICT', subGroup || 'RULE');
}

function admin_todayUkYmd_(){
  return Utilities.formatDate(new Date(), ADMIN_TZ, 'yyyy-MM-dd');
}
function admin_isSunday_(d){
  return d && d.getUTCDay && d.getUTCDay() === 0;
}
function admin_nextSunday_(d){
  const out = new Date(d.getTime());
  const day = out.getUTCDay();
  const offset = (7 - day) % 7;
  out.setUTCDate(out.getUTCDate() + offset);
  return out;
}
function admin_getUpcomingSundayEventKeys_(fromDateYmd, monthsAhead){
  const startYmd = String(fromDateYmd || '').trim() || admin_todayUkYmd_();
  let base = admin_parseYmd_(startYmd);
  if (!base) base = admin_parseYmd_(admin_todayUkYmd_());
  let start = base;
  if (!admin_isSunday_(start)) start = admin_nextSunday_(start);

  const months = Math.max(0, Math.min(Number(monthsAhead || 0), ADMIN_SERVING_MONTHS_AHEAD));
  const endMonthStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const endExclusive = new Date(Date.UTC(endMonthStart.getUTCFullYear(), endMonthStart.getUTCMonth() + 1, 1));
  const out = [];
  for (let i = 0; i < 370; i++){
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + (i * 7));
    if (!admin_isSunday_(d)) continue;
    if (d.getTime() >= endExclusive.getTime()) break;
    const ymd = admin_fmtYmd_(d);
    out.push({ eventKey: 'SundayService_' + ymd, dateYmd: ymd });
  }
  return out;
}


function admin_getSermonInfoSheet_(){
  const ss = admin_openSs_();
  return ss.getSheetByName(ADMIN_SERMON_SHEET_NAME) || null;
}
function admin_ensureSermonInfoSheet_(){
  const ss = admin_openSs_();
  let sh = ss.getSheetByName(ADMIN_SERMON_SHEET_NAME);
  const headers = [
    'EventKey','Speaker','SermonTitle','SermonPassageRaw','SermonPassageCanonical','SermonPassageStatus',
    'ResponsePassageRaw','ResponsePassageCanonical','ResponsePassageStatus','UpdatedAt','UpdatedBy','UpdatedRole','ResponseSpeaker'
  ];
  if (!sh) sh = ss.insertSheet(ADMIN_SERMON_SHEET_NAME);
  const existingCols = Math.max(sh.getLastColumn(), headers.length);
  const existing = existingCols > 0 ? sh.getRange(1,1,1,existingCols).getValues()[0].map(function(v){ return String(v||'').trim(); }) : [];
  let needsHeader = (sh.getLastRow() === 0);
  if (!needsHeader){
    for (let i=0;i<headers.length;i++){
      if (existing[i] !== headers[i]){ needsHeader = true; break; }
    }
  }
  if (needsHeader) sh.getRange(1,1,1,headers.length).setValues([headers]);
  sh.getRange(1,1,1,headers.length).setFontWeight('bold');
  return sh;
}
function admin_getSermonInfoHeaderMap_(sh){
  const lastCol = Math.max((sh && sh.getLastColumn()) || 0, 13);
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(function(v){ return String(v||'').trim(); });
  const map = {};
  headers.forEach(function(h, idx){ if (h) map[h] = idx + 1; });
  return map;
}
function admin_findSermonInfoRowByEventKey_(sh, eventKey){
  const ev = String(eventKey || '').trim();
  if (!ev) return null;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const colMap = admin_getSermonInfoHeaderMap_(sh);
  const evCol = colMap['EventKey'] || 1;
  const values = sh.getRange(2, evCol, lastRow - 1, 1).getValues();
  for (let i=0;i<values.length;i++) if (String((values[i] && values[i][0]) || '').trim() === ev) return i + 2;
  return null;
}
function admin_getMonthSundayEvents_(ym){
  const v = String(ym || '').trim();
  const m = v.match(/^(\d{4})-(\d{2})$/);
  if (!m) return [];
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (!(mo >= 1 && mo <= 12)) return [];
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const nextMonth = new Date(Date.UTC(y, mo, 1));
  const out = [];
  let cursor = new Date(first.getTime());
  while (cursor.getUTCDay() !== 0){ cursor.setUTCDate(cursor.getUTCDate() + 1); }
  for (let i=0;i<6;i++){
    if (cursor.getTime() >= nextMonth.getTime()) break;
    const ymd = admin_fmtYmd_(cursor);
    out.push({ eventKey:'SundayService_' + ymd, dateYmd: ymd });
    cursor = new Date(cursor.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}
function admin_ensureSermonRowsForMonth_(sh, ym){
  const events = admin_getMonthSundayEvents_(ym);
  if (!events.length) return [];
  const colMap = admin_getSermonInfoHeaderMap_(sh);
  const lastRow = sh.getLastRow();
  const eventCol = colMap['EventKey'] || 1;
  const existing = {};
  if (lastRow >= 2){
    const values = sh.getRange(2, eventCol, lastRow - 1, 1).getValues();
    values.forEach(function(row){ const ev = String((row && row[0]) || '').trim(); if (ev) existing[ev] = true; });
  }
  const toAppend = [];
  events.forEach(function(ev){
    if (!existing[ev.eventKey]) toAppend.push([ev.eventKey,'','','','','','','','','','','','']);
  });
  if (toAppend.length) sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, 13).setValues(toAppend);
  return events;
}
function admin_sermonBlankFromEventKey_(eventKey){
  const ev = String(eventKey || '').trim();
  const m = ev.match(/^SundayService_(\d{4}-\d{2}-\d{2})$/);
  return {
    eventKey: ev,
    dateYmd: m ? m[1] : '',
    speaker: '',
    sermonTitle: '',
    sermonPassageRaw: '',
    sermonPassageCanonical: '',
    sermonPassageStatus: 'EMPTY',
    responsePassageRaw: '',
    responsePassageCanonical: '',
    responsePassageStatus: 'EMPTY',
    responseSpeaker: '',
    updatedAt: '',
    updatedBy: '',
    updatedRole: ''
  };
}
function admin_rowToSermonInfo_(row, colMap, fallbackEventKey){
  const ev = String(row[(colMap['EventKey'] || 1) - 1] || '').trim() || String(fallbackEventKey || '').trim();
  const blank = admin_sermonBlankFromEventKey_(ev);
  return {
    eventKey: ev,
    dateYmd: blank.dateYmd,
    speaker: String(row[(colMap['Speaker'] || 2) - 1] || '').trim(),
    sermonTitle: String(row[(colMap['SermonTitle'] || 3) - 1] || '').trim(),
    sermonPassageRaw: String(row[(colMap['SermonPassageRaw'] || 4) - 1] || '').trim(),
    sermonPassageCanonical: String(row[(colMap['SermonPassageCanonical'] || 5) - 1] || '').trim(),
    sermonPassageStatus: String(row[(colMap['SermonPassageStatus'] || 6) - 1] || '').trim() || 'EMPTY',
    responsePassageRaw: String(row[(colMap['ResponsePassageRaw'] || 7) - 1] || '').trim(),
    responsePassageCanonical: String(row[(colMap['ResponsePassageCanonical'] || 8) - 1] || '').trim(),
    responsePassageStatus: String(row[(colMap['ResponsePassageStatus'] || 9) - 1] || '').trim() || 'EMPTY',
    responseSpeaker: String(row[(colMap['ResponseSpeaker'] || 13) - 1] || '').trim(),
    updatedAt: String(row[(colMap['UpdatedAt'] || 10) - 1] || '').trim(),
    updatedBy: String(row[(colMap['UpdatedBy'] || 11) - 1] || '').trim(),
    updatedRole: String(row[(colMap['UpdatedRole'] || 12) - 1] || '').trim()
  };
}
function admin_getSermonRecordByEventKey_(eventKey){
  const blank = admin_sermonBlankFromEventKey_(eventKey);
  const sh = admin_getSermonInfoSheet_();
  if (!sh) return blank;
  const rowNumber = admin_findSermonInfoRowByEventKey_(sh, blank.eventKey);
  if (!rowNumber) return blank;
  const colMap = admin_getSermonInfoHeaderMap_(sh);
  const row = sh.getRange(rowNumber, 1, 1, Math.max(sh.getLastColumn(), 13)).getValues()[0];
  return admin_rowToSermonInfo_(row, colMap, blank.eventKey);
}
function admin_upsertSermonInfoRow_(eventKey, fields){
  const sh = admin_ensureSermonInfoSheet_();
  const colMap = admin_getSermonInfoHeaderMap_(sh);
  let rowNumber = admin_findSermonInfoRowByEventKey_(sh, eventKey);
  if (!rowNumber){
    sh.appendRow([String(eventKey||'').trim(),'','','','','','','','','','','','']);
    rowNumber = sh.getLastRow();
  }
  const allFields = fields || {};
  ['EventKey','Speaker','SermonTitle','SermonPassageRaw','SermonPassageCanonical','SermonPassageStatus','ResponsePassageRaw','ResponsePassageCanonical','ResponsePassageStatus','UpdatedAt','UpdatedBy','UpdatedRole','ResponseSpeaker'].forEach(function(k){
    if (!Object.prototype.hasOwnProperty.call(allFields, k) && k !== 'EventKey') return;
    const v = (k === 'EventKey') ? String(eventKey||'').trim() : String(allFields[k] || '').trim();
    sh.getRange(rowNumber, colMap[k] || 1).setValue(v);
  });
  return admin_getSermonRecordByEventKey_(eventKey);
}
function admin_getSermonInfoForMonth_(eventKeys){
  const out = {};
  const keys = Array.isArray(eventKeys) ? eventKeys.map(function(ev){ return String(ev||'').trim(); }).filter(Boolean) : [];
  keys.forEach(function(ev){ out[ev] = admin_sermonBlankFromEventKey_(ev); });
  if (!keys.length) return out;
  const sh = admin_getSermonInfoSheet_();
  if (!sh || sh.getLastRow() < 2) return out;
  const wanted = {};
  keys.forEach(function(ev){ wanted[ev] = true; });
  const colMap = admin_getSermonInfoHeaderMap_(sh);
  const rows = sh.getRange(2,1,sh.getLastRow()-1,Math.max(sh.getLastColumn(),12)).getValues();
  rows.forEach(function(row){
    const ev = String(row[(colMap['EventKey'] || 1) - 1] || '').trim();
    if (!wanted[ev]) return;
    out[ev] = admin_rowToSermonInfo_(row, colMap, ev);
  });
  return out;
}
// Backward compatibility wrappers
function admin_getSermonSheet_(){ return admin_getSermonInfoSheet_(); }
function admin_ensureSermonSheet_(){ return admin_ensureSermonInfoSheet_(); }
function admin_getSermonColMap_(sh){ return admin_getSermonInfoHeaderMap_(sh); }
function admin_findSermonRowByEventKey_(sh, eventKey){ return admin_findSermonInfoRowByEventKey_(sh, eventKey); }
function admin_getSermonMapByEventKeys_(eventKeys){ return admin_getSermonInfoForMonth_(eventKeys); }

// sermon-info-v1 + bible-parser-v1
function bible_normalizeReferenceInput_(raw){
  return String(raw || '')
    .replace(/[：﹕]/g, ':')
    .replace(/[；︔]/g, ';')
    .replace(/[，]/g, ',')
    .replace(/[–—−~～]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

var __BIBLE_S2T_CHAR_MAP = {
  '创':'創','记':'記','亚':'亞','师':'師','历':'歷','诗':'詩','传':'傳','赛':'賽','结':'結','弥':'彌','鸿':'鴻','该':'該','玛':'瑪',
  '马':'馬','约':'約','罗':'羅','后':'後','门':'門','启':'啟','录':'錄','犹':'猶','书':'書','翰':'翰','众':'眾','灵':'靈','颂':'頌'
};
var __BIBLE_T2S_CHAR_MAP = null;
function bible_toTraditionalZh_(text){
  var src = String(text || '');
  return src.split('').map(function(ch){ return __BIBLE_S2T_CHAR_MAP[ch] || ch; }).join('');
}
function bible_toSimplifiedZh_(text){
  if (!__BIBLE_T2S_CHAR_MAP){
    __BIBLE_T2S_CHAR_MAP = {};
    Object.keys(__BIBLE_S2T_CHAR_MAP).forEach(function(k){
      var t = __BIBLE_S2T_CHAR_MAP[k];
      if (!__BIBLE_T2S_CHAR_MAP[t]) __BIBLE_T2S_CHAR_MAP[t] = k;
    });
  }
  var src = String(text || '');
  return src.split('').map(function(ch){ return __BIBLE_T2S_CHAR_MAP[ch] || ch; }).join('');
}
function bible_expandZhAliasVariants_(alias){
  var out = [];
  function add(v){
    var s = String(v || '').trim();
    if (!s) return;
    if (out.indexOf(s) < 0) out.push(s);
  }
  var base = String(alias || '').trim();
  if (!base) return out;
  add(base);
  add(bible_toTraditionalZh_(base));
  add(bible_toSimplifiedZh_(base));
  var snapshot = out.slice();
  snapshot.forEach(function(v){
    if (/[㐀-鿿]/.test(v) && v.length >= 3) add(v.slice(0, -1));
  });
  return out;
}
function bible_derivedZhAliases_(zhName){
  var zh = String(zhName || '').trim();
  if (!zh) return [];
  var out = [];
  function add(v){
    var k = String(v || '').trim();
    if (!k || k === zh) return;
    if (out.indexOf(k) < 0) out.push(k);
  }
  if (/福音$/.test(zh)) add(zh.replace(/福音$/, ''));
  if (/行傳$/.test(zh)) add(zh.replace(/行傳$/, ''));
  if (/啟示錄$/.test(zh)) add(zh.replace(/錄$/, ''));
  if (/篇$/.test(zh)) add(zh.replace(/篇$/, ''));
  if (/書$/.test(zh)) add(zh.replace(/書$/, ''));
  if (/記$/.test(zh)) add(zh.replace(/記$/, ''));
  if (/記([上下])$/.test(zh)) add(zh.replace(/記([上下])$/, '$1'));
  if (/紀([上下])$/.test(zh)) add(zh.replace(/紀([上下])$/, '$1'));
  if (/志([上下])$/.test(zh)) add(zh.replace(/志([上下])$/, '$1'));
  return out;
}
function bible_buildBookAliasMap_(){
  if (typeof __BIBLE_ALIAS_CACHE !== 'undefined' && __BIBLE_ALIAS_CACHE) return __BIBLE_ALIAS_CACHE;
  var books = [
    ['GEN','創世記','Genesis',['創','創世記','gen','ge','gn']],['EXO','出埃及記','Exodus',['出','出埃及記','exo','ex']],['LEV','利未記','Leviticus',['利','利未記','lev']],
    ['NUM','民數記','Numbers',['民','民數記','num','nu']],['DEU','申命記','Deuteronomy',['申','申命記','deu','dt']],['JOS','約書亞記','Joshua',['書','約書亞記','jos']],
    ['JDG','士師記','Judges',['士','士師記','jdg']],['RUT','路得記','Ruth',['得','路得記','rut']],['1SA','撒母耳記上','1 Samuel',['撒上','1sa','1 sam']],['2SA','撒母耳記下','2 Samuel',['撒下','2sa','2 sam']],
    ['1KI','列王紀上','1 Kings',['王上','1ki','1 kgs']],['2KI','列王紀下','2 Kings',['王下','2ki','2 kgs']],['1CH','歷代志上','1 Chronicles',['代上','1ch']],['2CH','歷代志下','2 Chronicles',['代下','2ch']],
    ['EZR','以斯拉記','Ezra',['拉','ezr']],['NEH','尼希米記','Nehemiah',['尼','neh']],['EST','以斯帖記','Esther',['斯','est']],['JOB','約伯記','Job',['伯','job']],
    ['PSA','詩篇','Psalm',['詩','詩篇','psalm','psalms','ps']],['PRO','箴言','Proverbs',['箴','proverbs','prov','pro']],['ECC','傳道書','Ecclesiastes',['傳','ecc']],['SNG','雅歌','Song of Songs',['歌','雅歌','song of songs','song']],
    ['ISA','以賽亞書','Isaiah',['賽','isa']],['JER','耶利米書','Jeremiah',['耶','jer']],['LAM','耶利米哀歌','Lamentations',['哀','lam']],['EZK','以西結書','Ezekiel',['結','ezk']],['DAN','但以理書','Daniel',['但','dan']],
    ['HOS','何西阿書','Hosea',['何','hos']],['JOL','約珥書','Joel',['珥','jol']],['AMO','阿摩司書','Amos',['摩','amo']],['OBA','俄巴底亞書','Obadiah',['俄','oba']],['JON','約拿書','Jonah',['拿','jon']],
    ['MIC','彌迦書','Micah',['彌','mic']],['NAM','那鴻書','Nahum',['鴻','nam']],['HAB','哈巴谷書','Habakkuk',['哈','hab']],['ZEP','西番雅書','Zephaniah',['番','zep']],['HAG','哈該書','Haggai',['該','hag']],
    ['ZEC','撒迦利亞書','Zechariah',['亞','zec']],['MAL','瑪拉基書','Malachi',['瑪','mal']],['MAT','馬太福音','Matthew',['太','馬太福音','matthew','matt','mt']],['MRK','馬可福音','Mark',['可','馬可福音','mark','mk']],
    ['LUK','路加福音','Luke',['路','路加','路加福音','luke','lk']],['JHN','約翰福音','John',['約','約翰福音','john','jn']],['ACT','使徒行傳','Acts',['徒','使徒行傳','acts','ac']],['ROM','羅馬書','Romans',['羅','羅馬書','romans','rom']],
    ['1CO','哥林多前書','1 Corinthians',['林前','1co','1 cor']],['2CO','哥林多後書','2 Corinthians',['林後','2co','2 cor']],['GAL','加拉太書','Galatians',['加','gal']],['EPH','以弗所書','Ephesians',['弗','eph']],['PHP','腓立比書','Philippians',['腓','php','phil']],
    ['COL','歌羅西書','Colossians',['西','col']],['1TH','帖撒羅尼迦前書','1 Thessalonians',['帖前','1th']],['2TH','帖撒羅尼迦後書','2 Thessalonians',['帖後','2th']],['1TI','提摩太前書','1 Timothy',['提前','1ti']],['2TI','提摩太後書','2 Timothy',['提後','2ti']],
    ['TIT','提多書','Titus',['多','tit']],['PHM','腓利門書','Philemon',['門','phm']],['HEB','希伯來書','Hebrews',['來','heb']],['JAS','雅各書','James',['雅','jas']],['1PE','彼得前書','1 Peter',['彼前','1pe']],
    ['2PE','彼得後書','2 Peter',['彼後','2pe']],['1JN','約翰一書','1 John',['約一','1jn']],['2JN','約翰二書','2 John',['約二','2jn']],['3JN','約翰三書','3 John',['約三','3jn']],['JUD','猶大書','Jude',['猶','jud']],['REV','啟示錄','Revelation',['啟','啟示錄','revelation','rev']]
  ];
  var map = {};
  books.forEach(function(b){
    var meta = { key:b[0], zh:b[1], en:b[2] };
    [b[1], b[2]].concat(b[3]||[]).concat(bible_derivedZhAliases_(b[1])).forEach(function(a){
      bible_expandZhAliasVariants_(a).forEach(function(v){
        var k = String(v||'').trim().toLowerCase();
        if (!k) return;
        if (!map[k]) map[k] = meta;
        var kNoSpace = k.replace(/\s+/g,'');
        if (!map[kNoSpace]) map[kNoSpace] = meta;
      });
    });
  });
  __BIBLE_ALIAS_CACHE = map;
  return map;
}
var __BIBLE_ALIAS_CACHE = null;
function bible_parseReference_(raw){
  var src = String(raw||'');
  var normalized = bible_normalizeReferenceInput_(src);
  if (!normalized) return { ok:true, status:'EMPTY', code:'', raw:src, canonical:'', segments:[], reasonZh:'', reasonEn:'' };
  var alias = bible_buildBookAliasMap_();
  var pieces = normalized.split(';').map(function(x){ return String(x||'').trim(); }).filter(Boolean);
  if (!pieces.length) return { ok:true, status:'EMPTY', code:'', raw:src, canonical:'', segments:[], reasonZh:'', reasonEn:'' };
  var segments = [];
  var prevBook = null, prevChapter = null;
  for (var i=0;i<pieces.length;i++){
    var piece = pieces[i];
    var m = piece.match(/^([^\d]+?)\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)$/) || piece.match(/^([^\d]+?)\s*(\d+)\s*:\s*(\d+)$/);
    var mInheritChapter = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    var mInheritBookWithChapter = piece.match(/^(\d+)\s*:\s*(\d+)\s*-\s*(\d+)$/) || piece.match(/^(\d+)\s*:\s*(\d+)$/);
    var bookMeta = null, chapter = null, v1 = null, v2 = null;
    if (m){
      var bookRaw = String(m[1]||'').trim().toLowerCase().replace(/\s+/g,'');
      bookMeta = alias[bookRaw] || alias[String(m[1]||'').trim().toLowerCase()];
      if (!bookMeta){
        if (i === 0) return { ok:false, status:'INVALID', code:'E711', raw:src, canonical:'', segments:segments, reasonZh:'無法識別卷名', reasonEn:'Unknown Bible book.' };
        if (!/\d/.test(String(m[1]||''))){ bookMeta = prevBook; }
      }
      chapter = parseInt(m[2],10); v1 = parseInt(m[3],10); v2 = m[4] ? parseInt(m[4],10) : v1;
    } else if (mInheritChapter){
      if (!prevBook || !prevChapter) return { ok:false, status:'AMBIGUOUS', code:'E712', raw:src, canonical:'', segments:segments, reasonZh:'後段缺少卷名或章節', reasonEn:'Later segment missing book/chapter context.' };
      bookMeta = prevBook; chapter = prevChapter; v1 = parseInt(mInheritChapter[1],10); v2 = parseInt(mInheritChapter[2],10);
    } else if (mInheritBookWithChapter){
      if (!prevBook) return { ok:false, status:'AMBIGUOUS', code:'E712', raw:src, canonical:'', segments:segments, reasonZh:'後段缺少卷名', reasonEn:'Later segment missing book context.' };
      bookMeta = prevBook;
      chapter = parseInt(mInheritBookWithChapter[1],10);
      v1 = parseInt(mInheritBookWithChapter[2],10);
      v2 = mInheritBookWithChapter[3] ? parseInt(mInheritBookWithChapter[3],10) : v1;
    } else {
      return { ok:false, status:'INVALID', code:'E713', raw:src, canonical:'', segments:segments, reasonZh:'章節格式不正確', reasonEn:'Invalid chapter/verse format.' };
    }
    if (!bookMeta) return { ok:false, status:'INVALID', code:'E711', raw:src, canonical:'', segments:segments, reasonZh:'無法識別卷名', reasonEn:'Unknown Bible book.' };
    if (!(chapter > 0 && v1 > 0 && v2 > 0 && v2 >= v1)) return { ok:false, status:'INVALID', code:'E713', raw:src, canonical:'', segments:segments, reasonZh:'章節範圍不正確', reasonEn:'Invalid chapter/verse range.' };
    if (v2 - v1 > 176) return { ok:false, status:'AMBIGUOUS', code:'E712', raw:src, canonical:'', segments:segments, reasonZh:'經文範圍過大或不明確', reasonEn:'Verse range too broad or ambiguous.' };
    segments.push({ bookKey:bookMeta.key, bookZh:bookMeta.zh, bookEn:bookMeta.en, chapter:chapter, verseStart:v1, verseEnd:v2 });
    prevBook = bookMeta; prevChapter = chapter;
  }
  var canonical = segments.map(function(seg, idx){
    var core = seg.chapter + ':' + seg.verseStart + (seg.verseEnd !== seg.verseStart ? ('-' + seg.verseEnd) : '');
    return idx === 0 ? (seg.bookZh + ' ' + core) : core;
  }).join('; ');
  return { ok:true, status:'OK', code:'', raw:src, canonical:canonical, segments:segments, reasonZh:'', reasonEn:'' };
}
function bible_expandCanonicalSegments_(parsed){
  return parsed && Array.isArray(parsed.segments) ? parsed.segments : [];
}
function bible_bookShortZhByKey_(bookKey){
  var map = {
    GEN:'創',EXO:'出',LEV:'利',NUM:'民',DEU:'申',JOS:'書',JDG:'士',RUT:'得',
    '1SA':'撒上','2SA':'撒下','1KI':'王上','2KI':'王下','1CH':'代上','2CH':'代下',
    EZR:'拉',NEH:'尼',EST:'斯',JOB:'伯',PSA:'詩',PRO:'箴',ECC:'傳',SNG:'歌',
    ISA:'賽',JER:'耶',LAM:'哀',EZK:'結',DAN:'但',HOS:'何',JOL:'珥',AMO:'摩',OBA:'俄',JON:'拿',MIC:'彌',NAM:'鴻',HAB:'哈',ZEP:'番',HAG:'該',ZEC:'亞',MAL:'瑪',
    MAT:'太',MRK:'可',LUK:'路',JHN:'約',ACT:'徒',ROM:'羅',
    '1CO':'林前','2CO':'林後',GAL:'加',EPH:'弗',PHP:'腓',COL:'西','1TH':'帖前','2TH':'帖後','1TI':'提前','2TI':'提後',TIT:'多',PHM:'門',HEB:'來',JAS:'雅','1PE':'彼前','2PE':'彼後','1JN':'約一','2JN':'約二','3JN':'約三',JUD:'猶',REV:'啟'
  };
  var key = String(bookKey || '').trim().toUpperCase();
  return map[key] || '';
}

function bible_fetchReferenceText_(canonicalRef, version){
  var vRaw = String(version || 'unv').trim().toLowerCase();
  var v = (vRaw === 'rcuv' || vRaw === 'unv') ? vRaw : 'unv';
  var parsed = bible_parseReference_(canonicalRef);
  if (!parsed.ok || parsed.status !== 'OK') return { ok:false, code:'E713', zh:'經文格式錯誤', en:'Invalid reference format.', canonical:canonicalRef, version:v, verses:[] };
  var segs = bible_expandCanonicalSegments_(parsed);
  var verses = [];
  try{
    segs.forEach(function(seg){
      var shortZh = bible_bookShortZhByKey_(seg.bookKey) || seg.bookZh;
      var secRange = (Number(seg.verseEnd || 0) > Number(seg.verseStart || 0))
        ? (String(seg.verseStart) + '-' + String(seg.verseEnd))
        : String(seg.verseStart);
      var url = 'https://bible.fhl.net/json/qb.php?chineses='+encodeURIComponent(shortZh)+'&chap='+encodeURIComponent(seg.chapter)+'&sec='+encodeURIComponent(secRange)+'&version='+encodeURIComponent(v)+'&strong=0&gb=0';
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions:true, followRedirects:true });
      if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) throw new Error('http_'+resp.getResponseCode());
      var data = JSON.parse(resp.getContentText() || '{}');
      var rec = Array.isArray(data.record) ? data.record : [];
      if (!rec.length){
        var fallbackUrl = 'https://bible.fhl.net/json/qsb.php?chineses='+encodeURIComponent(shortZh)+'&chap='+encodeURIComponent(seg.chapter)+'&sec='+encodeURIComponent(secRange)+'&version='+encodeURIComponent(v)+'&strong=0&gb=0';
        var fallbackResp = UrlFetchApp.fetch(fallbackUrl, { muteHttpExceptions:true, followRedirects:true });
        if (fallbackResp.getResponseCode() >= 200 && fallbackResp.getResponseCode() < 300){
          var fallbackData = JSON.parse(fallbackResp.getContentText() || '{}');
          rec = Array.isArray(fallbackData.record) ? fallbackData.record : [];
        }
      }
      rec.forEach(function(r){
        verses.push({
          bookZh: seg.bookZh,
          chapter: Number(r.chap || seg.chapter),
          verse: Number(r.sec || 0),
          text: String(r.bible_text || '').trim()
        });
      });
    });
    if (!verses.length) return { ok:false, code:'E716', zh:'找不到經文內容', en:'No verses returned.', canonical:parsed.canonical, version:v, verses:[] };
    return { ok:true, canonical:parsed.canonical, version:v, verses:verses };
  }catch(e){
    return { ok:false, code:'E715', zh:'抓取經文失敗', en:'Bible fetch failed.', detail:String(e&&e.message||e), canonical:parsed.canonical, version:v, verses:[] };
  }
}

function admin_getServingSheet_(){
  const ss = admin_openSs_();
  return ss.getSheetByName(ADMIN_SERVING_SHEET_NAME) || null;
}
function admin_ensureServingSheet_(){
  const ss = admin_openSs_();
  let sh = ss.getSheetByName(ADMIN_SERVING_SHEET_NAME);
  if (!sh){
    sh = ss.insertSheet(ADMIN_SERVING_SHEET_NAME);
    sh.appendRow(['EventKey'].concat(ADMIN_SERVING_POSITIONS.map(admin_servingHeaderLabel_)));
    sh.getRange(1,1,1,1 + ADMIN_SERVING_POSITIONS.length).setFontWeight('bold');
  }
  admin_ensureServingHeaders_(sh);
  return sh;
}
function admin_ensureServingEventKeys_(sh){
  const events = admin_getUpcomingSundayEventKeys_(admin_todayUkYmd_(), ADMIN_SERVING_MONTHS_AHEAD);
  if (!events.length) return;

  // Existing rows may contain past services. Do not assume that future events
  // belong at the same zero-based row as the generated event list: that left
  // valid future buttons visible in the portal without a writable sheet row.
  const lastRow = sh.getLastRow();
  const existing = lastRow >= 2
    ? sh.getRange(2, 1, lastRow - 1, 1).getValues()
    : [];
  const existingKeys = {};
  existing.forEach(function(row){
    const eventKey = String((row && row[0]) || '').trim();
    if (eventKey) existingKeys[eventKey] = true;
  });

  const missing = events.filter(function(ev){
    return ev && ev.eventKey && !existingKeys[ev.eventKey];
  });
  if (!missing.length) return;

  const startRow = Math.max(2, lastRow + 1);
  const requiredLastRow = startRow + missing.length - 1;
  const maxRows = sh.getMaxRows();
  if (requiredLastRow > maxRows){
    sh.insertRowsAfter(maxRows, requiredLastRow - maxRows);
  }
  sh.getRange(startRow, 1, missing.length, 1).setValues(
    missing.map(function(ev){ return [ev.eventKey]; })
  );
}
function admin_ensureServingHeaders_(sh){
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const existing = sh.getRange(1,1,1,lastCol).getValues()[0].map(v => String(v||'').trim());
  const desired = ['EventKey'].concat(ADMIN_SERVING_POSITIONS.map(admin_servingHeaderLabel_));

  const headerNeedsMigration = existing.some(function(h){
    const raw = String(h || '').trim();
    return raw.indexOf('Worship_Singer_1') >= 0 || raw.indexOf('Worship_Singer_2') >= 0 || raw.indexOf('Worship_Instrument_1') >= 0 || raw.indexOf('Worship_Instrument_2') >= 0;
  });
  const sameHeader = (existing.length === desired.length) && desired.every(function(label, idx){ return existing[idx] === label; });
  if (!headerNeedsMigration && sameHeader) return;

  const data = (lastRow > 0 && lastCol > 0) ? sh.getRange(1,1,lastRow,lastCol).getValues() : [];
  const oldHeaders = data.length ? data[0].map(v => String(v||'').trim()) : existing;
  const keyByCol = oldHeaders.map(admin_extractServingKey_);

  function mergedValue_(vals, maxSlots){
    const out = [];
    const seen = {};
    vals.forEach(function(raw){
      admin_splitServingValues_(raw).forEach(function(token){
        const t = String(token||'').trim();
        if (!t) return;
        const k = t.toUpperCase();
        if (seen[k]) return;
        if (out.length >= maxSlots) return;
        seen[k] = true;
        out.push(t);
      });
    });
    return out.join(', ');
  }

  const newData = [desired];
  for (let r=1; r<data.length; r++){
    const row = data[r];
    const valueByKey = {};
    for (let c=1; c<oldHeaders.length; c++){
      const key = keyByCol[c];
      if (!key) continue;
      const raw = String(row[c] || '').trim();
      if (!raw) continue;
      if (!valueByKey[key]) valueByKey[key] = [];
      valueByKey[key].push(raw);
    }

    const outRow = [String(row[0] || '').trim()];
    ADMIN_SERVING_POSITIONS.forEach(function(pos){
      let merged = '';
      if (pos === 'Worship_Singer'){
        merged = mergedValue_((valueByKey['Worship_Singer'] || []).concat(valueByKey['Worship_Singer_1'] || [], valueByKey['Worship_Singer_2'] || []), Number(ADMIN_SERVING_POSITION_MAX[pos] || 1));
      } else if (pos === 'Worship_Instrument'){
        merged = mergedValue_((valueByKey['Worship_Instrument'] || []).concat(valueByKey['Worship_Instrument_1'] || [], valueByKey['Worship_Instrument_2'] || []), Number(ADMIN_SERVING_POSITION_MAX[pos] || 1));
      } else {
        merged = mergedValue_(valueByKey[pos] || [], Number(ADMIN_SERVING_POSITION_MAX[pos] || 1));
      }
      outRow.push(merged);
    });
    newData.push(outRow);
  }

  const targetCols = desired.length;
  if (sh.getMaxColumns() < targetCols){
    sh.insertColumnsAfter(sh.getMaxColumns(), targetCols - sh.getMaxColumns());
  }
  sh.getRange(1,1,Math.max(1, newData.length), targetCols).clearContent();
  if (newData.length){
    sh.getRange(1,1,newData.length,targetCols).setValues(newData);
  } else {
    sh.getRange(1,1,1,targetCols).setValues([desired]);
  }
  sh.getRange(1,1,1,targetCols).setFontWeight('bold');
  const extraCols = sh.getLastColumn() - targetCols;
  if (extraCols > 0){
    sh.deleteColumns(targetCols + 1, extraCols);
  }
}
function admin_ensureAwaySheet_(){
  const ss = admin_openSs_();
  let sh = ss.getSheetByName(ADMIN_SERVING_AWAY_SHEET_NAME);
  if (!sh){
    sh = ss.insertSheet(ADMIN_SERVING_AWAY_SHEET_NAME);
    sh.appendRow(['MemberId','FromYmd','ToYmd','UpdatedAt','UpdatedBy','UpdatedRole']);
    sh.getRange(1,1,1,6).setFontWeight('bold');
  }
  return sh;
}
function admin_appendAwayHistory_(memberId, periods, actor){
  const id = String(memberId||'').trim().toUpperCase();
  if (!id) return;
  const sh = admin_ensureAwaySheet_();
  const now = admin_nowIso_();
  const role = (actor && actor.id === 'SUPERUSER') ? 'SUPERUSER' : String((actor && actor.role) || '').trim().toUpperCase();
  const by = String((actor && actor.id) || '').trim().toUpperCase();
  const list = Array.isArray(periods) ? periods : [];
  if (!list.length){
    sh.appendRow([id, '', '', now, by, role]);
    return;
  }
  list.forEach(function(p){
    sh.appendRow([id, String((p && p.from) || '').trim(), String((p && p.to) || '').trim(), now, by, role]);
  });
}
function admin_getAwayHistoryPeriodsMap_(memberIds){
  const out = {};
  const ids = new Set((Array.isArray(memberIds)?memberIds:[]).map(function(x){ return String(x||'').trim().toUpperCase(); }).filter(Boolean));
  if (!ids.size) return out;
  const sh = admin_ensureAwaySheet_();
  const last = sh.getLastRow();
  if (last < 2) return out;
  const rows = sh.getRange(2,1,last-1,6).getValues();
  rows.forEach(function(r){
    const id = String(r[0]||'').trim().toUpperCase();
    if (!ids.has(id)) return;
    const from = String(r[1]||'').trim();
    const to = String(r[2]||'').trim();
    if (!from || !to) return;
    out[id] = out[id] || [];
    out[id].push({ fromYmd: from, toYmd: to });
  });
  return out;
}
function admin_normalizeAwayPeriod_(fromYmd, toYmd){
  const f = admin_parseDmyToYmd_(fromYmd);
  const t = admin_parseDmyToYmd_(toYmd);
  if (!f && !t) return { fromYmd:'', toYmd:'' };
  return { fromYmd: f || t, toYmd: t || f };
}

function admin_memberLabelCompact_(m){
  const id = String((m && m.id) || '').trim().toUpperCase();
  const pref = String((m && m.preferredName) || '').trim();
  const zh = String((m && m.nameZh) || '').trim();
  const en = String((m && m.nameEn) || '').trim();
  const fallback = [en, zh].filter(Boolean).join(' / ');
  const hasName = !!(pref || fallback || zh || en);
  const display = pref || fallback || zh || en || '⚠️ 找不到會員姓名 / Member name not found';
  const isMinor = !!(m && m.isMinor);
  const prefix = isMinor ? '🧒 ' : '';
  return {
    id: id,
    nameZh: zh,
    nameEn: en,
    preferredName: pref,
    isMinor: isMinor,
    familyId: String((m && m.familyId) || '').trim(),
    nameFound:hasName,
    name: display,
    label: id ? (prefix + id + ' · ' + display) : (prefix + display)
  };
}
function admin_minorApprovedForGroup_(member, groupKey){
  if (!member || !member.isMinor) return true;
  const key = admin_normalizeServingGroupToken_(groupKey);
  const approved = Array.isArray(member.minorServingApprovedGroups)
    ? member.minorServingApprovedGroups
    : admin_parseGroupsCsv_(member.minorServingApprovedGroups || '');
  return approved.indexOf(key) >= 0;
}
function admin_minorServingEligibility_(member, groupKey){
  if (!member) return admin_err_('E412','找不到此會員','Member not found.');
  if (!member.isMinor) return { ok:true, isMinor:false };
  const group = admin_normalizeServingGroupToken_(groupKey);
  if (group !== ADMIN_MINOR_SERVING_GROUP){
    return admin_conflict_('未成年會員目前只可參與後勤事奉','Young volunteers may currently serve in Logistics only.','', 'MINOR_GROUP_NOT_ALLOWED','MINOR_SERVING');
  }
  if (admin_normStatus_(member.status) !== 'ACTIVE'){
    return admin_conflict_('未成年會員必須先成為 ACTIVE 才可安排事奉','A young volunteer must be ACTIVE before being rostered.','', 'MINOR_NOT_ACTIVE','MINOR_SERVING');
  }
  if (!admin_minorApprovedForGroup_(member, group)){
    return admin_conflict_('未成年會員尚未獲批准參與後勤事奉','This young member is not approved to serve in Logistics.','', 'MINOR_NOT_APPROVED','MINOR_SERVING');
  }
  return { ok:true, isMinor:true, selfSignup:!!member.minorServingSelfSignup };
}
function admin_validateMinorServingValues_(valuesByPosition, membersById, positionsToCheck){
  const values = valuesByPosition || {};
  const byId = membersById || {};
  const selected = Array.isArray(positionsToCheck) ? positionsToCheck : ADMIN_SERVING_POSITIONS;
  const errors = [];
  const warnings = [];
  selected.forEach(function(position){
    const group = admin_normalizeServingGroup_(ADMIN_SERVING_POSITION_GROUP[position] || '');
    const ids = admin_extractMemberIdsFromServingValue_(String(values[position] || ''));
    const members = ids.map(function(id){ return byId[id] || null; }).filter(Boolean);
    const minors = members.filter(function(m){ return !!m.isMinor; });
    if (!minors.length) return;
    const adults = members.filter(function(m){
      return !m.isMinor && admin_normStatus_(m.status) !== 'DISABLED';
    });
    minors.forEach(function(minor){
      const eligibility = admin_minorServingEligibility_(minor, group);
      if (!eligibility.ok){
        errors.push({
          memberId:minor.id,
          position:position,
          code:eligibility.subCode || eligibility.code || 'MINOR_NOT_ELIGIBLE',
          zh:eligibility.zh,
          en:eligibility.en
        });
        return;
      }
      if (!adults.length){
        errors.push({
          memberId:minor.id,
          position:position,
          code:'MINOR_ADULT_PAIR_REQUIRED',
          zh:'未成年事奉者必須在同一崗位與成年同工一同服侍',
          en:'A young volunteer must be paired with an adult in the same position.'
        });
        return;
      }
      const familyId = String(minor.familyId || '').trim();
      const sameFamilyAdults = familyId ? adults.filter(function(adult){ return String(adult.familyId || '').trim() === familyId; }) : [];
      if (!sameFamilyAdults.length){
        warnings.push({
          memberId:minor.id,
          position:position,
          adultIds:adults.map(function(adult){ return adult.id; }),
          code:'MINOR_DIFFERENT_FAMILY_ADULT',
          zh:'未有同一家庭成人安排；已由其他成年同工配對',
          en:'No adult from the same family is assigned; paired with another adult volunteer.'
        });
      }
    });
  });
  return { ok:errors.length === 0, errors:errors, warnings:warnings };
}
function admin_servingGroupLabelText_(groupKey){
  const key = admin_normalizeServingGroup_(groupKey);
  const label = ADMIN_SERVING_GROUP_LABELS[key] || { zh:key||'', en:key||'' };
  return (label.zh && label.en) ? (label.zh + ' / ' + label.en) : (label.zh || label.en || key || '');
}

function admin_memberHasAdminStatus_(memberId, membersById){
  const map = membersById || {};
  const id = String(memberId||'').trim().toUpperCase();
  if (!id) return false;
  const m = map[id] || null;
  if (!m) return false;
  const st = String(m.status || '').trim().toUpperCase();
  return admin_isAdminStatus_(st);
}
function admin_getAwayPeriodForMember_(memberId){
  const mi = admin_getMembersIndex_();
  const id = String(memberId||'').trim().toUpperCase();
  const m = mi.byId[id];
  if (!m) return { periods: [], fromYmd:'', toYmd:'', from2Ymd:'', to2Ymd:'' };
  const p1 = admin_normalizeAwayPeriod_(m.awayFrom1, m.awayTo1);
  const p2 = admin_normalizeAwayPeriod_(m.awayFrom2, m.awayTo2);
  const periods = [p1, p2].filter(p => p.fromYmd || p.toYmd);
  return {
    periods: periods,
    fromYmd: p1.fromYmd || '',
    toYmd: p1.toYmd || '',
    from2Ymd: p2.fromYmd || '',
    to2Ymd: p2.toYmd || ''
  };
}
function admin_getAwayPeriodsMap_(memberIds){
  const out = {};
  const ids = Array.isArray(memberIds) ? memberIds.map(x => String(x||'').trim().toUpperCase()).filter(Boolean) : [];
  if (!ids.length) return out;
  const mi = admin_getMembersIndex_();
  ids.forEach(function(id){
    const m = mi.byId[id];
    if (!m) return;
    const p1 = admin_normalizeAwayPeriod_(m.awayFrom1, m.awayTo1);
    const p2 = admin_normalizeAwayPeriod_(m.awayFrom2, m.awayTo2);
    out[id] = {
      periods: [p1, p2].filter(p => p.fromYmd || p.toYmd)
    };
  });
  return out;
}
function admin_getServingInsightsForMember_(memberId){
  const id = String(memberId||'').trim().toUpperCase();
  const out = { byGroup:{}, currentMembersByGroup:{} };
  if (!id) return out;

  const mi = admin_getMembersIndex_();
  const allMembers = (mi && mi.all) ? mi.all : [];
  const groups = ['worship','media','logistic','support','finance'];

  groups.forEach(function(groupKey){
    const list = allMembers.filter(function(m){ return admin_memberHasServingGroup_(m, groupKey); })
      .map(admin_memberLabelCompact_)
      .sort(function(a,b){ return String(a.label||'').localeCompare(String(b.label||'')); });
    out.currentMembersByGroup[groupKey] = list;
    out.byGroup[groupKey] = {
      group: groupKey,
      summary: [],
      historical: [],
      upcoming: [],
      gaps: []
    };
  });

  const sh = admin_getServingSheet_();
  if (!sh) return out;
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return out;

  const matrix = admin_getServingMatrix_(sh);
  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const today = admin_parseYmd_(admin_todayUkYmd_()) || new Date();

  const summaryMap = {};
  const historicalByGroup = {};
  const upcomingByGroup = {};
  const gapsByGroupEvent = {};
  const soon12w = new Date(today.getTime() + (84 * 24 * 60 * 60 * 1000));

  rows.forEach(function(row){
    const eventKey = String(row[0] || '').trim();
    if (!eventKey) return;
    const evDate = admin_eventDateFromKey_(eventKey);
    const dateYmd = evDate ? admin_fmtYmd_(evDate) : '';

    matrix.positions.forEach(function(pos){
      if (!pos || !pos.colIndex) return;
      const groupKey = admin_normalizeServingGroup_(pos.group);
      if (!groupKey || !out.byGroup[groupKey]) return;
      const raw = String(row[pos.colIndex - 1] || '').trim();
      if (admin_isServingClosedValue_(raw)) return;
      const ids = raw ? admin_extractMemberIdsFromServingValue_(raw) : [];
      const filledSlots = admin_countServingFilledSlots_(raw);

      const minRequired = admin_servingMinRequired_(pos.position);
      const missing = Math.max(0, minRequired - filledSlots);
      if (missing > 0 && evDate && evDate.getTime() >= today.getTime() && evDate.getTime() <= soon12w.getTime()){
        const gk = groupKey + '::' + eventKey;
        if (!gapsByGroupEvent[gk]){
          gapsByGroupEvent[gk] = {
            group: groupKey,
            eventKey: eventKey,
            dateYmd: dateYmd,
            totalMissing: 0,
            positions: []
          };
        }
        gapsByGroupEvent[gk].totalMissing += missing;
        gapsByGroupEvent[gk].positions.push({
          position: String(pos.position||''),
          label: admin_servingPositionZh_(String(pos.position||'')),
          missing: missing,
          assigned: filledSlots,
          minRequired: minRequired
        });
      }

      if (!ids || ids.indexOf(id) < 0) return;

      const position = String(pos.position||'').trim();
      const sKey = groupKey + '::' + position;
      if (evDate && evDate.getTime() < today.getTime()){
        if (!summaryMap[sKey]){
          summaryMap[sKey] = {
            group: groupKey,
            position: position,
            label: admin_servingPositionLabel_(position),
            count: 0
          };
        }
        summaryMap[sKey].count += 1;
      }

      const entry = {
        eventKey: eventKey,
        dateYmd: dateYmd,
        position: position,
        label: admin_servingPositionLabel_(position)
      };
      if (evDate && evDate.getTime() >= today.getTime()){
        if (!upcomingByGroup[groupKey]) upcomingByGroup[groupKey] = [];
        upcomingByGroup[groupKey].push(entry);
      } else {
        if (!historicalByGroup[groupKey]) historicalByGroup[groupKey] = [];
        historicalByGroup[groupKey].push(entry);
      }
    });
  });

  for (const key in summaryMap){
    const item = summaryMap[key];
    if (!item || !out.byGroup[item.group]) continue;
    out.byGroup[item.group].summary.push(item);
  }

  for (const groupKey in out.byGroup){
    const bucket = out.byGroup[groupKey];
    bucket.summary.sort(function(a,b){
      if (a.count !== b.count) return b.count - a.count;
      return String(a.position||'').localeCompare(String(b.position||''));
    });

    const past = historicalByGroup[groupKey] || [];
    past.sort(function(a,b){ return String(b.dateYmd||'').localeCompare(String(a.dateYmd||'')); });
    bucket.historical = past;

    const future = upcomingByGroup[groupKey] || [];
    future.sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); });
    bucket.upcoming = future;

    bucket.gaps = Object.keys(gapsByGroupEvent).map(function(k){ return gapsByGroupEvent[k]; })
      .filter(function(item){ return item.group === groupKey; })
      .sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); });
  }

  return out;
}
function admin_buildServingGroupOverview_(fromYmd){
  const out = { byGroup:{} };
  const groups = ['worship','media','logistic','support','finance'];
  const mi = admin_getMembersIndex_();
  const byId = (mi && mi.byId) ? mi.byId : {};
  const allMembers = (mi && mi.all) ? mi.all : [];
  groups.forEach(function(groupKey){
    const current = allMembers
      .filter(function(m){ return admin_memberHasServingGroup_(m, groupKey); })
      .map(admin_memberLabelCompact_)
      .sort(function(a,b){ return String(a.label||'').localeCompare(String(b.label||'')); });
    out.byGroup[groupKey] = {
      group: groupKey,
      currentMembers: current,
      gaps: [],
      activity:{ top:[], bottom:[], windowDays:ADMIN_ACTIVITY_WINDOW_DAYS },
      upcomingChildren:[],
      previous:[],
      upcoming:[]
    };
  });

  const sh = admin_getServingSheet_();
  if (!sh) return out;
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return out;

  const matrix = admin_getServingMatrix_(sh);
  const rows = sh.getRange(2,1,lastRow-1,lastCol).getValues();
  const today = admin_parseYmd_(fromYmd) || admin_parseYmd_(admin_todayUkYmd_()) || new Date();
  const soon12w = new Date(today.getTime() + (84 * 24 * 60 * 60 * 1000));
  const logisticsEnd = new Date(today.getTime() + (ADMIN_LOGISTICS_DASHBOARD_DAYS * 24 * 60 * 60 * 1000));
  const activityStart = new Date(today.getTime() - (ADMIN_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  const gapMap = {};
  const logisticActivity = {};
  (out.byGroup.logistic.currentMembers || []).forEach(function(m){
    logisticActivity[m.id] = { member:m, count:0, lastDateYmd:'' };
  });

  rows.forEach(function(row){
    const eventKey = String(row[0]||'').trim();
    if (!eventKey) return;
    const evDate = admin_eventDateFromKey_(eventKey);
    if (!evDate) return;
    const dateYmd = admin_fmtYmd_(evDate);
    matrix.positions.forEach(function(pos){
      if (!pos || !pos.colIndex) return;
      const groupKey = admin_normalizeServingGroup_(pos.group);
      if (!groupKey || !out.byGroup[groupKey]) return;
      const raw = String(row[pos.colIndex - 1] || '').trim();
      if (admin_isServingClosedValue_(raw)) return;
      const ids = raw ? admin_extractMemberIdsFromServingValue_(raw) : [];
      const members = ids.map(function(id){ return byId[id] || null; }).filter(Boolean);
      const entryBase = {
        eventKey:eventKey,
        dateYmd:dateYmd,
        position:String(pos.position||''),
        label:admin_servingPositionLabel_(String(pos.position||''))
      };
      ids.forEach(function(id){
        const member = byId[id] || { id:id };
        const compact = admin_memberLabelCompact_(member);
        const entry = Object.assign({}, entryBase, {
          memberId:id,
          name:compact.name,
          nameZh:compact.nameZh,
          nameEn:compact.nameEn,
          preferredName:compact.preferredName,
          isMinor:!!member.isMinor,
          familyId:String(member.familyId||'')
        });
        if (evDate.getTime() < today.getTime() && evDate.getTime() >= activityStart.getTime()){
          out.byGroup[groupKey].previous.push(entry);
        }else if (evDate.getTime() >= today.getTime() && evDate.getTime() <= (groupKey === 'logistic' ? logisticsEnd.getTime() : soon12w.getTime())){
          out.byGroup[groupKey].upcoming.push(entry);
        }
        if (groupKey === 'logistic' && evDate.getTime() < today.getTime() && evDate.getTime() >= activityStart.getTime() && logisticActivity[id]){
          logisticActivity[id].count += 1;
          if (!logisticActivity[id].lastDateYmd || dateYmd > logisticActivity[id].lastDateYmd) logisticActivity[id].lastDateYmd = dateYmd;
        }
      });

      if (groupKey === 'logistic' && evDate.getTime() >= today.getTime() && evDate.getTime() <= logisticsEnd.getTime()){
        const adults = members.filter(function(m){ return !m.isMinor && admin_normStatus_(m.status) !== 'DISABLED'; });
        members.filter(function(m){ return !!m.isMinor; }).forEach(function(child){
          const familyId = String(child.familyId || '').trim();
          const sameFamily = !!familyId && adults.some(function(adult){ return String(adult.familyId || '').trim() === familyId; });
          const compact = admin_memberLabelCompact_(child);
          out.byGroup.logistic.upcomingChildren.push({
            eventKey:eventKey,
            dateYmd:dateYmd,
            position:String(pos.position||''),
            label:admin_servingPositionLabel_(String(pos.position||'')),
            memberId:child.id,
            name:compact.name,
            nameZh:compact.nameZh,
            nameEn:compact.nameEn,
            preferredName:compact.preferredName,
            familyId:familyId,
            adultIds:adults.map(function(adult){ return adult.id; }),
            adultLabels:adults.map(function(adult){ return admin_memberLabelCompact_(adult).label; }),
            pairedAdult:adults.length > 0,
            sameFamilyAdult:sameFamily
          });
        });
      }

      const gapEnd = (groupKey === 'logistic') ? logisticsEnd : soon12w;
      if (evDate.getTime() < today.getTime() || evDate.getTime() > gapEnd.getTime()) return;
      const filledSlots = admin_countServingFilledSlots_(raw);
      const minRequired = admin_servingMinRequired_(pos.position);
      let missing = Math.max(0, minRequired - filledSlots);
      let pairingMissing = false;
      if (groupKey === 'logistic'){
        const hasMinor = members.some(function(m){ return !!m.isMinor; });
        const hasAdult = members.some(function(m){ return !m.isMinor && admin_normStatus_(m.status) !== 'DISABLED'; });
        if (hasMinor && !hasAdult){
          pairingMissing = true;
          missing = Math.max(1, missing);
        }
      }
      if (missing <= 0) return;
      const key = groupKey + '::' + eventKey;
      if (!gapMap[key]){
        gapMap[key] = { group: groupKey, eventKey:eventKey, dateYmd:dateYmd, totalMissing:0, positions:[] };
      }
      gapMap[key].totalMissing += missing;
      gapMap[key].positions.push({ position:String(pos.position||''), label:admin_servingPositionLabel_(String(pos.position||'')), missing:missing, assigned:filledSlots, minRequired:minRequired, pairingMissing:pairingMissing });
    });
  });

  for (const k in gapMap){
    const it = gapMap[k];
    if (!it || !out.byGroup[it.group]) continue;
    out.byGroup[it.group].gaps.push(it);
  }
  for (const g in out.byGroup){
    out.byGroup[g].gaps.sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); });
    out.byGroup[g].previous.sort(function(a,b){ return String(b.dateYmd||'').localeCompare(String(a.dateYmd||'')); });
    out.byGroup[g].upcoming.sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); });
  }
  const activityRows = Object.keys(logisticActivity).map(function(id){
    const row = logisticActivity[id];
    return {
      memberId:id,
      label:row.member.label,
      name:row.member.name,
      isMinor:!!row.member.isMinor,
      count:row.count,
      lastDateYmd:row.lastDateYmd
    };
  });
  out.byGroup.logistic.activity.top = activityRows.slice().sort(function(a,b){
    return (b.count - a.count) || String(b.lastDateYmd||'').localeCompare(String(a.lastDateYmd||'')) || String(a.label||'').localeCompare(String(b.label||''));
  }).slice(0,3);
  out.byGroup.logistic.activity.bottom = activityRows.slice().sort(function(a,b){
    return (a.count - b.count) || String(a.lastDateYmd||'').localeCompare(String(b.lastDateYmd||'')) || String(a.label||'').localeCompare(String(b.label||''));
  }).slice(0,3);
  out.byGroup.logistic.upcomingChildren.sort(function(a,b){
    return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')) || String(a.position||'').localeCompare(String(b.position||'')) || String(a.memberId||'').localeCompare(String(b.memberId||''));
  });
  return out;
}
function admin_servingHeaderLabel_(key){
  const label = ADMIN_SERVING_POSITION_LABELS[key];
  if (!label) return key;
  return key + ' / ' + label.zh + ' / ' + label.en;
}
function admin_servingLabelToKeyMap_(){
  const map = {};
  ADMIN_SERVING_POSITIONS.forEach(function(k){
    const label = ADMIN_SERVING_POSITION_LABELS[k];
    if (label){
      map[label.zh] = k;
      map[label.en] = k;
    }
  });
  return map;
}
const ADMIN_SERVING_LABEL_TO_KEY = admin_servingLabelToKeyMap_();
const ADMIN_SERVING_LEGACY_KEY_ALIAS = {
  Worship_Singer_1: 'Worship_Singer',
  Worship_Singer_2: 'Worship_Singer',
  Worship_Instrument_1: 'Worship_Instrument',
  Worship_Instrument_2: 'Worship_Instrument'
};
function admin_extractServingKey_(header){
  const raw = String(header||'').trim();
  if (!raw) return '';
  if (ADMIN_SERVING_POSITIONS.indexOf(raw) >= 0) return raw;
  if (ADMIN_SERVING_LEGACY_KEY_ALIAS[raw]) return ADMIN_SERVING_LEGACY_KEY_ALIAS[raw];
  const slash = raw.split('/');
  const first = String(slash[0]||'').trim();
  if (ADMIN_SERVING_POSITIONS.indexOf(first) >= 0) return first;
  if (ADMIN_SERVING_LEGACY_KEY_ALIAS[first]) return ADMIN_SERVING_LEGACY_KEY_ALIAS[first];
  const byLabel = ADMIN_SERVING_LABEL_TO_KEY[raw];
  if (byLabel) return byLabel;
  for (const key in ADMIN_SERVING_LABEL_TO_KEY){
    if (raw.indexOf(key) >= 0) return ADMIN_SERVING_LABEL_TO_KEY[key];
  }
  return raw;
}
function admin_splitServingValues_(raw){
  const s = String(raw||'').trim();
  if (!s) return [];
  return s.split(',').map(x => String(x||'').trim()).filter(Boolean);
}

function admin_extractCanonicalMemberId_(text){
  const s = String(text || '').trim().toUpperCase();
  if (!s) return '';
  const m = s.match(/\bCCF(?:\s*ID)?\s*[-: ]?(\d{4})\b/i);
  return m ? ('CCF' + m[1]) : '';
}

function admin_normalizeServingToken_(token){
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (admin_isServingClosedValue_(raw)) return 'CLOSED';
  if (admin_isServingNaValue_(raw)) return 'N/A';

  const canonicalId = admin_extractCanonicalMemberId_(raw);
  if (canonicalId) return canonicalId;

  return raw;
}

function admin_normalizeServingValue_(raw, maxSlots){
  const s = String(raw || '').trim();
  if (!s) return '';
  if (admin_isServingClosedValue_(s)) return 'CLOSED';

  const normalized = admin_splitServingValues_(s)
    .map(admin_normalizeServingToken_)
    .filter(Boolean);

  const max = Math.max(1, Number(maxSlots || 1));
  return normalized.slice(0, max).join(', ');
}

function admin_countServingFilledSlots_(raw){
  return admin_splitServingValues_(raw).filter(function(v){
    const token = String(v||'').trim();
    if (!token) return false;
    if (admin_isServingClosedValue_(token)) return false;
    if (admin_isServingNaValue_(token)) return false;
    return true;
  }).length;
}

function admin_extractMemberIdsFromServingValue_(raw){
  return admin_splitServingValues_(raw).map(function(v){
    const token = String(v||'').trim();
    if (!token) return '';
    if (admin_isServingNaValue_(token)) return '';
    if (admin_isServingClosedValue_(token)) return '';
    return admin_extractCanonicalMemberId_(token);
  }).filter(Boolean);
}
function admin_normalizeServingGroup_(g){
  const key = String(g||'').trim().toUpperCase();
  if (key === 'WORSHIP') return 'worship';
  if (key === 'MEDIA') return 'media';
  if (key === 'LOGISTIC') return 'logistic';
  if (key === 'SUPPORT') return 'support';
  if (key === 'FINANCE') return 'finance';
  return '';
}
function admin_memberHasServingGroup_(member, groupKey){
  if (!groupKey || groupKey === 'other') return true;
  if (!member) return false;
  const groups = (member.servingGroups || []).concat(member.servingGLGroups || []);
  return groups.some(function(g){ return admin_normalizeServingGroup_(g) === groupKey; });
}
function admin_checkServingAwayConflicts_(eventDate, rows){
  const out = [];
  if (!eventDate) return out;
  const ids = rows.map(r => String(r.memberId||'').trim().toUpperCase()).filter(Boolean);
  const map = admin_getAwayPeriodsMap_(ids);
  for (const r of rows){
    const id = String(r.memberId||'').trim().toUpperCase();
    if (!id) continue;
    if (admin_isServingNaValue_(id)) continue;
    const away = map[id];
    if (!away || !away.periods || !away.periods.length) continue;
    away.periods.forEach(function(p){
      if (!p.fromYmd || !p.toYmd) return;
      const from = admin_parseYmd_(p.fromYmd);
      const to = admin_parseYmd_(p.toYmd);
      if (!from || !to) return;
      if (eventDate.getTime() >= from.getTime() && eventDate.getTime() <= to.getTime()){
        out.push({ memberId: id, from: p.fromYmd, to: p.toYmd });
      }
    });
  }
  return out;
}
function admin_getServingMatrix_(sh){
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const headerMap = {};
  for (let i=1;i<headers.length;i++){
    const key = admin_extractServingKey_(headers[i]);
    if (key) headerMap[key] = i + 1;
  }
  const positions = ADMIN_SERVING_POSITIONS.map(function(key){
    return {
      colIndex: headerMap[key] || null,
      key: key,
      group: ADMIN_SERVING_POSITION_GROUP[key] || '',
      position: key
    };
  });
  return { eventCol: 1, positions: positions };
}
function admin_getServingMatrixHeaderMap_(sh){
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const map = {};
  for (let i=1;i<headers.length;i++){
    const key = admin_extractServingKey_(headers[i]);
    if (key) map[key] = i + 1;
  }
  return map;
}
function admin_makeServingHeaderKey_(group, position){
  const g = String(group||'').trim().toUpperCase();
  const p = String(position||'').trim();
  if (g && p) return g + '::' + p;
  if (p) return p;
  return g || '';
}
function admin_parseServingHeader_(header){
  const raw = String(header||'').trim();
  if (!raw) return { group:'', position:'' };
  return { group:'', position: raw };
}
function admin_findServingEventRowIndex_(sh, eventKey){
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i=0;i<values.length;i++){
    if (String(values[i][0]||'').trim() === eventKey) return i + 2;
  }
  return null;
}
function admin_getServingEventRowLookup_(sh){
  const lastRow = sh.getLastRow();
  const byEvent = {};
  if (lastRow < 2) return byEvent;
  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i=0;i<values.length;i++){
    const eventKey = String(values[i][0]||'').trim();
    if (!eventKey) continue;
    byEvent[eventKey] = i + 2;
  }
  return byEvent;
}
function admin_isServingNaValue_(value){
  const v = String(value || '').trim().toUpperCase();
  return (v === 'N/A' || v === 'NA');
}
function admin_isServingClosedValue_(value){
  const v = String(value || '').trim().toUpperCase();
  if (!v) return false;
  return (v === 'CLOSED' || v === '__CLOSED__' || v.indexOf('CLOSED') === 0);
}
function admin_isServingNaRow_(row){
  return admin_isServingNaValue_(row.position) || admin_isServingNaValue_(row.slot) || admin_isServingNaValue_(row.memberId);
}
function admin_getServingForEvent_(eventKey, membersById, checkedInSet, includeNa){
  const sh = admin_getServingSheet_();
  if (!sh) return [];
  const rowIndex = admin_findServingEventRowIndex_(sh, eventKey);
  if (!rowIndex) return [];

  const lastCol = sh.getLastColumn();
  if (lastCol < 2) return [];
  const matrix = admin_getServingMatrix_(sh);
  const row = sh.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  const out = [];

  matrix.positions.forEach(function(pos){
    if (!pos.colIndex) return;
    const raw = String(row[pos.colIndex-1] || '').trim();
    const values = raw ? admin_splitServingValues_(raw) : [];
    values.forEach(function(val, valueIdx){
      const token = String(val||'').trim();
      const canonicalId = admin_extractCanonicalMemberId_(token);
      const entry = {
        eventKey: eventKey,
        group: pos.group,
        position: pos.position,
        slot: String(valueIdx + 1),
        memberId: canonicalId || '',
        rawValue: token,
        checkedIn: !!canonicalId && checkedInSet && checkedInSet.has(canonicalId)
      };
      if (!includeNa && admin_isServingNaValue_(token)) return;
      const m = canonicalId ? (membersById[canonicalId] || {}) : {};
      entry.nameZh = String(m.nameZh || '');
      entry.nameEn = String(m.nameEn || '');
      entry.preferredName = String(m.preferredName || '');
      entry.isMinor = !!m.isMinor;
      entry.familyId = String(m.familyId || '');
      out.push(entry);
    });

    const maxSlots = Number(ADMIN_SERVING_POSITION_MAX[pos.position] || 1);
    if (!maxSlots || maxSlots <= 0) return;
    for (let slotIdx = values.length; slotIdx < maxSlots; slotIdx++){
      out.push({
        eventKey: eventKey,
        group: pos.group,
        position: pos.position,
        slot: String(slotIdx + 1),
        memberId: '',
        rawValue: '',
        checkedIn: false,
        nameZh: '',
        nameEn: '',
        preferredName: '',
        isMinor: false,
        familyId: ''
      });
    }
  });

  out.sort((a,b)=>{
    const g = String(a.group||'').localeCompare(String(b.group||''));
    if (g !== 0) return g;
    const p = String(a.position||'').localeCompare(String(b.position||''));
    if (p !== 0) return p;
    const s = Number(a.slot || 0) - Number(b.slot || 0);
    if (s !== 0) return s;
    return String(a.memberId||'').localeCompare(String(b.memberId||''));
  });
  return out;
}
function admin_getServingValuesForEvent_(eventKey){
  const sh = admin_getServingSheet_();
  if (!sh) return {};
  const rowIndex = admin_findServingEventRowIndex_(sh, eventKey);
  if (!rowIndex) return {};
  const lastCol = sh.getLastColumn();
  if (lastCol < 2) return {};
  const row = sh.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(v => String(v||'').trim());
  const out = {};
  for (let i=1;i<headers.length;i++){
    const key = admin_extractServingKey_(headers[i]);
    if (!key) continue;
    out[key] = String(row[i] || '').trim();
  }
  return out;
}
function admin_getDuplicatePositionMapFromValues_(valuesByPos){
  const map = {};
  const vals = valuesByPos || {};
  ADMIN_SERVING_POSITIONS.forEach(function(pos){
    const raw = String(vals[pos] || '').trim();
    if (!raw) return;
    const ids = admin_extractMemberIdsFromServingValue_(raw);
    ids.forEach(function(id){
      if (!map[id]) map[id] = [];
      map[id].push(pos);
    });
  });
  const out = {};
  for (const id in map){
    const arr = admin_filterDuplicateConflictPositions_(map[id] || []);
    if (arr.length <= 1) continue;
    out[id] = arr.slice().sort();
  }
  return out;
}

function admin_normalizeServingSheetData_(){
  const sh = admin_getServingSheet_();
  if (!sh) return { ok:true, rows:0, changedCells:0 };

  admin_ensureServingHeaders_(sh);

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return { ok:true, rows:0, changedCells:0 };

  const headerMap = admin_getServingMatrixHeaderMap_(sh);
  const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  let changedCells = 0;

  data.forEach(function(row){
    ADMIN_SERVING_POSITIONS.forEach(function(pos){
      const colIdx = headerMap[pos];
      if (!colIdx) return;

      const oldVal = String(row[colIdx - 1] || '').trim();
      const newVal = admin_normalizeServingValue_(
        oldVal,
        ADMIN_SERVING_POSITION_MAX[pos] || 1
      );

      if (newVal !== oldVal){
        row[colIdx - 1] = newVal;
        changedCells++;
      }
    });
  });

  if (changedCells > 0){
    sh.getRange(2, 1, data.length, lastCol).setValues(data);
  }

  return { ok:true, rows:data.length, changedCells:changedCells };
}

function admin_getServingPlanMatrix_(events){
  const eventList = Array.isArray(events) ? events : [];
  const eventKeys = eventList.map(e => e.eventKey);
  const cells = {};
  eventKeys.forEach(ev => { cells[ev] = {}; });

  const sh = admin_getServingSheet_();
  if (!sh){
    return { events: eventList, positions: [], cells: cells };
  }
  const lastRow = sh.getLastRow();
  if (lastRow < 2){
    return { events: eventList, positions: [], cells: cells };
  }

  const matrix = admin_getServingMatrix_(sh);
  const lastCol = sh.getLastColumn();
  if (lastCol < 2){
    return { events: eventList, positions: [], cells: cells };
  }
  const positions = matrix.positions.map(function(pos){
    return { key: pos.key, group: pos.group, position: pos.position };
  });

  const mi = admin_getMembersIndex_();
  const byId = (mi && mi.byId) ? mi.byId : {};
  const rowLookup = admin_getServingEventRowLookup_(sh);

  const targetRows = [];
  const targetEvents = [];
  eventKeys.forEach(function(ev){
    const rowIndex = rowLookup[ev] || null;
    if (!rowIndex) return;
    targetRows.push(rowIndex);
    targetEvents.push(ev);
  });

  if (!targetRows.length){
    return { events: eventList, positions: positions, cells: cells };
  }

  const minRow = Math.min.apply(null, targetRows);
  const maxRow = Math.max.apply(null, targetRows);
  const block = sh.getRange(minRow, 1, maxRow - minRow + 1, lastCol).getValues();
  const rowValuesByIndex = {};
  for (let i=0;i<block.length;i++){
    rowValuesByIndex[minRow + i] = block[i];
  }

  targetEvents.forEach(function(ev){
    const rowIndex = rowLookup[ev] || null;
    if (!rowIndex) return;
    const row = rowValuesByIndex[rowIndex] || null;
    if (!row) return;
    matrix.positions.forEach(function(pos){
      if (!pos.colIndex) return;
      const raw = String(row[pos.colIndex-1] || '').trim();
      if (!raw) return;
      const values = admin_splitServingValues_(raw);
      values.forEach(function(val){
        const token = String(val||'').trim();
        const canonicalId = admin_extractCanonicalMemberId_(token);
        const member = canonicalId ? (byId[canonicalId] || {}) : {};
        const entry = {
          memberId: canonicalId || '',
          rawValue: token,
          nameZh: String(member.nameZh || ''),
          nameEn: String(member.nameEn || ''),
          preferredName: String(member.preferredName || ''),
          isMinor: !!member.isMinor,
          familyId: String(member.familyId || ''),
          slot: ''
        };
        if (!cells[ev][pos.key]) cells[ev][pos.key] = [];
        cells[ev][pos.key].push(entry);
      });
    });
  });

  return { events: eventList, positions: positions, cells: cells };
}

// Bypass code from Script Properties
function admin_getBypassCode_(){
  try{
    const p = PropertiesService.getScriptProperties();
    return String(p.getProperty('ADMIN_BYPASS_CODE') || '').trim();
  }catch(e){
    return '';
  }
}

// Sessions
function admin_newSession_(actor){
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(
    ADMIN_SESSION_PREFIX + token,
    JSON.stringify({ actor: actor, createdAt: Date.now() }),
    ADMIN_SESSION_TTL_SECONDS
  );
  return token;
}
function admin_getSession_(token){
  const t = String(token||'').trim();
  if (!t) return null;
  const raw = CacheService.getScriptCache().get(ADMIN_SESSION_PREFIX + t);
  if (!raw) return null;
  CacheService.getScriptCache().put(ADMIN_SESSION_PREFIX + t, raw, ADMIN_SESSION_TTL_SECONDS);
  try { return JSON.parse(raw); } catch(e){ return null; }
}
function admin_requireSession_(token){
  const sess = admin_getSession_(token);
  if (!sess || !sess.actor) return admin_err_('E401','登入已過期，請重新登入','Session expired. Please login again.');
  return { ok:true, actor: sess.actor };
}
function admin_requireNonGl_(actor){
  const role = String(actor.role||'').trim().toUpperCase();
  if (role === 'GL'){
    return admin_err_('E403','群組長模式只限事奉功能','GL mode is serving-only.');
  }
  return null;
}

// Audit logging
function admin_audit_(actor, action, details, context){
  try{
    const ss = admin_openSs_();
    let sh = ss.getSheetByName(ADMIN_AUDIT_SHEET_NAME);
    if (!sh){
      sh = ss.insertSheet(ADMIN_AUDIT_SHEET_NAME);
      sh.appendRow(['Timestamp','ActorId','ActorRole','Action','Details','Context']);
      sh.getRange(1,1,1,6).setFontWeight('bold');
    }
    sh.appendRow([new Date(), String(actor.id||''), String(actor.role||''), String(action||''), String(details||''), String(context||'')]);
  }catch(e){}
}

// Date helpers (UTC midnight strings)
function admin_safeToDate_(v){
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function admin_parseYmd_(s){
  const v = String(s||'').trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10)));
  return isNaN(d.getTime()) ? null : d;
}
function admin_fmtYmd_(d){
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth()+1).padStart(2,'0');
  const dd = String(d.getUTCDate()).padStart(2,'0');
  return yyyy + '-' + mm + '-' + dd;
}
function admin_fmtYm_(d){
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth()+1).padStart(2,'0');
  return yyyy + '-' + mm;
}
function admin_daysBetween_(from, to){
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (24*60*60*1000));
}

// Range validation
function admin_validateRange_(actor, fromDate, toDate){
  const from = admin_parseYmd_(fromDate);
  const to = admin_parseYmd_(toDate);
  if (!from || !to){
    return admin_err_('E422','日期格式錯誤（YYYY-MM-DD）','Invalid date format (YYYY-MM-DD).');
  }
  if (to.getTime() < from.getTime()){
    return admin_err_('E423','結束日期不可早於開始日期','End date cannot be before start date.');
  }
  const days = admin_daysBetween_(from, to) + 1;
  const isAdmin = admin_isAdminActorRole_(actor.role);
  const maxDays = isAdmin ? ADMIN_MAX_DAYS_ADMIN : ADMIN_MAX_DAYS_STAFF;
  if (days > maxDays){
    return admin_err_('E424','所選日期範圍過長（最多 ' + maxDays + ' 日）','Date range too long (max ' + maxDays + ' days).');
  }
  return { ok:true, from: from, to: to, days: days };
}

// SundayService helpers
function admin_isSundayServiceKey_(ev){
  return /^SundayService_\d{4}-\d{2}-\d{2}$/.test(String(ev||'').trim());
}
function admin_eventDateFromKey_(ev){
  const s = String(ev||'').trim();
  const m = s.match(/^SundayService_(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10)));
  return isNaN(d.getTime()) ? null : d;
}
function admin_parseDmyToYmd_(dmy){
  const s = String(dmy||'').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  return m[3] + '-' + m[2] + '-' + m[1];
}

// QR parsing
function admin_parseQrStrict_(raw){
  const s = String(raw||'').trim();
  const parts = s.split('|');
  if (parts.length !== 2) return admin_err_('E416','QR 格式錯誤','Invalid QR format.');

  const id = String(parts[0]||'').trim().toUpperCase();
  const key = String(parts[1]||'').trim();

  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');
  if (!key || !/^k.+/.test(key)) return admin_err_('E416','QR Key 格式錯誤','Invalid QR key.');

  return { ok:true, id:id, key:key };
}

// Members sheet + col map
function admin_findMembersSheet_(){
  const ss = admin_openSs_();
  const sheets = ss.getSheets();
  for (const s of sheets){
    const lastCol = s.getLastColumn();
    if (lastCol < ADMIN_MEMBERS_HEADERS_REQUIRED.length) continue;
    const headers = s.getRange(1,1,1,lastCol).getValues()[0].map(v => String(v||'').trim());
    const headerSet = new Set(headers);
    const matches = ADMIN_MEMBERS_HEADERS_REQUIRED.every(h => headerSet.has(h));
    if (matches) return s;
  }
  return null;
}
function admin_debug_members_sheet_pick_(){
  const selected = admin_findMembersSheet_();
  const selectedName = selected ? selected.getName() : '';
  const ss = admin_openSs_();
  return ss.getSheets().map(function(s){
    const lastCol = s.getLastColumn();
    const headers = s.getRange(1,1,1,lastCol).getValues()[0].map(v => String(v||'').trim());
    const headerSet = new Set(headers);
    return {
      sheet: s.getName(),
      isSelectedMembersSheet: (s.getName() === selectedName),
      hasAllRequiredAnywhere: ADMIN_MEMBERS_HEADERS_REQUIRED.every(h => headerSet.has(h)),
      colMap: ['ID','Status','ServingGroups','ServingGLGroups','Email','Mobile'].reduce(function(acc, h){
        acc[h] = headers.indexOf(h);
        return acc;
      }, {})
    };
  });
}
function admin_debug_member_cache_record_(memberId){
  const id = String(memberId || 'CCF0104').trim().toUpperCase();
  const mi = admin_getMembersIndex_();
  const m = mi && mi.byId ? mi.byId[id] : null;
  return {
    id: id,
    found: !!m,
    statusRaw: m ? String(m.status || '') : '',
    statusNormalized: m ? admin_normStatus_(m.status || '') : '',
    servingGroups: m ? (Array.isArray(m.servingGroups) ? m.servingGroups : []) : [],
    servingGLGroups: m ? (Array.isArray(m.servingGLGroups) ? m.servingGLGroups : []) : [],
    key: m ? String(m.key || '') : '',
    roleExpires: m ? String(m.roleExpires || '') : ''
  };
}
function admin_getMembersColMap_(sh){
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const col = {};
  headers.forEach((h,i)=>{ col[h]=i; });
  return col;
}
function admin_findMemberRowById_(sh, col, id){
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const values = sh.getRange(2, col.ID+1, lastRow-1, 1).getValues();
  for (let i=0;i<values.length;i++){
    const v = String(values[i][0]||'').trim().toUpperCase();
    if (v === id) return i+2;
  }
  return null;
}
function admin_ensureRoleExpiresColumn_(sh, col){
  if (col.RoleExpires !== undefined) return col.RoleExpires;
  const lastCol = sh.getLastColumn();
  sh.insertColumnAfter(lastCol);
  const newCol = lastCol + 1;
  sh.getRange(1, newCol).setValue('RoleExpires').setFontWeight('bold');
  col.RoleExpires = newCol - 1;
  return col.RoleExpires;
}
function admin_ensureAwayColumns_(sh, col){
  const fields = ['AwayFrom1','AwayTo1','AwayFrom2','AwayTo2'];
  fields.forEach(function(field){
    if (col[field] !== undefined) return;
    const lastCol = sh.getLastColumn();
    sh.insertColumnAfter(lastCol);
    const newCol = lastCol + 1;
    sh.getRange(1, newCol).setValue(field).setFontWeight('bold');
    col[field] = newCol - 1;
  });
  return col;
}
function admin_ensureMemberColumns_(sh, col, fields){
  const list = Array.isArray(fields) ? fields : [];
  list.forEach(function(field){
    if (!field || col[field] !== undefined) return;
    const lastCol = sh.getLastColumn();
    sh.insertColumnAfter(lastCol);
    const newCol = lastCol + 1;
    sh.getRange(1, newCol).setValue(field).setFontWeight('bold');
    col[field] = newCol - 1;
  });
  return col;
}

// Members index cache (includes preferredName + memberSince)
function admin_clearMembersCache_(){
  try{ CacheService.getScriptCache().remove('admin_membersIndex_v2'); }catch(e){}
  try{ CacheService.getScriptCache().remove('admin_membersIndex_v3'); }catch(e){}
  try{ CacheService.getScriptCache().remove('admin_membersIndex_v4'); }catch(e){}
}
function admin_getMembersIndex_(){
  const cache = CacheService.getScriptCache();
  const key = 'admin_membersIndex_v4';
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const sh = admin_findMembersSheet_();
  if (!sh) throw new Error('Members sheet not found (schema mismatch).');

  const lastRow = sh.getLastRow();
  const col = admin_getMembersColMap_(sh);

  const byId = {};
  const all = [];
  if (lastRow >= 2){
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(2,1,lastRow-1,lastCol).getValues();

    for (let r=0;r<data.length;r++){
      const row = data[r];
      const id = String(row[col.ID]||'').trim().toUpperCase();
      if (!id) continue;

      const memberRow = {
        rowNumber: r+2,
        id: id,
        familyId: (col.FamilyID!==undefined) ? String(row[col.FamilyID]||'').trim() : '',
        memberLetter: (col.MemberLetter!==undefined) ? String(row[col.MemberLetter]||'').trim() : '',
        key: String(row[col.Key]||'').trim(),
        nameZh: String(row[col.NameZh]||'').trim(),
        nameEn: String(row[col.NameEn]||'').trim(),
        gender: (col.Gender!==undefined) ? String(row[col.Gender]||'').trim() : '',
        status: String(row[col.Status]||'').trim(),
        email: (col.Email!==undefined) ? String(row[col.Email]||'').trim() : '',
        mobile:(col.Mobile!==undefined)? String(row[col.Mobile]||'').trim() : '',
        vrm: (col.VRM!==undefined) ? String(row[col.VRM]||'').trim() : '',
        vrm2:(col.VRM2!==undefined)? String(row[col.VRM2]||'').trim() : '',
        preferredName: (col.PreferredName!==undefined) ? String(row[col.PreferredName]||'').trim() : '',
        displayNameZh: (col.DisplayNameZh!==undefined) ? String(row[col.DisplayNameZh]||'').trim() : '',
        isMinor: (col.IsMinor!==undefined) ? String(row[col.IsMinor]||'').trim().toUpperCase() === 'YES' : false,
        minorServingApprovedGroups: (col.MinorServingApprovedGroups!==undefined) ? admin_parseGroupsCsv_(row[col.MinorServingApprovedGroups]) : [],
        minorServingSelfSignup: (col.MinorServingSelfSignup!==undefined) ? String(row[col.MinorServingSelfSignup]||'').trim().toUpperCase() === 'YES' : false,
        minorServingApprovedBy: (col.MinorServingApprovedBy!==undefined) ? String(row[col.MinorServingApprovedBy]||'').trim() : '',
        minorServingApprovedAt: (col.MinorServingApprovedAt!==undefined) ? String(row[col.MinorServingApprovedAt]||'').trim() : '',
        memberSinceRaw: (col.Member_Since!==undefined) ? row[col.Member_Since] : '',
        servingGroups: (col.ServingGroups!==undefined) ? admin_parseGroupsCsv_(row[col.ServingGroups]) : [],
        servingGLGroups: (col.ServingGLGroups!==undefined) ? admin_parseGroupsCsv_(row[col.ServingGLGroups]) : [],
        awayFrom1: (col.AwayFrom1!==undefined) ? admin_cellToYmd_(row[col.AwayFrom1]) : '',
        awayTo1: (col.AwayTo1!==undefined) ? admin_cellToYmd_(row[col.AwayTo1]) : '',
        awayFrom2: (col.AwayFrom2!==undefined) ? admin_cellToYmd_(row[col.AwayFrom2]) : '',
        awayTo2: (col.AwayTo2!==undefined) ? admin_cellToYmd_(row[col.AwayTo2]) : '',
        roleExpires: (col.RoleExpires!==undefined) ? String(row[col.RoleExpires]||'').trim() : ''
      };
      byId[id] = memberRow;
      all.push(memberRow);
    }
  }

  const payload = { byId: byId, all: all };
  try{
    cache.put(key, JSON.stringify(payload), 15);
  }catch(e){
    // CacheService enforces a value size limit; skip cache when payload is too large.
  }
  return payload;
}

// Actor name enrichment
function admin_getActorNames_(actor){
  const a = { id: String(actor.id||''), role: String(actor.role||'') };
  if (a.id === 'SUPERUSER') return {
    id:'SUPERUSER', role:'SUPERUSER', nameZh:'', nameEn:'SUPERUSER',
    servingGroups:[], servingGLGroups:[],
    flags:{ canAccessWorshipPlanning:false, canEditWorshipRota:false }
  };

  const mi = admin_getMembersIndex_();
  const m = mi.byId[String(a.id||'').toUpperCase()];
  const servingGroups = m ? (Array.isArray(m.servingGroups) ? m.servingGroups : []) : (Array.isArray(actor.servingGroups) ? actor.servingGroups : []);
  const servingGLGroups = m ? (Array.isArray(m.servingGLGroups) ? m.servingGLGroups : []) : (Array.isArray(actor.servingGLGroups) ? actor.servingGLGroups : []);
  const out = {
    id: a.id,
    role: a.role,
    nameZh: m ? (m.nameZh||'') : '',
    nameEn: m ? (m.nameEn||'') : '',
    servingGroups: servingGroups,
    servingGLGroups: servingGLGroups,
    flags: m ? admin_actorFlagsForMember_(m) : (actor.flags || admin_actorFlagsForMember_({ servingGroups:servingGroups, servingGLGroups:servingGLGroups }))
  };
  if (String(a.role||'').toUpperCase() === 'GL'){
    out.glGroups = Array.isArray(actor.glGroups) ? actor.glGroups : servingGLGroups;
  }
  return out;
}

// Checkins access
function admin_getCheckinsSheet_(){
  const ss = admin_openSs_();
  let sh = ss.getSheetByName(ADMIN_CHECKINS_SHEET_NAME_PRIMARY);
  if (!sh) sh = ss.getSheetByName(ADMIN_CHECKINS_SHEET_NAME_LEGACY);
  return sh || null;
}
function admin_getCheckinsColMap_(sh){
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const col = {};
  headers.forEach((h,i)=>{ col[h]=i; });

  // Prefer Timestamp/EventKey/MemberId
  return {
    Timestamp: (col.Timestamp !== undefined) ? col.Timestamp : 0,
    EventKey:  (col.EventKey  !== undefined) ? col.EventKey  : 1,
    MemberId:  (col.MemberId  !== undefined) ? col.MemberId  : 2
  };
}
function admin_getCheckinsData_(){
  const sh = admin_getCheckinsSheet_();
  if (!sh) return admin_err_('E500','找不到 Checkins 表','Checkins sheet not found.');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok:true, rows:[] };

  const col = admin_getCheckinsColMap_(sh);
  const lastCol = sh.getLastColumn();
  const data = sh.getRange(2,1,lastRow-1,lastCol).getValues();

  const rows = [];
  for (let i=0;i<data.length;i++){
    const row = data[i];
    const ev = String(row[col.EventKey]||'').trim();
    if (!ev) continue;

    const mid = String(row[col.MemberId]||'').trim().toUpperCase();
    if (!mid) continue;

    const tsRaw = row[col.Timestamp];
    const ts = (tsRaw instanceof Date) ? tsRaw : new Date(tsRaw);
    const t = (ts && !isNaN(ts.getTime())) ? ts.getTime() : 0;

    rows.push({ eventKey: ev, memberId: mid, ts: t });
  }

  return { ok:true, rows: rows };
}

function admin_logCheckinsCacheTelemetry_(action, details){
  try{
    const cache = CacheService.getScriptCache();
    const throttleKey = 'admin_checkins_telemetry_' + String(action||'').toLowerCase();
    if (cache.get(throttleKey)) return;
    cache.put(throttleKey, '1', ADMIN_CACHE_CHECKINS_TELEMETRY_THROTTLE);
  }catch(e){}
  admin_audit_({id:'SYSTEM', role:'SYSTEM'}, String(action||''), JSON.stringify(details||{}), 'checkins_cache');
}

function admin_getCheckinsDataCached_(){
  const cache = CacheService.getScriptCache();
  try{
    const manifestRaw = cache.get(ADMIN_CACHE_CHECKINS_MANIFEST_KEY);
    if (manifestRaw){
      const manifest = JSON.parse(manifestRaw);
      const nParts = Number(manifest.nParts || 0);
      if (nParts > 0){
        const parts = [];
        for (let i=0;i<nParts;i++){
          const chunk = cache.get(ADMIN_CACHE_CHECKINS_PART_PREFIX + i);
          if (!chunk){ parts.length = 0; break; }
          parts.push(chunk);
        }
        if (parts.length === nParts){
          const rows = JSON.parse(parts.join(''));
          admin_logCheckinsCacheTelemetry_('CHECKINS_CACHE_HIT', { count: Array.isArray(rows) ? rows.length : 0, nParts: nParts });
          return { ok:true, rows: Array.isArray(rows)?rows:[], usedCache:true, cacheMode:'hit' };
        }
      }
    }
  }catch(e){}

  const fresh = admin_getCheckinsData_();
  if (!fresh || !fresh.ok) return fresh;
  let cacheMode = 'miss';
  try{
    const payload = JSON.stringify(fresh.rows || []);
    const nParts = Math.max(1, Math.ceil(payload.length / ADMIN_CACHE_CHECKINS_PART_CHARS));
    const maxParts = ADMIN_CACHE_CHECKINS_MAX_PARTS;
    const maxPayloadChars = ADMIN_CACHE_CHECKINS_PART_CHARS * maxParts;
    if (payload.length > maxPayloadChars || nParts > maxParts){
      cacheMode = 'skip_oversize';
      try{ cache.remove(ADMIN_CACHE_CHECKINS_MANIFEST_KEY); }catch(e){}
      admin_logCheckinsCacheTelemetry_('CHECKINS_CACHE_SKIP_OVERSIZE', { count: (fresh.rows||[]).length, payloadChars: payload.length, nParts: nParts, maxParts: maxParts });
    }else{
      const manifest = { count: (fresh.rows||[]).length, updatedAt: admin_nowIso_(), nParts: nParts };
      for (let i=0;i<nParts;i++){
        const st = i * ADMIN_CACHE_CHECKINS_PART_CHARS;
        const en = st + ADMIN_CACHE_CHECKINS_PART_CHARS;
        cache.put(ADMIN_CACHE_CHECKINS_PART_PREFIX + i, payload.slice(st,en), ADMIN_CACHE_CHECKINS_TTL);
      }
      cache.put(ADMIN_CACHE_CHECKINS_MANIFEST_KEY, JSON.stringify(manifest), ADMIN_CACHE_CHECKINS_TTL);
      admin_logCheckinsCacheTelemetry_('CHECKINS_CACHE_WRITE', { count: (fresh.rows||[]).length, nParts: nParts });
    }
  }catch(e){
    cacheMode = 'bypass_error';
    admin_logCheckinsCacheTelemetry_('CHECKINS_CACHE_BYPASS', { message: String(e && e.message || e) });
  }
  return { ok:true, rows:fresh.rows || [], usedCache:false, cacheMode: cacheMode };
}

// FirstSeen cache
function admin_getFirstSeenIndexCached_(){
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ADMIN_CACHE_FIRSTSEEN_KEY);
  if (cached){
    try{ return { map: JSON.parse(cached), usedCache:true }; }catch(e){}
  }
  const built = admin_buildFirstSeenIndex_();
  cache.put(ADMIN_CACHE_FIRSTSEEN_KEY, JSON.stringify(built.map), ADMIN_CACHE_FIRSTSEEN_TTL);
  return { map: built.map, usedCache:false };
}
function admin_buildFirstSeenIndex_(){
  const check = admin_getCheckinsDataCached_();
  const map = {};
  if (check.ok){
    for (const r of check.rows){
      if (!admin_isSundayServiceKey_(r.eventKey)) continue;
      const mid = r.memberId;
      if (!mid) continue;
      const prev = map[mid] || '';
      if (!prev || String(r.eventKey) < String(prev)) map[mid] = r.eventKey;
    }
  }
  return { map: map, rows: Object.keys(map).length, updatedAt: admin_nowIso_() };
}
function admin_isNewFriendForEvent_(eventKey, memberId, firstSeenMap, membersById){
  const ev = String(eventKey || '').trim();
  const id = String(memberId || '').trim().toUpperCase();
  const member = (membersById || {})[id] || {};
  const status = admin_normStatus_(member.status || '');
  const firstEvent = String((firstSeenMap || {})[id] || '');
  if (typeof classifyNewFriendFromFirstEvent_ === 'function'){
    return !!classifyNewFriendFromFirstEvent_(ev, id, status, firstEvent || ev).isNewFriend;
  }
  if (admin_isStaffOrAdminStatus_(status)) return false;
  if (!firstEvent || firstEvent !== ev) return false;
  try{
    if (typeof isNewFriendSuppressed_ === 'function' && isNewFriendSuppressed_(ev, id)) return false;
  }catch(e){}
  return true;
}

// Member_Since formatting helper
function admin_memberSinceAsYmd_(raw){
  if (!raw) return '';
  if (raw instanceof Date){
    return Utilities.formatDate(raw, ADMIN_TZ, 'yyyy-MM-dd');
  }
  const s = String(raw).trim();
  if (!s) return '';

  // already y-m-d
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return ymd[1]+'-'+ymd[2]+'-'+ymd[3];

  // UK format: DD/MM/YYYY[ HH:mm[:ss]]
  const uk = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (uk){
    const day = parseInt(uk[1], 10);
    const month = parseInt(uk[2], 10);
    const year = parseInt(uk[3], 10);
    const hh = parseInt(uk[4] || '0', 10);
    const mm = parseInt(uk[5] || '0', 10);
    const ss = parseInt(uk[6] || '0', 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59){
      const dt = new Date(year, month - 1, day, hh, mm, ss, 0);
      if (
        dt &&
        dt.getFullYear() === year &&
        dt.getMonth() === (month - 1) &&
        dt.getDate() === day &&
        dt.getHours() === hh &&
        dt.getMinutes() === mm &&
        dt.getSeconds() === ss
      ){
        return Utilities.formatDate(dt, ADMIN_TZ, 'yyyy-MM-dd');
      }
    }
    return '';
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())){
    return Utilities.formatDate(d, ADMIN_TZ, 'yyyy-MM-dd');
  }
  return '';
}

function admin_debugMemberSinceParsing_(){
  const cases = [
    { input: new Date('2026-01-18T12:46:18Z'), expect: '2026-01-18' },
    { input: '2026-01-18', expect: '2026-01-18' },
    { input: '2026-01-18T12:46:18Z', expect: '2026-01-18' },
    { input: '18/01/2026', expect: '2026-01-18' },
    { input: '18/01/2026 12:46:18', expect: '2026-01-18' },
    { input: '31/02/2026 12:00:00', expect: '' }
  ];
  const out = cases.map(function(c){
    const actual = admin_memberSinceAsYmd_(c.input);
    return { input: String(c.input), expect: c.expect, actual: actual, pass: actual === c.expect };
  });
  Logger.log(JSON.stringify(out));
  return out;
}

function admin_migrateMemberSinceUkStrings_(){
  const sh = admin_findMembersSheet_();
  if (!sh) return admin_err_('E500','找不到 Members 表','Members sheet not found.');

  const col = admin_getMembersColMap_(sh);
  if (col.Member_Since === undefined){
    return admin_err_('E500','找不到 Member_Since 欄位','Member_Since column not found.');
  }

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok:true, scanned:0, converted:0 };

  const idx = col.Member_Since;
  const rng = sh.getRange(2, idx+1, lastRow-1, 1);
  const vals = rng.getValues();
  let converted = 0;

  for (let i=0; i<vals.length; i++){
    const raw = vals[i][0];
    if (raw instanceof Date) continue;
    const s = String(raw||'').trim();
    if (!s) continue;
    const uk = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!uk) continue;

    const day = parseInt(uk[1], 10);
    const month = parseInt(uk[2], 10);
    const year = parseInt(uk[3], 10);
    const hh = parseInt(uk[4] || '0', 10);
    const mm = parseInt(uk[5] || '0', 10);
    const ss = parseInt(uk[6] || '0', 10);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59)) continue;

    const dt = new Date(year, month - 1, day, hh, mm, ss, 0);
    if (
      !dt ||
      dt.getFullYear() !== year ||
      dt.getMonth() !== (month - 1) ||
      dt.getDate() !== day ||
      dt.getHours() !== hh ||
      dt.getMinutes() !== mm ||
      dt.getSeconds() !== ss
    ){
      continue;
    }

    vals[i][0] = dt;
    converted++;
  }

  if (converted > 0){
    rng.setValues(vals);
    admin_clearMembersCache_();
  }

  const result = { ok:true, scanned: vals.length, converted: converted };
  Logger.log('admin_migrateMemberSinceUkStrings_ ' + JSON.stringify(result));
  return result;
}

// Low attendance flags cache (today-based, join-aware)
function admin_getLowAttendanceFlagsCached_(){
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ADMIN_CACHE_LOWATT_KEY);
  if (cached){
    try{ return JSON.parse(cached); }catch(e){}
  }
  const built = admin_buildLowAttendanceFlags_();
  cache.put(ADMIN_CACHE_LOWATT_KEY, JSON.stringify(built), ADMIN_CACHE_LOWATT_TTL);
  return built;
}
function admin_buildLowAttendanceFlags_(){
  const todayUk = Utilities.formatDate(new Date(), ADMIN_TZ, 'yyyy-MM-dd');
  const today = admin_parseYmd_(todayUk) || new Date();
  const enabled = (today.getTime() >= ADMIN_FLAG_START_DATE_UTC.getTime());

  const mi = admin_getMembersIndex_();
  const check = admin_getCheckinsDataCached_();
  const out = { enabled: enabled, flagById: {} };
  if (!enabled) return out;

  // Window: last 6 months approx by 183 days
  const windowStart = new Date(today.getTime() - (183*24*60*60*1000));

  // Collect service dates in window (unique)
  const services = [];
  const serviceSet = new Set();
  if (check.ok){
    for (const r of check.rows){
      if (!admin_isSundayServiceKey_(r.eventKey)) continue;
      const d = admin_eventDateFromKey_(r.eventKey);
      if (!d) continue;
      if (d.getTime() < windowStart.getTime() || d.getTime() > today.getTime()) continue;
      const k = admin_fmtYmd_(d);
      if (!serviceSet.has(k)){
        serviceSet.add(k);
        services.push(d);
      }
    }
  }
  services.sort((a,b)=> a.getTime()-b.getTime());

  // attendee per service date
  const attendByService = {}; // ymd -> Set(memberId)
  if (check.ok){
    for (const r of check.rows){
      if (!admin_isSundayServiceKey_(r.eventKey)) continue;
      const d = admin_eventDateFromKey_(r.eventKey);
      if (!d) continue;
      if (d.getTime() < windowStart.getTime() || d.getTime() > today.getTime()) continue;
      const ymd = admin_fmtYmd_(d);
      if (!attendByService[ymd]) attendByService[ymd] = new Set();
      attendByService[ymd].add(r.memberId);
    }
  }

  // For each member, compute denominator start = max(joinDate, windowStart)
  for (const id in mi.byId){
    const m = mi.byId[id];
    const joinYmd = admin_memberSinceAsYmd_(m.memberSinceRaw);
    let denomStart = windowStart;
    if (joinYmd){
      const jd = admin_parseYmd_(joinYmd);
      if (jd && jd.getTime() > denomStart.getTime()) denomStart = jd;
    }

    // services in denom window
    const denomServices = services.filter(d => d.getTime() >= denomStart.getTime());
    if (denomServices.length < ADMIN_FLAG_MIN_SERVICES) continue;

    let attended = 0;
    for (const d of denomServices){
      const ymd = admin_fmtYmd_(d);
      const set = attendByService[ymd];
      if (set && set.has(id)) attended++;
    }

    const pct = attended / denomServices.length;
    if (pct < ADMIN_FLAG_THRESHOLD){
      out.flagById[id] = true;
    }
  }

  return out;
}

// Reauth verification (normal: scan own QR; SUPERUSER: must scan DEACON/ADMIN QR)
function admin_verifyReauth_(actor, reauthQrPayload){
  const raw = String(reauthQrPayload||'').trim();
  if (!raw) return admin_err_('E401','請掃描你本人同工 QR 作確認','Please scan your own staff QR to confirm.');

  const bypass = (String(actor.id||'') === 'SUPERUSER');

  const parsed = admin_parseQrStrict_(raw);
  if (!parsed.ok) return parsed;

  const mi = admin_getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return admin_err_('E412','找不到此 ID','Member not found.');

  const st = admin_normStatus_(m.status);
  if (!m.key || String(m.key) !== parsed.key){
    return admin_err_('E418','Key 不相符（可能是舊 QR）','Key mismatch (possibly old QR).');
  }

  if (bypass){
    if (!admin_isAdminStatus_(st)){
      return admin_err_(
        'E491',
        '此操作需要執事／管理員（DEACON／ADMIN）QR 作確認',
        'DEACON/ADMIN QR required for this action.'
      );
    }
    return { ok:true, confirmedBy: parsed.id };
  }

  // Normal actor: must match current session id
  const expected = String(actor.id||'').trim().toUpperCase();
  if (parsed.id !== expected){
    return admin_err_('E431','請掃描你本人同工 QR 作確認（不可用其他同工）','Please scan your own staff QR to confirm (cannot use another staff).');
  }

  const actorRole = String(actor.role||'').trim().toUpperCase();
  if (actorRole === 'GL'){
    const glGroups = Array.isArray(m.servingGLGroups) ? m.servingGLGroups : [];
    if (!glGroups.length){
      return admin_err_('E403','此帳號沒有群組長權限','No GL privileges on this account.');
    }
    if (st === 'DISABLED'){
      return admin_err_('E414','此帳號已停用','Account disabled.');
    }
    return { ok:true, confirmedBy: parsed.id, glGroups: glGroups };
  }

  if (!admin_isStaffOrAdminStatus_(st)){
    return { ok:false, code:'E_HANDOFF_UNAUTHORISED', zh:'此管理平台只限已授權同工使用', en:'Admin portal for authorised staff only.' };
  }
  return { ok:true, confirmedBy: parsed.id };
}

// Read full member row for contact reveal
function admin_getMemberRowFull_(memberId){
  const id = String(memberId||'').trim().toUpperCase();
  const sh = admin_findMembersSheet_();
  if (!sh) return admin_err_('E500','找不到 Members 表','Members sheet not found.');

  const col = admin_getMembersColMap_(sh);
  const rowNumber = admin_findMemberRowById_(sh, col, id);
  if (!rowNumber) return admin_err_('E412','找不到此會員','Member not found.');

  const lastCol = sh.getLastColumn();
  const row = sh.getRange(rowNumber,1,1,lastCol).getValues()[0];

  function get_(h){
    return (col[h] === undefined) ? '' : row[col[h]];
  }

  return {
    ok:true,
    member:{
      id:id,
      nameZh:String(get_('NameZh')||'').trim(),
      nameEn:String(get_('NameEn')||'').trim(),
      preferredName:String(get_('PreferredName')||'').trim(),
      status:String(get_('Status')||'').trim(),
      email:String(get_('Email')||'').trim(),
      mobile:String(get_('Mobile')||'').trim(),
      vrm:String(get_('VRM')||'').trim(),
      vrm2:String(get_('VRM2')||'').trim()
    }
  };
}

/* ===== END OF Admin.gs (COMPLETE) ===== */
