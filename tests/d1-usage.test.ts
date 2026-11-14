import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker from '../src/index';
import {refreshMother,seal,parseSummary,reconciliation} from '../src/mother-account';
import {hashToken} from '../src/security';
import {createMemberSession} from '../src/admin-session';
import {overviewUsage,usage} from '../src/quota';
import {activeUsageSql,cycleStartSql,upperRateSql,type CalibrationState,type QuotaObservation} from '../src/quota-state';
import {evidenceStatement} from '../src/calibration-evidence';
import type {Env} from '../src/types';
import {applyMigrations} from './helpers/migrations';

let mf:Miniflare,db:D1Database;
const originalFetch=globalThis.fetch,originalNow=Date.now;
const at=2_000_000_000,adminToken='performance-admin-token'.padEnd(64,'x');
const summary={groups:['Gemini','Claude / GPT'].map(displayName=>({displayName,buckets:[
  {bucketId:displayName+'-5h',window:'5h',remainingFraction:.9,resetTime:new Date((at+3600)*1000).toISOString()},
  {bucketId:displayName+'-weekly',window:'weekly',remainingFraction:.95,resetTime:new Date((at+86400)*1000).toISOString()}
]}))};
const env=(database=db):Env=>({DB:database,ADMIN_TOKEN:adminToken,ACCOUNT_ENCRYPTION_KEY:'a'.repeat(64)});

// Use D1's real row counters, including first() and transactional batch() calls.
function metered(database:D1Database,beforeRun?:(sql:string)=>Promise<void>) {
  const totals={read:0,written:0};
  const inner=new WeakMap<object,{statement:D1PreparedStatement;sql:string}>();
  const record=(r:D1Result)=>{totals.read+=r.meta.rows_read;totals.written+=r.meta.rows_written;return r;};
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const wrapped={
      bind:(...values:unknown[])=>wrap(statement.bind(...values),sql),
      all:async()=>record(await statement.all()),
      run:async()=>{await beforeRun?.(sql);return record(await statement.run());},
      first:async(column?:string)=>{
        const r=record(await statement.all());
        return r.results.length?(column?r.results[0][column]:r.results[0]):null;
      }
    } as D1PreparedStatement;
    inner.set(wrapped,{statement,sql});return wrapped;
  };
  return {totals,database:{
    prepare:(sql:string)=>wrap(database.prepare(sql),sql),
    batch:async(statements:D1PreparedStatement[])=>{
      const items=statements.map(s=>inner.get(s)!);
      for(const item of items)await beforeRun?.(item.sql);
      return (await database.batch(items.map(item=>item.statement))).map(record);
    }
  } as D1Database};
}

before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  db=await mf.getD1Database('DB') as unknown as D1Database;
  await applyMigrations(db);
});
after(async()=>{await mf?.dispose();});
beforeEach(async()=>{
  Date.now=()=>at*1000;
  for(const table of ['member_sessions','usage_logs','members','mother_account','real_quota_budgets','quota_calibration','quota_samples'])await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('UPDATE policy SET calibration_enabled=1 WHERE id=1').run();
  for(const table of ['usage_totals','usage_cycles','calibration_totals'])await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('UPDATE usage_activity SET last_activity_at=0').run();
  await db.prepare('INSERT INTO members(member_id,name,email,token_hash,created_at) VALUES (?,?,?,?,?)')
    .bind('m','Member','member@example.com',await hashToken('member-token'),at).run();
  const groups=parseSummary(summary);
  await db.prepare('INSERT INTO mother_account(id,email,credentials,status,snapshot_json,checked_at,attempted_at) VALUES (1,?,?,?,?,?,?)')
    .bind('mother@example.com',await seal(env(),{access_token:'test',refresh_token:'test-refresh',expires_at:(at+3600)*1000}),
      'connected',JSON.stringify({groups,tier:'Pro',project:'project'}),(at-120)*1000,(at-120)*1000).run();
  await db.batch(reconciliation(groups,at-120).map(b=>db.prepare('INSERT INTO real_quota_budgets VALUES (?,?,?,?,?)')
    .bind(b.pool,b.window,b.fraction,b.at,b.at+900)));
  globalThis.fetch=async()=>Response.json(summary);
});
afterEach(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;});

async function overview(database:D1Database) {
  const response=await worker.fetch(new Request('https://quota.example/api/admin/overview',{headers:{Authorization:`Bearer ${adminToken}`}}),env(database));
  assert.equal(response.status,200);return await response.json() as any;
}

test('overview and synchronization avoid scanning archived usage',async t=>{
  await refreshMother(env());
  // 5,000 old calls must stay in history without being scanned by current totals.
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    SELECT 'm','gemini','gemini-flash',1,'archived',x,'committed',?,?,? FROM n`)
    .bind(at-2_000_000,at-2_000_000,at-2_000_000).run();
  const stats=metered(db),view=await overview(stats.database);
  assert.deepEqual(view.members[0].usage.gemini,{fiveHour:0,week:0});
  assert.equal(view.events.length,80);
  t.diagnostic(`overview with 5,000 archived calls: ${JSON.stringify(stats.totals)}`);
  Date.now=()=>(at+60)*1000;
  const sync=metered(db);await refreshMother(env(sync.database));
  t.diagnostic(`sync with 5,000 archived calls: ${JSON.stringify(sync.totals)}`);
  assert.ok(stats.totals.read<1000,`overview read ${stats.totals.read} rows`);
  assert.ok(sync.totals.read<200,`sync read ${sync.totals.read} rows`);
});

test('repeated and concurrent refreshes reuse a recent snapshot without writes',async t=>{
  let outbound=0;
  globalThis.fetch=async()=>{outbound++;return Response.json(summary);};
  await refreshMother(env());
  const stats=metered(db);
  await Promise.all(Array.from({length:4},()=>refreshMother(env(stats.database))));
  t.diagnostic(`duplicate refreshes: ${JSON.stringify(stats.totals)}`);
  assert.equal(outbound,1);
  assert.equal(stats.totals.written,0);
  // At the next scheduled minute, still permit a refresh.
  Date.now=()=>(at+60)*1000;await refreshMother(env());assert.equal(outbound,2);
});

test('overview reads cumulative totals even when recent calls keep changing',async t=>{
  await refreshMother(env());
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    SELECT 'm','gemini','gemini-flash',0.001,'recent',x,'committed',?,?,? FROM n`)
    .bind(at-60,at-60,at-60).run();
  const stats=metered(db),view=await overview(stats.database);
  assert.deepEqual(view.members[0].usage.gemini,{fiveHour:.1,week:.025});
  assert.deepEqual(view.pools[0].usage,view.members[0].usage.gemini);
  t.diagnostic(`overview with 1,000 recent calls: ${JSON.stringify(stats.totals)}`);
  assert.ok(stats.totals.read<350,`overview read ${stats.totals.read} rows`);
  await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    VALUES('m','gemini','gemini-flash',.001,'new-call',1,'committed',?,?,?)`).bind(at-60,at-60,at-60).run();
  const repeated=metered(db);
  Date.now=()=>(at+30)*1000;
  const refreshed=await overview(repeated.database);
  assert.deepEqual(refreshed.members[0].usage.gemini,{fiveHour:.1,week:.025});
  t.diagnostic(`overview after another commit: ${JSON.stringify(repeated.totals)}`);
  assert.ok(repeated.totals.read<350,`updated overview read ${repeated.totals.read} rows`);
  assert.equal(repeated.totals.written,0);
});

test('member history reads only the latest page even with thousands of archived calls',async t=>{
  const cookie=await createMemberSession(new Request('https://quota.example'),env(),'member@example.com','google-member');
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    SELECT 'm','gemini','gemini-flash',1,'history',x,'committed',?,?,? FROM n`)
    .bind(at-2_000_000,at-2_000_000,at-2_000_000).run();
  const stats=metered(db);
  const response=await worker.fetch(new Request('https://quota.example/api/member/overview',{headers:{Cookie:cookie.split(';')[0]}}),env(stats.database));
  assert.equal(response.status,200);
  const view=await response.json() as any;
  assert.equal(view.events.length,80);
  assert.ok(view.events[0].id>view.events[79].id);
  t.diagnostic(`member overview with 5,000 archived calls: ${JSON.stringify(stats.totals)}`);
  assert.ok(stats.totals.read<500,`member overview read ${stats.totals.read} rows`);
});

test('overview totals follow ledger mutations, reservation expiry, rates and official resets',async()=>{
  await refreshMother(env());
  const compare=async(now=at)=>{
    const totals=await overviewUsage(db,'gemini',now);
    // Compare against a separate full-ledger sum, not the cumulative read path.
    const five=cycleStartSql('gemini','fiveHour',now),week=cycleStartSql('gemini','week',now);
    const expected=await db.prepare(`SELECT
      ROUND(COALESCE(SUM(CASE WHEN status='committed' AND committed_at>=${five} OR status='reserved' AND expires_at>${now} THEN CAST(ROUND(weight*1000) AS INTEGER) ELSE 0 END),0)/1000.0*${upperRateSql('gemini','fiveHour')}*100,3) AS fiveHour,
      ROUND(COALESCE(SUM(CASE WHEN status='committed' AND committed_at>=${week} OR status='reserved' AND expires_at>${now} THEN CAST(ROUND(weight*1000) AS INTEGER) ELSE 0 END),0)/1000.0*${upperRateSql('gemini','week')}*100,3) AS week
      FROM usage_logs WHERE pool_group='gemini'`).first();
    assert.deepEqual(totals.family,expected);
    assert.deepEqual(totals.members.get('m')??{fiveHour:0,week:0},await usage(db,'gemini',now,'m'));
    return totals;
  };
  await compare();
  await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at)
    VALUES('m','gemini','gemini-flash',1,'mutations',1,'reserved',?,?)`).bind(at,at+10).run();
  assert.equal((await compare()).family.fiveHour,.1);
  await db.prepare("UPDATE usage_logs SET status='released' WHERE conversation_id='mutations'").run();
  assert.equal((await compare()).family.fiveHour,0);
  await db.prepare("UPDATE usage_logs SET status='reserved' WHERE conversation_id='mutations'").run();
  assert.equal((await compare()).family.fiveHour,.1);
  assert.equal((await compare(at+10)).family.fiveHour,0);
  await db.prepare("UPDATE usage_logs SET status='committed',weight=2,committed_at=? WHERE conversation_id='mutations'").bind(at+11).run();
  assert.equal((await compare(at+11)).family.fiveHour,.2);
  await db.prepare("UPDATE quota_calibration SET upper_fraction_per_unit=.002 WHERE pool_group='gemini'").run();
  assert.equal((await compare(at+12)).family.fiveHour,.4);
  await db.prepare("UPDATE policy SET calibration_enabled=0 WHERE id=1").run();
  assert.equal((await compare(at+12)).family.fiveHour,.2);
  await db.prepare("UPDATE quota_calibration SET cycle_started_at=? WHERE pool_group='gemini' AND window_name='fiveHour'").bind(at+12).run();
  assert.equal((await compare(at+12)).family.fiveHour,0);
  // Reset moves the window without mutating the ledger.
  const reset=at+3600;
  assert.equal((await compare(reset)).family.fiveHour,0);
  assert.equal((await compare(reset)).family.week,.05);
  await db.prepare('DELETE FROM usage_logs').run();
  assert.equal((await compare(reset)).family.week,0);
});

test('ledger edits update cumulative totals and roll back atomically on failure',async()=>{
  await refreshMother(env());
  await overviewUsage(db,'gemini',at);
  const insert=()=>db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    VALUES('m','gemini','gemini-flash',1,'racing',1,'committed',?,?,?)`).bind(at,at,at);
  await assert.rejects(db.batch([insert(),db.prepare('UPDATE missing_table SET value=1')]));
  assert.equal((await overviewUsage(db,'gemini',at)).family.fiveHour,0);
  await insert().run();
  assert.equal((await overviewUsage(db,'gemini',at)).family.fiveHour,.1);
  await db.prepare("UPDATE usage_logs SET pool_group='third_party' WHERE conversation_id='racing'").run();
  assert.equal((await overviewUsage(db,'gemini',at)).family.fiveHour,0);
  assert.equal((await overviewUsage(db,'third_party',at)).family.fiveHour,.1);
});

test('cold and cached totals preserve ledger SQL rounding at fractional boundaries',async()=>{
  for(const weight of [.005,.045,.075,.095,.115,.285,1.005]) {
    await db.prepare('DELETE FROM usage_logs').run();
    await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
      VALUES('m','gemini','gemini-flash',?,'rounding',1,'committed',?,?,?)`).bind(weight,at,at,at).run();
    const expected=await usage(db,'gemini',at);
    for(let read=0;read<2;read++)assert.deepEqual((await overviewUsage(db,'gemini',at)).family,expected,`weight ${weight}, read ${read}`);
  }
});

test('overlapping refreshes share the database lock and remove disappeared budget windows',async()=>{
  let outbound=0;
  globalThis.fetch=async()=>{outbound++;return Response.json(summary);};
  await Promise.all(Array.from({length:4},()=>refreshMother(env())));
  assert.equal(outbound,1);
  Date.now=()=>(at+60)*1000;
  globalThis.fetch=async()=>Response.json({groups:[summary.groups[0]]});
  await refreshMother(env());
  const budgets=await db.prepare('SELECT pool_group FROM real_quota_budgets').all<{pool_group:string}>();
  assert.deepEqual(budgets.results.map(r=>r.pool_group),['gemini','gemini']);
});

test('upstream failures back off without changing the last successful quota snapshot',async()=>{
  let outbound=0;
  globalThis.fetch=async()=>{outbound++;return new Response('{}',{status:503});};
  const failed=await refreshMother(env());
  assert.equal(failed!.status,'error');assert.equal(outbound,2);
  const stats=metered(db);await refreshMother(env(stats.database));
  assert.equal(outbound,2);assert.equal(stats.totals.written,0);
  assert.equal((await db.prepare('SELECT snapshot_at FROM real_quota_budgets LIMIT 1').first<{snapshot_at:number}>())!.snapshot_at,at-120);
  Date.now=()=>(at+60)*1000;
  globalThis.fetch=async()=>Response.json(summary);
  assert.equal((await refreshMother(env()))!.status,'connected');
});

test('refresh updates existing budget rows instead of deleting and recreating them',async t=>{
  await refreshMother(env());
  Date.now=()=>(at+60)*1000;
  const stats=metered(db);await refreshMother(env(stats.database));
  t.diagnostic(`steady-state sync: ${JSON.stringify(stats.totals)}`);
  assert.ok(stats.totals.written<=14,`sync wrote ${stats.totals.written} rows`);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM real_quota_budgets').first<{n:number}>())!.n,4);
});

test('background calibration does not rescan unchanged calls after activity stops',async t=>{
  await refreshMother(env());
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    SELECT 'm','gemini','gemini-flash',0.001,'background',x,'committed',?,?,? FROM n`)
    .bind(at+1,at+1,at+1).run();
  Date.now=()=>(at+60)*1000;
  const active=metered(db);await refreshMother(env(active.database));
  t.diagnostic(`first sync after 1,000 calls: ${JSON.stringify(active.totals)}`);
  Date.now=()=>(at+120)*1000;
  const idle=metered(db);await refreshMother(env(idle.database));
  t.diagnostic(`idle background sync with 1,000 unchanged calls: ${JSON.stringify(idle.totals)}`);
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100)
    INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    SELECT 'm','gemini','gemini-flash',0.001,'more-background',x,'committed',?,?,? FROM n`)
    .bind(at+121,at+121,at+121).run();
  Date.now=()=>(at+180)*1000;
  const delta=metered(db);await refreshMother(env(delta.database));
  t.diagnostic(`sync after 100 more calls, with 1,000 checkpointed: ${JSON.stringify(delta.totals)}`);
  assert.ok(delta.totals.read<400,`incremental sync read ${delta.totals.read} rows`);
  const hooks=metered(db);
  const response=await worker.fetch(new Request('https://quota.example/check',{
    method:'POST',headers:{Authorization:'Bearer member-token','Content-Type':'application/json'},
    body:JSON.stringify({modelName:'gemini-flash',conversationId:'next-call',invocationNum:1})
  }),env(hooks.database));
  assert.equal(response.status,200);
  t.diagnostic(`one check with 1,000 recent calls: ${JSON.stringify(hooks.totals)}`);
  assert.ok(idle.totals.read<200,`idle sync read ${idle.totals.read} rows`);
  assert.ok(hooks.totals.read<200,`check read ${hooks.totals.read} rows`);
});

test('idle scheduling slows down, active reservations keep minute sync, and calls refresh stale idle balances',async t=>{
  let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json(summary);};
  await db.prepare('UPDATE mother_account SET attempted_at=NULL WHERE id=1').run();
  await refreshMother(env(),{background:true});assert.equal(requests,1);
  Date.now=()=>(at+60)*1000;
  const skipped=metered(db);await refreshMother(env(skipped.database),{background:true});
  assert.equal(requests,1);assert.equal(skipped.totals.written,0);
  t.diagnostic(`idle scheduled tick: ${JSON.stringify(skipped.totals)}`);
  Date.now=()=>(at+120)*1000;
  const response=await worker.fetch(new Request('https://quota.example/check',{
    method:'POST',headers:{Authorization:'Bearer member-token','Content-Type':'application/json'},
    body:JSON.stringify({modelName:'gemini-flash',conversationId:'resume',invocationNum:1})
  }),env());
  assert.equal(response.status,200);assert.notEqual((await response.json() as any).terminationBehavior,'terminate');
  assert.equal(requests,2);
  Date.now=()=>(at+180)*1000;
  await refreshMother(env(),{background:true});assert.equal(requests,3);
  // A long-running hold must prevent idle mode even after five minutes.
  Date.now=()=>(at+600)*1000;
  const running=await refreshMother(env(),{background:true});assert.equal(running!.sync_mode,'active');
  await db.prepare("UPDATE usage_logs SET status='released' WHERE conversation_id='resume'").run();
  Date.now=()=>(at+660)*1000;
  const idle=await refreshMother(env(),{background:true});assert.equal(idle!.sync_mode,'idle');
  const before=requests;
  Date.now=()=>(at+900)*1000;
  await refreshMother(env(),{background:true});assert.equal(requests,before+1);
});

test('idle resume keeps transient-error grace but blocks expired snapshots and revoked authorization',async()=>{
  await refreshMother(env());
  const request=()=>worker.fetch(new Request('https://quota.example/check',{
    method:'POST',headers:{Authorization:'Bearer member-token','Content-Type':'application/json'},
    body:JSON.stringify({modelName:'gemini-flash',conversationId:'resume-error',invocationNum:1})
  }),env());
  globalThis.fetch=async()=>new Response('{}',{status:503});
  Date.now=()=>(at+180)*1000;
  assert.notEqual((await (await request()).json() as any).terminationBehavior,'terminate');
  Date.now=()=>(at+1200)*1000;
  assert.equal((await (await request()).json() as any).terminationBehavior,'terminate');
  globalThis.fetch=async()=>new Response('{}',{status:401});
  Date.now=()=>(at+1260)*1000;
  const revoked=await (await request()).json() as any;
  assert.equal(revoked.terminationBehavior,'terminate');
  assert.match(revoked.injectSteps[0].errorMessage.userMessage,/授权失效/);
});

test('incremental calibration matches a full ledger scan after checkpointed edits, late records and future commits',async()=>{
  await refreshMother(env());
  const put=async(id:string,weight:number,created:number,committed:number|null,source='check')=>{
    await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at,source)
      VALUES('m','gemini','gemini-flash',?,?,1,?,?,?, ?,?)`)
      .bind(weight,id,committed===null?'reserved':'committed',created,at+180,committed,source).run();
  };
  await put('done',1.125,at+1,at+2);await put('span',2,at-1,at+10);
  await put('hold',3,at+5,null);await put('future',4,at+200,at+200);
  const compare=async(now:number)=>{
    const old=await db.prepare("SELECT * FROM quota_calibration WHERE pool_group='gemini' AND window_name='fiveHour'").first<CalibrationState>();
    const b:QuotaObservation={pool:'gemini',window:'fiveHour',at:now,fraction:.9,resetAt:at+3600,bucketKey:'test'};
    const actual=await evidenceStatement(db,b,old).first<any>();
    const anchor=old!.anchor_at,previous=old!.observed_at;
    const expected=await db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='committed' AND source!='offline_commit' AND created_at>=? AND committed_at>=? AND committed_at<=? THEN weight ELSE 0 END),0) AS done,
      COALESCE(SUM(CASE WHEN status='committed' AND source!='offline_commit' AND created_at<? AND committed_at>=? AND committed_at<=? THEN weight ELSE 0 END),0) AS span,
      COALESCE(SUM(CASE WHEN status='reserved' AND expires_at>? THEN weight ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN status='committed' AND committed_at>? AND committed_at<=? THEN weight ELSE 0 END),0) AS recent,
      COALESCE(SUM(CASE WHEN status='committed' AND committed_at>? AND committed_at<=? THEN weight ELSE 0 END),0) AS stepDone,
      COALESCE(SUM(CASE WHEN source='offline_commit' AND committed_at>=? AND committed_at<=? THEN 1 ELSE 0 END),0) AS recentOffline
      FROM (${activeUsageSql('gemini',String(Math.min(anchor,previous,now-20)),now)})`)
      .bind(anchor,anchor,now,anchor,anchor,now,now,now-20,now,previous,now,previous,now).first<any>();
    for(const key of ['done','span','pending','recent','stepDone','recentOffline'])assert.ok(Math.abs(actual[key]-expected[key])<1e-9,`${key}: ${actual[key]} vs ${expected[key]}`);
  };
  await compare(at+60);
  Date.now=()=>(at+60)*1000;await refreshMother(env());
  await db.prepare("UPDATE usage_logs SET weight=2.375 WHERE conversation_id='done'").run();
  await db.prepare("DELETE FROM usage_logs WHERE conversation_id='span'").run();
  await put('backdated',.625,at+1,at+1);await put('offline',1,at+65,at+65,'offline_commit');
  await compare(at+120);
  Date.now=()=>(at+120)*1000;await refreshMother(env());
  await compare(at+240);
});

test('a ledger edit during sync cannot overwrite a newer calibration checkpoint',async()=>{
  await refreshMother(env());
  Date.now=()=>(at+60)*1000;await refreshMother(env());
  let changed=false;
  const racing=metered(db,async sql=>{
    if(changed||!sql.startsWith('INSERT INTO calibration_totals'))return;
    changed=true;
    await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
      VALUES('m','gemini','gemini-flash',1,'late-during-sync',1,'committed',?,?,?)`).bind(at+1,at+1,at+1).run();
  });
  Date.now=()=>(at+120)*1000;await refreshMother(env(racing.database));assert.ok(changed);
  const old=await db.prepare("SELECT * FROM quota_calibration WHERE pool_group='gemini' AND window_name='fiveHour'").first<CalibrationState>();
  const evidence=await evidenceStatement(db,{pool:'gemini',window:'fiveHour',at:at+180,fraction:.9,resetAt:at+3600,bucketKey:'test'},old).first<any>();
  assert.equal(evidence.done,1);
});

test('a cycle reset racing admission returns a retryable response and cannot use stale totals',async()=>{
  await refreshMother(env());
  let reset=false;
  const racing=metered(db,async sql=>{
    if(reset||!/^WITH\s+rates/.test(sql))return;
    reset=true;
    await db.prepare("UPDATE quota_calibration SET cycle_started_at=? WHERE pool_group='gemini' AND window_name='fiveHour'").bind(at).run();
  });
  const request=(database:D1Database)=>worker.fetch(new Request('https://quota.example/check',{
    method:'POST',headers:{Authorization:'Bearer member-token','Content-Type':'application/json'},
    body:JSON.stringify({modelName:'gemini-flash',conversationId:'cycle-race',invocationNum:1})
  }),env(database));
  assert.equal((await request(racing.database)).status,503);assert.ok(reset);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_logs').first<any>()).n,0);
  const retried=await request(db);
  assert.equal(retried.status,200);assert.notEqual((await retried.json() as any).terminationBehavior,'terminate');
});
