import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function utilities(){
  let uuidCounter = 0;
  return {
    Charset:{ UTF_8:'UTF-8' },
    getUuid(){
      uuidCounter += 1;
      return `${String(uuidCounter).padStart(8,'0')}-0000-4000-8000-${String(uuidCounter).padStart(12,'0')}`;
    },
    computeHmacSha256Signature(value, key){ return [...crypto.createHmac('sha256', key).update(value).digest()]; },
    base64EncodeWebSafe(bytes){ return Buffer.from(bytes).toString('base64url'); }
  };
}

function voteContext(extra = {}){
  const cacheData = new Map();
  const propertyData = new Map();
  const context = vm.createContext({
    console, Date, JSON, Math, Set, Map, Array, String, Number, Object, RegExp, Error,
    Promise, URL, encodeURIComponent, decodeURIComponent, isNaN, parseInt,
    Utilities:utilities(),
    CacheService:{ getScriptCache(){ return {
      get(key){ return cacheData.get(key) || null; },
      put(key, value){ cacheData.set(key, value); },
      remove(key){ cacheData.delete(key); }
    }; } },
    LockService:{ getScriptLock(){ return { waitLock(){}, releaseLock(){} }; } },
    PropertiesService:{ getScriptProperties(){ return {
      getProperty(key){ return propertyData.get(key) || ''; },
      setProperty(key, value){ propertyData.set(key, String(value)); }
    }; } },
    SpreadsheetApp:{ openById(){ throw new Error('unexpected spreadsheet access'); } },
    HtmlService:{},
    ...extra
  });
  vm.runInContext(read('Vote.gs'), context, { filename:'Vote.gs' });
  return context;
}

test('vote route and mobile page use only external scanner or QR image upload', () => {
  const code = read('Code.gs');
  const html = read('Vote.html');
  assert.ok(code.includes("if (mode === 'vote') return doGetVote_(e)"));
  assert.ok(code.includes("if (mode === 'vote-review') return doGetVoteReview_(e)"));
  assert.ok(html.includes('External scanner'));
  assert.ok(html.includes('Upload QR image'));
  assert.ok(html.includes('CCF_QR_RESULT'));
  assert.ok(html.includes("event.origin!==EXTERNAL_SCANNER_ORIGIN"));
  assert.ok(html.includes("event.source!==pendingExternalScanner_.popup"));
  assert.ok(!html.includes('getUserMedia'));
  assert.ok(!html.includes('<video'));
  assert.ok(!html.includes('BarcodeDetector'));
});

test('polling portal JavaScript parses after Apps Script template substitution', () => {
  ['Vote.html','VoteReview.html'].forEach(file => {
    const html = read(file)
      .replace(/<\?!=[\s\S]*?\?>/g, "''")
      .replace(/<\?=[\s\S]*?\?>/g, 'test-version');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new vm.Script(scripts[0], { filename:`${file}.inline.js` }));
  });
});

test('normal polling portal contains no exceptional-review wording or control', () => {
  const html = read('Vote.html');
  const normalPortal = html.toLowerCase();
  [
    'voting intention', '投票意向', 'decisioncode', 'decision code', 'encoded', '編碼',
    'traceable', 'trace', '追查', '追溯', 'confidential', '保密', 'anonymous', '匿名',
    'auditable', 'audit', '審計', 'exception', '例外', 'formal review', '核查', 'api_vote_trace'
  ].forEach(term => assert.equal(normalPortal.includes(term), false, `normal portal contains: ${term}`));
  const restricted = read('VoteReview.html');
  assert.ok(restricted.includes("call_('api_vote_trace',State.token,pollId,receipt,reason)"));
  assert.ok(!html.includes('VoteReview'));
});

test('church-name choices are an optional ADMIN template, not a fixed backend ballot', () => {
  const html = read('Vote.html');
  const match = html.match(/var NAME_POLL_TEMPLATE=(\[[\s\S]*?\]);\s*\n\s*function \$/);
  assert.ok(match, 'name-poll template literal is present');
  const options = vm.runInNewContext(`(${match[1]})`);
  assert.deepEqual(plain(options.map(option => option.optionNo)), ['1','3','4','5','6','9','12','17','18','20','21','25','26']);
  assert.equal(options.length, 13);
  assert.ok(html.includes('Create new poll'));
  assert.ok(html.includes('Poll manager'));
  assert.ok(html.includes('Load church-name choices'));
  assert.ok(!read('Vote.gs').includes('VOTE_SEED_OPTIONS'));
});

test('eligibility blocks excluded statuses, explicit exclusions, and unticked children', () => {
  const context = voteContext();
  const check = (status, isMinor = false, flag = {}) => context.vote_evaluate_eligibility_({ status, isMinor }, flag);
  assert.equal(check('DISABLED').code, 'STATUS_DISABLED');
  assert.equal(check('PROVISIONAL').code, 'STATUS_PROVISIONAL');
  assert.equal(check('PENDING').code, 'STATUS_PENDING');
  assert.equal(check('').code, 'STATUS_MISSING');
  assert.equal(check('ACTIVE', false, { explicitIneligible:true }).code, 'EXPLICITLY_INELIGIBLE');
  assert.equal(check('ACTIVE', true, { childEligible:false }).code, 'CHILD_APPROVAL_REQUIRED');
  assert.equal(check('ACTIVE', true, { childEligible:true }).eligible, true);
  assert.equal(check('STAFF').eligible, true);
  assert.equal(check('ADMIN').eligible, true);
});

test('poll timing differentiates draft, scheduled, open, and irreversibly closed windows', () => {
  const context = voteContext();
  const election = { state:'OPEN', opensAt:'2030-01-02T00:00:00.000Z', closesAt:'2030-01-03T00:00:00.000Z' };
  assert.equal(context.vote_effective_state_({ state:'DRAFT' }, new Date('2030-01-01T00:00:00.000Z')), 'DRAFT');
  assert.equal(context.vote_effective_state_(election, new Date('2030-01-01T00:00:00.000Z')), 'SCHEDULED');
  assert.equal(context.vote_effective_state_(election, new Date('2030-01-02T12:00:00.000Z')), 'OPEN');
  assert.equal(context.vote_effective_state_(election, new Date('2030-01-03T00:00:00.000Z')), 'CLOSED');
  assert.equal(context.vote_effective_state_({ state:'CLOSED' }, new Date('2020-01-01T00:00:00.000Z')), 'CLOSED');
});

test('dynamic poll validation enforces one-choice polls with 2–50 unique options', () => {
  const context = voteContext();
  assert.equal(context.vote_validate_poll_content_({ titleEn:'Question', options:[{ optionNo:'1', labelEn:'A' }] }).code, 'E422');
  assert.equal(context.vote_validate_poll_content_({ titleEn:'Question', options:[{ optionNo:'1', labelEn:'A' },{ optionNo:'1', labelEn:'B' }] }).code, 'E416');
  assert.equal(context.vote_validate_poll_content_({ titleEn:'', titleZh:'', options:[{ optionNo:'1', labelEn:'A' },{ optionNo:'2', labelEn:'B' }] }).code, 'E422');
  const valid = context.vote_validate_poll_content_({ titleEn:'Question', options:[{ optionNo:'Y', labelEn:'Yes' },{ optionNo:'N', labelEn:'No' }] });
  assert.equal(valid.ok, true);
  assert.deepEqual(plain(valid.options.map(option => option.optionNo)), ['Y','N']);
});

test('poll-scoped HMACs and option digests expose no member ID and detect option changes', () => {
  const context = voteContext();
  const secret = 'test-only-secret';
  const one = context.vote_voter_code_('POLL_A', 'CCF0123', secret);
  const same = context.vote_voter_code_('POLL_A', 'CCF0123', secret);
  const otherPoll = context.vote_voter_code_('POLL_B', 'CCF0123', secret);
  const internalDecision = context.vote_decision_code_('POLL_A', 'CCF0123', 'Y', 'R-TEST', secret);
  assert.equal(one, same);
  assert.notEqual(one, otherPoll);
  assert.ok(one.startsWith('V1.'));
  assert.ok(internalDecision.startsWith('D1.'));
  assert.ok(!`${one}${internalDecision}`.includes('CCF0123'));

  const options = [{ optionNo:'Y', labelZh:'是', labelEn:'Yes', sortOrder:1 },{ optionNo:'N', labelZh:'否', labelEn:'No', sortOrder:2 }];
  const digest = context.vote_options_digest_('POLL_A', options, secret);
  context.vote_get_secret_ = () => secret;
  assert.equal(context.vote_options_integrity_ok_({ electionId:'POLL_A', optionDigest:digest }, options), true);
  assert.equal(context.vote_options_integrity_ok_({ electionId:'POLL_A', optionDigest:digest }, [{ ...options[0], labelEn:'Changed' },options[1]]), false);
  assert.notEqual(digest, context.vote_options_digest_('POLL_B', options, secret));
});

test('ADMIN can create successive reusable polls and an active current poll is not displaced', () => {
  const context = voteContext();
  const electionRows = [];
  const optionRows = [];
  const audit = [];
  let currentId = '';
  const fromElectionRow = row => ({
    rowNumber:electionRows.indexOf(row) + 2, electionId:row[0], titleZh:row[1], titleEn:row[2],
    opensAt:'', closesAt:'', state:row[5], optionDigest:row[6], createdAt:row[7].toISOString(), createdBy:row[8]
  });
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_is_system_initialized_ = () => true;
  context.vote_get_secret_ = () => 'test-only-secret';
  context.vote_get_sheet_ = name => ({ appendRow(row){
    if (name === 'Vote_Elections') electionRows.push(row);
    else if (name === 'Vote_Options') optionRows.push(row);
    else throw new Error(`unexpected sheet ${name}`);
  } });
  context.vote_get_election_ = pollId => {
    const id = String(pollId || currentId);
    const row = electionRows.find(candidate => candidate[0] === id);
    return row ? fromElectionRow(row) : null;
  };
  context.vote_get_options_ = pollId => optionRows
    .filter(row => row[0] === pollId && row[5] === 'YES')
    .map(row => ({ optionNo:row[1], labelZh:row[2], labelEn:row[3], sortOrder:row[4] }));
  context.vote_set_current_poll_id_ = pollId => { currentId = pollId; };
  context.vote_audit_ = (actor, pollId, action, target, reason, details) => { audit.push({ actor,pollId,action,target,reason,details }); return true; };

  const first = context.api_vote_admin_create_poll('admin', {
    titleZh:'第一個投票', titleEn:'First poll',
    options:[{ optionNo:'Y', labelZh:'是', labelEn:'Yes' },{ optionNo:'N', labelZh:'否', labelEn:'No' }]
  });
  assert.equal(first.ok, true);
  assert.equal(first.madeCurrent, true);
  assert.equal(first.poll.state, 'DRAFT');
  assert.equal(first.options.length, 2);
  assert.equal(currentId, first.poll.electionId);
  assert.ok(first.poll.optionDigest.startsWith('O1.'));

  electionRows[0][5] = 'OPEN';
  electionRows[0][4] = new Date('2099-01-01T00:00:00.000Z');
  const second = context.api_vote_admin_create_poll('admin', {
    titleZh:'下一個投票', titleEn:'Next poll',
    options:[{ optionNo:'1', labelZh:'甲' },{ optionNo:'2', labelZh:'乙' },{ optionNo:'3', labelZh:'丙' }]
  });
  assert.equal(second.ok, true);
  assert.equal(second.madeCurrent, false);
  assert.equal(second.warning.code, 'CURRENT_POLL_ACTIVE');
  assert.notEqual(second.poll.electionId, first.poll.electionId);
  assert.equal(currentId, first.poll.electionId);
  assert.equal(electionRows.length, 2);
  assert.equal(optionRows.length, 5);
  assert.deepEqual(audit.map(row => row.action), ['POLL_CREATE','POLL_CREATE']);
});

test('an open or scheduled current poll cannot be replaced from the ADMIN manager', () => {
  const context = voteContext();
  let oldState = 'OPEN';
  let selected = '';
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_current_poll_id_ = () => 'POLL_OLD';
  context.vote_get_election_ = pollId => pollId === 'POLL_NEW'
    ? { electionId:'POLL_NEW', state:'DRAFT' }
    : { electionId:'POLL_OLD', state:oldState, closesAt:'2099-01-01T00:00:00.000Z' };
  context.vote_get_options_ = () => [{ optionNo:'1' },{ optionNo:'2' }];
  context.vote_set_current_poll_id_ = pollId => { selected = pollId; };
  context.vote_audit_ = () => true;
  context.vote_dashboard_for_member_ = () => ({ hasCurrentPoll:true });

  let result = context.api_vote_admin_set_current_poll('token','POLL_NEW');
  assert.equal(result.code, 'E_VOTE_CURRENT_ACTIVE');
  assert.equal(selected, '');
  oldState = 'CLOSED';
  result = context.api_vote_admin_set_current_poll('token','POLL_NEW');
  assert.equal(result.ok, true);
  assert.equal(selected, 'POLL_NEW');
});

function castFixture(member = { id:'CCF0123', status:'ACTIVE', isMinor:false }){
  const context = voteContext();
  const ballots = [];
  const audit = [];
  let currentPollId = 'POLL_TEST_A';
  let electionState = 'OPEN';
  context.vote_require_session_ = () => ({ ok:true, member });
  context.vote_current_poll_id_ = () => currentPollId;
  context.vote_get_election_ = pollId => ({
    electionId:String(pollId || currentPollId), titleZh:'測試投票', titleEn:'Test poll', state:electionState,
    opensAt:'', closesAt:electionState === 'OPEN' ? '2099-01-01T00:00:00.000Z' : '2020-01-01T00:00:00.000Z'
  });
  context.vote_get_eligibility_flag_ = () => ({ childEligible:true, explicitIneligible:false });
  context.vote_get_options_ = () => [{ optionNo:'1', labelZh:'甲', labelEn:'A', sortOrder:1 },{ optionNo:'3', labelZh:'乙', labelEn:'B', sortOrder:2 }];
  context.vote_options_integrity_ok_ = () => true;
  context.vote_get_secret_ = () => 'test-only-secret';
  context.vote_ballots_ = pollId => ballots.filter(ballot => !pollId || ballot.electionId === pollId);
  context.vote_prior_cast_audit_ = () => null;
  context.vote_audit_ = (actor, pollId, action, target, reason, details) => { audit.push({ actor,pollId,action,target,reason,details }); return true; };
  context.vote_get_sheet_ = name => {
    assert.equal(name, 'Vote_Ballots');
    return { appendRow(row){
      ballots.push({
        electionId:row[0], receiptId:row[1], voterCode:row[2], optionNo:String(row[3]),
        castAt:row[4].toISOString(), decisionCode:row[5], integrityMac:row[6]
      });
    } };
  };
  return {
    context, ballots, audit,
    setCurrentPoll(pollId){ currentPollId = pollId; },
    setElectionState(state){ electionState = state; }
  };
}

test('one member can submit once per poll and can participate again in the next poll', () => {
  const fixture = castFixture();
  const { context, ballots, audit } = fixture;
  const first = context.api_vote_cast('session','POLL_TEST_A','1');
  const second = context.api_vote_cast('session','POLL_TEST_A','3');
  assert.equal(first.ok, true);
  assert.equal(first.result, 'CAST');
  assert.equal(second.ok, true);
  assert.equal(second.result, 'ALREADY_VOTED');
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(Object.hasOwn(first, 'decisionCode'), false);
  assert.equal(ballots.length, 1);
  assert.equal(ballots[0].optionNo, '1');
  assert.equal(context.vote_valid_ballot_(ballots[0], 'test-only-secret'), true);
  assert.ok(!JSON.stringify(ballots[0]).includes('CCF0123'));
  assert.equal(audit[0].action, 'BALLOT_CAST');
  assert.equal(audit[0].actor.role, 'VOTER_CODE');
  assert.ok(!JSON.stringify(audit[0]).includes('optionNo'));
  const status = context.vote_existing_ballot_for_member_('POLL_TEST_A','CCF0123');
  assert.equal(status.hasVoted, true);
  assert.equal(status.receiptId, first.receiptId);

  fixture.setCurrentPoll('POLL_TEST_B');
  const nextPoll = context.api_vote_cast('session','POLL_TEST_B','3');
  assert.equal(nextPoll.ok, true);
  assert.equal(nextPoll.result, 'CAST');
  assert.equal(ballots.length, 2);
  assert.notEqual(ballots[0].voterCode, ballots[1].voterCode);
});

test('a surviving cast audit blocks a second submission when its ballot row is missing', () => {
  const { context, ballots } = castFixture();
  context.vote_prior_cast_audit_ = () => ({ receiptId:'R-ORIGINAL', timestamp:'2030-01-01T00:00:00.000Z' });
  const result = context.api_vote_cast('session','POLL_TEST_A','1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_VOTE_INTEGRITY');
  assert.equal(ballots.length, 0);
});

test('live totals are limited to ADMIN or appointed scrutineers and exceptional review fails closed', () => {
  const fixture = castFixture();
  const { context, ballots, audit } = fixture;
  const cast = context.api_vote_cast('session','POLL_TEST_A','3');
  assert.equal(cast.ok, true);

  let currentMember = { id:'CCF0999', status:'ACTIVE', isMinor:false };
  let appointed = false;
  context.vote_require_session_ = () => ({ ok:true, member:currentMember });
  context.vote_is_scrutineer_ = () => appointed;
  let result = context.api_vote_results('ordinary-session','POLL_TEST_A');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E403');

  appointed = true;
  result = context.api_vote_results('scrutineer-session','POLL_TEST_A');
  assert.equal(result.ok, true);
  assert.equal(result.totalBallots, 1);
  assert.equal(result.rows.find(row => row.optionNo === '3').votes, 1);
  assert.equal(Object.hasOwn(result, 'ballotRegister'), false);
  assert.equal(Object.hasOwn(result, 'decisionCode'), false);
  assert.equal(Object.hasOwn(result, 'canInvestigateExceptions'), false);

  appointed = false;
  fixture.setElectionState('CLOSED');
  result = context.api_vote_results('ordinary-session','POLL_TEST_A');
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, 'canInvestigateExceptions'), false);
  assert.equal(result.integrityExceptions, undefined);

  currentMember = { id:'CCF0001', status:'ADMIN', isMinor:false };
  context.vote_all_members_ = () => [
    { id:'CCF0123', nameZh:'投票者', nameEn:'Voter', status:'ACTIVE', isMinor:false },
    currentMember
  ];
  const tooShort = context.api_vote_trace('admin-session','POLL_TEST_A',cast.receiptId,'short');
  assert.equal(tooShort.ok, false);
  const recordAudit = context.vote_audit_;
  context.vote_audit_ = () => false;
  const auditFailure = context.api_vote_trace('admin-session','POLL_TEST_A',cast.receiptId,'Formal recount check');
  assert.equal(auditFailure.ok, false);
  assert.equal(auditFailure.code, 'E_VOTE_AUDIT');
  assert.equal(Object.hasOwn(auditFailure, 'member'), false);
  context.vote_audit_ = recordAudit;
  const reviewed = context.api_vote_trace('admin-session','POLL_TEST_A',cast.receiptId,'Formal recount check');
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.member.id, 'CCF0123');
  assert.equal(reviewed.choice.optionNo, '3');
  assert.equal(reviewed.auditRecorded, true);
  assert.equal(audit.at(-1).action, 'BALLOT_TRACE');
  assert.equal(audit.at(-1).reason, 'Formal recount check');
  assert.equal(ballots.length, 1);
});

test('the unlinked exception route lists polls only for ADMIN or their appointed scrutineer', () => {
  const context = voteContext();
  const polls = [
    { electionId:'POLL_A', titleZh:'甲', titleEn:'A', state:'CLOSED', opensAt:'', closesAt:'2030-01-01T00:00:00.000Z' },
    { electionId:'POLL_B', titleZh:'乙', titleEn:'B', state:'DRAFT', opensAt:'', closesAt:'' }
  ];
  let member = { id:'CCF0099', status:'ACTIVE' };
  context.vote_require_session_ = () => ({ ok:true, member });
  context.vote_all_elections_ = () => polls;
  context.vote_is_scrutineer_ = pollId => member.id === 'CCF0099' && pollId === 'POLL_A';

  let result = context.api_vote_exception_polls('token');
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.rows.map(row => row.electionId)), ['POLL_A']);

  member = { id:'CCF0088', status:'ACTIVE' };
  result = context.api_vote_exception_polls('token');
  assert.equal(result.code, 'E403');

  member = { id:'CCF0001', status:'ADMIN' };
  result = context.api_vote_exception_polls('token');
  assert.equal(result.ok, true);
  assert.deepEqual(new Set(result.rows.map(row => row.electionId)), new Set(['POLL_A','POLL_B']));
});

test('public and ordinary dashboard payloads omit internal poll metadata', () => {
  const context = voteContext();
  context.vote_get_election_ = () => ({
    electionId:'POLL_TEST_A', titleZh:'投票', titleEn:'Poll', opensAt:'', closesAt:'', state:'DRAFT',
    optionDigest:'O1.private', createdBy:'CCF0001', updatedBy:'CCF0001', rowNumber:2
  });
  context.vote_get_options_ = () => [{ optionNo:'1', labelZh:'甲', labelEn:'A', sortOrder:1 },{ optionNo:'2', labelZh:'乙', labelEn:'B', sortOrder:2 }];
  context.vote_options_integrity_ok_ = () => true;
  context.vote_is_system_initialized_ = () => true;
  const payload = context.vote_public_config_payload_();
  assert.equal(payload.election.electionId, 'POLL_TEST_A');
  assert.equal(Object.hasOwn(payload.election, 'optionDigest'), false);
  assert.equal(Object.hasOwn(payload.election, 'createdBy'), false);
  assert.equal(Object.hasOwn(payload, 'results'), false);
  const privileges = context.vote_client_privileges_({ role:'ADMIN', isAdmin:true, canTrace:true, canViewEarlyResults:true });
  assert.equal(Object.hasOwn(privileges, 'canTrace'), false);
});

test('STAFF manages eligibility while DEACON and ADMIN manage polls', () => {
  const context = voteContext();
  let member = { id:'CCF0002', status:'STAFF' };
  context.vote_require_session_ = () => ({ ok:true, member });
  assert.equal(context.vote_require_role_('token', ['STAFF','ADMIN']).ok, true);
  assert.equal(context.vote_require_role_('token', ['ADMIN']).code, 'E403');
  member = { id:'CCF0003', status:'DEACON' };
  assert.equal(context.vote_require_role_('token', ['ADMIN']).ok, true);
  context.vote_is_scrutineer_ = () => false;
  const deaconPrivileges = context.vote_privileges_(member, 'POLL_CURRENT');
  assert.equal(deaconPrivileges.isAdmin, true);
  assert.equal(deaconPrivileges.canManageElection, true);
  assert.equal(deaconPrivileges.canViewEarlyResults, true);
  member = { id:'CCF0001', status:'ADMIN' };
  assert.equal(context.vote_require_role_('token', ['ADMIN']).ok, true);
  assert.equal(context.vote_effective_member_status_('STAFF', '2020-01-01T00:00:00.000Z'), 'ACTIVE');
  assert.equal(context.vote_effective_member_status_('DEACON', '2020-01-01T00:00:00.000Z'), 'ACTIVE');
  assert.equal(context.vote_effective_member_status_('PENDING', '2020-01-01T00:00:00.000Z'), 'PENDING');

  const staffSession = { ok:true, role:'STAFF', member:{ id:'CCF0002', status:'STAFF' } };
  context.vote_get_election_ = pollId => ({ electionId:pollId, state:'DRAFT' });
  context.vote_current_poll_id_ = () => 'POLL_CURRENT';
  assert.equal(context.vote_staff_poll_scope_(staffSession,'POLL_CURRENT').ok, true);
  assert.equal(context.vote_staff_poll_scope_(staffSession,'POLL_HISTORY').code, 'E403');
});

test('draft content locks after opening and closed polls cannot be reopened', () => {
  const context = voteContext();
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_ballot_count_ = () => 0;
  context.vote_get_election_ = () => ({ electionId:'POLL_A', state:'OPEN', opensAt:'', closesAt:'2099-01-01T00:00:00.000Z' });
  let result = context.api_vote_admin_save_poll_content('token','POLL_A', {
    titleEn:'Changed', options:[{ optionNo:'1', labelEn:'A' },{ optionNo:'2', labelEn:'B' }]
  });
  assert.equal(result.code, 'E_VOTE_LOCKED');

  context.vote_get_election_ = () => ({ electionId:'POLL_A', state:'CLOSED', opensAt:'', closesAt:'' });
  result = context.api_vote_admin_save_election('token','POLL_A', { state:'OPEN', closesAt:'2099-01-01T00:00:00.000Z' });
  assert.equal(result.code, 'E_VOTE_FINAL');

  context.vote_get_election_ = () => ({ electionId:'POLL_A', state:'OPEN', opensAt:'2020-01-01T00:00:00.000Z', closesAt:'2020-01-02T00:00:00.000Z' });
  result = context.api_vote_admin_save_election('token','POLL_A', { state:'OPEN', closesAt:'2099-01-01T00:00:00.000Z' });
  assert.equal(result.code, 'E_VOTE_FINAL');
});

test('initialisation never replaces a missing private polling secret after ballots exist', () => {
  let secretWritten = false;
  const audit = [];
  const context = voteContext({
    PropertiesService:{ getScriptProperties(){ return {
      getProperty(){ return ''; },
      setProperty(){ secretWritten = true; }
    }; } }
  });
  context.vote_require_role_ = () => ({ ok:true, role:'ADMIN', member:{ id:'CCF0001', status:'ADMIN' } });
  context.vote_ensure_sheet_ = () => ({});
  context.vote_ballot_count_ = () => 1;
  context.vote_audit_ = (actor, pollId, action) => { audit.push({ actor,pollId,action }); return true; };
  const result = context.api_vote_admin_initialize('token');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_VOTE_SECRET_MISSING');
  assert.equal(secretWritten, false);
  assert.equal(audit[0].action, 'SECRET_MISSING_BLOCK');
});
