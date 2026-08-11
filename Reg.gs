/***************************************
 * CCF Registration Portal (public, no sign-in)
 * File: Reg.gs
 * v2026-08-11.reg122
 * CHANGELOG: require the ROTA_PUBLIC_PASSWORD Script Property; no hardcoded fallback.
 *
 * SOURCE OF TRUTH: Based on v2026-01-24.reg1 with minimal requested changes only.
 *
 * ============================================================
 * CHANGELOG (2026-01-31.reg2)
 * ============================================================
 * [1] Keep existing QR (no key rotation) on update:
 *     - Accepts input.keepExistingQr (boolean) for:
 *         - api_reg_self_update_public()
 *         - api_reg_update_by_id_public()
 *     - If true: does NOT change Key; qrPayload uses existing Key.
 *     - Response includes keepExistingQr.
 *
 * [2] Double-submit protection (server-side best effort):
 *     - Dedup cache for CREATE by fingerprint (deviceId + identity fields) for 30s.
 *     - Returns same successful CREATE result if repeated within TTL.
 *
 * [3] New Members optional field: ReferredBy
 *     - Added to REG_EXTRA_HEADERS and read/write paths.
 *
 * [4] Self attendance endpoint (self-only):
 *     - api_reg_self_attendance_public(qrPayload, fromYmdOptional, toYmdOptional)
 *     - Default window: last ~183 days ending today (UK).
 *     - Denominator start = max(Member_Since, windowStart).
 *
 * [5] Safety: preserve ADMIN status on self-update
 *     - If old status is ADMIN, do not downgrade to STAFF.
 *
 * PATCH BOUNDARIES:
 *   - Search for "PATCH_BOUNDARY:" to locate changes.
 ***************************************/

const REG_VERSION = '2026-08-11.reg122';
const REG_TEMPLATE = 'Reg2';

const REG_MIN_ID_NUM = 101;   // CCF0101
const REG_MAX_ID_NUM = 9999;  // CCF9999

const REG_WA_LINK = 'https://chat.whatsapp.com/G08XRgAsM520nexCGHW9q4';
const REG_QR_BASE = 'https://quickchart.io/qr';

const REG_EXTRA_HEADERS = [
  'Member_Since','PreferredName','Gender','HasCar','VRM','VRM2','IsMinor','ParentEmail',
  'MinorServingApprovedGroups','MinorServingSelfSignup','MinorServingApprovedBy','MinorServingApprovedAt',
  /* PATCH_BOUNDARY: REG2_REFERREDBY_HEADER_BEGIN */
  'ReferredBy'
  /* PATCH_BOUNDARY: REG2_REFERREDBY_HEADER_END */
];

const REG_ACTIVITY_SHEET = 'Reg_Activity';
const REG_SERMON_SHEET = 'Sermon_Info';
const REG_BIBLE_CACHE_PREFIX = 'reg_bible_v1_';
const REG_BIBLE_CACHE_TTL = 6 * 60 * 60;
const REG_ADMIN_HANDOFF_CACHE_PREFIX = 'reg_admin_handoff_';
const REG_ADMIN_HANDOFF_TTL_SECONDS = 10 * 60;
const ROTA_PUBLIC_VERSION = '2026-06-13.rota102';


/******** Entry ********/
function doGetReg_(e){
  const t = HtmlService.createTemplateFromFile(REG_TEMPLATE);
  t.APP_VERSION = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : REG_VERSION;
  t.REG_VERSION = REG_VERSION;
  const scannerCfg = getExternalScannerConfig_();
  t.EXTERNAL_SCANNER_URL = scannerCfg.url;
  t.EXTERNAL_SCANNER_ORIGIN = scannerCfg.origin;
  t.EXTERNAL_SCANNER_TIMEOUT_MS = scannerCfg.timeoutMs;
  return t.evaluate()
    .setTitle('CCF會員登記及自助服務平台 / CCF registration and self service portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGetRotaPublic_(e){
  const t = HtmlService.createTemplateFromFile('RotaPublic');
  t.ROTA_PUBLIC_VERSION = ROTA_PUBLIC_VERSION;
  return t.evaluate()
    .setTitle('CCF Serving Rota')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function api_reg_ping_public(){ return { ok:true, regVersion: REG_VERSION }; }

function reg_getPublicRotaPassword_(){
  try{
    const p = PropertiesService.getScriptProperties();
    const configured = String((p && p.getProperty('ROTA_PUBLIC_PASSWORD')) || '').trim();
    if (configured) return configured;
  }catch(e){}
  return '';
}

function reg_publicRotaNotConfigured_(){
  return {
    ok:false,
    code:'E503_ROTA_PASSWORD',
    zh:'公開事奉輪值尚未啟用；請聯絡管理員。',
    en:'Public serving rota is not configured; please contact an administrator.'
  };
}

function reg_publicRotaTokenType_(raw){
  const v = String(raw || '').trim().toUpperCase();
  if (!v) return 'EMPTY';
  if (v === 'N/A' || v === 'NA') return 'NA';
  if (v === 'CLOSED') return 'CLOSED';
  if (v === 'VACANT') return 'VACANT';
  return 'VALUE';
}

function reg_publicRotaMemberLabel_(entry){
  const e = entry || {};
  const memberId = String(e.memberId || '').trim().toUpperCase();
  if (memberId){
    const zh = String(e.nameZh || '').trim();
    const en = String(e.nameEn || '').trim();
    const preferred = String(e.preferredName || '').trim();
    return {
      textZh: zh || preferred || en || memberId,
      textEn: en || preferred || zh || memberId,
      textPreferred: preferred || zh || en || memberId
    };
  }
  const raw = String(e.rawValue || '').trim();
  return { textZh: raw || '', textEn: raw || '', textPreferred: raw || '' };
}

function reg_publicRotaPassageEn_(rawOrCanonical){
  const src = String(rawOrCanonical || '').trim();
  if (!src) return '';
  try{
    const parsed = bible_parseReference_(src);
    if (!parsed || !parsed.ok || parsed.status !== 'OK' || !Array.isArray(parsed.segments) || !parsed.segments.length){
      return src;
    }
    return parsed.segments.map(function(seg){
      const book = String(seg.bookEn || seg.bookZh || '').trim();
      const chapter = Number(seg.chapter || 0);
      const v1 = Number(seg.verseStart || 0);
      const v2 = Number(seg.verseEnd || 0);
      if (!(chapter > 0 && v1 > 0 && v2 > 0)) return book || src;
      return book + ' ' + chapter + ':' + v1 + '-' + v2;
    }).join(', ');
  }catch(e){
    return src;
  }
}

function reg_publicRotaNextWeeksEvents_(fromYmd, weeks){
  const base = admin_parseYmd_(String(fromYmd || '').trim()) || admin_parseYmd_(admin_todayUkYmd_()) || new Date();
  let start = new Date(base.getTime());
  if (!admin_isSunday_(start)) start = admin_nextSunday_(start);
  const totalWeeks = (Number(weeks) === 12) ? 12 : 8;
  const out = [];
  for (let i=0; i<totalWeeks; i++){
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + (i * 7));
    out.push({ eventKey:'SundayService_' + admin_fmtYmd_(d), dateYmd: admin_fmtYmd_(d) });
  }
  return out;
}

function api_public_rota_view(password, weeks){
  try{
    const inputPass = String(password || '').trim();
    const expected = reg_getPublicRotaPassword_();
    if (!expected) return reg_publicRotaNotConfigured_();
    if (!inputPass || inputPass !== expected){
      return { ok:false, code:'E401', zh:'密碼不正確', en:'Invalid password.' };
    }

    const from = admin_todayUkYmd_();
    const weekCount = (Number(weeks) === 12) ? 12 : 8;
    const events = reg_publicRotaNextWeeksEvents_(from, weekCount);
    const matrix = admin_getServingPlanMatrix_(events);
    const eventKeys = (matrix.events || []).map(function(ev){ return String(ev.eventKey || '').trim(); }).filter(Boolean);
    const sermonMap = admin_getSermonInfoForMonth_(eventKeys);

    const positionsOrder = (typeof ADMIN_SERVING_POSITIONS !== 'undefined' && Array.isArray(ADMIN_SERVING_POSITIONS))
      ? ADMIN_SERVING_POSITIONS.slice()
      : [];
    const positionsMetaMap = {};
    (matrix.positions || []).forEach(function(p){
      const key = String((p && p.position) || '').trim();
      if (!key) return;
      positionsMetaMap[key] = p;
    });
    positionsOrder.forEach(function(pos){
      if (!positionsMetaMap[pos]){
        positionsMetaMap[pos] = {
          key: pos,
          position: pos,
          group: (typeof ADMIN_SERVING_POSITION_GROUP === 'object' && ADMIN_SERVING_POSITION_GROUP) ? (ADMIN_SERVING_POSITION_GROUP[pos] || '') : ''
        };
      }
    });

    const rows = (matrix.events || []).map(function(ev){
      const eventKey = String((ev && ev.eventKey) || '').trim();
      const sermon = sermonMap[eventKey] || admin_sermonBlankFromEventKey_(eventKey);
      const rowPositions = {};
      const rowPositionMeta = {};

      positionsOrder.forEach(function(pos){
        const entries = ((((matrix.cells || {})[eventKey] || {})[pos]) || []);
        const maxSlots = Math.max(1, Number((typeof ADMIN_SERVING_POSITION_MAX === 'object' && ADMIN_SERVING_POSITION_MAX) ? (ADMIN_SERVING_POSITION_MAX[pos] || 1) : 1));
        const displayItems = [];
        let hasClosed = false;

        entries.forEach(function(entry){
          const raw = String((entry && entry.rawValue) || '').trim();
          const tokenType = reg_publicRotaTokenType_(raw);
          if (tokenType === 'CLOSED'){
            hasClosed = true;
            return;
          }
          if (tokenType === 'NA'){
            displayItems.push({ textZh:'-', textEn:'-', textPreferred:'-', isVacancy:false });
            return;
          }
          if (tokenType === 'VACANT' || tokenType === 'EMPTY'){
            displayItems.push({ textZh:'空缺', textEn:'Vacant', textPreferred:'Vacant', isVacancy:true });
            return;
          }
          const label = reg_publicRotaMemberLabel_(entry);
          if (!label || (!label.textZh && !label.textEn && !label.textPreferred)){
            displayItems.push({ textZh:'空缺', textEn:'Vacant', textPreferred:'Vacant', isVacancy:true });
            return;
          }
          displayItems.push({
            textZh:label.textZh || '-',
            textEn:label.textEn || '-',
            textPreferred:label.textPreferred || '-',
            isVacancy:false
          });
        });

        if (!hasClosed){
          const inferredVacancy = Math.max(0, maxSlots - entries.length);
          for (let i=0;i<inferredVacancy;i++) displayItems.push({ textZh:'空缺', textEn:'Vacant', textPreferred:'Vacant', isVacancy:true });
        }

        if (hasClosed){
          rowPositions[pos] = [{ textZh:'-', textEn:'-', textPreferred:'-', isVacancy:false }];
          rowPositionMeta[pos] = { isClosed:true };
          return;
        }

        if (!displayItems.length){
          rowPositions[pos] = [{ textZh:'-', textEn:'-', textPreferred:'-', isVacancy:false }];
          rowPositionMeta[pos] = { isClosed:false };
          return;
        }

        const allDash = displayItems.every(function(it){
          return String((it && it.textZh) || '').trim() === '-' && String((it && it.textEn) || '').trim() === '-';
        });
        if (allDash){
          rowPositions[pos] = [{ textZh:'-', textEn:'-', textPreferred:'-', isVacancy:false }];
          rowPositionMeta[pos] = { isClosed:false };
          return;
        }
        rowPositions[pos] = displayItems;
        rowPositionMeta[pos] = { isClosed:false };
      });

      const sermonPassage = (String(sermon.sermonPassageStatus || '').trim() === 'OK')
        ? String(sermon.sermonPassageCanonical || '').trim()
        : String(sermon.sermonPassageRaw || '').trim();
      const responsePassage = (String(sermon.responsePassageStatus || '').trim() === 'OK')
        ? String(sermon.responsePassageCanonical || '').trim()
        : String(sermon.responsePassageRaw || '').trim();

      const sermonPassageZh = sermonPassage || '-';
      const responsePassageZh = responsePassage || '-';
      return {
        eventKey: eventKey,
        dateYmd: String(ev.dateYmd || '').trim(),
        sermonTitle: String(sermon.sermonTitle || '').trim() || '-',
        speaker: String(sermon.speaker || '').trim() || '-',
        sermonPassageZh: sermonPassageZh,
        sermonPassageEn: reg_publicRotaPassageEn_(sermonPassageZh) || sermonPassageZh,
        responsePassageZh: responsePassageZh,
        responsePassageEn: reg_publicRotaPassageEn_(responsePassageZh) || responsePassageZh,
        positions: rowPositions,
        positionMeta: rowPositionMeta
      };
    });

    const positions = positionsOrder.map(function(pos){
      const labelObj = (typeof ADMIN_SERVING_POSITION_LABELS === 'object' && ADMIN_SERVING_POSITION_LABELS) ? (ADMIN_SERVING_POSITION_LABELS[pos] || null) : null;
      return {
        key: pos,
        labelZh: labelObj ? String(labelObj.zh || '').trim() : pos,
        labelEn: labelObj ? String(labelObj.en || '').trim() : pos,
        group: (positionsMetaMap[pos] && positionsMetaMap[pos].group) ? positionsMetaMap[pos].group : ''
      };
    });

    return {
      ok:true,
      version: ROTA_PUBLIC_VERSION,
      weeks: weekCount,
      generatedAt: admin_nowIso_(),
      generatedAtDisplay: reg_clientSafeDateTime_(new Date()),
      positions: positions,
      rows: rows
    };
  }catch(e){
    return regErr_('E_LIVE_ATTENDANCE','直播出席資料載入失敗。','Live attendance data load failed.', e);
  }
}

function api_public_serving_rota(password){
  try{
    const provided = String(password || '');
    const expected = reg_getPublicRotaPassword_();
    if (!expected) return reg_publicRotaNotConfigured_();
    if (!provided || provided !== expected){
      return { ok:false, code:'E401', zh:'認證失敗', en:'Authentication failed.' };
    }

    const todayYmd = admin_todayUkYmd_();
    const today = admin_parseYmd_(todayYmd) || new Date();
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const endExclusive = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1));
    let startSunday = new Date(monthStart.getTime());
    if (!admin_isSunday_(startSunday)) startSunday = admin_nextSunday_(startSunday);

    const events = [];
    for (let d = new Date(startSunday.getTime()); d.getTime() < endExclusive.getTime(); d.setUTCDate(d.getUTCDate() + 7)){
      if (!admin_isSunday_(d)) continue;
      const ymd = admin_fmtYmd_(d);
      events.push({ eventKey:'SundayService_' + ymd, dateYmd: ymd });
    }

    const matrix = admin_getServingPlanMatrix_(events);
    const positions = Array.isArray(matrix.positions) ? matrix.positions : [];
    const cells = matrix.cells || {};

    function monthForEvent_(eventObj){
      return admin_fmtYm_(admin_parseYmd_(eventObj.dateYmd) || monthStart);
    }
    function normalizeCell_(entry){
      const raw = String((entry && entry.rawValue) || '').trim();
      const upper = raw.toUpperCase();
      if (!raw || upper === 'VACANT' || upper === 'VACANCY'){
        return { text:'', isVacancy:true };
      }
      if (admin_isServingNaValue_(raw) || admin_isServingClosedValue_(raw)){
        return { text:'-', isVacancy:false };
      }
      const display = String((entry && (entry.preferredName || entry.nameZh || entry.nameEn || entry.memberId)) || '').trim();
      return display ? { text:display, isVacancy:false } : { text:'', isVacancy:true };
    }

    const monthsMap = {};
    const monthOrder = [];
    events.forEach(function(ev){
      const ym = monthForEvent_(ev);
      if (!monthsMap[ym]){
        monthsMap[ym] = { month:ym, events:[], groupsMap:{} };
        monthOrder.push(ym);
      }
      monthsMap[ym].events.push({ eventKey:ev.eventKey, dateYmd:ev.dateYmd });
    });

    positions.forEach(function(pos){
      const groupKey = admin_normalizeServingGroup_(pos.group || '') || 'other';
      monthOrder.forEach(function(ym){
        const bucket = monthsMap[ym];
        if (!bucket.groupsMap[groupKey]){
          bucket.groupsMap[groupKey] = {
            group: groupKey,
            groupZh: getServingGroupLabelZh_(groupKey),
            groupEn: getServingGroupLabelEn_(groupKey),
            positions:[]
          };
        }
        const byEvent = {};
        bucket.events.forEach(function(ev){
          const list = (((cells[ev.eventKey] || {})[pos.key]) || []).map(normalizeCell_);
          const maxSlots = Math.max(1, Number(ADMIN_SERVING_POSITION_MAX[pos.position] || 1));
          while (list.length < maxSlots){
            list.push({ text:'', isVacancy:true });
          }
          byEvent[ev.eventKey] = list.slice(0, maxSlots);
        });
        bucket.groupsMap[groupKey].positions.push({
          position: pos.position,
          positionZh: admin_servingPositionZh_(pos.position || ''),
          slotsByEvent: byEvent
        });
      });
    });

    const groupOrder = ['worship','media','support','logistic','finance','other'];
    const months = monthOrder.map(function(ym){
      const b = monthsMap[ym];
      const groups = Object.keys(b.groupsMap).sort(function(a,b2){
        return groupOrder.indexOf(a) - groupOrder.indexOf(b2);
      }).map(function(g){
        const x = b.groupsMap[g];
        x.positions.sort(function(a,b2){ return String(a.position||'').localeCompare(String(b2.position||'')); });
        return x;
      });
      return { month:b.month, events:b.events, groups:groups };
    });

    return { ok:true, months:months };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}


function api_reg_log_scanner_e420_public(payload){
  try{
    const p = payload || {};
    regLogActivity_('REG_SCANNER_E420', '', 'E420', {
      stage: String(p.stage || ''),
      diagnostics: p.diagnostics || {},
      deviceId: String(p.deviceId || ''),
      ua: String(p.ua || '')
    });
    return { ok:true };
  }catch(e){
    return { ok:false, code:'E500', zh:'系統錯誤', en:'System error', detail:String(e&&e.message||e) };
  }
}

/******** Greetings helper ********/
function regPickGreetings_(nameZh, nameEn, preferredName){
  const zh = String(nameZh || '').trim();
  const en = String(nameEn || '').trim();
  const pref = String(preferredName || '').trim();

  if (zh && !en) return { greetZh: zh, greetEn: zh };
  if (en && !zh) return { greetZh: en, greetEn: en };
  if (zh && en)  return { greetZh: zh, greetEn: en };

  if (pref) return { greetZh: pref, greetEn: pref };
  return { greetZh: '你好', greetEn: 'there' };
}

/******** Candidate search (email/mobile first, then name fallback) ********/
function api_reg_find_candidates_public(input){
  try{
    const qEmail = regNormEmail_(String((input && input.email) || ''));
    const qMobile = regNormMobile_(String((input && input.mobile) || ''));
    const qNameZh = String((input && input.nameZh) || '').trim();
    const qNameEn = String((input && input.nameEn) || '').trim();

    if (!qEmail && !qMobile && !qNameZh && !qNameEn) return { ok:true, results:[] };

    const ms = regGetMembersScan_();
    const out = [];

    // Pass 1: email/mobile
    for (const r of ms.dataRows){
      const st = regStatus_(r.Status);
      if (st === 'DISABLED') continue;

      const mEmail = regNormEmail_(r.Email);
      const mMobile = regNormMobile_(r.Mobile);

      const emailMatch = !!(qEmail && mEmail && qEmail === mEmail);
      const mobileMatch = !!(qMobile && mMobile && regMobilesMatch_(qMobile, mMobile));

      if (!emailMatch && !mobileMatch) continue;

      out.push(regProjectCandidate_(r, (emailMatch?200:0)+(mobileMatch?120:0), false));
      if (out.length >= 12) break;
    }

    // Pass 2: name fallback if <4
    if (out.length < 4 && (qNameZh || qNameEn)) {
      const qZhKey = regNormName_(qNameZh);
      const qEnTokens = regEnTokens_(qNameEn);

      for (const r of ms.dataRows){
        const st = regStatus_(r.Status);
        if (st === 'DISABLED') continue;
        if (out.some(x => x.id === r.ID)) continue;

        let score = 0;
        if (qZhKey){
          const mZhKey = regNormName_(r.NameZh);
          if (mZhKey && mZhKey.includes(qZhKey)) score += 60;
        }
        if (qEnTokens.length){
          const mEnKey = regNormName_(r.NameEn);
          const ok = qEnTokens.every(t => mEnKey.includes(t));
          if (ok) score += 50;
        }
        if (score <= 0) continue;

        out.push(regProjectCandidate_(r, score, true));
        if (out.length >= 4) break;
      }
    }

    out.sort((a,b)=> (b._score - a._score) || a.id.localeCompare(b.id));
    out.forEach(x => delete x._score);
    return { ok:true, results: out.slice(0,4) };

  } catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function regProjectCandidate_(r, score, nameHit){
  const st = regStatus_(r.Status);
  return {
    id: String(r.ID||'').trim().toUpperCase(),
    nameZh: String(r.NameZh||'').trim(),
    nameEn: String(r.NameEn||'').trim(),
    emailMasked: regMaskEmail_(r.Email),
    mobileMasked: regMaskMobile_(r.Mobile),
    vrmMasked: regMaskVrm_(r.VRM || r.VRM2),
    /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_BEGIN */
    isStaff: (st === 'STAFF' || st === 'ADMIN'),
    /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_END */
    nameHit: !!nameHit,
    _score: score
  };
}

/******** Create / Update / Self Update / Self Lookup ********/

/* ============================================================
 * PATCH_BOUNDARY: REG2_CREATE_DEDUP_BEGIN
 * Prevent accidental double-create (best-effort cache TTL).
 * ============================================================ */
function regCreateDedupKey_(inObj){
  const dev = String((inObj && inObj.deviceId) || '').trim();

  const email = regNormEmail_(String((inObj && inObj.email) || ''));

  // Prefer explicit country-code fields if provided, else use inObj.mobile
  let mobile = '';
  const cc = String((inObj && inObj.phoneCc) || '').replace(/\D/g,'');
  const nat = String((inObj && inObj.phoneNat) || '').replace(/\D/g,'');
  if (cc && nat) mobile = '+' + cc + nat;
  if (!mobile) mobile = regNormMobile_(String((inObj && inObj.mobile) || ''));

  const nameZh = regNormName_(String((inObj && inObj.nameZh) || ''));
  const nameEn = regNormName_(String((inObj && inObj.nameEn) || ''));

  const seed = [dev, email, mobile, nameZh, nameEn].join('|');
  return 'regCreateDedup_' + Utilities.base64EncodeWebSafe(seed).slice(0, 180);
}

function regCreateDedupGet_(key){
  try{
    const raw = CacheService.getScriptCache().get(String(key||''));
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(e){
    return null;
  }
}

function regCreateDedupPut_(key, payloadObj){
  try{
    CacheService.getScriptCache().put(String(key||''), JSON.stringify(payloadObj||{}), 30);
  }catch(e){}
}
/* ============================================================
 * PATCH_BOUNDARY: REG2_CREATE_DEDUP_END
 * ============================================================ */

function api_reg_create_member_public(input){
  const inObj = input || {};
  const deviceId = String(inObj.deviceId||'');
  const ua = String(inObj.ua||'');

  try{
    if (Array.isArray(inObj.familyMembers) && inObj.familyMembers.length){
      return api_reg_create_family_public(inObj);
    }
    // overwrite safety: if existingId provided, route to update
    const existingId = String(inObj.existingId||'').trim().toUpperCase();
    if (/^CCF\d{4}$/.test(existingId)) {
      const res = api_reg_update_by_id_public(existingId, inObj);
      regLogActivity_('REG_OVERWRITE_BY_EXISTINGID', existingId, res.ok ? 'OK' : (res.code||'E500'), { deviceId, ua });
      return res;
    }

    // server-side double-create protection
    const dedupKey = regCreateDedupKey_(inObj);
    const prior = regCreateDedupGet_(dedupKey);
    if (prior && prior.ok && prior.mode === 'CREATE') {
      regLogActivity_('REG_CREATE_DEDUP_HIT', prior.memberId || '', 'OK', { deviceId, ua });
      return prior;
    }

    const v = regValidateInput_(inObj);
    if (!v.ok) { regLogBlock_(v, null, deviceId, ua, 'CREATE_VALIDATE'); return v; }

    const hs = regEnforceHardStops_(v.data, null);
    if (!hs.ok) { regLogBlock_(hs, null, deviceId, ua, 'CREATE_HARDSTOP'); return hs; }

    const g = regPickGreetings_(v.data.nameZh, v.data.nameEn, v.data.preferredName);

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);

    try{
      const ms = regGetMembersScan_({ ensureExtras:true });
      const alloc = regAllocateSmallestIdAndKey_(ms);
      if (!alloc.ok) { regLogBlock_(alloc, null, deviceId, ua, 'CREATE_ALLOC'); return alloc; }

      const ts = regNow_();

      const row = regBuildAppendRow_(ms, {
        ...v.data,
        id: alloc.id,
        key: alloc.key,
        status: 'PENDING',
        memberSince: ts
      });

      ms.sh.appendRow(row);
      regClearMembersIndexCache_();

      const payload = alloc.id + '|' + alloc.key;

      const emailMeta = { optInEmail: !!v.data.optInEmail, emailProvided: !!v.data.email };
      const toEmail = v.data.optInEmail ? v.data.email : '';

      const emailRes = regSendEmails_({
        kind: 'CREATE',
        toEmail,
        oldEmail: '',
        memberId: alloc.id,
        payload,
        greetZh: g.greetZh,
        greetEn: g.greetEn,
        nameZh: v.data.nameZh,
        nameEn: v.data.nameEn,
        deviceHint: regDeviceHint_(inObj),
        changedFields: [],
        isStaff: false,
        includeWhatsApp: true,
        emailOptIn: emailMeta.optInEmail,
        emailProvided: emailMeta.emailProvided
      });

      regLogActivity_('REG_CREATE', alloc.id, 'OK', {
        emailOptIn: emailMeta.optInEmail ? 'YES' : 'NO',
        emailProvided: emailMeta.emailProvided ? 'YES' : 'NO',
        emailSent: emailRes.sentToNew ? 'YES' : 'NO',
        reason: emailRes.reason || '',
        deviceId, ua
      });

      const out = {
        ok:true,
        mode:'CREATE',
        memberId: alloc.id,
        qrPayload: payload,
        email: emailRes,
        emailMeta: emailMeta,
        greet: { zh: g.greetZh, en: g.greetEn }
      };

      // store in dedup cache (best effort)
      regCreateDedupPut_(dedupKey, out);

      return out;

    } finally {
      lock.releaseLock();
    }

  } catch(e){
    const err = regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
    regLogBlock_(err, null, deviceId, ua, 'CREATE_EXCEPTION');
    return err;
  }
}

function regGenerateFamilyId_(ms){
  const used = new Set((ms.dataRows || []).map(function(row){ return String(row.FamilyID||'').trim().toUpperCase(); }).filter(Boolean));
  for (let i=0;i<40;i++){
    const candidate = 'FAM-' + Utilities.getUuid().replace(/-/g,'').slice(0,12).toUpperCase();
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Failed to generate FamilyID');
}
function regAllocateFamilyIdsAndKeys_(ms, count){
  const usedNums = new Set();
  const usedKeys = new Set();
  (ms.dataRows || []).forEach(function(row){
    const hit = String(row.ID||'').match(/^CCF(\d{4})$/);
    if (hit) usedNums.add(parseInt(hit[1],10));
    if (row.Key) usedKeys.add(String(row.Key));
  });
  const out = [];
  let next = REG_MIN_ID_NUM;
  while (out.length < count){
    while (next <= REG_MAX_ID_NUM && usedNums.has(next)) next++;
    if (next > REG_MAX_ID_NUM) return { ok:false, code:'E433', zh:'ID 已用盡（CCF0101–CCF9999）', en:'IDs exhausted (CCF0101–CCF9999).' };
    let key = '';
    for (let tries=0;tries<60;tries++){
      const candidate = regNewKey_();
      if (!usedKeys.has(candidate)){ key = candidate; usedKeys.add(candidate); break; }
    }
    if (!key) return { ok:false, code:'E500', zh:'無法產生 Key', en:'Failed to generate Key.' };
    usedNums.add(next);
    out.push({ id:'CCF' + String(next).padStart(4,'0'), key:key });
    next++;
  }
  return { ok:true, allocations:out };
}
function regEnforceFamilyBatchHardStops_(ms, members){
  const activeRows = (ms.dataRows || []).filter(function(row){ return regStatus_(row.Status) !== 'DISABLED'; });
  const emailBatch = {};
  const nameBatch = {};
  (members || []).forEach(function(data){
    const email = regNormEmail_(data.email);
    if (email) emailBatch[email] = (emailBatch[email] || 0) + 1;
    if (data.nameZh && data.nameEn){
      const key = regNormName_(data.nameZh) + '|' + regNormName_(data.nameEn);
      nameBatch[key] = (nameBatch[key] || 0) + 1;
    }
  });
  for (const email in emailBatch){
    const existing = activeRows.filter(function(row){ return regNormEmail_(row.Email) === email; }).length;
    if (existing + emailBatch[email] > 4){
      return { ok:false, code:'E452', zh:'此電郵已由 4 個未停用的會員記錄使用；請改用另一個電郵或聯絡影音同工。', en:'This email is already used by four non-disabled member records. Use another email or contact Media team.' };
    }
  }
  for (const nameKey in nameBatch){
    const parts = nameKey.split('|');
    const existing = activeRows.filter(function(row){ return regNormName_(row.NameZh) === parts[0] && regNormName_(row.NameEn) === parts[1]; }).length;
    if (existing + nameBatch[nameKey] > 2){
      return { ok:false, code:'E451', zh:'同一中文名 + 英文名 已有 2 個未停用記錄，請聯絡影音同工核實。', en:'This exact Chinese and English name already has two non-disabled records. Contact Media team to verify.' };
    }
  }
  return { ok:true };
}

/**
 * One primary registration plus up to three additional family members.
 * All records validate before a single setValues write under one lock.
 */
function api_reg_create_family_public(input){
  const inObj = input || {};
  const deviceId = String(inObj.deviceId||'');
  const ua = String(inObj.ua||'');
  try{
    const additionalRaw = Array.isArray(inObj.familyMembers) ? inObj.familyMembers : [];
    if (additionalRaw.length < 1 || additionalRaw.length > 3){
      return { ok:false, code:'E465', zh:'家庭成員必須為 1 至 3 位', en:'Add between one and three family members.' };
    }
    const rawMembers = [Object.assign({}, inObj, { familyMembers:undefined })].concat(additionalRaw.map(function(row){
      const item = Object.assign({}, row || {});
      if (!Object.prototype.hasOwnProperty.call(item, 'referredBy')) item.referredBy = inObj.referredBy || '';
      item.deviceId = deviceId;
      item.ua = ua;
      return item;
    }));
    const validated = [];
    for (let i=0;i<rawMembers.length;i++){
      const v = regValidateInput_(rawMembers[i]);
      if (!v.ok){
        v.familyMemberIndex = i;
        v.detail = (i === 0 ? 'Primary member' : ('Family member ' + i));
        regLogBlock_(v, null, deviceId, ua, 'FAMILY_VALIDATE');
        return v;
      }
      validated.push(v.data);
    }

    const familyFingerprint = validated.map(function(member){
      return [regNormName_(member.nameZh), regNormName_(member.nameEn), regNormEmail_(member.email), regNormMobile_(member.mobile)].join('|');
    }).join('::');
    const dedupKey = regCreateDedupKey_(inObj) + '_family_' + validated.length + '_' + Utilities.base64EncodeWebSafe(familyFingerprint).slice(0, 120);
    const prior = regCreateDedupGet_(dedupKey);
    if (prior && prior.ok && prior.mode === 'FAMILY_CREATE') return prior;

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    let created = [];
    let familyId = '';
    try{
      const ms = regGetMembersScan_({ ensureExtras:true });
      const hardStop = regEnforceFamilyBatchHardStops_(ms, validated);
      if (!hardStop.ok){ regLogBlock_(hardStop, null, deviceId, ua, 'FAMILY_HARDSTOP'); return hardStop; }
      const allocation = regAllocateFamilyIdsAndKeys_(ms, validated.length);
      if (!allocation.ok) return allocation;
      familyId = regGenerateFamilyId_(ms);
      const ts = regNow_();
      const rows = validated.map(function(data, index){
        const alloc = allocation.allocations[index];
        const entry = Object.assign({}, data, {
          id:alloc.id,
          key:alloc.key,
          status:'PENDING',
          memberSince:ts,
          familyId:familyId,
          memberLetter:String.fromCharCode(65 + index)
        });
        const greet = regPickGreetings_(data.nameZh, data.nameEn, data.preferredName);
        created.push({
          memberId:alloc.id,
          qrPayload:alloc.id + '|' + alloc.key,
          nameZh:data.nameZh,
          nameEn:data.nameEn,
          preferredName:data.preferredName,
          email:data.email,
          optInEmail:!!data.optInEmail,
          isMinor:!!data.isMinor,
          greet:greet,
          memberLetter:String.fromCharCode(65 + index)
        });
        return regBuildAppendRow_(ms, entry);
      });
      const startRow = Math.max(2, ms.sh.getLastRow() + 1);
      const requiredLast = startRow + rows.length - 1;
      if (requiredLast > ms.sh.getMaxRows()) ms.sh.insertRowsAfter(ms.sh.getMaxRows(), requiredLast - ms.sh.getMaxRows());
      ms.sh.getRange(startRow, 1, rows.length, ms.lastCol).setValues(rows);
      regClearMembersIndexCache_();
      if (typeof admin_clearMembersCache_ === 'function') admin_clearMembersCache_();
    } finally {
      lock.releaseLock();
    }

    const familyEmail = (validated[0].optInEmail && validated[0].email)
      ? validated[0].email
      : ((created.find(function(row){ return row.optInEmail && row.email; }) || {}).email || '');
    const emailRes = regSendFamilyRegistrationEmail_({
      toEmail:familyEmail,
      familyId:familyId,
      members:created,
      deviceHint:regDeviceHint_(inObj)
    });
    regLogActivity_('REG_FAMILY_CREATE', created[0].memberId, 'OK', {
      familyId:familyId,
      memberIds:created.map(function(row){ return row.memberId; }),
      count:created.length,
      emailSent:emailRes.sentToNew ? 'YES' : 'NO',
      deviceId:deviceId,
      ua:ua
    });
    const out = {
      ok:true,
      mode:'FAMILY_CREATE',
      familyId:familyId,
      memberId:created[0].memberId,
      qrPayload:created[0].qrPayload,
      members:created,
      email:emailRes,
      emailMeta:{ optInEmail:!!familyEmail, emailProvided:!!familyEmail },
      greet:created[0].greet
    };
    regCreateDedupPut_(dedupKey, out);
    return out;
  }catch(e){
    const err = regErr_('E500','家庭登記失敗（E500）。','Family registration failed (E500).', e);
    regLogBlock_(err, null, deviceId, ua, 'FAMILY_EXCEPTION');
    return err;
  }
}

function api_reg_update_by_id_public(memberId, input){
  const inObj = input || {};
  const deviceId = String(inObj.deviceId||'');
  const ua = String(inObj.ua||'');

  try{
    const id = String(memberId||'').trim().toUpperCase();
    if (!/^CCF\d{4}$/.test(id)) {
      const r = { ok:false, code:'E416', zh:'CCF ID 格式錯誤（需要 4 位數）', en:'Invalid CCF ID format (requires 4 digits).' };
      regLogBlock_(r, id, deviceId, ua, 'UPDATE_ID_FORMAT');
      return r;
    }

    const v = regValidateInput_(inObj);
    if (!v.ok) { regLogBlock_(v, id, deviceId, ua, 'UPDATE_VALIDATE'); return v; }

    const hs = regEnforceHardStops_(v.data, id);
    if (!hs.ok) { regLogBlock_(hs, id, deviceId, ua, 'UPDATE_HARDSTOP'); return hs; }

    const g = regPickGreetings_(v.data.nameZh, v.data.nameEn, v.data.preferredName);

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);

    try{
      const ms = regGetMembersScan_({ ensureExtras:true });
      const rowNumber = regFindRowByIdFromScan_(ms, id);
      if (!rowNumber) {
        const r = { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };
        regLogBlock_(r, id, deviceId, ua, 'UPDATE_NOTFOUND');
        return r;
      }

      const oldRow = regReadRow_(ms, rowNumber);
      const stOld = regStatus_(oldRow.Status);

      /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_BLOCK_BEGIN */
      if (stOld === 'STAFF' || stOld === 'ADMIN') {
        const r = { ok:false, code:'STAFF', zh:'此為同工/管理員帳號，請聯絡影音同工處理。', en:'This is a staff/admin record. Please contact Media team.' };
        regLogActivity_('REG_BLOCK_STAFF_OVERWRITE', id, 'STAFF', { deviceId, ua });
        return r;
      }
      /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_BLOCK_END */

      if (stOld === 'DISABLED') {
        const r = { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };
        regLogBlock_(r, id, deviceId, ua, 'UPDATE_DISABLED');
        return r;
      }

      const res = regApplyUpdate_(ms, rowNumber, id, stOld, false, v.data, inObj);
      res.greet = { zh: g.greetZh, en: g.greetEn };
      return res;

    } finally {
      lock.releaseLock();
    }

  } catch(e){
    const err = regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
    regLogBlock_(err, String(memberId||''), deviceId, ua, 'UPDATE_EXCEPTION');
    return err;
  }
}

function api_reg_self_update_public(authQrPayload, input){
  const inObj = input || {};
  const deviceId = String(inObj.deviceId||'');
  const ua = String(inObj.ua||'');

  try{
    const parsed = regParseQr_(authQrPayload);
    if (!parsed.ok) { regLogBlock_(parsed, null, deviceId, ua, 'SELF_QR_PARSE'); return parsed; }

    const v = regValidateInput_(inObj);
    if (!v.ok) { regLogBlock_(v, parsed.id, deviceId, ua, 'SELF_VALIDATE'); return v; }

    const hs = regEnforceHardStops_(v.data, parsed.id);
    if (!hs.ok) { regLogBlock_(hs, parsed.id, deviceId, ua, 'SELF_HARDSTOP'); return hs; }

    const g = regPickGreetings_(v.data.nameZh, v.data.nameEn, v.data.preferredName);

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);

    try{
      const ms = regGetMembersScan_({ ensureExtras:true });
      const rowNumber = regFindRowByIdFromScan_(ms, parsed.id);
      if (!rowNumber) {
        const r = { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };
        regLogBlock_(r, parsed.id, deviceId, ua, 'SELF_NOTFOUND');
        return r;
      }

      const oldRow = regReadRow_(ms, rowNumber);
      const stOld = regStatus_(oldRow.Status);
      if (stOld === 'DISABLED') {
        const r = { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };
        regLogBlock_(r, parsed.id, deviceId, ua, 'SELF_DISABLED');
        return r;
      }

      if (String(oldRow.Key||'').trim() !== parsed.key) {
        const r = { ok:false, code:'E418', zh:'舊 QR 已失效或不相符', en:'Old QR invalid/mismatch.' };
        regLogBlock_(r, parsed.id, deviceId, ua, 'SELF_KEY_MISMATCH');
        return r;
      }

      /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_SELF_FLAG_BEGIN */
      const isStaff = (stOld === 'STAFF' || stOld === 'ADMIN');
      /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_SELF_FLAG_END */

      const res = regApplyUpdate_(ms, rowNumber, parsed.id, stOld, isStaff, v.data, inObj);
      res.greet = { zh: g.greetZh, en: g.greetEn };
      return res;

    } finally {
      lock.releaseLock();
    }

  } catch(e){
    const err = regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
    regLogBlock_(err, null, deviceId, ua, 'SELF_EXCEPTION');
    return err;
  }
}

function api_reg_self_lookup_public(qrPayload){
  try{
    const parsed = regParseQr_(qrPayload);
    if (!parsed.ok) return parsed;

    const ms = regGetMembersScan_({ ensureExtras:true });
    const rowNumber = regFindRowByIdFromScan_(ms, parsed.id);
    if (!rowNumber) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

    const r = regReadRow_(ms, rowNumber);
    const st = regStatus_(r.Status);
    if (st === 'DISABLED') return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };

    if (String(r.Key||'').trim() !== parsed.key) return { ok:false, code:'E418', zh:'QR 已失效或不相符', en:'QR invalid/mismatch.' };

    const g = regPickGreetings_(r.NameZh, r.NameEn, r.PreferredName);

    return {
      ok:true,
      member:{
        id: r.ID,
        status: st,
        /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_LOOKUP_BEGIN */
        isStaff: (st === 'STAFF' || st === 'ADMIN'),
        /* PATCH_BOUNDARY: REG1_ADMIN_AS_STAFFLIKE_LOOKUP_END */
        nameZh: String(r.NameZh||'').trim(),
        nameEn: String(r.NameEn||'').trim(),
        preferredName: String(r.PreferredName||'').trim(),
        email: String(r.Email||'').trim(),
        mobile: String(r.Mobile||'').trim(),
        notes: String(r.Notes||'').trim(),
        optInEmail: !regIsOptedOut_(r.OptOutEmail),
        hasCar: String(r.HasCar||'').trim().toUpperCase() === 'YES',
        vrm: regNormalizeVrm_(r.VRM||''),
        vrm2: regNormalizeVrm_(r.VRM2||''),
        isMinor: String(r.IsMinor||'').trim().toUpperCase() === 'YES',
        parentEmail: String(r.ParentEmail||'').trim(),
        familyId: String(r.FamilyID||'').trim(),
        minorServingApprovedGroups: reg_parseServingGroupsCsvSafe_(r.MinorServingApprovedGroups||''),
        minorServingSelfSignup: String(r.MinorServingSelfSignup||'').trim().toUpperCase() === 'YES',
        gender: String(r.Gender||'').trim().toUpperCase(),
        /* PATCH_BOUNDARY: REG2_REFERREDBY_LOOKUP_BEGIN */
        referredBy: String(r.ReferredBy||'').trim(),
        /* PATCH_BOUNDARY: REG2_REFERREDBY_LOOKUP_END */
        greet: { zh: g.greetZh, en: g.greetEn }
      }
    };
  } catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}



function api_reg_self_bootstrap_public(qrPayload){
  try{
    const lookup = api_reg_self_lookup_public(qrPayload);
    if (!lookup || !lookup.ok) return lookup || { ok:false, code:'E500', zh:'系統錯誤', en:'System error.' };
    let snapshot;
    try {
      snapshot = api_reg_self_portal_snapshot_public(qrPayload);
    } catch (snapshotErr) {
      snapshot = {
        ok:false,
        code:'E500',
        subCode:'SELF_PORTAL_SNAPSHOT_FAILED',
        zh:'部分資料暫時未能載入',
        en:'Some dashboard data is temporarily unavailable.',
        detail:String(snapshotErr && snapshotErr.message || snapshotErr)
      };
    }
    if (snapshot && snapshot.ok){
      return { ok:true, member:lookup.member, snapshot:snapshot, warning:null };
    }

    // A valid QR remains usable when optional attendance/serving dashboard
    // data is temporarily unavailable. Keep the failure visible as a warning.
    const m = lookup.member || {};
    const fallbackSnapshot = {
      ok:true,
      partial:true,
      member:{
        id:String(m.id || '').trim().toUpperCase(),
        status:regStatus_(m.status || ''),
        nameZh:String(m.nameZh || ''),
        nameEn:String(m.nameEn || ''),
        preferredName:String(m.preferredName || ''),
        displayName:regDisplayNameForPortal_(m),
        servingGroups:[],
        servingGLGroups:[],
        isGl:false,
        away:{ from1:'', to1:'', from2:'', to2:'' },
        memberSinceEarliest:''
      },
      attendance:{ attended:0, total:0, percent:0, unavailable:true },
      attendanceEvents:{ attendedEventKeys:[] },
      memberSinceEarliest:'',
      upcoming4:[]
    };
    return {
      ok:true,
      member:m,
      snapshot:fallbackSnapshot,
      warning:snapshot || { ok:false, code:'E500', zh:'部分資料暫時未能載入', en:'Some dashboard data is temporarily unavailable.' }
    };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function regGetCheckinsDataMinimal_(){
  const check = (typeof admin_getCheckinsData_ === 'function') ? admin_getCheckinsData_() : null;
  if (!check || !check.ok) return check || { ok:false, code:'E500', zh:'讀取簽到資料失敗', en:'Failed to read checkins.' };
  const rows = (check.rows || []).map(function(r){
    return { eventKey:String(r.eventKey||''), memberId:String(r.memberId||'') };
  });
  return { ok:true, rows: rows };
}

/* ============================================================
 * PATCH_BOUNDARY: REG2_SELF_ATTENDANCE_BEGIN
 * Self attendance endpoint (self-only).
 * ============================================================ */
function api_reg_self_attendance_public(qrPayload, fromYmdOptional, toYmdOptional){
  try{
    const parsed = regParseQr_(qrPayload);
    if (!parsed.ok) return parsed;

    const ms = regGetMembersScan_({ ensureExtras:true });
    const rowNumber = regFindRowByIdFromScan_(ms, parsed.id);
    if (!rowNumber) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

    const r = regReadRow_(ms, rowNumber);
    const st = regStatus_(r.Status);
    if (st === 'DISABLED') return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };

    if (String(r.Key||'').trim() !== parsed.key) return { ok:false, code:'E418', zh:'QR 已失效或不相符', en:'QR invalid/mismatch.' };

    // Date range (default last ~183 days)
    const todayUk = Utilities.formatDate(regNow_(), 'Europe/London', 'yyyy-MM-dd');
    const today = regParseYmdUtc_(todayUk) || new Date();
    let from = null;
    let to = null;

    if (fromYmdOptional && toYmdOptional){
      from = regParseYmdUtc_(String(fromYmdOptional||''));
      to = regParseYmdUtc_(String(toYmdOptional||''));
      if (!from || !to){
        return { ok:false, code:'E422', zh:'日期格式錯誤（YYYY-MM-DD）', en:'Invalid date format (YYYY-MM-DD).' };
      }
      if (to.getTime() < from.getTime()){
        return { ok:false, code:'E423', zh:'結束日期不可早於開始日期', en:'End date cannot be before start date.' };
      }
    } else {
      to = today;
      from = new Date(to.getTime() - (183*24*60*60*1000));
    }

    // Denominator start = max(Member_Since, from)
    let denomFrom = from;
    const joinRaw = r.Member_Since || '';
    const joinDt = regSafeToDate_(joinRaw);
    if (joinRaw && !joinDt){
      regLogActivity_('REG_SELF_ATTENDANCE_INVALID_MEMBER_SINCE', parsed.id, 'WARN', { joinRaw: String(joinRaw) });
    }
    if (joinDt){
      const joinUtc = new Date(Date.UTC(joinDt.getFullYear(), joinDt.getMonth(), joinDt.getDate()));
      if (joinUtc.getTime() > denomFrom.getTime()) denomFrom = joinUtc;
    }

    const check = regGetCheckinsDataMinimal_();
    if (!check.ok) return check;

    const serviceSet = new Set();
    const attendedSet = new Set();

    for (const row of check.rows){
      const ev = row.eventKey;
      if (!regIsSundayServiceKey_(ev)) continue;
      const d = regEventDateFromKeyUtc_(ev);
      if (!d) continue;
      if (d.getTime() < denomFrom.getTime() || d.getTime() > to.getTime()) continue;

      serviceSet.add(ev);
      if (row.memberId === parsed.id) attendedSet.add(ev);
    }

    const attendedEventKeys = Array.from(attendedSet).sort((a,b)=>{
      const da = regEventDateFromKeyUtc_(a); const db = regEventDateFromKeyUtc_(b);
      if (da && db) return db.getTime() - da.getTime(); // desc
      return String(b).localeCompare(String(a));
    });

    const attended = attendedEventKeys.length;
    const total = serviceSet.size;
    const percent = (total > 0) ? Math.round((attended/total)*1000)/10 : 0;

    return {
      ok:true,
      range:{
        from: regFmtYmdUtc_(denomFrom),
        to: regFmtYmdUtc_(to)
      },
      member:{
        id: r.ID,
        nameZh: String(r.NameZh||'').trim(),
        nameEn: String(r.NameEn||'').trim(),
        preferredName: String(r.PreferredName||'').trim(),
        memberSince: joinDt ? Utilities.formatDate(joinDt, 'Europe/London', 'yyyy-MM-dd') : ''
      },
      stats:{
        attended: attended,
        total: total,
        percent: percent,
        denomStart: regFmtYmdUtc_(denomFrom)
      },
      attendance:{
        attendedEventKeys: attendedEventKeys
      }
    };

  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}
/* ============================================================
 * PATCH_BOUNDARY: REG2_SELF_ATTENDANCE_END
 * ============================================================ */

/* ============================================================
 * PATCH_BOUNDARY: REG4_SELF_SERVICE_PORTAL_BEGIN
 * Self-service portal APIs.
 * ============================================================ */
function regGetSelfMemberByQr_(qrPayload){
  const parsed = regParseQr_(qrPayload);
  if (!parsed.ok) return parsed;

  const ms = regGetMembersScan_({ ensureExtras:true });
  const rowNumber = regFindRowByIdFromScan_(ms, parsed.id);
  if (!rowNumber) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

  const row = regReadRow_(ms, rowNumber);
  const st = regStatus_(row.Status);
  if (st === 'DISABLED') return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };
  if (String(row.Key||'').trim() !== parsed.key) return { ok:false, code:'E418', zh:'QR 已失效或不相符', en:'QR invalid/mismatch.' };

  return { ok:true, parsed: parsed, ms: ms, rowNumber: rowNumber, row: row };
}


function regGetSelfMemberByIdForAdmin_(memberId){
  const id = String(memberId || '').trim().toUpperCase();
  if (!/^CCF\d{4,}$/.test(id)) return { ok:false, code:'E416', zh:'資料格式錯誤', en:'Invalid member id.' };

  const ms = regGetMembersScan_({ ensureExtras:true });
  const rowNumber = regFindRowByIdFromScan_(ms, id);
  if (!rowNumber) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

  const row = regReadRow_(ms, rowNumber);
  const st = regStatus_(row.Status);
  if (st === 'DISABLED') return { ok:false, code:'E414', zh:'此帳號已停用', en:'Account disabled.' };
  return { ok:true, parsed:{ id:id }, ms:ms, rowNumber:rowNumber, row:row };
}

function reg_getWorshipAuthFromAdminToken_(token){
  if (typeof admin_requireSession_ !== 'function') return { ok:false, code:'E500', zh:'系統設定錯誤', en:'Admin session helper unavailable.' };
  const s = admin_requireSession_(token);
  if (!s || !s.ok) return s || { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };
  const actor = s.actor || {};
  const id = String(actor.id || '').trim().toUpperCase();
  if (!id || id === 'SUPERUSER') return { ok:false, code:'E403', zh:'未能識別會員身份', en:'Unable to identify member account.' };
  return regGetSelfMemberByIdForAdmin_(id);
}

function reg_selfCanAccessAdminPortal_(statusNorm, glGroups){
  const role = String(statusNorm || '').trim().toUpperCase();
  const gl = Array.isArray(glGroups) ? glGroups.filter(Boolean) : [];
  return role === 'STAFF' || role === 'ADMIN' || gl.length > 0 || role === 'GL';
}

function api_reg_issue_admin_handoff_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;

    const id = String((auth.parsed && auth.parsed.id) || '').trim().toUpperCase();
    if (!id) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

    const rowServing = regServingGroupsFromRow_(auth.row);
    const rowGl = rowServing.gl || [];
    const statusNorm = regStatus_((auth.row && auth.row.Status) || '');
    if (!reg_selfCanAccessAdminPortal_(statusNorm, rowGl)){
      return { ok:false, code:'E403', zh:'此管理平台只限已授權同工使用', en:'Admin portal for authorised staff only.' };
    }

    const handoffToken = Utilities.getUuid();
    const payload = {
      memberId: id,
      issuedAt: Date.now(),
      source: 'REG_SELF_PORTAL'
    };
    CacheService.getScriptCache().put(
      REG_ADMIN_HANDOFF_CACHE_PREFIX + handoffToken,
      JSON.stringify(payload),
      REG_ADMIN_HANDOFF_TTL_SECONDS
    );

    return { ok:true, handoffToken: handoffToken, expiresInSeconds: REG_ADMIN_HANDOFF_TTL_SECONDS };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function reg_consumeAdminHandoffToken_(handoffToken){
  const token = String(handoffToken || '').trim();
  if (!token) return { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };

  const cache = CacheService.getScriptCache();
  const key = REG_ADMIN_HANDOFF_CACHE_PREFIX + token;
  const raw = cache.get(key);
  if (!raw) return { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };
  // Do not remove here: admin login removes only after a successful session is created.
  // This avoids consuming the token during failed iframe/top-window navigation attempts.

  let payload = null;
  try{
    payload = JSON.parse(raw);
  }catch(e){
    return { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };
  }

  const id = String((payload && payload.memberId) || '').trim().toUpperCase();
  if (!id) return { ok:false, code:'E_HANDOFF_EXPIRED', zh:'登入連結已過期', en:'Handoff link expired.' };

  return { ok:true, memberId:id, source:String((payload && payload.source) || '') };
}

function reg_removeAdminHandoffToken_(handoffToken){
  const token = String(handoffToken || '').trim();
  if (!token) return;
  try{ CacheService.getScriptCache().remove(REG_ADMIN_HANDOFF_CACHE_PREFIX + token); }catch(e){}
}

function regDisplayNameForPortal_(m){
  const pref = String((m && m.preferredName) || '').trim();
  const en = String((m && m.nameEn) || '').trim();
  const zh = String((m && m.nameZh) || '').trim();
  if (pref) return pref;
  if (en) return en;
  if (zh) return zh;
  return '(' + String((m && m.id) || '').trim().toUpperCase() + ')';
}

function reg_parseServingGroupsCsvSafe_(raw){
  if (typeof admin_parseGroupsCsv_ === 'function') return admin_parseGroupsCsv_(raw);
  return String(raw||'').split(',').map(function(v){ return String(v||'').trim(); }).filter(Boolean);
}

function reg_mergeServingGroups_(groupsA, groupsB){
  return Array.from(new Set([].concat(groupsA || [], groupsB || []).filter(Boolean)));
}

function regServingGroupsFromRow_(row){
  const base = reg_parseServingGroupsCsvSafe_(row && row.ServingGroups);
  const gl = reg_parseServingGroupsCsvSafe_(row && row.ServingGLGroups);
  return {
    serving: base,
    gl: gl,
    merged: reg_mergeServingGroups_(base, gl)
  };
}

function regRefreshMembersCachesForSelfPortal_(){
  try{ regClearMembersIndexCache_(); }catch(e){}
  try{ if (typeof admin_clearMembersCache_ === 'function') admin_clearMembersCache_(); }catch(e){}
}

function regSelfMemberSinceEarliestYmd_(memberId, memberSinceRaw){
  const id = String(memberId||'').trim().toUpperCase();
  let earliest = null;
  const msDt = regSafeToDate_(memberSinceRaw);
  if (msDt){
    earliest = Utilities.formatDate(msDt, 'Europe/London', 'yyyy-MM-dd');
  }

  try{
    const check = admin_getCheckinsData_();
    if (check && check.ok){
      check.rows.forEach(function(r){
        if (r.memberId !== id) return;
        if (!admin_isSundayServiceKey_(r.eventKey)) return;
        const ymd = (String(r.eventKey||'').match(/^SundayService_(\d{4}-\d{2}-\d{2})$/) || [])[1] || '';
        if (!ymd) return;
        if (!earliest || ymd < earliest) earliest = ymd;
      });
    }
  }catch(e){}

  return earliest || '';
}

function regFutureDateYmd_(offsetDays){
  const d = new Date();
  d.setDate(d.getDate() + Number(offsetDays || 0));
  return Utilities.formatDate(d, 'Europe/London', 'yyyy-MM-dd');
}

function regSelfServingEditable_(eventDate){
  if (!eventDate) return false;
  const now = new Date();
  const diffMs = eventDate.getTime() - now.getTime();
  const weeks = diffMs / (7 * 24 * 60 * 60 * 1000);
  return weeks >= 6;
}

function reg_isDuplicateExemptPosition_(position){
  const pos = String(position||'').trim();
  if (!pos) return false;
  try{
    if (typeof ADMIN_SERVING_DUPLICATE_EXEMPT_POSITIONS !== 'undefined' && ADMIN_SERVING_DUPLICATE_EXEMPT_POSITIONS){
      return !!ADMIN_SERVING_DUPLICATE_EXEMPT_POSITIONS[pos];
    }
  }catch(e){}
  return false;
}

function reg_buildServingTokensForWrite_(raw, maxSlots){
  const list = (typeof admin_splitServingValues_ === 'function')
    ? admin_splitServingValues_(raw)
    : String(raw||'').split(',').map(v => String(v||'').trim()).filter(Boolean);
  const out = [];
  for (let i=0;i<Number(maxSlots||0);i++){
    out.push(String(list[i]||'').trim());
  }
  return out;
}

function api_reg_self_portal_snapshot_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;

    const id = auth.parsed.id;
    const mIndex = admin_getMembersIndex_();
    const member = (mIndex && mIndex.byId) ? mIndex.byId[id] : null;
    const rowServing = regServingGroupsFromRow_(auth.row);
    const rowGroups = rowServing.merged;
    const groups = rowGroups.length
      ? rowGroups
      : (member ? reg_mergeServingGroups_(member.servingGroups, member.servingGLGroups) : []);

    const att = api_reg_self_attendance_public(qrPayload, null, null);
    if (!att || !att.ok) return att;

    if (!member && !groups.length) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

    const servingInsights = admin_getServingInsightsForMember_(id) || { byGroup:{} };

    const upcoming4 = [];
    const today = admin_parseYmd_(admin_todayUkYmd_()) || new Date();
    const max4 = new Date(today.getTime() + (28 * 24 * 60 * 60 * 1000));
    Object.keys(servingInsights.byGroup || {}).forEach(function(gk){
      const b = servingInsights.byGroup[gk];
      (b.upcoming || []).forEach(function(it){
        const d = admin_parseYmd_(it.dateYmd || '');
        if (!d || d.getTime() < today.getTime() || d.getTime() > max4.getTime()) return;
        upcoming4.push({ group: gk, eventKey: it.eventKey, dateYmd: it.dateYmd, position: it.position, labelZh: admin_servingPositionZh_(it.position || '') });
      });
    });
    upcoming4.sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); });

    const away = admin_getAwayPeriodForMember_(id) || {};
    const profile = member || {};
    const fallbackProfile = {
      id: id,
      nameZh: String((auth.row && auth.row.NameZh) || '').trim(),
      nameEn: String((auth.row && auth.row.NameEn) || '').trim(),
      preferredName: String((auth.row && auth.row.PreferredName) || '').trim()
    };
    const memberSinceRaw = profile.memberSinceRaw || (auth.row && auth.row.Member_Since);

    const statusNorm = regStatus_((auth.row && auth.row.Status) || (profile.status || ''));
    const glGroupsMerged = rowServing.gl.length
      ? rowServing.gl
      : (member ? reg_mergeServingGroups_(member.servingGLGroups, []) : []);

    const memberSinceEarliest = regSelfMemberSinceEarliestYmd_(id, memberSinceRaw);

    return {
      ok:true,
      member:{
        id: id,
        status: statusNorm,
        nameZh: profile.nameZh || fallbackProfile.nameZh,
        nameEn: profile.nameEn || fallbackProfile.nameEn,
        preferredName: profile.preferredName || fallbackProfile.preferredName,
        displayName: regDisplayNameForPortal_(profile.id ? profile : fallbackProfile),
        servingGroups: groups,
        servingGLGroups: glGroupsMerged,
        isGl: !!(glGroupsMerged.length || statusNorm === 'GL'),
        away:{ from1: away.fromYmd || '', to1: away.toYmd || '', from2: away.from2Ymd || '', to2: away.to2Ymd || '' },
        memberSinceEarliest: memberSinceEarliest
      },
      attendance: att.stats,
      attendanceEvents: att.attendance,
      memberSinceEarliest: memberSinceEarliest,
      upcoming4: upcoming4
    };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function api_reg_self_serving_group_stats_public(qrPayload, groupKey){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;

    const key = admin_normalizeServingGroup_(groupKey);
    if (!key) return { ok:false, code:'E416', zh:'組別格式錯誤', en:'Invalid group key.' };

    const mi = admin_getMembersIndex_();
    const byId = (mi && mi.byId) ? mi.byId : {};
    const selfMember = byId[auth.parsed.id] || null;
    const rowServing = regServingGroupsFromRow_(auth.row);
    const rowGroups = rowServing.merged;
    const selfGroups = (rowGroups.length ? rowGroups : (selfMember ? reg_mergeServingGroups_(selfMember.servingGroups, selfMember.servingGLGroups) : []))
      .map(function(g){ return admin_normalizeServingGroup_(g); }).filter(Boolean);
    if (selfGroups.indexOf(key) < 0){
      return { ok:false, code:'E403', zh:'你不屬於此事奉組別', en:'You are not in this serving group.' };
    }

    const all = Object.keys(byId).map(function(id){ return byId[id]; });
    const members = all
      .filter(function(m){
        const groups = Array.isArray(m.servingGroups) ? m.servingGroups : [];
        return groups.some(function(g){ return admin_normalizeServingGroup_(g) === key; });
      })
      .map(admin_memberLabelCompact_)
      .sort(function(a,b){ return String(a.label||'').localeCompare(String(b.label||'')); });

    return { ok:true, group:key, count:members.length, members:members };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}


function api_reg_self_delete_membership_public(qrPayload, confirmQrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    if (String(qrPayload||'').trim() !== String(confirmQrPayload||'').trim()) {
      return { ok:false, code:'E418', zh:'確認 QR 不相符', en:'Confirmation QR mismatch.' };
    }

    regWriteCell_(auth.ms, auth.rowNumber, 'Status', 'DISABLED');
    regLogActivity_('REG_SELF_DISABLE', auth.parsed.id, 'OK', { reason:'self_delete' });
    regClearMembersIndexCache_();
    if (typeof admin_clearMembersCache_ === 'function') admin_clearMembersCache_();
    return { ok:true, memberId: auth.parsed.id, status:'DISABLED' };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function reg_minorSelfServingPolicy_(member, position){
  if (!member || !member.isMinor) return { ok:true, isMinor:false };
  const group = ADMIN_SERVING_POSITION_GROUP[position] || '';
  const eligible = admin_minorServingEligibility_(member, group);
  if (!eligible.ok) return eligible;
  if (!member.minorServingSelfSignup){
    return regConflict_(
      '此未成年會員未獲允許自行報名或取消，請聯絡組長／同工。',
      'This young member is not permitted to self-sign up or cancel. Contact a GL or staff member.',
      '',
      'MINOR_SELF_SIGNUP_NOT_ALLOWED',
      'MINOR_SERVING'
    );
  }
  return { ok:true, isMinor:true, selfSignup:true };
}

function reg_minorPairingWarningFromValidation_(validation){
  const warnings = validation && Array.isArray(validation.warnings) ? validation.warnings : [];
  if (!warnings.length) return null;
  const first = warnings[0] || {};
  return {
    code:String(first.code || 'MINOR_DIFFERENT_FAMILY_ADULT'),
    zh:String(first.zh || '未有同一家庭成人安排；已由其他成年同工配對'),
    en:String(first.en || 'No adult from the same family is assigned; paired with another adult volunteer.'),
    minorPairing:warnings
  };
}

function api_reg_self_serving_data_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const id = auth.parsed.id;
    const mIndex = admin_getMembersIndex_();
    const member = (mIndex && mIndex.byId) ? mIndex.byId[id] : null;
    const rowServing = regServingGroupsFromRow_(auth.row);
    const rowGroups = rowServing.merged;
    const groups = rowGroups.length
      ? rowGroups
      : (member ? reg_mergeServingGroups_(member.servingGroups, member.servingGLGroups) : []);
    if (!member && !groups.length) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };
    const groupNorm = groups.map(function(g){ return admin_normalizeServingGroup_(g); }).filter(Boolean);
    const isMinor = !!(member && member.isMinor);
    const minorApproved = isMinor ? admin_minorApprovedForGroup_(member, ADMIN_MINOR_SERVING_GROUP) : false;
    const minorSelfSignup = isMinor && !!member.minorServingSelfSignup;
    const insights = admin_getServingInsightsForMember_(id) || { byGroup:{} };

    const summary = [];
    const memberLabelsById = {};
    Object.keys((mIndex && mIndex.byId) ? mIndex.byId : {}).forEach(function(mid){
      memberLabelsById[mid] = admin_memberLabelCompact_(mIndex.byId[mid]).label || mid;
    });
    Object.keys(insights.byGroup || {}).forEach(function(gk){
      const b = insights.byGroup[gk] || {};
      (b.summary || []).forEach(function(s){ summary.push({ position: s.position, labelZh: admin_servingPositionZh_(s.position||''), count: s.count || 0, events: (b.historical||[]).filter(function(h){ return h.position===s.position; }).map(function(h){ return h.eventKey; }) }); });
    });
    summary.sort(function(a,b){ return (b.count||0)-(a.count||0); });

    const from = admin_todayUkYmd_();
    const events = admin_getUpcomingSundayEventKeys_(from, ADMIN_SERVING_MONTHS_AHEAD);
    const matrix = admin_getServingPlanMatrix_(events);
    const filteredPositions = (matrix.positions||[]).filter(function(p){ return groupNorm.indexOf(admin_normalizeServingGroup_(p.group||'')) >= 0; });
    const cells = {};
    (matrix.events||[]).forEach(function(ev){
      cells[ev.eventKey] = {};
      filteredPositions.forEach(function(p){
        const entries = (((matrix.cells||{})[ev.eventKey]||{})[p.position]||[]);
        const max = ADMIN_SERVING_POSITION_MAX[p.position] || 1;
        const slots = [];
        var isClosed = false;

        (entries || []).forEach(function(e){
          if (slots.length >= max) return;
          const memberId = String((e && e.memberId) || '').trim().toUpperCase();
          const rawVal = String((e && e.rawValue) || '').trim();
          if (admin_isServingClosedValue_(rawVal)){
            isClosed = true;
            return;
          }
          if (memberId){
            slots.push(memberId);
            return;
          }
          if (admin_isServingNaValue_(rawVal)){
            slots.push('N/A');
            return;
          }
          slots.push('');
        });
        while (slots.length < max) slots.push('');

        const canChange = regSelfServingEditable_(admin_eventDateFromKey_(ev.eventKey));
        let canSignup = !isClosed;
        let canSelfRemove = canChange;
        let minorBlockedReason = '';
        let pairing = null;
        if (isMinor){
          const policy = reg_minorSelfServingPolicy_(member, p.position);
          const adultIds = slots.filter(function(mid){
            const assigned = ((mIndex && mIndex.byId) ? mIndex.byId : {})[String(mid||'').trim().toUpperCase()] || null;
            return assigned && !assigned.isMinor && admin_normStatus_(assigned.status) !== 'DISABLED';
          });
          const familyId = String(member.familyId || '').trim();
          const sameFamilyAdultIds = familyId ? adultIds.filter(function(mid){
            const adult = mIndex.byId[String(mid||'').trim().toUpperCase()] || {};
            return String(adult.familyId || '').trim() === familyId;
          }) : [];
          pairing = { adultIds:adultIds, sameFamilyAdultIds:sameFamilyAdultIds, sameFamily:!!sameFamilyAdultIds.length };
          if (!policy.ok){
            canSignup = false;
            canSelfRemove = false;
            minorBlockedReason = String(policy.subCode || policy.code || 'MINOR_SELF_SIGNUP_NOT_ALLOWED');
          }else if (!adultIds.length){
            canSignup = false;
            minorBlockedReason = 'MINOR_ADULT_PAIR_REQUIRED';
          }
        }
        cells[ev.eventKey][p.position] = {
          slots:isClosed ? [] : slots,
          canSignup:canSignup,
          canChange:canChange,
          canSelfRemove:canSelfRemove,
          minorBlockedReason:minorBlockedReason,
          pairing:pairing
        };
      });
    });

    return {
      ok:true,
      member:{
        id:id,
        servingGroups:groups,
        isMinor:isMinor,
        minorServingApproved:minorApproved,
        minorServingSelfSignup:minorSelfSignup,
        canSelfManageMinorServing:!isMinor || (minorApproved && minorSelfSignup)
      },
      summary:summary,
      events:matrix.events||[],
      positions:filteredPositions,
      cells:cells,
      memberLabelsById:memberLabelsById,
      maxMonths:ADMIN_SERVING_MONTHS_AHEAD
    };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function api_reg_public_rota_public(fromDate){
  try{
    const from = String(fromDate || admin_todayUkYmd_()).trim() || admin_todayUkYmd_();
    const events = admin_getUpcomingSundayEventKeys_(from, ADMIN_SERVING_MONTHS_AHEAD) || [];
    const matrix = admin_getServingPlanMatrix_(events);
    const sermonMap = admin_getSermonMapByEventKeys_(events.map(function(ev){ return ev.eventKey; })) || {};

    function normalizeDisplay_(value){
      const s = String(value || '').trim();
      if (!s) return '-';
      const up = s.toUpperCase();
      if (up === 'N/A' || up === 'NA' || up === 'CLOSED') return '-';
      return s;
    }

    function joinCell_(eventKey, position){
      const cellList = (((matrix.cells || {})[eventKey] || {})[position] || []);
      if (!Array.isArray(cellList) || !cellList.length) return '-';
      const vals = cellList.map(function(it){
        const raw = String((it && it.rawValue) || '').trim();
        if (!raw) return '';
        return normalizeDisplay_(raw);
      }).filter(function(v){ return !!v && v !== '-'; });
      if (!vals.length) return '-';
      return vals.join(', ');
    }

    const rows = (matrix.events || []).map(function(ev){
      const eventKey = String((ev && ev.eventKey) || '').trim();
      const sermon = sermonMap[eventKey] || {};
      return {
        eventKey: eventKey,
        dateYmd: String((ev && ev.dateYmd) || '').trim(),
        worshipLead: joinCell_(eventKey, 'Worship_Lead'),
        worshipSinger: joinCell_(eventKey, 'Worship_Singer'),
        worshipPianist: joinCell_(eventKey, 'Worship_Pianist'),
        worshipDrum: joinCell_(eventKey, 'Worship_Drum'),
        worshipInstrument: joinCell_(eventKey, 'Worship_Instrument'),
        bibleReader: joinCell_(eventKey, 'Support_BibleReader'),
        sermonPassage: normalizeDisplay_(String(sermon.sermonPassageCanonical || sermon.sermonPassageRaw || '')),
        responsePassage: normalizeDisplay_(String(sermon.responsePassageCanonical || sermon.responsePassageRaw || ''))
      };
    });

    return { ok:true, fromDate: from, rows: rows };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function api_reg_self_serving_signup_public(qrPayload, eventKey, position, slotIndex){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const id = auth.parsed.id;
    const ev = String(eventKey||'').trim();
    const pos = String(position||'').trim();
    if (!admin_isSundayServiceKey_(ev)) return { ok:false, code:'E416', zh:'活動格式錯誤', en:'Invalid eventKey.' };
    if (ADMIN_SERVING_POSITIONS.indexOf(pos) < 0) return { ok:false, code:'E416', zh:'崗位格式錯誤', en:'Invalid position.' };

    const evDate = admin_eventDateFromKey_(ev);
    const afterChangeCutoff = !regSelfServingEditable_(evDate);

    const mi = admin_getMembersIndex_();
    const member = mi.byId[id];
    if (!member) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };
    if (!admin_memberHasServingGroup_(member, ADMIN_SERVING_POSITION_GROUP[pos] || '')) return regConflict_('你不屬於此事奉組別', 'You are not in this serving group.', '', 'MEMBER_NOT_IN_SERVING_GROUP', 'SERVING_SIGNUP');
    const minorPolicy = reg_minorSelfServingPolicy_(member, pos);
    if (!minorPolicy.ok) return minorPolicy;

    var awayPeriodsMap = admin_getAwayPeriodsMap_([id]) || {};
    var periods = (awayPeriodsMap[id] && awayPeriodsMap[id].periods) ? awayPeriodsMap[id].periods : [];
    const onHoliday = periods.some(function(p){
      const from = admin_parseYmd_(p.fromYmd || '');
      const to = admin_parseYmd_(p.toYmd || '');
      if (!from || !to || !evDate) return false;
      return from.getTime() <= evDate.getTime() && evDate.getTime() <= to.getTime();
    });
    if (onHoliday) return regConflict_('此日期與你的假期重疊，請先刪除或更改假期後再報名。', 'This date overlaps your holiday. Please clear or update your holiday period before signing up.', '', 'HOLIDAY_OVERLAP', 'SERVING_SIGNUP');

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try{
      const sh = admin_ensureServingSheet_();
      admin_ensureServingEventKeys_(sh);
      const rowIndex = admin_findServingEventRowIndex_(sh, ev);
      if (!rowIndex) return { ok:false, code:'E412', zh:'找不到活動', en:'Event not found.' };

      const headerMap = admin_getServingMatrixHeaderMap_(sh);
      const colIndex = headerMap[pos];
      if (!colIndex) return { ok:false, code:'E500', zh:'崗位欄位不存在', en:'Position column not found.' };

      // duplicate guard: same member cannot hold >1 non-exempt position for same event
      const existingPositions = [];
      ADMIN_SERVING_POSITIONS.forEach(function(p){
        const ci = headerMap[p];
        if (!ci) return;
        const idsAtPos = admin_extractMemberIdsFromServingValue_(String(sh.getRange(rowIndex, ci).getValue() || ''));
        if (idsAtPos.indexOf(id) >= 0) existingPositions.push(p);
      });
      const targetIsExempt = reg_isDuplicateExemptPosition_(pos);
      const conflictingExisting = existingPositions.filter(function(p){
        if (p === pos) return false;
        if (reg_isDuplicateExemptPosition_(p)) return false;
        return true;
      });
      if (conflictingExisting.length && !targetIsExempt){
        const dateYmd = ev.replace('SundayService_', '');
        const existingZhList = conflictingExisting.map(function(p){ return admin_servingPositionZh_(p || '') || p; });
        const targetZh = admin_servingPositionZh_(pos || '') || pos;
        return {
          ok:false,
          code:'E409',
          subCode:'DUPLICATE_ASSIGNMENT',
          subGroup:'SERVING_SIGNUP',
          zh:'同一活動不可同時擔任多個崗位',
          en:'Duplicate serving assignments for the same event are not allowed.',
          detail: dateYmd + '｜重覆崗位: ' + existingZhList.join('、') + ' → ' + targetZh
        };
      }

      const raw = String(sh.getRange(rowIndex, colIndex).getValue() || '').trim();
      const ids = admin_extractMemberIdsFromServingValue_(raw);
      const max = ADMIN_SERVING_POSITION_MAX[pos] || 1;
      const idx = Math.max(0, Number(slotIndex||0));
      if (idx >= max) return { ok:false, code:'E416', zh:'空缺序號錯誤', en:'Invalid slot index.' };
      if (ids.indexOf(id) >= 0) return { ok:true, eventKey:ev, position:pos };
      const tokens = reg_buildServingTokensForWrite_(raw, max);
      if (admin_isServingClosedValue_(raw)) return regConflict_('此位置不接受報名', 'This slot is not open for sign up.', '', 'POSITION_CLOSED', 'SERVING_SIGNUP');

      function isSignupOpenToken_(token){
        const v = String(token||'').trim();
        if (!v) return true;
        if (admin_isServingNaValue_(v)) return true;
        return false;
      }

      let targetIdx = idx;
      const currentAtSlot = String(tokens[targetIdx]||'').trim();
      const hasOpenSlot = tokens.some(function(t){ return isSignupOpenToken_(t); });
      if (!hasOpenSlot) return regConflict_('此崗位已滿額', 'This position is full.', '', 'POSITION_FULL', 'SERVING_SIGNUP');

      if (!isSignupOpenToken_(currentAtSlot)){
        const fallbackIdx = tokens.findIndex(function(t){ return isSignupOpenToken_(t); });
        if (fallbackIdx < 0) return regConflict_('此崗位已滿額', 'This position is full.', '', 'POSITION_FULL', 'SERVING_SIGNUP');
        targetIdx = fallbackIdx;
      }

      const targetToken = String(tokens[targetIdx]||'').trim();
      if (!isSignupOpenToken_(targetToken)){
        if (targetToken && /^CCF\d{4}$/i.test(targetToken)){
          return regConflict_('此空缺已被佔用', 'This slot is already occupied.', '', 'SLOT_OCCUPIED', 'SERVING_SIGNUP');
        }
        return regConflict_('此位置不接受報名', 'This slot is not open for sign up.', '', 'POSITION_NOT_OPEN', 'SERVING_SIGNUP');
      }

      tokens[targetIdx] = id;
      const candidateRaw = tokens.join(', ');
      const minorValidation = admin_validateMinorServingValues_((function(){ const out={}; out[pos]=candidateRaw; return out; })(), mi.byId, [pos]);
      if (!minorValidation.ok){
        const first = minorValidation.errors[0] || {};
        return regConflict_(
          String(first.zh || '未成年事奉者必須在同一崗位與成年同工一同服侍'),
          String(first.en || 'A young volunteer must be paired with an adult in the same position.'),
          [first.memberId, first.position].filter(Boolean).join(' · '),
          String(first.code || 'MINOR_ADULT_PAIR_REQUIRED'),
          'MINOR_SERVING'
        );
      }
      sh.getRange(rowIndex, colIndex).setValue(candidateRaw);
      regLogActivity_('REG_SELF_SERVING_SIGNUP', id, 'OK', { eventKey:ev, position:pos, afterCutoff: afterChangeCutoff });
      const pairingWarning = reg_minorPairingWarningFromValidation_(minorValidation);
      return {
        ok:true,
        eventKey:ev,
        position:pos,
        pairing:minorValidation.warnings || [],
        warning: pairingWarning || (afterChangeCutoff
          ? {
              code:'W_CUTOFF',
              zh:'已超過六週更改期限。如需更改或取消，請聯絡組長。',
              en:'The 6-week change/cancel cutoff has passed. Please contact your GL for changes or cancellations.'
            }
          : null)
      };
    } finally {
      lock.releaseLock();
    }
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function api_reg_self_serving_remove_public(qrPayload, eventKey, position){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const id = auth.parsed.id;
    const ev = String(eventKey||'').trim();
    const pos = String(position||'').trim();
    if (!admin_isSundayServiceKey_(ev)) return { ok:false, code:'E416', zh:'活動格式錯誤', en:'Invalid eventKey.' };
    if (ADMIN_SERVING_POSITIONS.indexOf(pos) < 0) return { ok:false, code:'E416', zh:'崗位格式錯誤', en:'Invalid position.' };
    if (!regSelfServingEditable_(admin_eventDateFromKey_(ev))) return regConflict_('六週內不可更改，請聯絡組長', 'Changes within 6 weeks are blocked. Please contact GL.', '', 'CHANGE_CUTOFF_WINDOW', 'SERVING_SIGNUP');

    const mi = admin_getMembersIndex_();
    const member = (mi && mi.byId) ? mi.byId[id] : null;
    if (!member) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };
    const minorPolicy = reg_minorSelfServingPolicy_(member, pos);
    if (!minorPolicy.ok) return minorPolicy;

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try{
      const sh = admin_ensureServingSheet_();
      const rowIndex = admin_findServingEventRowIndex_(sh, ev);
      const headerMap = admin_getServingMatrixHeaderMap_(sh);
      const colIndex = headerMap[pos];
      if (!rowIndex || !colIndex) return { ok:false, code:'E412', zh:'找不到崗位', en:'Position not found.' };

      const raw = String(sh.getRange(rowIndex, colIndex).getValue()||'');
      const max = ADMIN_SERVING_POSITION_MAX[pos] || 1;
      const tokens = reg_buildServingTokensForWrite_(raw, max);
      const next = tokens.map(function(t){ return String(t||'').trim().toUpperCase() === id ? 'N/A' : t; });
      const candidateRaw = next.join(', ');
      const minorValidation = admin_validateMinorServingValues_((function(){ const out={}; out[pos]=candidateRaw; return out; })(), mi.byId, [pos]);
      if (!minorValidation.ok){
        const first = minorValidation.errors[0] || {};
        return regConflict_(
          String(first.zh || '取消後會令未成年事奉者失去同崗位成年同工配對'),
          String(first.en || 'This cancellation would leave a young volunteer without an adult in the same position.'),
          [first.memberId, first.position].filter(Boolean).join(' · '),
          String(first.code || 'MINOR_ADULT_PAIR_REQUIRED'),
          'MINOR_SERVING'
        );
      }
      sh.getRange(rowIndex, colIndex).setValue(candidateRaw);
      regLogActivity_('REG_SELF_SERVING_REMOVE', id, 'OK', { eventKey:ev, position:pos });
      return { ok:true, eventKey:ev, position:pos, warning:reg_minorPairingWarningFromValidation_(minorValidation), pairing:minorValidation.warnings || [] };
    } finally {
      lock.releaseLock();
    }
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}


function reg_getSermonInfoByEventKey_(eventKey){
  const ev = String(eventKey || '').trim();
  const out = {
    eventKey: ev,
    speaker:'',
    sermonTitle:'',
    sermonPassageRaw:'',
    sermonPassageCanonical:'',
    sermonPassageStatus:'EMPTY',
    responsePassageRaw:'',
    responsePassageCanonical:'',
    responsePassageStatus:'EMPTY'
  };
  if (!/^SundayService_\d{4}-\d{2}-\d{2}$/.test(ev)) return out;
  try{
    if (typeof admin_getSermonRecordByEventKey_ === 'function'){
      const rec = admin_getSermonRecordByEventKey_(ev) || {};
      out.speaker = String(rec.speaker || '').trim();
      out.sermonTitle = String(rec.sermonTitle || '').trim();
      out.sermonPassageRaw = String(rec.sermonPassageRaw || '').trim();
      out.sermonPassageCanonical = String(rec.sermonPassageCanonical || '').trim();
      out.sermonPassageStatus = String(rec.sermonPassageStatus || '').trim() || 'EMPTY';
      out.responsePassageRaw = String(rec.responsePassageRaw || '').trim();
      out.responsePassageCanonical = String(rec.responsePassageCanonical || '').trim();
      out.responsePassageStatus = String(rec.responsePassageStatus || '').trim() || 'EMPTY';
      return out;
    }
  }catch(e){}
  return out;
}
function reg_buildCurrentServiceSermonBlock_(eventKey){
  const info = reg_getSermonInfoByEventKey_(eventKey);
  const entries = [];
  if (info.speaker) entries.push({ key:'speaker', labelZh:'講員', labelEn:'Speaker', text:info.speaker, clickable:false });
  if (info.sermonTitle) entries.push({ key:'sermonTitle', labelZh:'講題', labelEn:'Sermon title', text:info.sermonTitle, clickable:false });
  if (info.sermonPassageCanonical && info.sermonPassageStatus === 'OK') entries.push({ key:'sermonPassage', labelZh:'講道經文', labelEn:'Sermon passage', text:info.sermonPassageCanonical, canonical:info.sermonPassageCanonical, clickable:true });
  else if (info.sermonPassageRaw) entries.push({ key:'sermonPassage', labelZh:'講道經文', labelEn:'Sermon passage', text:info.sermonPassageRaw, clickable:false });
  if (info.responsePassageCanonical && info.responsePassageStatus === 'OK') entries.push({ key:'responsePassage', labelZh:'回應經文', labelEn:'Response passage', text:info.responsePassageCanonical, canonical:info.responsePassageCanonical, clickable:true });
  else if (info.responsePassageRaw) entries.push({ key:'responsePassage', labelZh:'回應經文', labelEn:'Response passage', text:info.responsePassageRaw, clickable:false });
  return { hasData: entries.length > 0, entries: entries, raw: info };
}
function api_reg_sermon_info(eventKey){
  try{
    const b = reg_buildCurrentServiceSermonBlock_(eventKey);
    return { ok:true, eventKey:String(eventKey||''), hasData:b.hasData, entries:b.entries, sermon:b.raw };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}
function reg_bibleCacheKey_(canonicalRef, version){
  return REG_BIBLE_CACHE_PREFIX + encodeURIComponent(String(version||'unv').toLowerCase()) + '_' + Utilities.base64EncodeWebSafe(String(canonicalRef||''));
}
function api_reg_bible_text(canonicalRef, version){
  try{
    const ref = String(canonicalRef || '').trim();
    const ver = String(version || 'unv').trim().toLowerCase() || 'unv';
    if (!ref) return { ok:false, code:'E713', zh:'經文格式錯誤', en:'Invalid reference format.', canonical:'', version:ver, verses:[] };
    const cache = CacheService.getScriptCache();
    const key = reg_bibleCacheKey_(ref, ver);
    const hit = cache.get(key);
    if (hit){
      const parsed = JSON.parse(hit);
      parsed.cached = true;
      return parsed;
    }
    const fetched = bible_fetchReferenceText_(ref, ver);
    if (fetched && fetched.ok) cache.put(key, JSON.stringify(fetched), REG_BIBLE_CACHE_TTL);
    return fetched;
  }catch(e){
    return { ok:false, code:'E715', zh:'抓取經文失敗', en:'Bible fetch failed.', detail:String(e&&e.message||e), canonical:String(canonicalRef||''), version:String(version||'unv'), verses:[] };
  }
}

function reg_liveCacheGet_(key){
  try{ var v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; }catch(e){ return null; }
}
function reg_liveCachePut_(key, val, ttlSec){
  try{ CacheService.getScriptCache().put(key, JSON.stringify(val), Number(ttlSec||30)); }catch(e){}
}

/* PATCH_BOUNDARY: SAILOR_SATURN_LIVE_SERVICE_BEGIN */
function reg_isSailorSaturnAllowed_(memberId){
  const id = String(memberId || '').trim().toUpperCase();
  return id === 'CCF0001' || id === 'CCF0137';
}

function reg_getNext4SundayEvents_(){
  const todayYmd = admin_todayUkYmd_();
  return admin_getUpcomingSundayEventKeys_(todayYmd, 4) || [];
}

function reg_buildLiveServiceEntry_(eventKey, byId, prefetched){
  const ev = String(eventKey || '').trim();
  const memberById = byId || {};
  const pre = prefetched || {};
  let servingRaw = [];
  if (ev && pre.servingMatrix){
    const matrix = pre.servingMatrix || {};
    const posMeta = pre.positionMetaByKey || {};
    const cellsByEvent = (((matrix.cells || {})[ev]) || {});
    const positions = (matrix.positions || []).map(function(p){ return String((p && p.position) || '').trim(); }).filter(Boolean);
    positions.forEach(function(position){
      const meta = posMeta[position] || {};
      const entries = cellsByEvent[position] || [];
      entries.forEach(function(entry){
        const e = entry || {};
        const memberId = String(e.memberId || '').trim().toUpperCase();
        const m = memberById[memberId] || {};
        servingRaw.push({
          eventKey: ev,
          group: String(meta.group || ''),
          position: position,
          rawValue: String(e.rawValue || ''),
          memberId: memberId,
          nameZh: String(e.nameZh || m.nameZh || '').trim(),
          nameEn: String(e.nameEn || m.nameEn || '').trim()
        });
      });
    });
  }else{
    servingRaw = ev ? admin_getServingForEvent_(ev, memberById, null, false) : [];
  }
  const serving = servingRaw.map(function(r){
    const m = memberById[String(r.memberId||'').trim().toUpperCase()] || {};
    const genderRaw = String(m.gender || m.Gender || '').trim().toUpperCase();
    const suffixZh = (genderRaw === 'M' || genderRaw === 'MALE' || genderRaw === '男') ? '弟兄'
      : ((genderRaw === 'F' || genderRaw === 'FEMALE' || genderRaw === '女') ? '姊妹' : '');
    const suffixEn = (genderRaw === 'M' || genderRaw === 'MALE' || genderRaw === '男') ? 'Brother'
      : ((genderRaw === 'F' || genderRaw === 'FEMALE' || genderRaw === '女') ? 'Sister' : '');
    const nameZh = String(r.nameZh||'').trim();
    const nameEn = String(r.nameEn||'').trim();
    return {
      eventKey: r.eventKey,
      group: admin_normalizeServingGroup_(r.group || ''),
      groupZh: getServingGroupLabelZh_(r.group || ''),
      groupEn: getServingGroupLabelEn_(r.group || ''),
      position: r.position,
      positionZh: admin_servingPositionZh_(r.position || ''),
      positionEn: admin_servingPositionLabel_(r.position || ''),
      rawValue: String(r.rawValue || ''),
      memberId: String(r.memberId || ''),
      nameZh: nameZh,
      nameEn: nameEn,
      suffixZh: suffixZh,
      suffixEn: suffixEn,
      displayName: [nameZh, nameEn].filter(Boolean).join(' / ') + (suffixZh || suffixEn ? (' · ' + [suffixZh, suffixEn].filter(Boolean).join(' / ')) : '')
    };
  });

  const worshipSongsThisWeek = [];
  if (ev){
    var songs = {};
    if (pre.worshipMap && pre.worshipMap[ev]){
      songs = pre.worshipMap[ev] || {};
    }else{
      const worshipCacheKey = 'reg_live_worship_' + ev;
      songs = reg_liveCacheGet_(worshipCacheKey);
      if (!songs){
        const planningMap = reg_getWorshipPlanningMapByEventKeys_([ev]);
        songs = planningMap[ev] || {};
        reg_liveCachePut_(worshipCacheKey, songs, 45);
      }
    }
    [
      { section:'WORSHIP_MAIN_1', labelZh:'敬拜 1', labelEn:'Main 1' },
      { section:'WORSHIP_MAIN_2', labelZh:'敬拜 2', labelEn:'Main 2' },
      { section:'WORSHIP_MAIN_3', labelZh:'敬拜 3', labelEn:'Main 3' },
      { section:'WORSHIP_MAIN_4', labelZh:'敬拜 4', labelEn:'Main 4' },
      { section:'WORSHIP_RESPONSE_1', labelZh:'回應 1', labelEn:'Response 1' },
      { section:'WORSHIP_RESPONSE_2', labelZh:'回應 2', labelEn:'Response 2' }
    ].forEach(function(meta){
      const sec = songs[meta.section] || {};
      worshipSongsThisWeek.push({
        section: meta.section,
        labelZh: meta.labelZh,
        labelEn: meta.labelEn,
        songTitle: String(sec.songTitle || '').trim()
      });
    });
  }

  var sermonCacheKey = 'reg_live_sermon_' + String(ev || '');
  var hit = reg_liveCacheGet_(sermonCacheKey);
  var sermonBlock = hit;
  if (!sermonBlock){
    sermonBlock = reg_buildCurrentServiceSermonBlock_(ev);
    reg_liveCachePut_(sermonCacheKey, sermonBlock, 45);
  }

  return {
    sermonBlock: sermonBlock,
    servingThisWeek: serving,
    worshipSongsThisWeek: worshipSongsThisWeek
  };
}

function reg_resolveExportDisplayNameZh_(entry, byId, warnings){
  const e = entry || {};
  const memberById = byId || {};
  const warns = Array.isArray(warnings) ? warnings : [];
  const raw = String(e.rawValue || e.value || '').trim();
  const mid = String(e.memberId || '').trim().toUpperCase();
  const member = mid ? (memberById[mid] || {}) : {};
  const zh = String(e.nameZh || member.nameZh || member.NameZh || '').trim();
  const en = String(e.nameEn || member.nameEn || member.NameEn || '').trim();
  const preferred = String(e.preferredName || member.preferredName || member.PreferredName || '').trim();

  var base = zh || '';
  if (!base) base = String(e.nameZh || '').trim();
  if (!base) base = en;
  if (!base) base = preferred;
  if (!base) base = raw;
  if (!base) base = mid;

  if (!zh && (mid || raw)) warns.push('Chinese name unavailable for ' + (mid || raw));

  const titled = /(牧師|傳道|弟兄|姊妹)$/.test(base);
  if (titled) return base;

  const genderRaw = String(member.gender || member.Gender || '').trim().toLowerCase();
  if (genderRaw === 'male' || genderRaw === 'm' || genderRaw === '男') return base + '弟兄';
  if (genderRaw === 'female' || genderRaw === 'f' || genderRaw === '女') return base + '姊妹';
  return base;
}

function reg_csvEscape_(value){
  const s = String(value == null ? '' : value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function reg_csvDateZh_(ymd){
  const m = String(ymd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd || '');
  return String(Number(m[1])) + '年' + String(Number(m[2])) + '月' + String(Number(m[3])) + '日';
}

function api_reg_self_sailor_saturn_csv_public(qrPayload, whichMonth){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const memberId = String((auth && auth.parsed && auth.parsed.id) || '').trim().toUpperCase();
    if (!reg_isSailorSaturnAllowed_(memberId)) return { ok:false, code:'E403', zh:'沒有權限', en:'Not authorised.' };

    const mode = String(whichMonth || 'THIS').trim().toUpperCase();
    const now = new Date();
    const year = Number(Utilities.formatDate(now, 'Europe/London', 'yyyy'));
    const month = Number(Utilities.formatDate(now, 'Europe/London', 'M'));
    const targetYear = (mode === 'NEXT' && month === 12) ? (year + 1) : year;
    const targetMonth = (mode === 'NEXT') ? ((month % 12) + 1) : month;

    const d = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
    const events = [];
    while (Number(Utilities.formatDate(d, 'Europe/London', 'M')) === targetMonth){
      if (Utilities.formatDate(d, 'Europe/London', 'u') === '7'){
        const ymd = Utilities.formatDate(d, 'Europe/London', 'yyyy-MM-dd');
        events.push({ eventKey:'SundayService_' + ymd, dateYmd: ymd });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    const matrix = admin_getServingPlanMatrix_(events) || {};
    const membersIndex = admin_getMembersIndex_() || {};
    const byId = membersIndex.byId || {};
    const sermonMap = admin_getSermonMapByEventKeys_(events.map(function(ev){ return ev.eventKey; })) || {};
    const warnings = [];

    function isSkipToken_(raw){
      const up = String(raw || '').trim().toUpperCase();
      return !up || up === 'N/A' || up === 'NA' || up === 'CLOSED' || up === '__CLOSED__' || up.indexOf('CLOSED') === 0;
    }

    function collectNames_(eventKey, position){
      const list = ((((matrix.cells || {})[eventKey] || {})[position]) || []);
      return list.map(function(entry){
        const raw = String((entry && entry.rawValue) || '').trim();
        if (isSkipToken_(raw)) return '';
        return reg_resolveExportDisplayNameZh_(entry, byId, warnings);
      }).filter(Boolean).join('+');
    }

    function speakerName_(eventKey){
      const sermon = sermonMap[eventKey] || {};
      const raw = String(sermon.speaker || '').trim();
      if (!raw) return '';
      if (/(牧師|傳道|弟兄|姊妹)/.test(raw)) return raw;
      const hit = Object.keys(byId).find(function(mid){
        const m = byId[mid] || {};
        return raw === String(m.nameZh || '').trim() || raw === String(m.nameEn || '').trim() || raw === String(m.preferredName || '').trim();
      });
      if (hit){
        return reg_resolveExportDisplayNameZh_({ memberId:hit, rawValue:raw }, byId, warnings);
      }
      return raw;
    }

    function otherField_(eventKey){
      const prayer = collectNames_(eventKey, 'Support_Prayer');
      const testimony = collectNames_(eventKey, 'Support_Testimony');
      const communion = collectNames_(eventKey, 'Support_Communion');
      const parts = [];
      if (prayer) parts.push('祈禱：' + prayer);
      if (testimony) parts.push('見證：' + testimony);
      if (communion) parts.push('聖餐：' + communion);
      return parts.join('；');
    }

    function passageValue_(eventKey, kind){
      const sermon = sermonMap[eventKey] || {};
      if (kind === 'SERMON'){
        return String(sermon.sermonPassageCanonical || sermon.sermonPassageRaw || '').trim();
      }
      if (kind === 'RESPONSE'){
        return String(sermon.responsePassageCanonical || sermon.responsePassageRaw || '').trim();
      }
      return '';
    }

    const header = '日期,講員,領詩,司琴,和唱,讀經,講道經文,回應經文,場務,招待,PPT,影音,茶水,其他';
    const rows = events.slice().sort(function(a,b){ return String(a.dateYmd||'').localeCompare(String(b.dateYmd||'')); }).map(function(ev){
      const eventKey = String(ev.eventKey || '').trim();
      const cols = [
        reg_csvDateZh_(ev.dateYmd),
        speakerName_(eventKey),
        collectNames_(eventKey, 'Worship_Lead'),
        collectNames_(eventKey, 'Worship_Pianist'),
        collectNames_(eventKey, 'Worship_Singer'),
        collectNames_(eventKey, 'Support_BibleReader'),
        passageValue_(eventKey, 'SERMON'),
        passageValue_(eventKey, 'RESPONSE'),
        collectNames_(eventKey, 'Logistic_Venue'),
        collectNames_(eventKey, 'Logistic_Welcome'),
        collectNames_(eventKey, 'Media_PPT'),
        collectNames_(eventKey, 'Media_AV'),
        collectNames_(eventKey, 'Logistic_Refreshment'),
        otherField_(eventKey)
      ];
      return cols.map(reg_csvEscape_).join(',');
    });

    const csv = '\ufeff' + [header].concat(rows).join('\n');
    const yyyyMm = String(targetYear) + '-' + (targetMonth < 10 ? ('0'+targetMonth) : String(targetMonth));
    return {
      ok:true,
      filename:'CCF_SailorSaturn_' + yyyyMm + '.csv',
      mimeType:'text/csv;charset=utf-8',
      base64: Utilities.base64Encode(Utilities.newBlob(csv, 'text/csv;charset=utf-8').getBytes()),
      warnings: warnings
    };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}
/* PATCH_BOUNDARY: SAILOR_SATURN_LIVE_SERVICE_END */

function api_reg_self_live_service_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;

    const todayYmd = admin_todayUkYmd_();
    const today = admin_parseYmd_(todayYmd) || new Date();
    const todayDow = today.getDay();
    const offsetToPrevSunday = (todayDow === 0) ? 7 : todayDow;
    const prevSunday = new Date(today.getTime() - offsetToPrevSunday*24*60*60*1000);
    const prevYmd = admin_fmtYmd_(prevSunday);

    const events = (reg_getNext4SundayEvents_() || []).slice(0, 4);
    const next = (events && events.length) ? events[0].eventKey : '';
    const last = prevYmd ? ('SundayService_' + prevYmd) : '';
    const offeringMap = (typeof admin_getOfferingMap_ === 'function') ? admin_getOfferingMap_() : {};

    const mi = admin_getMembersIndex_() || {};
    const byId = mi.byId || {};
    const countByEvent = {};
    const breakdownByEvent = {};
    // New Friend handling must be reflected immediately, so the classification
    // is rebuilt from the cached Checkins source instead of caching the derived flag.
    const check = (typeof admin_getCheckinsDataCached_ === 'function') ? admin_getCheckinsDataCached_() : admin_getCheckinsData_();
    if (check && check.ok){
      const firstSundayByMember = {};
      check.rows.forEach(function(r){
        if (!admin_isSundayServiceKey_(r.eventKey) || !r.memberId) return;
        const prev = firstSundayByMember[r.memberId];
        if (!prev || String(r.eventKey) < prev) firstSundayByMember[r.memberId] = String(r.eventKey);
      });
      check.rows.forEach(function(r){
        if (!admin_isSundayServiceKey_(r.eventKey)) return;
        if (r.eventKey !== next && r.eventKey !== last) return;
        if (!countByEvent[r.eventKey]) countByEvent[r.eventKey] = new Set();
        countByEvent[r.eventKey].add(r.memberId);
      });
      [next,last].forEach(function(ev){
        const set = countByEvent[ev] || new Set();
        var total = 0, newFriend = 0;
        set.forEach(function(mid){
          total++;
          const st = regStatus_((((mi||{}).byId||{})[mid] || {}).status || '');
          let classification = null;
          if (typeof classifyNewFriendFromFirstEvent_ === 'function'){
            classification = classifyNewFriendFromFirstEvent_(ev, mid, st, firstSundayByMember[mid] || ev);
          }else{
            const suppressed = (typeof isNewFriendSuppressed_ === 'function') ? isNewFriendSuppressed_(ev, mid) : false;
            classification = { isNewFriend:firstSundayByMember[mid] === ev && st !== 'STAFF' && st !== 'ADMIN' && !suppressed };
          }
          if (classification && classification.isNewFriend) newFriend++;
        });
        breakdownByEvent[ev] = { totalAttendance:total, newFriendCount:newFriend, existingChurchgoerCount:Math.max(0, total-newFriend) };
      });
    }

    const eventKeys = events.map(function(ev){ return String((ev && ev.eventKey) || '').trim(); }).filter(Boolean);
    const servingMatrix = admin_getServingPlanMatrix_(events) || {};
    const positionMetaByKey = {};
    (servingMatrix.positions || []).forEach(function(p){
      const key = String((p && p.position) || '').trim();
      if (!key) return;
      positionMetaByKey[key] = p || {};
    });
    const worshipMap = reg_getWorshipPlanningMapByEventKeys_(eventKeys);
    const servicesByEvent = {};
    const serviceOptions = (events || []).map(function(ev){
      const ek = String((ev && ev.eventKey) || '').trim();
      const ymd = String((ev && ev.dateYmd) || '').trim() || ek.replace('SundayService_', '');
      servicesByEvent[ek] = reg_buildLiveServiceEntry_(ek, byId, {
        servingMatrix: servingMatrix,
        positionMetaByKey: positionMetaByKey,
        worshipMap: worshipMap
      });
      return { eventKey: ek, dateYmd: ymd, labelZh: ymd, labelEn: ymd };
    }).slice(0, 4);
    const selected = servicesByEvent[next] || { sermonBlock:{ hasData:false, entries:[] }, servingThisWeek:[], worshipSongsThisWeek:[] };

    return {
      ok:true,
      viewerMemberId: String((auth && auth.parsed && auth.parsed.id) || '').trim().toUpperCase(),
      defaultEventKey: next,
      serviceOptions: serviceOptions,
      servicesByEvent: servicesByEvent,
      currentAttendance:Object.assign({ eventKey:next, count: next && countByEvent[next] ? countByEvent[next].size : 0 }, breakdownByEvent[next] || {}),
      lastAttendance:Object.assign({ eventKey:last, count: last && countByEvent[last] ? countByEvent[last].size : 0 }, breakdownByEvent[last] || {}),
      lastOffering:{
        eventKey:last,
        amount: (last && typeof offeringMap[last] === 'number') ? offeringMap[last] : null
      },
      sermonBlock: selected.sermonBlock,
      servingThisWeek: selected.servingThisWeek,
      worshipSongsThisWeek: selected.worshipSongsThisWeek
    };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

const REG_WORSHIP_PLANNING_SHEET = 'Worship_Planning';
const REG_WORSHIP_AUDIT_SHEET = 'Worship_Audit';
const REG_WORSHIP_ALIAS_SHEET = 'Worship_Alias';
const REG_WORSHIP_IMPORT_HEADERS = [
  'EventKey','Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument',
  'WorshipSong1Title','WorshipSong1Key','WorshipSong1Capo','WorshipSong1Version','WorshipSong1Link',
  'WorshipSong2Title','WorshipSong2Key','WorshipSong2Capo','WorshipSong2Version','WorshipSong2Link',
  'WorshipSong3Title','WorshipSong3Key','WorshipSong3Capo','WorshipSong3Version','WorshipSong3Link',
  'WorshipSong4Title','WorshipSong4Key','WorshipSong4Capo','WorshipSong4Version','WorshipSong4Link',
  'ResponseSong1Title','ResponseSong1Key','ResponseSong1Capo','ResponseSong1Version','ResponseSong1Link',
  'ResponseSong2Title','ResponseSong2Key','ResponseSong2Capo','ResponseSong2Version','ResponseSong2Link'
];
const REG_WORSHIP_SECTIONS = ['WORSHIP_MAIN_1','WORSHIP_MAIN_2','WORSHIP_MAIN_3','WORSHIP_MAIN_4','WORSHIP_RESPONSE_1','WORSHIP_RESPONSE_2'];
const WORSHIP_IMPORT_ENGINE_VERSION = '2026-06-15.worship119';


function reg_openSsForWorship_(){
  try{
    if (typeof openSs_ === 'function'){
      const ss = openSs_();
      if (ss) return ss;
    }
  }catch(e){}
  try{
    if (typeof SPREADSHEET_ID !== 'undefined' && SPREADSHEET_ID){
      return SpreadsheetApp.openById(SPREADSHEET_ID);
    }
  }catch(e){}
  return SpreadsheetApp.getActive();
}

function reg_ensureWorshipPlanningSheet_(){
  const ss = reg_openSsForWorship_();
  if (!ss) throw new Error('Spreadsheet unavailable');
  let sh = ss.getSheetByName(REG_WORSHIP_PLANNING_SHEET);
  if (!sh) sh = ss.insertSheet(REG_WORSHIP_PLANNING_SHEET);
  const headers = ['EventKey','SongSection','SongTitle','SongKey','Capo','VersionNote','LinkUrl','LinkTitle','LastUpdatedAt','LastUpdatedByCCFID'];
  const current = (sh.getLastRow() >= 1) ? sh.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  const need = headers.some(function(h, i){ return String(current[i] || '').trim() !== h; });
  if (need) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}


function reg_worshipSectionOrder_(section){
  const sec = String(section || '').trim().toUpperCase();
  const idx = REG_WORSHIP_SECTIONS.indexOf(sec);
  return idx >= 0 ? idx : 999;
}

function reg_worshipEventDateSortKey_(eventKey){
  const ev = String(eventKey || '').trim();
  const m = ev.match(/(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : '9999-99-99';
}

function reg_sortAndDedupWorshipPlanningSheet_(sh){
  const sheet = sh || reg_ensureWorshipPlanningSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const rows = sheet.getRange(2, 1, last - 1, 10).getValues();

  const dedup = {};
  rows.forEach(function(r, idx){
    const ev = String(r[0] || '').trim();
    const sec = String(r[1] || '').trim().toUpperCase();
    if (!ev || REG_WORSHIP_SECTIONS.indexOf(sec) < 0) return;
    const key = ev + '|' + sec;
    dedup[key] = {
      row: [
        ev,
        sec,
        String(r[2] || '').trim(),
        String(r[3] || '').trim(),
        String(r[4] || '').trim(),
        String(r[5] || '').trim(),
        String(r[6] || '').trim(),
        String(r[7] || '').trim(),
        r[8],
        String(r[9] || '').trim().toUpperCase()
      ],
      idx: idx
    };
  });

  const merged = Object.keys(dedup).map(function(k){ return dedup[k]; });
  merged.sort(function(a, b){
    const ar = a.row, br = b.row;
    const da = reg_worshipEventDateSortKey_(ar[0]);
    const db = reg_worshipEventDateSortKey_(br[0]);
    if (da < db) return -1;
    if (da > db) return 1;
    if (String(ar[0]) < String(br[0])) return -1;
    if (String(ar[0]) > String(br[0])) return 1;
    const sa = reg_worshipSectionOrder_(ar[1]);
    const sb = reg_worshipSectionOrder_(br[1]);
    if (sa !== sb) return sa - sb;
    return a.idx - b.idx;
  });

  const out = merged.map(function(x){ return x.row; });
  if (last > 1) sheet.getRange(2, 1, last - 1, 10).clearContent();
  if (out.length) sheet.getRange(2, 1, out.length, 10).setValues(out);
}

function reg_ensureWorshipAuditSheet_(){
  const ss = reg_openSsForWorship_();
  if (!ss) throw new Error('Spreadsheet unavailable');
  let sh = ss.getSheetByName(REG_WORSHIP_AUDIT_SHEET);
  if (!sh) sh = ss.insertSheet(REG_WORSHIP_AUDIT_SHEET);
  const headers = ['Timestamp','ActorCCFID','EventKey','Area','FieldName','OldValue','NewValue','ActionSource','Context'];
  const current = (sh.getLastRow() >= 1) ? sh.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  const need = headers.some(function(h, i){ return String(current[i] || '').trim() !== h; });
  if (need) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}

function reg_isWorshipMember_(member){
  const groups = ((member && member.servingGroups) || []).concat((member && member.servingGLGroups) || []);
  return groups.some(function(g){ return admin_normalizeServingGroup_(g) === 'worship'; });
}

function reg_isWorshipGlOrAdminForWorship_(member, statusNorm){
  const role = String(statusNorm || '').trim().toUpperCase();
  if (role === 'ADMIN' || role === 'SUPERUSER') return reg_isWorshipMember_(member);
  const gl = (member && member.servingGLGroups) || [];
  return gl.some(function(g){ return admin_normalizeServingGroup_(g) === 'worship'; });
}

function reg_clientSafeDateTime_(v){
  if (v === null || v === undefined || v === '') return '';
  const d = regSafeToDate_(v);
  if (!d) return String(v || '');
  return Utilities.formatDate(d, 'Europe/London', 'yyyy-MM-dd HH:mm:ss');
}

function reg_getFutureWorshipEvents_(){
  const today = admin_todayUkYmd_();
  const monthsAhead = (typeof ADMIN_SERVING_MONTHS_AHEAD !== 'undefined' && ADMIN_SERVING_MONTHS_AHEAD)
    ? Math.max(1, Number(ADMIN_SERVING_MONTHS_AHEAD))
    : 6;
  const evs = admin_getUpcomingSundayEventKeys_(today, monthsAhead) || [];
  return evs.map(function(e){
    return { eventKey: e.eventKey, dateYmd: e.dateYmd || '' };
  });
}

function reg_getWorshipPlanningMapByEventKeys_(eventKeys){
  const map = {};
  eventKeys.forEach(function(ev){ map[ev] = {}; });

  const sh = reg_ensureWorshipPlanningSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return map;

  const wanted = {};
  eventKeys.forEach(function(ev){ wanted[ev] = true; });

  const rows = sh.getRange(2, 1, lastRow - 1, 10).getValues();
  rows.forEach(function(r){
    const ev = String(r[0] || '').trim();
    const sec = String(r[1] || '').trim().toUpperCase();
    if (!wanted[ev] || REG_WORSHIP_SECTIONS.indexOf(sec) < 0) return;

    if (!map[ev]) map[ev] = {};
    map[ev][sec] = {
      songTitle: String(r[2] || '').trim(),
      songKey: String(r[3] || '').trim(),
      capo: String(r[4] || '').trim(),
      versionNote: String(r[5] || '').trim(),
      linkUrl: String(r[6] || '').trim(),
      linkTitle: String(r[7] || '').trim(),
      lastUpdatedAt: reg_clientSafeDateTime_(r[8]),
      lastUpdatedBy: String(r[9] || '').trim().toUpperCase()
    };
  });

  return map;
}

function reg_writeWorshipAuditRows_(rows){
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  const sh = reg_ensureWorshipAuditSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, list.length, 9).setValues(list);
}

function reg_tryFetchYoutubeMeta_(url){
  const s = String(url || '').trim();
  if (!/(youtube\.com|youtu\.be)/i.test(s)) return { ok:false };
  try{
    const resp = UrlFetchApp.fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(s) + '&format=json', { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { ok:false };
    const obj = JSON.parse(resp.getContentText() || '{}');
    return { ok:true, title: String(obj.title || '').trim() };
  }catch(e){ return { ok:false }; }
}

function reg_assertWorshipDeps_(){
  const root = (typeof globalThis !== 'undefined') ? globalThis : this;
  const required = [
    'admin_getMembersIndex_',
    'admin_getServingPlanMatrix_',
    'admin_getUpcomingSundayEventKeys_',
    'admin_todayUkYmd_',
    'admin_normalizeServingGroup_'
  ];
  const missing = required.filter(function(name){
    return typeof root[name] !== 'function';
  });
  if (missing.length) throw new Error('Missing dependencies: ' + missing.join(', '));
}

function reg_buildWorshipPagePayload_(auth, includeMembers){
  reg_assertWorshipDeps_();

  const mi = admin_getMembersIndex_();
  const byId = (mi && mi.byId) ? mi.byId : {};
  const cachedMember = byId[auth.parsed.id] || null;
  const rowServing = regServingGroupsFromRow_(auth.row);

  const effectiveMember = cachedMember ? {
    id: cachedMember.id,
    nameZh: cachedMember.nameZh || '',
    nameEn: cachedMember.nameEn || '',
    preferredName: cachedMember.preferredName || '',
    servingGroups: reg_mergeServingGroups_(cachedMember.servingGroups || [], rowServing.serving || []),
    servingGLGroups: reg_mergeServingGroups_(cachedMember.servingGLGroups || [], rowServing.gl || [])
  } : {
    id: auth.parsed.id,
    nameZh: String((auth.row && auth.row.NameZh) || '').trim(),
    nameEn: String((auth.row && auth.row.NameEn) || '').trim(),
    preferredName: String((auth.row && auth.row.PreferredName) || '').trim(),
    servingGroups: rowServing.serving || [],
    servingGLGroups: rowServing.gl || []
  };

  const statusNorm = regStatus_(
    (auth.row && auth.row.Status) ||
    (cachedMember && cachedMember.status) ||
    ''
  );

  if (!reg_isWorshipMember_(effectiveMember)) {
    return {
      ok:false,
      code:'E403',
      zh:'你沒有權限檢視敬拜排期',
      en:'No permission for worship planning.'
    };
  }

  const events = reg_getFutureWorshipEvents_();
  const eventKeys = events.map(function(e){ return e.eventKey; });
  const planningMap = reg_getWorshipPlanningMapByEventKeys_(eventKeys);
  const matrix = admin_getServingPlanMatrix_(events);
  const canGl = reg_isWorshipGlOrAdminForWorship_(effectiveMember, statusNorm);

  function getCellList_(eventKey, position){
    const bucket = ((matrix.cells || {})[eventKey] || {});
    return (
      bucket[position] ||
      bucket['worship__' + position] ||
      bucket['Worship__' + position] ||
      []
    );
  }

  function joinCell_(eventKey, position){
    const list = getCellList_(eventKey, position);
    if (!Array.isArray(list) || !list.length) return '';

    return list.map(function(it){
      const raw = String((it && it.rawValue) || '').trim();
      const memberId = String((it && it.memberId) || '').trim().toUpperCase();

      if (memberId && byId[memberId] && typeof admin_memberLabelCompact_ === 'function') {
        return admin_memberLabelCompact_(byId[memberId]).label || raw || memberId;
      }
      return raw || memberId;
    }).filter(Boolean).join(', ');
  }

  const allowedPositions = ['Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument'];

  function rotaStats_(eventKey, position){
    const list = getCellList_(eventKey, position);
    const configuredMax = (typeof ADMIN_SERVING_POSITION_MAX === 'object' && ADMIN_SERVING_POSITION_MAX)
      ? Number(ADMIN_SERVING_POSITION_MAX[position] || 0)
      : 0;
    if (!Array.isArray(list) || !list.length) {
      return { totalSlots: Math.max(0, configuredMax), vacantSlots: Math.max(0, configuredMax) };
    }
    let total = 0;
    let vacant = 0;
    let hasClosed = false;
    list.forEach(function(it){
      const raw = String((it && it.rawValue) || '').trim();
      const up = raw.toUpperCase();
      if (!raw || up === 'VACANT') { total += 1; vacant += 1; return; }
      if (up === 'CLOSED') { hasClosed = true; return; }
      total += 1;
    });
    if (hasClosed) return { totalSlots:0, vacantSlots:0 };
    if (configuredMax > total){
      vacant += (configuredMax - total);
      total = configuredMax;
    }
    return { totalSlots: total, vacantSlots: vacant };
  }

  const rows = events.map(function(e){
    const rota = {
      Worship_Lead: joinCell_(e.eventKey, 'Worship_Lead'),
      Worship_Singer: joinCell_(e.eventKey, 'Worship_Singer'),
      Worship_Pianist: joinCell_(e.eventKey, 'Worship_Pianist'),
      Worship_Drum: joinCell_(e.eventKey, 'Worship_Drum'),
      Worship_Instrument: joinCell_(e.eventKey, 'Worship_Instrument')
    };
    const rotaMeta = {};
    allowedPositions.forEach(function(pos){ rotaMeta[pos] = rotaStats_(e.eventKey, pos); });
    return {
      eventKey: e.eventKey,
      dateYmd: e.dateYmd,
      rota: rota,
      rotaMeta: rotaMeta,
      songs: planningMap[e.eventKey] || {}
    };
  });

  const worshipIdsFromPlan = {};
  events.forEach(function(e){
    allowedPositions.forEach(function(pos){
      const list = getCellList_(e.eventKey, pos);
      (Array.isArray(list) ? list : []).forEach(function(it){
        const id = String((it && it.memberId) || '').trim().toUpperCase();
        if (id) worshipIdsFromPlan[id] = true;
      });
    });
  });

  const membersPayload = includeMembers
    ? Object.keys(byId).map(function(id){
        const m = byId[id] || {};
        return {
          id: m.id || id,
          nameZh: m.nameZh || '',
          nameEn: m.nameEn || '',
          preferredName: m.preferredName || '',
          gender: m.gender || '',
          servingGroups: m.servingGroups || [],
          servingGLGroups: m.servingGLGroups || []
        };
      }).filter(function(m){
        const mid = String(m.id || '').trim().toUpperCase();
        return reg_isWorshipMember_(m) || !!worshipIdsFromPlan[mid];
      })
    : [];

  return {
    ok:true,
    viewer:{
      id: effectiveMember.id || auth.parsed.id,
      preferredName: effectiveMember.preferredName || '',
      status: statusNorm,
      servingGroups: effectiveMember.servingGroups || [],
      servingGLGroups: effectiveMember.servingGLGroups || [],
      isGl: !!canGl
    },
    permission:{
      isWorshipMember:true,
      canSongEditAllFuture:true,
      canGlRotaEdit: !!canGl
    },
    events: rows,
    members: membersPayload
  };
}


function api_reg_self_worship_page_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    return reg_buildWorshipPagePayload_(auth, false);
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function api_reg_self_worship_members_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const base = reg_buildWorshipPagePayload_(auth, true);
    if (!base || !base.ok) return base;
    return { ok:true, members: base.members || [] };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}


function reg_worship_song_save_with_auth_(auth, payload, actionSource){
  const base = reg_buildWorshipPagePayload_(auth, false);
  if (!base.ok) return { ok:false, code:'E_WORSHIP_PERMISSION', zh:'你沒有權限修改敬拜資料', en:'No permission to edit worship data.' };
  const ev = String((payload && payload.eventKey) || '').trim();
  const section = String((payload && payload.songSection) || '').trim().toUpperCase();
  if (!admin_isSundayServiceKey_(ev) || REG_WORSHIP_SECTIONS.indexOf(section) < 0) return { ok:false, code:'E_WORSHIP_SAVE', zh:'資料格式錯誤', en:'Invalid worship save payload.' };
  const p = payload || {};
  const sh = reg_ensureWorshipPlanningSheet_();
  const last = sh.getLastRow();
  const now = new Date();
  const nowStamp = Utilities.formatDate(now, 'Europe/London', 'yyyy-MM-dd HH:mm:ss');
  const actor = String((auth && auth.parsed && auth.parsed.id) || '').toUpperCase();
  let targetRow = 0;
  let old = { songTitle:'', songKey:'', capo:'', versionNote:'', linkUrl:'', linkTitle:'' };
  if (last >= 2){
    const vals = sh.getRange(2,1,last-1,10).getValues();
    for (let i=0;i<vals.length;i++){
      if (String(vals[i][0]||'').trim() === ev && String(vals[i][1]||'').trim().toUpperCase() === section){
        targetRow = i + 2;
        old = { songTitle:String(vals[i][2]||''), songKey:String(vals[i][3]||''), capo:String(vals[i][4]||''), versionNote:String(vals[i][5]||''), linkUrl:String(vals[i][6]||''), linkTitle:String(vals[i][7]||'') };
      }
    }
  }
  const next = {
    songTitle: String(p.songTitle || '').trim(),
    songKey: String(p.songKey || '').trim(),
    capo: String(p.capo || '').trim(),
    versionNote: String(p.versionNote || '').trim(),
    linkUrl: String(p.linkUrl || '').trim(),
    linkTitle: String(p.linkTitle || '').trim()
  };
  if (!next.linkTitle) next.linkTitle = String(old.linkTitle || '').trim();
  const linkChanged = String(next.linkUrl || '') !== String(old.linkUrl || '');
  const forceTitleFromLink = !!(p && p.forceTitleFromLink === true);
  if (next.linkUrl && (linkChanged || forceTitleFromLink) && !next.songTitle && !next.linkTitle){
    const yt = reg_tryFetchYoutubeMeta_(next.linkUrl);
    if (yt.ok && yt.title){
      next.linkTitle = yt.title;
      next.songTitle = yt.title;
    }
  }
  const row = [ev, section, next.songTitle, next.songKey, next.capo, next.versionNote, next.linkUrl, next.linkTitle, now, actor];
  if (targetRow){ sh.getRange(targetRow,1,1,10).setValues([row]); }
  else { sh.getRange(sh.getLastRow()+1,1,1,10).setValues([row]); }
  reg_sortAndDedupWorshipPlanningSheet_(sh);

  const auditRows = [];
  ['songTitle','songKey','capo','versionNote','linkUrl','linkTitle'].forEach(function(k){
    if (String(old[k]||'') === String(next[k]||'')) return;
    auditRows.push([nowStamp, actor, ev, 'SONG', section + '.' + k, String(old[k]||''), String(next[k]||''), String(actionSource || 'SELF_WORSHIP_SONG_SAVE'), '']);
  });
  reg_writeWorshipAuditRows_(auditRows);
  return { ok:true, eventKey:ev, songSection:section, saved:next, lastUpdatedAt: nowStamp, lastUpdatedBy: actor };
}

function reg_worship_rota_gl_save_with_auth_(auth, eventKey, rows, overrideAway, actionSource){
  const mi = admin_getMembersIndex_();
  const actorId = String((auth && auth.parsed && auth.parsed.id) || '').toUpperCase();
  const member = (mi && mi.byId) ? mi.byId[actorId] : null;
  const statusNorm = regStatus_((auth && auth.row && auth.row.Status) || (member && member.status) || '');
  if (!reg_isWorshipGlOrAdminForWorship_(member, statusNorm)) return { ok:false, code:'E403', zh:'你沒有權限修改敬拜排更', en:'No permission to edit worship rota.' };
  const allowed = ['Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument'];
  const list = (Array.isArray(rows) ? rows : []).filter(function(r){ return allowed.indexOf(String(r.position||'')) >= 0; });
  const existing = admin_getServingValuesForEvent_(String(eventKey || ''));
  const cleaned = list.map(function(r){
    const out = { position:String(r.position||''), value:String(r.value||'').trim() };
    const slotIndex = Number(r.slotIndex || 0);
    if (!slotIndex || slotIndex < 1) return out;
    const prev = String(existing[out.position] || '').trim();
    const tokens = prev ? prev.split(',').map(function(x){ return String(x||'').trim(); }) : [];
    while (tokens.length < slotIndex) tokens.push('Vacant');
    tokens[slotIndex - 1] = out.value || 'Vacant';
    out.value = tokens.join(', ');
    return out;
  });
  const sh = admin_ensureServingSheet_();
  admin_ensureServingEventKeys_(sh);
  const token = reg_issueTempAdminTokenForWorship_(actorId);
  if (!token) return { ok:false, code:'E403', zh:'授權失敗', en:'Authorization failed.' };
  const res = api_admin_serving_event_save(token, eventKey, cleaned, overrideAway, 'WORSHIP');
  if (!res || !res.ok) return res;
  regRefreshMembersCachesForSelfPortal_();
  const now = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd HH:mm:ss');
  const auditRows = cleaned.map(function(r){ return [now, actorId, String(eventKey||''), 'ROTA', String(r.position||''), '', String(r.value||''), String(actionSource || 'SELF_WORSHIP_GL_SAVE'), '']; });
  reg_writeWorshipAuditRows_(auditRows);
  return res;
}

function api_reg_self_worship_song_save_public(qrPayload, payload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    return reg_worship_song_save_with_auth_(auth, payload, 'SELF_WORSHIP_SONG_SAVE');
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function api_reg_self_worship_rota_member_action_public(qrPayload, eventKey, position, action, slotIndex){
  const act = String(action || '').trim().toUpperCase();
  if (act === 'ADD') return api_reg_self_serving_signup_public(qrPayload, eventKey, position, Number(slotIndex || 0));
  if (act === 'REMOVE') return api_reg_self_serving_remove_public(qrPayload, eventKey, position);
  return { ok:false, code:'E416', zh:'不支援的動作', en:'Unsupported action.' };
}

function api_reg_self_worship_rota_gl_save_public(qrPayload, eventKey, rows, overrideAway){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    return reg_worship_rota_gl_save_with_auth_(auth, eventKey, rows, overrideAway, 'SELF_WORSHIP_GL_SAVE');
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function reg_issueTempAdminTokenForWorship_(memberId){
  if (typeof admin_newSession_ !== 'function') return '';
  const mi = admin_getMembersIndex_();
  const m = (mi && mi.byId) ? mi.byId[String(memberId||'').toUpperCase()] : null;
  if (!m) return '';
  return admin_newSession_({
    id:m.id, role:'ADMIN',
    nameZh:m.nameZh||'', nameEn:m.nameEn||'', preferredName:m.preferredName||'',
    servingGroups:m.servingGroups||[], servingGLGroups:(m.servingGLGroups||[]).concat(['WORSHIP'])
  });
}


function api_admin_worship_page(token){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    return reg_buildWorshipPagePayload_(auth, false);
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function api_admin_worship_members(token){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    const base = reg_buildWorshipPagePayload_(auth, true);
    if (!base || !base.ok) return base;
    return { ok:true, members: base.members || [] };
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function api_admin_worship_song_save(token, payload){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    return reg_worship_song_save_with_auth_(auth, payload, 'ADMIN_WORSHIP_SONG_SAVE');
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function api_admin_worship_rota_member_action(token, eventKey, position, action, slotIndex){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    const key = String((auth && auth.row && auth.row.Key) || '').trim();
    if (!key) return { ok:false, code:'E417', zh:'系統缺少 Key，請聯絡影音同工', en:'Key missing in database. Please contact Media team.' };
    const qrPayload = String((auth && auth.parsed && auth.parsed.id) || '') + '|' + key;
    return api_reg_self_worship_rota_member_action_public(qrPayload, eventKey, position, action, slotIndex);
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function api_admin_worship_rota_gl_save(token, eventKey, rows, overrideAway){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    return reg_worship_rota_gl_save_with_auth_(auth, eventKey, rows, overrideAway, 'ADMIN_WORSHIP_GL_SAVE');
  }catch(e){ return regErr_('E500','系統錯誤（E500）。','System error (E500).', e); }
}

function api_admin_worship_import_probe(token, input){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    return worshipBuildImportProbe_(input);
  }catch(e){ return regErr_('E_WORSHIP_PROBE_FAILED','匯入診斷失敗','Import probe failed', e); }
}

function api_admin_worship_import_preview(token, spreadsheetUrlOrId){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    return worshipPreviewImportChanges_(auth, spreadsheetUrlOrId);
  }catch(e){ return regErr_('E_WORSHIP_PREVIEW_FAILED','匯入預覽失敗','Import preview failed', e); }
}

function api_admin_worship_import_commit(token, spreadsheetUrlOrId, overrideAway){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    return worshipCommitImportChanges_(auth, spreadsheetUrlOrId, overrideAway, 'ADMIN_WORSHIP_IMPORT');
  }catch(e){ return regErr_('E_WORSHIP_IMPORT_FAILED','匯入失敗','Import failed', e); }
}

function api_admin_worship_export(token, format){
  try{
    const auth = reg_getWorshipAuthFromAdminToken_(token);
    if (!auth.ok) return auth;
    const key = String((auth && auth.row && auth.row.Key) || '').trim();
    if (!key) return { ok:false, code:'E417', zh:'系統缺少 Key，請聯絡影音同工', en:'Key missing in database. Please contact Media team.' };
    const qrPayload = String((auth && auth.parsed && auth.parsed.id) || '') + '|' + key;
    return api_reg_self_worship_export_public(qrPayload, format);
  }catch(e){ return regErr_('E_WORSHIP_EXPORT_FAILED','匯出失敗','Export failed', e); }
}


function worshipError_(code, zh, en, detail, subCode){
  const out = { ok:false, code:String(code||'E_WORSHIP_ERROR'), zh:String(zh||'敬拜匯入/匯出錯誤'), en:String(en||'Worship import/export error') };
  if (subCode) out.subCode = String(subCode);
  if (detail !== undefined && detail !== null && String(detail) !== '') out.detail = String(detail);
  return out;
}

function worshipEnsureAliasSheet_(){
  const ss = reg_openSsForWorship_();
  if (!ss) throw new Error('Spreadsheet unavailable');
  let sh = ss.getSheetByName(REG_WORSHIP_ALIAS_SHEET);
  if (!sh) sh = ss.insertSheet(REG_WORSHIP_ALIAS_SHEET);
  const headers = ['CCFID','Aliases'];
  const current = sh.getLastRow() >= 1 ? sh.getRange(1,1,1,2).getValues()[0] : [];
  if (String(current[0]||'').trim() !== headers[0] || String(current[1]||'').trim() !== headers[1]){
    sh.getRange(1,1,1,2).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}

function worshipNormalizeAlias_(value){
  return String(value || '')
    .replace(/[，、；;\/|\n\r\t]+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[.,:：()（）\[\]{}<>《》!！?？_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function worshipIsActiveWorshipMember_(ccfId, membersIndex){
  const id = String(ccfId||'').trim().toUpperCase();
  const m = membersIndex && membersIndex.byId ? membersIndex.byId[id] : null;
  if (!m) return false;
  const st = String(m.status || '').trim().toUpperCase();
  if (st === 'PROVISIONAL' || st === 'DISABLED') return false;
  return reg_isWorshipMember_(m);
}

function worshipReadAliasMap_(){
  const cache = CacheService.getScriptCache();
  const cached = cache.get('worship_alias_map_v1');
  if (cached) return JSON.parse(cached);
  const mi = admin_getMembersIndex_();
  const sh = worshipEnsureAliasSheet_();
  const out = { byAlias:{}, aliasesById:{}, conflicts:{} };
  const add = function(alias, id){
    const ccfId = String(id||'').trim().toUpperCase();
    if (!/^CCF\d{4}$/.test(ccfId) || !worshipIsActiveWorshipMember_(ccfId, mi)) return;
    const key = worshipNormalizeAlias_(alias);
    if (!key) return;
    if (!out.byAlias[key]) out.byAlias[key] = [];
    if (out.byAlias[key].indexOf(ccfId) < 0) out.byAlias[key].push(ccfId);
    if (!out.aliasesById[ccfId]) out.aliasesById[ccfId] = [];
    if (out.aliasesById[ccfId].indexOf(alias) < 0) out.aliasesById[ccfId].push(String(alias||''));
  };
  Object.keys((mi && mi.byId) || {}).forEach(function(id){ add(id, id); });
  const last = sh.getLastRow();
  if (last >= 2){
    const rows = sh.getRange(2,1,last-1,2).getValues();
    rows.forEach(function(r){
      const id = String(r[0]||'').trim().toUpperCase();
      if (!id) return;
      add(id, id);
      String(r[1]||'').split(/[，,、;；\/|\n\r]+/).forEach(function(a){ add(a, id); });
    });
  }
  Object.keys(out.byAlias).forEach(function(k){ if ((out.byAlias[k]||[]).length > 1) out.conflicts[k] = out.byAlias[k]; });
  try{ cache.put('worship_alias_map_v1', JSON.stringify(out), 15); }catch(e){}
  return out;
}

function worshipResolveAliasToCcfId_(rawName, aliasMap, membersIndex){
  const raw = String(rawName||'').trim();
  if (!raw) return { ok:true, empty:true, ccfId:'' };
  const up = raw.toUpperCase();
  if (/^(VACANT|空缺)$/i.test(raw)) return { ok:true, special:'VACANT', ccfId:'' };
  if (/^(N\/A|NA|不適用)$/i.test(raw)) return { ok:true, special:'N/A', ccfId:'' };
  if (/^(CLOSED|關閉)$/i.test(raw)) return { ok:true, special:'CLOSED', ccfId:'' };
  if (/^CCF\d{4}$/.test(up)){
    if (!((membersIndex && membersIndex.byId || {})[up])) return worshipError_('E_WORSHIP_UNKNOWN_NAME','找不到此 CCFID','Unknown CCFID', raw);
    if (!worshipIsActiveWorshipMember_(up, membersIndex)) return worshipError_('E_WORSHIP_MEMBER_NOT_IN_GROUP','此成員不是有效敬拜組成員','Member is not an active Worship member', raw);
    return { ok:true, ccfId:up };
  }
  const key = worshipNormalizeAlias_(raw);
  const ids = ((aliasMap && aliasMap.byAlias) ? aliasMap.byAlias[key] : []) || [];
  if (ids.length > 1) return worshipError_('E_WORSHIP_ALIAS_AMBIGUOUS','名稱對應多於一位有效成員，請在 Worship_Alias 修正','Alias resolves to more than one active member; fix Worship_Alias', raw + ' → ' + ids.join(', '));
  if (!ids.length) return worshipError_('E_WORSHIP_UNKNOWN_NAME','找不到名稱/別名','Unknown name/alias', raw);
  if (!worshipIsActiveWorshipMember_(ids[0], membersIndex)) return worshipError_('E_WORSHIP_MEMBER_NOT_IN_GROUP','此成員不是有效敬拜組成員','Member is not an active Worship member', raw + ' → ' + ids[0]);
  return { ok:true, ccfId:ids[0] };
}

function worshipParseSpreadsheetUrlOrId_(input){
  const raw = String(input||'').trim();
  if (!raw) return worshipError_('E_WORSHIP_INVALID_FORMAT','請輸入 Google Sheet URL 或 ID','Please enter a Google Sheet URL or ID');
  let id = raw, gid = '';
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) id = m[1];
  const gm = raw.match(/[?&#]gid=([0-9]+)/);
  if (gm) gid = gm[1];
  if (!/^[a-zA-Z0-9-_]{20,}$/.test(id)) return worshipError_('E_WORSHIP_INVALID_FORMAT','Google Sheet ID 格式錯誤','Invalid Google Sheet ID', raw);
  return { ok:true, spreadsheetId:id, sheetNameOrGid:gid };
}

function worshipParseDelimitedValues_(text, delimiter){
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return [];
  if (delimiter === '\t'){
    return raw.split(/\r?\n/).filter(function(line){ return String(line||'').trim(); }).map(function(line){ return String(line||'').split('\t').map(function(c){ return String(c||'').trim(); }); });
  }
  try{ return Utilities.parseCsv(raw); }catch(e){ return raw.split(/\r?\n/).map(function(line){ return String(line||'').split(','); }); }
}

function worshipDecodeXml_(value){
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function(_, n){ return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function(_, n){ return String.fromCharCode(parseInt(n, 16)); });
}

function worshipColumnLettersToIndex_(letters){
  const s = String(letters || '').toUpperCase();
  let n = 0;
  for (let i=0;i<s.length;i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}


function worshipExtractXlsxCellsFromRowXml_(rowXml, shared){
  const row = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cellRe.exec(String(rowXml || ''))) !== null){
    const attrs = String(m[1] || '');
    const body = String(m[2] || '');
    const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [,''])[1];
    const idx = ref ? (worshipColumnLettersToIndex_(ref) - 1) : row.length;
    const type = (attrs.match(/\bt="([^"]+)"/) || [,''])[1];
    let v = '';
    if (body){
      if (type === 'inlineStr'){
        const texts = [];
        (body.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).forEach(function(t){
          texts.push(worshipDecodeXml_(t.replace(/<[^>]+>/g, '')));
        });
        v = texts.join('');
      } else {
        v = (body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [,''])[1];
        if (type === 's') v = shared[Number(v)] || '';
        else v = worshipDecodeXml_(v);
      }
    }
    if (idx >= 0) row[idx] = String(v || '').trim();
  }
  return row;
}

function worshipReadUploadedSpreadsheetFormat_(file){
  const f = file || {};
  const name = String(f.name || f.filename || '').trim();
  const mime = String(f.mimeType || '').trim();
  const b64 = String(f.base64 || '').replace(/^data:.*?;base64,/, '');
  if (!b64) return worshipError_('E_WORSHIP_UPLOAD_MISSING','請先選擇匯入檔案','Please choose a file to import.');
  const lower = name.toLowerCase();
  try{
    const bytes = Utilities.base64Decode(b64);
    if (/\.(csv)$/i.test(lower) || /csv/i.test(mime)){
      const values = worshipParseDelimitedValues_(Utilities.newBlob(bytes).getDataAsString('UTF-8'), ',');
      return { ok:true, sheetName:name || 'CSV upload', values:values, sheets:[{ sheetName:name || 'CSV upload', values:values }] };
    }
    if (/\.(tsv|txt)$/i.test(lower)){
      const values = worshipParseDelimitedValues_(Utilities.newBlob(bytes).getDataAsString('UTF-8'), '\t');
      return { ok:true, sheetName:name || 'TSV upload', values:values, sheets:[{ sheetName:name || 'TSV upload', values:values }] };
    }
    if (!/\.xlsx$/i.test(lower)) return worshipError_('E_WORSHIP_UNSUPPORTED_UPLOAD','只支援 .xlsx、.csv 或 .tsv 匯入檔案','Only .xlsx, .csv or .tsv upload files are supported.', name || mime);
    const blob = Utilities.newBlob(bytes, 'application/zip', name || 'worship.xlsx');
    const parts = Utilities.unzip(blob);
    const byName = {};
    parts.forEach(function(part){ byName[String(part.getName()).replace(/^\//,'')] = part; });
    const sheetKeys = Object.keys(byName).filter(function(k){ return /^xl\/worksheets\/sheet\d+\.xml$/.test(k); }).sort(function(a,b){ return Number((a.match(/sheet(\d+)/)||[,0])[1]) - Number((b.match(/sheet(\d+)/)||[,0])[1]); });
    if (!sheetKeys.length) return worshipError_('E_WORSHIP_INVALID_FORMAT','Excel 檔案沒有工作表','Excel file has no worksheet.', name);
    const workbookSheetNames = {};
    if (byName['xl/workbook.xml']){
      const wb = byName['xl/workbook.xml'].getDataAsString('UTF-8');
      const relMap = {};
      if (byName['xl/_rels/workbook.xml.rels']){
        const rels = byName['xl/_rels/workbook.xml.rels'].getDataAsString('UTF-8');
        (rels.match(/<Relationship\b[^>]*>/g) || []).forEach(function(tag){
          const id = (tag.match(/\bId="([^"]+)"/) || [,''])[1];
          const target = (tag.match(/\bTarget="([^"]+)"/) || [,''])[1];
          if (id && target) relMap[id] = target.replace(/^\//,'').replace(/^xl\//,'');
        });
      }
      (wb.match(/<sheet\b[^>]*>/g) || []).forEach(function(tag){
        const nm = (tag.match(/\bname="([^"]+)"/) || [,''])[1];
        const rid = (tag.match(/(?:r:id|id)="([^"]+)"/) || [,''])[1];
        const sid = (tag.match(/\bsheetId="(\d+)"/) || [,''])[1];
        const target = rid && relMap[rid] ? relMap[rid].replace(/^worksheets\//,'') : (sid ? 'sheet' + sid + '.xml' : '');
        if (target && nm) workbookSheetNames[target] = worshipDecodeXml_(nm);
      });
    }
    const shared = [];
    if (byName['xl/sharedStrings.xml']){
      const sx = byName['xl/sharedStrings.xml'].getDataAsString('UTF-8');
      (sx.match(/<si[\s\S]*?<\/si>/g) || []).forEach(function(si){
        const text = (si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(function(t){ return worshipDecodeXml_(t.replace(/<[^>]+>/g, '')); }).join('');
        shared.push(text);
      });
    }
    const sheets = sheetKeys.map(function(key){
      const xml = byName[key].getDataAsString('UTF-8');
      const rows = [];
      (xml.match(/<row[\s\S]*?<\/row>/g) || []).forEach(function(rowXml){
        const row = worshipExtractXlsxCellsFromRowXml_(rowXml, shared);
        if (row.some(function(x){ return String(x||'').trim(); })) rows.push(row.map(function(x){ return x || ''; }));
      });
      const shortName = key.replace(/^xl\/worksheets\//,''); return { sheetName:workbookSheetNames[shortName] || shortName, values:rows };
    }).filter(function(sh){ return sh.values && sh.values.length; });
    if (!sheets.length) return worshipError_('E_WORSHIP_INVALID_FORMAT','Excel 檔案沒有可匯入資料','Excel file has no importable rows.', name);
    return { ok:true, sheetName:sheets[0].sheetName, values:sheets[0].values, sheets:sheets };
  }catch(e){ return worshipError_('E_WORSHIP_UPLOAD_PARSE_FAILED','匯入檔案解析失敗','Uploaded file parsing failed.', String(e && e.message || e)); }
}

function worshipReadSheetByPublicCsvFallback_(spreadsheetId, sheetNameOrGid){
  const hasGid = /^\d+$/.test(String(sheetNameOrGid||''));
  const gid = hasGid ? String(sheetNameOrGid||'') : '';
  const url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(String(spreadsheetId||'')) + '/export?format=csv' + (hasGid ? ('&gid=' + encodeURIComponent(gid)) : '');
  try{
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions:true, followRedirects:true });
    const code = resp.getResponseCode();
    const text = resp.getContentText('UTF-8') || '';
    if (code >= 200 && code < 300 && text && !/^\s*</.test(text)){
      const values = worshipParseDelimitedValues_(text, ',');
      if (values && values.length) return { ok:true, sheetName:'CSV export', gid:gid, values:values, via:'PUBLIC_CSV_EXPORT' };
    }
    return worshipError_('E_WORSHIP_SHEET_OPEN_FAILED','無法直接讀取 Google Sheet，請檢查共享權限，或改用檔案上載','Could not read Google Sheet directly; check sharing permissions or use file upload.', (code === 401 || code === 403 ? 'Google returned HTTP ' + code + ': sheet is not publicly exportable or not shared with the web app owner. Please upload .xlsx/.csv/.tsv, publish/share the sheet, or export from Google Sheets first.' : 'SpreadsheetApp and CSV export failed. HTTP ' + code));
  }catch(e){ return worshipError_('E_WORSHIP_SHEET_OPEN_FAILED','無法直接讀取 Google Sheet，請檢查共享權限，或改用檔案上載','Could not read Google Sheet directly; check sharing permissions or use file upload.', String(e && e.message || e)); }
}

function worshipReadExistingSheetFormat_(spreadsheetId, sheetNameOrGid){
  // User-supplied worship spreadsheets are often owned outside this Apps Script account.
  // Avoid SpreadsheetApp.openById first because it can throw an unhelpful service-level E500.
  const publicCsv = worshipReadSheetByPublicCsvFallback_(spreadsheetId, sheetNameOrGid);
  if (publicCsv && publicCsv.ok) return publicCsv;
  return publicCsv || worshipError_('E_WORSHIP_SHEET_OPEN_FAILED','無法直接讀取 Google Sheet，請檢查共享權限，或改用檔案上載','Could not read Google Sheet directly; check sharing permissions or use file upload.');
}

function worshipHeaderKey_(h){
  const n = worshipNormalizeAlias_(h).replace(/[\s\-_/／\\:：()（）\[\]【】.。]+/g,'');
  if (/^(DATE|日期|SERVICE日期|SERVICEDATE|SUNDAY|SUNDAYDATE|主日|主日日期|崇拜日期|崇拜日|聚會日期)$/.test(n)) return 'Date';
  if (/^(EVENTKEY|EVENT|活動|SERVICE|SERVICEKEY)$/.test(n)) return 'EventKey';
  if (/(主領|領詩|敬拜主領|敬拜領袖|敬拜LEADER|WORSHIPLEADER|LEAD)/.test(n)) return 'Worship_Lead';
  if (/(和唱|和音|歌手|SINGER|VOCAL|BACKING)/.test(n)) return 'Worship_Singer';
  if (/(司琴|琴|PIANIST|PIANO|KEYS|KEYBOARD)/.test(n)) return 'Worship_Pianist';
  if (/(鼓手|鼓|DRUM|DRUMMER)/.test(n)) return 'Worship_Drum';
  if (/(樂器|樂手|結他|吉他|GUITAR|BASS|INSTRUMENT)/.test(n)) return 'Worship_Instrument';
  let sec = ''; const mainNo = n.match(/(敬拜|WORSHIP|MAIN).*([1-4])/); const respNo = n.match(/(回應|RESPONSE).*([1-2])/); if (mainNo) sec = 'WORSHIP_MAIN_' + mainNo[2]; else if (respNo) sec = 'WORSHIP_RESPONSE_' + respNo[2];
  if (sec){
    if (/(KEY|調)/.test(n)) return sec + '.songKey';
    if (/CAPO/.test(n)) return sec + '.capo';
    if (/(VERSION|版本|NOTE|備註|備忘)/.test(n)) return sec + '.versionNote';
    if (/(LINK|YOUTUBE|CHORD|URL|連結|譜)/.test(n)) return sec + '.linkUrl';
    return sec + '.songTitle';
  }
  return '';
}

function worshipSheetMonthContext_(sheetName){
  const s = String(sheetName || '').trim();
  const names = { JAN:1,JANUARY:1,FEB:2,FEBRUARY:2,MAR:3,MARCH:3,APR:4,APRIL:4,MAY:5,JUN:6,JUNE:6,JUL:7,JULY:7,AUG:8,AUGUST:8,SEP:9,SEPT:9,SEPTEMBER:9,OCT:10,OCTOBER:10,NOV:11,NOVEMBER:11,DEC:12,DECEMBER:12 };
  let m = s.toUpperCase().match(/\b(JANUARY|JAN|FEBRUARY|FEB|MARCH|MAR|APRIL|APR|MAY|JUNE|JUN|JULY|JUL|AUGUST|AUG|SEPTEMBER|SEPT|SEP|OCTOBER|OCT|NOVEMBER|NOV|DECEMBER|DEC)\b\s*(\d{2,4})\b/);
  if (m){ const y = Number(String(m[2]).length === 2 ? '20' + m[2] : m[2]); return { year:y, month:names[m[1]] || 0, ym:y + '-' + ('0'+(names[m[1]]||0)).slice(-2) }; }
  m = s.match(/(20\d{2})\s*[-_年 ]\s*(\d{1,2})\s*月?/);
  if (m) return { year:Number(m[1]), month:Number(m[2]), ym:m[1] + '-' + ('0'+m[2]).slice(-2) };
  return null;
}

function worshipNativeHeaderKey_(h){
  const n = worshipNormalizeAlias_(h).replace(/[\s\-_/／\\:：()（）\[\]【】.。]+/g,'');
  if (!n) return '';
  if (/^(VOCALS|INSTRUMENTALS|WORSHIPSONGS|敬拜|樂器|乐器)$/.test(n)) return '';
  if (/(主領|主领|領詩|领诗|LEAD|WORSHIPLEADER)/.test(n)) return 'Worship_Lead';
  if (/(伴唱|和唱|和音|SINGER|VOCAL|VOCALS|BACKING)/.test(n)) return 'Worship_Singer';
  if (/(司琴|PIANIST|PIANO|KEYS|KEYBOARD)/.test(n)) return 'Worship_Pianist';
  if (/(鼓吉他|鼓結他|鼓手吉他|鼓|DRUM|DRUMMER|CAJON)/.test(n) && /(吉他|結他|GUITAR|BASS|INSTRUMENT|樂器|乐器)/.test(n)) return 'Worship_CombinedInstrument';
  if (/(鼓手|鼓|DRUM|DRUMMER|CAJON)/.test(n)) return 'Worship_Drum';
  if (/(吉他|結他|GUITAR|BASS|樂器|乐器|INSTRUMENT)/.test(n)) return 'Worship_Instrument';
  if (/(敬拜詩歌|敬拜诗歌|敬拜歌|WORSHIPSONG|WORSHIPSONGS|WORSHIP歌曲|MAINSONG|MAINSONGS)/.test(n)) return 'WorshipSongs';
  if (/(回應詩歌|回应诗歌|回應歌|回应歌|回應詩|回应诗|RESPONSESONG|RESPONSESONGS)/.test(n)) return 'ResponseSongs';
  return '';
}

function worshipCleanNativeSong_(value){
  return String(value || '').replace(/^\s*\d+\s*[)）.、:：-]?\s*/, '').trim();
}

function worshipPushNativeSong_(target, prefix, raw, maxCount){
  const max = Number(maxCount || 4);
  String(raw || '').split(/[\n\r]+/).map(function(x){ return String(x || '').trim(); }).filter(Boolean).forEach(function(part){
    const numbered = part.match(/^\s*([1-9])\s*[)）.、:：-]/);
    const line = worshipCleanNativeSong_(part);
    let idx = numbered ? Number(numbered[1]) : 0;
    if (!idx){ for (let i=1;i<=max;i++){ if (!target[prefix + '_' + i + '.songTitle']){ idx = i; break; } } }
    if (idx >= 1 && idx <= max && line && !target[prefix + '_' + idx + '.songTitle']) { target[prefix + '_' + idx + '.songTitle'] = line; if (prefix === 'WORSHIP_MAIN') target['WorshipSong' + idx + 'Title'] = line; if (prefix === 'WORSHIP_RESPONSE') target['ResponseSong' + idx + 'Title'] = line; }
  });
}

function worshipAppendNativeValue_(obj, key, value){
  const v = String(value || '').trim();
  if (!v) return;
  obj[key] = obj[key] ? (obj[key] + '\n' + v) : v;
}

function worshipStripInstrumentPrefix_(raw){
  const s = String(raw || '').trim();
  const m = s.match(/^\s*(CAJON|DRUMS?|DRUMMER|鼓手?|GUITARS?|BASS|吉他|結他|乐器|樂器|INSTRUMENT)\s*(?:[:：-]\s*|\s+)(.+)$/i);
  return m ? { role:m[1], name:m[2].trim(), hadPrefix:true } : { role:'', name:s, hadPrefix:false };
}

function worshipRoleHintForCombinedName_(name, roleHints){
  const key = worshipNormalizeAlias_(name);
  const hint = key && roleHints && roleHints.byAlias ? roleHints.byAlias[key] : null;
  if (!hint) return '';
  if (hint.drummer && !hint.guitarist) return 'DRUM';
  if (hint.guitarist && !hint.drummer) return 'INSTRUMENT';
  if (hint.drummer && hint.guitarist) return 'BOTH';
  return '';
}

function worshipAppendCombinedInstrument_(obj, value, warnings, meta){
  const roleHints = meta && meta.roleHints;
  const defaultUnprefixedRole = String((meta && meta.defaultUnprefixedRole) || '').toUpperCase();
  String(value || '').split(/[\n\r,，;；]+/).map(function(x){ return x.trim(); }).filter(Boolean).forEach(function(part){
    const x = worshipStripInstrumentPrefix_(part);
    const role = String(x.role || '').toUpperCase();
    const probe = String(part).toUpperCase();
    if (/CAJON|DRUM|鼓/.test(role) || (/CAJON|DRUM|鼓/.test(probe) && x.hadPrefix)) { worshipAppendNativeValue_(obj, 'Worship_Drum', x.name); return; }
    if (/GUITAR|BASS|吉他|結他|樂器|乐器|INSTRUMENT/.test(role) || (/GUITAR|BASS|吉他|結他|樂器|乐器|INSTRUMENT/.test(probe) && x.hadPrefix)) { worshipAppendNativeValue_(obj, 'Worship_Instrument', x.name); return; }
    const hint = worshipRoleHintForCombinedName_(x.name, roleHints);
    if (hint === 'DRUM') { worshipAppendNativeValue_(obj, 'Worship_Drum', x.name); return; }
    if (hint === 'INSTRUMENT') { worshipAppendNativeValue_(obj, 'Worship_Instrument', x.name); return; }
    if (defaultUnprefixedRole === 'DRUM') { worshipAppendNativeValue_(obj, 'Worship_Drum', x.name); return; }
    if (hint === 'BOTH' && warnings) warnings.push({ code:'E_WORSHIP_NATIVE_INSTRUMENT_ROLE_HINT_BOTH', zh:'成員同時列於鼓手及結他手提示，已放入樂器欄', en:'Member appears in both drummer and guitarist hints; placed in Instrument', detail:x.name, sheetName:meta && meta.sheetName, rowNumber:meta && meta.rowNumber, area:'WARNING', fieldName:'Worship_Instrument' });
    worshipAppendNativeValue_(obj, 'Worship_Instrument', x.name);
  });
}

function worshipBuildNativeMemberRoleHints_(sheets){
  const hints = { byAlias:{} };
  (sheets || []).forEach(function(sh){
    const sheetName = String((sh && sh.sheetName) || '');
    if (!/CURRENT\s*MEMBERS|MEMBERS/i.test(sheetName)) return;
    const values = (sh && sh.values) || [];
    let headerRow = -1, drummerCol = -1, guitaristCol = -1;
    for (let r=0; r<Math.min(values.length, 20); r++){
      (values[r] || []).forEach(function(cell, c){
        const n = worshipNormalizeAlias_(cell).replace(/\s+/g, '');
        if (/^DRUMMER$|鼓手|鼓$/i.test(n)) drummerCol = c;
        if (/^GUITARIST$|^GUITAR$|結他|吉他|^BASS$/i.test(n)) guitaristCol = c;
      });
      if (drummerCol >= 0 || guitaristCol >= 0){ headerRow = r; break; }
    }
    if (headerRow < 0) return;
    function add(raw, key){
      String(raw || '').split(/[\n\r,，;；\/|+＋]+/).map(function(x){ return String(x||'').trim(); }).filter(Boolean).forEach(function(name){
        const alias = worshipNormalizeAlias_(name);
        if (!alias) return;
        if (!hints.byAlias[alias]) hints.byAlias[alias] = { drummer:false, guitarist:false, sourceSheet:sheetName };
        hints.byAlias[alias][key] = true;
      });
    }
    for (let r=headerRow+1; r<values.length; r++){
      const row = values[r] || [];
      if (drummerCol >= 0) add(row[drummerCol], 'drummer');
      if (guitaristCol >= 0) add(row[guitaristCol], 'guitarist');
    }
  });
  return hints;
}

function worshipDetectNativeHeader_(values){
  let best = null;
  for (let r=0; r<Math.min(values.length, 30); r++){
    const map = {}, counts = { actual:0, song:0 };
    (values[r] || []).forEach(function(h, c){
      const k = worshipNativeHeaderKey_(h);
      if (!k) return;
      if (map[k] === undefined) map[k] = c;
      if (k === 'WorshipSongs' || k === 'ResponseSongs') counts.song++;
      else if (k !== 'Worship_Singer' || !/^\s*(VOCALS?|SINGERS?)\s*$/i.test(String(h||''))) counts.actual++;
    });
    const score = counts.actual * 2 + counts.song * 3;
    if (score >= 7 && (counts.actual + counts.song) >= 3 && counts.actual >= 2 && (!best || score > best.score)) best = { row:r, map:map, score:score };
  }
  return best;
}


function worshipNativeFixedHeaderScore_(row){
  let score = 0;
  (row || []).forEach(function(cell){
    const n = worshipNormalizeAlias_(cell).replace(/[\s\-_/／\\:：()（）\[\]【】.。]+/g,'');
    if (/(主領|主领|伴唱|和唱|司琴|鼓|吉他|結他|敬拜詩歌|敬拜诗歌|回應詩歌|回应诗歌)/.test(n)) score++;
  });
  return score;
}

function worshipFindNativeFixedHeaderRow_(values){
  for (let r=0; r<Math.min((values||[]).length, 12); r++){
    if (worshipNativeFixedHeaderScore_(values[r] || []) >= 3) return r;
  }
  return -1;
}

function worshipLooksLikeNativeCcfMonthSheet_(sheetName, values){
  if (!worshipSheetMonthContext_(sheetName || '')) return false;
  return worshipFindNativeFixedHeaderRow_(values || []) >= 0;
}

function worshipNormalizeNativePersonCell_(value){
  const v = String(value || '').trim();
  if (!v || /^(VACANT|空缺)$/i.test(v)) return '';
  if (/^(N\/A|NA|不適用)$/i.test(v)) return 'N/A';
  if (/^(CLOSED|關閉)$/i.test(v)) return 'CLOSED';
  return v;
}

function worshipFixedRowHasImportContent_(row){
  return [2,3,4,5,6,7].some(function(c){ return String((row||[])[c] || '').trim(); });
}

function worshipParseNativeCcfFixedProfile_(values, sheetName, roleHints){
  values = Array.isArray(values) ? values : [];
  const ctx = worshipSheetMonthContext_(sheetName || '');
  const headerRow = worshipFindNativeFixedHeaderRow_(values);
  if (!ctx || headerRow < 0) return worshipError_('E_WORSHIP_NATIVE_FIXED_NOT_DETECTED','不是固定 CCF 敬拜月份格式','Not fixed CCF worship month format', String(sheetName||''));
  const dateCol = 1, leadCol = 2, singerCol = 3, pianistCol = 4, combinedCol = 5, worshipCol = 6, responseCol = 7;
  const rows = [], warnings = [];
  let current = null, blankRun = 0, ignoredRows = 0;
  function flush(){ if (current && current.EventKey) rows.push(current); current = null; }
  for (let r=headerRow+1; r<values.length; r++){
    const row = values[r] || [];
    const fullyBlank = !row.some(function(c){ return String(c||'').trim(); });
    if (fullyBlank){ blankRun++; if (blankRun >= 20 && current) break; continue; }
    blankRun = 0;
    const ev = worshipDateCellToEventKey_(row[dateCol], ctx);
    if (ev){
      flush();
      current = { EventKey:ev, _rowNumber:r+1, _sheetName:String(sheetName||''), _source:String(sheetName||'') + ' row ' + (r+1), _mode:'NATIVE_CCF_FIXED_PROFILE' };
    } else if (!current){
      ignoredRows++;
      continue;
    }
    if (!current || !worshipFixedRowHasImportContent_(row)) continue;
    worshipAppendNativeValue_(current, 'Worship_Lead', worshipNormalizeNativePersonCell_(row[leadCol]));
    worshipAppendNativeValue_(current, 'Worship_Singer', worshipNormalizeNativePersonCell_(row[singerCol]));
    worshipAppendNativeValue_(current, 'Worship_Pianist', worshipNormalizeNativePersonCell_(row[pianistCol]));
    worshipAppendCombinedInstrument_(current, worshipNormalizeNativePersonCell_(row[combinedCol]), warnings, { sheetName:sheetName, rowNumber:r+1, roleHints:roleHints, defaultUnprefixedRole:'DRUM' });
    worshipPushNativeSong_(current, 'WORSHIP_MAIN', row[worshipCol], 4);
    worshipPushNativeSong_(current, 'WORSHIP_RESPONSE', row[responseCol], 2);
  }
  flush();
  if (!rows.length) return worshipError_('E_WORSHIP_INVALID_FORMAT','找不到固定 CCF 敬拜日期區塊','No fixed-profile worship service date blocks found', String(sheetName||''));
  return { ok:true, rows:rows, warnings:warnings, mode:'NATIVE_CCF_FIXED_PROFILE', headerRow:headerRow+1, dateColumn:dateCol+1, ignoredRows:ignoredRows, sheetName:sheetName };
}

function worshipParsedServiceFields_(row){
  const parsed = {};
  ['Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument'].forEach(function(k){ parsed[k] = String((row||{})[k] || '').trim(); });
  REG_WORSHIP_SECTIONS.forEach(function(sec){ parsed[sec] = { songTitle:String((row||{})[sec+'.songTitle']||'').trim(), songKey:String((row||{})[sec+'.songKey']||'').trim(), capo:String((row||{})[sec+'.capo']||'').trim(), versionNote:String((row||{})[sec+'.versionNote']||'').trim(), linkUrl:String((row||{})[sec+'.linkUrl']||'').trim() }; });
  return parsed;
}
function worshipParseNativeCcfRows_(values, sheetName, roleHints){
  values = Array.isArray(values) ? values : [];
  const header = worshipDetectNativeHeader_(values);
  if (!header) return worshipError_('E_WORSHIP_NATIVE_NOT_DETECTED','不是原生 CCF 敬拜 Excel 格式','Not native CCF worship Excel format');
  const ctx = worshipSheetMonthContext_(sheetName) || null;
  let dateCol = -1, best = 0;
  const mapped = Object.keys(header.map).map(function(k){ return header.map[k]; });
  const maxCols = Math.max.apply(null, [8].concat(mapped));
  for (let c=0; c<=maxCols; c++){
    if (mapped.indexOf(c) >= 0) continue;
    let count = 0;
    for (let r=header.row+1; r<Math.min(values.length, header.row+35); r++) if (worshipDateCellToEventKey_((values[r]||[])[c], ctx)) count++;
    if (count > best){ best = count; dateCol = c; }
  }
  if (dateCol < 0) dateCol = 1;
  Object.keys(header.map).forEach(function(k){
    const c = header.map[k];
    let dateLike = 0;
    for (let r=header.row+1; r<Math.min(values.length, header.row+12); r++) if (worshipDateCellToEventKey_((values[r]||[])[c], ctx)) dateLike++;
    if (c === dateCol || dateLike >= 2) delete header.map[k];
  });
  const rows = [], warnings = [];
  let current = null;
  function finish(){ if (current && current.EventKey) rows.push(current); }
  for (let r=header.row+1; r<values.length; r++){
    const row = values[r] || [];
    if (!row.some(function(c){ return String(c||'').trim(); })) continue;
    const ev = worshipDateCellToEventKey_(row[dateCol], ctx);
    if (ev){ finish(); current = { EventKey:ev, _rowNumber:r+1, _sheetName:String(sheetName||''), _mode:'NATIVE_CCF_WORSHIP' }; }
    if (!current) continue;
    Object.keys(header.map).forEach(function(k){
      const raw = String(row[header.map[k]] || '').trim();
      if (!raw) return;
      if (k === 'Worship_CombinedInstrument') worshipAppendCombinedInstrument_(current, raw, warnings, { sheetName:sheetName, rowNumber:r+1, roleHints:roleHints });
      else if (k === 'WorshipSongs') worshipPushNativeSong_(current, 'WORSHIP_MAIN', raw, 4);
      else if (k === 'ResponseSongs') worshipPushNativeSong_(current, 'WORSHIP_RESPONSE', raw, 2);
      else worshipAppendNativeValue_(current, k, raw);
    });
  }
  finish();
  if (!rows.length) return worshipError_('E_WORSHIP_INVALID_FORMAT','找不到可匯入的敬拜日期區塊','No importable worship service date blocks found', String(sheetName||''));
  return { ok:true, rows:rows, warnings:warnings, mode:'NATIVE_CCF_WORSHIP', headerRow:header.row+1, dateColumn:dateCol+1, sheetName:sheetName };
}

function worshipDateCellToEventKey_(value, context){
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) return 'SundayService_' + Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  const raw = String(value || '').trim().replace(/\.0$/, '');
  if (!raw) return '';
  const ctx = context || null;
  if (/^SundayService_\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{5}(\.\d+)?$/.test(String(value || '').trim())){
    const days = Number(value);
    if (days > 20000 && days < 80000){
      const dt = new Date(Math.round((days - 25569) * 86400000));
      return 'SundayService_' + Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
    }
  }
  const ymd = raw.match(/(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
  const dmy = raw.match(/(^|\D)(\d{1,2})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{2,4})(\D|$)/);
  const mdZh = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(日|號|号)?/);
  const dayOnly = raw.match(/^\s*(\d{1,2})\s*(日|號|号)?\s*$/);
  function ymdKey(y,m,d){
    const dt = new Date(Date.UTC(Number(y), Number(m)-1, Number(d)));
    if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(m)-1 || dt.getUTCDate() !== Number(d)) return '';
    return 'SundayService_' + y + '-' + ('0'+m).slice(-2) + '-' + ('0'+d).slice(-2);
  }
  if (ymd) return ymdKey(ymd[1], ymd[2], ymd[3]);
  if (dmy) return ymdKey(String(dmy[4]).length === 2 ? '20'+dmy[4] : dmy[4], dmy[3], dmy[2]);
  if (mdZh && ctx && ctx.year) return ymdKey(ctx.year, mdZh[1], mdZh[2]);
  if (dayOnly && ctx && ctx.year && ctx.month) return ymdKey(ctx.year, ctx.month, dayOnly[1]);
  return '';
}

function worshipRowsFromValues_(values, sheetName, roleHints){
  values = Array.isArray(values) ? values : [];
  if (worshipLooksLikeNativeCcfMonthSheet_(sheetName || '', values)){
    return worshipParseNativeCcfFixedProfile_(values, sheetName || '', roleHints);
  }
  const native = worshipParseNativeCcfRows_(values, sheetName || '', roleHints);
  if (native && native.ok) return native;
  let headerRow = -1, map = {}, bestScore = -1, best = null;
  const maxScan = Math.min(values.length, 80);
  for (let r=0; r<maxScan; r++){
    const temp = {};
    (values[r]||[]).forEach(function(h, c){ const k = worshipHeaderKey_(h); if (k && temp[k] === undefined) temp[k] = c; });
    const keys = Object.keys(temp);
    const score = keys.reduce(function(n,k){
      if (k === 'Date' || k === 'EventKey') return n + 3;
      if (/^Worship_/.test(k)) return n + 2;
      if (/^WORSHIP_/.test(k)) return n + 1;
      return n;
    }, 0);
    if (score > bestScore){ bestScore = score; best = { row:r, map:temp, keys:keys }; }
    if ((temp.EventKey || temp.Date) && keys.some(function(k){ return /^Worship_|^WORSHIP_/.test(k); }) && score >= 5){ headerRow = r; map = temp; break; }
  }
  if (headerRow < 0 && best && bestScore >= 4 && best.keys.some(function(k){ return /^Worship_|^WORSHIP_/.test(k); })){
    headerRow = best.row;
    map = best.map;
    if (map.Date === undefined && map.EventKey === undefined) map.Date = 0;
  }
  if (headerRow < 0){
    const sample = values.slice(0, 12).map(function(row, i){ return (i+1) + ': ' + (row || []).slice(0, 12).join(' | '); }).join('\n');
    return worshipError_('E_WORSHIP_INVALID_FORMAT','找不到標題列','Header row not found', sample || 'No visible rows');
  }
  const out = [];
  const ctx = worshipSheetMonthContext_(sheetName || '');
  for (let r=headerRow+1; r<values.length; r++){
    const row = values[r] || [];
    const o = { _rowNumber:r+1, _sheetName:String(sheetName||''), _mode:'FLAT' };
    Object.keys(map).forEach(function(k){ o[k] = String(row[map[k]] || '').trim(); });
    if (!o.EventKey && o.Date) o.EventKey = worshipDateCellToEventKey_(o.Date, ctx);
    if (Object.keys(o).some(function(k){ return k.charAt(0) !== '_' && String(o[k]||'').trim(); })) out.push(o);
  }
  return { ok:true, rows:out, headerRow:headerRow + 1, mode:'FLAT' };
}

function worshipShouldSkipImportSheet_(sheetName){
  const n = worshipNormalizeAlias_(sheetName).replace(/\s+/g, ' ');
  if (/^(CURRENT MEMBERS|MEMBERS|ALIAS|WORSHIP ALIAS|CONFIG|ARCHIVE)$/.test(n)) return { skip:true, code:'E_WORSHIP_SHEET_IGNORED', zh:'已略過非排期工作表', en:'Non-rota sheet ignored' };
  if (/PAST\s*ROTA|HISTORICAL|ARCHIVE/.test(n)) return { skip:true, code:'E_WORSHIP_SHEET_SKIPPED_PAST', zh:'已略過過去排期工作表', en:'Historical sheet skipped' };
  return { skip:false };
}

function worshipRowHasMeaningfulImportContent_(row){
  const r = row || {};
  return ['Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument'].some(function(k){ return String(r[k]||'').trim(); }) || REG_WORSHIP_SECTIONS.some(function(sec){ return ['songTitle','songKey','capo','versionNote','linkUrl'].some(function(k){ return String(r[sec+'.'+k]||'').trim(); }); });
}


function worshipIsExpectedMonthSheet_(sheetName){
  const s = String(sheetName || '').trim();
  if (!s) return false;
  if (worshipShouldSkipImportSheet_(s).skip) return false;
  if (worshipSheetMonthContext_(s)) return true;
  return /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\s*\d{2,4}$/i.test(s) || /^20\d{2}\s*[-_/]\s*\d{1,2}$/.test(s) || /^20\d{2}\s*年\s*\d{1,2}\s*月$/.test(s);
}

function worshipFirstVisibleRows_(values){
  return (values || []).slice(0, 8).map(function(row){
    const out = [];
    for (let c=0; c<8; c++) out.push(String(((row || [])[c]) || ''));
    return out;
  });
}

function worshipParserOutcome_(res){
  if (!res || !res.ok) return { ok:false, code:(res && res.code) || 'E_WORSHIP_PARSE_FAILED', detail:(res && (res.detail || res.en || res.zh)) || '' };
  return { ok:true, mode:res.mode || '', headerRow:res.headerRow || 0, dateCol:res.dateColumn || 0, logicalBlocksProduced:(res.rows || []).filter(function(r){ return r && r.EventKey; }).length, warnings:(res.warnings || []).length };
}

function worshipProbeSheet_(sheetName, values, roleHints){
  values = Array.isArray(values) ? values : [];
  const skip = worshipShouldSkipImportSheet_(sheetName);
  const ctx = worshipSheetMonthContext_(sheetName || '');
  const headerIdx = worshipFindNativeFixedHeaderRow_(values);
  const headerScore = headerIdx >= 0 ? worshipNativeFixedHeaderScore_(values[headerIdx] || []) : 0;
  const diag = {
    sheetName:String(sheetName || ''),
    physicalRowsRead:values.length,
    firstRows:worshipFirstVisibleRows_(values),
    skipDecision:skip.skip ? { skip:true, code:skip.code, zh:skip.zh, en:skip.en } : { skip:false },
    expectedMonthSheet:worshipIsExpectedMonthSheet_(sheetName),
    monthContext:ctx || null,
    fixedHeaderRowScore:headerScore,
    fixedHeaderRowIndex:headerIdx >= 0 ? headerIdx + 1 : 0,
    fixedParserOutcome:null,
    flexibleParserOutcome:null,
    rowLevelParseErrors:[]
  };
  if (skip.skip) return diag;
  try{ diag.fixedParserOutcome = worshipParserOutcome_(worshipParseNativeCcfFixedProfile_(values, sheetName || '', roleHints)); }
  catch(e){ diag.fixedParserOutcome = { ok:false, code:'E_WORSHIP_FIXED_PROBE_EXCEPTION', detail:String(e && e.message || e) }; }
  try{ diag.flexibleParserOutcome = worshipParserOutcome_(worshipParseNativeCcfRows_(values, sheetName || '', roleHints)); }
  catch(e){ diag.flexibleParserOutcome = { ok:false, code:'E_WORSHIP_FLEX_PROBE_EXCEPTION', detail:String(e && e.message || e) }; }
  if (diag.fixedParserOutcome && !diag.fixedParserOutcome.ok) diag.rowLevelParseErrors.push({ parser:'fixed', code:diag.fixedParserOutcome.code, detail:diag.fixedParserOutcome.detail || '' });
  if (diag.flexibleParserOutcome && !diag.flexibleParserOutcome.ok) diag.rowLevelParseErrors.push({ parser:'flexible', code:diag.flexibleParserOutcome.code, detail:diag.flexibleParserOutcome.detail || '' });
  return diag;
}

function worshipBuildImportProbe_(input){
  const out = { ok:true, importEngineVersion:WORSHIP_IMPORT_ENGINE_VERSION, source:{}, sheets:[] };
  if (input && typeof input === 'object' && !Array.isArray(input)){
    const upload = worshipReadUploadedSpreadsheetFormat_(input);
    if (!upload.ok){ upload.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; return upload; }
    const sheets = upload.sheets && upload.sheets.length ? upload.sheets : [{ sheetName:upload.sheetName || '', values:upload.values || [] }];
    const roleHints = worshipBuildNativeMemberRoleHints_(sheets);
    out.source = { uploadName:String(input.name || input.filename || ''), via:'UPLOAD', sheetCount:sheets.length };
    out.sheets = sheets.map(function(sh){ return worshipProbeSheet_(sh.sheetName || upload.sheetName || '', sh.values || [], roleHints); });
    return out;
  }
  const parsed = worshipParseSpreadsheetUrlOrId_(input);
  if (!parsed.ok){ parsed.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; return parsed; }
  const read = worshipReadExistingSheetFormat_(parsed.spreadsheetId, parsed.sheetNameOrGid);
  if (!read.ok){ read.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; return read; }
  out.source = { spreadsheetId:parsed.spreadsheetId, sheetName:read.sheetName || '', gid:read.gid || '', via:read.via || 'SHEET' };
  out.sheets = [worshipProbeSheet_(read.sheetName || 'Google Sheet', read.values || [], null)];
  return out;
}

function worshipMonthSheetsFailedError_(code, diagnostics, failedSheets){
  const detail = (failedSheets || []).map(function(f){ return f.sheetName + ': ' + (f.code || '') + ' ' + (f.detail || ''); }).join(' | ');
  const err = worshipError_(code || 'E_WORSHIP_EXPECTED_MONTH_SHEETS_FAILED', '找到月份工作表，但未能讀取敬拜排期', 'Month sheets were found, but worship rota data could not be read', detail || 'Expected month sheets failed');
  err.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION;
  err.diagnostics = { sheets:diagnostics || [] };
  err.failedSheets = failedSheets || [];
  err.hasHardErrors = true;
  err.canCommit = false;
  return err;
}

function worshipImportParseInput_(input){
  if (Array.isArray(input)) return { ok:true, importEngineVersion:WORSHIP_IMPORT_ENGINE_VERSION, rows:reg_parseWorshipImportRows_(input).filter(function(r){ return !!r.EventKey; }), warnings:[], diagnostics:{ sheets:[] } };
  if (input && typeof input === 'object'){
    const upload = worshipReadUploadedSpreadsheetFormat_(input);
    if (!upload.ok){ upload.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; return upload; }
    const sheets = upload.sheets && upload.sheets.length ? upload.sheets : [{ sheetName:upload.sheetName || '', values:upload.values || [] }];
    const roleHints = worshipBuildNativeMemberRoleHints_(sheets);
    let nativeRows = [], nativeWarnings = [], bestFlat = null, diagnostics = [], expectedCount = 0, parsedExpected = 0;
    const failedExpected = [];
    sheets.forEach(function(sh){
      const sheetName = sh.sheetName || upload.sheetName || '';
      const values = sh.values || [];
      const diag = worshipProbeSheet_(sheetName, values, roleHints);
      const skip = worshipShouldSkipImportSheet_(sheetName);
      if (skip.skip){
        diag.mode = 'SKIPPED';
        diag.logicalBlocksProduced = 0;
        diag.ignoredRows = values.length;
        diagnostics.push(diag);
        nativeWarnings.push({ code:skip.code, zh:skip.zh, en:skip.en, detail:sheetName, sheetName:sheetName, area:'SKIPPED', fieldName:'Sheet' });
        return;
      }
      const expected = worshipIsExpectedMonthSheet_(sheetName);
      if (expected) expectedCount++;
      let parsed = null;
      if (expected){
        parsed = worshipParseNativeCcfFixedProfile_(values, sheetName, roleHints);
        diag.mode = 'EXPECTED_MONTH_FIXED_PROFILE';
        diag.fixedParserOutcome = worshipParserOutcome_(parsed);
        if (!parsed.ok){
          failedExpected.push({ sheetName:sheetName, code:parsed.code || 'E_WORSHIP_FIXED_PROFILE_FAILED', detail:parsed.detail || parsed.en || parsed.zh || '' });
          diag.error = { code:parsed.code || '', detail:parsed.detail || '' };
          diagnostics.push(diag);
          return;
        }
      } else {
        parsed = worshipRowsFromValues_(values, sheetName, roleHints);
        diag.mode = parsed && parsed.ok ? (parsed.mode || 'FLAT') : 'UNPARSED_NON_MONTH_SHEET';
        if (!parsed.ok){
          diag.error = { code:parsed.code || '', detail:parsed.detail || '' };
          diagnostics.push(diag);
          return;
        }
      }
      const cleanRows = (parsed.rows || []).filter(function(r){ return r && r.EventKey; });
      diag.headerRow = parsed.headerRow || diag.fixedHeaderRowIndex || 0;
      diag.dateCol = parsed.dateColumn || 0;
      diag.logicalBlocksProduced = cleanRows.length;
      diag.ignoredRows = Math.max(0, values.length - cleanRows.length);
      diag.invalidRows = Math.max(0, (parsed.rows || []).length - cleanRows.length);
      diagnostics.push(diag);
      if (expected && !cleanRows.length){
        failedExpected.push({ sheetName:sheetName, code:'E_WORSHIP_NO_SERVICE_BLOCKS', detail:'Fixed-profile parser returned zero logical service blocks' });
        return;
      }
      if (parsed.mode === 'NATIVE_CCF_WORSHIP' || parsed.mode === 'NATIVE_CCF_FIXED_PROFILE'){
        if (expected) parsedExpected++;
        nativeRows = nativeRows.concat(cleanRows);
        nativeWarnings = nativeWarnings.concat(parsed.warnings || []);
      } else if (!expected && cleanRows.length && (!bestFlat || cleanRows.length > (bestFlat.rows || []).length)){
        parsed.rows = cleanRows;
        bestFlat = parsed;
      }
    });
    if (failedExpected.length){
      return worshipMonthSheetsFailedError_('E_WORSHIP_EXPECTED_MONTH_SHEETS_FAILED', diagnostics, failedExpected);
    }
    if (expectedCount > 0 && parsedExpected === 0){
      return worshipMonthSheetsFailedError_('E_WORSHIP_NO_MONTH_SHEETS_PARSED', diagnostics, [{ sheetName:'(all expected month sheets)', code:'E_WORSHIP_NO_MONTH_SHEETS_PARSED', detail:'Expected month sheets were present but no service blocks were produced.' }]);
    }
    if (nativeRows.length) return { ok:true, importEngineVersion:WORSHIP_IMPORT_ENGINE_VERSION, rows:nativeRows, warnings:nativeWarnings, source:{ uploadName:String(input.name || input.filename || ''), via:'UPLOAD', mode:'NATIVE_CCF_FIXED_PROFILE' }, diagnostics:{ sheets:diagnostics } };
    if (bestFlat){ bestFlat.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; bestFlat.diagnostics = { sheets:diagnostics }; return bestFlat; }
    return worshipMonthSheetsFailedError_('E_WORSHIP_NO_MONTH_SHEETS_PARSED', diagnostics, [{ sheetName:'(workbook)', code:'E_WORSHIP_NO_MONTH_SHEETS_PARSED', detail:'No importable worship month sheets or flat import table parsed.' }]);
  }
  const parsed = worshipParseSpreadsheetUrlOrId_(input);
  if (!parsed.ok){ parsed.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; return parsed; }
  const read = worshipReadExistingSheetFormat_(parsed.spreadsheetId, parsed.sheetNameOrGid);
  if (!read.ok){ read.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION; return read; }
  const expected = worshipIsExpectedMonthSheet_(read.sheetName || '');
  const diag = worshipProbeSheet_(read.sheetName || '', read.values || [], null);
  const rows = expected ? worshipParseNativeCcfFixedProfile_(read.values || [], read.sheetName || '', null) : worshipRowsFromValues_(read.values, read.sheetName || '', null);
  if (!rows.ok) return worshipMonthSheetsFailedError_(expected ? 'E_WORSHIP_EXPECTED_MONTH_SHEETS_FAILED' : (rows.code || 'E_WORSHIP_INVALID_FORMAT'), [diag], [{ sheetName:read.sheetName || '', code:rows.code || '', detail:rows.detail || '' }]);
  rows.importEngineVersion = WORSHIP_IMPORT_ENGINE_VERSION;
  rows.rows = (rows.rows || []).filter(function(r){ return r && r.EventKey; });
  rows.source = { spreadsheetId:parsed.spreadsheetId, sheetName:read.sheetName, gid:read.gid, mode:rows.mode || '' };
  rows.diagnostics = { sheets:[Object.assign(diag, { mode:rows.mode || 'FLAT', headerRow:rows.headerRow || 0, dateCol:rows.dateColumn || 0, logicalBlocksProduced:(rows.rows||[]).length, ignoredRows:Math.max(0, (read.values||[]).length - (rows.rows||[]).length), skippedPastRows:0, invalidRows:0 })] };
  return rows;
}

function reg_parseWorshipImportRows_(rows){
  const list = Array.isArray(rows) ? rows : [];
  return list.map(function(r){
    const o = r || {};
    const out = { _rowNumber:o._rowNumber || '' };
    REG_WORSHIP_IMPORT_HEADERS.forEach(function(h){ out[h] = String(o[h] || '').trim(); });
    const friendly = [
      ['WORSHIP_MAIN_1','WorshipSong1'], ['WORSHIP_MAIN_2','WorshipSong2'], ['WORSHIP_MAIN_3','WorshipSong3'], ['WORSHIP_MAIN_4','WorshipSong4'],
      ['WORSHIP_RESPONSE_1','ResponseSong1'], ['WORSHIP_RESPONSE_2','ResponseSong2']
    ];
    friendly.forEach(function(pair){
      const sec = pair[0], pre = pair[1];
      const m = { songTitle:'Title', songKey:'Key', capo:'Capo', versionNote:'Version', linkUrl:'Link' };
      Object.keys(m).forEach(function(k){ out[sec+'.'+k] = String(o[sec+'.'+k] || o[pre + m[k]] || '').trim(); });
    });
    return out;
  }).filter(function(r){ return !!r.EventKey; });
}

function worshipGetCurrentImportState_(eventKeys){
  const plan = reg_getWorshipPlanningMapByEventKeys_(eventKeys);
  const state = {};
  eventKeys.forEach(function(ev){
    const rota = admin_getServingValuesForEvent_(ev);
    state[ev] = { rota:{}, songs:plan[ev] || {} };
    ['Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument'].forEach(function(p){ state[ev].rota[p] = String(rota[p] || '').trim(); });
  });
  return state;
}

function worshipCanonicalRotaValue_(raw, aliasMap, mi){
  const s = String(raw||'').trim();
  if (!s || /^(VACANT|空缺)$/i.test(s)) return { ok:true, value:'' };
  if (/^(N\/A|NA|不適用)$/i.test(s)) return { ok:true, value:'N/A' };
  if (/^(CLOSED|關閉)$/i.test(s)) return { ok:true, value:'CLOSED' };
  const parts = s.split(/[，,、;；\/|+＋\n\r]+/).map(function(x){ return String(x||'').trim(); }).filter(Boolean);
  const out = [];
  for (let i=0;i<parts.length;i++){
    const res = worshipResolveAliasToCcfId_(parts[i], aliasMap, mi);
    if (!res.ok) return res;
    if (res.special === 'N/A') out.push('N/A');
    else if (res.special === 'CLOSED') return { ok:true, value:'CLOSED' };
    else if (res.ccfId) out.push(res.ccfId);
  }
  return { ok:true, value:out.join(', ') };
}


function worshipRotaValuesEquivalent_(oldVal, newVal){
  const a = String(oldVal || '').trim();
  const b = String(newVal || '').trim();
  if (a === b) return true;
  if (!a || !b) return false;
  if (/^(CLOSED|N\/A)$/i.test(a) || /^(CLOSED|N\/A)$/i.test(b)) return a.toUpperCase() === b.toUpperCase();
  const aa = admin_extractMemberIdsFromServingValue_(a).slice().sort();
  const bb = admin_extractMemberIdsFromServingValue_(b).slice().sort();
  return aa.length > 0 && aa.length === bb.length && aa.join('|') === bb.join('|');
}

function worshipSongValuesEquivalent_(fieldName, oldVal, newVal){
  const a = String(oldVal || '').trim();
  const b = String(newVal || '').trim();
  if (a === b) return true;
  if (/\.songTitle$/.test(String(fieldName || ''))) return worshipCleanNativeSong_(a) === worshipCleanNativeSong_(b);
  return false;
}

function worshipPreviewImportChanges_(auth, input){
  const base = reg_buildWorshipPagePayload_(auth, false);
  if (!base.ok) return base;
  if (!base.permission || !base.permission.canGlRotaEdit) return worshipError_('E_WORSHIP_PERMISSION','你沒有權限匯入敬拜排更','No permission to import worship rota');
  const parsed = worshipImportParseInput_(input);
  if (!parsed.ok) return parsed;
  const mi = admin_getMembersIndex_();
  const aliasMap = worshipReadAliasMap_();
  const todayYmd = Utilities.formatDate(regNow_(), 'Europe/London', 'yyyy-MM-dd');
  const eventKeys = parsed.rows.map(function(r){ return String(r.EventKey||'').trim(); }).filter(function(ev){
    const m = String(ev||'').match(/^SundayService_(\d{4}-\d{2}-\d{2})$/);
    return !!(m && m[1] >= todayYmd);
  });
  const current = worshipGetCurrentImportState_(eventKeys);
  const changes = [], errors = [], warnings = [].concat(parsed.warnings || []), parsedServices = [];
  let fieldsParsed = 0, noChangeFields = 0;
  const positions = ['Worship_Lead','Worship_Singer','Worship_Pianist','Worship_Drum','Worship_Instrument'];
  parsed.rows.forEach(function(r){
    const ev = String(r.EventKey||'').trim();
    if (!admin_isSundayServiceKey_(ev)){
      if (!worshipRowHasMeaningfulImportContent_(r) || /^(HEADER|CATEGORY|CONTINUATION|IGNORED)$/i.test(String(r._rowRole||''))) return;
      if (r._skipReason){ warnings.push({ code:String(r._skipReason), zh:'已略過此列', en:'Row skipped', detail:r._source || ('row ' + (r._rowNumber||'')), eventKey:ev, rowNumber:r._rowNumber||'', sheetName:r._sheetName||'', area:'SKIPPED', fieldName:'EventKey' }); return; }
      errors.push(Object.assign(worshipError_('E_WORSHIP_INVALID_EVENT','活動日期/代碼錯誤','Invalid date/event', ev || ('row ' + (r._rowNumber||''))), { eventKey:ev, rowNumber:r._rowNumber||'', sheetName:r._sheetName||'', message:'請檢查日期欄或標題列是否正確 / Check the date column or header row.' })); return;
    }
    const evYmd = (ev.match(/^SundayService_(\d{4}-\d{2}-\d{2})$/) || [,''])[1];
    const serviceInfo = { eventKey:ev, dateYmd:evYmd || '', sheetName:r._sheetName||'', rowNumber:r._rowNumber||'', parsed:worshipParsedServiceFields_(r), status:(evYmd && evYmd < todayYmd) ? 'PAST_SKIPPED' : 'FUTURE' };
    parsedServices.push(serviceInfo);
    if (evYmd && evYmd < todayYmd){
      warnings.push({ ok:false, code:'E_WORSHIP_PAST_EVENT_SKIPPED', zh:'已略過過去日期', en:'Past event skipped', detail:evYmd + ' < ' + todayYmd, eventKey:ev, rowNumber:r._rowNumber||'', area:'SKIPPED', fieldName:'EventDate', status:'SKIPPED', sheetName:r._sheetName||'' });
      return;
    }
    positions.forEach(function(pos){
      if (r[pos] === undefined) return;
      if (worshipDateCellToEventKey_(r[pos], worshipSheetMonthContext_(r._sheetName||''))){ errors.push(Object.assign(worshipError_('E_WORSHIP_PARSER_GEOMETRY_FAILED','匯入格式解析失敗：日期欄被讀成事奉崗位','Import parser failed: the date column was read as a serving role', (r._sheetName||'') + ' row ' + (r._rowNumber||'') + ' field ' + pos + ' value ' + String(r[pos]||'')), { eventKey:ev, area:'ROTA', fieldName:pos, rowNumber:r._rowNumber||'', sheetName:r._sheetName||'' })); return; }
      const cv = worshipCanonicalRotaValue_(r[pos], aliasMap, mi);
      if (!cv.ok){ errors.push(Object.assign(cv, { eventKey:ev, area:'ROTA', fieldName:pos, rowNumber:r._rowNumber||'', sheetName:r._sheetName||'' })); return; }
      const oldVal = String(((current[ev]||{}).rota||{})[pos] || '').trim();
      if (String(r[pos]||'').trim()) fieldsParsed++;
      if (worshipRotaValuesEquivalent_(oldVal, cv.value)) noChangeFields++;
      if (!worshipRotaValuesEquivalent_(oldVal, cv.value)) changes.push({ eventKey:ev, area:'ROTA', fieldName:pos, oldValue:oldVal, newValue:cv.value, status:'ACCEPTED', sheetName:r._sheetName||'', rowNumber:r._rowNumber||'' });
    });
    REG_WORSHIP_SECTIONS.forEach(function(sec){
      ['songTitle','songKey','capo','versionNote','linkUrl'].forEach(function(k){
        const key = sec+'.'+k;
        if (r[key] === undefined) return;
        let nv = String(r[key]||'').trim();
        const oldVal = String(((((current[ev]||{}).songs||{})[sec]||{})[k]) || '').trim();
        if (nv) fieldsParsed++;
        if (worshipSongValuesEquivalent_(key, oldVal, nv) && nv) noChangeFields++;
        if (!worshipSongValuesEquivalent_(key, oldVal, nv)) changes.push({ eventKey:ev, area:'SONG', fieldName:key, oldValue:oldVal, newValue:nv, status:'ACCEPTED', sheetName:r._sheetName||'', rowNumber:r._rowNumber||'' });
      });
    });
  });
  const effectiveByEvent = {};
  eventKeys.forEach(function(ev){ effectiveByEvent[ev] = Object.assign({}, ((current[ev]||{}).rota||{})); });
  changes.filter(function(c){ return c.area === 'ROTA'; }).forEach(function(c){
    if (!effectiveByEvent[c.eventKey]) effectiveByEvent[c.eventKey] = {};
    effectiveByEvent[c.eventKey][c.fieldName] = c.newValue;
    const max = Number((typeof ADMIN_SERVING_POSITION_MAX === 'object' && ADMIN_SERVING_POSITION_MAX[c.fieldName]) || 1);
    const ids = admin_extractMemberIdsFromServingValue_(c.newValue);
    if (ids.length > max) errors.push(Object.assign(worshipError_('E_WORSHIP_POSITION_CAPACITY','崗位人數超出上限','Too many people for this position', c.fieldName + ': ' + ids.join(', ')), { eventKey:c.eventKey, area:'ROTA', fieldName:c.fieldName }));
  });
  Object.keys(effectiveByEvent).forEach(function(ev){
    const byMember = {};
    positions.forEach(function(pos){
      admin_extractMemberIdsFromServingValue_(String(effectiveByEvent[ev][pos]||'')).forEach(function(id){
        if (!byMember[id]) byMember[id] = [];
        byMember[id].push(pos);
      });
    });
    Object.keys(byMember).forEach(function(id){
      const p = (typeof admin_filterDuplicateConflictPositions_ === 'function') ? admin_filterDuplicateConflictPositions_(byMember[id]) : byMember[id];
      if (p.length > 1) errors.push(Object.assign(worshipError_('E_WORSHIP_DUPLICATE_ASSIGNMENT','同一成員在同日有重複敬拜崗位','Duplicate worship assignment on the same date', id + ': ' + p.join(', ')), { eventKey:ev, area:'ROTA', fieldName:p.join(', ') }));
    });
    const changedIds = {};
    changes.filter(function(c){ return c.area === 'ROTA' && c.eventKey === ev; }).forEach(function(c){ admin_extractMemberIdsFromServingValue_(c.newValue).forEach(function(id){ changedIds[id] = true; }); });
    const ids = Object.keys(changedIds);
    if (ids.length){
      const conflicts = admin_checkServingAwayConflicts_(admin_eventDateFromKey_(ev), ids.map(function(id){ return { memberId:id }; })) || [];
      conflicts.forEach(function(c){ errors.push(Object.assign(worshipError_('E_WORSHIP_HOLIDAY_CONFLICT','事奉安排與假期重疊','Serving assignment overlaps holiday period', (c.memberId||'') + ' ' + (c.from||'') + ' - ' + (c.to||'')), { eventKey:ev, area:'ROTA', fieldName:'holiday' })); });
    }
  });
  const servicesPastSkipped = parsedServices.filter(function(x){ return x.status === 'PAST_SKIPPED'; }).length;
  const servicesFutureParsed = parsedServices.filter(function(x){ return x.status === 'FUTURE'; }).length;
  return { ok:true, importEngineVersion:WORSHIP_IMPORT_ENGINE_VERSION, source:parsed.source || {}, diagnostics:parsed.diagnostics || { sheets:[] }, parsedServices:parsedServices, changes:changes, accepted:changes, errors:errors, warnings:warnings, skipped:warnings, rejected:errors, hasHardErrors:errors.length > 0, canCommit:errors.length === 0, futureOnly:true, todayYmd:todayYmd, summary:{ servicesParsedTotal:parsedServices.length, servicesFutureParsed:servicesFutureParsed, servicesPastSkipped:servicesPastSkipped, fieldsParsed:fieldsParsed, changesAccepted:changes.length, noChangeFields:noChangeFields, accepted:changes.length, errors:errors.length, skipped:servicesPastSkipped, warnings:warnings.length } };
}

function worshipCommitImportChanges_(auth, input, overrideAway, actionSource){
  const preview = worshipPreviewImportChanges_(auth, input);
  if (!preview.ok) return preview;
  if (preview.hasHardErrors) return worshipError_('E_WORSHIP_IMPORT_BLOCKED','匯入有錯誤，請先修正試算表後再匯入','Import has errors; fix the spreadsheet and import again', (preview.errors||[]).map(function(e){ return e.code + ':' + (e.detail||e.fieldName||''); }).join(' | '));
  const actorId = String((auth && auth.parsed && auth.parsed.id) || '').toUpperCase();
  const token = reg_issueTempAdminTokenForWorship_(actorId);
  if (!token) return worshipError_('E_WORSHIP_PERMISSION','授權失敗','Authorization failed');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    const byEvent = {};
    (preview.changes||[]).forEach(function(c){ if (!byEvent[c.eventKey]) byEvent[c.eventKey] = { rota:[], songs:[] }; byEvent[c.eventKey][c.area === 'ROTA' ? 'rota' : 'songs'].push(c); });
    Object.keys(byEvent).forEach(function(ev){
      const rotaRows = byEvent[ev].rota.map(function(c){ return { position:c.fieldName, value:c.newValue }; });
      if (rotaRows.length){
        const res = api_admin_serving_event_save(token, ev, rotaRows, !!overrideAway, 'WORSHIP');
        if (!res || !res.ok) throw new Error(JSON.stringify(res || worshipError_('E_WORSHIP_ROTA_SAVE','排更儲存失敗','Rota save failed')));
      }
      const songBySec = {};
      byEvent[ev].songs.forEach(function(c){ const m = String(c.fieldName).split('.'); if (!songBySec[m[0]]) songBySec[m[0]] = {}; songBySec[m[0]][m[1]] = c.newValue; });
      Object.keys(songBySec).forEach(function(sec){
        const old = reg_getWorshipPlanningMapByEventKeys_([ev])[ev][sec] || {};
        const p = Object.assign({ eventKey:ev, songSection:sec, songTitle:old.songTitle||'', songKey:old.songKey||'', capo:old.capo||'', versionNote:old.versionNote||'', linkUrl:old.linkUrl||'', linkTitle:old.linkTitle||'' }, songBySec[sec]);
        if (p.linkUrl && !p.songTitle){ const yt = reg_tryFetchYoutubeMeta_(p.linkUrl); if (yt.ok && yt.title){ p.songTitle = yt.title; p.linkTitle = yt.title; } }
        const sr = reg_worship_song_save_with_auth_(auth, p, actionSource || 'SELF_WORSHIP_IMPORT');
        if (!sr || !sr.ok) throw new Error(JSON.stringify(sr));
      });
    });
    const now = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd HH:mm:ss');
    const audit = (preview.changes||[]).filter(function(c){ return c.area === 'ROTA'; }).map(function(c){ return [now, actorId, c.eventKey, 'ROTA', c.fieldName, c.oldValue, c.newValue, actionSource || 'SELF_WORSHIP_IMPORT', 'spreadsheet import']; });
    reg_writeWorshipAuditRows_(audit);
    return { ok:true, changed:(preview.changes||[]).length, changes:preview.changes };
  }catch(e){ return regErr_('E_WORSHIP_IMPORT_COMMIT_FAILED','匯入寫入失敗','Import commit failed', e); }
  finally{ try{ lock.releaseLock(); }catch(e){} }
}

function worshipBuildExportRowsFromExistingRotaAndSongs_(auth){
  const data = reg_buildWorshipPagePayload_(auth, false);
  if (!data.ok) return data;
  const headers = ['EventKey','Date','主領 / Lead','和唱 / Singer','司琴 / Pianist','鼓 / Drum','樂器 / Instrument'];
  ['敬拜 1','敬拜 2','敬拜 3','敬拜 4'].forEach(function(label){
    headers.push(label + ' Title / Worship ' + label.replace('敬拜 ',''), label + ' Key', label + ' Capo', label + ' Version / Note', label + ' Link / YouTube / Chord');
  });
  ['回應 1','回應 2'].forEach(function(label){
    headers.push(label + ' Title / Response ' + label.replace('回應 ',''), label + ' Key', label + ' Capo', label + ' Version / Note', label + ' Link / YouTube / Chord');
  });
  const rows = (data.events||[]).map(function(ev){
    const s = ev.songs || {}; function g(sec,k){ return String(((s[sec]||{})[k]) || ''); }
    const r = ev.rota || {};
    const row = [ev.eventKey, ev.dateYmd || ev.eventKey.replace('SundayService_',''), r.Worship_Lead || '', r.Worship_Singer || '', r.Worship_Pianist || '', r.Worship_Drum || '', r.Worship_Instrument || ''];
    REG_WORSHIP_SECTIONS.forEach(function(sec){ row.push(g(sec,'songTitle'), g(sec,'songKey'), g(sec,'capo'), g(sec,'versionNote'), g(sec,'linkUrl')); });
    return row;
  });
  return { ok:true, headers:headers, rows:rows };
}

function api_reg_self_worship_import_probe_public(qrPayload, input){
  try{ const auth = regGetSelfMemberByQr_(qrPayload); if (!auth.ok) return auth; return worshipBuildImportProbe_(input); }
  catch(e){ return regErr_('E_WORSHIP_PROBE_FAILED','匯入診斷失敗','Import probe failed', e); }
}

function api_reg_self_worship_import_preview_public(qrPayload, spreadsheetUrlOrId){
  try{ const auth = regGetSelfMemberByQr_(qrPayload); if (!auth.ok) return auth; return worshipPreviewImportChanges_(auth, spreadsheetUrlOrId); }
  catch(e){ return regErr_('E_WORSHIP_PREVIEW_FAILED','匯入預覽失敗','Import preview failed', e); }
}

function api_reg_self_worship_import_commit_public(qrPayload, spreadsheetUrlOrId, overrideAway){
  try{ const auth = regGetSelfMemberByQr_(qrPayload); if (!auth.ok) return auth; return worshipCommitImportChanges_(auth, spreadsheetUrlOrId, overrideAway, 'SELF_WORSHIP_IMPORT'); }
  catch(e){ return regErr_('E_WORSHIP_IMPORT_FAILED','匯入失敗','Import failed', e); }
}

function api_reg_self_worship_export_public(qrPayload, format){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const data = worshipBuildExportRowsFromExistingRotaAndSongs_(auth);
    if (!data.ok) return data;
    const ss = SpreadsheetApp.create('Worship_Export_' + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd_HHmmss'));
    const sh = ss.getSheets()[0];
    sh.setName('Worship_Import');
    const stamp = Utilities.formatDate(new Date(), 'Europe/London', 'dd/MM/yy HH:mm:ss');
    const warnEn = 'Exported at ' + stamp + '. Uncontrolled when exported. Please refer to portal for latest version.';
    const warnZh = '匯出時間：' + stamp + '。匯出後屬非受控版本，請以系統最新資料為準。';
    sh.getRange(1,1,1,data.headers.length).merge().setValue(warnEn + '\n' + warnZh).setFontWeight('bold').setBackground('#fff3cd');
    sh.getRange(3,1,1,data.headers.length).setValues([data.headers]).setFontWeight('bold');
    if (data.rows.length) sh.getRange(4,1,data.rows.length,data.headers.length).setValues(data.rows);
    sh.setFrozenRows(3);
    sh.autoResizeColumns(1, data.headers.length);
    if (String(format||'').toUpperCase() === 'PDF'){
      const pdf = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=pdf&portrait=false&fitw=true&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=true&fzr=false', { headers:{ Authorization:'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
      return { ok:true, kind:'PDF', filename:'Worship_Export.pdf', base64:Utilities.base64Encode(pdf.getBytes()) };
    }
    return { ok:true, kind:'SPREADSHEET', url:ss.getUrl(), spreadsheetId:ss.getId(), warning:warnEn + ' ' + warnZh };
  }catch(e){ return regErr_('E_WORSHIP_EXPORT_FAILED','匯出失敗','Export failed', e); }
}

function getServingGroupLabelZh_(raw){
  const k = admin_normalizeServingGroup_(raw);
  if (k === 'worship') return '敬拜聯盟';
  if (k === 'media') return '影像大師';
  if (k === 'logistic') return '後勤特工';
  if (k === 'support') return '聖工支援隊';
  if (k === 'finance') return '財務公司';
  return raw || '';
}
function getServingGroupLabelEn_(raw){
  const k = admin_normalizeServingGroup_(raw);
  if (k === 'worship') return 'Worship Alliance';
  if (k === 'media') return 'Media Master';
  if (k === 'logistic') return 'Logistic Specialist';
  if (k === 'support') return 'Divine Supporter';
  if (k === 'finance') return 'Finance Dept';
  return raw || '';
}


function api_reg_self_set_holiday_public(qrPayload, fromDmy1, toDmy1, fromDmy2, toDmy2){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const id = auth.parsed.id;

    const fromYmd1 = admin_parseDmyToYmd_(fromDmy1);
    const toYmd1 = admin_parseDmyToYmd_(toDmy1);
    const fromYmd2 = admin_parseDmyToYmd_(fromDmy2);
    const toYmd2 = admin_parseDmyToYmd_(toDmy2);

    function bothOrNone(fromYmd, toYmd){
      return (!fromYmd && !toYmd) || (fromYmd && toYmd);
    }
    if (!bothOrNone(fromYmd1, toYmd1) || !bothOrNone(fromYmd2, toYmd2)) {
      return { ok:false, code:'E422', zh:'假期日期格式錯誤', en:'Holiday date format invalid.' };
    }

    const periods = [];
    if (fromYmd1 && toYmd1) periods.push({ from: fromYmd1, to: toYmd1 });
    if (fromYmd2 && toYmd2) periods.push({ from: fromYmd2, to: toYmd2 });
    for (let i=0;i<periods.length;i++){
      const aFrom = admin_parseYmd_(periods[i].from), aTo = admin_parseYmd_(periods[i].to);
      if (!aFrom || !aTo || aTo.getTime() < aFrom.getTime()) return { ok:false, code:'E423', zh:'結束日期不可早於開始日期', en:'End date cannot be before start date.' };
      for (let j=i+1;j<periods.length;j++){
        const bFrom = admin_parseYmd_(periods[j].from), bTo = admin_parseYmd_(periods[j].to);
        if (aFrom.getTime() <= bTo.getTime() && bFrom.getTime() <= aTo.getTime()) return regConflict_('兩段假期不可重疊', 'Holiday periods cannot overlap.', '', 'HOLIDAY_PERIOD_OVERLAP', 'HOLIDAY');
      }
    }

    const assignmentConflicts = (typeof admin_getServingAssignmentsForMemberInPeriods_ === 'function')
      ? admin_getServingAssignmentsForMemberInPeriods_(id, periods)
      : [];
    if (assignmentConflicts.length){
      const detail = assignmentConflicts.map(function(it){ return (it.dateYmd||'') + ' ' + (admin_servingPositionZh_(it.position||'') || it.position || ''); }).join(' | ');
      return regConflict_('設定假期前，請先取消該時段已報名的事奉。', 'Please cancel serving dates within the selected holiday period before saving holiday.', detail, 'HOLIDAY_HAS_SERVING_ASSIGNMENTS', 'HOLIDAY');
    }

    const sh = getMembersSheet_();
    const col = admin_getMembersColMap_(sh);
    admin_ensureAwayColumns_(sh, col);
    const row = admin_findMemberRowById_(sh, col, id);
    if (!row) return { ok:false, code:'E412', zh:'找不到會員列', en:'Member row not found.' };

    const p1 = periods[0] || { from:'', to:'' };
    const p2 = periods[1] || { from:'', to:'' };
    sh.getRange(row, col.AwayFrom1+1).setValue(p1.from || '');
    sh.getRange(row, col.AwayTo1+1).setValue(p1.to || '');
    sh.getRange(row, col.AwayFrom2+1).setValue(p2.from || '');
    sh.getRange(row, col.AwayTo2+1).setValue(p2.to || '');
    if (typeof admin_appendAwayHistory_ === 'function') {
      admin_appendAwayHistory_(id, [p1, p2].filter(function(x){ return x.from && x.to; }), { id:id, status:'MEMBER' });
    }

    regLogActivity_('REG_SELF_HOLIDAY_SET', id, 'OK', { from1:p1.from||'', to1:p1.to||'', from2:p2.from||'', to2:p2.to||'' });
    if (typeof admin_clearMembersCache_ === 'function') admin_clearMembersCache_();
    return { ok:true, from1:p1.from||'', to1:p1.to||'', from2:p2.from||'', to2:p2.to||'' };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}
/* ============================================================
 * PATCH_BOUNDARY: REG4_SELF_SERVICE_PORTAL_END
 * ============================================================ */

/******** Update apply ********/
function regApplyUpdate_(ms, rowNumber, memberId, stOld, isStaff, data, inObj){
  const deviceId = String(inObj.deviceId||'');
  const ua = String(inObj.ua||'');

  const oldRow = regReadRow_(ms, rowNumber);
  // A member already marked under 18 cannot remove that flag through public
  // self-service. STAFF/ADMIN performs the separate reauthenticated 18+ step.
  if (String(oldRow.IsMinor||'').trim().toUpperCase() === 'YES' && !data.isMinor){
    data.isMinor = true;
  }

  /* PATCH_BOUNDARY: REG2_KEEP_EXISTING_QR_BEGIN */
  const keepExistingQr = !!(inObj && inObj.keepExistingQr);
  const oldKey = String(oldRow.Key || '').trim();
  let keyToUse = oldKey;
  if (!keepExistingQr) {
    const newKey = regGenerateUniqueKeyFromScan_(ms);
    regWriteCell_(ms, rowNumber, 'Key', newKey);
    keyToUse = newKey;
  }
  /* PATCH_BOUNDARY: REG2_KEEP_EXISTING_QR_END */

  const oldEmail = String(oldRow.Email||'').trim();
  const newEmail = String(data.email||'').trim();
  const emailChanged = !!(regNormEmail_(oldEmail) && regNormEmail_(oldEmail) !== regNormEmail_(newEmail));

  /* PATCH_BOUNDARY: REG1_CHANGEDFIELDS_BEGIN */
  const changedFields = regComputeChangedFields_(oldRow, data);
  /* PATCH_BOUNDARY: REG1_CHANGEDFIELDS_END */

  // Apply updates
  regWriteCell_(ms, rowNumber, 'NameZh', data.nameZh);
  regWriteCell_(ms, rowNumber, 'NameEn', data.nameEn);
  regWriteCell_(ms, rowNumber, 'PreferredName', data.preferredName);

  regWriteCell_(ms, rowNumber, 'Email', data.email);
  regWriteCell_(ms, rowNumber, 'Mobile', data.mobile);

  regWriteCell_(ms, rowNumber, 'Notes', data.notes);
  regWriteCell_(ms, rowNumber, 'OptOutEmail', data.optInEmail ? '' : 'OPTOUT');

  regWriteCell_(ms, rowNumber, 'HasCar', data.hasCar ? 'YES' : 'NO');
  regWriteCell_(ms, rowNumber, 'VRM', data.hasCar ? data.vrm : '');
  regWriteCell_(ms, rowNumber, 'VRM2', data.hasCar ? data.vrm2 : '');

  regWriteCell_(ms, rowNumber, 'IsMinor', data.isMinor ? 'YES' : 'NO');
  regWriteCell_(ms, rowNumber, 'ParentEmail', data.parentEmail || '');
  regWriteCell_(ms, rowNumber, 'Gender', data.gender || '');

  /* PATCH_BOUNDARY: REG2_REFERREDBY_WRITE_BEGIN */
  regWriteCell_(ms, rowNumber, 'ReferredBy', data.referredBy || '');
  /* PATCH_BOUNDARY: REG2_REFERREDBY_WRITE_END */

  /* PATCH_BOUNDARY: REG2_PRESERVE_ADMIN_STATUS_BEGIN */
  const stOldNorm = String(stOld||'').toUpperCase();
  // A later profile/email change for one family member must not change that
  // member's workflow state. Legacy non-family updates retain their existing
  // promotion behaviour.
  const preserveFamilyStatus = !!String(oldRow.FamilyID || '').trim();
  const newStatusToWrite = (stOldNorm === 'ADMIN')
    ? 'ADMIN'
    : ((stOldNorm === 'STAFF')
      ? 'STAFF'
      : (preserveFamilyStatus ? (stOldNorm || 'ACTIVE') : 'ACTIVE'));
  regWriteCell_(ms, rowNumber, 'Status', newStatusToWrite);
  /* PATCH_BOUNDARY: REG2_PRESERVE_ADMIN_STATUS_END */

  regClearMembersIndexCache_();

  const payload = memberId + '|' + keyToUse;

  const includeWhatsApp = (!isStaff && String(stOld||'').toUpperCase() === 'PROVISIONAL');

  const toEmail = isStaff ? (newEmail || oldEmail || '') : (data.optInEmail ? newEmail : '');
  const alertEmails = [];
  if (emailChanged && oldEmail) alertEmails.push(oldEmail);
  if (emailChanged && String(oldRow.IsMinor||'').trim().toUpperCase() === 'YES' && oldRow.ParentEmail){
    alertEmails.push(String(oldRow.ParentEmail||'').trim());
  }

  const g = regPickGreetings_(data.nameZh, data.nameEn, data.preferredName);
  const emailMeta = { optInEmail: !!data.optInEmail, emailProvided: !!data.email };

  const emailRes = regSendEmails_({
    kind: 'UPDATE',
    toEmail,
    oldEmail: alertEmails[0] || '',
    alertEmails: alertEmails,
    memberId,
    payload,
    greetZh: g.greetZh,
    greetEn: g.greetEn,
    nameZh: data.nameZh,
    nameEn: data.nameEn,
    deviceHint: regDeviceHint_(inObj),
    changedFields: changedFields,
    isStaff: isStaff,
    includeWhatsApp: includeWhatsApp,
    emailOptIn: emailMeta.optInEmail,
    emailProvided: emailMeta.emailProvided
  });

  regLogActivity_('REG_UPDATE', memberId, 'OK', {
    oldStatus: String(stOld||''),
    newStatus: newStatusToWrite,
    includeWhatsApp: includeWhatsApp ? 'YES' : 'NO',
    emailOptIn: emailMeta.optInEmail ? 'YES' : 'NO',
    emailProvided: emailMeta.emailProvided ? 'YES' : 'NO',
    emailSent: emailRes.sentToNew ? 'YES' : 'NO',
    reason: emailRes.reason || '',
    keepExistingQr: keepExistingQr ? 'YES' : 'NO',
    deviceId, ua
  });

  return {
    ok:true,
    mode:'UPDATE',
    memberId,
    qrPayload: payload,
    changedFields,
    email: emailRes,
    emailMeta: emailMeta,
    greet: { zh: g.greetZh, en: g.greetEn },
    keepExistingQr: keepExistingQr
  };
}

/* ============================================================
 * PATCH_BOUNDARY: REG1_COMPUTE_CHANGED_FIELDS_IMPLEMENTATION_BEGIN
 * regComputeChangedFields_ (extended minimally for ReferredBy)
 * ============================================================ */
function regComputeChangedFields_(oldRow, data){
  const out = [];

  function add(label){ if (label) out.push(label); }
  function normStr(x){ return String(x||'').trim(); }
  function normEmail(x){ return regNormEmail_(x); }
  function normMobile(x){ return String(x||'').trim(); }
  function normYesNo(x){
    const v = String(x||'').trim().toUpperCase();
    if (v === 'YES') return 'YES';
    if (v === 'NO') return 'NO';
    return '';
  }
  function normOptInFromOld(optOutEmail){
    return !regIsOptedOut_(optOutEmail);
  }
  function normVrm(x){ return regNormalizeVrm_(x); }
  function eqCI(a,b){ return String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase(); }

  // Names
  if (normStr(oldRow.NameZh) !== normStr(data.nameZh)) add('中文名/Chinese name');
  if (normStr(oldRow.NameEn) !== normStr(data.nameEn)) add('英文名/English name');
  if (normStr(oldRow.PreferredName) !== normStr(data.preferredName)) add('常用稱呼/Preferred name');

  // Contact
  if (normEmail(oldRow.Email) !== normEmail(data.email)) add('電郵/Email');
  if (normMobile(oldRow.Mobile) !== normMobile(data.mobile)) add('手機/Mobile');

  // Notes
  if (normStr(oldRow.Notes) !== normStr(data.notes)) add('備註/Notes');

  // Email opt-in
  const oldOptIn = normOptInFromOld(oldRow.OptOutEmail);
  if (!!oldOptIn !== !!data.optInEmail) add('接收電郵/Email opt-in');

  // Car / VRM
  const oldHasCar = normYesNo(oldRow.HasCar) === 'YES';
  if (!!oldHasCar !== !!data.hasCar) add('是否有車/Has car');

  const oldVrm1 = oldHasCar ? normVrm(oldRow.VRM) : '';
  const oldVrm2 = oldHasCar ? normVrm(oldRow.VRM2) : '';
  const newVrm1 = data.hasCar ? normVrm(data.vrm) : '';
  const newVrm2 = data.hasCar ? normVrm(data.vrm2) : '';
  if (oldVrm1 !== newVrm1) add('車牌1/VRM1');
  if (oldVrm2 !== newVrm2) add('車牌2/VRM2');

  // Minor / parent email
  const oldIsMinor = normYesNo(oldRow.IsMinor) === 'YES';
  if (!!oldIsMinor !== !!data.isMinor) add('未滿18/Under 18');

  const oldParent = normStr(oldRow.ParentEmail);
  const newParent = normStr(data.parentEmail || '');
  if (!eqCI(oldParent, newParent)) add('家長電郵/Parent email');

  const oldGender = normStr(oldRow.Gender).toUpperCase();
  const newGender = normStr(data.gender || '').toUpperCase();
  if (oldGender !== newGender) add('性別/Gender');

  /* PATCH_BOUNDARY: REG2_REFERREDBY_CHANGEDFIELDS_BEGIN */
  const oldRef = normStr(oldRow.ReferredBy);
  const newRef = normStr(data.referredBy || '');
  if (!eqCI(oldRef, newRef)) add('介紹人/Referred by');
  /* PATCH_BOUNDARY: REG2_REFERREDBY_CHANGEDFIELDS_END */

  return out;
}
/* ============================================================
 * PATCH_BOUNDARY: REG1_COMPUTE_CHANGED_FIELDS_IMPLEMENTATION_END
 * ============================================================ */

/******** Validation ********/
function regValidateInput_(inObj){
  const nameZh = String(inObj.nameZh||'').trim();
  const nameEn = String(inObj.nameEn||'').trim();
  const preferredName = String(inObj.preferredName||'').trim();

  const email = String(inObj.email||'').trim();

  const phoneParsed = regParseAndValidatePhone_(inObj);
  if (!phoneParsed.ok) return phoneParsed;
  const mobile = phoneParsed.mobile;

  const notes = String(inObj.notes||'').trim();
  const optInEmail = !!inObj.optInEmail;

  const hasCarRaw = String(inObj.hasCar||'').trim().toUpperCase();
  const hasCar = (hasCarRaw === 'YES');
  const vrm = regNormalizeVrm_(inObj.vrm||'');
  const vrm2 = regNormalizeVrm_(inObj.vrm2||'');

  const isMinor = !!inObj.isMinor;
  const parentEmail = String(inObj.parentEmail||'').trim();
  const genderRaw = String(inObj.gender||'').trim().toUpperCase();
  const genderAllowed = { MALE:true, FEMALE:true, OTHER:true, PREFER_NOT:true };

  /* PATCH_BOUNDARY: REG2_REFERREDBY_VALIDATE_BEGIN */
  const referredBy = String(inObj.referredBy||'').trim();
  /* PATCH_BOUNDARY: REG2_REFERREDBY_VALIDATE_END */

  if (email && parentEmail && regNormEmail_(email) === regNormEmail_(parentEmail)){
    return { ok:false, code:'E461', zh:'家長電郵與本人電郵相同，請刪除其中一個或改用不同電郵。', en:'Parent email equals member email. Remove one or use a different email.' };
  }

  if (!email && !mobile) return { ok:false, code:'E421', zh:'請填寫手機或電郵（至少一項）', en:'Please provide mobile or email (at least one).' };
  if (!nameZh && !nameEn) return { ok:false, code:'E422', zh:'請填寫中文名或英文名（至少一項）', en:'Please provide Chinese or English name (at least one).' };
  if (!nameZh && nameEn && nameEn.split(/\s+/).filter(Boolean).length < 2){
    return { ok:false, code:'E423', zh:'只填英文名時，請同時填寫名及姓（例如 Chan Tai Man）', en:'If only English name is provided, include both first and last name.' };
  }
  if (optInEmail && !email){
    return { ok:false, code:'E424', zh:'如選擇接收電郵，請填寫電郵；或取消勾選後再繼續', en:'Email is required if email opt-in is checked.' };
  }
  if (!genderAllowed[genderRaw]){
    return { ok:false, code:'E427', zh:'請選擇性別 / Please select gender', en:'Please select gender.' };
  }
  if (hasCarRaw !== 'YES' && hasCarRaw !== 'NO'){
    return { ok:false, code:'E425', zh:'請選擇是否有車', en:'Please choose whether you have a car.' };
  }
  if (hasCar && !vrm && !vrm2){
    return { ok:false, code:'E426', zh:'如有車，請填寫至少一個車牌', en:'If you have a car, provide at least one VRM.' };
  }

  return {
    ok:true,
    data:{
      nameZh, nameEn, preferredName,
      email,
      mobile,
      notes,
      optInEmail,
      hasCar,
      vrm: hasCar ? vrm : '',
      vrm2: hasCar ? vrm2 : '',
      isMinor: !!isMinor,
      parentEmail: parentEmail,
      gender: genderRaw,
      /* PATCH_BOUNDARY: REG2_REFERREDBY_DATA_BEGIN */
      referredBy: referredBy
      /* PATCH_BOUNDARY: REG2_REFERREDBY_DATA_END */
    }
  };
}

function regParseAndValidatePhone_(inObj){
  const cc = String(inObj.phoneCc || '').trim();
  const nat = String(inObj.phoneNat || '').trim();

  if (cc || nat){
    const ccDigits = cc.replace(/\D/g,'');
    const natDigits = nat.replace(/\D/g,'');
    if (!ccDigits || !natDigits) return { ok:true, mobile: '' };
    return regValidateByCountry_(ccDigits, natDigits);
  }

  const raw = regSanitizeMobile_(String(inObj.mobile||''));
  if (!raw) return { ok:true, mobile: '' };

  const m = raw.match(/^\+(\d{1,4})(\d{6,15})$/);
  if (!m){
    return { ok:false, code:'E472', zh:'手機格式不正確（請使用國碼，例如 +44… 或 +852…）', en:'Invalid phone format (use country code, e.g. +44… or +852…).'};
  }
  return regValidateByCountry_(m[1], m[2]);
}

function regValidateByCountry_(ccDigits, natDigits){
  if (ccDigits === '852'){
    if (natDigits.length !== 8){
      return { ok:false, code:'E471', zh:'香港號碼必須為 8 位數。', en:'Hong Kong number must be 8 digits.' };
    }
    return { ok:true, mobile: '+852' + natDigits };
  }
  if (ccDigits === '44'){
    if (natDigits.length === 11 && natDigits.startsWith('0')) return { ok:true, mobile: '+44' + natDigits.slice(1) };
    if (natDigits.length === 10) return { ok:true, mobile: '+44' + natDigits };
    return { ok:false, code:'E471', zh:'英國號碼格式不正確（10 位數，或 11 位並以 0 開頭）。', en:'UK number invalid (10 digits, or 11 digits starting with 0).' };
  }
  const total = (ccDigits + natDigits);
  if (total.length < 7 || total.length > 15){
    return { ok:false, code:'E471', zh:'手機號碼位數不合理。', en:'Phone number length looks invalid.' };
  }
  return { ok:true, mobile: '+' + ccDigits + natDigits };
}

function regSanitizeMobile_(s){
  let raw = String(s||'').trim().replace(/\s+/g,'');
  if (!raw) return '';
  if (raw === '+' || raw === '+44' || raw === '44') return '';
  return raw;
}


function regSafeToDate_(v){
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  const s = String(v||'').trim();
  if (!s) return null;

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
        return dt;
      }
    }
  }

  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Debug helper for Member_Since parsing scenarios.
function reg_debugMemberSinceParsing_(){
  const cases = [
    { input: new Date('2026-01-18T12:46:18Z'), expect: '2026-01-18' },
    { input: '2026-01-18', expect: '2026-01-18' },
    { input: '2026-01-18T12:46:18Z', expect: '2026-01-18' },
    { input: '18/01/2026', expect: '2026-01-18' },
    { input: '18/01/2026 12:46:18', expect: '2026-01-18' },
    { input: '31/02/2026 12:00:00', expect: '' }
  ];
  const out = cases.map(function(c){
    const dt = regSafeToDate_(c.input);
    const actual = dt ? Utilities.formatDate(dt, 'Europe/London', 'yyyy-MM-dd') : '';
    return { input: String(c.input), expect: c.expect, actual: actual, pass: actual === c.expect };
  });
  Logger.log(JSON.stringify(out));
  return out;
}

/******** Hard-stops ********/
function regEnforceHardStops_(data, excludeId){
  if (data.nameZh && data.nameEn){
    const zhKey = regNormName_(data.nameZh);
    const enKey = regNormName_(data.nameEn);
    const cnt = regCountRows_(r => regNormName_(r.NameZh)===zhKey && regNormName_(r.NameEn)===enKey, excludeId);
    if (cnt >= 2) return { ok:false, code:'E451', zh:'同一中文名 + 英文名 已登記多於 2 次，請停止並聯絡影音同工處理。', en:'This exact Chinese+English name is already registered more than twice.' };
  }
  const email = regNormEmail_(data.email);
  if (email){
    const cntE = regCountRows_(r => regNormEmail_(r.Email)===email, excludeId);
    if (cntE >= 4) return { ok:false, code:'E452', zh:'此電郵已由 4 個未停用的會員記錄使用；請改用另一個電郵或聯絡影音同工。', en:'This email is already used by four non-disabled member records. Use another email or contact Media team.' };
  }
  return { ok:true };
}

/******** Members scan / allocation / row io ********/
function regGetMembersScan_(opts){
  opts = opts || {};
  const sh = getMembersSheet_(); // from Code.gs
  let lastCol = sh.getLastColumn();
  let headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
  const col = {};
  headers.forEach((h,i)=>{ if(h) col[h]=i; });

  if (opts.ensureExtras){
    let curLast = lastCol;
    for (const h of REG_EXTRA_HEADERS){
      if (col[h] !== undefined) continue;
      sh.insertColumnAfter(curLast);
      curLast++;
      sh.getRange(1, curLast).setValue(h).setFontWeight('bold');
      col[h] = curLast - 1;
    }
    lastCol = sh.getLastColumn();
    headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h||'').trim());
    Object.keys(col).forEach(k => delete col[k]);
    headers.forEach((h,i)=>{ if(h) col[h]=i; });
  }

  const lastRow = sh.getLastRow();
  const data = (lastRow >= 2) ? sh.getRange(2,1,lastRow-1,lastCol).getValues() : [];
  const dataRows = data.map((row, idx)=> regRowObj_(col, row, idx+2));
  return { sh, col, lastCol, lastRow, dataRows };
}

function regRowObj_(col, row, rowNumber){
  function g(h){ return (col[h] === undefined) ? '' : row[col[h]]; }
  return {
    rowNumber,
    FamilyID: String(g('FamilyID')||'').trim(),
    MemberLetter: String(g('MemberLetter')||'').trim(),
    ID: String(g('ID')||'').trim().toUpperCase(),
    Key: String(g('Key')||'').trim(),
    NameZh: String(g('NameZh')||'').trim(),
    NameEn: String(g('NameEn')||'').trim(),
    PreferredName: String(g('PreferredName')||'').trim(),
    Email: String(g('Email')||'').trim(),
    Mobile: String(g('Mobile')||'').trim(),
    Status: String(g('Status')||'').trim(),
    OptOutEmail: String(g('OptOutEmail')||'').trim(),
    Notes: String(g('Notes')||'').trim(),
    HasCar: String(g('HasCar')||'').trim(),
    VRM: String(g('VRM')||'').trim(),
    VRM2: String(g('VRM2')||'').trim(),
    IsMinor: String(g('IsMinor')||'').trim(),
    ParentEmail: String(g('ParentEmail')||'').trim(),
    MinorServingApprovedGroups: String(g('MinorServingApprovedGroups')||'').trim(),
    MinorServingSelfSignup: String(g('MinorServingSelfSignup')||'').trim(),
    MinorServingApprovedBy: String(g('MinorServingApprovedBy')||'').trim(),
    MinorServingApprovedAt: String(g('MinorServingApprovedAt')||'').trim(),
    Gender: String(g('Gender')||'').trim().toUpperCase(),
    /* PATCH_BOUNDARY: REG2_REFERREDBY_ROWOBJ_BEGIN */
    ReferredBy: String(g('ReferredBy')||'').trim(),
    /* PATCH_BOUNDARY: REG2_REFERREDBY_ROWOBJ_END */
    Member_Since: g('Member_Since'),
    ServingGroups: String(g('ServingGroups')||'').trim(),
    ServingGLGroups: String(g('ServingGLGroups')||'').trim()
  };
}

function regFindRowByIdFromScan_(ms, id){
  id = String(id||'').trim().toUpperCase();
  for (const r of ms.dataRows){
    if (r.ID === id) return r.rowNumber;
  }
  return null;
}

function regReadRow_(ms, rowNumber){
  const r = ms.dataRows.find(x => x.rowNumber === rowNumber);
  if (r) return r;
  const row = ms.sh.getRange(rowNumber, 1, 1, ms.lastCol).getValues()[0];
  return regRowObj_(ms.col, row, rowNumber);
}

function regWriteCell_(ms, rowNumber, header, value){
  const c = ms.col[header];
  if (c === undefined) return;
  ms.sh.getRange(rowNumber, c+1).setValue(value);
}

function regCountRows_(predicateFn, excludeId){
  const ms = regGetMembersScan_();
  let n = 0;
  for (const r of ms.dataRows){
    const st = regStatus_(r.Status);
    if (st === 'DISABLED') continue;
    if (excludeId && r.ID === excludeId) continue;
    if (predicateFn(r)) n++;
  }
  return n;
}

function regAllocateSmallestIdAndKey_(ms){
  const usedNums = new Set();
  const usedKeys = new Set();

  for (const r of ms.dataRows){
    const m = r.ID.match(/^CCF(\d{4})$/);
    if (m){
      const n = parseInt(m[1],10);
      if (!isNaN(n) && n >= REG_MIN_ID_NUM && n <= REG_MAX_ID_NUM) usedNums.add(n);
    }
    if (r.Key) usedKeys.add(r.Key);
  }

  let chosen = null;
  for (let n=REG_MIN_ID_NUM; n<=REG_MAX_ID_NUM; n++){
    if (!usedNums.has(n)) { chosen = n; break; }
  }
  if (chosen === null){
    return { ok:false, code:'E433', zh:'ID 已用盡（CCF0101–CCF9999）', en:'IDs exhausted (CCF0101–CCF9999).' };
  }

  const id = 'CCF' + String(chosen).padStart(4,'0');

  let key = '';
  for (let tries=0; tries<60; tries++){
    const cand = regNewKey_();
    if (!usedKeys.has(cand)){ key = cand; break; }
  }
  if (!key) return { ok:false, code:'E500', zh:'無法產生 Key', en:'Failed to generate Key.' };

  return { ok:true, id, key };
}

function regGenerateUniqueKeyFromScan_(ms){
  const usedKeys = new Set();
  for (const r of ms.dataRows){
    if (r.Key) usedKeys.add(r.Key);
  }
  for (let tries=0; tries<60; tries++){
    const cand = regNewKey_();
    if (!usedKeys.has(cand)) return cand;
  }
  throw new Error('Failed to generate unique Key');
}

function regNewKey_(){
  const u = Utilities.getUuid().replace(/-/g,'').toUpperCase();
  return 'k' + u.slice(0, 20);
}

function regBuildAppendRow_(ms, obj){
  const row = new Array(ms.lastCol).fill('');
  function set(h, v){
    const c = ms.col[h];
    if (c === undefined) return;
    row[c] = v;
  }

  set('FamilyID', obj.familyId || '');
  set('MemberLetter', obj.memberLetter || '');
  set('ID', obj.id);
  set('Key', obj.key);

  set('NameZh', obj.nameZh || '');
  set('NameEn', obj.nameEn || '');
  set('Email', obj.email || '');
  set('Mobile', obj.mobile || '');
  set('Status', obj.status || 'ACTIVE');
  set('OptOutEmail', obj.optInEmail ? '' : 'OPTOUT');
  set('Notes', obj.notes || '');

  set('Member_Since', obj.memberSince || regNow_());
  set('PreferredName', obj.preferredName || '');
  set('HasCar', obj.hasCar ? 'YES' : 'NO');
  set('VRM', obj.hasCar ? (obj.vrm || '') : '');
  set('VRM2', obj.hasCar ? (obj.vrm2 || '') : '');

  set('IsMinor', obj.isMinor ? 'YES' : 'NO');
  set('ParentEmail', obj.parentEmail || '');
  set('MinorServingApprovedGroups', '');
  set('MinorServingSelfSignup', 'NO');
  set('MinorServingApprovedBy', '');
  set('MinorServingApprovedAt', '');
  set('Gender', obj.gender || '');

  /* PATCH_BOUNDARY: REG2_REFERREDBY_APPEND_BEGIN */
  set('ReferredBy', obj.referredBy || '');
  /* PATCH_BOUNDARY: REG2_REFERREDBY_APPEND_END */

  return row;
}

/******** QR helpers ********/
function regQrUrl_(text, sizePx){
  const s = Math.max(220, Math.min(900, Number(sizePx || 360)));
  return REG_QR_BASE +
    '?text=' + encodeURIComponent(String(text||'')) +
    '&size=' + encodeURIComponent(String(s)) +
    '&ecLevel=M&margin=2&format=png';
}

function regFetchQrPngBlob_(text, sizePx, filename){
  const url = regQrUrl_(text, sizePx);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions:true, followRedirects:true });
  const code = resp.getResponseCode();
  if (code !== 200){
    const snippet = String(resp.getContentText() || '').slice(0, 400);
    throw new Error('QR_FETCH_HTTP_' + code + ': ' + snippet);
  }
  return resp.getBlob().setName(filename).setContentType(MimeType.PNG);
}

/******** Email send ********/
function regSendFamilyRegistrationEmail_(p){
  const out = { sentToNew:false, sentToOld:false, toNewMasked:'', toOldMasked:'', reason:'' };
  const toEmail = String((p && p.toEmail) || '').trim();
  const members = Array.isArray(p && p.members) ? p.members.slice(0, 4) : [];
  out.toNewMasked = toEmail ? regMaskEmail_(toEmail) : '';
  if (!toEmail){ out.reason = 'NO_EMAIL'; return out; }
  if (!members.length){ out.reason = 'NO_MEMBERS'; return out; }
  if (MailApp.getRemainingDailyQuota() <= 0){ out.reason = 'QUOTA'; return out; }

  const attachments = [];
  members.forEach(function(member, index){
    const letter = String(member.memberLetter || String.fromCharCode(65 + index)).trim().toUpperCase();
    const id = String(member.memberId || '').trim().toUpperCase();
    try{
      attachments.push(regFetchQrPngBlob_(member.qrPayload, 420, 'ccf-' + letter + '-' + id + '-qr.png'));
    }catch(e){
      if (!out.reason) out.reason = 'QR_ATTACH_FAIL: ' + String(e && e.message || e);
    }
  });
  try{
    attachments.push(regFetchQrPngBlob_(REG_WA_LINK, 420, 'ccf-whatsapp.png'));
  }catch(e){
    if (!out.reason) out.reason = 'WHATSAPP_QR_ATTACH_FAIL: ' + String(e && e.message || e);
  }

  const familyId = String((p && p.familyId) || '').trim();
  const cards = members.map(function(member, index){
    const letter = String(member.memberLetter || String.fromCharCode(65 + index)).trim().toUpperCase();
    const id = String(member.memberId || '').trim().toUpperCase();
    const name = [member.nameZh, member.nameEn].map(function(v){ return String(v || '').trim(); }).filter(Boolean).join(' / ') || id;
    return '<div style="border:1px solid #d9deea;border-radius:12px;padding:12px;margin:12px 0;">' +
      '<p style="margin:0 0 6px;"><b>' + regHtmlEscape_(letter + ' · ' + name) + '</b></p>' +
      '<p style="margin:0 0 8px;"><b>CCF ID:</b> ' + regHtmlEscape_(id) + '</p>' +
      '<p style="margin:0;"><img alt="CCF QR ' + regHtmlEscape_(id) + '" src="' + regQrUrl_(member.qrPayload, 360) + '" style="max-width:320px;height:auto;" /></p>' +
      '<p style="color:#666;font-size:12px;margin:6px 0 0;">附件 / Attachment: ccf-' + regHtmlEscape_(letter) + '-' + regHtmlEscape_(id) + '-qr.png</p>' +
    '</div>';
  }).join('');
  const textMembers = members.map(function(member, index){
    const letter = String(member.memberLetter || String.fromCharCode(65 + index)).trim().toUpperCase();
    const id = String(member.memberId || '').trim().toUpperCase();
    const name = [member.nameZh, member.nameEn].map(function(v){ return String(v || '').trim(); }).filter(Boolean).join(' / ') || id;
    return letter + ' · ' + name + '\nCCF ID: ' + id + '\nAttachment: ccf-' + letter + '-' + id + '-qr.png';
  }).join('\n\n');

  const html = '<div style="font-family:Arial,sans-serif;line-height:1.55;">' +
    '<p><b>家庭登記已完成 / Family registration complete</b></p>' +
    '<p>以下每位家庭成員都有獨立的 CCF ID 及 QR。請分別保存並在簽到時出示正確的 QR。<br/>' +
      'Each family member has an independent CCF ID and QR. Save them separately and present the correct QR at check-in.</p>' +
    (familyId ? ('<p><b>Family ID:</b> ' + regHtmlEscape_(familyId) + '</p>') : '') +
    cards +
    '<hr/><p><b>加入 CCF WhatsApp 社群 / Join the CCF WhatsApp community</b><br/><a href="' + REG_WA_LINK + '">' + REG_WA_LINK + '</a></p>' +
    '<p><img alt="CCF WhatsApp QR" src="' + regQrUrl_(REG_WA_LINK, 320) + '" style="max-width:320px;height:auto;" /></p>' +
    '<p style="color:#666;font-size:12px;">如 QR 未能顯示，請開啟相應附件。日後每位成員可用自己的 QR 登入並獨立更改電郵；CCF ID、QR、Family ID、出席及事奉記錄不會因此改變。<br/>' +
      'If a QR is not visible, open its labelled attachment. Later, each member can sign in with their own QR and change email independently; their CCF ID, QR, Family ID, attendance and serving history stay unchanged. ' + regHtmlEscape_((p && p.deviceHint) || '') + '</p>' +
  '</div>';
  const textBody = '家庭登記已完成 / Family registration complete\n' +
    (familyId ? ('Family ID: ' + familyId + '\n\n') : '\n') + textMembers +
    '\n\nJoin WhatsApp: ' + REG_WA_LINK +
    '\n\nEach member may later change email independently without changing their CCF ID, QR, Family ID, attendance or serving history.';
  try{
    MailApp.sendEmail({
      to:toEmail,
      subject:'CCF 家庭登記 QR / Family registration QRs',
      body:textBody,
      htmlBody:html,
      attachments:attachments
    });
    out.sentToNew = true;
    if (!out.reason) out.reason = 'SENT';
  }catch(e){
    out.reason = 'SEND_NEW_FAIL: ' + String(e && e.message || e);
  }
  return out;
}

function regSendEmails_(p){
  const out = { sentToNew:false, sentToOld:false, toNewMasked:'', toOldMasked:'', reason:'' };

  const quota = MailApp.getRemainingDailyQuota();
  if (quota <= 0){ out.reason = 'QUOTA'; return out; }

  const toEmail = String(p.toEmail||'').trim();
  const oldEmail = String(p.oldEmail||'').trim();
  const alertEmails = [];
  (Array.isArray(p.alertEmails) ? p.alertEmails : []).concat(oldEmail ? [oldEmail] : []).forEach(function(value){
    const email = String(value||'').trim();
    const norm = regNormEmail_(email);
    if (!norm || alertEmails.some(function(existing){ return regNormEmail_(existing) === norm; })) return;
    alertEmails.push(email);
  });
  out.toNewMasked = toEmail ? regMaskEmail_(toEmail) : '';
  out.toOldMasked = alertEmails.length ? alertEmails.map(regMaskEmail_).join(', ') : '';

  // reasons if not sending
  if (!toEmail){
    if (p.emailOptIn === false) out.reason = 'OPTOUT';
    else if (p.emailProvided === false) out.reason = 'NO_EMAIL';
    else out.reason = 'NOT_REQUESTED';
  }

  const attachments = [];
  if (toEmail){
    try{
      attachments.push(regFetchQrPngBlob_(p.payload, 420, 'ccf-qr.png'));
      if (p.includeWhatsApp){
        attachments.push(regFetchQrPngBlob_(REG_WA_LINK, 420, 'ccf-whatsapp.png'));
      }
    }catch(e){
      out.reason = 'QR_ATTACH_FAIL: ' + String(e && e.message || e);
    }
  }

  const subjectNew = (p.kind === 'UPDATE') ? 'CCF 資料更新 QR / Updated QR' : 'CCF 會員登記 QR / Registration QR';
  const subjectOld = 'CCF 資料變更警示 / Account change alert';

  const greetZh = String(p.greetZh||'').trim() || '你好';
  const greetEn = String(p.greetEn||'').trim() || 'there';

  const changedLine = (p.kind === 'UPDATE' && p.changedFields && p.changedFields.length)
    ? ('<p><b>已更新 / Updated：</b> ' + p.changedFields.map(regHtmlEscape_).join('、') + '</p>')
    : '';

  const deviceLine =
    '<p style="color:#666;font-size:12px;">' +
      '如未能顯示 QR，請查看附件（ccf-qr.png）。如仍未能看到，請聯絡影音同工，並告知你使用的裝置／電郵程式。<br/>' +
      'If QR is not visible, open the attachment (ccf-qr.png). If still not visible, contact Media Team and tell us which device/app you used. ' +
      regHtmlEscape_(p.deviceHint||'') +
    '</p>';

  const ccfRemoteImg = regQrUrl_(p.payload, 360);

  const waSectionHtml = p.includeWhatsApp
    ? (
      '<hr/>' +
      '<p><b>加入 CCF WhatsApp 社群（如未加入）</b><br/>Join the CCF WhatsApp community (if you have not joined yet)</p>' +
      '<p><a href="' + REG_WA_LINK + '">' + REG_WA_LINK + '</a></p>' +
      '<div style="border:1px solid #ddd;border-radius:12px;padding:10px;background:#fff6e6;">' +
        '<b>⚠️ 注意：</b>以下 QR 是 WhatsApp 連結，<b>不是</b>你的 CCF ID QR。<br/>' +
        '<b>Note:</b> The QR below is the WhatsApp link, <b>NOT</b> your CCF ID QR.' +
      '</div>' +
      '<p>請打開 WhatsApp，用「掃描 QR」功能掃描以下 QR。<br/>Open WhatsApp and scan this QR.</p>' +
      '<p><img alt="CCF WhatsApp QR" src="' + regQrUrl_(REG_WA_LINK, 360) + '" style="max-width:360px;height:auto;" /></p>'
    )
    : '';

  if (toEmail){
    const htmlNew =
      '<div style="font-family:Arial,sans-serif;line-height:1.55;">' +
        '<p><b>' + regHtmlEscape_(greetZh) + '，歡迎你來到 CCF 😊</b></p>' +
        '<p>盼望你今天聚會有得著，也期待下次再見。</p>' +
        '<p><b>Hi ' + regHtmlEscape_(greetEn) + ', welcome to CCF 😊</b><br/>We hope you’re blessed today, and we’d love to see you again.</p>' +
        '<p><b>以下是你的 CCF 會員 QR（只作登記，不會自動簽到）。</b><br/>This is your CCF member QR (registration only; no auto check-in).</p>' +
        '<p>請交給接待同工掃描 QR。<br/>Please show it to Welcome team to scan.</p>' +
        '<p><b>CCF ID:</b> ' + regHtmlEscape_(p.memberId) + '</p>' +
        changedLine +
        '<p><img alt="CCF QR" src="' + ccfRemoteImg + '" style="max-width:360px;height:auto;" /></p>' +
        '<p style="color:#666;font-size:12px;">如未能看到 QR，請查看附件 <b>ccf-qr.png</b>。</p>' +
        waSectionHtml +
        deviceLine +
      '</div>';

    const txtNew =
`${greetZh}，歡迎你來到 CCF 😊
Hi ${greetEn}, welcome to CCF 😊

This is your CCF member QR (registration only; no auto check-in).
Please show it to Welcome team to scan.

CCF ID: ${p.memberId}

If QR is not visible, open attachment "ccf-qr.png".
${p.includeWhatsApp ? ('Join WhatsApp (if not already): ' + REG_WA_LINK) : ''}`;

    try{
      MailApp.sendEmail({ to: toEmail, subject: subjectNew, body: txtNew, htmlBody: htmlNew, attachments: attachments });
      out.sentToNew = true;
      if (!out.reason || out.reason === 'SENT') out.reason = 'SENT';
    }catch(e){
      out.reason = out.reason || ('SEND_NEW_FAIL: ' + String(e && e.message || e));
    }
  }

  if (alertEmails.length){
    const staffExtraHtml = p.isStaff
      ? '<p style="color:#b00;"><b>STAFF notice:</b> If you are CCF staff and did not request this, contact Media Team immediately.</p>'
      : '';

    const htmlOld =
      '<div style="font-family:Arial,sans-serif;line-height:1.45;">' +
        '<p><b>Security alert / 安全提示</b></p>' +
        '<p>Your CCF profile details were updated. If you did not request this change, please contact CCF Media Team / staff ASAP.</p>' +
        '<p>你的 CCF 資料已被更新。如非你本人操作，請盡快聯絡影音同工／同工。</p>' +
        staffExtraHtml +
        '<p style="color:#666;font-size:12px;">(For security, no personal details or QR are included.)</p>' +
      '</div>';

    const txtOld =
`SECURITY ALERT
Your CCF profile details were updated.
If you did not request this change, please contact Media Team ASAP.

(For security, no personal details or QR are included.)`;

    alertEmails.forEach(function(alertEmail){
      try{
        MailApp.sendEmail({ to: alertEmail, subject: subjectOld, body: txtOld, htmlBody: htmlOld });
        out.sentToOld = true;
      }catch(e){
        out.reason = out.reason || ('SEND_OLD_FAIL: ' + String(e && e.message || e));
      }
    });
  }

  return out;
}

/******** Utilities / wrappers ********/
function regParseYmdUtc_(ymd){
  const s = String(ymd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10)));
  return isNaN(d.getTime()) ? null : d;
}
function regFmtYmdUtc_(d){
  if (!(d instanceof Date)) return '';
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
function regIsSundayServiceKey_(ev){
  return /^SundayService_\d{4}-\d{2}-\d{2}$/.test(String(ev||'').trim());
}
function regEventDateFromKeyUtc_(ev){
  const s = String(ev||'').trim();
  const m = s.match(/^SundayService_(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10)));
  return isNaN(d.getTime()) ? null : d;
}
function regNow_(){
  try{ return (typeof nowUk_ === 'function') ? nowUk_() : new Date(); }catch(e){ return new Date(); }
}

function regHtmlEscape_(s){
  s = String(s || '');
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}


function regConflict_(zh, en, detail, subCode, subGroup){
  const out = { ok:false, code:'E409', zh:String(zh||''), en:String(en||'') };
  if (detail) out.detail = String(detail);
  if (subCode) out.subCode = String(subCode);
  if (subGroup) out.subGroup = String(subGroup);
  return out;
}

function regErr_(code, zh, en, e){
  const msg = String((e && (e.stack || e.message)) || e || '');
  return { ok:false, code: code || 'E500', zh: zh || '系統錯誤', en: en || 'System error', detail: msg };
}

function regDeviceHint_(inObj){
  const ua = String(inObj && inObj.ua || '').trim();
  const dev = String(inObj && inObj.deviceId || '').trim();
  if (!ua && !dev) return '';
  return '(DeviceId: ' + dev + ') (UA: ' + ua + ')';
}

function regStatus_(s){ return String(s||'').trim().toUpperCase(); }
function regNormName_(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,''); }
function regEnTokens_(s){ return String(s||'').trim().toLowerCase().split(/\s+/).filter(Boolean).map(t => t.replace(/[^a-z0-9]/g,'')); }
function regNormEmail_(s){ return String(s||'').trim().toLowerCase(); }
function regNormMobile_(s){ return String(s||'').trim(); }

function regMobilesMatch_(a, b){
  const da = String(a||'').replace(/\D/g,'');
  const db = String(b||'').replace(/\D/g,'');
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length < 7 || db.length < 7) return false;
  return da.endsWith(db) || db.endsWith(da);
}

/* ============================================================
 * PATCH_BOUNDARY: REG1_CACHE_CLEAR_BEGIN
 * Clear both Staff Portal and legacy members index caches.
 * ============================================================ */
function regClearMembersIndexCache_(){
  try{
    const c = CacheService.getScriptCache();
    c.remove('membersIndex_staff_v1');
    c.remove('membersIndex_v6');
  }catch(e){}
}
/* ============================================================
 * PATCH_BOUNDARY: REG1_CACHE_CLEAR_END
 * ============================================================ */

function regParseQr_(raw){
  // Use existing strict parser if present, otherwise minimal local parser
  if (typeof parseQrPayloadStrict_ === 'function') return parseQrPayloadStrict_(raw);

  const s = String(raw||'').trim();
  const parts = s.split('|');
  if (parts.length !== 2) return { ok:false, code:'E416', zh:'QR 格式錯誤', en:'Invalid QR format.' };
  const id = String(parts[0]||'').trim().toUpperCase();
  const key = String(parts[1]||'').trim();
  if (!/^CCF\d{4}$/.test(id)) return { ok:false, code:'E416', zh:'QR 格式錯誤', en:'Invalid QR format.' };
  if (!/^k.+/.test(key)) return { ok:false, code:'E416', zh:'QR 格式錯誤', en:'Invalid QR format.' };
  return { ok:true, id, key };
}

function regNormalizeVrm_(s){
  if (typeof normalizeVrm_ === 'function') return normalizeVrm_(s);
  return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
}

function regIsOptedOut_(optOutRaw){
  if (typeof isOptedOut_ === 'function') return isOptedOut_(optOutRaw);
  const v = String(optOutRaw || '').trim().toUpperCase();
  if (!v) return false;
  if (v === '0' || v === 'N' || v === 'NO' || v === 'FALSE') return false;
  return ['1','Y','YES','TRUE','OPTOUT'].includes(v);
}

/******** Logging (canonical; duplicates removed) ********/
/* PATCH_BOUNDARY: REG1_LOGGING_CANONICAL_BEGIN */
function regEnsureRegActivity_(){
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(REG_ACTIVITY_SHEET);
  if (!sh){
    sh = ss.insertSheet(REG_ACTIVITY_SHEET);
    sh.appendRow(['Timestamp','Action','TargetId','ResultCode','Details','DeviceId','UserAgent']);
    sh.getRange(1,1,1,7).setFontWeight('bold');
  }
  return sh;
}

function regLogActivity_(action, targetId, resultCode, detailsObj){
  const sh = regEnsureRegActivity_();
  const ts = regNow_();
  const details = detailsObj ? JSON.stringify(detailsObj) : '';
  sh.appendRow([
    ts,
    String(action||''),
    String(targetId||''),
    String(resultCode||''),
    details,
    String((detailsObj&&detailsObj.deviceId)||''),
    String((detailsObj&&detailsObj.ua)||'')
  ]);
}

function regLogBlock_(res, targetId, deviceId, ua, stage){
  const code = (res && res.code) ? res.code : 'E500';
  regLogActivity_('REG_BLOCK_' + String(stage||'UNKNOWN'), targetId || '', code, {
    zh: res && res.zh ? res.zh : '',
    en: res && res.en ? res.en : '',
    detail: res && res.detail ? res.detail : '',
    deviceId, ua
  });
}
/* PATCH_BOUNDARY: REG1_LOGGING_CANONICAL_END */

/******** Masking ********/
function regMaskEmail_(email){
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

function regMaskMobile_(mobile){
  const raw = String(mobile||'').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g,'');
  if (digits.length < 7) return raw;
  const head = digits.slice(0,4);
  const tail = digits.slice(-3);
  const stars = '*'.repeat(Math.max(3, digits.length - 7));
  const plus = raw.startsWith('+') ? '+' : '';
  return plus + head + stars + tail;
}

function regMaskVrm_(vrm){
  const v = regNormalizeVrm_(vrm||'');
  if (!v) return '';
  return v.slice(0,4) + ' ***';
}

/* ===== END OF Reg.gs (COMPLETE) ===== */
