/***************************************
 * CCF Admin Portal (attendance & stats)
 * File: Admin.gs
 * v2026-03-07.admin106
 *
 * Route: ?mode=admin  -> doGetAdmin_() renders Admin2.html
 *
 * Login:
 * - STAFF/ADMIN via personal QR (CCF####|k...)
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
 * - ADMIN/SUPERUSER: max 366 days range
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
 *    • SUPERUSER must scan an ADMIN QR (and must match ADMIN member)
 * - Status change (STAFF also allowed):
 *    • dropdown STAFF/ACTIVE/DISABLED/PROVISIONAL/TEMP/HELPER
 *    • TEMP via admin portal = 2 days (RoleExpires)
 *    • HELPER via admin portal = 31 days (RoleExpires)
 *    • QR re-scan confirmation (same rules as contact reveal)
 *    • Hard-stop: cannot change another ADMIN’s status (including ADMIN->ADMIN)
 * - Separate audit sheet: Admin_Activity logs actions
 ***************************************/

// ---- Config ----
const ADMIN_VERSION = '2026-03-07.admin106';
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
const ADMIN_CACHE_FIRSTSEEN_KEY = 'admin_firstSeen_v2';
const ADMIN_CACHE_FIRSTSEEN_TTL = 10 * 60;

const ADMIN_CACHE_LOWATT_KEY = 'admin_lowatt_v1';
const ADMIN_CACHE_LOWATT_TTL = 10 * 60;
const ADMIN_CACHE_CHECKINS_MANIFEST_KEY = 'admin_checkins_manifest_v1';
const ADMIN_CACHE_CHECKINS_PART_PREFIX = 'admin_checkins_part_v1_';
const ADMIN_CACHE_CHECKINS_TTL = 60;
const ADMIN_CACHE_CHECKINS_PART_CHARS = 85000;
const ADMIN_CACHE_CHECKINS_MAX_PARTS = 12;
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

/**
 * Admin portal login:
 * - QR: must be STAFF or ADMIN (DISABLED/ACTIVE/etc rejected)
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
  if (!(st === 'STAFF' || st === 'ADMIN' || glGroups.length)) {
    return admin_err_('E403','此管理平台只限已授權同工使用','Admin portal for authorised staff only.');
  }
  if (!m.key || String(m.key) !== parsed.key){
    return admin_err_('E418','Key 不相符（可能是舊 QR）','Key mismatch (possibly old QR).');
  }

  const role = (st === 'STAFF' || st === 'ADMIN') ? st : 'GL';
  const actor = { id:m.id, role:role };
  if (role === 'GL') actor.glGroups = glGroups;
  const token = admin_newSession_(actor);
  admin_audit_(actor, 'LOGIN', JSON.stringify({ via:'QR' }), '');
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
  if (role === 'ADMIN' || role === 'SUPERUSER' || role === 'STAFF') return true;
  if (role !== 'GL') return false;
  const glGroups = Array.isArray(actor.glGroups) ? actor.glGroups : [];
  return glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; });
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

  const glGroups = Array.isArray(s.actor.glGroups) ? s.actor.glGroups : [];
  const canManage = (role === 'ADMIN' || role === 'SUPERUSER' || (role === 'GL' && glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; })));

  return { ok:true, group:key, count:members.length, members:members, canManage:canManage };
}

function admin_actorCanAccessServingGroup_(actor, groupKey){
  const key = admin_normalizeServingGroup_(groupKey);
  if (!key) return false;
  const role = String((actor && actor.role) || '').trim().toUpperCase();
  if (role === 'ADMIN' || role === 'STAFF' || role === 'SUPERUSER') return true;
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

  const glGroups = Array.isArray(s.actor.glGroups) ? s.actor.glGroups : [];
  const isAdminLike = (role === 'ADMIN' || role === 'SUPERUSER');
  const isGlAllowed = (role === 'GL' && glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; }));
  if (!isAdminLike && !isGlAllowed){
    return admin_err_('E403','沒有權限修改此組別','No permission to modify this group.');
  }

  const mi = admin_getMembersIndex_();
  const target = (mi && mi.byId) ? mi.byId[id] : null;
  if (!target) return admin_err_('E412','找不到此會員','Member not found.');

  const targetStatus = admin_normStatus_(target.status || '');
  if (!isAdminLike && (targetStatus === 'STAFF' || targetStatus === 'ADMIN')){
    return admin_err_('E403','GL 不可修改 STAFF/ADMIN 的組別','GL cannot modify STAFF/ADMIN serving groups.');
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
  if (up === 'ADD'){
    if (next.indexOf(keyUpper) < 0) next.push(keyUpper);
  } else if (up === 'REMOVE'){
    next = next.filter(function(g){ return g !== keyUpper; });
  }

  sh.getRange(rowNumber, col.ServingGroups+1).setValue(next.join(', '));
  admin_clearMembersCache_();
  admin_audit_(s.actor, 'SERVING_GROUP_MEMBER_UPDATE', JSON.stringify({ group:key, action:up, memberId:id, viaTargetQr:(up==='ADD' && role==='GL') }), 'serving_group');
  return { ok:true, group:key, action:up, memberId:id, servingGroups:next };
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

  const role = String((s.actor && s.actor.role) || '').trim().toUpperCase();
  const glGroups = Array.isArray(s.actor.glGroups) ? s.actor.glGroups : [];
  const isAdminLike = (role === 'ADMIN' || role === 'SUPERUSER');
  const isGlAllowed = (role === 'GL' && glGroups.some(function(g){ return admin_normalizeServingGroup_(g) === key; }));
  if (!isAdminLike && !isGlAllowed){
    return admin_err_('E403','沒有權限修改此組別','No permission to modify this group.');
  }

  const mi = admin_getMembersIndex_();
  const target = (mi && mi.byId) ? mi.byId[id] : null;
  if (!target) return admin_err_('E412','找不到此會員','Member not found.');

  const targetStatus = admin_normStatus_(target.status || '');
  if (!isAdminLike && (targetStatus === 'STAFF' || targetStatus === 'ADMIN')){
    return admin_err_('E403','GL 不可修改 STAFF/ADMIN 的組別','GL cannot modify STAFF/ADMIN serving groups.');
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
    return { id: m.id, nameZh: m.nameZh||'', nameEn: m.nameEn||'', preferredName: m.preferredName||'', groups: groups };
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
    cleaned.push({ position, value: valueRaw });
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
    const minAllowed = admin_servingMinRequired_(r.position);
    const filledSlots = admin_countServingFilledSlots_(r.value);
    if (minAllowed && filledSlots > 0 && filledSlots < minAllowed){
      return admin_conflict_('崗位人數不足','Not enough people for this position.', '', 'POSITION_MIN_REQUIRED', 'SERVING_ASSIGNMENT');
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
    duplicateDetails.push({ memberId: id, positions: effectivePositions.slice(0, 2), dateYmd: eventDateYmd, newlyIntroduced:true });
  });

  const evDate = admin_eventDateFromKey_(ev);
  let conflicts = [];
  if (memberIdsForAway.length){
    conflicts = admin_checkServingAwayConflicts_(evDate, memberIdsForAway.map(function(id){
      return { memberId: id };
    }));
  }
  const role = String(s.actor.role||'').trim().toUpperCase();
  const canOverride = (role === 'ADMIN' || role === 'SUPERUSER');
  if (invalidGroupAssignments.length){
    const detail = invalidGroupAssignments.map(function(x){
      const m = membersById[String(x.memberId||'').toUpperCase()] || null;
      const compact = admin_memberLabelCompact_(m || { id:String(x.memberId||'') });
      return [compact.label, String(x.position||''), String(x.group||'')].filter(Boolean).join(' → ');
    }).join(' | ');
    return admin_conflict_('成員不屬於該事奉組別','Member is NOT a member of this serving group.', detail, 'MEMBER_NOT_IN_SERVING_GROUP', 'SERVING_ASSIGNMENT');
  }
  if (duplicateDetails.length){
    if (!canOverride){
      const detail = duplicateDetails.map(function(d){
        const labels = (d.positions || []).map(admin_servingPositionLabel_);
        return d.memberId + ': ' + labels.join(', ');
      }).join(' | ');
      return admin_conflict_('該會員已在此崗位事奉','They are already serving this position.', detail, 'DUPLICATE_ASSIGNMENT', 'SERVING_ASSIGNMENT');
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
      duplicates: []
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
        const fev = firstSeen[mid];
        if (fev && fev === ev) newCount++;
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
 * ADMIN/SUPERUSER only: rebuild firstSeen cache immediately.
 */
function api_admin_stats_rebuild(token){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const glBlock = admin_requireNonGl_(s.actor);
  if (glBlock) return glBlock;

  if (!(s.actor.role === 'ADMIN' || s.actor.role === 'SUPERUSER')){
    return admin_err_('E403','只有管理員可以重建統計快取','Only ADMIN can rebuild cache.');
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
    if (fs[mid] && fs[mid] === ev) newMembers.push(obj);
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

  admin_audit_(s.actor, 'EVENT_DETAIL', JSON.stringify({eventKey: ev, total, new: newCount, existing: existingCount}), 'event');

  return {
    ok:true,
    eventKey: ev,
    dateYmd: ev.replace('SundayService_',''),
    counts:{ total: total, new: newCount, existing: existingCount },
    lists:{ newMembers: newMembers, existingMembers: existingMembers },
    extras:{
      offering: null,
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
  const newByMonth = {};
  for (const mid in fs){
    const fev = fs[mid];
    if (!fev || !admin_isSundayServiceKey_(fev)) continue;
    const d = admin_eventDateFromKey_(fev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;
    const mk = admin_fmtYm_(d);
    if (!newByMonth[mk]) newByMonth[mk] = new Set();
    newByMonth[mk].add(mid);
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
    seasonBuckets[sk].newSet.add(mid);
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
  const s = admin_requireSession_(token);
  if (!s.ok) return s;
  const glBlock = admin_requireNonGl_(s.actor);
  if (glBlock) return glBlock;

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const query = String(q||'').trim();
  const qU = query.toUpperCase();
  const qL = query.toLowerCase();

  const check = admin_getCheckinsDataCached_();
  if (!check.ok) return check;

  const evSet = new Set();
  const attended = {};
  const attendeeIds = new Set();

  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;

    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < range.from || d > range.to) continue;

    const mid = r.memberId;
    if (!mid) continue;

    evSet.add(ev);
    attendeeIds.add(mid);

    if (!attended[mid]) attended[mid] = {};
    attended[mid][ev] = 1;
  }

  const events = Array.from(evSet).sort((a,b)=>{
    const da = admin_eventDateFromKey_(a); const db = admin_eventDateFromKey_(b);
    return (da && db) ? (da.getTime() - db.getTime()) : a.localeCompare(b);
  });

  const mi = admin_getMembersIndex_();
  const flags = admin_getLowAttendanceFlagsCached_();

  const members = [];
  for (const id of attendeeIds){
    const m = mi.byId[id];
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
      lowFlagEn: flags.flagById[m.id] ? 'Low attendance — consider pastoral care.' : ''
    });
  }

  members.sort((a,b)=> a.id.localeCompare(b.id));

  const away = {};
  const historyMap = admin_getAwayHistoryPeriodsMap_(members.map(function(m){ return m.id; }));
  events.forEach(function(ev){
    const d = admin_eventDateFromKey_(ev);
    if (!d) return;
    members.forEach(function(m){
      const ap = admin_getAwayPeriodForMember_(m.id);
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

  admin_audit_(s.actor, 'MATRIX_LOAD', JSON.stringify({from:String(fromDate||''), to:String(toDate||''), members:members.length, events:events.length}), 'matrix');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    events: events,
    members: members,
    attended: attended,
    away: away
  };
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
 * - cannot change another ADMIN’s status (including ADMIN changing other admins)
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
  // - SUPERUSER: scanned ADMIN id
  const effectiveActorId = String(auth.confirmedBy || s.actor.id || '').trim().toUpperCase();

  if (oldStatus === 'ADMIN' && id !== effectiveActorId){
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

/* ===========================
   ===== Internals below =====
   =========================== */

function admin_openSs_(){ return SpreadsheetApp.openById(ADMIN_SPREADSHEET_ID); }
function admin_nowIso_(){ return new Date().toISOString(); }
function admin_normStatus_(s){ return String(s||'').trim().toUpperCase(); }
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
  const rows = events.length;
  const existing = sh.getRange(2, 1, rows, 1).getValues();
  const emptyRows = [];
  for (let i=0;i<rows;i++){
    const current = String((existing[i] && existing[i][0]) || '').trim();
    if (!current) emptyRows.push(i);
  }
  if (!emptyRows.length) return;
  const first = emptyRows[0];
  const last = emptyRows[emptyRows.length - 1];
  const isContiguous = (emptyRows.length === (last - first + 1));
  if (isContiguous){
    const values = [];
    for (let i=first; i<=last; i++) values.push([events[i].eventKey]);
    sh.getRange(2 + first, 1, values.length, 1).setValues(values);
    return;
  }
  for (let k=0; k<emptyRows.length; k++){
    const i = emptyRows[k];
    sh.getRange(2 + i, 1).setValue(events[i].eventKey);
  }
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
  const display = pref || fallback || zh || en || id;
  return {
    id: id,
    name: display,
    label: id ? (id + ' · ' + display) : display
  };
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
  return (st === 'ADMIN');
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
  const allMembers = (mi && mi.all) ? mi.all : [];
  groups.forEach(function(groupKey){
    const current = allMembers
      .filter(function(m){ return admin_memberHasServingGroup_(m, groupKey); })
      .map(admin_memberLabelCompact_)
      .sort(function(a,b){ return String(a.label||'').localeCompare(String(b.label||'')); });
    out.byGroup[groupKey] = { group: groupKey, currentMembers: current, gaps: [] };
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
  const gapMap = {};

  rows.forEach(function(row){
    const eventKey = String(row[0]||'').trim();
    if (!eventKey) return;
    const evDate = admin_eventDateFromKey_(eventKey);
    if (!evDate || evDate.getTime() < today.getTime() || evDate.getTime() > soon12w.getTime()) return;
    const dateYmd = admin_fmtYmd_(evDate);
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
      if (missing <= 0) return;
      const key = groupKey + '::' + eventKey;
      if (!gapMap[key]){
        gapMap[key] = { group: groupKey, eventKey:eventKey, dateYmd:dateYmd, totalMissing:0, positions:[] };
      }
      gapMap[key].totalMissing += missing;
      gapMap[key].positions.push({ position:String(pos.position||''), label:admin_servingPositionZh_(String(pos.position||'')), missing:missing, assigned:filledSlots, minRequired:minRequired });
    });
  });

  for (const k in gapMap){
    const it = gapMap[k];
    if (!it || !out.byGroup[it.group]) continue;
    out.byGroup[it.group].gaps.push(it);
  }
  for (const g in out.byGroup){
    out.byGroup[g].gaps.sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); });
  }
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
    const matched = token.match(/CCF\d{4}/i);
    if (matched && matched[0]) return matched[0].toUpperCase();
    return '';
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
      const rawUpper = String(val||'').trim().toUpperCase();
      const ids = admin_extractMemberIdsFromServingValue_(val);
      const memberId = ids && ids.length ? ids[0] : rawUpper;
      const entry = {
        eventKey: eventKey,
        group: pos.group,
        position: pos.position,
        slot: String(valueIdx + 1),
        memberId: memberId,
        rawValue: val,
        checkedIn: checkedInSet && !!(ids && ids.length) && checkedInSet.has(memberId)
      };
      if (!includeNa && admin_isServingNaValue_(rawUpper)) return;
      const m = membersById[memberId] || {};
      entry.nameZh = String(m.nameZh || '');
      entry.nameEn = String(m.nameEn || '');
      entry.preferredName = String(m.preferredName || '');
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
        preferredName: ''
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
        const matched = token.match(/CCF\d{4}/i);
        const memberId = matched ? matched[0].toUpperCase() : '';
        const member = memberId ? (byId[memberId] || {}) : {};
        const entry = {
          memberId: memberId,
          rawValue: val,
          nameZh: String(member.nameZh || ''),
          nameEn: String(member.nameEn || ''),
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
  const isAdmin = (actor.role === 'ADMIN' || actor.role === 'SUPERUSER');
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

// Members index cache (includes preferredName + memberSince)
function admin_clearMembersCache_(){
  try{ CacheService.getScriptCache().remove('admin_membersIndex_v2'); }catch(e){}
}
function admin_getMembersIndex_(){
  const cache = CacheService.getScriptCache();
  const key = 'admin_membersIndex_v2';
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
  cache.put(key, JSON.stringify(payload), 15);
  return payload;
}

// Actor name enrichment
function admin_getActorNames_(actor){
  const a = { id: String(actor.id||''), role: String(actor.role||'') };
  if (a.id === 'SUPERUSER') return { id:'SUPERUSER', role:'SUPERUSER', nameZh:'', nameEn:'SUPERUSER' };

  const mi = admin_getMembersIndex_();
  const m = mi.byId[String(a.id||'').toUpperCase()];
  const out = {
    id: a.id,
    role: a.role,
    nameZh: m ? (m.nameZh||'') : '',
    nameEn: m ? (m.nameEn||'') : ''
  };
  if (String(a.role||'').toUpperCase() === 'GL'){
    out.glGroups = Array.isArray(actor.glGroups) ? actor.glGroups : [];
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
  const tsById = {};
  if (check.ok){
    for (const r of check.rows){
      if (!admin_isSundayServiceKey_(r.eventKey)) continue;
      const mid = r.memberId;
      const t = r.ts || 0;
      if (!mid || !t) continue;
      const prev = tsById[mid];
      if (prev === undefined || t < prev){
        tsById[mid] = t;
        map[mid] = r.eventKey;
      }
    }
  }
  return { map: map, rows: Object.keys(map).length, updatedAt: admin_nowIso_() };
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

// Reauth verification (normal: scan own QR; SUPERUSER: must scan ADMIN QR)
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
    if (st !== 'ADMIN'){
      return admin_err_(
        'E491',
        '此操作需要管理員（ADMIN）QR 作確認',
        'ADMIN QR required for this action.'
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

  if (!(st === 'STAFF' || st === 'ADMIN')){
    return admin_err_('E403','此管理平台只限已授權同工使用','Admin portal for authorised staff only.');
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
