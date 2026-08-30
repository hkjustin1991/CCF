/***************************************
 * CCF reusable member polling portal
 * File: Vote.gs (use VoteBackend.gs in Apps Script if Vote.html already exists)
 * v2026-08-23.vote4
 *
 * The normal portal exposes routine voting and permitted aggregate results only.
 * The separately routed review workflow remains permission- and audit-gated.
 ***************************************/

const VOTE_VERSION = '2026-08-23.vote4';
const VOTE_SESSION_PREFIX = 'vote_sess_';
const VOTE_SESSION_TTL_SECONDS = 30 * 60;
const VOTE_SECRET_PROPERTY = 'CCF_VOTE_TRACE_SECRET';
const VOTE_CURRENT_POLL_PROPERTY = 'CCF_VOTE_CURRENT_POLL_ID';

/* Poll setup stays readable in Vote; running records stay in Vote Audit. */
const VOTE_SHEET = 'Vote';
const VOTE_AUDIT_SHEET = 'Vote Audit';
const VOTE_LEGACY_SHEETS = [
  'Vote_Elections','Vote_Options','Vote_Eligibility','Vote_Ballots','Vote_Scrutineers','Vote_Audit'
];
const VOTE_HEADERS = [
  'RecordType','PollId','RecordId','Question','QuestionAlt','OptionNo','OptionText','OptionTextAlt','SortOrder',
  'AnswerType','MaxSelections','IncludeChildren','State','OpensAt','ClosesAt','Active','OptionDigest',
  'FinalResult','ResultNotes','CreatedAt','CreatedBy','UpdatedAt','UpdatedBy','LegacySource'
];
const VOTE_AUDIT_HEADERS = [
  'RecordType','PollId','RecordId','MemberId','ExplicitIneligible','Reason','ReceiptId','VoterCode','Choices','Abstained',
  'CastAt','DecisionCode','IntegrityMac','ActorId','ActorRole','Action','Target','Details','Active',
  'CreatedAt','CreatedBy','UpdatedAt','UpdatedBy','LegacySource'
];
const VOTE_RECORD_POLL = 'POLL';
const VOTE_RECORD_OPTION = 'OPTION';
const VOTE_RECORD_ELIGIBILITY = 'ELIGIBILITY';
const VOTE_RECORD_BALLOT = 'BALLOT';
const VOTE_RECORD_SCRUTINEER = 'SCRUTINEER';
const VOTE_RECORD_AUDIT = 'AUDIT';
const VOTE_ANSWER_SINGLE = 'SINGLE';
const VOTE_ANSWER_MULTIPLE = 'MULTIPLE';
const VOTE_ANSWER_RANKED = 'RANKED';
const VOTE_ABSTAIN_VALUE = '__ABSTAIN__';

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

function vote_err_(code,zh,en,detail){
  const out = { ok:false, code:String(code || 'E500'), zh:String(zh || '系統錯誤'), en:String(en || 'System error') };
  if (detail !== undefined && detail !== null && String(detail) !== '') out.detail = String(detail);
  return out;
}

function vote_open_ss_(){
  const id = (typeof SPREADSHEET_ID !== 'undefined') ? SPREADSHEET_ID : '';
  if (!id) throw new Error('Spreadsheet ID is not configured.');
  return SpreadsheetApp.openById(id);
}

function vote_ensure_sheet_(name,headers){
  const ss = vote_open_ss_();
  let sh = ss.getSheetByName(name);
  if (!sh){
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#e8eef8');
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = Math.max(1,sh.getLastColumn());
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
function vote_get_data_sheet_(){ return vote_get_sheet_(VOTE_SHEET); }
function vote_ensure_data_sheet_(){ return vote_ensure_sheet_(VOTE_SHEET,VOTE_HEADERS); }
function vote_get_audit_sheet_(){ return vote_get_sheet_(VOTE_AUDIT_SHEET); }
function vote_ensure_audit_sheet_(){ return vote_ensure_sheet_(VOTE_AUDIT_SHEET,VOTE_AUDIT_HEADERS); }

function vote_sheet_records_(name){
  const sh = vote_get_sheet_(name);
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 1) return [];
  const values = sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
  const headers = values[0].map(function(v){ return String(v || '').trim(); });
  return values.slice(1).map(function(row,idx){
    const rec = { _rowNumber:idx + 2 };
    headers.forEach(function(h,col){ if (h) rec[h] = row[col]; });
    return rec;
  });
}

function vote_header_map_(sh){
  if (!sh || sh.getLastColumn() < 1) return {};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0], map = {};
  headers.forEach(function(h,idx){ const key = String(h || '').trim(); if (key) map[key] = idx; });
  return map;
}

function vote_sheet_row_from_fields_(headers,fields){
  const f = fields || {};
  return headers.map(function(h){ return Object.prototype.hasOwnProperty.call(f,h) ? f[h] : ''; });
}

function vote_row_from_fields_(fields){ return vote_sheet_row_from_fields_(VOTE_HEADERS,fields); }
function vote_audit_row_from_fields_(fields){ return vote_sheet_row_from_fields_(VOTE_AUDIT_HEADERS,fields); }

function vote_append_record_(fields){
  const sh = vote_ensure_data_sheet_();
  sh.appendRow(vote_row_from_fields_(fields));
  return sh.getLastRow();
}

function vote_append_audit_record_(fields){
  const sh = vote_ensure_audit_sheet_();
  sh.appendRow(vote_audit_row_from_fields_(fields));
  return sh.getLastRow();
}

function vote_update_record_(rowNumber,fields){
  const sh = vote_get_data_sheet_();
  if (!sh || !rowNumber) throw new Error('Vote data row not found.');
  const col = vote_header_map_(sh), f = fields || {};
  Object.keys(f).forEach(function(key){
    if (col[key] === undefined) throw new Error('Missing Vote column: ' + key);
    sh.getRange(rowNumber,col[key] + 1).setValue(f[key]);
  });
}

function vote_update_audit_record_(rowNumber,fields){
  const sh = vote_get_audit_sheet_();
  if (!sh || !rowNumber) throw new Error('Vote Audit row not found.');
  const col = vote_header_map_(sh), f = fields || {};
  Object.keys(f).forEach(function(key){
    if (col[key] === undefined) throw new Error('Missing Vote Audit column: ' + key);
    sh.getRange(rowNumber,col[key] + 1).setValue(f[key]);
  });
}

function vote_data_records_(recordType){
  const rows = vote_sheet_records_(VOTE_SHEET), type = String(recordType || '').trim().toUpperCase();
  return type ? rows.filter(function(r){ return String(r.RecordType || '').trim().toUpperCase() === type; }) : rows;
}

function vote_audit_data_records_(recordType){
  const rows = vote_sheet_records_(VOTE_AUDIT_SHEET), type = String(recordType || '').trim().toUpperCase();
  return type ? rows.filter(function(r){ return String(r.RecordType || '').trim().toUpperCase() === type; }) : rows;
}

function vote_is_config_record_type_(recordType){
  const type = String(recordType || '').trim().toUpperCase();
  return type === VOTE_RECORD_POLL || type === VOTE_RECORD_OPTION;
}

function vote_is_runtime_record_type_(recordType){
  const type = String(recordType || '').trim().toUpperCase();
  return [VOTE_RECORD_ELIGIBILITY,VOTE_RECORD_BALLOT,VOTE_RECORD_SCRUTINEER,VOTE_RECORD_AUDIT].indexOf(type) >= 0;
}

function vote_join_text_(primary,alternate){
  const one = String(primary || '').trim(), two = String(alternate || '').trim();
  if (!one) return two;
  if (!two || one === two) return one;
  return one + ' / ' + two;
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

function vote_poll_id_(value){ return String(value || '').trim().toUpperCase(); }
function vote_valid_poll_id_(value){ return /^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(vote_poll_id_(value)); }
function vote_record_poll_id_(r){ return vote_poll_id_((r && (r.PollId || r.ElectionId)) || ''); }
function vote_new_record_id_(prefix){ return String(prefix || 'REC') + '_' + Utilities.getUuid().replace(/-/g,'').toUpperCase(); }

function vote_legacy_source_(sheetName,rowNumber){ return String(sheetName) + '#' + String(rowNumber); }

function vote_legacy_record_fields_(sheetName,r){
  const source = vote_legacy_source_(sheetName,r._rowNumber);
  if (sheetName === 'Vote_Elections') return {
    RecordType:VOTE_RECORD_POLL, PollId:vote_poll_id_(r.ElectionId), RecordId:vote_poll_id_(r.ElectionId),
    Question:String(r.TitleZh || '').trim(), QuestionAlt:String(r.TitleEn || '').trim(), AnswerType:VOTE_ANSWER_SINGLE, MaxSelections:1,
    IncludeChildren:'NO',
    State:String(r.State || 'DRAFT').trim().toUpperCase(), OpensAt:r.OpensAt || '', ClosesAt:r.ClosesAt || '', OptionDigest:r.OptionDigest || '',
    CreatedAt:r.CreatedAt || '', CreatedBy:r.CreatedBy || '', UpdatedAt:r.UpdatedAt || '', UpdatedBy:r.UpdatedBy || '', LegacySource:source
  };
  if (sheetName === 'Vote_Options') return {
    RecordType:VOTE_RECORD_OPTION, PollId:vote_poll_id_(r.ElectionId), RecordId:source, OptionNo:String(r.OptionNo || '').trim(),
    OptionText:String(r.LabelZh || '').trim(), OptionTextAlt:String(r.LabelEn || '').trim(), SortOrder:Number(r.SortOrder || 0),
    Active:vote_bool_(r.Active) ? 'YES' : 'NO', LegacySource:source
  };
  if (sheetName === 'Vote_Eligibility') return {
    RecordType:VOTE_RECORD_ELIGIBILITY, PollId:vote_poll_id_(r.ElectionId), RecordId:source, MemberId:String(r.MemberId || '').trim().toUpperCase(),
    ExplicitIneligible:vote_bool_(r.ExplicitIneligible) ? 'YES' : 'NO', Reason:r.Reason || '',
    UpdatedAt:r.UpdatedAt || '', UpdatedBy:r.UpdatedBy || '', LegacySource:source
  };
  if (sheetName === 'Vote_Ballots') return {
    RecordType:VOTE_RECORD_BALLOT, PollId:vote_poll_id_(r.ElectionId), RecordId:source, ReceiptId:r.ReceiptId || '', VoterCode:r.VoterCode || '',
    Choices:String(r.OptionNo || '').trim(), Abstained:'NO', CastAt:r.CastAt || '', DecisionCode:r.DecisionCode || '', IntegrityMac:r.IntegrityMac || '', LegacySource:source
  };
  if (sheetName === 'Vote_Scrutineers') return {
    RecordType:VOTE_RECORD_SCRUTINEER, PollId:vote_poll_id_(r.ElectionId), RecordId:source, MemberId:String(r.MemberId || '').trim().toUpperCase(),
    Active:vote_bool_(r.Active) ? 'YES' : 'NO', CreatedAt:r.AddedAt || '', CreatedBy:r.AddedBy || '', UpdatedAt:r.UpdatedAt || '', UpdatedBy:r.UpdatedBy || '', LegacySource:source
  };
  if (sheetName === 'Vote_Audit') return {
    RecordType:VOTE_RECORD_AUDIT, PollId:vote_poll_id_(r.ElectionId), RecordId:source, ActorId:r.ActorId || '', ActorRole:r.ActorRole || '',
    Action:r.Action || '', Target:r.Target || '', Reason:r.Reason || '', Details:r.Details || '', CreatedAt:r.Timestamp || '', LegacySource:source
  };
  return null;
}

/* Split records created by vote3 before importing any older Vote_* tabs. */
function vote_migrate_unified_vote_(){
  const ss = vote_open_ss_(), sh = ss.getSheetByName(VOTE_SHEET);
  if (!sh){ vote_ensure_data_sheet_(); vote_ensure_audit_sheet_(); return { migrated:0, removedRows:0, removedColumns:0 }; }
  const rows = vote_sheet_records_(VOTE_SHEET);
  const unknownRows = rows.filter(function(r){
    const type = String(r.RecordType || '').trim().toUpperCase();
    return !!type && !vote_is_config_record_type_(type) && !vote_is_runtime_record_type_(type);
  });
  if (unknownRows.length) throw new Error('Unsupported Vote record type at row(s): ' + unknownRows.map(function(r){ return r._rowNumber; }).join(', '));
  const runtimeRows = rows.filter(function(r){
    const type = String(r.RecordType || '').trim().toUpperCase();
    return vote_is_runtime_record_type_(type);
  });
  const auditSheet = vote_ensure_audit_sheet_(), existingSources = {};
  vote_audit_data_records_('').forEach(function(r){ if (r.LegacySource) existingSources[String(r.LegacySource)] = true; });
  const expected = [];
  runtimeRows.forEach(function(r){
    const fields = {}, source = String(r.LegacySource || vote_legacy_source_(VOTE_SHEET,r._rowNumber));
    VOTE_AUDIT_HEADERS.forEach(function(h){ if (Object.prototype.hasOwnProperty.call(r,h)) fields[h] = r[h]; });
    fields.LegacySource = source;
    expected.push(source);
    if (!existingSources[source]){
      auditSheet.appendRow(vote_audit_row_from_fields_(fields));
      existingSources[source] = true;
    }
  });
  const verified = {};
  vote_audit_data_records_('').forEach(function(r){ if (r.LegacySource) verified[String(r.LegacySource)] = true; });
  const missing = expected.filter(function(source){ return !verified[source]; });
  if (missing.length) throw new Error('Vote split verification failed: ' + missing.join(', '));
  runtimeRows.map(function(r){ return r._rowNumber; }).sort(function(a,b){ return b - a; }).forEach(function(rowNumber){ sh.deleteRow(rowNumber); });
  vote_ensure_data_sheet_();
  const headers = sh.getRange(1,1,1,Math.max(1,sh.getLastColumn())).getValues()[0].map(function(v){ return String(v || '').trim(); });
  let removedColumns = 0;
  for (let col=headers.length - 1;col>=0;col--){
    if (VOTE_HEADERS.indexOf(headers[col]) >= 0) continue;
    sh.deleteColumn(col + 1);
    removedColumns++;
  }
  vote_ensure_data_sheet_();
  return { migrated:runtimeRows.length, removedRows:runtimeRows.length, removedColumns:removedColumns };
}

function vote_migrate_legacy_sheets_(){
  const ss = vote_open_ss_(), split = vote_migrate_unified_vote_(), dataSheet = vote_ensure_data_sheet_(), auditSheet = vote_ensure_audit_sheet_(), existingSources = {};
  vote_data_records_('').concat(vote_audit_data_records_('')).forEach(function(r){ if (r.LegacySource) existingSources[String(r.LegacySource)] = true; });
  const expectedSources = [], legacySheets = [];
  VOTE_LEGACY_SHEETS.forEach(function(name){
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    legacySheets.push(sh);
    vote_sheet_records_(name).forEach(function(r){
      const fields = vote_legacy_record_fields_(name,r);
      if (!fields) return;
      expectedSources.push(fields.LegacySource);
      if (!existingSources[fields.LegacySource]){
        const target = vote_is_config_record_type_(fields.RecordType) ? dataSheet : auditSheet;
        target.appendRow(vote_is_config_record_type_(fields.RecordType) ? vote_row_from_fields_(fields) : vote_audit_row_from_fields_(fields));
        existingSources[fields.LegacySource] = true;
      }
    });
  });
  const verified = {};
  vote_data_records_('').concat(vote_audit_data_records_('')).forEach(function(r){ if (r.LegacySource) verified[String(r.LegacySource)] = true; });
  const missing = expectedSources.filter(function(source){ return !verified[source]; });
  if (missing.length) throw new Error('Vote migration verification failed: ' + missing.join(', '));
  legacySheets.forEach(function(sh){ ss.deleteSheet(sh); });
  return { migrated:expectedSources.length + split.migrated, removedSheets:legacySheets.length, splitRows:split.removedRows, removedColumns:split.removedColumns };
}

function vote_norm_status_(value){ return String(value || '').trim().toUpperCase(); }

function vote_effective_member_status_(value,roleExpires){
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
    nameZh:String(row.NameZh || '').trim(), nameEn:String(row.NameEn || '').trim(), preferredName:String(row.PreferredName || '').trim(),
    status:vote_effective_member_status_(row.Status,row.RoleExpires), isMinor:vote_bool_(row.IsMinor)
  };
}

function vote_get_member_(memberId){
  const id = String(memberId || '').trim().toUpperCase();
  if (!id) return null;
  try{
    const idx = admin_getMembersIndex_(), m = idx && idx.byId ? idx.byId[id] : null;
    if (!m) return null;
    return {
      id:id, nameZh:String(m.nameZh || '').trim(), nameEn:String(m.nameEn || '').trim(), preferredName:String(m.preferredName || '').trim(),
      status:vote_effective_member_status_(m.status,m.roleExpires), isMinor:!!m.isMinor
    };
  }catch(e){ return null; }
}

function vote_all_members_(){
  const idx = admin_getMembersIndex_();
  return ((idx && idx.all) || []).map(function(m){
    return {
      id:String(m.id || '').trim().toUpperCase(), nameZh:String(m.nameZh || '').trim(), nameEn:String(m.nameEn || '').trim(),
      preferredName:String(m.preferredName || '').trim(), status:vote_effective_member_status_(m.status,m.roleExpires), isMinor:!!m.isMinor
    };
  }).filter(function(m){ return !!m.id; });
}

function vote_new_session_(member){
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(VOTE_SESSION_PREFIX + token,JSON.stringify({ memberId:member.id, createdAt:Date.now() }),VOTE_SESSION_TTL_SECONDS);
  return token;
}

function vote_require_session_(token){
  const key = VOTE_SESSION_PREFIX + String(token || '').trim(), raw = CacheService.getScriptCache().get(key);
  if (!raw) return vote_err_('E401','登入已過期，請重新掃描會員 QR。','Session expired. Please scan your member QR again.');
  let parsed;
  try{ parsed = JSON.parse(raw); }catch(e){ return vote_err_('E401','登入已過期，請重新掃描會員 QR。','Session expired. Please scan your member QR again.'); }
  const member = vote_get_member_(parsed.memberId);
  if (!member) return vote_err_('E412','找不到會員資料。','Member record not found.');
  CacheService.getScriptCache().put(key,raw,VOTE_SESSION_TTL_SECONDS);
  return { ok:true, member:member };
}

function vote_require_role_(token,allowed){
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
  try{ return !!vote_get_data_sheet_() && !!vote_get_audit_sheet_() && !!String(PropertiesService.getScriptProperties().getProperty(VOTE_SECRET_PROPERTY) || '').trim(); }
  catch(e){ return false; }
}

function vote_current_poll_id_(){
  try{ return String(PropertiesService.getScriptProperties().getProperty(VOTE_CURRENT_POLL_PROPERTY) || '').trim(); }
  catch(e){ return ''; }
}

function vote_set_current_poll_id_(pollId){ PropertiesService.getScriptProperties().setProperty(VOTE_CURRENT_POLL_PROPERTY,String(pollId || '').trim()); }

function vote_new_poll_id_(){
  const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const suffix = Utilities.getUuid().replace(/-/g,'').slice(0,12).toUpperCase();
  return 'POLL_' + stamp + '_' + suffix;
}

function vote_normalize_answer_type_(value){
  const type = String(value || VOTE_ANSWER_SINGLE).trim().toUpperCase();
  return [VOTE_ANSWER_SINGLE,VOTE_ANSWER_MULTIPLE,VOTE_ANSWER_RANKED].indexOf(type) >= 0 ? type : '';
}

function vote_election_from_record_(r){
  const pollId = vote_record_poll_id_(r), question = String(r.Question !== undefined ? r.Question : r.TitleZh || '').trim();
  const questionAlt = String(r.QuestionAlt !== undefined ? r.QuestionAlt : r.TitleEn || '').trim();
  const answerType = vote_normalize_answer_type_(r.AnswerType) || VOTE_ANSWER_SINGLE;
  let maxSelections = Number(r.MaxSelections || 0);
  if (answerType === VOTE_ANSWER_SINGLE) maxSelections = 1;
  return {
    rowNumber:r._rowNumber, electionId:pollId, pollId:pollId, question:question, questionAlt:questionAlt,
    titleZh:question, titleEn:questionAlt, answerType:answerType, maxSelections:maxSelections, includeChildren:vote_bool_(r.IncludeChildren),
    opensAt:vote_iso_(r.OpensAt), closesAt:vote_iso_(r.ClosesAt), state:String(r.State || 'DRAFT').trim().toUpperCase(),
    optionDigest:String(r.OptionDigest || '').trim(), createdAt:vote_iso_(r.CreatedAt), createdBy:String(r.CreatedBy || '').trim(),
    updatedAt:vote_iso_(r.UpdatedAt), updatedBy:String(r.UpdatedBy || '').trim(), finalResult:String(r.FinalResult || '').trim(), resultNotes:String(r.ResultNotes || '').trim()
  };
}

function vote_all_elections_(){
  const rows = vote_get_data_sheet_() ? vote_data_records_(VOTE_RECORD_POLL) : vote_sheet_records_('Vote_Elections');
  return rows.filter(function(r){ return vote_valid_poll_id_(vote_record_poll_id_(r)); }).map(vote_election_from_record_);
}

function vote_get_election_(pollId){
  const id = vote_poll_id_(pollId || vote_current_poll_id_());
  if (!id) return null;
  const rows = vote_all_elections_();
  for (let i=rows.length - 1;i>=0;i--){ if (rows[i].electionId === id) return rows[i]; }
  return null;
}

function vote_effective_state_(election,now){
  if (!election) return 'NO_CURRENT_POLL';
  const state = String(election.state || 'DRAFT').trim().toUpperCase();
  if (state === 'CLOSED') return 'CLOSED';
  if (state !== 'OPEN') return 'DRAFT';
  const current = now instanceof Date ? now : new Date();
  const opens = election.opensAt ? new Date(election.opensAt) : null, closes = election.closesAt ? new Date(election.closesAt) : null;
  if (opens && !isNaN(opens.getTime()) && current.getTime() < opens.getTime()) return 'SCHEDULED';
  if (closes && !isNaN(closes.getTime()) && current.getTime() >= closes.getTime()) return 'CLOSED';
  return 'OPEN';
}

function vote_get_options_(pollId){
  const id = vote_poll_id_(pollId);
  if (!id) return [];
  const unified = !!vote_get_data_sheet_();
  const rows = unified ? vote_data_records_(VOTE_RECORD_OPTION) : vote_sheet_records_('Vote_Options');
  return rows.filter(function(r){ return vote_record_poll_id_(r) === id && vote_bool_(r.Active); }).map(function(r){
    const label = String(unified ? r.OptionText || '' : r.LabelZh || '').trim();
    const labelAlt = String(unified ? r.OptionTextAlt || '' : r.LabelEn || '').trim();
    return { optionNo:String(r.OptionNo || '').trim(), label:label, labelAlt:labelAlt, labelZh:label, labelEn:labelAlt, sortOrder:Number(r.SortOrder || 0) };
  }).sort(function(a,b){ return a.sortOrder - b.sortOrder; });
}

function vote_normalize_options_payload_(rawOptions){
  const input = Array.isArray(rawOptions) ? rawOptions : [];
  if (input.length < 2 || input.length > 50) return vote_err_('E422','每個投票需要 2 至 50 個選項。','Each poll requires between 2 and 50 options.');
  const seen = {}, options = [];
  for (let i=0;i<input.length;i++){
    const raw = input[i] || {}, optionNo = String(raw.optionNo || (i + 1)).trim();
    const label = String(raw.label !== undefined ? raw.label : raw.labelZh || raw.labelEn || '').trim();
    const labelAlt = String(raw.labelAlt !== undefined ? raw.labelAlt : (raw.labelZh && raw.labelEn ? raw.labelEn : '') || '').trim();
    if (!/^[A-Za-z0-9_-]{1,12}$/.test(optionNo)) return vote_err_('E416','選項編號格式無效。','An option number is invalid.');
    const key = optionNo.toUpperCase();
    if (seen[key]) return vote_err_('E416','選項不可重複。','Options must be unique.');
    if (!label) return vote_err_('E422','每個選項都需要文字。','Each option needs text.');
    if (label.length > 240 || labelAlt.length > 240) return vote_err_('E422','選項文字過長。','An option label is too long.');
    seen[key] = true;
    options.push({ optionNo:optionNo, label:label, labelAlt:labelAlt, labelZh:label, labelEn:labelAlt, sortOrder:i + 1 });
  }
  return { ok:true, options:options };
}

function vote_validate_poll_content_(payload){
  const p = payload || {};
  const question = String(p.question !== undefined ? p.question : p.titleZh || p.titleEn || '').trim();
  const questionAlt = String(p.questionAlt !== undefined ? p.questionAlt : (p.titleZh && p.titleEn ? p.titleEn : '') || '').trim();
  if (!question) return vote_err_('E422','請填寫投票問題。','Please enter the poll question.');
  if (question.length > 300 || questionAlt.length > 300) return vote_err_('E422','投票問題過長。','The poll question is too long.');
  const checked = vote_normalize_options_payload_(p.options);
  if (!checked.ok) return checked;
  const answerType = vote_normalize_answer_type_(p.answerType);
  if (!answerType) return vote_err_('E416','回答方式無效。','The answer type is invalid.');
  let maxSelections = Number(p.maxSelections || 0);
  if (answerType === VOTE_ANSWER_SINGLE) maxSelections = 1;
  else if (answerType === VOTE_ANSWER_RANKED) maxSelections = checked.options.length;
  else{
    maxSelections = Math.floor(maxSelections || checked.options.length);
    if (maxSelections < 2 || maxSelections > checked.options.length) return vote_err_('E422','多選上限必須為 2 至選項總數。','The multiple-choice limit must be between 2 and the number of options.');
  }
  return { ok:true, question:question, questionAlt:questionAlt, answerType:answerType, maxSelections:maxSelections, includeChildren:vote_bool_(p.includeChildren), options:checked.options };
}

function vote_hmac_(message,secret){
  const key = String(secret || vote_get_secret_());
  const bytes = Utilities.computeHmacSha256Signature(String(message || ''),key,Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g,'');
}

function vote_options_digest_(pollId,options,secret){
  const canonical = (options || []).map(function(o){ return [String(o.optionNo),String(o.label !== undefined ? o.label : o.labelZh || ''),String(o.labelAlt !== undefined ? o.labelAlt : o.labelEn || ''),Number(o.sortOrder || 0)]; });
  return 'O1.' + vote_hmac_('options|' + vote_poll_id_(pollId) + '|' + JSON.stringify(canonical),secret);
}

function vote_options_integrity_ok_(election,options){
  if (!election || !election.optionDigest || !Array.isArray(options) || options.length < 2) return false;
  try{ return election.optionDigest === vote_options_digest_(election.electionId,options,vote_get_secret_()); }
  catch(e){ return false; }
}

function vote_get_eligibility_records_(){ return vote_get_audit_sheet_() ? vote_audit_data_records_(VOTE_RECORD_ELIGIBILITY) : vote_sheet_records_('Vote_Eligibility'); }

function vote_get_eligibility_flag_(pollId,memberId){
  const poll = vote_poll_id_(pollId), id = String(memberId || '').trim().toUpperCase(), rows = vote_get_eligibility_records_();
  for (let i=rows.length - 1;i>=0;i--){
    if (vote_record_poll_id_(rows[i]) !== poll || String(rows[i].MemberId || '').trim().toUpperCase() !== id) continue;
    return {
      rowNumber:rows[i]._rowNumber, explicitIneligible:vote_bool_(rows[i].ExplicitIneligible),
      reason:String(rows[i].Reason || '').trim(), updatedAt:vote_iso_(rows[i].UpdatedAt), updatedBy:String(rows[i].UpdatedBy || '').trim()
    };
  }
  return { rowNumber:0, explicitIneligible:false, reason:'', updatedAt:'', updatedBy:'' };
}

function vote_evaluate_eligibility_(member,flag,includeChildren){
  const m = member || {}, f = flag || {}, status = vote_norm_status_(m.status);
  if (!status) return { eligible:false, code:'STATUS_MISSING', zh:'會員狀態未設定', en:'Member status is not set.' };
  if (status === 'DISABLED') return { eligible:false, code:'STATUS_DISABLED', zh:'會員帳戶已停用', en:'Member account is disabled.' };
  if (status === 'PROVISIONAL') return { eligible:false, code:'STATUS_PROVISIONAL', zh:'臨時會員不能投票', en:'Provisional members cannot vote.' };
  if (status === 'PENDING') return { eligible:false, code:'STATUS_PENDING', zh:'待確認會員不能投票', en:'Pending members cannot vote.' };
  if (vote_bool_(f.explicitIneligible)) return { eligible:false, code:'EXPLICITLY_INELIGIBLE', zh:'此投票不合資格', en:'Not eligible for this poll.', reason:String(f.reason || '') };
  if (!!m.isMinor && !vote_bool_(includeChildren)) return { eligible:false, code:'CHILDREN_NOT_INCLUDED', zh:'此投票不包括兒童會員', en:'This poll does not include child members.' };
  return { eligible:true, code:'ELIGIBLE', zh:'合資格投票', en:'Eligible to vote.' };
}

function vote_scrutineer_records_(){ return vote_get_audit_sheet_() ? vote_audit_data_records_(VOTE_RECORD_SCRUTINEER) : vote_sheet_records_('Vote_Scrutineers'); }

function vote_is_scrutineer_(pollId,memberId){
  const poll = vote_poll_id_(pollId), id = String(memberId || '').trim().toUpperCase();
  if (!poll || !id) return false;
  return vote_scrutineer_records_().some(function(r){ return vote_record_poll_id_(r) === poll && String(r.MemberId || '').trim().toUpperCase() === id && vote_bool_(r.Active); });
}

function vote_privileges_(member,pollId){
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
    electionId:election.electionId, pollId:election.electionId, question:vote_join_text_(election.question,election.questionAlt),
    answerType:election.answerType, maxSelections:election.maxSelections, includeChildren:!!election.includeChildren,
    opensAt:election.opensAt, closesAt:election.closesAt, state:election.state
  };
}

/* Public, before QR sign-in: current question only. */
function vote_public_config_payload_(){
  const election = vote_get_election_();
  return { question:election ? vote_join_text_(election.question,election.questionAlt) : '', hasCurrentPoll:!!election, voteVersion:VOTE_VERSION };
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
  const election = vote_get_election_(), pollId = election ? election.electionId : '';
  const options = election ? vote_get_options_(pollId) : [];
  const integrityOk = election ? vote_options_integrity_ok_(election,options) : true;
  const flag = pollId ? vote_get_eligibility_flag_(pollId,member.id) : { explicitIneligible:false, reason:'' };
  const privileges = vote_privileges_(member,pollId), initialized = vote_is_system_initialized_();
  const eligibility = vote_evaluate_eligibility_(member,flag,election && election.includeChildren);
  return {
    systemInitialized:initialized, setupRequired:!initialized, hasCurrentPoll:!!election,
    election:vote_client_election_(election), effectiveState:election ? (integrityOk ? vote_effective_state_(election,new Date()) : 'UNAVAILABLE') : 'NO_CURRENT_POLL',
    options:integrityOk ? options : [], optionsIntegrityOk:integrityOk, voteVersion:VOTE_VERSION,
    member:{ id:member.id, nameZh:member.nameZh, nameEn:member.nameEn, preferredName:member.preferredName || '', status:member.status, isMinor:!!member.isMinor },
    canVote:eligibility.eligible,
    ballotStatus:pollId ? vote_existing_ballot_for_member_(pollId,member.id) : { hasVoted:false },
    privileges:vote_client_privileges_(privileges)
  };
}

function api_vote_dashboard(token){
  try{
    const s = vote_require_session_(token);
    if (!s.ok) return s;
    return Object.assign({ ok:true },vote_dashboard_for_member_(s.member));
  }catch(e){ return vote_err_('E500','未能更新投票頁面。','Could not refresh the polling page.',e && e.message); }
}

function vote_voter_code_(pollId,memberId,secret){ return 'V1.' + vote_hmac_('voter|' + vote_poll_id_(pollId) + '|' + String(memberId).toUpperCase(),secret); }
function vote_decision_code_(pollId,memberId,choicesRaw,receiptId,secret){ return 'D1.' + vote_hmac_('decision|' + vote_poll_id_(pollId) + '|' + String(memberId).toUpperCase() + '|' + String(choicesRaw) + '|' + String(receiptId),secret); }

function vote_integrity_mac_(ballot,secret){
  return 'I1.' + vote_hmac_(['ballot',String(ballot.electionId || ''),String(ballot.receiptId || ''),String(ballot.voterCode || ''),String(ballot.optionNo || ''),String(ballot.castAt || ''),String(ballot.decisionCode || '')].join('|'),secret);
}

function vote_parse_choices_(raw){
  const value = String(raw || '').trim();
  if (!value || value === VOTE_ABSTAIN_VALUE) return [];
  if (value.charAt(0) !== '[') return [value];
  try{
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(function(v){ return String(v || '').trim(); }).filter(Boolean) : [];
  }catch(e){ return []; }
}

function vote_ballots_(pollId){
  const poll = vote_poll_id_(pollId), consolidated = !!vote_get_audit_sheet_();
  const rows = consolidated ? vote_audit_data_records_(VOTE_RECORD_BALLOT) : vote_sheet_records_('Vote_Ballots');
  return rows.filter(function(r){ return !poll || vote_record_poll_id_(r) === poll; }).map(function(r){
    const raw = String(consolidated ? r.Choices || '' : r.OptionNo || '').trim();
    return {
      rowNumber:r._rowNumber, electionId:vote_record_poll_id_(r), receiptId:String(r.ReceiptId || '').trim(), voterCode:String(r.VoterCode || '').trim(),
      optionNo:raw, choicesRaw:raw, choices:vote_parse_choices_(raw), abstained:raw === VOTE_ABSTAIN_VALUE,
      castAt:vote_iso_(r.CastAt), decisionCode:String(r.DecisionCode || '').trim(), integrityMac:String(r.IntegrityMac || '').trim()
    };
  });
}

function vote_ballot_count_(pollId){ return vote_ballots_(pollId).length; }
function vote_valid_ballot_(ballot,secret){ return String(ballot.integrityMac || '') === vote_integrity_mac_(ballot,secret); }

function vote_existing_ballot_for_member_(pollId,memberId){
  try{
    const secret = vote_get_secret_(), voterCode = vote_voter_code_(pollId,memberId,secret);
    const ballot = vote_ballots_(pollId).filter(function(b){ return b.voterCode === voterCode; })[0];
    return ballot ? { hasVoted:true, receiptId:ballot.receiptId, castAt:ballot.castAt } : { hasVoted:false };
  }catch(e){ return { hasVoted:false }; }
}

function vote_audit_records_(){ return vote_get_audit_sheet_() ? vote_audit_data_records_(VOTE_RECORD_AUDIT) : vote_sheet_records_('Vote_Audit'); }

function vote_prior_cast_audit_(pollId,voterCode){
  const poll = vote_poll_id_(pollId), rows = vote_audit_records_();
  for (let i=rows.length - 1;i>=0;i--){
    if (vote_record_poll_id_(rows[i]) !== poll || String(rows[i].Action || '').trim() !== 'BALLOT_CAST' || String(rows[i].ActorId || '').trim() !== String(voterCode || '')) continue;
    return { receiptId:String(rows[i].Target || '').trim(), timestamp:vote_iso_(rows[i].CreatedAt || rows[i].Timestamp) };
  }
  return null;
}

function vote_audit_(actor,pollId,action,target,reason,details){
  try{
    vote_append_audit_record_({
      RecordType:VOTE_RECORD_AUDIT, PollId:vote_poll_id_(pollId), RecordId:vote_new_record_id_('AUDIT'),
      ActorId:String((actor && actor.id) || ''), ActorRole:String((actor && actor.role) || ''), Action:String(action || ''),
      Target:String(target || ''), Reason:String(reason || ''), Details:String(details || ''), CreatedAt:new Date()
    });
    return true;
  }catch(e){ return false; }
}

function api_vote_admin_initialize(token){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    const migration = vote_migrate_legacy_sheets_(), props = PropertiesService.getScriptProperties();
    if (!String(props.getProperty(VOTE_SECRET_PROPERTY) || '').trim()){
      if (vote_ballot_count_('') > 0){
        vote_audit_({ id:s.member.id, role:s.role },'','SECRET_MISSING_BLOCK','','','Refused replacement secret because ballots exist.');
        return vote_err_('E_VOTE_SECRET_MISSING','內部核查密匙遺失；已有選票時系統不會自動重設。請由系統負責人恢復原密匙。','The internal audit secret is missing and will not be regenerated while ballots exist.');
      }
      props.setProperty(VOTE_SECRET_PROPERTY,[Utilities.getUuid(),Utilities.getUuid(),Utilities.getUuid(),Utilities.getUuid()].join(''));
    }
    vote_audit_({ id:s.member.id, role:s.role },'','POLL_SYSTEM_INITIALISE','','',JSON.stringify(migration));
    return Object.assign({ ok:true, migration:migration },vote_dashboard_for_member_(s.member));
  }catch(e){ return vote_err_('E500','未能初始化投票系統。','Could not initialise the polling system.',e && e.message); }
}

function api_vote_admin_create_poll(token,payload){
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
      content.options.forEach(function(o){
        vote_append_record_({
          RecordType:VOTE_RECORD_OPTION, PollId:pollId, RecordId:vote_new_record_id_('OPTION'), OptionNo:o.optionNo,
          OptionText:o.label, OptionTextAlt:o.labelAlt, SortOrder:o.sortOrder, Active:'YES', CreatedAt:new Date(), CreatedBy:s.member.id
        });
      });
      const digest = vote_options_digest_(pollId,content.options,secret);
      vote_append_record_({
        RecordType:VOTE_RECORD_POLL, PollId:pollId, RecordId:pollId, Question:content.question, QuestionAlt:content.questionAlt,
        AnswerType:content.answerType, MaxSelections:content.maxSelections, IncludeChildren:content.includeChildren ? 'YES' : 'NO', State:'DRAFT', OptionDigest:digest,
        CreatedAt:new Date(), CreatedBy:s.member.id, UpdatedAt:new Date(), UpdatedBy:s.member.id
      });
      const current = vote_get_election_(), currentState = vote_effective_state_(current,new Date());
      if (!current || (currentState !== 'OPEN' && currentState !== 'SCHEDULED')){ vote_set_current_poll_id_(pollId); madeCurrent = true; }
    }finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },pollId,'POLL_CREATE',pollId,'',JSON.stringify({ optionCount:content.options.length, answerType:content.answerType, includeChildren:content.includeChildren, madeCurrent:madeCurrent }));
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
      electionId:e.electionId, question:vote_join_text_(e.question,e.questionAlt), answerType:e.answerType, maxSelections:e.maxSelections,
      state:e.state, effectiveState:vote_effective_state_(e,new Date()), opensAt:e.opensAt, closesAt:e.closesAt, createdAt:e.createdAt,
      ballotCount:vote_ballot_count_(e.electionId), optionCount:vote_get_options_(e.electionId).length, isCurrent:e.electionId === currentId
    };
  }).sort(function(a,b){ return String(b.createdAt || b.electionId).localeCompare(String(a.createdAt || a.electionId)); });
}

function api_vote_admin_polls(token){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{ return { ok:true, rows:vote_poll_list_payload_(), currentPollId:vote_current_poll_id_() }; }
  catch(e){ return vote_err_('E500','未能載入投票列表。','Could not load the poll list.',e && e.message); }
}

function vote_count_scrutineers_(pollId){
  const poll = vote_poll_id_(pollId);
  return vote_scrutineer_records_().filter(function(r){ return vote_record_poll_id_(r) === poll && vote_bool_(r.Active); }).length;
}

function api_vote_admin_poll_detail(token,pollId){
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

function api_vote_admin_set_current_poll(token,pollId){
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

function api_vote_admin_save_poll_content(token,pollId,payload){
  try{
    const s = vote_require_role_(token,['ADMIN']);
    if (!s.ok) return s;
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    if (election.state !== 'DRAFT' || vote_ballot_count_(election.electionId) > 0) return vote_err_('E_VOTE_LOCKED','只有未有選票的草稿可以修改問題及選項。','Only a draft with no ballots may change its question or options.');
    const content = vote_validate_poll_content_(payload);
    if (!content.ok) return content;
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      vote_data_records_(VOTE_RECORD_OPTION).forEach(function(r){ if (vote_record_poll_id_(r) === election.electionId) vote_update_record_(r._rowNumber,{ Active:'NO', UpdatedAt:new Date(), UpdatedBy:s.member.id }); });
      content.options.forEach(function(o){
        vote_append_record_({
          RecordType:VOTE_RECORD_OPTION, PollId:election.electionId, RecordId:vote_new_record_id_('OPTION'), OptionNo:o.optionNo,
          OptionText:o.label, OptionTextAlt:o.labelAlt, SortOrder:o.sortOrder, Active:'YES', CreatedAt:new Date(), CreatedBy:s.member.id
        });
      });
      vote_update_record_(election.rowNumber,{
        Question:content.question, QuestionAlt:content.questionAlt, AnswerType:content.answerType, MaxSelections:content.maxSelections,
        IncludeChildren:content.includeChildren ? 'YES' : 'NO', OptionDigest:vote_options_digest_(election.electionId,content.options,vote_get_secret_()), UpdatedAt:new Date(), UpdatedBy:s.member.id
      });
    }finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },election.electionId,'POLL_CONTENT_UPDATE',election.electionId,'',JSON.stringify({ optionCount:content.options.length, answerType:content.answerType, includeChildren:content.includeChildren }));
    return api_vote_admin_poll_detail(token,election.electionId);
  }catch(e){ return vote_err_('E500','未能更新投票內容。','Could not update poll content.',e && e.message); }
}

function api_vote_admin_save_election(token,pollId,payload){
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
    const oldSummary = JSON.stringify({ state:election.state, opensAt:election.opensAt, closesAt:election.closesAt });
    vote_update_record_(election.rowNumber,{ OpensAt:opensAt ? new Date(opensAt) : '', ClosesAt:closesAt ? new Date(closesAt) : '', State:state, UpdatedAt:new Date(), UpdatedBy:s.member.id });
    if (state === 'OPEN') vote_set_current_poll_id_(election.electionId);
    const warning = state === 'OPEN' && vote_count_scrutineers_(election.electionId) < 2 ? { code:'FEWER_THAN_TWO_SCRUTINEERS', zh:'目前少於兩名監票員；建議正式投票前至少指定兩名。', en:'Fewer than two scrutineers are appointed; at least two are recommended.' } : null;
    vote_audit_({ id:s.member.id, role:s.role },election.electionId,'POLL_SETTINGS_UPDATE',election.electionId,'',oldSummary + ' -> ' + JSON.stringify({ state:state, opensAt:opensAt, closesAt:closesAt }));
    const detail = api_vote_admin_poll_detail(token,election.electionId);
    detail.warning = warning;
    return detail;
  }catch(e){ return vote_err_('E500','未能儲存投票設定。','Could not save poll settings.',e && e.message); }
}

function vote_upsert_eligibility_(pollId,memberId,explicitIneligible,reason,actorId){
  const current = vote_get_eligibility_flag_(pollId,memberId), fields = {
    PollId:vote_poll_id_(pollId), MemberId:String(memberId || '').trim().toUpperCase(),
    ExplicitIneligible:explicitIneligible ? 'YES' : 'NO', Reason:String(reason || ''), UpdatedAt:new Date(), UpdatedBy:actorId
  };
  if (current.rowNumber) vote_update_audit_record_(current.rowNumber,fields);
  else vote_append_audit_record_(Object.assign({ RecordType:VOTE_RECORD_ELIGIBILITY, RecordId:vote_new_record_id_('ELIGIBILITY') },fields));
}

function vote_staff_poll_scope_(s,pollId){
  const election = vote_get_election_(pollId);
  if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
  if (s.role === 'STAFF' && election.electionId !== vote_current_poll_id_()) return vote_err_('E403','STAFF 只可管理目前投票的資格。','STAFF may manage eligibility only for the current poll.');
  return { ok:true, election:election };
}

function api_vote_staff_set_eligibility(token,pollId,memberId,childEligible,explicitIneligible,reason){
  const s = vote_require_role_(token,['STAFF','ADMIN']);
  if (!s.ok) return s;
  try{
    const scope = vote_staff_poll_scope_(s,pollId);
    if (!scope.ok) return scope;
    const id = String(memberId || '').trim().toUpperCase(), target = vote_get_member_(id);
    if (!target) return vote_err_('E412','找不到此會員。','Member not found.');
    const excluded = vote_bool_(explicitIneligible), why = String(reason || '').trim();
    if (excluded && why.length < 3) return vote_err_('E422','加入不合資格名單時，請填寫原因。','Please give a reason when excluding someone.');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{ vote_upsert_eligibility_(scope.election.electionId,id,excluded,excluded ? why : '',s.member.id); }
    finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },scope.election.electionId,'EXCLUSION_UPDATE',id,excluded ? why : '',JSON.stringify({ explicitIneligible:excluded }));
    const flag = vote_get_eligibility_flag_(scope.election.electionId,id);
    return { ok:true, member:target, flags:flag, eligibility:vote_evaluate_eligibility_(target,flag,scope.election.includeChildren) };
  }catch(e){ return vote_err_('E500','未能更新投票資格。','Could not update voting eligibility.',e && e.message); }
}

function api_vote_staff_roster(token,pollId,query){
  const s = vote_require_role_(token,['STAFF','ADMIN']);
  if (!s.ok) return s;
  try{
    const scope = vote_staff_poll_scope_(s,pollId);
    if (!scope.ok) return scope;
    const poll = scope.election.electionId, q = String(query || '').trim().toLowerCase(), flagged = {};
    vote_get_eligibility_records_().forEach(function(r){ if (vote_record_poll_id_(r) === poll && vote_bool_(r.ExplicitIneligible)) flagged[String(r.MemberId || '').trim().toUpperCase()] = true; });
    let members = vote_all_members_().filter(function(m){
      if (!q) return !!flagged[m.id];
      return [m.id,m.nameZh,m.nameEn,m.preferredName].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    const totalMatches = members.length;
    members = members.slice(0,100).map(function(m){ const flag = vote_get_eligibility_flag_(poll,m.id); return { member:m, flags:flag, eligibility:vote_evaluate_eligibility_(m,flag,scope.election.includeChildren) }; });
    return { ok:true, rows:members, truncated:totalMatches > 100 };
  }catch(e){ return vote_err_('E500','未能載入會員投票資格。','Could not load voting eligibility.',e && e.message); }
}

function api_vote_admin_scrutineers(token,pollId){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const rows = vote_scrutineer_records_().filter(function(r){ return vote_record_poll_id_(r) === election.electionId && vote_bool_(r.Active); }).map(function(r){
      const m = vote_get_member_(r.MemberId);
      return { memberId:String(r.MemberId || '').trim().toUpperCase(), nameZh:m ? m.nameZh : '', nameEn:m ? m.nameEn : '', addedAt:vote_iso_(r.CreatedAt || r.AddedAt), addedBy:String(r.CreatedBy || r.AddedBy || '') };
    });
    return { ok:true, rows:rows, pollId:election.electionId };
  }catch(e){ return vote_err_('E500','未能載入監票員名單。','Could not load the scrutineer list.',e && e.message); }
}

function api_vote_admin_scrutineer_update(token,pollId,memberId,active){
  const s = vote_require_role_(token,['ADMIN']);
  if (!s.ok) return s;
  try{
    const election = vote_get_election_(pollId);
    if (!election) return vote_err_('E412','找不到此投票。','Poll not found.');
    const id = String(memberId || '').trim().toUpperCase(), target = vote_get_member_(id);
    if (!target) return vote_err_('E412','找不到此會員。','Member not found.');
    const targetEligibility = vote_evaluate_eligibility_(target,{ explicitIneligible:false },true);
    if (['STATUS_MISSING','STATUS_DISABLED','STATUS_PROVISIONAL','STATUS_PENDING'].indexOf(targetEligibility.code) >= 0) return vote_err_('E403','此會員狀態不能獲委任為監票員。','This member status cannot be appointed as a scrutineer.');
    const enabled = vote_bool_(active), lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      const matches = vote_scrutineer_records_().filter(function(r){ return vote_record_poll_id_(r) === election.electionId && String(r.MemberId || '').trim().toUpperCase() === id; });
      if (!matches.length){
        if (enabled) vote_append_audit_record_({ RecordType:VOTE_RECORD_SCRUTINEER, PollId:election.electionId, RecordId:vote_new_record_id_('SCRUTINEER'), MemberId:id, Active:'YES', CreatedAt:new Date(), CreatedBy:s.member.id, UpdatedAt:new Date(), UpdatedBy:s.member.id });
      }else{
        const primary = matches[matches.length - 1];
        matches.forEach(function(current){ vote_update_audit_record_(current._rowNumber,{ Active:enabled && current._rowNumber === primary._rowNumber ? 'YES' : 'NO', UpdatedAt:new Date(), UpdatedBy:s.member.id }); });
      }
    }finally{ lock.releaseLock(); }
    vote_audit_({ id:s.member.id, role:s.role },election.electionId,enabled ? 'SCRUTINEER_ADD' : 'SCRUTINEER_REMOVE',id,'','Explicit appointment updated.');
    return api_vote_admin_scrutineers(token,election.electionId);
  }catch(e){ return vote_err_('E500','未能更新監票員名單。','Could not update the scrutineer list.',e && e.message); }
}

function vote_normalize_cast_(election,options,selections,abstain){
  if (vote_bool_(abstain)) return { ok:true, choices:[], choicesRaw:VOTE_ABSTAIN_VALUE, abstained:true };
  const rawList = Array.isArray(selections) ? selections : [selections], seen = {}, choices = [];
  rawList.forEach(function(value){
    const choice = String(value || '').trim();
    if (choice && !seen[choice]){ seen[choice] = true; choices.push(choice); }
  });
  const valid = {};
  options.forEach(function(o){ valid[o.optionNo] = true; });
  if (!choices.length || choices.some(function(choice){ return !valid[choice]; })) return vote_err_('E416','請選擇有效選項，或按棄權。','Choose valid option(s), or press Abstain.');
  const type = election.answerType || VOTE_ANSWER_SINGLE;
  if (type === VOTE_ANSWER_SINGLE && choices.length !== 1) return vote_err_('E422','此投票只可選一項。','This poll allows one choice.');
  if (type === VOTE_ANSWER_MULTIPLE && choices.length > Number(election.maxSelections || options.length)) return vote_err_('E422','所選項目超過此投票的上限。','Too many options were selected.');
  if (type === VOTE_ANSWER_RANKED && choices.length > options.length) return vote_err_('E422','排名項目過多。','Too many ranked options.');
  return { ok:true, choices:choices, choicesRaw:JSON.stringify(choices), abstained:false };
}

function api_vote_cast(token,pollId,selections,abstain){
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
    const flag = vote_get_eligibility_flag_(poll,s.member.id), eligibility = vote_evaluate_eligibility_(s.member,flag,election.includeChildren);
    if (!eligibility.eligible) return vote_err_('E_VOTE_NOT_AVAILABLE','此投票不適用於此帳戶。','This poll is not available for this account.');
    const normalized = vote_normalize_cast_(election,options,selections,abstain);
    if (!normalized.ok) return normalized;
    const secret = vote_get_secret_(), voterCode = vote_voter_code_(poll,s.member.id,secret), lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      const existing = vote_ballots_(poll).filter(function(b){ return b.voterCode === voterCode; })[0];
      if (existing) return { ok:true, result:'ALREADY_VOTED', receiptId:existing.receiptId, castAt:existing.castAt };
      const priorAudit = vote_prior_cast_audit_(poll,voterCode);
      if (priorAudit) return vote_err_('E_VOTE_INTEGRITY','系統找到先前投票記錄，但選票資料不完整；為防止重複投票，請聯絡管理員。','A prior cast record exists but its ballot is incomplete. Contact an admin for review.',priorAudit.receiptId || priorAudit.timestamp);
      const receiptId = 'R-' + Utilities.getUuid().replace(/-/g,'').slice(0,20).toUpperCase(), castAt = new Date().toISOString();
      const decisionCode = vote_decision_code_(poll,s.member.id,normalized.choicesRaw,receiptId,secret);
      const ballot = { electionId:poll, receiptId:receiptId, voterCode:voterCode, optionNo:normalized.choicesRaw, castAt:castAt, decisionCode:decisionCode };
      ballot.integrityMac = vote_integrity_mac_(ballot,secret);
      vote_append_audit_record_({ RecordType:VOTE_RECORD_BALLOT, PollId:poll, RecordId:vote_new_record_id_('BALLOT'), ReceiptId:receiptId, VoterCode:voterCode, Choices:normalized.choicesRaw, Abstained:normalized.abstained ? 'YES' : 'NO', CastAt:new Date(castAt), DecisionCode:decisionCode, IntegrityMac:ballot.integrityMac });
      vote_audit_({ id:voterCode, role:'VOTER_CODE' },poll,'BALLOT_CAST',receiptId,'','Ballot recorded; response omitted from log.');
      return { ok:true, result:'CAST', receiptId:receiptId, castAt:castAt };
    }finally{ lock.releaseLock(); }
  }catch(e){ return vote_err_('E500','未能提交選票。','Could not submit the ballot.',e && e.message); }
}

function vote_require_results_viewer_(token,pollId,requireTrace){
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

function vote_validate_recorded_choices_(election,options,ballot){
  if (ballot.abstained) return { ok:true, abstained:true, choices:[] };
  const valid = {}, choices = ballot.choices || [];
  options.forEach(function(o){ valid[o.optionNo] = true; });
  if (!choices.length || choices.some(function(c){ return !valid[c]; }) || new Set(choices).size !== choices.length) return { ok:false };
  if (election.answerType === VOTE_ANSWER_SINGLE && choices.length !== 1) return { ok:false };
  if (election.answerType === VOTE_ANSWER_MULTIPLE && choices.length > Number(election.maxSelections || options.length)) return { ok:false };
  if (election.answerType === VOTE_ANSWER_RANKED && choices.length > options.length) return { ok:false };
  return { ok:true, abstained:false, choices:choices };
}

function api_vote_results(token,pollId){
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
    let invalid = 0, totalBallots = 0, abstentions = 0;
    vote_ballots_(election.electionId).forEach(function(b){
      if (!vote_valid_ballot_(b,secret)){ invalid++; return; }
      const checked = vote_validate_recorded_choices_(election,options,b);
      if (!checked.ok){ invalid++; return; }
      totalBallots++;
      if (checked.abstained){ abstentions++; return; }
      if (election.answerType !== VOTE_ANSWER_RANKED) checked.choices.forEach(function(choice){ counts[choice]++; });
    });
    const rankedRecordOnly = election.answerType === VOTE_ANSWER_RANKED;
    const rows = rankedRecordOnly ? [] : options.map(function(o){ return { optionNo:o.optionNo, label:o.label, labelAlt:o.labelAlt, labelZh:o.label, labelEn:o.labelAlt, votes:counts[o.optionNo] || 0 }; });
    vote_audit_({ id:s.member.id, role:vote_norm_status_(s.member.status) },election.electionId,'RESULTS_VIEW',election.electionId,'',JSON.stringify({ effectiveState:effectiveState, privileged:privileges.canViewEarlyResults }));
    return { ok:true, election:vote_client_election_(election), effectiveState:effectiveState, rows:rows, totalBallots:totalBallots, abstentions:abstentions, rankedRecordOnly:rankedRecordOnly, integrityExceptions:privileges.canTrace ? invalid : undefined };
  }catch(e){ return vote_err_('E500','未能載入投票結果。','Could not load results.',e && e.message); }
}

function api_vote_exception_polls(token){
  const s = vote_require_session_(token);
  if (!s.ok) return s;
  try{
    const rows = vote_all_elections_().filter(function(e){ return vote_privileges_(s.member,e.electionId).canTrace; }).map(function(e){
      return { electionId:e.electionId, question:vote_join_text_(e.question,e.questionAlt), effectiveState:vote_effective_state_(e,new Date()), opensAt:e.opensAt, closesAt:e.closesAt };
    }).sort(function(a,b){ return String(b.closesAt || b.opensAt || b.electionId).localeCompare(String(a.closesAt || a.opensAt || a.electionId)); });
    if (!rows.length) return vote_err_('E403','沒有權限執行此操作。','You do not have permission for this action.');
    return { ok:true, rows:rows };
  }catch(e){ return vote_err_('E500','未能載入正式核查頁面。','Could not load the formal review page.',e && e.message); }
}

function api_vote_trace(token,pollId,receiptOrDecisionCode,reason){
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
    const options = vote_get_options_(poll), checked = vote_validate_recorded_choices_(s.election,options,ballot);
    if (!checked.ok) return vote_err_('E_VOTE_INTEGRITY','選票內容完整性檢查失敗。','Ballot content integrity check failed.');
    const members = vote_all_members_();
    let member = null;
    for (let i=0;i<members.length;i++){ if (vote_voter_code_(poll,members[i].id,secret) === ballot.voterCode){ member = members[i]; break; } }
    if (!member) return vote_err_('E_VOTE_TRACE','未能配對會員；會員資料可能已被移除。','Could not match the member; its record may have been removed.');
    const optionMap = {};
    options.forEach(function(o){ optionMap[o.optionNo] = o; });
    const choices = checked.choices.map(function(choice){ return optionMap[choice] || { optionNo:choice, label:'', labelAlt:'', labelZh:'', labelEn:'' }; });
    const auditRecorded = vote_audit_({ id:s.member.id, role:vote_norm_status_(s.member.status) },poll,'BALLOT_TRACE',ballot.receiptId,why,JSON.stringify({ memberId:member.id, decisionCode:ballot.decisionCode }));
    if (!auditRecorded) return vote_err_('E_VOTE_AUDIT','未能寫入核查審計記錄，因此沒有顯示會員資料。請稍後重試。','The review audit could not be written, so member details were not disclosed. Please retry later.');
    return {
      ok:true, ballot:{ receiptId:ballot.receiptId, castAt:ballot.castAt },
      member:{ id:member.id, nameZh:member.nameZh, nameEn:member.nameEn, preferredName:member.preferredName, status:member.status },
      choices:choices, choice:choices[0] || null, abstained:checked.abstained, auditRecorded:true
    };
  }catch(e){ return vote_err_('E500','未能完成選票核查。','Could not complete the ballot review.',e && e.message); }
}

/* ===== END OF Vote.gs (COMPLETE) ===== */
