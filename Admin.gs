/***************************************
 * CCF Admin Portal (attendance & stats)
 * File: Admin.gs
 * v2026-02-07.admin10
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
 * - Members sheet (existing schema; first 11 headers match)
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
 *    • TEMP via admin portal = 2 days (RoleExpiresISO)
 *    • HELPER via admin portal = 31 days (RoleExpiresISO)
 *    • QR re-scan confirmation (same rules as contact reveal)
 *    • Hard-stop: cannot change another ADMIN’s status (including ADMIN->ADMIN)
 * - Separate audit sheet: Admin_Activity logs actions
 ***************************************/

// ---- Config ----
const ADMIN_VERSION = '2026-02-08.admin11';
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

// Members required headers (first 11 must match)
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
  'Worship_Singer_1',
  'Worship_Singer_2',
  'Worship_Pianist',
  'Worship_Drum',
  'Worship_Instrument_1',
  'Worship_Instrument_2',
  'Media_AV',
  'Media_PPT',
  'Media_PPTBuild',
  'Support_BibleReader',
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
  Worship_Singer_1:     { zh:'和唱 1', en:'Singer 1' },
  Worship_Singer_2:     { zh:'和唱 2', en:'Singer 2' },
  Worship_Pianist:      { zh:'司琴', en:'Pianist' },
  Worship_Drum:         { zh:'鼓手', en:'Drummer' },
  Worship_Instrument_1: { zh:'樂器 1', en:'Instrument 1' },
  Worship_Instrument_2: { zh:'樂器 2', en:'Instrument 2' },
  Media_AV:             { zh:'影音', en:'Audio Visual' },
  Media_PPT:            { zh:'投影', en:'PPT' },
  Media_PPTBuild:       { zh:'PPT製作', en:'PPT Preparation' },
  Support_BibleReader:  { zh:'讀經員', en:'Bible Reader' },
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
  Worship_Singer_1:     'worship',
  Worship_Singer_2:     'worship',
  Worship_Pianist:      'worship',
  Worship_Drum:         'worship',
  Worship_Instrument_1: 'worship',
  Worship_Instrument_2: 'worship',
  Media_AV:             'media',
  Media_PPT:            'media',
  Media_PPTBuild:       'media',
  Support_BibleReader:  'support',
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
  Finance_Offering: 2
};
function admin_servingPositionLabel_(pos){
  const label = ADMIN_SERVING_POSITION_LABELS[pos];
  if (label) return label.en + ' / ' + label.zh;
  return String(pos || '');
}

// Cache
const ADMIN_CACHE_FIRSTSEEN_KEY = 'admin_firstSeen_v2';
const ADMIN_CACHE_FIRSTSEEN_TTL = 10 * 60;

const ADMIN_CACHE_LOWATT_KEY = 'admin_lowatt_v1';
const ADMIN_CACHE_LOWATT_TTL = 10 * 60;

// ---- Page ----
function doGetAdmin_(e){
  const t = HtmlService.createTemplateFromFile(ADMIN_TEMPLATE);
  t.ADMIN_VERSION = ADMIN_VERSION;

  // Official portal naming
  t.ADMIN_TITLE_ZH = '粵語基督徒團契 - ❤️爱使我们相聚在一起❤️';
  t.ADMIN_TITLE_EN = 'CCF - ❤️When Love Brings Us Together❤️';

  return t.evaluate()
    .setTitle('CCF Admin Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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

  const st = admin_normStatus_(m.status);
  if (st === 'DISABLED') return admin_err_('E414','此帳號已停用','Account disabled.');

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
    maxMonths: ADMIN_SERVING_MONTHS_AHEAD
  };
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
function api_admin_serving_event_save(token, eventKey, rows, overrideAway){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const sh = admin_ensureServingSheet_();
  admin_ensureServingEventKeys_(sh);
  const ev = String(eventKey||'').trim();
  if (!admin_isSundayServiceKey_(ev)){
    return admin_err_('E416','活動格式錯誤（只支援 SundayService_YYYY-MM-DD）','Invalid eventKey (SundayService_YYYY-MM-DD only).');
  }

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

  for (const r of cleaned){
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
    const minAllowed = ADMIN_SERVING_POSITION_MIN[r.position] || 0;
    if (minAllowed && ids.length > 0 && ids.length < minAllowed){
      return admin_err_('E409','崗位人數不足','Not enough people for this position.');
    }
    ids.forEach(function(id){
      const groupKey = ADMIN_SERVING_POSITION_GROUP[r.position] || '';
      if (!admin_memberHasServingGroup_(membersById[id], groupKey)){
        invalidGroupAssignments.push({ memberId: id, position: r.position, group: groupKey });
      }
      memberIdsForAway.push(id);
      if (!duplicateMap[id]) duplicateMap[id] = [];
      duplicateMap[id].push(r.position);
    });
  }

  Object.keys(duplicateMap).forEach(function(id){
    const positions = duplicateMap[id] || [];
    if (positions.length <= 1) return;
    duplicateDetails.push({ memberId: id, positions: positions.slice(0, 2) });
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
    return admin_err_('E409','成員不屬於該事奉組別','Member is not in the required serving group.');
  }
  if (duplicateDetails.length){
    if (!canOverride){
      const detail = duplicateDetails.map(function(d){
        const labels = (d.positions || []).map(admin_servingPositionLabel_);
        return d.memberId + ': ' + labels.join(', ');
      }).join(' | ');
      return admin_err_('E409','同一會員不可同時擔任多個崗位','Duplicate serving assignments for the same member.', detail);
    }
    if (!overrideAway){
      return { ok:false, code:'E409', zh:'同一會員不可同時擔任多個崗位', en:'Duplicate serving assignments for the same member.', duplicates: duplicateDetails, canOverride:true };
    }
  }
  if (conflicts.length){
    if (!canOverride){
      return admin_err_('E409','事奉安排與離開期重疊','Serving assignment overlaps away period.');
    }
    if (!overrideAway){
      return { ok:false, code:'E409', zh:'事奉安排與離開期重疊', en:'Serving assignment overlaps away period.', conflicts: conflicts, canOverride:true };
    }
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
  for (let i=1;i<lastCol;i++){
    rowValues[i] = '';
  }
  cleaned.forEach(function(r){
    const colIdx = updatedHeaderMap[r.position];
    if (colIdx) rowValues[colIdx-1] = r.value || '';
  });
  sh.getRange(rowIndex, 1, 1, lastCol).setValues([rowValues]);

  admin_audit_(
    s.actor,
    'SERVING_EVENT_SAVE',
    JSON.stringify({ eventKey: ev, rows: cleaned.length, overrideAway: !!overrideAway }),
    'serving'
  );

  return { ok:true, eventKey: ev, rows: cleaned.length };
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

  sh.getRange(rowNumber, col.AwayFrom1+1).setValue(p1.from || '');
  sh.getRange(rowNumber, col.AwayTo1+1).setValue(p1.to || '');
  sh.getRange(rowNumber, col.AwayFrom2+1).setValue(p2.from || '');
  sh.getRange(rowNumber, col.AwayTo2+1).setValue(p2.to || '');

  admin_audit_(
    s.actor,
    'SERVING_AWAY_SET',
    JSON.stringify({ memberId: id, from1: p1.from||'', to1: p1.to||'', from2: p2.from||'', to2: p2.to||'' }),
    'serving'
  );

  admin_clearMembersCache_();
  return { ok:true, memberId: id, from1: p1.from||'', to1: p1.to||'', from2: p2.from||'', to2: p2.to||'' };
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

  const check = admin_getCheckinsData_();
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

  const out = [];
  for (const ev of events){
    const set = evAttendees.get(ev);
    const total = set ? set.size : 0;
    let newCount = 0;

    if (set){
      for (const mid of set){
        const fev = firstSeen[mid];
        if (fev && fev === ev) newCount++;
      }
    }
    const existing = Math.max(0, total - newCount);
    out.push({ eventKey: ev, total: total, new: newCount, existing: existing });
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

  const check = admin_getCheckinsData_();
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

  const check = admin_getCheckinsData_();
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
      newUnique: newSet.size
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
      newUnique: o.newSet.size
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

  const check = admin_getCheckinsData_();
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

  admin_audit_(s.actor, 'MATRIX_LOAD', JSON.stringify({from:String(fromDate||''), to:String(toDate||''), members:members.length, events:events.length}), 'matrix');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    events: events,
    members: members,
    attended: attended
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
  const out = [];
  const qU = query.toUpperCase();
  const qL = query.toLowerCase();

  for (const id in mi.byId){
    const m = mi.byId[id];

    const hay = (m.id + ' | ' + (m.nameZh||'') + ' | ' + (m.nameEn||'')).toLowerCase();
    if (!(m.id.toUpperCase().includes(qU) || hay.includes(qL))) continue;

    const st = admin_normStatus_(m.status);

    out.push({
      id: m.id,
      nameZh: m.nameZh||'',
      nameEn: m.nameEn||'',
      status: st,
      servingGroups: m.servingGroups || [],
      servingGLGroups: m.servingGLGroups || [],
      lowFlag: !!flags.flagById[m.id],
      lowFlagZh: flags.flagById[m.id] ? '出席偏低：建議關顧跟進' : '',
      lowFlagEn: flags.flagById[m.id] ? 'Low attendance — consider pastoral care.' : ''
    });
    if (out.length >= 12) break;
  }

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

  const check = admin_getCheckinsData_();
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
    }
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
    return admin_err_('E409', zh, en);
  }

  // Ensure RoleExpiresISO column exists (for TEMP expiry)
  const roleCol = admin_ensureRoleExpiresIsoColumn_(ms, col);

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
function admin_parseGroupsCsv_(value){
  return String(value || '')
    .split(',')
    .map(v => String(v || '').trim().toUpperCase())
    .filter(Boolean);
}
function admin_hasGroupOverlap_(a, b){
  const set = new Set(a || []);
  return (b || []).some(g => set.has(g));
}

function admin_err_(code, zh, en, detail){
  const out = { ok:false, code:String(code||'E500'), zh:String(zh||'系統錯誤'), en:String(en||'System error') };
  if (detail) out.detail = String(detail);
  return out;
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
  for (let i=0;i<events.length;i++){
    const row = 2 + i;
    const current = String(sh.getRange(row, 1).getValue() || '').trim();
    if (!current){
      sh.getRange(row, 1).setValue(events[i].eventKey);
    }
  }
}
function admin_ensureServingHeaders_(sh){
  const existing = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(v => String(v||'').trim());
  if (!existing[0]) existing[0] = 'EventKey';
  const desired = ['EventKey'].concat(ADMIN_SERVING_POSITIONS.map(admin_servingHeaderLabel_));
  let needUpdate = false;
  desired.forEach(function(label, idx){
    if (existing[idx] !== label){
      needUpdate = true;
    }
  });
  if (!needUpdate && existing.length >= desired.length) return;
  sh.getRange(1,1,1,Math.max(existing.length, desired.length)).clearContent();
  sh.getRange(1,1,1,desired.length).setValues([desired]);
  sh.getRange(1,1,1,desired.length).setFontWeight('bold');
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
function admin_normalizeAwayPeriod_(fromYmd, toYmd){
  const f = String(fromYmd||'').trim();
  const t = String(toYmd||'').trim();
  if (!f && !t) return { fromYmd:'', toYmd:'' };
  return { fromYmd: f || t, toYmd: t || f };
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
function admin_extractServingKey_(header){
  const raw = String(header||'').trim();
  if (!raw) return '';
  if (ADMIN_SERVING_POSITIONS.indexOf(raw) >= 0) return raw;
  const slash = raw.split('/');
  const first = String(slash[0]||'').trim();
  if (ADMIN_SERVING_POSITIONS.indexOf(first) >= 0) return first;
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
function admin_isServingNaValue_(value){
  const v = String(value || '').trim().toUpperCase();
  return (v === 'N/A' || v === 'NA');
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
    if (!raw) return;
    const values = admin_splitServingValues_(raw);
    values.forEach(function(val){
      const rawUpper = String(val||'').trim().toUpperCase();
      const entry = {
        eventKey: eventKey,
        group: pos.group,
        position: pos.position,
        slot: '',
        memberId: rawUpper,
        rawValue: val,
        checkedIn: checkedInSet && checkedInSet.has(rawUpper)
      };
      if (!includeNa && admin_isServingNaValue_(rawUpper)) return;
      const m = membersById[rawUpper] || {};
      entry.nameZh = String(m.nameZh || '');
      entry.nameEn = String(m.nameEn || '');
      out.push(entry);
    });
  });

  out.sort((a,b)=>{
    const g = String(a.group||'').localeCompare(String(b.group||''));
    if (g !== 0) return g;
    const p = String(a.position||'').localeCompare(String(b.position||''));
    if (p !== 0) return p;
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
  const positions = matrix.positions.map(function(pos){
    return { key: pos.key, group: pos.group, position: pos.position };
  });

  const mi = admin_getMembersIndex_();
  const byId = (mi && mi.byId) ? mi.byId : {};

  eventKeys.forEach(function(ev){
    const rowIndex = admin_findServingEventRowIndex_(sh, ev);
    if (!rowIndex) return;
    const lastCol = sh.getLastColumn();
    const row = sh.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
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
    const header = s.getRange(1,1,1,ADMIN_MEMBERS_HEADERS_REQUIRED.length).getValues()[0].map(v => String(v||'').trim());
    const matches = ADMIN_MEMBERS_HEADERS_REQUIRED.every((h,i)=> header[i] === h);
    if (matches) return s;
  }
  return null;
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
function admin_ensureRoleExpiresIsoColumn_(sh, col){
  if (col.RoleExpiresISO !== undefined) return col.RoleExpiresISO;
  const lastCol = sh.getLastColumn();
  sh.insertColumnAfter(lastCol);
  const newCol = lastCol + 1;
  sh.getRange(1, newCol).setValue('RoleExpiresISO').setFontWeight('bold');
  col.RoleExpiresISO = newCol - 1;
  return col.RoleExpiresISO;
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
  if (lastRow >= 2){
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(2,1,lastRow-1,lastCol).getValues();

    for (let r=0;r<data.length;r++){
      const row = data[r];
      const id = String(row[col.ID]||'').trim().toUpperCase();
      if (!id) continue;

      byId[id] = {
        rowNumber: r+2,
        id: id,
        key: String(row[col.Key]||'').trim(),
        nameZh: String(row[col.NameZh]||'').trim(),
        nameEn: String(row[col.NameEn]||'').trim(),
        status: String(row[col.Status]||'').trim(),
        email: (col.Email!==undefined) ? String(row[col.Email]||'').trim() : '',
        mobile:(col.Mobile!==undefined)? String(row[col.Mobile]||'').trim() : '',
        vrm: (col.VRM!==undefined) ? String(row[col.VRM]||'').trim() : '',
        vrm2:(col.VRM2!==undefined)? String(row[col.VRM2]||'').trim() : '',
        preferredName: (col.PreferredName!==undefined) ? String(row[col.PreferredName]||'').trim() : '',
        memberSinceRaw: (col.Member_Since!==undefined) ? row[col.Member_Since] : '',
        servingGroups: (col.ServingGroups!==undefined) ? admin_parseGroupsCsv_(row[col.ServingGroups]) : [],
        servingGLGroups: (col.ServingGLGroups!==undefined) ? admin_parseGroupsCsv_(row[col.ServingGLGroups]) : [],
        awayFrom1: (col.AwayFrom1!==undefined) ? String(row[col.AwayFrom1]||'').trim() : '',
        awayTo1: (col.AwayTo1!==undefined) ? String(row[col.AwayTo1]||'').trim() : '',
        awayFrom2: (col.AwayFrom2!==undefined) ? String(row[col.AwayFrom2]||'').trim() : '',
        awayTo2: (col.AwayTo2!==undefined) ? String(row[col.AwayTo2]||'').trim() : ''
      };
    }
  }

  const payload = { byId: byId };
  cache.put(key, JSON.stringify(payload), 120);
  return payload;
}

// Actor name enrichment
function admin_getActorNames_(actor){
  const a = { id: String(actor.id||''), role: String(actor.role||'') };
  if (a.id === 'SUPERUSER') return { id:'SUPERUSER', role:'SUPERUSER', nameZh:'', nameEn:'SUPERUSER' };

  const mi = admin_getMembersIndex_();
  const m = mi.byId[String(a.id||'').toUpperCase()];
  return {
    id: a.id,
    role: a.role,
    nameZh: m ? (m.nameZh||'') : '',
    nameEn: m ? (m.nameEn||'') : ''
  };
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
  const check = admin_getCheckinsData_();
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
  // already y-m-d
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1]+'-'+m[2]+'-'+m[3];

  const d = new Date(s);
  if (!isNaN(d.getTime())){
    return Utilities.formatDate(d, ADMIN_TZ, 'yyyy-MM-dd');
  }
  return '';
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
  const check = admin_getCheckinsData_();
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
