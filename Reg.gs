/***************************************
 * CCF Registration Portal (public, no sign-in)
 * File: Reg.gs
 * v2026-02-09.reg3
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

const REG_VERSION = '2026-02-15.reg95';
const REG_TEMPLATE = 'Reg2';

const REG_MIN_ID_NUM = 101;   // CCF0101
const REG_MAX_ID_NUM = 9999;  // CCF9999

const REG_WA_LINK = 'https://chat.whatsapp.com/G08XRgAsM520nexCGHW9q4';
const REG_QR_BASE = 'https://quickchart.io/qr';

const REG_EXTRA_HEADERS = [
  'Member_Since','PreferredName','HasCar','VRM','VRM2','IsMinor','ParentEmail',
  /* PATCH_BOUNDARY: REG2_REFERREDBY_HEADER_BEGIN */
  'ReferredBy'
  /* PATCH_BOUNDARY: REG2_REFERREDBY_HEADER_END */
];

const REG_ACTIVITY_SHEET = 'Reg_Activity';

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

function api_reg_ping_public(){ return { ok:true, regVersion: REG_VERSION }; }


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
        status: 'ACTIVE',
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
      return { ok:false, code:'E422', zh:'會員入會日期格式錯誤，請聯絡影音同工', en:'Invalid member since date format. Please contact Media team.' };
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

function regDisplayNameForPortal_(m){
  const pref = String((m && m.preferredName) || '').trim();
  const en = String((m && m.nameEn) || '').trim();
  const zh = String((m && m.nameZh) || '').trim();
  if (pref) return pref;
  if (en) return en;
  if (zh) return zh;
  return '(' + String((m && m.id) || '').trim().toUpperCase() + ')';
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

function reg_buildServingTokensForWrite_(raw, maxSlots){
  const list = (typeof admin_splitServingValues_ === 'function')
    ? admin_splitServingValues_(raw)
    : String(raw||'').split(',').map(v => String(v||'').trim()).filter(Boolean);
  const out = [];
  for (let i=0;i<Number(maxSlots||0);i++){
    out.push(String(list[i]||'').trim() || 'N/A');
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
    if (!member) return { ok:false, code:'E412', zh:'找不到此 ID', en:'Member not found.' };

    const att = api_reg_self_attendance_public(qrPayload, null, null);
    if (!att || !att.ok) return att;

    const servingInsights = admin_getServingInsightsForMember_(id) || { byGroup:{} };
    const groups = Array.from(new Set(((member.servingGroups||[]).concat(member.servingGLGroups||[])).filter(Boolean)));

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

    return {
      ok:true,
      member:{
        id: id,
        nameZh: member.nameZh || '',
        nameEn: member.nameEn || '',
        preferredName: member.preferredName || '',
        displayName: regDisplayNameForPortal_(member),
        servingGroups: groups,
        away:{ from1: away.fromYmd || '', to1: away.toYmd || '', from2: away.from2Ymd || '', to2: away.to2Ymd || '' },
        memberSinceEarliest: regSelfMemberSinceEarliestYmd_(id, member.memberSinceRaw)
      },
      attendance: att.stats,
      attendanceEvents: att.attendance,
      memberSinceEarliest: regSelfMemberSinceEarliestYmd_(id, member.memberSinceRaw),
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
    const selfGroups = selfMember ? (selfMember.servingGroups || []).map(function(g){ return admin_normalizeServingGroup_(g); }).filter(Boolean) : [];
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

function api_reg_self_serving_data_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;
    const id = auth.parsed.id;
    const mIndex = admin_getMembersIndex_();
    const member = (mIndex && mIndex.byId) ? mIndex.byId[id] : null;
    if (!member) return { ok:false, code:'E412', zh:'找不到此會員', en:'Member not found.' };

    const groups = Array.from(new Set(((member.servingGroups||[]).concat(member.servingGLGroups||[])).filter(Boolean)));
    const groupNorm = groups.map(function(g){ return admin_normalizeServingGroup_(g); }).filter(Boolean);
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
        const raw = (((matrix.cells||{})[ev.eventKey]||{})[p.position]||{}).value || '';
        const max = ADMIN_SERVING_POSITION_MAX[p.position] || 1;
        const tokens = reg_buildServingTokensForWrite_(raw, max);
        const slots = tokens.map(function(t){
          const v = String(t||'').trim().toUpperCase();
          return admin_isServingNaValue_(v) ? 'N/A' : v;
        });
        const canChange = regSelfServingEditable_(admin_eventDateFromKey_(ev.eventKey));
        cells[ev.eventKey][p.position] = { slots: slots, canSignup: true, canChange: canChange };
      });
    });

    return { ok:true, member:{ id:id, servingGroups:groups }, summary:summary, events:matrix.events||[], positions:filteredPositions, cells:cells, memberLabelsById:memberLabelsById, maxMonths:ADMIN_SERVING_MONTHS_AHEAD };
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
    if (!admin_memberHasServingGroup_(member, ADMIN_SERVING_POSITION_GROUP[pos] || '')) return { ok:false, code:'E409', zh:'你不屬於此事奉組別', en:'You are not in this serving group.' };

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

      // duplicate guard: same member cannot hold >1 position for same event
      let existingPosition = '';
      ADMIN_SERVING_POSITIONS.forEach(function(p){
        const ci = headerMap[p];
        if (!ci || existingPosition) return;
        const idsAtPos = admin_extractMemberIdsFromServingValue_(String(sh.getRange(rowIndex, ci).getValue() || ''));
        if (idsAtPos.indexOf(id) >= 0) existingPosition = p;
      });
      if (existingPosition && existingPosition !== pos){
        return {
          ok:false,
          code:'E409',
          zh:'同一活動不可同時擔任多個崗位',
          en:'Duplicate serving assignments for the same event are not allowed.',
          detail: existingPosition + ' -> ' + pos
        };
      }

      const raw = String(sh.getRange(rowIndex, colIndex).getValue() || '').trim();
      const ids = admin_extractMemberIdsFromServingValue_(raw);
      const max = ADMIN_SERVING_POSITION_MAX[pos] || 1;
      const idx = Math.max(0, Number(slotIndex||0));
      if (idx >= max) return { ok:false, code:'E416', zh:'空缺序號錯誤', en:'Invalid slot index.' };
      if (ids.indexOf(id) >= 0) return { ok:true, eventKey:ev, position:pos };
      const tokens = reg_buildServingTokensForWrite_(raw, max);
      const currentAtSlot = String(tokens[idx]||'').trim();
      if (currentAtSlot && !admin_isServingNaValue_(currentAtSlot) && /^CCF\d{4}$/i.test(currentAtSlot)){
        return { ok:false, code:'E409', zh:'此空缺已被佔用', en:'This slot is already occupied.' };
      }
      const hasFree = tokens.some(function(t){ return admin_isServingNaValue_(t); });
      if (!hasFree) return { ok:false, code:'E409', zh:'此崗位已滿額', en:'This position is full.' };

      tokens[idx] = id;
      sh.getRange(rowIndex, colIndex).setValue(tokens.join(', '));
      regLogActivity_('REG_SELF_SERVING_SIGNUP', id, 'OK', { eventKey:ev, position:pos, afterCutoff: afterChangeCutoff });
      return {
        ok:true,
        eventKey:ev,
        position:pos,
        warning: afterChangeCutoff
          ? {
              code:'W_CUTOFF',
              zh:'已超過六週更改期限。如需更改或取消，請聯絡組長。',
              en:'The 6-week change/cancel cutoff has passed. Please contact your GL for changes or cancellations.'
            }
          : null
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
    if (!regSelfServingEditable_(admin_eventDateFromKey_(ev))) return { ok:false, code:'E409', zh:'六週內不可更改，請聯絡組長', en:'Changes within 6 weeks are blocked. Please contact GL.' };

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
      sh.getRange(rowIndex, colIndex).setValue(next.join(', '));
      regLogActivity_('REG_SELF_SERVING_REMOVE', id, 'OK', { eventKey:ev, position:pos });
      return { ok:true, eventKey:ev, position:pos };
    } finally {
      lock.releaseLock();
    }
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
}

function api_reg_self_live_service_public(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth.ok) return auth;

    const todayYmd = admin_todayUkYmd_();
    const today = admin_parseYmd_(todayYmd) || new Date();
    const todayDow = today.getUTCDay();
    const offsetToPrevSunday = (todayDow === 0) ? 7 : todayDow;
    const prevSunday = new Date(today.getTime() - offsetToPrevSunday*24*60*60*1000);
    const prevYmd = admin_fmtYmd_(prevSunday);

    const events = admin_getUpcomingSundayEventKeys_(todayYmd, 1);
    const next = (events && events.length) ? events[0].eventKey : '';
    const last = prevYmd ? ('SundayService_' + prevYmd) : '';

    const check = admin_getCheckinsData_();
    const countByEvent = {};
    if (check && check.ok){
      check.rows.forEach(function(r){
        if (!admin_isSundayServiceKey_(r.eventKey)) return;
        if (!countByEvent[r.eventKey]) countByEvent[r.eventKey] = new Set();
        countByEvent[r.eventKey].add(r.memberId);
      });
    }

    const mi = admin_getMembersIndex_() || {};
    const byId = mi.byId || {};
    const servingRaw = next ? admin_getServingForEvent_(next, byId, null, false) : [];
    const serving = servingRaw.map(function(r){
      const m = byId[String(r.memberId||'').trim().toUpperCase()] || {};
      const genderRaw = String(m.gender || m.Gender || '').trim().toUpperCase();
      const suffix = (genderRaw === 'M' || genderRaw === 'MALE' || genderRaw === '男') ? '弟兄 / Brother'
        : ((genderRaw === 'F' || genderRaw === 'FEMALE' || genderRaw === '女') ? '姊妹 / Sister' : '');
      const zhEnName = [String(r.nameZh||'').trim(), String(r.nameEn||'').trim()].filter(Boolean).join(' / ');
      return {
        eventKey: r.eventKey,
        group: admin_normalizeServingGroup_(r.group || ''),
        groupZh: getServingGroupLabelZh_(r.group || ''),
        groupEn: getServingGroupLabelEn_(r.group || ''),
        position: r.position,
        positionZh: admin_servingPositionZh_(r.position || ''),
        positionEn: admin_servingPositionLabel_(r.position || ''),
        displayName: zhEnName + (suffix ? (' · ' + suffix) : '')
      };
    });

    return {
      ok:true,
      currentAttendance:{ eventKey:next, count: next && countByEvent[next] ? countByEvent[next].size : 0 },
      lastAttendance:{ eventKey:last, count: last && countByEvent[last] ? countByEvent[last].size : 0 },
      servingThisWeek: serving
    };
  }catch(e){
    return regErr_('E500','系統錯誤（E500）。','System error (E500).', e);
  }
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
        if (aFrom.getTime() <= bTo.getTime() && bFrom.getTime() <= aTo.getTime()) return { ok:false, code:'E409', zh:'兩段假期不可重疊', en:'Holiday periods cannot overlap.' };
      }
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
  const emailChanged = !!(regNormEmail_(oldEmail) && regNormEmail_(newEmail) && regNormEmail_(oldEmail) !== regNormEmail_(newEmail));

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

  /* PATCH_BOUNDARY: REG2_REFERREDBY_WRITE_BEGIN */
  regWriteCell_(ms, rowNumber, 'ReferredBy', data.referredBy || '');
  /* PATCH_BOUNDARY: REG2_REFERREDBY_WRITE_END */

  /* PATCH_BOUNDARY: REG2_PRESERVE_ADMIN_STATUS_BEGIN */
  const stOldNorm = String(stOld||'').toUpperCase();
  const newStatusToWrite = (stOldNorm === 'ADMIN') ? 'ADMIN' : (isStaff ? 'STAFF' : 'ACTIVE');
  regWriteCell_(ms, rowNumber, 'Status', newStatusToWrite);
  /* PATCH_BOUNDARY: REG2_PRESERVE_ADMIN_STATUS_END */

  regClearMembersIndexCache_();

  const payload = memberId + '|' + keyToUse;

  const includeWhatsApp = (!isStaff && String(stOld||'').toUpperCase() === 'PROVISIONAL');

  const toEmail = isStaff ? (newEmail || oldEmail || '') : (data.optInEmail ? newEmail : '');
  const oldAlertEmail = emailChanged ? oldEmail : '';

  const g = regPickGreetings_(data.nameZh, data.nameEn, data.preferredName);
  const emailMeta = { optInEmail: !!data.optInEmail, emailProvided: !!data.email };

  const emailRes = regSendEmails_({
    kind: 'UPDATE',
    toEmail,
    oldEmail: oldAlertEmail,
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
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
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
    if (cntE >= 4) return { ok:false, code:'E452', zh:'此電郵已登記多於 4 次，請改用另一個電郵或聯絡影音同工處理。', en:'This email address is already registered more than 4 times.' };
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
    /* PATCH_BOUNDARY: REG2_REFERREDBY_ROWOBJ_BEGIN */
    ReferredBy: String(g('ReferredBy')||'').trim(),
    /* PATCH_BOUNDARY: REG2_REFERREDBY_ROWOBJ_END */
    Member_Since: g('Member_Since')
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

  set('FamilyID','');
  set('MemberLetter','');
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
function regSendEmails_(p){
  const out = { sentToNew:false, sentToOld:false, toNewMasked:'', toOldMasked:'', reason:'' };

  const quota = MailApp.getRemainingDailyQuota();
  if (quota <= 0){ out.reason = 'QUOTA'; return out; }

  const toEmail = String(p.toEmail||'').trim();
  const oldEmail = String(p.oldEmail||'').trim();
  out.toNewMasked = toEmail ? regMaskEmail_(toEmail) : '';
  out.toOldMasked = oldEmail ? regMaskEmail_(oldEmail) : '';

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

  if (oldEmail){
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

    try{
      MailApp.sendEmail({ to: oldEmail, subject: subjectOld, body: txtOld, htmlBody: htmlOld });
      out.sentToOld = true;
    }catch(e){
      out.reason = out.reason || ('SEND_OLD_FAIL: ' + String(e && e.message || e));
    }
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

function regErr_(code, zh, en, e){
  return { ok:false, code: code || 'E500', zh: zh || '系統錯誤', en: en || 'System error', detail: String(e && e.message || e || '') };
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
  return ['1','Y','YES','TRUE','OPTOUT'].includes(v) || v.length > 0;
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
