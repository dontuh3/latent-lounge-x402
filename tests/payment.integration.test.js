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

const root = path.resolve(import.meta.dirname, '..');
const receiver = '0x' + '0'.repeat(40), a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40);
// The real x402-express package calls this LOCAL facilitator. It deliberately
// simulates settlement; this suite does not test cryptography or move money.
async function setup(t, fixtures = {}) {
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
      state.settlements++;
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
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ADMIN_KEY:'local-test-admin', PAY_TO_ADDRESS: receiver, NETWORK: 'base-sepolia', PORT: String(port), DATA_DIR: dir, FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}`, BACKUP_FIRST_RUN_MS: '600000' }, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd); const readLog = () => fs.readFileSync(logFile, 'utf8');
  t.after(async () => { child.kill(); if(child.exitCode===null) await once(child,'exit'); facilitator.closeAllConnections(); await new Promise(r => facilitator.close(r)); const target=fs.realpathSync(dir), parent=fs.realpathSync(os.tmpdir()); if(path.dirname(target)===parent && path.basename(target).startsWith('lounge-test-')) fs.rmSync(target,{recursive:true,force:true}); });
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

test('a rejected settlement releases the name reservation', async t => {
  const s = await setup(t); s.state.reject = true;
  assert.equal((await s.request('/api/play/sequence?designation=retry-name', a)).status, 402);
  s.state.reject = false;
  assert.equal((await s.request('/api/play/sequence?designation=retry-name', b)).status, 200);
});
test('free samples never enter the paid pending store', async t => {
  const s=await setup(t);const sample=await s.request('/api/sample/sequence');await s.request('/api/play/sequence?designation=sample-test',a);
  const pending=JSON.parse(fs.readFileSync(path.join(s.dir,'pending-puzzles.json')));assert.equal(pending[sample.body.puzzleId],undefined);
});
test('corrupt ledgers return unavailable and preserve the damaged bytes',async t=>{
 const s=await setup(t);const file=path.join(s.dir,'leaderboard.json');fs.writeFileSync(file,'{broken');const r=await s.request('/api/leaderboard');assert.equal(r.status,503);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('rejected settlement creates no plaque or identity',async t=>{
 const s=await setup(t);s.state.reject=true;const r=await s.request('/api/plaque',a,{designation:'reject-test',inscription:'test'});assert.equal(r.status,402);assert.equal(r.settled,false);assert.equal(fs.existsSync(path.join(s.dir,'plaques.json')),false);assert.equal(fs.existsSync(path.join(s.dir,'names.json')),false);
});

test('every free generator withholds its solution until submission', async t => {
  const s = await setup(t);
  for (const game of ['walk','automaton','constraint','sequence','logic','induction','cipher']) {
    const sample = await s.request(`/api/sample/${game}`);
    assert.equal(sample.status, 200, game);
    for (const key of ['answer','solution','explanation']) assert.equal(sample.body[key], undefined, `${game} leaked ${key}`);
    assert.equal(sample.body.generatorVersion, '2026-09-20.2');
    assert.equal(sample.body.difficulty.calibrated, false);
    const result = await s.request('/api/check', null, {puzzleId:sample.body.puzzleId,guess:'deliberately incorrect'});
    assert.equal(result.status,200); assert.equal(result.body.correct,false);
    assert.equal(typeof result.body.answer,'string'); assert.ok(result.body.explanation.summary);
    assert.equal((await s.request('/api/check',null,{puzzleId:sample.body.puzzleId,guess:result.body.answer})).status,410);
  }
  assert.equal(fs.existsSync(path.join(s.dir,'leaderboard.json')),false);
  assert.equal(fs.existsSync(path.join(s.dir,'pending-puzzles.json')),false);
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
  const s=await setup(t); const sample=await s.request('/api/sample/walk');
  let release; s.state.verifyWait=new Promise(resolve=>{release=resolve;});s.state.verifyReject=true;
  const payment=s.request('/api/play/cipher',a);
  while(!s.state.verifyEntered) await new Promise(resolve=>setTimeout(resolve,10));
  try {
    const res=await fetch(s.base+'/api/menu',{signal:AbortSignal.timeout(1500)});assert.equal(res.status,200);
    const answer=await fetch(s.base+'/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({puzzleId:sample.body.puzzleId,guess:'wrong'}),signal:AbortSignal.timeout(1500)});assert.equal(answer.status,200);
  } finally {release();}
  assert.equal((await payment).status,402);assert.equal(s.state.settlements,0);
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
