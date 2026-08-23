import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name,root),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function utilities(){
  let uuidCounter = 0;
  return {
    Charset:{ UTF_8:'UTF-8' },
    getUuid(){ uuidCounter += 1; return `${String(uuidCounter).padStart(8,'0')}-0000-4000-8000-${String(uuidCounter).padStart(12,'0')}`; },
    computeHmacSha256Signature(value,key){ return [...crypto.createHmac('sha256',key).update(value).digest()]; },
    base64EncodeWebSafe(bytes){ return Buffer.from(bytes).toString('base64url'); }
  };
}

function voteContext(extra = {}){
  const cacheData = new Map(), propertyData = new Map();
  const context = vm.createContext({
    console, Date, JSON, Math, Set, Map, Array, String, Number, Object, RegExp, Error,
    Promise, URL, encodeURIComponent, decodeURIComponent, isNaN, parseInt,
    Utilities:utilities(),
    CacheService:{ getScriptCache(){ return {
      get(key){ return cacheData.get(key) || null; },
      put(key,value){ cacheData.set(key,value); },
      remove(key){ cacheData.delete(key); }
    }; } },
    LockService:{ getScriptLock(){ return { waitLock(){}, releaseLock(){} }; } },
    PropertiesService:{ getScriptProperties(){ return {
      getProperty(key){ return propertyData.get(key) || ''; },
      setProperty(key,value){ propertyData.set(key,String(value)); }
    }; } },
    SpreadsheetApp:{ openById(){ throw new Error('unexpected spreadsheet access'); } },
    HtmlService:{},
    ...extra
  });
  vm.runInContext(read('Vote.gs'),context,{ filename:'Vote.gs' });
  context.__propertyData = propertyData;
  return context;
}

test('vote route and mobile page use only external scanner or automatic QR image upload', () => {
  const code = read('Code.gs'), html = read('Vote.html');
  assert.ok(code.includes("if (mode === 'vote') return doGetVote_(e)"));
  assert.ok(code.includes("if (mode === 'vote-review') return doGetVoteReview_(e)"));
  assert.ok(html.includes('External scanner'));
  assert.ok(html.includes('Upload QR image'));
  assert.ok(html.includes("$('qrFile').onchange"));
  assert.ok(html.includes('CCF_QR_RESULT'));
  assert.ok(html.includes("event.origin!==EXTERNAL_SCANNER_ORIGIN"));
  assert.ok(html.includes("event.source!==pendingExternalScanner_.popup"));
  assert.ok(!html.includes('E415'));
  assert.ok(!html.includes('getUserMedia'));
  assert.ok(!html.includes('<video'));
  assert.ok(!html.includes('BarcodeDetector'));
});

test('poll portal JavaScript parses after Apps Script template substitution', () => {
  ['Vote.html','VoteReview.html'].forEach(file => {
    const html = read(file).replace(/<\?!=[\s\S]*?\?>/g,"''").replace(/<\?=[\s\S]*?\?>/g,'test-version');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.equal(scripts.length,1);
    assert.doesNotThrow(() => new vm.Script(scripts[0],{ filename:`${file}.inline.js` }));
  });
});

test('normal poll portal contains no restricted-review wording or control', () => {
  const html = read('Vote.html'), lower = html.toLowerCase();
  [
    'voting intention','投票意向','decisioncode','decision code','encoded','編碼','traceable','trace','追查','追溯',
    'confidential','保密','anonymous','匿名','auditable','audit','審計','exception','例外','formal review','核查','api_vote_trace'
  ].forEach(term => assert.equal(lower.includes(term),false,`normal portal contains: ${term}`));
  assert.ok(read('VoteReview.html').includes("call_('api_vote_trace',State.token,pollId,receipt,reason)"));
  assert.ok(!html.includes('VoteReview'));
});

test('portal is generic and follows the simple reusable poll design', () => {
  const html = read('Vote.html'), lower = html.toLowerCase();
  assert.equal(lower.includes('church'),false);
  assert.equal(html.includes('教會名稱'),false);
  assert.equal(html.includes('NAME_POLL_TEMPLATE'),false);
  assert.ok(html.includes('目前投票 / Current poll'));
  assert.ok(html.includes('管理投票 / Manage polls'));
  assert.ok(html.includes('投票 / Cast vote'));
  assert.ok(html.includes('id="btnManagerCreate"'));
  assert.ok(html.includes('id="pollQuestion"'));
  assert.ok(html.includes('id="pollMultiple"'));
  assert.ok(html.includes('id="pollRanked"'));
  assert.ok(html.includes('id="pollChildren"'));
  assert.ok(html.includes('棄權 / Abstain'));
  assert.ok(html.includes("answerType:ranked?'RANKED':(multi?'MULTIPLE':'SINGLE')"));
  assert.equal(html.includes('Existing poll data will be consolidated'),false);
  assert.equal(html.includes('eligibilityHtml_'),false);
  assert.equal(html.includes('childTick'),false);
  assert.equal(html.includes('id="btnEligibility"'),false);
});

test('Vote holds poll setup while Vote Audit holds running records', () => {
  const context = voteContext();
  assert.equal(vm.runInContext('VOTE_SHEET',context),'Vote');
  assert.equal(vm.runInContext('VOTE_AUDIT_SHEET',context),'Vote Audit');
  assert.deepEqual(plain(vm.runInContext('VOTE_LEGACY_SHEETS',context)),[
    'Vote_Elections','Vote_Options','Vote_Eligibility','Vote_Ballots','Vote_Scrutineers','Vote_Audit'
  ]);
  const headers = plain(vm.runInContext('VOTE_HEADERS',context));
  ['RecordType','PollId','Question','AnswerType','MaxSelections','IncludeChildren','FinalResult','ResultNotes'].forEach(header => assert.ok(headers.includes(header)));
  ['MemberId','Choices','Abstained','Action'].forEach(header => assert.equal(headers.includes(header),false));
  const auditHeaders = plain(vm.runInContext('VOTE_AUDIT_HEADERS',context));
  ['RecordType','PollId','MemberId','Choices','Abstained','Action'].forEach(header => assert.ok(auditHeaders.includes(header)));
  ['Question','OptionText','FinalResult'].forEach(header => assert.equal(auditHeaders.includes(header),false));
  const mapped = context.vote_legacy_record_fields_('Vote_Elections',{ _rowNumber:2, ElectionId:'POLL_OLD', TitleZh:'問題', TitleEn:'Question', State:'OPEN' });
  assert.equal(mapped.RecordType,'POLL');
  assert.equal(mapped.PollId,'POLL_OLD');
  assert.equal(mapped.AnswerType,'SINGLE');
  assert.equal(mapped.IncludeChildren,'NO');
  assert.equal(mapped.LegacySource,'Vote_Elections#2');
});

class FakeRange{
  constructor(sheet,row,col,numRows = 1,numCols = 1){ Object.assign(this,{ sheet,row,col,numRows,numCols }); }
  getValues(){
    return Array.from({ length:this.numRows },(_,r) => Array.from({ length:this.numCols },(_,c) => this.sheet.values[this.row - 1 + r]?.[this.col - 1 + c] ?? ''));
  }
  setValues(rows){ rows.forEach((values,r) => values.forEach((value,c) => this.setCell(this.row + r,this.col + c,value))); return this; }
  setValue(value){ this.setCell(this.row,this.col,value); return this; }
  setCell(row,col,value){ while(this.sheet.values.length < row)this.sheet.values.push([]); while(this.sheet.values[row - 1].length < col)this.sheet.values[row - 1].push(''); this.sheet.values[row - 1][col - 1] = value; }
  setFontWeight(){ return this; }
  setBackground(){ return this; }
}

class FakeSheet{
  constructor(name,values = []){ this.name = name; this.values = values.map(row => [...row]); }
  getLastRow(){ return this.values.length; }
  getLastColumn(){ return this.values.reduce((max,row) => Math.max(max,row.length),0); }
  getRange(row,col,numRows,numCols){ return new FakeRange(this,row,col,numRows,numCols); }
  appendRow(row){ this.values.push([...row]); }
  deleteRow(row){ this.values.splice(row - 1,1); }
  deleteColumn(col){ this.values.forEach(row => row.splice(col - 1,1)); }
  setFrozenRows(){}
}

class FakeSpreadsheet{
  constructor(sheets){ this.sheets = new Map(sheets.map(sheet => [sheet.name,sheet])); this.deleted = []; }
  getSheetByName(name){ return this.sheets.get(name) || null; }
  insertSheet(name){ const sheet = new FakeSheet(name); this.sheets.set(name,sheet); return sheet; }
  deleteSheet(sheet){ this.deleted.push(sheet.name); this.sheets.delete(sheet.name); }
}

test('legacy migration creates Vote and Vote Audit, verifies rows, then removes the six legacy tabs', () => {
  const legacy = [
    new FakeSheet('Vote_Elections',[[ 'ElectionId','TitleZh','TitleEn','State' ],[ 'POLL_OLD','舊問題','Old question','CLOSED' ]]),
    new FakeSheet('Vote_Options',[[ 'ElectionId','OptionNo','LabelZh','LabelEn','SortOrder','Active' ],[ 'POLL_OLD','1','甲','A',1,'YES' ]]),
    new FakeSheet('Vote_Eligibility',[[ 'ElectionId','MemberId','ChildEligible','ExplicitIneligible' ],[ 'POLL_OLD','CCF0002','YES','NO' ]]),
    new FakeSheet('Vote_Ballots',[[ 'ElectionId','ReceiptId','VoterCode','OptionNo','CastAt','DecisionCode','IntegrityMac' ],[ 'POLL_OLD','R-1','V1.X','1','2030-01-01','D1.X','I1.X' ]]),
    new FakeSheet('Vote_Scrutineers',[[ 'ElectionId','MemberId','Active' ],[ 'POLL_OLD','CCF0003','YES' ]]),
    new FakeSheet('Vote_Audit',[[ 'Timestamp','ElectionId','ActorId','ActorRole','Action' ],[ '2030-01-01','POLL_OLD','CCF0001','ADMIN','POLL_CREATE' ]])
  ];
  const ss = new FakeSpreadsheet(legacy), context = voteContext();
  context.vote_open_ss_ = () => ss;
  const result = context.vote_migrate_legacy_sheets_();
  assert.equal(result.migrated,6);
  assert.equal(result.removedSheets,6);
  assert.deepEqual(new Set(ss.deleted),new Set(legacy.map(sheet => sheet.name)));
  assert.deepEqual([...ss.sheets.keys()],['Vote','Vote Audit']);
  assert.equal(context.vote_data_records_('').length,2);
  assert.equal(context.vote_audit_data_records_('').length,4);
});

test('the previous unified Vote layout is safely split without losing ballots', () => {
  const oldHeaders = [
    'RecordType','PollId','RecordId','MemberId','Question','QuestionAlt','OptionNo','OptionText','OptionTextAlt','SortOrder',
    'AnswerType','MaxSelections','State','OpensAt','ClosesAt','Active','OptionDigest','ChildEligible','ExplicitIneligible','Reason',
    'ReceiptId','VoterCode','Choices','Abstained','CastAt','DecisionCode','IntegrityMac','ActorId','ActorRole','Action','Target','Details',
    'CreatedAt','CreatedBy','UpdatedAt','UpdatedBy','LegacySource'
  ];
  const row = fields => oldHeaders.map(header => fields[header] ?? '');
  const vote = new FakeSheet('Vote',[
    oldHeaders,
    row({ RecordType:'POLL', PollId:'POLL_OLD', RecordId:'POLL_OLD', Question:'Question', AnswerType:'SINGLE', MaxSelections:1, State:'CLOSED' }),
    row({ RecordType:'OPTION', PollId:'POLL_OLD', RecordId:'OPT_1', OptionNo:'1', OptionText:'A', SortOrder:1, Active:'YES' }),
    row({ RecordType:'BALLOT', PollId:'POLL_OLD', RecordId:'BALLOT_1', ReceiptId:'R-1', VoterCode:'V1.X', Choices:'["1"]', CastAt:'2030-01-01', DecisionCode:'D1.X', IntegrityMac:'I1.X' }),
    row({ RecordType:'AUDIT', PollId:'POLL_OLD', RecordId:'AUDIT_1', ActorId:'V1.X', ActorRole:'VOTER_CODE', Action:'BALLOT_CAST', Target:'R-1' })
  ]);
  const ss = new FakeSpreadsheet([vote]), context = voteContext();
  context.vote_open_ss_ = () => ss;
  const result = context.vote_migrate_legacy_sheets_();
  assert.equal(result.migrated,2);
  assert.equal(result.splitRows,2);
  assert.equal(result.removedSheets,0);
  assert.deepEqual([...ss.sheets.keys()],['Vote','Vote Audit']);
  assert.deepEqual(context.vote_data_records_('').map(record => record.RecordType),['POLL','OPTION']);
  assert.deepEqual(context.vote_audit_data_records_('').map(record => record.RecordType),['BALLOT','AUDIT']);
  assert.equal(context.vote_ballots_('POLL_OLD')[0].receiptId,'R-1');
  const voteHeaders = vote.values[0].filter(Boolean);
  ['IncludeChildren','FinalResult','ResultNotes'].forEach(header => assert.ok(voteHeaders.includes(header)));
  ['MemberId','VoterCode','Choices','Action'].forEach(header => assert.equal(voteHeaders.includes(header),false));
});

test('eligibility blocks excluded statuses, explicit exclusions, and children when the poll-wide box is off', () => {
  const context = voteContext();
  const check = (status,isMinor = false,flag = {},includeChildren = false) => context.vote_evaluate_eligibility_({ status,isMinor },flag,includeChildren);
  assert.equal(check('DISABLED').code,'STATUS_DISABLED');
  assert.equal(check('PROVISIONAL').code,'STATUS_PROVISIONAL');
  assert.equal(check('PENDING').code,'STATUS_PENDING');
  assert.equal(check('').code,'STATUS_MISSING');
  assert.equal(check('ACTIVE',false,{ explicitIneligible:true }).code,'EXPLICITLY_INELIGIBLE');
  assert.equal(check('ACTIVE',true,{},false).code,'CHILDREN_NOT_INCLUDED');
  assert.equal(check('ACTIVE',true,{},true).eligible,true);
  assert.equal(check('STAFF').eligible,true);
  assert.equal(check('DEACON').eligible,true);
  assert.equal(check('ADMIN').eligible,true);
});

test('poll timing differentiates draft, scheduled, open, and closed windows', () => {
  const context = voteContext();
  const election = { state:'OPEN', opensAt:'2030-01-02T00:00:00.000Z', closesAt:'2030-01-03T00:00:00.000Z' };
  assert.equal(context.vote_effective_state_({ state:'DRAFT' },new Date('2030-01-01T00:00:00.000Z')),'DRAFT');
  assert.equal(context.vote_effective_state_(election,new Date('2030-01-01T00:00:00.000Z')),'SCHEDULED');
  assert.equal(context.vote_effective_state_(election,new Date('2030-01-02T12:00:00.000Z')),'OPEN');
  assert.equal(context.vote_effective_state_(election,new Date('2030-01-03T00:00:00.000Z')),'CLOSED');
  assert.equal(context.vote_effective_state_({ state:'CLOSED' },new Date('2020-01-01T00:00:00.000Z')),'CLOSED');
});

test('poll validation supports single, multiple, and stored-order response modes', () => {
  const context = voteContext(), options = [{ label:'A' },{ label:'B' },{ label:'C' }];
  assert.equal(context.vote_validate_poll_content_({ question:'Question', answerType:'SINGLE', options:[{ label:'A' }] }).code,'E422');
  assert.equal(context.vote_validate_poll_content_({ question:'', answerType:'SINGLE', options }).code,'E422');
  assert.equal(context.vote_validate_poll_content_({ question:'Question', answerType:'MULTIPLE', maxSelections:1, options }).code,'E422');
  const single = context.vote_validate_poll_content_({ question:'Question', answerType:'SINGLE', includeChildren:false, options });
  const multiple = context.vote_validate_poll_content_({ question:'Question', answerType:'MULTIPLE', maxSelections:2, includeChildren:true, options });
  const ranked = context.vote_validate_poll_content_({ question:'Question', answerType:'RANKED', options });
  assert.equal(single.ok,true);
  assert.equal(single.maxSelections,1);
  assert.equal(multiple.ok,true);
  assert.equal(multiple.maxSelections,2);
  assert.equal(single.includeChildren,false);
  assert.equal(multiple.includeChildren,true);
  assert.equal(ranked.ok,true);
  assert.equal(ranked.maxSelections,3);
  assert.deepEqual(plain(ranked.options.map(option => option.optionNo)),['1','2','3']);
});

test('poll-scoped HMACs and option digests expose no member ID and detect option changes', () => {
  const context = voteContext(), secret = 'test-only-secret';
  const one = context.vote_voter_code_('POLL_A','CCF0123',secret);
  const same = context.vote_voter_code_('POLL_A','CCF0123',secret);
  const otherPoll = context.vote_voter_code_('POLL_B','CCF0123',secret);
  const internalDecision = context.vote_decision_code_('POLL_A','CCF0123','["Y"]','R-TEST',secret);
  assert.equal(one,same);
  assert.notEqual(one,otherPoll);
  assert.ok(one.startsWith('V1.'));
  assert.ok(internalDecision.startsWith('D1.'));
  assert.ok(!`${one}${internalDecision}`.includes('CCF0123'));
  const options = [{ optionNo:'Y', label:'Yes', labelAlt:'是', sortOrder:1 },{ optionNo:'N', label:'No', labelAlt:'否', sortOrder:2 }];
  const digest = context.vote_options_digest_('POLL_A',options,secret);
  context.vote_get_secret_ = () => secret;
  assert.equal(context.vote_options_integrity_ok_({ electionId:'POLL_A', optionDigest:digest },options),true);
  assert.equal(context.vote_options_integrity_ok_({ electionId:'POLL_A', optionDigest:digest },[{ ...options[0], label:'Changed' },options[1]]),false);
  assert.notEqual(digest,context.vote_options_digest_('POLL_B',options,secret));
});

test('ADMIN creates reusable polls without displacing an active current poll', () => {
  const context = voteContext(), polls = new Map(), optionRows = [], audit = [];
  let currentId = '';
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_is_system_initialized_ = () => true;
  context.vote_get_secret_ = () => 'test-only-secret';
  context.vote_append_record_ = fields => {
    if(fields.RecordType === 'POLL')polls.set(fields.PollId,{
      rowNumber:polls.size + 2, electionId:fields.PollId, pollId:fields.PollId, question:fields.Question, questionAlt:fields.QuestionAlt,
      answerType:fields.AnswerType, maxSelections:fields.MaxSelections, includeChildren:fields.IncludeChildren === 'YES', state:fields.State, optionDigest:fields.OptionDigest,
      opensAt:'', closesAt:'', createdAt:fields.CreatedAt.toISOString(), createdBy:fields.CreatedBy
    });
    if(fields.RecordType === 'OPTION')optionRows.push({ optionNo:fields.OptionNo, label:fields.OptionText, labelAlt:fields.OptionTextAlt, labelZh:fields.OptionText, labelEn:fields.OptionTextAlt, sortOrder:fields.SortOrder, pollId:fields.PollId });
  };
  context.vote_get_election_ = pollId => polls.get(String(pollId || currentId)) || null;
  context.vote_get_options_ = pollId => optionRows.filter(row => row.pollId === pollId);
  context.vote_set_current_poll_id_ = pollId => { currentId = pollId; };
  context.vote_audit_ = (actor,pollId,action,target,reason,details) => { audit.push({ actor,pollId,action,target,reason,details }); return true; };

  const first = context.api_vote_admin_create_poll('admin',{ question:'First poll', answerType:'MULTIPLE', maxSelections:2, includeChildren:true, options:[{ label:'A' },{ label:'B' },{ label:'C' }] });
  assert.equal(first.ok,true);
  assert.equal(first.madeCurrent,true);
  assert.equal(first.poll.answerType,'MULTIPLE');
  assert.equal(first.poll.includeChildren,true);
  assert.equal(first.options.length,3);
  assert.equal(currentId,first.poll.electionId);
  assert.ok(first.poll.optionDigest.startsWith('O1.'));

  polls.get(first.poll.electionId).state = 'OPEN';
  polls.get(first.poll.electionId).closesAt = '2099-01-01T00:00:00.000Z';
  const second = context.api_vote_admin_create_poll('admin',{ question:'Next poll', answerType:'RANKED', options:[{ label:'One' },{ label:'Two' }] });
  assert.equal(second.ok,true);
  assert.equal(second.madeCurrent,false);
  assert.equal(second.warning.code,'CURRENT_POLL_ACTIVE');
  assert.equal(currentId,first.poll.electionId);
  assert.equal(polls.size,2);
  assert.deepEqual(audit.map(row => row.action),['POLL_CREATE','POLL_CREATE']);
});

test('an open or scheduled current poll cannot be replaced from the manager', () => {
  const context = voteContext();
  let oldState = 'OPEN', selected = '';
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_current_poll_id_ = () => 'POLL_OLD';
  context.vote_get_election_ = pollId => pollId === 'POLL_NEW' ? { electionId:'POLL_NEW', state:'DRAFT' } : { electionId:'POLL_OLD', state:oldState, closesAt:'2099-01-01T00:00:00.000Z' };
  context.vote_get_options_ = () => [{ optionNo:'1' },{ optionNo:'2' }];
  context.vote_set_current_poll_id_ = pollId => { selected = pollId; };
  context.vote_audit_ = () => true;
  context.vote_dashboard_for_member_ = () => ({ hasCurrentPoll:true });
  let result = context.api_vote_admin_set_current_poll('token','POLL_NEW');
  assert.equal(result.code,'E_VOTE_CURRENT_ACTIVE');
  assert.equal(selected,'');
  oldState = 'CLOSED';
  result = context.api_vote_admin_set_current_poll('token','POLL_NEW');
  assert.equal(result.ok,true);
  assert.equal(selected,'POLL_NEW');
});

function castFixture(member = { id:'CCF0123', status:'ACTIVE', isMinor:false }){
  const context = voteContext(), ballots = [], audit = [];
  let currentPollId = 'POLL_TEST_A', electionState = 'OPEN', answerType = 'SINGLE', maxSelections = 1, includeChildren = true;
  const options = [{ optionNo:'1', label:'A', labelAlt:'甲', labelZh:'A', labelEn:'甲', sortOrder:1 },{ optionNo:'3', label:'B', labelAlt:'乙', labelZh:'B', labelEn:'乙', sortOrder:2 },{ optionNo:'5', label:'C', labelAlt:'丙', labelZh:'C', labelEn:'丙', sortOrder:3 }];
  context.vote_require_session_ = () => ({ ok:true, member });
  context.vote_current_poll_id_ = () => currentPollId;
  context.vote_get_election_ = pollId => ({
    electionId:String(pollId || currentPollId), question:'Test poll', state:electionState, answerType, maxSelections,
    includeChildren,
    opensAt:'', closesAt:electionState === 'OPEN' ? '2099-01-01T00:00:00.000Z' : '2020-01-01T00:00:00.000Z'
  });
  context.vote_get_eligibility_flag_ = () => ({ explicitIneligible:false });
  context.vote_get_options_ = () => options;
  context.vote_options_integrity_ok_ = () => true;
  context.vote_get_secret_ = () => 'test-only-secret';
  context.vote_ballots_ = pollId => ballots.filter(ballot => !pollId || ballot.electionId === pollId);
  context.vote_prior_cast_audit_ = () => null;
  context.vote_audit_ = (actor,pollId,action,target,reason,details) => { audit.push({ actor,pollId,action,target,reason,details }); return true; };
  context.vote_append_audit_record_ = fields => {
    if(fields.RecordType !== 'BALLOT')return;
    ballots.push({
      electionId:fields.PollId, receiptId:fields.ReceiptId, voterCode:fields.VoterCode,
      optionNo:String(fields.Choices), choicesRaw:String(fields.Choices), choices:context.vote_parse_choices_(fields.Choices),
      abstained:String(fields.Choices) === '__ABSTAIN__', castAt:fields.CastAt.toISOString(), decisionCode:fields.DecisionCode, integrityMac:fields.IntegrityMac
    });
  };
  return {
    context,ballots,audit,options,
    setCurrentPoll(pollId){ currentPollId = pollId; },
    setElectionState(state){ electionState = state; },
    setAnswerType(type,max){ answerType = type; maxSelections = max; },
    setIncludeChildren(value){ includeChildren = value; }
  };
}

test('the one poll-wide child setting controls every child ballot', () => {
  const fixture = castFixture({ id:'CCF0200', status:'ACTIVE', isMinor:true });
  fixture.setIncludeChildren(false);
  let result = fixture.context.api_vote_cast('session','POLL_TEST_A',['1'],false);
  assert.equal(result.code,'E_VOTE_NOT_AVAILABLE');
  assert.equal(fixture.ballots.length,0);
  fixture.setIncludeChildren(true);
  result = fixture.context.api_vote_cast('session','POLL_TEST_A',['1'],false);
  assert.equal(result.ok,true);
  assert.equal(fixture.ballots.length,1);
});

test('one member submits once per poll and may participate in the next poll', () => {
  const fixture = castFixture(), { context,ballots,audit } = fixture;
  const first = context.api_vote_cast('session','POLL_TEST_A',['1'],false);
  const second = context.api_vote_cast('session','POLL_TEST_A',['3'],false);
  assert.equal(first.ok,true);
  assert.equal(first.result,'CAST');
  assert.equal(second.result,'ALREADY_VOTED');
  assert.equal(second.receiptId,first.receiptId);
  assert.equal(Object.hasOwn(first,'decisionCode'),false);
  assert.equal(ballots.length,1);
  assert.deepEqual(ballots[0].choices,['1']);
  assert.equal(context.vote_valid_ballot_(ballots[0],'test-only-secret'),true);
  assert.ok(!JSON.stringify(ballots[0]).includes('CCF0123'));
  assert.equal(audit[0].action,'BALLOT_CAST');
  assert.equal(audit[0].actor.role,'VOTER_CODE');
  assert.ok(!JSON.stringify(audit[0]).includes('choices'));
  const status = context.vote_existing_ballot_for_member_('POLL_TEST_A','CCF0123');
  assert.equal(status.hasVoted,true);
  fixture.setCurrentPoll('POLL_TEST_B');
  const nextPoll = context.api_vote_cast('session','POLL_TEST_B',['3'],false);
  assert.equal(nextPoll.ok,true);
  assert.equal(ballots.length,2);
  assert.notEqual(ballots[0].voterCode,ballots[1].voterCode);
});

test('multiple, ordered, and abstention submissions store the intended canonical record', () => {
  let fixture = castFixture();
  fixture.setAnswerType('MULTIPLE',2);
  let result = fixture.context.api_vote_cast('session','POLL_TEST_A',['1','3'],false);
  assert.equal(result.ok,true);
  assert.equal(fixture.ballots[0].choicesRaw,'["1","3"]');

  fixture = castFixture();
  fixture.setAnswerType('MULTIPLE',2);
  result = fixture.context.api_vote_cast('session','POLL_TEST_A',['1','3','5'],false);
  assert.equal(result.code,'E422');
  assert.equal(fixture.ballots.length,0);

  fixture = castFixture();
  fixture.setAnswerType('RANKED',3);
  result = fixture.context.api_vote_cast('session','POLL_TEST_A',['5','1','3'],false);
  assert.equal(result.ok,true);
  assert.deepEqual(fixture.ballots[0].choices,['5','1','3']);

  fixture = castFixture();
  result = fixture.context.api_vote_cast('session','POLL_TEST_A',[],true);
  assert.equal(result.ok,true);
  assert.equal(fixture.ballots[0].choicesRaw,'__ABSTAIN__');
  assert.equal(fixture.ballots[0].abstained,true);
});

test('a surviving cast log blocks a second submission when its ballot row is missing', () => {
  const { context,ballots } = castFixture();
  context.vote_prior_cast_audit_ = () => ({ receiptId:'R-ORIGINAL', timestamp:'2030-01-01T00:00:00.000Z' });
  const result = context.api_vote_cast('session','POLL_TEST_A',['1'],false);
  assert.equal(result.code,'E_VOTE_INTEGRITY');
  assert.equal(ballots.length,0);
});

test('live totals are limited to ADMIN or appointed scrutineers and multiple totals count ballots correctly', () => {
  const fixture = castFixture(), { context,audit } = fixture;
  fixture.setAnswerType('MULTIPLE',2);
  const cast = context.api_vote_cast('session','POLL_TEST_A',['1','3'],false);
  assert.equal(cast.ok,true);
  let currentMember = { id:'CCF0999', status:'ACTIVE', isMinor:false }, appointed = false;
  context.vote_require_session_ = () => ({ ok:true, member:currentMember });
  context.vote_is_scrutineer_ = () => appointed;
  let result = context.api_vote_results('ordinary','POLL_TEST_A');
  assert.equal(result.code,'E403');
  appointed = true;
  result = context.api_vote_results('scrutineer','POLL_TEST_A');
  assert.equal(result.ok,true);
  assert.equal(result.totalBallots,1);
  assert.equal(result.abstentions,0);
  assert.equal(result.rows.find(row => row.optionNo === '1').votes,1);
  assert.equal(result.rows.find(row => row.optionNo === '3').votes,1);
  assert.equal(Object.hasOwn(result,'ballotRegister'),false);
  assert.equal(Object.hasOwn(result,'decisionCode'),false);

  appointed = false;
  fixture.setElectionState('CLOSED');
  result = context.api_vote_results('ordinary','POLL_TEST_A');
  assert.equal(result.ok,true);
  assert.equal(result.integrityExceptions,undefined);
  assert.equal(audit.at(-1).action,'RESULTS_VIEW');
});

test('ordered responses are record-only until a counting method is chosen', () => {
  const fixture = castFixture(), { context } = fixture;
  fixture.setAnswerType('RANKED',3);
  assert.equal(context.api_vote_cast('session','POLL_TEST_A',['3','1','5'],false).ok,true);
  context.vote_require_session_ = () => ({ ok:true, member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_is_scrutineer_ = () => false;
  const result = context.api_vote_results('admin','POLL_TEST_A');
  assert.equal(result.ok,true);
  assert.equal(result.totalBallots,1);
  assert.equal(result.rankedRecordOnly,true);
  assert.deepEqual(plain(result.rows),[]);
});

test('abstention is a valid ballot and is reported separately', () => {
  const fixture = castFixture(), { context } = fixture;
  assert.equal(context.api_vote_cast('session','POLL_TEST_A',[],true).ok,true);
  context.vote_require_session_ = () => ({ ok:true, member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_is_scrutineer_ = () => false;
  const result = context.api_vote_results('admin','POLL_TEST_A');
  assert.equal(result.ok,true);
  assert.equal(result.totalBallots,1);
  assert.equal(result.abstentions,1);
  assert.equal(result.rows.reduce((sum,row) => sum + row.votes,0),0);
});

test('restricted review fails closed and returns ordered choices only after its log succeeds', () => {
  const fixture = castFixture(), { context,audit } = fixture;
  fixture.setAnswerType('RANKED',3);
  const cast = context.api_vote_cast('session','POLL_TEST_A',['3','1'],false);
  let currentMember = { id:'CCF0001', status:'ADMIN', isMinor:false };
  context.vote_require_session_ = () => ({ ok:true, member:currentMember });
  context.vote_is_scrutineer_ = () => false;
  context.vote_all_members_ = () => [{ id:'CCF0123', nameZh:'投票者', nameEn:'Voter', status:'ACTIVE', isMinor:false },currentMember];
  assert.equal(context.api_vote_trace('admin','POLL_TEST_A',cast.receiptId,'short').code,'E422');
  const record = context.vote_audit_;
  context.vote_audit_ = () => false;
  const failed = context.api_vote_trace('admin','POLL_TEST_A',cast.receiptId,'Formal recount check');
  assert.equal(failed.code,'E_VOTE_AUDIT');
  assert.equal(Object.hasOwn(failed,'member'),false);
  context.vote_audit_ = record;
  const reviewed = context.api_vote_trace('admin','POLL_TEST_A',cast.receiptId,'Formal recount check');
  assert.equal(reviewed.ok,true);
  assert.equal(reviewed.member.id,'CCF0123');
  assert.deepEqual(plain(reviewed.choices.map(choice => choice.optionNo)),['3','1']);
  assert.equal(reviewed.abstained,false);
  assert.equal(audit.at(-1).action,'BALLOT_TRACE');
});

test('the unlinked review route lists polls only for ADMIN or an appointed scrutineer', () => {
  const context = voteContext();
  const polls = [
    { electionId:'POLL_A', question:'A', state:'CLOSED', opensAt:'', closesAt:'2030-01-01T00:00:00.000Z' },
    { electionId:'POLL_B', question:'B', state:'DRAFT', opensAt:'', closesAt:'' }
  ];
  let member = { id:'CCF0099', status:'ACTIVE' };
  context.vote_require_session_ = () => ({ ok:true, member });
  context.vote_all_elections_ = () => polls;
  context.vote_is_scrutineer_ = pollId => member.id === 'CCF0099' && pollId === 'POLL_A';
  let result = context.api_vote_exception_polls('token');
  assert.equal(result.ok,true);
  assert.deepEqual(plain(result.rows.map(row => row.electionId)),['POLL_A']);
  member = { id:'CCF0088', status:'ACTIVE' };
  assert.equal(context.api_vote_exception_polls('token').code,'E403');
  member = { id:'CCF0001', status:'ADMIN' };
  result = context.api_vote_exception_polls('token');
  assert.equal(result.ok,true);
  assert.deepEqual(new Set(result.rows.map(row => row.electionId)),new Set(['POLL_A','POLL_B']));
});

test('pre-login payload contains the current question but no poll choices, result, ID, state, or dates', () => {
  const context = voteContext();
  context.vote_get_election_ = () => ({ electionId:'POLL_PRIVATE', question:'Should we proceed?', questionAlt:'是否繼續？', state:'OPEN', opensAt:'2030-01-01', closesAt:'2030-02-01' });
  const payload = context.vote_public_config_payload_();
  assert.equal(payload.question,'Should we proceed? / 是否繼續？');
  assert.equal(payload.hasCurrentPoll,true);
  ['election','options','effectiveState','pollId','opensAt','closesAt','state','results'].forEach(key => assert.equal(Object.hasOwn(payload,key),false,key));
});

test('authenticated dashboard has ballot data but omits restricted permission and ballot internals', () => {
  const context = voteContext();
  context.vote_get_election_ = () => ({ electionId:'POLL_A', question:'Question', questionAlt:'', answerType:'SINGLE', maxSelections:1, includeChildren:false, state:'OPEN', opensAt:'', closesAt:'2099-01-01', optionDigest:'digest' });
  context.vote_get_options_ = () => [{ optionNo:'1', label:'A', labelAlt:'', sortOrder:1 },{ optionNo:'2', label:'B', labelAlt:'', sortOrder:2 }];
  context.vote_options_integrity_ok_ = () => true;
  context.vote_get_eligibility_flag_ = () => ({ explicitIneligible:false });
  context.vote_existing_ballot_for_member_ = () => ({ hasVoted:false });
  context.vote_is_system_initialized_ = () => true;
  context.vote_is_scrutineer_ = () => false;
  const dashboard = context.vote_dashboard_for_member_({ id:'CCF0123', nameZh:'會員', status:'ACTIVE', isMinor:false });
  assert.equal(dashboard.election.question,'Question');
  assert.equal(dashboard.options.length,2);
  assert.equal(dashboard.canVote,true);
  assert.equal(Object.hasOwn(dashboard,'eligibility'),false);
  assert.equal(Object.hasOwn(dashboard,'eligibilityFlags'),false);
  assert.equal(Object.hasOwn(dashboard.privileges,'canTrace'),false);
  assert.equal(Object.hasOwn(dashboard,'decisionCode'),false);
  assert.equal(Object.hasOwn(dashboard,'ballotRegister'),false);
});

test('STAFF manages the not-eligible list while DEACON and ADMIN manage polls', () => {
  const context = voteContext();
  context.vote_is_scrutineer_ = () => false;
  const staff = context.vote_privileges_({ id:'CCF1', status:'STAFF' },'POLL_A');
  const deacon = context.vote_privileges_({ id:'CCF2', status:'DEACON' },'POLL_A');
  const admin = context.vote_privileges_({ id:'CCF3', status:'ADMIN' },'POLL_A');
  assert.equal(staff.canManageEligibility,true);
  assert.equal(staff.canManageElection,false);
  assert.equal(deacon.canManageElection,true);
  assert.equal(admin.canManageElection,true);
  context.vote_require_session_ = () => ({ ok:true, member:{ id:'CCF2', status:'DEACON' } });
  assert.equal(context.vote_require_role_('token',['ADMIN']).ok,true);
});

test('draft content locks after opening and closed polls cannot be reopened', () => {
  const context = voteContext();
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_get_election_ = () => ({ electionId:'POLL_A', state:'OPEN', closesAt:'2099-01-01T00:00:00.000Z' });
  context.vote_ballot_count_ = () => 0;
  let result = context.api_vote_admin_save_poll_content('token','POLL_A',{ question:'Changed', answerType:'SINGLE', options:[{ label:'A' },{ label:'B' }] });
  assert.equal(result.code,'E_VOTE_LOCKED');
  context.vote_get_election_ = () => ({ electionId:'POLL_A', state:'CLOSED', closesAt:'2020-01-01T00:00:00.000Z' });
  result = context.api_vote_admin_save_election('token','POLL_A',{ state:'OPEN', closesAt:'2099-01-01T00:00:00.000Z' });
  assert.equal(result.code,'E_VOTE_FINAL');
});

test('initialisation never replaces a missing private secret after ballots exist', () => {
  const context = voteContext();
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_migrate_legacy_sheets_ = () => ({ migrated:7, removedSheets:6 });
  context.vote_ballot_count_ = () => 1;
  context.vote_audit_ = () => true;
  const result = context.api_vote_admin_initialize('token');
  assert.equal(result.code,'E_VOTE_SECRET_MISSING');
  assert.equal(context.__propertyData.get('CCF_VOTE_TRACE_SECRET'),undefined);
});
