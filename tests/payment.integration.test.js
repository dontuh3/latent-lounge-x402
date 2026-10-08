import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const receiver = '0x' + '0'.repeat(40), a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40);
// The real x402-express package calls this LOCAL facilitator. It deliberately
// simulates settlement; this suite does not test cryptography or move money.
// Every test server runs with a tripwire that fails the test if the browser wallet-UI dependency
// tree loads (the premise of the decode-uri-component audit exception).
const tripwire = `--require ${path.join(root,'tests/support/wallet-ui-tripwire.cjs')} --import ${pathToFileURL(path.join(root,'tests/support/wallet-ui-tripwire.mjs')).href}`;
async function setup(t, fixtures = {}, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lounge-test-'));
  for (const [file, value] of Object.entries(fixtures)) fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const state = { settlements: 0, reject: false, disconnect: false };
  const facilitator = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/verify') {
      state.verifyEntered=true;
      if(state.verifyWait) await state.verifyWait;
      return res.end(JSON.stringify({ isValid: !state.verifyReject, payer: body.paymentPayload.payload.authorization.from }));
    }
    if (req.url === '/settle') {
      state.settlements++; state.settleEntered=true;
      if(state.settleWait) await state.settleWait;
      if (state.disconnect) { req.socket.destroy(); return; }
      if (state.settleOverride) return res.end(JSON.stringify(state.settleOverride));
      await new Promise(resolve => setTimeout(resolve, 150));
      state.settledAt=Date.now();
      return res.end(JSON.stringify({ success: !state.reject, errorReason: state.reject ? 'test_rejected' : undefined, transaction: state.reject ? '' : 'local-test', network: body.paymentPayload.accepted?.network || 'base-sepolia', payer: body.paymentPayload.payload.authorization.from }));
    }
    res.writeHead(404).end('{}');
  });
  facilitator.listen(0, '127.0.0.1'); await once(facilitator, 'listening');
  const slot = net.createServer(); slot.listen(0, '127.0.0.1'); await once(slot, 'listening'); const port = slot.address().port; await new Promise(r => slot.close(r));
  const logFile = path.join(dir, 'server.log'); const logFd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_OPTIONS: tripwire, TRIPWIRE_FILE: path.join(dir, 'tripwire.log'), ...extraEnv, ADMIN_KEY:'local-test-admin', PAY_TO_ADDRESS: receiver, NETWORK: 'base-sepolia', PORT: String(port), DATA_DIR: dir, FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}`, BACKUP_FIRST_RUN_MS: '600000' }, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd); const readLog = () => fs.readFileSync(logFile, 'utf8');
  t.after(async () => { child.kill(); if(child.exitCode===null) await once(child,'exit'); const loaded=path.join(dir,'tripwire.log'); assert.equal(fs.existsSync(loaded),false,fs.existsSync(loaded)?fs.readFileSync(loaded,'utf8'):''); facilitator.closeAllConnections(); await new Promise(r => facilitator.close(r)); const target=fs.realpathSync(dir), parent=fs.realpathSync(os.tmpdir()); if(path.dirname(target)===parent && path.basename(target).startsWith('lounge-test-')) fs.rmSync(target,{recursive:true,force:true}); });
  const until = Date.now() + 30000; while (!readLog().includes('open on port') && Date.now() < until && child.exitCode === null) await new Promise(r => setTimeout(r, 25));
  assert.match(readLog(), /open on port/, readLog());
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, wallet, body) => {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (wallet) headers['X-PAYMENT'] = Buffer.from(JSON.stringify({x402Version:1, scheme:'exact', network:'base-sepolia', payload:{signature:'0x'+'1'.repeat(130),authorization:{from:wallet,to:receiver,value:route==='/api/plaque'?'1000000':'20000',validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce:'0x'+randomBytes(32).toString('hex')}}})).toString('base64');
    const res = await fetch(base+route,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
    return {status:res.status,settled:res.headers.has('X-PAYMENT-RESPONSE'),body:await res.json(),payment:headers['X-PAYMENT']};
  };
  return {request,dir,state,base,child};
}

test('actual middleware protects unpaid path variants', async t => {
  const s=await setup(t); for(const route of ['/api/play/cipher','/api/play/cipher/','/API/PLAY/CIPHER']) assert.equal((await s.request(route)).status,402);
});
test('concurrent first claims cannot score under another wallet', async t => {
  const s=await setup(t); const results=await Promise.all([s.request('/api/play/sequence?designation=racer',a),s.request('/api/play/sequence?designation=racer',b)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,403]); assert.equal(s.state.settlements,1);
});

test('same-wallet concurrent claims preserve canonical casing', async t => {
  const s = await setup(t);
  const results = await Promise.all([s.request('/api/play/sequence?designation=Racer', a), s.request('/api/play/sequence?designation=racer', a)]);
  assert.ok(results.every(r => r.status === 200));
  const pending = Object.values(JSON.parse(fs.readFileSync(path.join(s.dir, 'pending-puzzles.json'))));
  assert.equal(new Set(pending.map(p => p.designation)).size, 1);
});

test('names copied from a field description stay anonymous instead of locking later buyers out', async t => {
  const s = await setup(t);
  for (const copied of ["Optional. Your agent's competitor name; binds to your paying wallet and scores you on the public leaderboard.","Optional. Your agent's competitor name;"]) {
    const q = '/api/play/sequence?designation=' + encodeURIComponent(copied);
    assert.equal((await s.request(q, a)).status, 200, copied);
    assert.equal((await s.request(q, b)).status, 200, copied);
  }
  assert.equal(fs.existsSync(path.join(s.dir, 'names.json')), false);
  assert.equal((await s.request('/api/play/sequence?designation=real-name', a)).status, 200);
  assert.equal((await s.request('/api/play/sequence?designation=real-name', b)).status, 403);
});

test('a rejected settlement releases the name reservation', async t => {
  const s = await setup(t); s.state.reject = true;
  assert.equal((await s.request('/api/play/sequence?designation=retry-name', a)).status, 402);
  s.state.reject = false;
  assert.equal((await s.request('/api/play/sequence?designation=retry-name', b)).status, 200);
});
test('free demo questions are optional, validated when given, and the demo stays shared', async t => {
  const s=await setup(t);
  const admin=async()=>(await fetch(s.base+'/api/admin/stats',{headers:{'x-admin-key':'local-test-admin'}})).json();
  const bare=await s.request('/api/sample/walk'), invalid=await s.request('/api/sample/walk?client=http&wallet=maybe&found=bazaar');
  assert.equal(bare.status,200); assert.ok(bare.body.puzzleId);
  assert.equal(invalid.status,400);assert.match(invalid.body.error,/wallet/);assert.doesNotMatch(invalid.body.error,/client \(/);assert.deepEqual(invalid.body.optional.wallet,['yes','no','unknown']);
  const one=await s.request('/api/sample/walk?client=HTTP&wallet=unknown&found=bazaar'), two=await s.request('/api/sample/walk?client=browser');
  assert.equal(one.status,200);assert.notEqual(one.body.puzzleId,two.body.puzzleId);assert.deepEqual(two.body.prompt,one.body.prompt);assert.deepEqual(bare.body.prompt,one.body.prompt);
  for(const key of ['answer','solution','explanation'])assert.equal(one.body[key],undefined,key);
  assert.equal((await s.request('/api/check',null,{puzzleId:one.body.puzzleId,guess:'x'})).status,200);
  const survey=(await admin()).demoSurvey;
  assert.deepEqual(survey.client,{skipped:1,http:1,browser:1});assert.deepEqual(survey.wallet,{skipped:2,unknown:1});assert.deepEqual(survey.found,{skipped:2,bazaar:1});
  assert.equal(fs.existsSync(path.join(s.dir,'pending-puzzles.json')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'daily-demos.json')))[new Date().toISOString().slice(0,10)].walk.pub.prompt!==undefined,true);
  for(const route of ['/daily','/daily/archive','/daily/2026-10-05'])assert.equal((await fetch(s.base+route)).status,410,route);
  assert.doesNotMatch(await (await fetch(s.base+'/sitemap.xml')).text(),/daily/);
  const dossier=await (await fetch(s.base+'/agent/%3Cscript%3Ex')).text();
  assert.match(dossier,/<title>&lt;script&gt;x — streaks/);assert.doesNotMatch(dossier,/<title><script>/);
});

test('every paid listing declares JSON and play listings document the answer step', async t => {
  const s=await setup(t);
  const menu=(await s.request('/api/menu')).body;
  assert.equal(menu.startHere.demo,'/api/sample/walk');
  for (const [method, route] of [['GET','/api/play/walk'],['GET','/api/play/grandmaster/cipher'],['GET','/api/pack/logic'],['GET','/api/x402/echo'],['POST','/api/x402/echo'],['POST','/api/plaque'],['GET','/api/duel/attempt'],['POST','/api/oracle/answer'],['POST','/api/duel/post']]) {
    const res=await fetch(s.base+route,{method,headers:{Accept:'application/json','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(res.status,402,route); assert.equal((await res.json()).accepts[0].mimeType,'application/json',route);
  }
  const quote=await fetch(s.base+'/api/play/walk',{headers:{Accept:'application/json'}});
  const v2=JSON.parse(Buffer.from(quote.headers.get('PAYMENT-REQUIRED'),'base64').toString());
  assert.deepEqual(v2.extensions.bazaar.info.output.example.submit,{action:'submit_answer',method:'POST',url:'/api/check',body:{puzzleId:'b1e2c3d4-…',guess:'<your answer>'}});
  assert.match(v2.extensions.bazaar.schema.properties.output.properties.example.properties.submit.description,/POST \/api\/check/);
});

test('paid echo and puzzle packs settle once, store nothing scorable and count as sales', async t => {
  const s=await setup(t);
  const quote=await s.request('/api/x402/echo');
  assert.equal(quote.status,402);assert.equal(quote.body.accepts[0].maxAmountRequired,'1000');
  const echo=await s.request('/api/x402/echo',a);
  assert.equal(echo.status,200);assert.equal(echo.settled,true);assert.equal(echo.body.payer,a);assert.equal(echo.body.header,'X-PAYMENT');
  const posted=await s.request('/api/x402/echo',b,{hello:'lounge'});
  assert.equal(posted.status,200);assert.deepEqual(posted.body.receivedBody,{hello:'lounge'});
  const pack=await s.request('/api/pack/walk',a);
  assert.equal(pack.status,200);assert.equal(pack.body.count,25);assert.equal(pack.body.puzzles.length,25);
  assert.equal(typeof pack.body.puzzles[0].answer,'string');assert.ok(pack.body.puzzles[0].explanation.summary);assert.ok(pack.body.license);
  assert.equal(new Set(pack.body.puzzles.map(p=>p.id)).size,25);
  assert.equal(s.state.settlements,3);
  assert.equal(fs.existsSync(path.join(s.dir,'pending-puzzles.json')),false);
  const sales=(await (await fetch(s.base+'/api/admin/stats',{headers:{'x-admin-key':'local-test-admin'}})).json()).sales;
  assert.deepEqual(sales,{'GET /api/x402/echo':{count:1,usdc:0.001},'POST /api/x402/echo':{count:1,usdc:0.001},'GET /api/pack/walk':{count:1,usdc:0.25}});
  const replay=await fetch(s.base+'/api/pack/walk',{headers:{'X-PAYMENT':pack.payment}});
  assert.equal(replay.status,200);assert.deepEqual((await replay.json()).puzzles,pack.body.puzzles);assert.equal(s.state.settlements,3);
});
test('corrupt ledgers return unavailable and preserve the damaged bytes',async t=>{
 const s=await setup(t);const file=path.join(s.dir,'leaderboard.json');fs.writeFileSync(file,'{broken');const r=await s.request('/api/leaderboard');assert.equal(r.status,503);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('rejected settlement creates no plaque or identity',async t=>{
 const s=await setup(t);s.state.reject=true;const r=await s.request('/api/plaque',a,{designation:'reject-test',inscription:'test'});assert.equal(r.status,402);assert.equal(r.settled,false);assert.equal(fs.existsSync(path.join(s.dir,'plaques.json')),false);assert.equal(fs.existsSync(path.join(s.dir,'names.json')),false);
});

test('every paid generator withholds its solution until submission', async t => {
  const s = await setup(t);
  for (const game of ['walk','automaton','constraint','sequence','logic','induction','cipher']) {
    const bought = await s.request(`/api/play/${game}`, a);
    assert.equal(bought.status, 200, game);
    for (const key of ['answer','solution','explanation']) assert.equal(bought.body[key], undefined, `${game} leaked ${key}`);
    assert.equal(bought.body.generatorVersion, '2026-09-20.2');
    assert.equal(bought.body.difficulty.calibrated, false);
    const result = await s.request('/api/check', null, {puzzleId:bought.body.puzzleId,guess:'deliberately incorrect'});
    assert.equal(result.status,200); assert.equal(result.body.correct,false);
    assert.equal(typeof result.body.answer,'string'); assert.ok(result.body.explanation.summary);
    assert.equal((await s.request('/api/check',null,{puzzleId:bought.body.puzzleId,guess:result.body.answer})).status,410);
  }
  assert.equal(fs.existsSync(path.join(s.dir,'leaderboard.json')),false);
});

test('confirmed expiry resets a streak and watermark prevents recounting after restart', async t => {
  const record = {bestStreak:3,currentStreak:3,solved:3,plays:3,points:0,totalTimeMs:0,timedPlays:0};
  const pending = {expired:{settled:true,answer:'4',lbKey:'sequence',designation:'player',issuedAt:1,expires:2}};
  const first = await setup(t, {'leaderboard.json':{sequence:{player:record}},'pending-puzzles.json':pending});
  const lb = JSON.parse(fs.readFileSync(path.join(first.dir,'leaderboard.json')));
  assert.equal(lb.sequence.player.currentStreak,0); assert.equal(lb.sequence.player.plays,4);
  const second = await setup(t, {'leaderboard.json':lb,'pending-puzzles.json':pending});
  const replay = JSON.parse(fs.readFileSync(path.join(second.dir,'leaderboard.json')));
  assert.equal(replay.sequence.player.plays,4);
});

test('legacy and unsettled expiry cannot be retroactively counted as paid failure', async t => {
  const record={bestStreak:3,currentStreak:3,solved:3,plays:3};
  const s=await setup(t,{'leaderboard.json':{sequence:{player:record}},'pending-puzzles.json':{old:{answer:'4',lbKey:'sequence',designation:'player',issuedAt:1,expires:2},failed:{settled:false,answer:'4',lbKey:'sequence',designation:'player',issuedAt:1,expires:3}}});
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'leaderboard.json'))).sequence.player.plays,3);
});

test('already-closed duel attempts reveal no answer and award no further credit', async t => {
  const s = await setup(t, {'duels.json':[{id:'challenge',setter:'setter',setterWallet:a,answer:'secret',posted:new Date().toISOString(),status:'open',attempts:0}], 'pending-puzzles.json':Object.fromEntries(['first','second'].map(id=>[id,{settled:true,kind:'duel',duelId:'challenge',lbKey:'duels',designation:'solver',solverWallet:b,answer:'secret',issuedAt:Date.now(),expires:Date.now()+600000}]))});
  const first = await s.request('/api/check',null,{puzzleId:'first',guess:'secret'});
  assert.equal(first.status,200); assert.equal(first.body.correct,true);
  const second = await s.request('/api/check',null,{puzzleId:'second',guess:'secret',confidence:99});
  assert.equal(second.status,200); assert.match(second.body.scoringNote,/closed/);
  assert.equal(second.body.answer,undefined); assert.equal(second.body.explanation,undefined); assert.equal(second.body.wagerPoints,undefined);
  const lb=JSON.parse(fs.readFileSync(path.join(s.dir,'leaderboard.json')));
  assert.equal(lb.duels.solver.solved,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'tournament.json'))).scores.solver.solved,1);
});

test('confidence points do not outrank more solved puzzles', async t => {
  const s=await setup(t,{'leaderboard.json':{walk:{steady:{bestStreak:2,solved:8,plays:10,points:0},wagerer:{bestStreak:2,solved:2,plays:2,points:9999}}}});
  assert.equal((await s.request('/api/leaderboard/walk')).body.board[0].designation,'steady');
});

test('public discovery assets and health probe work without paying', async t => {
  const s=await setup(t);
  for(const route of ['/','/connect.html','/puzzles.html','/press.html','/llms.txt','/robots.txt','/sitemap.xml','/openapi.json']) assert.equal((await fetch(s.base+route)).status,200,route);
  const health=await s.request('/healthz');assert.equal(health.body.payments,'not_checked');assert.equal(s.state.settlements,0);
});

test('paid purchase and answer retries replay the original result without double charging or scoring',async t=>{
  const s=await setup(t);
  const purchased=await s.request('/api/play/sequence?designation=replay',a);
  assert.equal(purchased.status,200);
  const replay=await fetch(s.base+'/api/play/sequence?designation=replay',{headers:{'X-PAYMENT':purchased.payment}});
  assert.equal(replay.status,200);assert.equal((await replay.json()).puzzleId,purchased.body.puzzleId);assert.equal(s.state.settlements,1);
  const pending=JSON.parse(fs.readFileSync(path.join(s.dir,'pending-puzzles.json')));
  const body={puzzleId:purchased.body.puzzleId,guess:pending[purchased.body.puzzleId].answer};
  const first=await s.request('/api/check',null,body),second=await s.request('/api/check',null,body);
  assert.equal(first.status,200);assert.deepEqual(second.body,first.body);
  const lb=JSON.parse(fs.readFileSync(path.join(s.dir,'leaderboard.json')));assert.equal(lb.sequence.replay.plays,1);
  assert.equal((await s.request('/api/check',null,{...body,guess:'different'})).status,410);
  const mismatch=await fetch(s.base+'/api/play/cipher',{headers:{'X-PAYMENT':purchased.payment}});assert.equal(mismatch.status,409);
});

test('a conditional paid request is never settled into an empty response',async t=>{
  const s=await setup(t);
  // Raw request: fetch adds Cache-Control: no-cache to conditional requests, which hides the bug.
  const header=Buffer.from(JSON.stringify({x402Version:1,scheme:'exact',network:'base-sepolia',payload:{signature:'0x'+'1'.repeat(130),authorization:{from:a,to:receiver,value:'20000',validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce:'0x'+randomBytes(32).toString('hex')}}})).toString('base64');
  const raw=await new Promise((resolve,reject)=>{const req=http.request(s.base+'/api/play/sequence?designation=etag',{headers:{'X-PAYMENT':header,'If-None-Match':'*',Accept:'application/json'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});
  assert.equal(raw.status,200);assert.ok(JSON.parse(raw.body).puzzleId);assert.equal(s.state.settlements,1);
  assert.equal((await s.request('/api/play/cipher',b)).status,200);
});

test('a re-encoded payment header cannot buy a second puzzle',async t=>{
  const s=await setup(t);const first=await s.request('/api/play/sequence?designation=rekey',a);
  assert.equal(first.status,200);
  const altered=JSON.parse(Buffer.from(first.payment,'base64'));altered.accepted={network:'re-keyed'};
  const again=await fetch(s.base+'/api/play/sequence?designation=rekey',{headers:{Accept:'application/json','X-PAYMENT':Buffer.from(JSON.stringify(altered)).toString('base64')}});
  assert.equal(again.status,200);assert.equal((await again.json()).puzzleId,first.body.puzzleId);assert.equal(s.state.settlements,1);
});

test('an in-flight settlement does not turn away quotes, readiness or other buyers',async t=>{
  const s=await setup(t);let release;s.state.settleWait=new Promise(r=>{release=r;});
  const buying=s.request('/api/play/sequence?designation=inflight',a);
  const until=Date.now()+5000;while(!s.state.settleEntered && Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal((await s.request('/api/play/cipher')).status,402);
  assert.equal((await fetch(s.base+'/readyz')).status,200);
  const other=s.request('/api/play/cipher',b);
  await new Promise(r=>setTimeout(r,100));release();
  assert.equal((await buying).status,200);assert.equal((await other).status,200);assert.equal(s.state.settlements,2);
});

test('uncertain settlement leaves a recovery record and blocks further purchases',async t=>{
  const s=await setup(t);s.state.disconnect=true;
  const result=await s.request('/api/play/sequence?designation=uncertain',a);
  assert.equal(result.status,503);
  const record=JSON.parse(fs.readFileSync(path.join(s.dir,'transaction-journal.json')));
  assert.equal(record.state,'prepared');assert.ok(record.entries['pending-puzzles.json']);
  assert.equal(fs.existsSync(path.join(s.dir,'names.json')),false);
  assert.equal((await s.request('/api/play/cipher',b)).status,503);
  assert.equal((await s.request('/api/admin/payment-recovery')).status,403);
});

test('storage failure before settlement never charges',async t=>{
  const s=await setup(t);fs.mkdirSync(path.join(s.dir,'transaction-journal.json.tmp'));
  const result=await s.request('/api/play/sequence?designation=storage-failure',a);
  assert.equal(result.status,503);assert.equal(s.state.settlements,0);
  assert.equal(fs.existsSync(path.join(s.dir,'names.json')),false);
});

test('answer storage failure preserves the attempt and does not partly update scores',async t=>{
  const s=await setup(t);const bought=await s.request('/api/play/sequence?designation=atomic-test',a);
  const file=path.join(s.dir,'pending-puzzles.json');const pending=JSON.parse(fs.readFileSync(file));
  fs.mkdirSync(path.join(s.dir,'transaction-journal.json.tmp'));
  const result=await s.request('/api/check',null,{puzzleId:bought.body.puzzleId,guess:pending[bought.body.puzzleId].answer});
  assert.equal(result.status,503);assert.deepEqual(JSON.parse(fs.readFileSync(file)),pending);
  assert.equal(fs.existsSync(path.join(s.dir,'leaderboard.json')),false);
});

async function modernPayment(s, route) {
  const quote=await fetch(s.base+route);
  assert.equal(quote.status,402);
  const challenge=JSON.parse(Buffer.from(quote.headers.get('PAYMENT-REQUIRED'),'base64'));
  assert.equal(challenge.x402Version,2);
  assert.equal(challenge.extensions.bazaar.info.input.method,'GET');
  assert.equal(challenge.extensions.bazaar.schema.properties.input.properties.queryParams.properties.designation.type,'string');
  assert.equal(challenge.extensions.bazaar.schema.properties.output.properties.example.properties.puzzleId.type,'string');
  assert.equal((await quote.json()).x402Version,1);
  return {x402Version:2,resource:challenge.resource,accepted:challenge.accepts[0],payload:{signature:'0x'+'1'.repeat(130),authorization:{from:a,to:receiver,value:challenge.accepts[0].amount,validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce:'0x'+randomBytes(32).toString('hex')}}};
}
const encodePayment=p=>Buffer.from(JSON.stringify(p)).toString('base64');
test('v2 purchase, identity, answer and cross-version replay settle exactly once',async t=>{
  const s=await setup(t),route='/api/play/sequence?designation=modern';
  const p=await modernPayment(s,route);
  assert.equal(p.accepted.network,'eip155:84532');assert.equal(p.accepted.amount,'20000');
  const buy=await fetch(s.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment(p)}});
  assert.equal(buy.status,200);assert.ok(buy.headers.has('PAYMENT-RESPONSE'));
  assert.equal(JSON.parse(Buffer.from(buy.headers.get('PAYMENT-RESPONSE'),'base64')).network,'eip155:84532');
  const puzzle=await buy.json();
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'names.json'))).modern.wallet,a);
  const old={x402Version:1,network:'base-sepolia',scheme:'exact',payload:p.payload};
  for(const headers of [{'PAYMENT-SIGNATURE':encodePayment(p)},{'X-PAYMENT':encodePayment(old)}]){
    const replay=await fetch(s.base+route,{headers});assert.equal(replay.status,200);assert.equal((await replay.json()).puzzleId,puzzle.puzzleId);
  }
  assert.equal(s.state.settlements,1);
  const pending=JSON.parse(fs.readFileSync(path.join(s.dir,'pending-puzzles.json')));
  const answer=await s.request('/api/check',null,{puzzleId:puzzle.puzzleId,guess:pending[puzzle.puzzleId].answer});assert.equal(answer.body.correct,true);
});
test('v2 rejects altered requirements, ambiguous headers and incorrect version without settlement',async t=>{
  const s=await setup(t),route='/api/play/cipher';const p=await modernPayment(s,route);
  for(const [key,value] of [['amount','1'],['network','eip155:1'],['payTo',b],['asset',b],['extra',{}]]){
    const tampered=structuredClone(p);tampered.accepted[key]=value;
    assert.equal((await fetch(s.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment(tampered)}})).status,402);
  }
  assert.equal((await fetch(s.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment(p),'X-PAYMENT':encodePayment(p)}})).status,402);
  assert.equal((await fetch(s.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment({...p,x402Version:1})}})).status,402);
  assert.equal(s.state.settlements,0);
});
test('v2 uncertainty keeps durable evidence and storage failure never settles',async t=>{
  const s=await setup(t),route='/api/play/cipher';const p=await modernPayment(s,route);s.state.disconnect=true;
  assert.equal((await fetch(s.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment(p)}})).status,503);
  const record=JSON.parse(fs.readFileSync(path.join(s.dir,'transaction-journal.json')));
  assert.equal(record.state,'prepared');assert.equal(record.payload.x402Version,2);assert.equal(record.requirements.amount,'20000');
  assert.equal((await fetch(s.base+route)).status,503);
  const other=await setup(t),q=await modernPayment(other,route);fs.mkdirSync(path.join(other.dir,'transaction-journal.json.tmp'));
  assert.equal((await fetch(other.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment(q)}})).status,503);assert.equal(other.state.settlements,0);
});

test('pending and malformed settlement results preserve recovery evidence',async t=>{
  for(const outcome of [{success:false,errorReason:'settlement_pending',transaction:'pending-test'},{success:'true',transaction:'invalid-test'}]){
    const s=await setup(t),route='/api/play/cipher',p=await modernPayment(s,route);
    s.state.settleOverride=outcome;
    const result=await fetch(s.base+route,{headers:{'PAYMENT-SIGNATURE':encodePayment(p)}});
    assert.equal(result.status,503);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'transaction-journal.json'))).state,'prepared');
    assert.equal((await fetch(s.base+route)).status,503);assert.equal(s.state.settlements,1);
  }
});

test('slow rejected verification does not block browsing or answering',async t=>{
  const s=await setup(t); const sample=await s.request('/api/play/walk',b);
  let release; s.state.verifyWait=new Promise(resolve=>{release=resolve;});s.state.verifyReject=true;
  const payment=s.request('/api/play/cipher',a);
  while(!s.state.verifyEntered) await new Promise(resolve=>setTimeout(resolve,10));
  try {
    const res=await fetch(s.base+'/api/menu',{signal:AbortSignal.timeout(1500)});assert.equal(res.status,200);
    const answer=await fetch(s.base+'/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({puzzleId:sample.body.puzzleId,guess:'wrong'}),signal:AbortSignal.timeout(1500)});assert.equal(answer.status,200);
  } finally {release();}
  assert.equal((await payment).status,402);assert.equal(s.state.settlements,1);
});

test('reserved names are rejected before charging; existing paid reserved-name attempts still score',async t=>{
 const s=await setup(t,{'pending-puzzles.json':{legacy:{settled:true,answer:'7',lbKey:'sequence',designation:'toString',issuedAt:Date.now(),expires:Date.now()+600000}}});
 for(const name of ['toString','hasOwnProperty','__proto__','constructor']) assert.equal((await s.request('/api/play/sequence?designation='+name,a)).status,403);
 assert.equal(s.state.settlements,0);
 assert.equal((await s.request('/api/check',null,{puzzleId:'legacy',guess:'7'})).body.correct,true);
 assert.equal((await s.request('/api/leaderboard/sequence')).body.board[0].designation,'toString');
});

test('shared anonymous labels never score or claim identities; settlement counts once',async t=>{
 const s=await setup(t);
 for(const name of ['anonymous','anonymous patron']) {
  const route='/api/play/sequence?designation='+encodeURIComponent(name),p=await s.request(route,a);
  assert.equal(p.status,200);assert.equal(typeof p.body.expiresAt,'string');
  const record=JSON.parse(fs.readFileSync(path.join(s.dir,'pending-puzzles.json')))[p.body.puzzleId];
  assert.equal(record.designation,null);assert.equal(record.expires-record.issuedAt,600000);
  assert.ok(record.issuedAt>=s.state.settledAt); // settlement latency does not consume solve time
  const replay=await fetch(s.base+route,{headers:{'X-PAYMENT':p.payment}});assert.equal(replay.status,200);
  await s.request('/api/check',null,{puzzleId:p.body.puzzleId,guess:record.answer});
 }
 assert.deepEqual((await s.request('/api/leaderboard/sequence')).body.board,[]);
 const stats=await(await fetch(s.base+'/api/admin/stats',{headers:{'x-admin-key':'local-test-admin'}})).json();
 assert.equal(stats.anonPlays.sequence.settled,2);assert.equal(stats.puzzleFunnel.byGame.sequence.paidSettled,2);assert.equal(s.state.settlements,2);
});

test('retired names keep history and cannot be reassigned; retirement fails atomically',async t=>{
 const fixtures={'names.json':{retired:{designation:'retired',wallet:a,claimedAt:new Date().toISOString()}},'tournament.json':{date:new Date().toISOString().slice(0,10),scores:{retired:{solved:7,plays:7}},history:[]}};
 const s=await setup(t,fixtures);
 const res=await fetch(s.base+'/api/admin/name/retired',{method:'DELETE',headers:{'x-admin-key':'local-test-admin'}});assert.equal(res.status,200);
 for(const wallet of [a,b])assert.equal((await s.request('/api/play/sequence?designation=retired',wallet)).status,403);
 assert.equal(s.state.settlements,0);assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'tournament.json'))).scores.retired.solved,7);
 const other=await setup(t,fixtures);fs.mkdirSync(path.join(other.dir,'transaction-journal.json.tmp'));
 assert.equal((await fetch(other.base+'/api/admin/name/retired',{method:'DELETE',headers:{'x-admin-key':'local-test-admin'}})).status,503);
 assert.equal(JSON.parse(fs.readFileSync(path.join(other.dir,'names.json'))).retired.retiredAt,undefined);
});

test('readiness distinguishes recovery while free discovery remains accessible',async t=>{
 const s=await setup(t);assert.equal((await s.request('/readyz')).status,200);s.state.disconnect=true;
 assert.equal((await s.request('/api/play/cipher',a)).status,503);
 assert.equal((await s.request('/readyz')).status,503);assert.equal((await s.request('/healthz')).status,200);
 assert.equal((await s.request('/api/menu')).status,200);assert.equal((await s.request('/api/play/walk',b)).status,503);
});

test('all paid HEAD routes challenge without generating or charging and large JSON is 413',async t=>{
 const s=await setup(t);
 for(const tier of ['','grandmaster/'])for(const game of ['sequence','cipher','logic','induction','automaton','walk','constraint'])assert.equal((await fetch(s.base+'/api/play/'+tier+game,{method:'HEAD'})).status,402);
 assert.equal(fs.existsSync(path.join(s.dir,'pending-puzzles.json')),false);assert.equal(s.state.settlements,0);
 const big=await fetch(s.base+'/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guess:'x'.repeat(17000)})});assert.equal(big.status,413);
});

test('archives page without exposing hidden records and old expired recovery receipts are bounded',async t=>{
 const plaques=Array.from({length:205},(_,i)=>({id:i+1,designation:'visitor',inscription:'public',engraved:new Date().toISOString()}));
 const old={fingerprint:'old',body:'{}',status:200,at:'2000-01-01T00:00:00Z',validBefore:1};
 const s=await setup(t,{'plaques.json':plaques,'payment-receipts.json':{expired:old,legacy:{...old,validBefore:undefined},stillValid:{...old,validBefore:Math.floor(Date.now()/1000)+86400}}});
 const page=(await s.request('/api/plaques?limit=100&offset=0')).body;
 assert.equal(page.wall.length,100);assert.equal(page.pagination.total,205);assert.equal(page.pagination.nextOffset,100);
 const last=(await s.request('/api/plaques?limit=100&offset=200')).body;assert.equal(last.wall.length,5);assert.equal(last.pagination.nextOffset,null);
 assert.equal((await s.request('/api/play/sequence',a)).status,200);
 const records=JSON.parse(fs.readFileSync(path.join(s.dir,'payment-receipts.json')));
 assert.equal(records.expired,undefined);assert.ok(records.legacy);assert.ok(records.stillValid);
});

// ---------- retry authorization, bounded receipt storage and echo guardrails ----------
const signedHeader = ({ from = a, value = '250000', validBefore = Math.floor(Date.now()/1000)+600, nonce = '0x'+randomBytes(32).toString('hex'), signature = '0x'+'1'.repeat(130) } = {}) =>
  Buffer.from(JSON.stringify({x402Version:1,scheme:'exact',network:'base-sepolia',payload:{signature,authorization:{from,to:receiver,value,validAfter:'0',validBefore:String(validBefore),nonce}}})).toString('base64');
const call = async (s, route, headers = {}, body) => {
  const res = await fetch(s.base+route,{method:body?'POST':'GET',headers:{Accept:'application/json','Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  return { status: res.status, receipt: res.headers.get('X-PAYMENT-RESPONSE'), body: await res.json().catch(()=>({})) };
};

test('a forged retry cannot fetch another buyer\'s paid response', async t => {
  const s = await setup(t); const nonce = '0x'+randomBytes(32).toString('hex'), validBefore = Math.floor(Date.now()/1000)+600;
  const original = signedHeader({ nonce, validBefore });
  const bought = await call(s, '/api/pack/walk', { 'X-PAYMENT': original });
  assert.equal(bought.status, 200); assert.equal(bought.body.puzzles.length, 25);
  for (const signature of ['0x'+'9'.repeat(130), '']) {
    const forged = await call(s, '/api/pack/walk', { 'X-PAYMENT': signedHeader({ nonce, validBefore, signature }) });
    assert.equal(forged.status, 409, `signature ${signature.slice(0,4)}`); assert.equal(forged.body.puzzles, undefined);
  }
  const retry = await call(s, '/api/pack/walk', { 'X-PAYMENT': original });
  assert.equal(retry.status, 200); assert.deepEqual(retry.body.puzzles, bought.body.puzzles); assert.equal(s.state.settlements, 1);
});

test('retries after the grace window need the retrieval key sent with the purchase', async t => {
  const s = await setup(t); const past = Math.floor(Date.now()/1000) - 7200, key = 'k'+randomBytes(16).toString('hex');
  const keyless = signedHeader({ value: '20000', validBefore: past });
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': keyless })).status, 200);
  const closed = await call(s, '/api/play/walk', { 'X-PAYMENT': keyless });
  assert.equal(closed.status, 410); assert.ok(closed.receipt); assert.equal(closed.body.puzzleId, undefined);
  const keyed = signedHeader({ value: '20000', validBefore: past });
  const first = await call(s, '/api/play/walk', { 'X-PAYMENT': keyed, 'X-Lounge-Retrieval-Key': key });
  assert.equal(first.status, 200);
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': keyed, 'X-Lounge-Retrieval-Key': key })).body.puzzleId, first.body.puzzleId);
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': keyed })).status, 409);
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': keyed, 'X-Lounge-Retrieval-Key': 'wrong-'+key })).status, 409);
  const fresh = signedHeader({ value: '20000' }), bought = await call(s, '/api/play/walk', { 'X-PAYMENT': fresh });
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': fresh })).body.puzzleId, bought.body.puzzleId);
  assert.equal(s.state.settlements, 3);
});

test('echo bodies over 1 KB are summarised, and the stored receipt stays small', async t => {
  const s = await setup(t); const big = { note: 'é'.repeat(1500) }, header = signedHeader({ value: '1000' });
  const echoed = await call(s, '/api/x402/echo', { 'X-PAYMENT': header }, big);
  assert.equal(echoed.status, 200); assert.equal(echoed.body.receivedBodyOmitted, true); assert.equal(echoed.body.receivedBody, null);
  const json = JSON.stringify(big);
  assert.equal(echoed.body.receivedBodyBytes, Buffer.byteLength(json));
  assert.equal(echoed.body.receivedBodySha256, (await import('node:crypto')).createHash('sha256').update(json).digest('hex'));
  const stored = Object.values(JSON.parse(fs.readFileSync(path.join(s.dir, 'payment-receipts.json'))))[0];
  assert.ok(Buffer.byteLength(stored.body) < 1024, `stored ${Buffer.byteLength(stored.body)} bytes`);
  assert.deepEqual((await call(s, '/api/x402/echo', { 'X-PAYMENT': header }, big)).body, echoed.body);
  assert.deepEqual((await call(s, '/api/x402/echo', { 'X-PAYMENT': signedHeader({ value: '1000' }) }, { small: true })).body.receivedBody, { small: true });
});

test('past the storage budget, responses are delivered but not retained, and sales continue', async t => {
  const s = await setup(t, {}, { RECEIPT_BODY_BUDGET_BYTES: '3000' });
  const header = signedHeader();
  const pack = await call(s, '/api/pack/walk', { 'X-PAYMENT': header });
  assert.equal(pack.status, 200); assert.equal(pack.body.puzzles.length, 25);
  const stored = Object.values(JSON.parse(fs.readFileSync(path.join(s.dir, 'payment-receipts.json'))))[0];
  assert.equal(stored.bodyOmitted, true); assert.equal(stored.body, undefined); assert.ok(stored.bodyBytes > 3000);
  const retry = await call(s, '/api/pack/walk', { 'X-PAYMENT': header });
  assert.equal(retry.status, 410); assert.equal(retry.body.bodySha256, stored.bodySha256); assert.ok(retry.receipt);
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': signedHeader({ value: '20000' }) })).status, 200);
  assert.equal(s.state.settlements, 2);
});

test('echo limits apply per wallet and per IP before payment, and never block a retry', async t => {
  const s = await setup(t, {}, { ECHO_WALLET_DAILY: '2', ECHO_IP_HOURLY: '4' });
  const first = signedHeader({ value: '1000' });
  assert.equal((await call(s, '/api/x402/echo', { 'X-PAYMENT': first })).status, 200);
  assert.equal((await call(s, '/api/x402/echo', { 'X-PAYMENT': signedHeader({ value: '1000' }) })).status, 200);
  const overWallet = await call(s, '/api/x402/echo', { 'X-PAYMENT': signedHeader({ value: '1000' }) });
  assert.equal(overWallet.status, 429); assert.match(overWallet.body.error, /not been charged/);
  assert.equal((await call(s, '/api/x402/echo', { 'X-PAYMENT': first })).status, 200);
  assert.equal((await call(s, '/api/x402/echo', { 'X-PAYMENT': signedHeader({ from: b, value: '1000' }) })).status, 200);
  assert.equal((await call(s, '/api/x402/echo', { 'X-PAYMENT': signedHeader({ from: b, value: '1000' }) })).status, 429);
  assert.equal((await call(s, '/api/x402/echo')).status, 402);
  assert.equal(s.state.settlements, 3);
});

test('the wallet-UI tripwire detects a load, and no source imports that tree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lounge-tripwire-')), log = path.join(dir, 'tripwire.log');
  try {
    const qs = path.join(root, 'node_modules', 'query-string');
    const run = spawn(process.execPath, ['--require', path.join(root, 'tests/support/wallet-ui-tripwire.cjs'), '-e', `require(${JSON.stringify(qs)})`], { env: { PATH: process.env.PATH, TRIPWIRE_FILE: log }, stdio: 'ignore' });
    await once(run, 'exit');
    assert.match(fs.readFileSync(log, 'utf8'), /query-string/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const sources = ['server.js', 'payment-middleware.js', 'payment-protocol.js', 'payment-recovery.js', 'durable-store.js', 'puzzle-insights.js', 'agent-client.js', ...fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.js')).map(f => 'public/'+f)];
  for (const file of sources) assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /['"](x402\/paywall|wagmi|@wagmi\/[^'"]*|@walletconnect\/[^'"]*|query-string|decode-uri-component)['"]/, file);
});

// ---------- operator recovery through the real admin route (simulated chain) ----------
async function fakeChain(t, { authorizationUsed = false } = {}) {
  const { keccak256, toHex, pad } = await import('viem');
  const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e', txs = new Map(), finalized = { number: 1000, timestamp: Math.floor(Date.now()/1000) };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const { id, method, params } = JSON.parse(raw), reply = result => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    res.setHeader('Content-Type', 'application/json');
    if (method === 'eth_chainId') return reply('0x14a34');
    if (method === 'eth_getBlockByNumber') return reply({ number: toHex(finalized.number), timestamp: toHex(finalized.timestamp), hash: '0x'+'b'.repeat(64), parentHash: '0x'+'c'.repeat(64), transactions: [], uncles: [] });
    if (method === 'eth_getTransactionReceipt') return reply(txs.get(params[0].toLowerCase()) || null);
    if (method === 'eth_call') return reply(pad(authorizationUsed ? '0x1' : '0x0'));
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));
  const topic = signature => keccak256(toHex(signature));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    // A finalized settlement transaction carrying AuthorizationUsed and the USDC Transfer.
    settle(hashValue, { from, to, nonce, value }) {
      txs.set(hashValue, { transactionHash: hashValue, blockHash: '0x'+'d'.repeat(64), blockNumber: toHex(finalized.number - 5), transactionIndex: '0x0', from, to: usdc, status: '0x1', type: '0x2', gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', contractAddress: null, logsBloom: '0x'+'0'.repeat(512),
        logs: [
          { address: usdc, topics: [topic('AuthorizationUsed(address,bytes32)'), pad(from), nonce], data: '0x', blockNumber: toHex(finalized.number - 5), transactionHash: hashValue, logIndex: '0x0', blockHash: '0x'+'d'.repeat(64), transactionIndex: '0x0', removed: false },
          { address: usdc, topics: [topic('Transfer(address,address,uint256)'), pad(from), pad(to)], data: pad(toHex(BigInt(value))), blockNumber: toHex(finalized.number - 5), transactionHash: hashValue, logIndex: '0x1', blockHash: '0x'+'d'.repeat(64), transactionIndex: '0x0', removed: false },
        ] });
    },
  };
}
const admin = (s, method, body, key = 'local-test-admin') => fetch(s.base+'/api/admin/payment-recovery', { method, headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('an operator recovers an uncertain purchase through the admin route, exactly once', async t => {
  const chain = await fakeChain(t), s = await setup(t, {}, { RECOVERY_RPC_URL: chain.url });
  const nonce = '0x'+randomBytes(32).toString('hex'), header = signedHeader({ value: '20000', nonce });
  s.state.disconnect = true;
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': header })).status, 503);
  s.state.disconnect = false;
  assert.equal((await call(s, '/api/play/cipher', { 'X-PAYMENT': signedHeader({ from: b, value: '20000' }) })).status, 503);
  const pending = await admin(s, 'GET');
  assert.equal(pending.status, 200); assert.equal(pending.body.pending.payer, a); assert.equal(pending.body.pending.nonce, nonce);
  const id = pending.body.pending.id, tx = '0x'+'e'.repeat(64), wrongTx = '0x'+'f'.repeat(64);
  assert.equal((await admin(s, 'POST', { id, transactionHash: tx }, 'wrong-key')).status, 403);
  assert.equal((await admin(s, 'POST', { id: 'not-the-id', transactionHash: tx })).status, 409);
  chain.settle(wrongTx, { from: a, to: receiver, nonce, value: 1 });
  assert.notEqual((await admin(s, 'POST', { id, transactionHash: wrongTx })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'transaction-journal.json'))).state, 'prepared');
  chain.settle(tx, { from: a, to: receiver, nonce, value: 20000 });
  const recovered = await admin(s, 'POST', { id, transactionHash: tx });
  assert.deepEqual(recovered.body, { recovered: true, cancelled: false });
  assert.equal((await admin(s, 'POST', { id, transactionHash: tx })).status, 409);
  const retry = await call(s, '/api/play/walk', { 'X-PAYMENT': header });
  assert.equal(retry.status, 200); assert.ok(retry.receipt); assert.ok(retry.body.puzzleId);
  const answer = await s.request('/api/check', null, { puzzleId: retry.body.puzzleId, guess: '0,0' });
  assert.equal(answer.status, 200);
  const stats = await (await fetch(s.base+'/api/admin/stats', { headers: { 'x-admin-key': 'local-test-admin' } })).json();
  assert.deepEqual(stats.sales['GET /api/play/walk'], { count: 1, usdc: 0.02 });
  assert.equal(s.state.settlements, 1);
});

test('an operator releases an expired, unused authorization and purchases resume', async t => {
  const chain = await fakeChain(t, { authorizationUsed: false }), s = await setup(t, {}, { RECOVERY_RPC_URL: chain.url });
  s.state.disconnect = true;
  assert.equal((await call(s, '/api/play/walk', { 'X-PAYMENT': signedHeader({ value: '20000', validBefore: Math.floor(Date.now()/1000) - 60 }) })).status, 503);
  s.state.disconnect = false;
  const { id } = (await admin(s, 'GET')).body.pending;
  assert.deepEqual((await admin(s, 'POST', { id, action: 'release-expired' })).body, { recovered: true, cancelled: true });
  assert.equal((await admin(s, 'GET')).body.pending, null);
  assert.equal((await call(s, '/api/play/cipher', { 'X-PAYMENT': signedHeader({ from: b, value: '20000' }) })).status, 200);
});
