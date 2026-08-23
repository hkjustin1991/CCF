/***************************************
 * CCF reusable member polling portal
 * File: Vote.gs
 * v2026-08-23.vote2
 *
 * Ordinary voting exposes only poll content, eligibility, final submission state,
 * receipt, and permitted results. Exceptional ballot investigation remains inside
 * the authorised DEACON/ADMIN/scrutineer workflow and is audit-gated.
 ***************************************/

const VOTE_VERSION = '2026-08-23.vote2';
const VOTE_SESSION_PREFIX = 'vote_sess_';
const VOTE_SESSION_TTL_SECONDS = 30 * 60;
const VOTE_SECRET_PROPERTY = 'CCF_VOTE_TRACE_SECRET';
const VOTE_CURRENT_POLL_PROPERTY = 'CCF_VOTE_CURRENT_POLL_ID';

const VOTE_ELECTIONS_SHEET = 'Vote_Elections';
const VOTE_OPTIONS_SHEET = 'Vote_Options';
const VOTE_ELIGIBILITY_SHEET = 'Vote_Eligibility';
const VOTE_BALLOTS_SHEET = 'Vote_Ballots';
const VOTE_SCRUTINEERS_SHEET = 'Vote_Scrutineers';
const VOTE_AUDIT_SHEET = 'Vote_Audit';

const VOTE_ELECTION_HEADERS = ['ElectionId','TitleZh','TitleEn','OpensAt','ClosesAt','State','OptionDigest','CreatedAt','CreatedBy','UpdatedAt','UpdatedBy'];
const VOTE_OPTION_HEADERS = ['ElectionId','OptionNo','LabelZh','LabelEn','SortOrder','Active'];
const VOTE_ELIGIBILITY_HEADERS = ['ElectionId','MemberId','ChildEligible','ExplicitIneligible','Reason','UpdatedAt','UpdatedBy'];
const VOTE_BALLOT_HEADERS = ['ElectionId','ReceiptId','VoterCode','OptionNo','CastAt','DecisionCode','IntegrityMac'];
const VOTE_SCRUTINEER_HEADERS = ['ElectionId','MemberId','Active','AddedAt','AddedBy','UpdatedAt','UpdatedBy'];
const VOTE_AUDIT_HEADERS = ['Timestamp','ElectionId','ActorId','ActorRole','Action','Target','Reason','Details'];

function doGetVote_(e){
  const t = HtmlService.createTemplateFromFile('Vote');
  t.APP_VERSION = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '';
  t.VOTE_VERSION = VOTE_VERSION;
  const scannerCfg = getExternalScannerConfig_();
  t.EXTERNAL_SCANNER_URL = scannerCfg.url;
  t.EXTERNAL_SCANNER_ORIGIN = scannerCfg.origin;
  t.EXTERNAL_SCANNER_TIMEOUT_MS = scannerCfg.timeoutMs;
  return t.evaluate().setTitle('CCF Member Polls / 會員投票').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGetVoteReview_(e){
  const t = HtmlService.createTemplateFromFile('VoteReview');
  t.APP_VERSION = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '';
  t.VOTE_VERSION = VOTE_VERSION;
  const scannerCfg = getExternalScannerConfig_();
  t.EXTERNAL_SCANNER_URL = scannerCfg.url;
  t.EXTERNAL_SCANNER_ORIGIN = scannerCfg.origin;
  t.EXTERNAL_SCANNER_TIMEOUT_MS = scannerCfg.timeoutMs;
  return t.evaluate().setTitle('CCF Formal Review').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function vote_err_(code, zh, en, detail){
  const out = { ok:false, code:String(code || 'E500'), zh:String(zh || '系統錯誤'), en:String(en || 'System error') };
  if (detail !== undefined && detail !== null && String(detail) !== '') out.detail = String(detail);
  return out;
}

function vote_open_ss_(){
  const id = (typeof SPREADSHEET_ID !== 'undefined') ? SPREADSHEET_ID : '';
  if (!id) throw new Error('Spreadsheet ID is not configured.');
  return SpreadsheetApp.openById(id);
}

function vote_ensure_sheet_(name, headers){
  const ss = vote_open_ss_();
  let sh = ss.getSheetByName(name);
  if (!sh){
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#e8eef8');
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = Math.max(1, sh.getLastColumn());
  const existing = sh.getRange(1,1,1,lastCol).getValues()[0].map(function(v){ return String(v || '').trim(); });
  headers.forEach(function(header){
    if (existing.indexOf(header) >= 0) return;
    const next = sh.getLastColumn() + 1;
    sh.getRange(1,next).setValue(header).setFontWeight('bold').setBackground('#e8eef8');
    existing.push(header);
  });
  sh.setFrozenRows(1);
  return sh;
}

function vote_get_sheet_(name){ return vote_open_ss_().getSheetByName(name); }

function vote_sheet_records_(name){
  const sh = vote_get_sheet_(name);
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 1) return [];
  const values = sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
  const headers = values[0].map(function(v){ return String(v || '').trim(); });
  return values.slice(1).map(function(row, idx){
    const rec = { _rowNumber:idx + 2 };
    headers.forEach(function(h, col){ if (h) rec[h] = row[col]; });
    return rec;
  });
}

function vote_header_map_(sh){
  if (!sh || sh.getLastColumn() < 1) return {};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function(h, idx){ const key = String(h || '').trim(); if (key) map[key] = idx; });
  return map;
}

function vote_iso_(value){
  if (!value && value !== 0) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return isNaN(value.getTime()) ? '' : value.toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function vote_bool_(value){
  if (value === true || value === 1) return true;
  const s = String(value || '').trim().toUpperCase();
  return s === 'YES' || s === 'TRUE' || s === '1' || s === 'Y';
}

function vote_norm_status_(value){ return String(value || '').trim().toUpperCase(); }

function vote_effective_member_status_(value, roleExpires){
  const status = vote_norm_status_(value);
  if (['STAFF','DEACON','ADMIN','HELPER','TEMP'].indexOf(status) < 0 || !roleExpires) return status;
  const expiry = new Date(roleExpires);
  if (!isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) return 'ACTIVE';
  return status;
}

function vote_member_from_reg_auth_(auth){
  const row = (auth && auth.row) || {};
  return {
    id:String((auth && auth.parsed && auth.parsed.id) || row.ID || '').trim().toUpperCase(),
    nameZh:String(row.NameZh || '').trim(),
    nameEn:String(row.NameEn || '').trim(),
    status:vote_effective_member_status_(row.Status, row.RoleExpires),
    isMinor:vote_bool_(row.IsMinor)
  };
}

function vote_get_member_(memberId){
  const id = String(memberId || '').trim().toUpperCase();
  if (!id) return null;
  try{
    const idx = admin_getMembersIndex_();
    const m = idx && idx.byId ? idx.byId[id] : null;
    if (!m) return null;
    return {
      id:id, nameZh:String(m.nameZh || '').trim(), nameEn:String(m.nameEn || '').trim(),
      preferredName:String(m.preferredName || '').trim(), status:vote_effective_member_status_(m.status, m.roleExpires), isMinor:!!m.isMinor
    };
  }catch(e){ return null; }
}

function vote_all_members_(){
  const idx = admin_getMembersIndex_();
  return ((idx && idx.all) || []).map(function(m){
    return {
      id:String(m.id || '').trim().toUpperCase(), nameZh:String(m.nameZh || '').trim(), nameEn:String(m.nameEn || '').trim(),
      preferredName:String(m.preferredName || '').trim(), status:vote_effective_member_status_(m.status, m.roleExpires), isMinor:!!m.isMinor
    };
  }).filter(function(m){ return !!m.id; });
}

function vote_new_session_(member){
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(VOTE_SESSION_PREFIX + token, JSON.stringify({ memberId:member.id, createdAt:Date.now() }), VOTE_SESSION_TTL_SECONDS);
  return token;
}

function vote_require_session_(token){
  const key = VOTE_SESSION_PREFIX + String(token || '').trim();
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return vote_err_('E401','登入已過期，請重新掃描會員 QR。','Session expired. Please scan your member QR again.');
  let parsed;
  try{ parsed = JSON.parse(raw); }catch(e){ return vote_err_('E401','登入已過期，請重新掃描會員 QR。','Session expired. Please scan your member QR again.'); }
  const member = vote_get_member_(parsed.memberId);
  if (!member) return vote_err_('E412','找不到會員資料。','Member record not found.');
  CacheService.getScriptCache().put(key, raw, VOTE_SESSION_TTL_SECONDS);
  return { ok:true, member:member };
}

function vote_require_role_(token, allowed){
  const s = vote_require_session_(token);
  if (!s.ok) return s;
  const role = vote_norm_status_(s.member.status);
  const permitted = allowed.indexOf(role) >= 0 || (role === 'DEACON' && allowed.indexOf('ADMIN') >= 0);
  if (!permitted) return vote_err_('E403','沒有權限執行此操作。','You do not have permission for this action.');
  s.role = role;
  return s;
}

function vote_get_secret_(){
  const value = String(PropertiesService.getScriptProperties().getProperty(VOTE_SECRET_PROPERTY) || '').trim();
  if (!value) throw new Error('Internal ballot audit secret is not initialised.');
  return value;
}

function vote_is_system_initialized_(){
  try{ return !!String(PropertiesService.getScriptProperties().getProperty(VOTE_SECRET_PROPERTY) || '').trim(); }
  catch(e){ return false; }
}

function vote_current_poll_id_(){
  try{ return String(PropertiesService.getScriptProperties().getProperty(VOTE_CURRENT_POLL_PROPERTY) || '').trim(); }
  catch(e){ return ''; }
}

function vote_set_current_poll_id_(pollId){ PropertiesService.getScriptProperties().setProperty(VOTE_CURRENT_POLL_PROPERTY, String(pollId || '').trim()); }
function vote_poll_id_(value){ return String(value || '').trim().toUpperCase(); }
function vote_valid_poll_id_(value){ return /^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(vote_poll_id_(value)); }

function vote_new_poll_id_(){
  const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const suffix = Utilities.getUuid().replace(/-/g,'').slice(0,12).toUpperCase();
  return 'POLL_' + stamp + '_' + suffix;
}

function vote_election_from_record_(r){
  return {
    rowNumber:r._rowNumber, electionId:vote_poll_id_(r.ElectionId), titleZh:String(r.TitleZh || '').trim(), titleEn:String(r.TitleEn || '').trim(),
    opensAt:vote_iso_(r.OpensAt), closesAt:vote_iso_(r.ClosesAt), state:String(r.State || 'DRAFT').trim().toUpperCase(),
    optionDigest:String(r.OptionDigest || '').trim(), createdAt:vote_iso_(r.CreatedAt), createdBy:String(r.CreatedBy || '').trim(),
    updatedAt:vote_iso_(r.UpdatedAt), updatedBy:String(r.UpdatedBy || '').trim()
  };
}

function vote_all_elections_(){
  return vote_sheet_records_(VOTE_ELECTIONS_SHEET).filter(function(r){ return vote_valid_poll_id_(r.ElectionId); }).map(vote_election_from_record_);
}

function vote_get_election_(pollId){
  const id = vote_poll_id_(pollId || vote_current_poll_id_());
  if (!id) return null;
  const rows = vote_all_elections_();
  for (let i=rows.length-1;i>=0;i--){ if (rows[i].electionId === id) return rows[i]; }
  return null;
}

function vote_effective_state_(election, now){
  if (!election) return 'NO_CURRENT_POLL';
  const state = String(election.state || 'DRAFT').trim().toUpperCase();
  if (state === 'CLOSED') return 'CLOSED';
  if (state !== 'OPEN') return 'DRAFT';
  const current = now instanceof Date ? now : new Date();
  const opens = election.opensAt ? new Date(election.opensAt) : null;
  const closes = election.closesAt ? new Date(election.closesAt) : null;
  if (opens && !isNaN(opens.getTime()) && current.getTime() < opens.getTime()) return 'SCHEDULED';
  if (closes && !isNaN(closes.getTime()) && current.getTime() >= closes.getTime()) return 'CLOSED';
  return 'OPEN';
}

function vote_get_options_(pollId){
  const id = vote_poll_id_(pollId);
  if (!id) return [];
  return vote_sheet_records_(VOTE_OPTIONS_SHEET).filter(function(r){ return vote_poll_id_(r.ElectionId) === id && vote_bool_(r.Active); }).map(function(r){
    return { optionNo:String(r.OptionNo || '').trim(), labelZh:String(r.LabelZh || '').trim(), labelEn:String(r.LabelEn || '').trim(), sortOrder:Number(r.SortOrder || 0) };
  }).sort(function(a,b){ return a.sortOrder - b.sortOrder; });
}

function vote_normalize_options_payload_(rawOptions){
  const input = Array.isArray(rawOptions) ? rawOptions : [];
  if (input.length < 2 || input.length > 50) return vote_err_('E422','每個投票需要 2 至 50 個選項。','Each poll requires between 2 and 50 options.');
  const seen = {}, options = [];
  for (let i=0;i<input.length;i++){
    const raw = input[i] || {};
    const optionNo = String(raw.optionNo || (i + 1)).trim();
    const labelZh = String(raw.labelZh || '').trim();
    const labelEn = String(raw.labelEn || '').trim();
    if (!/^[A-Za-z0-9_-]{1,12}$/.test(optionNo)) return vote_err_('E416','選項編號只可使用 1–12 個英文字母、數字、_ 或 -。','Option numbers may use 1–12 letters, numbers, underscores, or hyphens.');
    const key = optionNo.toUpperCase();
    if (seen[key]) return vote_err_('E416','選項編號不可重複：' + optionNo,'Option numbers must be unique: ' + optionNo);
    if (!labelZh && !labelEn) return vote_err_('E422','每個選項至少需要中文或英文名稱。','Each option needs at least a Chinese or English label.');
    if (labelZh.length > 240 || labelEn.length > 240) return vote_err_('E422','選項文字過長。','An option label is too long.');
    seen[key] = true;
    options.push({ optionNo:optionNo, labelZh:labelZh, labelEn:labelEn, sortOrder:i + 1 });
  }
  return { ok:true, options:options };
}

function vote_hmac_(message, secret){
  const key = String(secret || vote_get_secret_());
  const bytes = Utilities.computeHmacSha256Signature(String(message || ''), key, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function vote_options_digest_(pollId, options, secret){
  const canonical = (options || []).map(function(o){ return [String(o.optionNo),String(o.labelZh || ''),String(o.labelEn || ''),Number(o.sortOrder || 0)]; });
  return 'O1.' + vote_hmac_('options|' + vote_poll_id_(pollId) + '|' + JSON.stringify(canonical), secret);
}

function vote_options_integrity_ok_(election, options){
  if (!election || !election.optionDigest || !Array.isArray(options) || options.length < 2) return false;
  try{ return election.optionDigest === vote_options_digest_(election.electionId,options,vote_get_secret_()); }
  catch(e){ return false; }
}

function vote_get_eligibility_flag_(pollId, memberId){
  const poll = vote_poll_id_(pollId), id = String(memberId || '').trim().toUpperCase();
  const rows = vote_sheet_records_(VOTE_ELIGIBILITY_SHEET);
  for (let i=rows.length-1;i>=0;i--){
    if (vote_poll_id_(rows[i].ElectionId) !== poll || String(rows[i].MemberId || '').trim().toUpperCase() !== id) continue;
    return {
      rowNumber:rows[i]._rowNumber, childEligible:vote_bool_(rows[i].ChildEligible), explicitIneligible:vote_bool_(rows[i].ExplicitIneligible),
      reason:String(rows[i].Reason || '').trim(), updatedAt:vote_iso_(rows[i].UpdatedAt), updatedBy:String(rows[i].UpdatedBy || '').trim()
    };
  }
  return { rowNumber:0, childEligible:false, explicitIneligible:false, reason:'', updatedAt:'', updatedBy:'' };
}

function vote_evaluate_eligibility_(member, flag){
  const m = member || {}, f = flag || {}, status = vote_norm_status_(m.status);
  if (!status) return { eligible:false, code:'STATUS_MISSING', zh:'會員狀態未設定', en:'Member status is not set.' };
  if (status === 'DISABLED') return { eligible:false, code:'STATUS_DISABLED', zh:'會員帳戶已停用', en:'Member account is disabled.' };
  if (status === 'PROVISIONAL') return { eligible:false, code:'STATUS_PROVISIONAL', zh:'臨時會員不能投票', en:'Provisional members cannot vote.' };
  if (status === 'PENDING') return { eligible:false, code:'STATUS_PENDING', zh:'待確認會員不能投票', en:'Pending members cannot vote.' };
  if (vote_bool_(f.explicitIneligible)) return { eligible:false, code:'EXPLICITLY_INELIGIBLE', zh:'此投票不合資格', en:'Not eligible for this poll.', reason:String(f.reason || '') };
  if (!!m.isMinor && !vote_bool_(f.childEligible)) return { eligible:false, code:'CHILD_APPROVAL_REQUIRED', zh:'兒童會員須先由同工確認投票資格', en:'A staff member must confirm voting eligibility for this child.' };
  return { eligible:true, code:'ELIGIBLE', zh:'合資格投票', en:'Eligible to vote.' };
}

function vote_is_scrutineer_(pollId, memberId){
  const poll = vote_poll_id_(pollId), id = String(memberId || '').trim().toUpperCase();
  if (!poll || !id) return false;
  return vote_sheet_records_(VOTE_SCRUTINEERS_SHEET).some(function(r){ return vote_poll_id_(r.ElectionId) === poll && String(r.MemberId || '').trim().toUpperCase() === id && vote_bool_(r.Active); });
}

function vote_privileges_(member, pollId){
  const role = vote_norm_status_(member && member.status), isAdmin = role === 'DEACON' || role === 'ADMIN', isStaff = role === 'STAFF' || isAdmin;
  const isScrutineer = vote_is_scrutineer_(pollId,member && member.id);
  return {
    role:role, isStaff:isStaff, isAdmin:isAdmin, isScrutineer:isScrutineer,
    canManageEligibility:isStaff, canManageElection:isAdmin, canViewEarlyResults:isAdmin || isScrutineer, canTrace:isAdmin || isScrutineer
  };
}

function vote_client_privileges_(p){
  p = p || {};
  return {
    role:p.role || '', isStaff:!!p.isStaff, isAdmin:!!p.isAdmin, isScrutineer:!!p.isScrutineer,
    canManageEligibility:!!p.canManageEligibility, canManageElection:!!p.canManageElection, canViewEarlyResults:!!p.canViewEarlyResults
  };
}

function vote_client_election_(election){
  if (!election) return null;
  return {
    electionId:election.electionId, titleZh:election.titleZh, titleEn:election.titleEn,
    opensAt:election.opensAt, closesAt:election.closesAt, state:election.state
  };
}

function vote_public_config_payload_(){
  const election = vote_get_election_();
  const options = election ? vote_get_options_(election.electionId) : [];
  const integrityOk = election ? vote_options_integrity_ok_(election,options) : true;
  return {
    systemInitialized:vote_is_system_initialized_(), election:vote_client_election_(election),
    effectiveState:election ? (integrityOk ? vote_effective_state_(election,new Date()) : 'UNAVAILABLE') : 'NO_CURRENT_POLL',
    options:integrityOk ? options : [], optionsIntegrityOk:integrityOk, voteVersion:VOTE_VERSION
  };
}

function api_vote_public_config(){
  try{ return Object.assign({ ok:true },vote_public_config_payload_()); }
  catch(e){ return vote_err_('E500','未能讀取投票設定。','Could not load the poll configuration.',e && e.message); }
}

function api_vote_login(qrPayload){
  try{
    const auth = regGetSelfMemberByQr_(qrPayload);
    if (!auth || !auth.ok) return auth || vote_err_('E401','QR 驗證失敗。','QR verification failed.');
    const member = vote_member_from_reg_auth_(auth), token = vote_new_session_(member);
    return Object.assign({ ok:true, token:token },vote_dashboard_for_member_(member));
  }catch(e){ return vote_err_('E500','登入失敗。','Login failed.',e && e.message); }
}

function vote_dashboard_for_member_(member){
  const cfg = vote_public_config_payload_(), pollId = cfg.election ? cfg.election.electionId : '';
  const flag = pollId ? vote_get_eligibility_flag_(pollId,member.id) : { childEligible:false, explicitIneligible:false, reason:'' };
  const privileges = vote_privileges_(member,pollId);
  return Object.assign(cfg,{
    member:{ id:member.id, nameZh:member.nameZh, nameEn:member.nameEn, preferredName:member.preferredName || '', status:member.status, isMinor:!!member.isMinor },
    eligibility:vote_evaluate_eligibility_(member,flag), eligibilityFlags:flag,
    ballotStatus:pollId ? vote_existing_ballot_for_member_(pollId,member.id) : { hasVoted:false },
    privileges:vote_client_privileges_(privileges), setupRequired:!cfg.systemInitialized, hasCurrentPoll:!!cfg.election
  });
}

function api_vote_dashboard(token){
  try{
    const s = vote_require_session_(token);
    if (!s.ok) return s;
    return Object.assign({ ok:true },vote_dashboard_for_member_(s.member));
  }catch(e){ return vote_err_('E500','未能更新投票頁面。','Could not refresh the polling page.',e && e.message); }
}

function vote_voter_code_(pollId, memberId, secret){ return 'V1.' + vote_hmac_('voter|' + vote_poll_id_(pollId) + '|' + String(memberId).toUpperCase(),secret); }
function vote_decision_code_(pollId, memberId, optionNo, receiptId, secret){ return 'D1.' + vote_hmac_('decision|' + vote_poll_id_(pollId) + '|' + String(memberId).toUpperCase() + '|' + String(optionNo) + '|' + String(receiptId),secret); }

function vote_integrity_mac_(ballot, secret){
  return 'I1.' + vote_hmac_(['ballot',String(ballot.electionId || ''),String(ballot.receiptId || ''),String(ballot.voterCode || ''),String(ballot.optionNo || ''),String(ballot.castAt || ''),String(ballot.decisionCode || '')].join('|'),secret);
}

function vote_ballots_(pollId){
  const poll = vote_poll_id_(pollId);
  return vote_sheet_records_(VOTE_BALLOTS_SHEET).filter(function(r){ return !poll || vote_poll_id_(r.ElectionId) === poll; }).map(function(r){
    return {
      rowNumber:r._rowNumber, electionId:vote_poll_id_(r.ElectionId), receiptId:String(r.ReceiptId || '').trim(), voterCode:String(r.VoterCode || '').trim(),
      optionNo:String(r.OptionNo || '').trim(), castAt:vote_iso_(r.CastAt), decisionCode:String(r.DecisionCode || '').trim(), integrityMac:String(r.IntegrityMac || '').trim()
    };
  });
}

function vote_ballot_count_(pollId){ return vote_ballots_(pollId).length; }
function vote_valid_ballot_(ballot, secret){ return String(ballot.integrityMac || '') === vote_integrity_mac_(ballot,secret); }

function vote_existing_ballot_for_member_(pollId, memberId){
  try{
    const secret = vote_get_secret_(), voterCode = vote_voter_code_(pollId,memberId,secret);
    const ballot = vote_ballots_(pollId).filter(function(b){ return b.voterCode === voterCode; })[0];
    return ballot ? { hasVoted:true, receiptId:ballot.receiptId, castAt:ballot.castAt } : { hasVoted:false };
  }catch(e){ return { hasVoted:false }; }
}

function vote_prior_cast_audit_(pollId, voterCode){
  const poll = vote_poll_id_(pollId), rows = vote_sheet_records_(VOTE_AUDIT_SHEET);
  for (let i=rows.length-1;i>=0;i--){
    if (vote_poll_id_(rows[i].ElectionId) !== poll || String(rows[i].Action || '').trim() !== 'BALLOT_CAST' || String(rows[i].ActorId || '').trim() !== String(voterCode || '')) continue;
    return { receiptId:String(rows[i].Target || '').trim(), timestamp:vote_iso_(rows[i].Timestamp) };
  }
  return null;
}

function vote_audit_(actor, pollId, action, target, reason, details){
  try{
    const sh = vote_ensure_sheet_(VOTE_AUDIT_SHEET,VOTE_AUDIT_HEADERS);
    sh.appendRow([new Date(),vote_poll_id_(pollId),String((actor && actor.id) || ''),String((actor && actor.role) || ''),String(action || ''),String(target || ''),String(reason || ''),String(details || '')]);
    return true;
  }catch(e){ return false; }
}

function api_vote_admin_initialize(token){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    vote_ensure_sheet_(VOTE_ELECTIONS_SHEET,VOTE_ELECTION_HEADERS);
    vote_ensure_sheet_(VOTE_OPTIONS_SHEET,VOTE_OPTION_HEADERS);
    vote_ensure_sheet_(VOTE_ELIGIBILITY_SHEET,VOTE_ELIGIBILITY_HEADERS);
    vote_ensure_sheet_(VOTE_BALLOTS_SHEET,VOTE_BALLOT_HEADERS);
    vote_ensure_sheet_(VOTE_SCRUTINEERS_SHEET,VOTE_SCRUTINEER_HEADERS);
    vote_ensure_sheet_(VOTE_AUDIT_SHEET,VOTE_AUDIT_HEADERS);
    const props = PropertiesService.getScriptProperties();
    if (!String(props.getProperty(VOTE_SECRET_PROPERTY) || '').trim()){
      if (vote_ballot_count_('') > 0){
        vote_audit_({ id:s.member.id, role:s.role },'','SECRET_MISSING_BLOCK','','','Refused replacement secret because ballots exist.');
        return vote_err_('E_VOTE_SECRET_MISSING','內部核查密匙遺失；已有選票時系統不會自動重設。請由系統負責人恢復原密匙。','The internal audit secret is missing and will not be regenerated while ballots exist.');
      }
      props.setProperty(VOTE_SECRET_PROPERTY,[Utilities.getUuid(),Utilities.getUuid(),Utilities.getUuid(),Utilities.getUuid()].join(''));
    }
    vote_audit_({ id:s.member.id, role:s.role },'','POLL_SYSTEM_INITIALISE','','','Reusable polling system initialised.');
    return Object.assign({ ok:true },vote_dashboard_for_member_(s.member));
  }catch(e){ return vote_err_('E500','未能初始化投票系統。','Could not initialise the polling system.',e && e.message); }
}

function vote_validate_poll_content_(payload){
  const p = payload || {}, titleZh = String(p.titleZh || '').trim(), titleEn = String(p.titleEn || '').trim();
  if (!titleZh && !titleEn) return vote_err_('E422','請填寫投票標題。','Please enter a poll title.');
  if (titleZh.length > 160 || titleEn.length > 160) return vote_err_('E422','投票標題過長。','The poll title is too long.');
  const checked = vote_normalize_options_payload_(p.options);
  return checked.ok ? { ok:true, titleZh:titleZh, titleEn:titleEn, options:checked.options } : checked;
}

function vote_write_election_field_(sh, rowNumber, col, field, value){
  if (col[field] === undefined) throw new Error('Missing Vote_Elections column: ' + field);
  sh.getRange(rowNumber,col[field] + 1).setValue(value);
}

function api_vote_admin_create_poll(token, payload){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    if (!vote_is_system_initialized_()) return vote_err_('E_VOTE_SETUP','請先初始化投票系統。','Please initialise the polling system first.');
    const content = vote_validate_poll_content_(payload);
    if (!content.ok) return content;
    const pollId = vote_new_poll_id_(), secret = vote_get_secret_(), lock = LockService.getScriptLock();
    lock.waitLock(30000);
    let madeCurrent = false;
    try{
      const optionsSheet = vote_get_sheet_(VOTE_OPTIONS_SHEET);
      content.options.forEach(function(o){ optionsSheet.appendRow([pollId,o.optionNo,o.labelZh,o.labelEn,o.sortOrder,'YES']); });
      const digest = vote_options_digest_(pollId,content.options,secret);
      vote_get_sheet_(VOTE_ELECTIONS_SHEET).appendRow([pollId,content.titleZh,content.titleEn,'','','DRAFT',digest,new Date(),s.member.id,new Date(),s.member.id]);
      const current = vote_get_election_(), currentState = vote_effective_state_(current,new Date());
      if (!current || (currentState !== 'OPEN' && currentState !== 'SCHEDULED')){ vote_set_current_poll_id_(pollId); madeCurrent = true; }
    }finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },pollId,'POLL_CREATE',pollId,'',JSON.stringify({ optionCount:content.options.length, madeCurrent:madeCurrent }));
    return {
      ok:true, poll:vote_get_election_(pollId), options:vote_get_options_(pollId), madeCurrent:madeCurrent,
      warning:madeCurrent ? null : { code:'CURRENT_POLL_ACTIVE', zh:'新投票已儲存為草稿；現有投票仍在進行，因此未切換會員頁面。', en:'The new poll was saved as a draft. The member page was not switched because the current poll is active.' }
    };
  }catch(e){ return vote_err_('E500','未能建立投票。','Could not create the poll.',e && e.message); }
}

function vote_poll_list_payload_(){
  const currentId = vote_current_poll_id_();
  return vote_all_elections_().map(function(e){
    return {
      electionId:e.electionId, titleZh:e.titleZh, titleEn:e.titleEn, state:e.state, effectiveState:vote_effective_state_(e,new Date()),
      opensAt:e.opensAt, closesAt:e.closesAt, createdAt:e.createdAt, ballotCount:vote_ballot_count_(e.electionId),
      optionCount:vote_get_options_(e.electionId).length, isCurrent:e.electionId === currentId
    };
  }).sort(function(a,b){ return String(b.createdAt || b.electionId).localeCompare(String(a.createdAt || a.electionId)); });
}

function api_vote_admin_polls(token){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{ return { ok:true, rows:vote_poll_list_payload_(), currentPollId:vote_current_poll_id_() }; }
  catch(e){ return vote_err_('E500','未能載入投票列表。','Could not load the poll list.',e && e.message); }
}

function api_vote_admin_poll_detail(token, pollId){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const options = vote_get_options_(election.electionId);
    return {
      ok:true, election:election, effectiveState:vote_effective_state_(election,new Date()), options:options,
      optionsIntegrityOk:vote_options_integrity_ok_(election,options), ballotCount:vote_ballot_count_(election.electionId),
      scrutineerCount:vote_count_scrutineers_(election.electionId), isCurrent:election.electionId === vote_current_poll_id_()
    };
  }catch(e){ return vote_err_('E500','未能載入投票資料。','Could not load poll details.',e && e.message); }
}

function api_vote_admin_set_current_poll(token, pollId){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    const target = vote_get_election_(pollId);
    if (!target) return vote_err_('E412','找不到此投票。','Poll not found.');
    const oldId = vote_current_poll_id_();
    if (oldId && oldId !== target.electionId){
      const oldState = vote_effective_state_(vote_get_election_(oldId),new Date());
      if (oldState === 'OPEN' || oldState === 'SCHEDULED') return vote_err_('E_VOTE_CURRENT_ACTIVE','現有投票仍在進行或已排程，請先結束後才切換。','The current poll is open or scheduled. Close it before switching.');
    }
    const options = vote_get_options_(target.electionId);
    if (target.state !== 'DRAFT' && !vote_options_integrity_ok_(target,options)) return vote_err_('E_VOTE_OPTIONS_INTEGRITY','投票選項完整性檢查失敗，不能設為目前投票。','Option integrity failed; this poll cannot become current.');
    vote_set_current_poll_id_(target.electionId);
    vote_audit_({ id:s.member.id, role:s.role },target.electionId,'CURRENT_POLL_SET',target.electionId,'','Previous current poll: ' + oldId);
    return Object.assign({ ok:true },vote_dashboard_for_member_(s.member));
  }catch(e){ return vote_err_('E500','未能切換目前投票。','Could not switch the current poll.',e && e.message); }
}

function api_vote_admin_save_poll_content(token, pollId, payload){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    if (election.state !== 'DRAFT' || vote_ballot_count_(election.electionId) > 0) return vote_err_('E_VOTE_LOCKED','只有未有選票的草稿可以修改標題及選項。','Only a draft with no ballots may change its title or options.');
    const content = vote_validate_poll_content_(payload);
    if (!content.ok) return content;
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      const optionSheet = vote_get_sheet_(VOTE_OPTIONS_SHEET), optionCol = vote_header_map_(optionSheet);
      vote_sheet_records_(VOTE_OPTIONS_SHEET).forEach(function(r){ if (vote_poll_id_(r.ElectionId) === election.electionId) optionSheet.getRange(r._rowNumber,optionCol.Active + 1).setValue('NO'); });
      content.options.forEach(function(o){ optionSheet.appendRow([election.electionId,o.optionNo,o.labelZh,o.labelEn,o.sortOrder,'YES']); });
      const digest = vote_options_digest_(election.electionId,content.options,vote_get_secret_());
      const sh = vote_get_sheet_(VOTE_ELECTIONS_SHEET), col = vote_header_map_(sh);
      vote_write_election_field_(sh,election.rowNumber,col,'TitleZh',content.titleZh);
      vote_write_election_field_(sh,election.rowNumber,col,'TitleEn',content.titleEn);
      vote_write_election_field_(sh,election.rowNumber,col,'OptionDigest',digest);
      vote_write_election_field_(sh,election.rowNumber,col,'UpdatedAt',new Date());
      vote_write_election_field_(sh,election.rowNumber,col,'UpdatedBy',s.member.id);
    }finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },election.electionId,'POLL_CONTENT_UPDATE',election.electionId,'',JSON.stringify({ optionCount:content.options.length }));
    return api_vote_admin_poll_detail(token,election.electionId);
  }catch(e){ return vote_err_('E500','未能更新投票內容。','Could not update poll content.',e && e.message); }
}

function vote_count_scrutineers_(pollId){
  const poll = vote_poll_id_(pollId);
  return vote_sheet_records_(VOTE_SCRUTINEERS_SHEET).filter(function(r){ return vote_poll_id_(r.ElectionId) === poll && vote_bool_(r.Active); }).length;
}

function api_vote_admin_save_election(token, pollId, payload){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const p = payload || {}, state = String(p.state || '').trim().toUpperCase();
    if (['DRAFT','OPEN','CLOSED'].indexOf(state) < 0) return vote_err_('E416','投票狀態無效。','Invalid poll state.');
    if (election.state === 'CLOSED') return vote_err_('E_VOTE_FINAL','投票已正式結束，設定已鎖定。','The poll is closed and its settings are locked.');
    if (election.state === 'OPEN' && state === 'DRAFT') return vote_err_('E_VOTE_FINAL','已開放的投票不能回復為草稿。','An opened poll cannot return to draft.');
    if (vote_effective_state_(election,new Date()) === 'CLOSED' && state !== 'CLOSED') return vote_err_('E_VOTE_FINAL','截止時間已過，投票不能重新開啟。','The closing time has passed and the poll cannot be reopened.');
    const opensAt = vote_iso_(p.opensAt), closesAt = vote_iso_(p.closesAt);
    if (p.opensAt && !opensAt) return vote_err_('E422','開始日期格式無效。','Invalid opening date.');
    if (p.closesAt && !closesAt) return vote_err_('E422','截止日期格式無效。','Invalid closing date.');
    if (state === 'OPEN' && !closesAt) return vote_err_('E422','開放投票前必須設定截止時間。','A closing time is required before opening the poll.');
    if (state === 'OPEN' && new Date(closesAt).getTime() <= Date.now()) return vote_err_('E422','開放投票的截止時間必須在未來。','An open poll must have a future closing time.');
    if (opensAt && closesAt && new Date(closesAt).getTime() <= new Date(opensAt).getTime()) return vote_err_('E422','截止時間必須遲於開始時間。','Closing time must be after opening time.');
    const options = vote_get_options_(election.electionId);
    if (state === 'OPEN' && !vote_options_integrity_ok_(election,options)) return vote_err_('E_VOTE_OPTIONS_INTEGRITY','投票選項完整性檢查失敗，不能開放。','Option integrity failed; the poll cannot be opened.');
    if (state === 'OPEN'){
      const currentId = vote_current_poll_id_();
      if (currentId && currentId !== election.electionId){
        const currentState = vote_effective_state_(vote_get_election_(currentId),new Date());
        if (currentState === 'OPEN' || currentState === 'SCHEDULED') return vote_err_('E_VOTE_CURRENT_ACTIVE','另一個目前投票仍在進行或已排程。','Another current poll is open or scheduled.');
      }
    }
    const sh = vote_get_sheet_(VOTE_ELECTIONS_SHEET), col = vote_header_map_(sh);
    const oldSummary = JSON.stringify({ state:election.state, opensAt:election.opensAt, closesAt:election.closesAt });
    vote_write_election_field_(sh,election.rowNumber,col,'OpensAt',opensAt ? new Date(opensAt) : '');
    vote_write_election_field_(sh,election.rowNumber,col,'ClosesAt',closesAt ? new Date(closesAt) : '');
    vote_write_election_field_(sh,election.rowNumber,col,'State',state);
    vote_write_election_field_(sh,election.rowNumber,col,'UpdatedAt',new Date());
    vote_write_election_field_(sh,election.rowNumber,col,'UpdatedBy',s.member.id);
    if (state === 'OPEN') vote_set_current_poll_id_(election.electionId);
    const warning = state === 'OPEN' && vote_count_scrutineers_(election.electionId) < 2 ? { code:'FEWER_THAN_TWO_SCRUTINEERS', zh:'目前少於兩名監票員；建議正式投票前至少指定兩名。', en:'Fewer than two scrutineers are appointed; at least two are recommended.' } : null;
    vote_audit_({ id:s.member.id, role:s.role },election.electionId,'POLL_SETTINGS_UPDATE',election.electionId,'',oldSummary + ' -> ' + JSON.stringify({ state:state, opensAt:opensAt, closesAt:closesAt }));
    const detail = api_vote_admin_poll_detail(token,election.electionId);
    detail.warning = warning;
    return detail;
  }catch(e){ return vote_err_('E500','未能儲存投票設定。','Could not save poll settings.',e && e.message); }
}

function vote_upsert_eligibility_(pollId, memberId, childEligible, explicitIneligible, reason, actorId){
  const sh = vote_get_sheet_(VOTE_ELIGIBILITY_SHEET), current = vote_get_eligibility_flag_(pollId,memberId);
  const values = [vote_poll_id_(pollId),memberId,childEligible ? 'YES' : 'NO',explicitIneligible ? 'YES' : 'NO',reason,new Date(),actorId];
  if (current.rowNumber) sh.getRange(current.rowNumber,1,1,VOTE_ELIGIBILITY_HEADERS.length).setValues([values]);
  else sh.appendRow(values);
}

function vote_staff_poll_scope_(s, pollId){
  const election = vote_get_election_(pollId);
  if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
  if (s.role === 'STAFF' && election.electionId !== vote_current_poll_id_()) return vote_err_('E403','STAFF 只可管理目前投票的資格。','STAFF may manage eligibility only for the current poll.');
  return { ok:true, election:election };
}

function api_vote_staff_set_eligibility(token, pollId, memberId, childEligible, explicitIneligible, reason){
  const s = vote_require_role_(token,['STAFF','ADMIN']);
  if (!s.ok) return s;
  try{
    const scope = vote_staff_poll_scope_(s,pollId);
    if (!scope.ok) return scope;
    const id = String(memberId || '').trim().toUpperCase(), target = vote_get_member_(id);
    if (!target) return vote_err_('E412','找不到此會員。','Member not found.');
    const child = !!target.isMinor && vote_bool_(childEligible), excluded = vote_bool_(explicitIneligible), why = String(reason || '').trim();
    if (excluded && why.length < 3) return vote_err_('E422','加入不合資格名單時，請填寫原因。','Please give a reason when excluding someone.');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{ vote_upsert_eligibility_(scope.election.electionId,id,child,excluded,excluded ? why : '',s.member.id); }
    finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },scope.election.electionId,'ELIGIBILITY_UPDATE',id,excluded ? why : '',JSON.stringify({ childEligible:child, explicitIneligible:excluded }));
    const flag = vote_get_eligibility_flag_(scope.election.electionId,id);
    return { ok:true, member:target, flags:flag, eligibility:vote_evaluate_eligibility_(target,flag) };
  }catch(e){ return vote_err_('E500','未能更新投票資格。','Could not update voting eligibility.',e && e.message); }
}

function api_vote_staff_roster(token, pollId, query){
  const s = vote_require_role_(token,['STAFF','ADMIN']);
  if (!s.ok) return s;
  try{
    const scope = vote_staff_poll_scope_(s,pollId);
    if (!scope.ok) return scope;
    const poll = scope.election.electionId, q = String(query || '').trim().toLowerCase(), flagged = {};
    vote_sheet_records_(VOTE_ELIGIBILITY_SHEET).forEach(function(r){ if (vote_poll_id_(r.ElectionId) === poll) flagged[String(r.MemberId || '').trim().toUpperCase()] = true; });
    let members = vote_all_members_().filter(function(m){
      if (!q) return m.isMinor || !!flagged[m.id];
      return [m.id,m.nameZh,m.nameEn,m.preferredName].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    const totalMatches = members.length;
    members = members.slice(0,100).map(function(m){ const flag = vote_get_eligibility_flag_(poll,m.id); return { member:m, flags:flag, eligibility:vote_evaluate_eligibility_(m,flag) }; });
    return { ok:true, rows:members, truncated:totalMatches > 100 };
  }catch(e){ return vote_err_('E500','未能載入會員投票資格。','Could not load voting eligibility.',e && e.message); }
}

function api_vote_admin_scrutineers(token, pollId){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const rows = vote_sheet_records_(VOTE_SCRUTINEERS_SHEET).filter(function(r){ return vote_poll_id_(r.ElectionId) === election.electionId && vote_bool_(r.Active); }).map(function(r){
      const m = vote_get_member_(r.MemberId);
      return { memberId:String(r.MemberId || '').trim().toUpperCase(), nameZh:m ? m.nameZh : '', nameEn:m ? m.nameEn : '', addedAt:vote_iso_(r.AddedAt), addedBy:String(r.AddedBy || '') };
    });
    return { ok:true, rows:rows, pollId:election.electionId };
  }catch(e){ return vote_err_('E500','未能載入監票員名單。','Could not load the scrutineer list.',e && e.message); }
}

function api_vote_admin_scrutineer_update(token, pollId, memberId, active){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const id = String(memberId || '').trim().toUpperCase(), target = vote_get_member_(id);
    if (!target) return vote_err_('E412','找不到此會員。','Member not found.');
    const targetEligibility = vote_evaluate_eligibility_(target,{ childEligible:true, explicitIneligible:false });
    if (['STATUS_MISSING','STATUS_DISABLED','STATUS_PROVISIONAL','STATUS_PENDING'].indexOf(targetEligibility.code) >= 0) return vote_err_('E403','此會員狀態不能獲委任為監票員。','This member status cannot be appointed as a scrutineer.');
    const enabled = vote_bool_(active), sh = vote_get_sheet_(VOTE_SCRUTINEERS_SHEET), lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      const matches = vote_sheet_records_(VOTE_SCRUTINEERS_SHEET).filter(function(r){ return vote_poll_id_(r.ElectionId) === election.electionId && String(r.MemberId || '').trim().toUpperCase() === id; });
      if (!matches.length){ if (enabled) sh.appendRow([election.electionId,id,'YES',new Date(),s.member.id,new Date(),s.member.id]); }
      else{
        const primary = matches[matches.length - 1];
        matches.forEach(function(current){
          const activeValue = enabled && current._rowNumber === primary._rowNumber ? 'YES' : 'NO';
          sh.getRange(current._rowNumber,1,1,VOTE_SCRUTINEER_HEADERS.length).setValues([[election.electionId,id,activeValue,current.AddedAt || new Date(),current.AddedBy || s.member.id,new Date(),s.member.id]]);
        });
      }
    }finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },election.electionId,enabled ? 'SCRUTINEER_ADD' : 'SCRUTINEER_REMOVE',id,'','Explicit appointment updated.');
    return api_vote_admin_scrutineers(token,election.electionId);
  }catch(e){ return vote_err_('E500','未能更新監票員名單。','Could not update the scrutineer list.',e && e.message); }
}

function api_vote_cast(token, pollId, optionNo){
  const s = vote_require_session_(token);
  if (!s.ok) return s;
  try{
    const poll = vote_poll_id_(pollId);
    if (!poll || poll !== vote_current_poll_id_()) return vote_err_('E_VOTE_NOT_CURRENT','此投票並非目前投票。','This is not the current poll.');
    const election = vote_get_election_(poll);
    if (!election) return vote_err_('E_VOTE_SETUP','投票尚未設定。','The poll has not been configured.');
    if (vote_effective_state_(election,new Date()) !== 'OPEN') return vote_err_('E_VOTE_CLOSED','投票目前未開放。','Voting is not currently open.');
    const options = vote_get_options_(poll);
    if (!vote_options_integrity_ok_(election,options)) return vote_err_('E_VOTE_OPTIONS_INTEGRITY','投票選項暫時未能使用。','Poll options are temporarily unavailable.');
    const flag = vote_get_eligibility_flag_(poll,s.member.id), eligibility = vote_evaluate_eligibility_(s.member,flag);
    if (!eligibility.eligible) return vote_err_('E_VOTE_INELIGIBLE',eligibility.zh,eligibility.en,eligibility.reason || eligibility.code);
    const option = String(optionNo || '').trim();
    if (!options.some(function(o){ return o.optionNo === option; })) return vote_err_('E416','請選擇一個有效選項。','Please select one valid option.');
    const secret = vote_get_secret_(), voterCode = vote_voter_code_(poll,s.member.id,secret), lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      const existing = vote_ballots_(poll).filter(function(b){ return b.voterCode === voterCode; })[0];
      if (existing) return { ok:true, result:'ALREADY_VOTED', receiptId:existing.receiptId, castAt:existing.castAt };
      const priorAudit = vote_prior_cast_audit_(poll,voterCode);
      if (priorAudit) return vote_err_('E_VOTE_INTEGRITY','系統找到先前投票記錄，但選票資料不完整；為防止重複投票，請聯絡管理員。','A prior cast record exists but its ballot is incomplete. Contact an admin for review.',priorAudit.receiptId || priorAudit.timestamp);
      const receiptId = 'R-' + Utilities.getUuid().replace(/-/g,'').slice(0,20).toUpperCase(), castAt = new Date().toISOString();
      const decisionCode = vote_decision_code_(poll,s.member.id,option,receiptId,secret);
      const ballot = { electionId:poll, receiptId:receiptId, voterCode:voterCode, optionNo:option, castAt:castAt, decisionCode:decisionCode };
      ballot.integrityMac = vote_integrity_mac_(ballot,secret);
      vote_get_sheet_(VOTE_BALLOTS_SHEET).appendRow([poll,receiptId,voterCode,option,new Date(castAt),decisionCode,ballot.integrityMac]);
      vote_audit_({ id:voterCode, role:'VOTER_CODE' },poll,'BALLOT_CAST',receiptId,'','Ballot recorded; option omitted from audit.');
      return { ok:true, result:'CAST', receiptId:receiptId, castAt:castAt };
    }finally{ lock.releaseLock(); }
  }catch(e){ return vote_err_('E500','未能提交選票。','Could not submit the ballot.',e && e.message); }
}

function vote_require_results_viewer_(token, pollId, requireTrace){
  const s = vote_require_session_(token);
  if (!s.ok) return s;
  const election = vote_get_election_(pollId);
  if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
  const p = vote_privileges_(s.member,election.electionId);
  if (requireTrace ? !p.canTrace : !p.canViewEarlyResults) return vote_err_('E403','只有管理員或指定監票員可執行此操作。','Only an admin or appointed scrutineer may perform this action.');
  s.privileges = p;
  s.election = election;
  return s;
}

function api_vote_results(token, pollId){
  const s = vote_require_session_(token);
  if (!s.ok) return s;
  try{
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const effectiveState = vote_effective_state_(election,new Date()), privileges = vote_privileges_(s.member,election.electionId);
    const isCurrent = election.electionId === vote_current_poll_id_();
    if ((!isCurrent || effectiveState !== 'CLOSED') && !privileges.canViewEarlyResults) return vote_err_('E403','投票結束前只有管理員及指定監票員可查看結果。','Only admins and appointed scrutineers may view results before closing.');
    const options = vote_get_options_(election.electionId);
    if (!vote_options_integrity_ok_(election,options)) return vote_err_('E_VOTE_OPTIONS_INTEGRITY','投票選項完整性檢查失敗。','Poll option integrity check failed.');
    const secret = vote_get_secret_(), counts = {};
    options.forEach(function(o){ counts[o.optionNo] = 0; });
    let invalid = 0;
    vote_ballots_(election.electionId).forEach(function(b){
      if (!vote_valid_ballot_(b,secret) || counts[b.optionNo] === undefined){ invalid++; return; }
      counts[b.optionNo]++;
    });
    const rows = options.map(function(o){ return { optionNo:o.optionNo, labelZh:o.labelZh, labelEn:o.labelEn, votes:counts[o.optionNo] || 0 }; });
    vote_audit_({ id:s.member.id, role:vote_norm_status_(s.member.status) },election.electionId,'RESULTS_VIEW',election.electionId,'',JSON.stringify({ effectiveState:effectiveState, privileged:privileges.canViewEarlyResults }));
    return {
      ok:true, election:vote_client_election_(election), effectiveState:effectiveState, rows:rows, totalBallots:rows.reduce(function(sum,r){ return sum + r.votes; },0),
      integrityExceptions:privileges.canTrace ? invalid : undefined
    };
  }catch(e){ return vote_err_('E500','未能載入投票結果。','Could not load results.',e && e.message); }
}

function api_vote_exception_polls(token){
  const s = vote_require_session_(token);
  if (!s.ok) return s;
  try{
    const rows = vote_all_elections_().filter(function(e){ return vote_privileges_(s.member,e.electionId).canTrace; }).map(function(e){
      return {
        electionId:e.electionId, titleZh:e.titleZh, titleEn:e.titleEn,
        effectiveState:vote_effective_state_(e,new Date()), opensAt:e.opensAt, closesAt:e.closesAt
      };
    }).sort(function(a,b){ return String(b.closesAt || b.opensAt || b.electionId).localeCompare(String(a.closesAt || a.opensAt || a.electionId)); });
    if (!rows.length) return vote_err_('E403','沒有權限執行此操作。','You do not have permission for this action.');
    return { ok:true, rows:rows };
  }catch(e){ return vote_err_('E500','未能載入正式核查頁面。','Could not load the formal review page.',e && e.message); }
}

function api_vote_trace(token, pollId, receiptOrDecisionCode, reason){
  const s = vote_require_results_viewer_(token,pollId,true);
  if (!s.ok) return s;
  try{
    const poll = s.election.electionId, query = String(receiptOrDecisionCode || '').trim(), why = String(reason || '').trim();
    if (!query) return vote_err_('E422','請輸入選票收據編號。','Enter the ballot receipt ID.');
    if (why.length < 10) return vote_err_('E422','正式核查原因至少需要 10 個字元。','The formal review reason must be at least 10 characters.');
    const ballot = vote_ballots_(poll).filter(function(b){ return b.receiptId === query || b.decisionCode === query; })[0];
    if (!ballot) return vote_err_('E412','找不到此選票。','Ballot not found.');
    const secret = vote_get_secret_();
    if (!vote_valid_ballot_(ballot,secret)) return vote_err_('E_VOTE_INTEGRITY','選票完整性檢查失敗。','Ballot integrity check failed.');
    const members = vote_all_members_();
    let member = null;
    for (let i=0;i<members.length;i++){ if (vote_voter_code_(poll,members[i].id,secret) === ballot.voterCode){ member = members[i]; break; } }
    if (!member) return vote_err_('E_VOTE_TRACE','未能配對會員；會員資料可能已被移除。','Could not match the member; its record may have been removed.');
    const option = vote_get_options_(poll).filter(function(o){ return o.optionNo === ballot.optionNo; })[0] || { optionNo:ballot.optionNo, labelZh:'', labelEn:'' };
    const auditRecorded = vote_audit_({ id:s.member.id, role:vote_norm_status_(s.member.status) },poll,'BALLOT_TRACE',ballot.receiptId,why,JSON.stringify({ memberId:member.id, decisionCode:ballot.decisionCode }));
    if (!auditRecorded) return vote_err_('E_VOTE_AUDIT','未能寫入核查審計記錄，因此沒有顯示會員資料。請稍後重試。','The review audit could not be written, so member details were not disclosed. Please retry later.');
    return {
      ok:true, ballot:{ receiptId:ballot.receiptId, castAt:ballot.castAt },
      member:{ id:member.id, nameZh:member.nameZh, nameEn:member.nameEn, preferredName:member.preferredName, status:member.status },
      choice:option, auditRecorded:true
    };
  }catch(e){ return vote_err_('E500','未能完成選票核查。','Could not complete the ballot review.',e && e.message); }
}

/* ===== END OF Vote.gs (COMPLETE) ===== */
