import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {usage} from '../src/quota';
import {overviewUsage} from '../src/usage-statistics';
import {applyMigration} from './helpers/migrations';

test('cumulative migration preserves existing ledger and credentials and initializes totals lazily',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  try {
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    const migration='0015_cumulative_usage.sql';
    for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')&&n<migration).sort())await applyMigration(db,name);
    await db.prepare("INSERT INTO members(member_id,name,token_hash,created_at) VALUES('m','Existing','existing-hash',1)").run();
    await db.prepare("INSERT INTO mother_account(id,email,credentials) VALUES(1,'owner@example.com','encrypted-existing')").run();
    await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
      VALUES('m','gemini','gemini-flash',2,'existing',1,'committed',2000000000,2000000000,2000000000)`).run();
    const tables=['members','mother_account','usage_logs','policy'];
    const before=await Promise.all(tables.map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results));
    await applyMigration(db,migration);
    assert.deepEqual(await Promise.all(tables.map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results)),before);
    assert.deepEqual((await overviewUsage(db,'gemini',2000000000)).family,await usage(db,'gemini',2000000000));
    await db.prepare("UPDATE members SET enabled=0,deleted_at=2000000001 WHERE member_id='m'").run();
    assert.equal((await overviewUsage(db,'gemini',2000000001)).family.fiveHour,.2);
  } finally {await mf.dispose();}
});

test('removing family import erases its grants and pending consent while preserving members, quota credentials and usage',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  try {
    const db=await mf.getD1Database('DB');
    const cleanupName='0010_remove_family_connection.sql';
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')&&name<cleanupName).sort()) {
      const sql=await readFile(`migrations/${name}`,'utf8');
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO members(member_id,name,email,token_hash,created_at) VALUES('member','Existing','member@example.com','member-hash',1)").run();
    await db.prepare("INSERT INTO mother_account(id,email,credentials) VALUES(1,'owner@example.com','encrypted-quota-credentials')").run();
    await db.prepare("INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at) VALUES('member','gemini','gemini-pro',10,'existing',0,'committed',90,90,90)").run();
    await db.prepare("UPDATE family_connection SET credentials='encrypted-family-credentials',snapshot_json='[]',status='blocked' WHERE id=1").run();
    await db.prepare("INSERT INTO family_oauth_sessions VALUES('pending-state','encrypted-proof','browser-hash',9999999999999)").run();
    const preservedTables=['members','mother_account','usage_logs','policy','admin_identity','admin_sessions','member_sessions','oauth_sessions'];
    const before=await Promise.all(preservedTables.map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results));
    const sql=await readFile(`migrations/${cleanupName}`,'utf8');
    for(let run=0;run<2;run++) {
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
      assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE tbl_name IN ('family_connection','family_oauth_sessions')").all()).results,[]);
      assert.deepEqual(await Promise.all(preservedTables.map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results)),before);
    }
  } finally {await mf.dispose();}
});

test('zero-floor migration upgrades the old default, preserves custom policies and changes future defaults',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['old_default','custom','zero']}));
  const legacy=(await Promise.all(['0001_initial.sql','0002_mother_account.sql','0003_admin_google_login.sql'].map(name=>readFile(`migrations/${name}`,'utf8')))).join('\n');
  const migration=await readFile('migrations/0004_zero_quota_floor.sql','utf8');
  try {
    for(const [name,floor] of [['old_default',5],['custom',12],['zero',0]] as const) {
      const db=await mf.getD1Database(name);
      for(const statement of legacy.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
      await db.prepare('UPDATE policy SET real_quota_floor=?,real_quota_guard=1,gemini_5h_limit=123,buffer_percent=7,opus_weight=9').bind(floor).run();
      const previous=await db.prepare('SELECT * FROM policy').first();
      for(const statement of migration.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
      assert.deepEqual(await db.prepare('SELECT * FROM policy').first(),{...previous,real_quota_floor:floor===5?0:floor});
      await db.prepare('DELETE FROM policy').run();
      await db.prepare('INSERT INTO policy (id) VALUES (1)').run();
      assert.equal((await db.prepare('SELECT real_quota_floor FROM policy').first())!.real_quota_floor,0);
    }
  } finally {await mf.dispose();}
});

test('adaptive migration installs 250/2000 defaults and zero buffer while retaining customized budgets and existing data',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['defaults','customized']}));
  try {
    for(const name of ['defaults','customized']) {
      const db=await mf.getD1Database(name);
      for(const migration of ['0001_initial.sql','0002_mother_account.sql','0003_admin_google_login.sql','0004_zero_quota_floor.sql']){
        const sql=await readFile(`migrations/${migration}`,'utf8');
        for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
      }
      if(name==='customized')await db.prepare('UPDATE policy SET gemini_5h_limit=123,gemini_wk_limit=456,tp_5h_limit=789,tp_wk_limit=987,buffer_percent=7,flash_weight=2,real_quota_guard=1').run();
      await db.prepare("INSERT INTO members(member_id,name,token_hash,created_at) VALUES('member','Existing','hash',100)").run();
      const member=await db.prepare('SELECT * FROM members').first();
      const sql=await readFile('migrations/0005_adaptive_quota.sql','utf8');
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
      const p=await db.prepare('SELECT * FROM policy').first<any>();
      assert.equal(p.calibration_enabled,1);assert.deepEqual(await db.prepare('SELECT * FROM members').first(),member);
      assert.equal(p.gemini_5h_limit,name==='defaults'?250:123);
      assert.equal(p.gemini_wk_limit,name==='defaults'?2000:456);
      assert.equal(p.tp_5h_limit,name==='defaults'?250:789);
      assert.equal(p.tp_wk_limit,name==='defaults'?2000:987);
      assert.equal(p.buffer_percent,name==='defaults'?0:7);
      assert.equal(p.flash_weight,name==='defaults'?1:2);
      await db.prepare('DELETE FROM policy').run();await db.prepare('INSERT INTO policy(id) VALUES(1)').run();
      const fresh=await db.prepare('SELECT * FROM policy').first<any>();
      assert.equal(fresh.gemini_5h_limit,250);assert.equal(fresh.gemini_wk_limit,2000);assert.equal(fresh.calibration_enabled,1);
    }
  } finally {await mf.dispose();}
});

test('initial-usage migration reconciles existing accounts without double charging recorded calls or changing history',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  try {
    const db=await mf.getD1Database('DB');
    for(const name of ['0001_initial.sql','0002_mother_account.sql','0003_admin_google_login.sql','0004_zero_quota_floor.sql','0005_adaptive_quota.sql','0006_member_deletion.sql']) {
      const sql=await readFile(`migrations/${name}`,'utf8');
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO members(member_id,name,token_hash,created_at) VALUES('member','Existing','hash',1)").run();
    await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
      VALUES('member','gemini','gemini-pro',10,'existing',0,'committed',90,90,90)`).run();
    await db.prepare(`INSERT INTO quota_calibration VALUES
      ('gemini','fiveHour','mother@example.com','gemini-5h',1,1000,100,.8,100,.8,1,.01,10,.1,1,10,100,'learned')`).run();
    const calibration=await db.prepare('SELECT * FROM quota_calibration').first();
    const history=(await db.prepare('SELECT * FROM usage_logs').all()).results;
    const sql=await readFile('migrations/0007_initial_quota_usage.sql','utf8');
    for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    assert.deepEqual(await db.prepare('SELECT * FROM quota_calibration').first(),{...calibration,initial_fraction:.8,initial_at:100});
    assert.deepEqual((await db.prepare('SELECT * FROM usage_logs').all()).results,history);
  } finally {await mf.dispose();}
});

test('percentage migration converts legacy member/policy point limits to 0-100%, preserves auth/sessions/mother credentials, and resets early counters',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  try {
    const db=await mf.getD1Database('DB');
    const pre=(await readdir('migrations')).filter(name=>name.endsWith('.sql')&&name<'0012_percentage_quota.sql').sort();
    for(const name of pre) {
      const sql=await readFile(`migrations/${name}`,'utf8');
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO mother_account(id,email,credentials,status,checked_at) VALUES(1,'owner@example.com','encrypted-mother-secret','connected',2000000000000)").run();
    await db.prepare("INSERT INTO admin_identity(id,email,google_id) VALUES(1,'owner@example.com','google-owner')").run();
    await db.prepare("INSERT INTO admin_sessions VALUES('admin-session-hash','owner@example.com','google-owner',9999999999999)").run();
    await db.prepare("INSERT INTO members(member_id,name,email,google_id,token_hash,gemini_5h_limit,gemini_wk_limit,tp_5h_limit,tp_wk_limit,created_at) VALUES('a','A','a@gmail.com','gid-a','hash-a',125,1000,125,1000,1)").run();
    await db.prepare("INSERT INTO members(member_id,name,email,google_id,token_hash,gemini_5h_limit,gemini_wk_limit,tp_5h_limit,tp_wk_limit,created_at) VALUES('b','B','b@gmail.com','gid-b','hash-b',62,500,37,300,2)").run();
    await db.prepare("INSERT INTO member_sessions VALUES('member-session-hash','a','a@gmail.com','gid-a',9999999999999)").run();
    await db.prepare("INSERT INTO real_quota_budgets VALUES('gemini','fiveHour',0.8,2000000000,2000000090)").run();
    await db.prepare("INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at) VALUES('a','gemini','gemini-pro',3,'c1',0,'committed',100,100,100)").run();

    const sql=await readFile('migrations/0012_percentage_quota.sql','utf8');
    for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();

    const p=await db.prepare('SELECT * FROM policy WHERE id=1').first<any>();
    assert.deepEqual([p.gemini_5h_limit,p.gemini_wk_limit,p.tp_5h_limit,p.tp_wk_limit],[100,100,100,100]);
    assert.equal(p.real_quota_guard,1);assert.equal(p.real_quota_floor,0);

    const a=await db.prepare("SELECT * FROM members WHERE member_id='a'").first<any>();
    assert.deepEqual([a.gemini_5h_limit,a.gemini_wk_limit,a.tp_5h_limit,a.tp_wk_limit],[50,50,50,50]);
    assert.equal(a.token_hash,'hash-a');assert.equal(a.google_id,'gid-a');

    const b=await db.prepare("SELECT * FROM members WHERE member_id='b'").first<any>();
    assert.deepEqual([b.gemini_5h_limit,b.gemini_wk_limit,b.tp_5h_limit,b.tp_wk_limit],[25,25,15,15]);

    assert.equal((await db.prepare('SELECT credentials FROM mother_account WHERE id=1').first<any>()).credentials,'encrypted-mother-secret');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first<any>()).n,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<any>()).n,1);
    assert.equal((await db.prepare('SELECT expires_at FROM real_quota_budgets').first<any>()).expires_at,2000000900);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_logs').first<any>()).n,0);
    for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')&&n>'0012_percentage_quota.sql').sort())await applyMigration(db as unknown as D1Database,name);
    assert.deepEqual(await usage(db as unknown as D1Database,'gemini',2000000010),{fiveHour:0,week:0});
  } finally {await mf.dispose();}
});
