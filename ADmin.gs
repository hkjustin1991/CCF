/***************************************
 * CCF Admin Portal (attendance & stats)
 * File: Admin.gs
 * v2026-01-27.admin3.full
 *
 * Route: ?mode=admin  -> doGetAdmin_() renders Admin2.html
 *
 * Login:
 * - STAFF/ADMIN via personal QR (CCF####|k...)
 * - SUPERUSER via secret bypass code stored in Script Properties:
 *     key: ADMIN_BYPASS_CODE
 *
 * IMPORTANT:
 * - Bypass code is NOT hard-coded in this file.
 * - UI must not display the bypass code.
 *
 * Data sources:
 * - Members sheet (existing schema; first 11 headers match)
 * - Checkins sheet (existing)
 *
 * Limits:
 * - STAFF: max 181 days range
 * - ADMIN/SUPERUSER: max 366 days range
 *
 * Extra requirements implemented:
 * - DISABLED members:
 *    • appear in member search
 *    • included in attendance totals/stats (attendance comes from Checkins)
 *    • hidden from matrix columns (not returned in members[] for matrix)
 * - Low attendance flag 〽️ (today-based, join-aware):
 *    • rolling 6 months ending today (UK time)
 *    • denominator starts at max(joinDate, windowStart)
 *    • suppressed before 2026-04-01 and if too few services in window
 * - Monthly + seasonal stats with UNIQUE attendance + UNIQUE new attendees
 * - Contact/VRM reveal:
 *    • free text reason + QR re-scan confirmation
 *    • scanned QR must match current session actor
 *    • SUPERUSER must scan an ADMIN QR (must be a real ADMIN member)
 * - Status change (STAFF also allowed):
 *    • dropdown STAFF/ACTIVE/DISABLED/PROVISIONAL
 *    • QR re-scan confirmation (same rules as contact reveal)
 * - Separate audit sheet: Admin_Activity
 *    • logins, API actions, contact reveal flow, status change flow
 ***************************************/

// ---- Config ----
const ADMIN_VERSION = '2026-01-27.admin3.full';
const ADMIN_TEMPLATE = 'Admin2'; // Admin2.html

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

// Optional members columns (read if present)
const ADMIN_MEMBER_OPTIONAL_COLS = [
  'VRM','VRM2','PreferredName','Member_Since'
];

// Range limits
const ADMIN_MAX_DAYS_STAFF = 181;
const ADMIN_MAX_DAYS_ADMIN = 366;

// Low attendance flag
const ADMIN_FLAG_START_DATE_UTC = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01 UTC
const ADMIN_FLAG_MIN_SERVICES = 6; // suppress if fewer services in denominator
const ADMIN_FLAG_THRESHOLD = 0.5;  // <50%

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
  t.ADMIN_TITLE_EN = 'CCF - ❤️Love brings us together❤️';

  return t.evaluate()
    .setTitle('CCF Admin Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Admin portal login:
 * - QR: must be STAFF or ADMIN (DISABLED/ACTIVE/etc rejected)
 * - bypass: SUPERUSER via Script Properties key ADMIN_BYPASS_CODE
 *
 * IMPORTANT: if bypass fails and input is NOT a QR payload, return E401
 * (do NOT return QR-format error E416 for wrong bypass attempts).
 */
function api_admin_login(input){
  const raw = String(input || '').trim();
  if (!raw) return admin_err_('E401','請掃描你自己的 Staff QR Code 登入','Please scan your own Staff QR code to login.');

  // SUPERUSER via Script Properties
  const bypass = admin_getBypassCode_();
  if (bypass && raw === bypass){
    const token = admin_newSession_({ id:'SUPERUSER', role:'SUPERUSER' });
    admin_audit_({id:'SUPERUSER', role:'SUPERUSER'}, 'LOGIN', JSON.stringify({ via:'BYPASS' }), 'login');
    return { ok:true, token, actor:{ id:'SUPERUSER', role:'SUPERUSER' } };
  }

  // If it doesn't look like a QR payload, treat as invalid login
  if (raw.indexOf('|') < 0){
    return admin_err_('E401','請掃描你自己的 Staff QR Code 登入','Please scan your own Staff QR code to login.');
  }

  const parsed = admin_parseQrStrict_(raw);
  if (!parsed.ok) return parsed;

  const mi = admin_getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return admin_err_('E412','找不到此 ID','Member not found.');

  const st = admin_normStatus_(m.status);
  if (st === 'DISABLED') return admin_err_('E414','此帳號已停用','Account disabled.');
  if (!(st === 'STAFF' || st === 'ADMIN')) {
    return admin_err_('E403','此入口只限已授權同工使用','Admin portal for authorised staff only.');
  }
  if (!m.key || String(m.key) !== parsed.key){
    return admin_err_('E418','Key 不相符（可能是舊 QR）','Key mismatch (possibly old QR).');
  }

  const token = admin_newSession_({ id:m.id, role:st });
  admin_audit_({id:m.id, role:st}, 'LOGIN', JSON.stringify({ via:'QR' }), 'login');

  return { ok:true, token, actor:{ id:m.id, role:st } };
}

function api_admin_ping(token){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  // Provide names for greeting
  const actorInfo = admin_getActorNames_(s.actor);
  admin_audit_(s.actor, 'PING', '', 'ping');
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
 * Stats by service (SundayService only) within date range.
 * Contract (locked earlier):
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

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const firstSeenRes = admin_getFirstSeenIndexCached_();
  const firstSeen = firstSeenRes.map;

  const check = admin_getCheckinsData_();
  if (!check.ok) return check;

  const evAttendees = new Map(); // eventKey -> Set(memberId)

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
 * Period stats by month + season within date range.
 * Adds:
 * - total attendance (sum over services)
 * - unique attendance (unique members in period)
 * - new attendees unique (firstSeen in period)
 */
function api_admin_period_stats(token, fromDate, toDate){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const check = admin_getCheckinsData_();
  if (!check.ok) return check;

  // Build eventKey -> Set(memberId) for services in range
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

  const events = Array.from(evAttendees.keys()).sort(function(a,b){
    return evDate.get(a).getTime() - evDate.get(b).getTime();
  });

  // Month aggregations
  const month = {}; // YYYY-MM -> {services,total,uniqueSet}
  for (const ev of events){
    const d = evDate.get(ev);
    const key = admin_fmtYm_(d); // YYYY-MM
    if (!month[key]) month[key] = { month:key, services:0, total:0, uniqueSet:new Set() };
    month[key].services += 1;
    const set = evAttendees.get(ev);
    month[key].total += set.size;
    set.forEach(mid => month[key].uniqueSet.add(mid));
  }

  // New attendees unique by month uses firstSeenEventKey
  const fs = admin_getFirstSeenIndexCached_().map;
  const newByMonth = {}; // YYYY-MM -> Set(memberId)
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

  const monthsOut = Object.keys(month).sort().map(function(k){
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

  // Season aggregations
  const seasonBuckets = {}; // label -> {season, services,total,uniqueSet,newSet}
  function seasonLabel_(d){
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth()+1;
    if (m<=3) return y+' Jan–Mar';
    if (m<=6) return y+' Apr–Jun';
    if (m<=9) return y+' Jul–Sep';
    return y+' Oct–Dec';
  }

  for (const ev of events){
    const d = evDate.get(ev);
    const sk = seasonLabel_(d);
    if (!seasonBuckets[sk]) seasonBuckets[sk] = { season: sk, services:0, total:0, uniqueSet:new Set(), newSet:new Set() };
    seasonBuckets[sk].services += 1;
    const set = evAttendees.get(ev);
    seasonBuckets[sk].total += set.size;
    set.forEach(mid => seasonBuckets[sk].uniqueSet.add(mid));
  }

  // fill newSet per season from firstSeen
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

  const seasonsOut = Object.keys(seasonBuckets).sort().map(function(k){
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
 * - includes low-attendance flag info for those members (today-based, join-aware)
 */
function api_admin_matrix(token, fromDate, toDate, q){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const range = admin_validateRange_(s.actor, fromDate, toDate);
  if (!range.ok) return range;

  const query = String(q||'').trim();
  const qU = query.toUpperCase();
  const qL = query.toLowerCase();

  const check = admin_getCheckinsData_();
  if (!check.ok) return check;

  const evSet = new Set();
  const attended = {}; // id -> {ev:1}
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

  const events = Array.from(evSet).sort(function(a,b){
    const da = admin_eventDateFromKey_(a); const db = admin_eventDateFromKey_(b);
    return (da && db) ? (da.getTime() - db.getTime()) : a.localeCompare(b);
  });

  const mi = admin_getMembersIndex_();
  const flags = admin_getLowAttendanceFlagsCached_(); // today-based

  const members = [];
  for (const id of attendeeIds){
    const m = mi.byId[id];
    if (!m) continue;

    const st = admin_normStatus_(m.status);
    if (st === 'DISABLED') continue; // hide columns for DISABLED

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

  members.sort(function(a,b){ return a.id.localeCompare(b.id); });

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
 * Adds low-attendance flag + short description.
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
 * Shows PreferredName + Member_Since.
 * Attendance % denominator starts at max(fromDate, Member_Since).
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
  const memberSinceUtc = admin_memberSinceUtc_(m.memberSinceRaw); // Date or null
  const memberSinceYmd = memberSinceUtc ? admin_fmtYmd_(memberSinceUtc) : '';

  const denomStart = admin_maxUtcDate_(range.from, memberSinceUtc || range.from);

  const check = admin_getCheckinsData_();
  if (!check.ok) return check;

  const allEvents = new Set();        // all SundayService in denom window
  const attendedEvents = new Set();   // attended in denom window
  const attendedAllRange = new Set(); // attended within [range.from, range.to] (for list display)

  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;

    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;

    // For list: within requested range
    if (d >= range.from && d <= range.to && r.memberId === id){
      attendedAllRange.add(ev);
    }

    // For denominator: within [denomStart, range.to]
    if (d < denomStart || d > range.to) continue;
    allEvents.add(ev);
    if (r.memberId === id) attendedEvents.add(ev);
  }

  const attendedList = Array.from(attendedAllRange).sort(function(a,b){
    const da = admin_eventDateFromKey_(a); const db = admin_eventDateFromKey_(b);
    return da.getTime() - db.getTime();
  });

  const attended = attendedEvents.size;
  const total = allEvents.size;
  const percent = (total > 0) ? Math.round((attended / total) * 1000) / 10 : 0;

  // Low attendance info (today-based) for display
  const flags = admin_getLowAttendanceFlagsCached_();
  const low = flags.ratioById[id];

  admin_audit_(s.actor, 'MEMBER_DETAIL', JSON.stringify({id:id, from:String(fromDate||''), to:String(toDate||'')}), 'member_detail');

  return {
    ok:true,
    range:{ from: admin_fmtYmd_(range.from), to: admin_fmtYmd_(range.to) },
    member:{
      id: m.id,
      nameZh: m.nameZh||'',
      nameEn: m.nameEn||'',
      preferredName: pref || '',
      status: admin_normStatus_(m.status),
      memberSince: memberSinceYmd
    },
    attendance:{ attendedEventKeys: attendedList },
    stats:{
      attended: attended,
      total: total,
      percent: percent,
      denomStart: admin_fmtYmd_(denomStart)
    },
    lowAttendance:{
      enabled: flags.enabled,
      ratio: (low === undefined ? null : low),
      flag: !!flags.flagById[id]
    }
  };
}

/**
 * Contact/VRM reveal (gated):
 * - requires reason
 * - requires reauth QR scan
 * Rules:
 * - STAFF/ADMIN: reauth QR must match session actor ID + key
 * - SUPERUSER: reauth QR must be an ADMIN member QR
 */
function api_admin_member_contact_reveal(token, memberId, reason, reauthQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const why = String(reason||'').trim();
  if (!why) return admin_err_('E430','請填寫需要查看資料的原因','Please provide a reason.');

  const auth = admin_verifyReauth_(s.actor, reauthQrPayload);
  if (!auth.ok){
    admin_audit_(s.actor, 'CONTACT_REVEAL_DENY', JSON.stringify({memberId:id, reason:why, deny:auth.code||''}), 'contact');
    return auth;
  }

  const mi = admin_getMembersIndex_();
  const m = mi.byId[id];
  if (!m) return admin_err_('E412','找不到此會員','Member not found.');

  admin_audit_(s.actor, 'CONTACT_REVEAL', JSON.stringify({memberId:id, reason:why}), 'contact');

  return {
    ok:true,
    member:{
      id: m.id,
      nameZh: m.nameZh||'',
      nameEn: m.nameEn||'',
      preferredName: String(m.preferredName||'').trim(),
      status: admin_normStatus_(m.status),
      email: String(m.email||'').trim(),
      mobile: String(m.mobile||'').trim(),
      vrm: String(m.vrm||'').trim(),
      vrm2: String(m.vrm2||'').trim()
    }
  };
}

/**
 * Status change (STAFF allowed):
 * - newStatus: STAFF / ACTIVE / DISABLED / PROVISIONAL
 * - reauth QR rules same as contact reveal
 * Logs full flow.
 */
function api_admin_member_status_change(token, memberId, newStatus, reauthQrPayload){
  const s = admin_requireSession_(token);
  if (!s.ok) return s;

  const id = String(memberId||'').trim().toUpperCase();
  if (!/^CCF\d{4}$/.test(id)) return admin_err_('E416','CCF ID 格式錯誤（需要 4 位數）','Invalid CCF ID format.');

  const ns = admin_normStatus_(newStatus);

  // Allowed transitions from Admin portal
  // NOTE: ADMIN is deliberately NOT allowed here (cannot promote to ADMIN via portal)
  const allowed = ['STAFF','ACTIVE','DISABLED','PROVISIONAL','TEMP'];
  if (!allowed.includes(ns)){
    return admin_err_('E431','狀態不正確','Invalid status.');
  }

  // Re-auth scan (must match current actor; SUPERUSER must scan an ADMIN QR)
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

  // Effective confirmer:
  // - for normal actors: their own ID
  // - for SUPERUSER: the ADMIN ID scanned during reauth (auth.confirmedBy)
  const effectiveActorId = String(auth.confirmedBy || s.actor.id || '').trim().toUpperCase();

  // HARD STOP:
  // If target is ADMIN and NOT the same ADMIN who is confirming => block.
  // (Prevents STAFF changing admin, and prevents admin changing other admins.)
  if (oldStatus === 'ADMIN' && id !== effectiveActorId){
    const zh = '帳號目前使用中，請稍後再試；如問題持續請聯絡影音同工。';
    const en = 'Account currently in use. Please try again later. If the problem persists, contact Media team.';
    admin_audit_(s.actor, 'STATUS_CHANGE_BLOCK_ADMIN', JSON.stringify({
      memberId:id, oldStatus:oldStatus, requestedTo:ns, effectiveActorId:effectiveActorId
    }), 'status');
    return admin_err_('E409', zh, en);
  }

  // Ensure RoleExpiresISO column exists if needed
  const roleCol = admin_ensureRoleExpiresIsoColumn_(ms, col);

  // Apply changes
  ms.getRange(rowNumber, col.Status+1).setValue(ns);

  // TEMP handling: 7 days, with RoleExpiresISO
  let expiryIso = '';
  if (ns === 'TEMP'){
    const expiry = new Date(Date.now() + 7*24*60*60*1000);
    expiryIso = expiry.toISOString();
    ms.getRange(rowNumber, roleCol+1).setValue(expiryIso);
  } else {
    // If leaving TEMP (or any other status change), clear RoleExpiresISO
    if (roleCol !== null) ms.getRange(rowNumber, roleCol+1).setValue('');
  }

  // Clear caches (members + low-attendance)
  admin_clearMembersCache_();
  try{ CacheService.getScriptCache().remove(ADMIN_CACHE_LOWATT_KEY); }catch(e){}

  admin_audit_(s.actor, 'STATUS_CHANGE', JSON.stringify({
    memberId:id,
    from: oldStatusRaw,
    to: ns,
    tempExpiryIso: expiryIso || '',
    effectiveActorId: effectiveActorId
  }), 'status');

  return { ok:true, memberId:id, fromStatus: oldStatusRaw, toStatus: ns, expiryIso: expiryIso };
}

/* ============================
 * Internal helpers
 * ============================ */

function admin_openSs_(){ return SpreadsheetApp.openById(ADMIN_SPREADSHEET_ID); }
function admin_nowIso_(){ return new Date().toISOString(); }
function admin_normStatus_(s){ return String(s||'').trim().toUpperCase(); }

function safeToDate_(v){
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Secret bypass stored in Script Properties
function admin_getBypassCode_(){
  return String(PropertiesService.getScriptProperties().getProperty('ADMIN_BYPASS_CODE') || '').trim();
}

function admin_err_(code, zh, en, detail){
  const out = { ok:false, code:String(code||'E500'), zh:String(zh||'系統錯誤'), en:String(en||'System error') };
  if (detail) out.detail = String(detail);
  return out;
}

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

/******** Audit logging ********/
function admin_ensureAuditSheet_(){
  const ss = admin_openSs_();
  let sh = ss.getSheetByName(ADMIN_AUDIT_SHEET_NAME);
  if (!sh){
    sh = ss.insertSheet(ADMIN_AUDIT_SHEET_NAME);
    sh.appendRow(['Timestamp','ActorId','ActorRole','Action','Context','Details']);
    sh.getRange(1,1,1,6).setFontWeight('bold');
  }
  return sh;
}

function admin_audit_(actor, action, details, context){
  try{
    const sh = admin_ensureAuditSheet_();
    sh.appendRow([
      new Date(),
      String(actor && actor.id || ''),
      String(actor && actor.role || ''),
      String(action||''),
      String(context||''),
      String(details||'')
    ]);
  }catch(e){}
}

/******** Date parsing / formatting ********/
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
  return Math.floor((to.getTime() - from.getTime()) / (24*60*60*1000));
}

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

function admin_todayYmdUk_(){
  const ymd = Utilities.formatDate(new Date(), ADMIN_TZ, 'yyyy-MM-dd');
  return admin_parseYmd_(ymd);
}

function admin_monthsAgoUtc_(utcDate, months){
  const d = new Date(utcDate.getTime());
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m - months, day));
  return target;
}

function admin_maxUtcDate_(a, b){
  return (a.getTime() >= b.getTime()) ? a : b;
}

/******** Members sheet helpers ********/
function admin_findMembersSheet_(){
  const ss = admin_openSs_();
  const sheets = ss.getSheets();
  for (const sh of sheets){
    const lastCol = sh.getLastColumn();
    if (lastCol < ADMIN_MEMBERS_HEADERS_REQUIRED.length) continue;

    const header = sh.getRange(1,1,1,ADMIN_MEMBERS_HEADERS_REQUIRED.length).getValues()[0]
      .map(v => String(v||'').trim());
    const matches = ADMIN_MEMBERS_HEADERS_REQUIRED.every((h,i)=> header[i] === h);
    if (matches) return sh;
  }
  return null;
}

function admin_getMembersColMap_(sh){
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const col = {};
  headers.forEach((h,i)=>{ if(h) col[h]=i; });

  return col;
}

function admin_findMemberRowById_(sh, col, memberId){
  const idx = col.ID;
  if (idx === undefined) return null;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const ids = sh.getRange(2, idx+1, lastRow-1, 1).getValues();
  const needle = String(memberId||'').trim().toUpperCase();
  for (let i=0;i<ids.length;i++){
    const v = String(ids[i][0]||'').trim().toUpperCase();
    if (v === needle) return i+2;
  }
  return null;
}

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
  const lastCol = sh.getLastColumn();

  const byId = {};
  if (lastRow >= 2){
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

        // optional fields (read if exist)
        email: (col.Email !== undefined) ? String(row[col.Email]||'').trim() : '',
        mobile: (col.Mobile !== undefined) ? String(row[col.Mobile]||'').trim() : '',
        vrm: (col.VRM !== undefined) ? String(row[col.VRM]||'').trim() : '',
        vrm2: (col.VRM2 !== undefined) ? String(row[col.VRM2]||'').trim() : '',
        preferredName: (col.PreferredName !== undefined) ? String(row[col.PreferredName]||'').trim() : '',
        memberSinceRaw: (col.Member_Since !== undefined) ? row[col.Member_Since] : ''
      };
    }
  }

  const payload = { byId: byId };
  cache.put(key, JSON.stringify(payload), 120);
  return payload;
}

function admin_getActorNames_(actor){
  if (!actor) return { id:'', role:'' };
  if (actor.id === 'SUPERUSER') return { id:'SUPERUSER', role:'SUPERUSER', nameZh:'', nameEn:'SUPERUSER' };

  const mi = admin_getMembersIndex_();
  const m = mi.byId[String(actor.id||'').trim().toUpperCase()];
  if (!m) return { id: String(actor.id||''), role: String(actor.role||''), nameZh:'', nameEn:'' };

  return { id:m.id, role:String(actor.role||''), nameZh:m.nameZh||'', nameEn:m.nameEn||'' };
}

function admin_memberSinceUtc_(raw){
  const d = safeToDate_(raw);
  if (!d) return null;
  // Convert to UTC date (midnight) for comparisons
  const ymd = Utilities.formatDate(d, ADMIN_TZ, 'yyyy-MM-dd');
  return admin_parseYmd_(ymd);
}

function admin_memberSinceAsYmd_(raw){
  const d = admin_memberSinceUtc_(raw);
  return d ? admin_fmtYmd_(d) : '';
}
function admin_ensureRoleExpiresIsoColumn_(sh, col){
  // Returns the 0-based column index of RoleExpiresISO, creating it if missing.
  if (col.RoleExpiresISO !== undefined) return col.RoleExpiresISO;

  const lastCol = sh.getLastColumn();
  sh.insertColumnAfter(lastCol);
  const newCol = lastCol + 1;

  sh.getRange(1, newCol).setValue('RoleExpiresISO').setFontWeight('bold');
  col.RoleExpiresISO = newCol - 1; // 0-based index

  return col.RoleExpiresISO;
}
/******** Checkins access ********/
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
  headers.forEach((h,i)=>{ if(h) col[h]=i; });

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
    const ts = (tsRaw instanceof Date) ? tsRaw : safeToDate_(tsRaw);

    rows.push({ eventKey: ev, memberId: mid, ts: ts ? ts.getTime() : 0 });
  }

  return { ok:true, rows: rows };
}

/******** SundayService helpers ********/
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

/******** QR parsing (admin) ********/
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

/******** Reauth verification ********/
function admin_verifyReauth_(actor, reauthQrPayload){
  const raw = String(reauthQrPayload||'').trim();
  if (!raw) return admin_err_('E440','請掃描同工 QR 以確認','Please scan your staff QR to confirm.');

  const parsed = admin_parseQrStrict_(raw);
  if (!parsed.ok) return parsed;

  const mi = admin_getMembersIndex_();
  const m = mi.byId[parsed.id];
  if (!m) return admin_err_('E412','找不到此 ID','Member not found.');
  if (!m.key || String(m.key) !== parsed.key) return admin_err_('E418','Key 不相符（可能是舊 QR）','Key mismatch.');

  const st = admin_normStatus_(m.status);

  // SUPERUSER: must scan an ADMIN QR
  if (actor.id === 'SUPERUSER'){
    if (st !== 'ADMIN'){
      return admin_err_('E441','SUPERUSER 需要掃描管理員（ADMIN）QR','SUPERUSER requires ADMIN QR.');
    }
    return { ok:true, confirmedBy: m.id, confirmedRole: 'ADMIN' };
  }

  // STAFF/ADMIN: must scan own QR
  const actorId = String(actor.id||'').trim().toUpperCase();
  if (parsed.id !== actorId){
    return admin_err_('E442','請掃描你本人同工 QR（不可用其他人）','Please scan your own staff QR (not someone else).');
  }

  // ensure actor is STAFF/ADMIN currently (defensive)
  if (!(st === 'STAFF' || st === 'ADMIN')){
    return admin_err_('E443','此帳號不是同工/管理員，無法確認','Not STAFF/ADMIN; cannot confirm.');
  }

  return { ok:true, confirmedBy: actorId, confirmedRole: st };
}

/******** FirstSeen caching for stats ********/
function admin_getFirstSeenIndexCached_(){
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ADMIN_CACHE_FIRSTSEEN_KEY);
  if (cached){
    try { return { map: JSON.parse(cached), usedCache:true }; } catch(e){}
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

/******** Low attendance flags (today-based, join-aware) ********/
function admin_getLowAttendanceFlagsCached_(){
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ADMIN_CACHE_LOWATT_KEY);
  if (cached){
    try { return JSON.parse(cached); } catch(e){}
  }
  const built = admin_buildLowAttendanceFlags_();
  cache.put(ADMIN_CACHE_LOWATT_KEY, JSON.stringify(built), ADMIN_CACHE_LOWATT_TTL);
  return built;
}

function admin_buildLowAttendanceFlags_(){
  const out = {
    enabled: false,
    flagById: {},     // memberId -> true/false
    ratioById: {},    // memberId -> ratio number
    attendedById: {}, // memberId -> attended count
    denomById: {}     // memberId -> denominator service count
  };

  const today = admin_todayYmdUk_();
  if (!today) return out;

  // suppress before 2026-04-01
  if (today.getTime() < ADMIN_FLAG_START_DATE_UTC.getTime()) return out;

  out.enabled = true;

  const windowStart = admin_monthsAgoUtc_(today, 6);

  // derive list of services held in window from Checkins (distinct EventKeys)
  const check = admin_getCheckinsData_();
  if (!check.ok) return out;

  const serviceDates = new Map(); // ev -> date
  const serviceSet = new Set();

  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;
    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < windowStart || d > today) continue;
    serviceSet.add(ev);
    serviceDates.set(ev, d);
  }

  const services = Array.from(serviceSet).sort(function(a,b){
    return serviceDates.get(a).getTime() - serviceDates.get(b).getTime();
  });

  // If too few services overall, suppress all flags
  if (services.length < ADMIN_FLAG_MIN_SERVICES){
    out.enabled = false;
    return out;
  }

  // For each member, compute join-aware denominator and attendance count
  const mi = admin_getMembersIndex_().byId;

  // Pre-build per member attended set in window
  const attendedSetById = {};
  for (const r of check.rows){
    const ev = r.eventKey;
    if (!admin_isSundayServiceKey_(ev)) continue;
    const d = admin_eventDateFromKey_(ev);
    if (!d) continue;
    if (d < windowStart || d > today) continue;

    const mid = r.memberId;
    if (!mid) continue;
    if (!attendedSetById[mid]) attendedSetById[mid] = new Set();
    attendedSetById[mid].add(ev);
  }

  for (const id in mi){
    const m = mi[id];

    // Join date (if known)
    const join = admin_memberSinceUtc_(m.memberSinceRaw);
    const denomStart = admin_maxUtcDate_(windowStart, join || windowStart);

    // Denominator services since denomStart
    let denom = 0;
    for (const ev of services){
      const d = serviceDates.get(ev);
      if (d >= denomStart && d <= today) denom++;
    }

    // Suppress if denom too small
    if (denom < ADMIN_FLAG_MIN_SERVICES){
      out.flagById[id] = false;
      out.denomById[id] = denom;
      out.attendedById[id] = 0;
      out.ratioById[id] = null;
      continue;
    }

    const attSet = attendedSetById[id] || new Set();
    // attended only those services in denom window
    let attended = 0;
    for (const ev of attSet){
      const d = serviceDates.get(ev);
      if (d && d >= denomStart && d <= today) attended++;
    }

    const ratio = denom > 0 ? (attended / denom) : 0;
    out.denomById[id] = denom;
    out.attendedById[id] = attended;
    out.ratioById[id] = Math.round(ratio * 1000) / 1000;

    out.flagById[id] = (ratio < ADMIN_FLAG_THRESHOLD);
  }

  return out;
}

/* ===== END OF Admin.gs (COMPLETE) ===== */
