import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {check,commit,usage,resolveRule,reserveUnits,settleWeight,FIVE_HOURS,WEEK} from '../src/quota';
import type {Member,Policy} from '../src/types';
import {finishOAuth,parseSummary,refreshMother,seal,unseal,reconciliation} from '../src/mother-account';
import {hashToken} from '../src/security';

const adminToken='test-admin-'.padEnd(64,'x');
let mf:Miniflare, db:any;
const MIGRATIONS=[
  '0001_initial.sql','0002_mother_account.sql','0003_admin_google_login.sql','0004_zero_quota_floor.sql',
  '0005_adaptive_quota.sql','0006_member_deletion.sql','0007_initial_quota_usage.sql','0008_member_login.sql',
  '0009_family_connection.sql','0010_remove_family_connection.sql','0011_precision_billing.sql','0012_percentage_quota.sql'
];

before(async()=>{
  const clientScript=await readFile('public/client/agy-quota.mjs','utf8');
  mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',
    d1Databases:['DB'],bindings:{ADMIN_TOKEN:adminToken,ACCOUNT_ENCRYPTION_KEY:'a'.repeat(64)},
    serviceBindings:{
      ASSETS:async(request:any)=>new URL(request.url).pathname==='/client/agy-quota.mjs'
        ?new Response(clientScript,{headers:{'Content-Type':'text/javascript; charset=utf-8'}})
        :new Response('Not found',{status:404})
    }
  }));
  db=await mf.getD1Database('DB');
  const schema=(await Promise.all(MIGRATIONS.map(name=>readFile(`migrations/${name}`,'utf8')))).join('\n');
  for(const statement of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
});
after(async()=>{await mf?.dispose();});

const summary=(fraction=.9,atMs=Date.now())=>({groups:[
  {displayName:'Gemini',buckets:[
    {bucketId:'gemini-5h',window:'5h',remainingFraction:fraction,resetTime:new Date(atMs+3_600_000).toISOString()},
    {bucketId:'gemini-weekly',window:'weekly',remainingFraction:.95,resetTime:new Date(atMs+86_400_000).toISOString()}
  ]},
  {displayName:'Claude / GPT',buckets:[
    {bucketId:'3p-5h',window:'5h',remainingFraction:fraction,resetTime:new Date(atMs+3_600_000).toISOString()},
    {bucketId:'3p-weekly',window:'weekly',remainingFraction:.9,resetTime:new Date(atMs+86_400_000).toISOString()}
  ]}
]});

async function seedMother(atSec=Math.floor(Date.now()/1000),fraction=.95,status='connected') {
  const groups=parseSummary(summary(fraction,atSec*1000));
  await db.batch([
    db.prepare('DELETE FROM mother_account'),
    db.prepare('DELETE FROM real_quota_budgets'),
    db.prepare('INSERT INTO mother_account (id,email,credentials,status,snapshot_json,checked_at) VALUES (1,?,?,?,?,?)')
      .bind('mother@example.com','encrypted',status,JSON.stringify({groups,tier:'Pro'}),atSec*1000),
    ...reconciliation(groups,atSec).map(b=>
      db.prepare('INSERT INTO real_quota_budgets VALUES (?,?,?,?,?)').bind(b.pool,b.window,b.fraction,b.at,atSec+900)
    )
  ]);
}

beforeEach(async()=>{
  await db.batch([
    db.prepare('DELETE FROM usage_logs'),db.prepare('DELETE FROM members'),
    db.prepare('DELETE FROM policy'),db.prepare('INSERT INTO policy (id) VALUES (1)'),
    db.prepare('DELETE FROM mother_account'),db.prepare('DELETE FROM oauth_sessions'),
    db.prepare('DELETE FROM real_quota_budgets'),db.prepare('DELETE FROM admin_identity'),
    db.prepare('DELETE FROM admin_sessions'),db.prepare('DELETE FROM quota_calibration'),
    db.prepare('DELETE FROM quota_samples')
  ]);
  await seedMother();
});

async function request(path:string,token=adminToken,body?:unknown,method=body?'POST':'GET') {
  const r=await mf.dispatchFetch(`http://localhost${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:r.status,headers:r.headers,body:await r.json() as any};
}
async function member(overrides={}) {
  const res=await request('/api/admin/members',adminToken,{name:'测试成员',email:`member-${crypto.randomUUID()}@gmail.com`,...overrides});
  assert.equal(res.status,201);return res.body;
}
const call=(n=0,model='gemini-3.8-flash')=>({conversationId:'conversation-1',invocationNum:n,modelName:model});
async function row(m:any){return await db.prepare('SELECT * FROM members WHERE member_id=?').bind(m.member_id).first() as Member;}
async function policy(){return await db.prepare('SELECT * FROM policy WHERE id=1').first() as Policy;}

test('health and hook errors expose durations without creating usage records',async()=>{
  const health=await request('/health');
  assert.equal(health.status,200);
  assert.deepEqual(health.body,{ok:true,service:'agy-manager'});
  assert.match(health.headers.get('Server-Timing')!,/sql;dur=\d+(?:\.\d+)?/);
  assert.match(health.headers.get('Server-Timing')!,/app;dur=\d+(?:\.\d+)?/);
  const denied=await request('/check','invalid-diagnostic-token',{});
  assert.equal(denied.status,401);
  assert.match(denied.headers.get('Server-Timing')!,/^app;dur=\d+(?:\.\d+)?$/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_logs').first()).n,0);
});

test('retired family lookup and authorization endpoints are unavailable',async()=>{
  for(const [suffix,method] of [['','GET'],['/start','POST'],['/finish','POST'],['/refresh','POST'],['','DELETE']]) {
    assert.equal((await request('/api/admin/family'+suffix,adminToken,method==='POST'?{}:undefined,method)).status,404);
  }
});

test('API authenticates both roles, stores only token hash and validates identity fields',async()=>{
  assert.equal((await request('/api/admin/overview','bad')).status,401);
  const m=await member();
  assert.equal((await request('/api/admin/overview',m.token)).status,401);
  assert.equal((await request('/check','bad',call())).status,401);
  const expectedSha256=await hashToken(await readFile('public/client/agy-quota.mjs','utf8'));
  const validCheck=await request('/check',m.token,call());
  assert.equal(validCheck.status,200);
  assert.equal(validCheck.headers.get('X-Agy-Client-Sha256'),expectedSha256);
  assert.equal((await request('/commit',m.token,{modelName:'gemini-flash'})).status,400);
  assert.equal((await request('/check',m.token,{...call(),invocationNum:-1})).status,400);
  assert.equal((await request('/check',m.token,call(0,'unrecognized-model'))).status,422);
  assert.equal((await row(m)).token_hash.length,64);
  const view=await request('/api/admin/overview');
  assert.ok(!JSON.stringify(view.body).includes(m.token));
  assert.ok(!JSON.stringify(view.body).includes('token_hash'));
});

test('double-pool weights, percentage usage, and duplicate deliveries',async()=>{
  const m=await member();
  // Default seed rates: 5h = 0.1% per unit, week = 0.025% per unit.
  // Gemini: flash(1) + pro(3) = 4 units -> 5h 0.4%, week 0.1%
  // Third party: sonnet(3) + opus(8) + gpt-5(3) = 14 units -> 5h 1.4%, week 0.35%
  for(const [n,model] of ['gemini-flash','gemini-pro','claude-sonnet','claude-opus','gpt-5'].entries()){
    assert.notEqual((await request('/check',m.token,call(n,model))).body.terminationBehavior,'terminate');
    await request('/commit',m.token,call(n,model));
    await request('/commit',m.token,call(n,model));
  }
  const v=(await request('/api/admin/overview')).body;
  assert.deepEqual(v.members[0].usage.gemini,{fiveHour:0.4,week:0.1});
  assert.deepEqual(v.members[0].usage.third_party,{fiveHour:1.4,week:0.35});
  assert.equal(v.events.length,5);
  assert.equal(v.events[0].five_hour_percent,0.3); // gpt-5: 3 * 0.1% = 0.3%
});

test('A 50% / B 25% / C 25% allocation: parallel checks reserve atomically and cannot overspend member percentage share',async()=>{
  // At 0.1% per Flash unit, 0.8% member limit admits exact 8 parallel Flash calls:
  const m=await member({gemini_5h_limit:0.8,gemini_wk_limit:0.8});
  const results=await Promise.all(Array.from({length:20},(_,n)=>request('/check',m.token,call(n))));
  assert.equal(results.filter(r=>r.body.terminationBehavior!=='terminate').length,8);
  const v=(await request('/api/admin/overview')).body;
  assert.equal(v.members[0].usage.gemini.fiveHour,0.8);
});

test('family percentage caps include all members and withhold the safety buffer',async()=>{
  // Family 5h cap = 1.25%, buffer = 20% -> effective cap = 1.0% -> admits exact 10 Flash calls (0.1% each) across A & B:
  await request('/api/admin/policy',adminToken,{gemini_5h_limit:1.25,gemini_wk_limit:1.25,buffer_percent:20},'PATCH');
  const a=await member({gemini_5h_limit:50}), b=await member({gemini_5h_limit:50});
  const results=await Promise.all(Array.from({length:20},(_,n)=>request('/check',n%2?a.token:b.token,call(n))));
  assert.equal(results.filter(r=>r.body.terminationBehavior!=='terminate').length,10);
});

test('fixed fallback cycles reset independently without waiting for calls to age out',async()=>{
  // 5h limit = 0.1% (1 Flash call), week limit = 0.05% (2 Flash calls at 0.025%/unit):
  const m=await member({gemini_5h_limit:0.1,gemini_wk_limit:0.05}),mr=await row(m),p=await policy();
  const weekStart=345600+3000*WEEK,now=Math.ceil((weekStart+100)/FIVE_HOURS)*FIVE_HOURS;
  await seedMother(now,.95);
  await commit(db,mr,p,call(0),now-1);
  assert.notEqual((await check(db,mr,p,call(1),now) as any).terminationBehavior,'terminate');
  await commit(db,mr,p,call(1),now);
  await seedMother(now+FIVE_HOURS,.95);
  assert.equal((await check(db,mr,p,call(2),now+FIVE_HOURS) as any).terminationBehavior,'terminate');
  await seedMother(weekStart+WEEK,.95);
  assert.notEqual((await check(db,mr,p,call(3),weekStart+WEEK) as any).terminationBehavior,'terminate');
});

test('reservations expire, explicit errors and idle Stop release without charging',async()=>{
  const m=await member({gemini_5h_limit:0.1}),mr=await row(m),p=await policy(),now=Math.floor(Date.now()/1000);
  await seedMother(now,.95);
  await check(db,mr,p,call(),now);
  assert.equal((await check(db,mr,p,call(1),now+1) as any).terminationBehavior,'terminate');
  await seedMother(now+p.reservation_seconds,.95);
  assert.notEqual((await check(db,mr,p,call(1),now+p.reservation_seconds) as any).terminationBehavior,'terminate');
  await request('/release',m.token,{conversationId:'conversation-1',fullyIdle:true});
  await seedMother(Math.floor(Date.now()/1000),.95);
  await request('/check',m.token,call(4));
  await request('/commit',m.token,{...call(4),success:false});
  const v=(await request('/api/admin/overview')).body;
  assert.equal(v.members[0].usage.gemini.fiveHour,0);
});

test('late and offline commits preserve real usage, idempotency and original reserved weight',async()=>{
  const m=await member({gemini_5h_limit:0.1}),mr=await row(m),p=await policy(),now=2_000_000_000;
  await seedMother(now,.95);
  await check(db,mr,p,call(),now);
  await commit(db,mr,{...p,flash_weight:9},call(),now+100);
  await commit(db,mr,p,call(),now+200);
  await commit(db,mr,p,call(1),now+300);
  const records=(await db.prepare('SELECT * FROM usage_logs ORDER BY invocation_num').all()).results;
  assert.equal(records.length,2);assert.equal(records[0].weight,1);assert.equal(records[0].committed_at,now+100);
  assert.equal(records[1].source,'offline_commit');
});

test('one id cannot be reused for a different model; replayed check does not reserve twice',async()=>{
  const m=await member({gemini_5h_limit:0.1});
  await request('/check',m.token,call());
  assert.notEqual((await request('/check',m.token,call())).body.terminationBehavior,'terminate');
  assert.equal((await request('/commit',m.token,call(0,'claude-opus'))).status,409);
  assert.equal((await request('/check',m.token,call(0,'gemini-pro'))).status,409);
  assert.equal((await request('/api/admin/overview')).body.events.length,1);
});

test('percentage balance notification, weekly <20% warning, zero limits, disabling, and rotating tokens work',async()=>{
  // Flash costs 0.1% in 5h, 0.025% in 7d. Set 7d limit = 0.15% (6 Flash calls):
  const m=await member({gemini_5h_limit:50,gemini_wk_limit:0.15,tp_5h_limit:0});
  const firstTurn=await request('/check',m.token,call(0));
  assert.equal(firstTurn.body.injectSteps?.length,1);
  assert.match(firstTurn.body.injectSteps[0]?.systemMessage?.systemMessage ?? '',/【个人配额余额】/);
  assert.match(firstTurn.body.injectSteps[0]?.systemMessage?.metadata?.user_markdown ?? '',/【个人配额余额】.*个人 5h 0\.1%\/50%，7d 0\.025%\/0\.15%。本轮预冻结 5h 0\.1% \/ 7d 0\.025%，个人剩余可用 5h 49\.9% \/ 7d 0\.125%。/);
  await request('/commit',m.token,call(0));
  const contStep=await request('/check',m.token,call(1));
  assert.deepEqual(contStep.body.injectSteps,[]);
  await request('/commit',m.token,call(1));
  for(let n=2;n<5;n++)await request('/commit',m.token,call(n));
  const nextTurn=await request('/check',m.token,call(10000));
  assert.equal(nextTurn.body.injectSteps?.length,1);
  assert.match(nextTurn.body.injectSteps[0]?.systemMessage?.metadata?.user_markdown ?? '',/7d 0\.15%\/0\.15%.*配额余量不足 20%，请留意后续用量。/);
  const next=await request('/check',m.token,call(6));
  assert.equal(next.body.terminationBehavior,'terminate');
  assert.equal((await request('/check',m.token,call(7,'claude-opus'))).body.terminationBehavior,'terminate');
  await request(`/api/admin/members/${m.member_id}`,adminToken,{enabled:0},'PATCH');
  assert.equal((await request('/check',m.token,call(8))).body.terminationBehavior,'terminate');
  const rotated=await request(`/api/admin/members/${m.member_id}/rotate-token`,adminToken,{});
  assert.equal((await request('/check',m.token,call(9))).status,401);
  assert.equal((await request('/commit',rotated.body.token,call(8))).status,200);
});

test('racing completions with conflicting models cannot silently reuse the same id',async()=>{
  const m=await member();
  const results=await Promise.all([request('/commit',m.token,call(0,'gemini-flash')),request('/commit',m.token,call(0,'claude-opus'))]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await request('/api/admin/overview')).body.events.length,1);
});

test('deleting a member hides them, blocks new calls and preserves history, family usage and pending settlements',async()=>{
  const m=await member(), other=await member();
  await request('/commit',m.token,call());
  await request('/check',m.token,call(1));
  await request('/check',m.token,call(2));
  const path=`/api/admin/members/${m.member_id}`;
  assert.equal((await request(path,other.token,undefined,'DELETE')).status,401);
  const before=(await request('/api/admin/overview')).body;
  assert.equal((await request(path,adminToken,undefined,'DELETE')).status,200);
  const after=(await request('/api/admin/overview')).body;
  assert.deepEqual(after.members.map((m:any)=>m.member_id),[other.member_id]);
  assert.deepEqual(after.events,before.events);
  assert.deepEqual(after.pools.map((p:any)=>p.usage),before.pools.map((p:any)=>p.usage));
  assert.ok((await row(m)).deleted_at);assert.equal((await row(m)).enabled,0);
  const blocked=await request('/check',m.token,call(3));
  assert.equal(blocked.body.terminationBehavior,'terminate');
  assert.match(blocked.body.injectSteps[0].errorMessage.userMessage,/已删除/);
  assert.equal((await request(path,adminToken,{enabled:1},'PATCH')).status,404);
  assert.equal((await request(`${path}/rotate-token`,adminToken,{})).status,404);
  assert.equal((await request(path,adminToken,undefined,'DELETE')).status,404);
  assert.equal((await request('/commit',m.token,call(1))).status,200);
  assert.equal((await request('/release',m.token,{conversationId:'conversation-1',invocationNum:2})).status,200);
  const logs=(await db.prepare('SELECT status FROM usage_logs WHERE member_id=? ORDER BY invocation_num').bind(m.member_id).all()).results;
  assert.deepEqual(logs.map((l:any)=>l.status),['committed','committed','released']);
  assert.deepEqual(await usage(db,'gemini',Math.floor(Date.now()/1000)),{fiveHour:0.2,week:0.05});
});

test('malformed admin writes (including >100% limits) and oversized requests cannot change policy',async()=>{
  assert.equal((await request('/api/admin/policy',adminToken,{gemini_5h_limit:101},'PATCH')).status,400);
  assert.equal((await request('/api/admin/policy',adminToken,{buffer_percent:100},'PATCH')).status,400);
  assert.equal((await request('/api/admin/policy',adminToken,{flash_weight:0},'PATCH')).status,400);
  assert.equal((await request('/api/admin/policy',adminToken,{calibration_enabled:2},'PATCH')).status,400);
  assert.equal((await request('/api/admin/members',adminToken,{name:'x',email:'x@gmail.com',gemini_5h_limit:150})).status,400);
  assert.equal((await request('/api/admin/members',adminToken,{name:'x'.repeat(20000)})).status,413);
  assert.equal((await request('/health','')).status,200);
});

const accountEnv=()=>({DB:db,ADMIN_TOKEN:adminToken,ACCOUNT_ENCRYPTION_KEY:'a'.repeat(64)});

test('mother account gatekeeping: blocks disconnected, auth_required, >15m stale, or exhausted official balance; allows <=15m transient errors',async()=>{
  const m=await member({gemini_5h_limit:50,gemini_wk_limit:50});
  const nowSec=Math.floor(Date.now()/1000);

  // 1. Disconnected mother account -> blocked immediately:
  await db.batch([db.prepare('DELETE FROM mother_account'),db.prepare('DELETE FROM real_quota_budgets')]);
  const noMother=await request('/check',m.token,call(0));
  assert.equal(noMother.body.terminationBehavior,'terminate');
  assert.match(noMother.body.injectSteps[0].errorMessage.userMessage,/母账号未连接/);

  // 2. Transient upstream error within 15-minute grace window (e.g., 5 minutes = 300s ago) -> ALLOWED!
  await seedMother(nowSec-300,.8,'error');
  const inGrace=await request('/check',m.token,call(1));
  assert.notEqual(inGrace.body.terminationBehavior,'terminate');

  // 3. Snapshot older than 15 minutes (e.g., 960s ago) -> BLOCKED!
  await seedMother(nowSec-960,.8,'error');
  const staleBlock=await request('/check',m.token,call(2));
  assert.equal(staleBlock.body.terminationBehavior,'terminate');
  assert.match(staleBlock.body.injectSteps[0].errorMessage.userMessage,/同步超时/);

  // 4. Mother account OAuth revoked (auth_required) -> BLOCKED immediately even if checked_at is recent:
  await seedMother(nowSec,.8,'auth_required');
  const authBlock=await request('/check',m.token,call(3));
  assert.equal(authBlock.body.terminationBehavior,'terminate');
  assert.match(authBlock.body.injectSteps[0].errorMessage.userMessage,/母账号授权失效/);

  // 5. Official mother account balance exhausted or below buffer_percent -> BLOCKED:
  await request('/api/admin/policy',adminToken,{buffer_percent:10},'PATCH');
  await seedMother(nowSec,.1005,'connected'); // 10.05% official - 10% buffer = 0.05% left < 0.1% needed for Flash!
  const realHit=await request('/check',m.token,call(4));
  assert.equal(realHit.body.terminationBehavior,'terminate');
  assert.match(realHit.body.injectSteps[0].errorMessage.userMessage,/官方配额触底/);
});

test('mother account refresh pins exclusively to daily-cloudcode-pa, retries transient errors, and caches cloudaicompanionProject',async()=>{
  const env=accountEnv();
  await db.batch([db.prepare('DELETE FROM mother_account'),db.prepare('DELETE FROM real_quota_budgets')]);
  await db.prepare('INSERT INTO mother_account(id,email,credentials) VALUES(1,?,?)')
    .bind('mother@example.com',await seal(env,{access_token:'secret',refresh_token:'refresh',expires_at:Date.now()+3600_000})).run();
  const actualFetch=globalThis.fetch;
  const attempts:string[]=[];
  const quotaPayloads:any[]=[];
  let firstAttempt=true;
  globalThis.fetch=async(input:any,init:any)=>{
    const url=String(input);
    assert.ok(url.startsWith('https://daily-cloudcode-pa.googleapis.com/'),'Must query only authoritative Antigravity ledger');
    attempts.push(url);
    if(firstAttempt){firstAttempt=false;return new Response('{}',{status:503});}
    if(url.endsWith(':loadCodeAssist')) {
      return Response.json({paidTier:{id:'g1-ultra-tier'},cloudaicompanionProject:'companion-proj-123'});
    }
    if(url.endsWith(':retrieveUserQuotaSummary')) {
      quotaPayloads.push(JSON.parse(String(init.body)));
      return Response.json(summary(.88));
    }
    throw Error('Unexpected URL '+url);
  };
  try {
    const account=await refreshMother(env);
    assert.equal(account!.status,'connected');
    assert.equal(account!.snapshot!.tier,'g1-ultra-tier');
    assert.deepEqual(quotaPayloads[0],{project:'companion-proj-123'});
    assert.equal(attempts.length,3); // 1 transient 503 retry + loadCodeAssist + retrieveUserQuotaSummary

    // Second refresh within 1 hour skips redundant loadCodeAssist RPC and reuses cached project & tier!
    attempts.length=0;
    await db.prepare('UPDATE mother_account SET refresh_lock=0 WHERE id=1').run();
    const second=await refreshMother(env);
    assert.equal(second!.status,'connected');
    assert.equal(second!.snapshot!.tier,'g1-ultra-tier');
    assert.deepEqual(quotaPayloads[1],{project:'companion-proj-123'});
    assert.equal(attempts.length,1); // Only retrieveUserQuotaSummary!
  } finally {globalThis.fetch=actualFetch;}
});

test('cloud OAuth uses PKCE, rejects mismatched or replayed callbacks, encrypts tokens, reconciles real quota, and disconnect blocks calls',async()=>{
  const m=await member();
  assert.equal((await request('/api/admin/mother/login',m.token,{})).status,401);
  const login=await request('/api/admin/mother/login',adminToken,{}),url=new URL(login.body.url);
  const nonce=login.headers.get('Set-Cookie')!.split(';')[0].split('=')[1];
  const context={purpose:'mother' as const,browserHash:await hashToken(nonce)};
  assert.equal(login.body.manual_callback,true);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const state=url.searchParams.get('state')!,redirect=url.searchParams.get('redirect_uri')!;
  const wrong=`https://evil.example/oauth-callback?code=x&state=${state}`;
  assert.equal((await request('/api/admin/mother/callback',adminToken,{callback_url:wrong})).status,400);
  const actualFetch=globalThis.fetch;
  const callback=redirect+'?code=one-time-code&state='+state;
  let exchanges=0;
  globalThis.fetch=async(input:any,init:any)=>{
    const endpoint=String(input);
    if(endpoint==='https://oauth2.googleapis.com/token') {
      const form=init.body as URLSearchParams;assert.equal(form.get('redirect_uri'),redirect);
      const verifier=form.get('code_verifier')!;assert.ok(verifier.length>=43&&verifier.length<=128);
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
      assert.equal(Buffer.from(digest).toString('base64url'),url.searchParams.get('code_challenge'));exchanges++;
      return Response.json({access_token:'google-access-secret',refresh_token:'google-refresh-secret',expires_in:3600});
    }
    assert.equal(init.headers.Authorization,'Bearer google-access-secret');
    if(endpoint.includes('userinfo'))return Response.json({email:'mother@example.com',id:'google-mother-id',verified_email:true});
    if(endpoint.endsWith(':retrieveUserQuotaSummary'))return Response.json(summary(.8));
    if(endpoint.endsWith(':loadCodeAssist'))return Response.json({paidTier:{id:'g1-pro-tier'}});
    throw Error('Unexpected outbound URL');
  };
  try {
    const res=await finishOAuth(accountEnv(),callback,context);assert.equal(res.status,200);
    const account=(await res.json() as any).account;
    assert.equal(account.email,'mother@example.com');assert.equal(account.snapshot.groups.length,2);
    assert.ok(!JSON.stringify(account).includes('secret'));
    const stored=await db.prepare('SELECT credentials FROM mother_account').first();
    assert.ok(!stored.credentials.includes('google-'));
    assert.equal((await unseal<any>(accountEnv(),stored.credentials)).refresh_token,'google-refresh-secret');
    assert.equal((await policy()).real_quota_guard,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM real_quota_budgets').first()).n,4);
    await assert.rejects(()=>finishOAuth(accountEnv(),callback,context),/过期或已使用/);assert.equal(exchanges,1);
    const view=(await request('/api/admin/overview')).body;
    assert.ok(!JSON.stringify(view).includes('google-access'));
    assert.deepEqual(view.pools.map((p:any)=>p.usage),[{fiveHour:0,week:0},{fiveHour:0,week:0}]);
    assert.ok(view.pools[0].realBudget.fiveHour.remainingPercent>0);
    assert.notEqual((await request('/check',m.token,call())).body.terminationBehavior,'terminate');
    await request('/api/admin/mother',adminToken,undefined,'DELETE');
    assert.equal((await request('/check',m.token,call(1))).body.terminationBehavior,'terminate');
  } finally {globalThis.fetch=actualFetch;}
});

test('cumulative interval calibration learns even with active in-flight calls and governs percentage admission',async()=>{
  const at=Math.floor(Date.now()/1000)-60,m=await member({gemini_5h_limit:50,gemini_wk_limit:50}),mr=await row(m);
  const p=await policy(),env=accountEnv(),fetchBefore=globalThis.fetch,clockBefore=Date.now;
  let fraction=.9,weekly=.9;
  await db.batch([db.prepare('DELETE FROM mother_account'),db.prepare('DELETE FROM real_quota_budgets')]);
  await db.prepare('INSERT INTO mother_account(id,email,credentials) VALUES(1,?,?)')
    .bind('mother@example.com',await seal(env,{access_token:'secret',refresh_token:'refresh',expires_at:clockBefore()+3600_000})).run();
  globalThis.fetch=async(input:any)=>{
    if(String(input).endsWith(':loadCodeAssist'))return Response.json({});
    const value=summary(fraction,at*1000);
    value.groups[0].buckets[0].resetTime=new Date((at+FIVE_HOURS)*1000).toISOString();
    value.groups[0].buckets[1].resetTime=new Date((at+WEEK)*1000).toISOString();
    value.groups[0].buckets[1].remainingFraction=weekly;
    return Response.json(value);
  };
  try {
    Date.now=()=>at*1000;await refreshMother(env);
    // Commit 10 Flash calls (10 units) AND leave 1 call in-flight (reserved) during Cron tick!
    for(let n=0;n<10;n++){
      assert.notEqual((await check(db,mr,p,call(n),at+10)).terminationBehavior,'terminate');
      await commit(db,mr,p,call(n),at+11);
    }
    assert.notEqual((await check(db,mr,p,call(99),at+35)).terminationBehavior,'terminate');
    // At at+60 (49s after commits > 20s lag window), upstream dropped 10% in 5h (.9 -> .8) and 1% in week (.9 -> .89):
    fraction=.8;weekly=.89;Date.now=()=>(at+60)*1000;await refreshMother(env);
  } finally {globalThis.fetch=fetchBefore;Date.now=clockBefore;}

  const view=(await request('/api/admin/overview')).body;
  const rate=view.pools[0].realBudget;
  // Upper rate for 5h = (0.10 + 0.002) / 10 = 0.0102 (1.02% per unit)!
  assert.ok(Math.abs(rate.fiveHour.upperFractionPerUnit-0.0102)<1e-9);
  assert.equal(rate.fiveHour.source,'learned');
  assert.equal(rate.fiveHour.sampleCount,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quota_samples').first()).n,2);

  // Turning calibration off reverts to initial seed upper bound (0.1% / 0.025%), and re-enabling restores learned bound:
  await request('/api/admin/policy',adminToken,{calibration_enabled:0},'PATCH');
  const manual=(await request('/api/admin/overview')).body.pools[0].realBudget;
  assert.equal(manual.fiveHour.upperPercentPerUnit,.1);assert.equal(manual.week.upperPercentPerUnit,.025);
  assert.equal(manual.fiveHour.source,'disabled');
  await request('/api/admin/policy',adminToken,{calibration_enabled:1},'PATCH');
  assert.equal((await request('/api/admin/overview')).body.pools[0].realBudget.fiveHour.upperFractionPerUnit,rate.fiveHour.upperFractionPerUnit);
});

test('official 5h and weekly resets independently clear family and member percentage usage while retaining history and in-flight holds',async()=>{
  const at=Math.floor(Date.now()/1000),m=await member(),mr=await row(m),env=accountEnv();
  const p=await policy(),fetchBefore=globalThis.fetch,clockBefore=Date.now;
  let fraction=.8,weekly=.9,fiveReset=at+60,weekReset=at+180;
  await db.batch([db.prepare('DELETE FROM mother_account'),db.prepare('DELETE FROM real_quota_budgets')]);
  await db.prepare('INSERT INTO mother_account(id,email,credentials) VALUES(1,?,?)')
    .bind('mother@example.com',await seal(env,{access_token:'secret',refresh_token:'refresh',expires_at:clockBefore()+3600_000})).run();
  globalThis.fetch=async(input:any)=>{
    if(String(input).endsWith(':loadCodeAssist'))return Response.json({});
    const value=summary(fraction,at*1000);
    value.groups[0].buckets[0].resetTime=new Date(fiveReset*1000).toISOString();
    value.groups[0].buckets[1].resetTime=new Date(weekReset*1000).toISOString();
    value.groups[0].buckets[1].remainingFraction=weekly;return Response.json(value);
  };
  try {
    Date.now=()=>at*1000;await refreshMother(env);
    await commit(db,mr,p,call(0),at+10);
    await check(db,mr,p,call(1),at+20);
    assert.deepEqual(await usage(db,'gemini',at+30,m.member_id),{fiveHour:0.2,week:0.05});
    fraction=1;fiveReset+=FIVE_HOURS;Date.now=()=>(at+60)*1000;await refreshMother(env);
    assert.deepEqual(await usage(db,'gemini',at+61,m.member_id),{fiveHour:0.1,week:0.05});
    await commit(db,mr,p,call(1),at+70);
    weekly=1;weekReset+=WEEK;fraction=.99;Date.now=()=>(at+180)*1000;await refreshMother(env);
    assert.deepEqual(await usage(db,'gemini',at+181,m.member_id),{fiveHour:0.1,week:0});
    assert.deepEqual(await usage(db,'gemini',at+181),{fiveHour:0.1,week:0});
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_logs').first()).n,2);
    fraction=1;Date.now=()=>(at+240)*1000;await refreshMother(env);
    assert.deepEqual(await usage(db,'gemini',at+241,m.member_id),{fiveHour:0,week:0});
  } finally {globalThis.fetch=fetchBefore;Date.now=clockBefore;}
});

test('token rotation survives quota failure and authentication expiry immediately sets auth_required',async()=>{
  const env=accountEnv();
  await db.batch([db.prepare('DELETE FROM mother_account'),db.prepare('DELETE FROM real_quota_budgets')]);
  await db.prepare('INSERT INTO mother_account (id,email,credentials) VALUES (1,?,?)')
    .bind('mother@example.com',await seal(env,{access_token:'expired',refresh_token:'old-refresh',expires_at:0})).run();
  const actualFetch=globalThis.fetch;
  globalThis.fetch=async(input:any)=>String(input).includes('oauth2.googleapis.com')?
    Response.json({access_token:'new-access',refresh_token:'rotated-refresh',expires_in:3600}):new Response('{}',{status:503});
  try {
    const account=await refreshMother(env);assert.equal(account!.status,'error');
    const stored=await db.prepare('SELECT credentials FROM mother_account').first();
    assert.equal((await unseal<any>(env,stored.credentials)).refresh_token,'rotated-refresh');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM real_quota_budgets').first()).n,0);
    await db.prepare('UPDATE mother_account SET credentials=?').bind(await seal(env,{access_token:'expired',refresh_token:'revoked',expires_at:0})).run();
    globalThis.fetch=async()=>new Response('{}',{status:400});
    assert.equal((await refreshMother(env))!.status,'auth_required');
  } finally {globalThis.fetch=actualFetch;}
  assert.throws(()=>parseSummary({groups:[]}));
  assert.throws(()=>parseSummary(summary(1.01)));
  assert.equal(parseSummary(summary(0))[0].buckets[0].remaining_fraction,0);
});

test('Option B context-aware reservation, cold-cache smooth settlement, uncapped scaling, and strict no-overdraft admission',async()=>{
  // Give member 0.5% in 5h, 20% in week (seed rate = 0.1%/unit -> 5 units budget):
  const m=await member({gemini_5h_limit:0.5,gemini_wk_limit:20}),p=await policy();

  // 1. Model & effort tier differentiation:
  assert.equal(resolveRule('gemini-4-carbon-low',p).weight,1.35);
  assert.equal(resolveRule('Gemini 4 Carbon (Low)',p).weight,1.35);
  assert.equal(resolveRule('gemini-4-carbon-medium',p).weight,2.25);
  assert.equal(resolveRule('gemini-4-argon-medium',p).weight,3.45);
  assert.equal(resolveRule('gemini-4-argon-high',p).weight,5.175);
  assert.equal(resolveRule('claude-4-opus-high',p).weight,12);

  // 2. Context-aware reservation scaling, smooth 5-min cold-cache re-prefill, and uncapped large turns:
  assert.equal(reserveUnits(1,0),1);
  assert.equal(reserveUnits(1,300_000),1.4); // (25000 + 45000)/50000 = 1.4x
  // 5-min implicit cache expiry on 245k context (~4.84 units vs ~2.12 warm) avoids 8x-10x single-step explosion:
  const coldMiss=settleWeight(3.375,{...call(0,'gemini-4-carbon-high'),inputTokens:245_364,cacheReadTokens:0,outputTokens:417});
  assert.ok(coldMiss>4.5&&coldMiss<5.2,`Expected smooth cold-cache settlement ~4.84, got ${coldMiss}`);
  // Very large turn is still strictly uncapped (>2.5x baseline):
  const hugeTurn=settleWeight(3,{...call(0,'gemini-pro'),inputTokens:1_000_000,cacheReadTokens:0,outputTokens:20_000});
  assert.ok(hugeTurn>18,`Expected uncapped settlement > 18 units, got ${hugeTurn}`);

  // 3. Short Q&A with cached prompt reserves 2.25 * 0.1% = 0.225%, then settles linearly to ~0.123 * 0.1% = ~0.012%:
  const c0=await request('/check',m.token,call(0,'gemini-4-carbon-medium'));
  assert.notEqual(c0.body.terminationBehavior,'terminate');
  let v=(await request('/api/admin/overview')).body;
  assert.equal(v.members[0].usage.gemini.fiveHour,0.225);
  await request('/commit',m.token,{...call(0,'gemini-4-carbon-medium'),inputTokens:100,cacheReadTokens:13400,outputTokens:160,toolCalls:0});
  v=(await request('/api/admin/overview')).body;
  assert.ok(v.members[0].usage.gemini.fiveHour>0.01&&v.members[0].usage.gemini.fiveHour<0.02,`got ${v.members[0].usage.gemini.fiveHour}`);

  // 4. Strict no-overdraft admission (no last-drop exemption!):
  // Commit inputTokens=25_000, outputTokens=8_500 on gemini-pro (weight=3):
  // effectiveTokens = 500 + 25_000 + 42_500 = 68_000 -> 3 * 1.36 = 4.08 units = 0.408%!
  // Total usedPct ≈ 0.012 + 0.408 = 0.420% -> ~0.080% remaining in 0.5% budget!
  await request('/commit',m.token,{...call(1,'gemini-pro'),inputTokens:25_000,cacheReadTokens:0,outputTokens:8_500,toolCalls:0});
  v=(await request('/api/admin/overview')).body;
  const usedPct=v.members[0].usage.gemini.fiveHour;
  assert.ok(usedPct>0.41&&usedPct<0.43,`usedPct=${usedPct}`);

  // Expensive model (gemini-4-argon-high needs >= 0.518%) MUST BE BLOCKED (no last-drop overdraft!):
  const heavyBlocked=await request('/check',m.token,call(2,'gemini-4-argon-high'));
  assert.equal(heavyBlocked.body.terminationBehavior,'terminate','Expensive model exceeding remaining % must be rejected');
  assert.match(heavyBlocked.body.injectSteps[0].errorMessage.userMessage,/家庭配额上限/);

  // Meanwhile, a lighter model (gemini-4-flash-low on a fresh conversation: weight 0.6 -> needs 0.06% <= 0.08% remaining) IS ADMITTED!
  const lightAllowed=await request('/check',m.token,{conversationId:'fresh-light-conv',invocationNum:0,modelName:'gemini-4-flash-low'});
  assert.notEqual(lightAllowed.body.terminationBehavior,'terminate','Light model that fits within remaining % should be admitted');

  // Now remaining is ~0.02% (< 0.06%), so another Flash Low call is strictly blocked:
  const exhausted=await request('/check',m.token,{conversationId:'fresh-light-conv-2',invocationNum:0,modelName:'gemini-4-flash-low'});
  assert.equal(exhausted.body.terminationBehavior,'terminate');

  // Releasing the light reservation restores the 0.06% headroom:
  await request('/release',m.token,{conversationId:'fresh-light-conv',invocationNum:0});
  const afterRelease=await request('/check',m.token,{conversationId:'fresh-light-conv',invocationNum:0,modelName:'gemini-4-flash-low'});
  assert.notEqual(afterRelease.body.terminationBehavior,'terminate');
});
