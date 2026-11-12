import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker from '../src/index';
import {hashToken} from '../src/security';
import type {Env} from '../src/types';

let mf:Miniflare,db:D1Database;
const originalFetch=globalThis.fetch;
const origin='https://quota.example',email='mother@example.com',adminToken='test-admin-'.padEnd(64,'x');
let googleUser:Record<string,unknown>,exchanges:number;
const env=():Env=>({DB:db,ACCOUNT_ENCRYPTION_KEY:'a'.repeat(64),ADMIN_GOOGLE_EMAIL:email});
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  db=await mf.getD1Database('DB') as unknown as D1Database;
  for(const name of ['0001_initial.sql','0002_mother_account.sql','0003_admin_google_login.sql','0004_zero_quota_floor.sql','0005_adaptive_quota.sql','0006_member_deletion.sql','0007_initial_quota_usage.sql','0008_member_login.sql','0009_family_connection.sql','0010_remove_family_connection.sql','0011_precision_billing.sql','0012_percentage_quota.sql']) {
    const schema=await readFile(`migrations/${name}`,'utf8');
    for(const statement of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
  }
});
after(async()=>{await mf?.dispose();});
beforeEach(async()=>{
  for(const table of ['mother_account','oauth_sessions','real_quota_budgets','admin_identity','admin_sessions','quota_calibration','quota_samples','member_sessions','usage_logs','members'])await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('UPDATE policy SET real_quota_guard=0 WHERE id=1').run();
  googleUser={email,id:'google-mother-id',verified_email:true};exchanges=0;
  globalThis.fetch=async(input:any)=>{
    const url=String(input);
    if(url==='https://oauth2.googleapis.com/token'){exchanges++;return Response.json({access_token:'test-access',refresh_token:'test-refresh',expires_in:3600});}
    if(url.includes('/userinfo'))return Response.json(googleUser);
    // Upstream quota failure must not prevent a verified administrator signing in.
    return new Response('{}',{status:503});
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;});
function route(path:string,options:{method?:string;body?:unknown;cookie?:string;headers?:Record<string,string>}={},bindings=env()) {
  return worker.fetch(new Request(origin+path,{method:options.method||(options.body?'POST':'GET'),headers:{
    ...(options.body?{'Content-Type':'application/json',Origin:origin}:{}),...(options.cookie?{Cookie:options.cookie}:{}),...options.headers
  },...(options.body?{body:JSON.stringify(options.body)}:{})}),bindings);
}
function cookie(response:Response,kind='admin') {
  const value=response.headers.getSetCookie().find(value=>value.startsWith(`__Host-agy_${kind}=`));
  assert.ok(value,`Missing ${kind} cookie`);return value.split(';')[0];
}
async function start(bindings=env()) {
  const response=await route('/api/auth/google/start',{body:{}},bindings);
  assert.equal(response.status,200);
  const data=await response.json() as any,url=new URL(data.url);
  return {response,data,url,nonce:cookie(response,'oauth'),callback:`${data.redirect_uri}?code=one-time-code&state=${url.searchParams.get('state')}`};
}
async function login(bindings=env()) {
  const flow=await start(bindings);
  return route('/api/auth/google/finish',{body:{callback_url:flow.callback},cookie:flow.nonce},bindings);
}
test('public Google entry is closed until an administrator is configured; no first-visitor claim',async()=>{
  const bindings={...env(),ADMIN_GOOGLE_EMAIL:undefined};
  const status=await route('/api/auth/status',{},bindings);
  assert.deepEqual(await status.json(),{authenticated:false,google_login_available:false});
  assert.equal((await route('/api/auth/google/start',{body:{}},bindings)).status,503);
  assert.equal((await route('/api/auth/google/start',{body:{},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await route('/api/admin/overview')).status,401);
});
test('Google login creates a hashed, seven-day HttpOnly session without ADMIN_TOKEN; reloads stay signed in',async()=>{
  const response=await login();assert.equal(response.status,200);
  const header=response.headers.getSetCookie().find(value=>value.startsWith('__Host-agy_admin='))!;
  for(const attribute of ['Path=/','HttpOnly','Secure','SameSite=Lax','Max-Age=604800'])assert.ok(header.includes(attribute));
  const sessionCookie=cookie(response),token=sessionCookie.split('=')[1];
  const stored=await db.prepare('SELECT * FROM admin_sessions').first<any>();
  assert.equal(stored.token_hash,await hashToken(token));assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal((await route('/api/admin/overview',{cookie:sessionCookie})).status,200);
  assert.equal((await (await route('/api/auth/status',{cookie:sessionCookie})).json() as any).authenticated,true);
  const account=await db.prepare('SELECT * FROM mother_account').first<any>();
  assert.equal(account.email,email);assert.equal(account.status,'error');assert.ok(!account.credentials.includes('test-refresh'));
  assert.equal((await db.prepare('SELECT real_quota_guard FROM policy').first<any>()).real_quota_guard,1);
});
test('OAuth state is bound to its browser, callback URI and purpose; replay and expiry are rejected',async()=>{
  const flow=await start();
  const finish=(callback=flow.callback,nonce=flow.nonce)=>route('/api/auth/google/finish',{body:{callback_url:callback},cookie:nonce});
  assert.equal((await finish(flow.callback,'__Host-agy_oauth=agy_'+'b'.repeat(64))).status,400);
  assert.equal((await finish(flow.callback,'')).status,400);
  assert.equal((await finish('https://evil.example/oauth-callback?'+new URL(flow.callback).searchParams)).status,400);
  assert.equal(exchanges,0);
  assert.equal((await finish()).status,200);assert.equal((await finish()).status,400);assert.equal(exchanges,1);
  const expired=await start();await db.prepare('UPDATE oauth_sessions SET expires_at=0').run();
  assert.equal((await route('/api/auth/google/finish',{body:{callback_url:expired.callback},cookie:expired.nonce})).status,400);
  const mother=await route('/api/admin/mother/login',{body:{},headers:{Authorization:`Bearer ${adminToken}`}},{...env(),ADMIN_TOKEN:adminToken});
  const data=await mother.json() as any,url=new URL(data.url);
  assert.equal((await route('/api/auth/google/finish',{body:{callback_url:`${data.redirect_uri}?code=x&state=${url.searchParams.get('state')}`},cookie:cookie(mother,'oauth')})).status,400);
});
test('wrong, unverified, and changed Google identities cannot replace the mother or get an admin session',async()=>{
  googleUser.email='someone@example.com';assert.equal((await login()).status,403);
  assert.equal(await db.prepare('SELECT * FROM mother_account').first(),null);
  assert.equal(await db.prepare('SELECT * FROM admin_sessions').first(),null);
  googleUser={email,id:'google-mother-id',verified_email:false};assert.equal((await login()).status,400);
  googleUser.verified_email=true;assert.equal((await login()).status,200);
  googleUser.id='different-subject';assert.equal((await login()).status,403);
  assert.equal((await db.prepare('SELECT google_id FROM admin_identity').first<any>()).google_id,'google-mother-id');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first<any>()).n,1);
});
test('cookie-authenticated writes require the same origin; bearer recovery and member isolation still work',async()=>{
  const sessionCookie=cookie(await login());
  assert.equal((await route('/api/admin/members',{body:{name:'家人',email:'member@gmail.com'},cookie:sessionCookie,headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await route('/api/admin/members',{body:{name:'家人',email:'member@gmail.com'},cookie:sessionCookie,headers:{Origin:''}})).status,403);
  const created=await route('/api/admin/members',{body:{name:'家人',email:'member@gmail.com'},cookie:sessionCookie});assert.equal(created.status,201);
  const member=await created.json() as any;
  assert.equal((await route('/api/admin/overview',{headers:{Authorization:`Bearer ${member.token}`}}, {...env(),ADMIN_TOKEN:adminToken})).status,401);
  assert.equal((await route('/api/admin/overview',{headers:{Authorization:`Bearer ${adminToken}`}}, {...env(),ADMIN_TOKEN:adminToken})).status,200);
});
test('logout revokes its session and pending OAuth; expiration and configured owner changes invalidate cookies',async()=>{
  const sessionCookie=cookie(await login()),pending=await start();
  assert.equal((await route('/api/auth/logout',{body:{},cookie:sessionCookie,headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await route('/api/auth/logout',{body:{},cookie:sessionCookie+'; '+pending.nonce})).status,200);
  assert.equal((await route('/api/admin/overview',{cookie:sessionCookie})).status,401);
  assert.equal((await route('/api/auth/google/finish',{body:{callback_url:pending.callback},cookie:pending.nonce})).status,400);
  const fresh=cookie(await login());
  assert.equal((await route('/api/admin/overview',{cookie:fresh},{...env(),ADMIN_GOOGLE_EMAIL:'new-owner@example.com'})).status,401);
  await db.prepare('UPDATE admin_sessions SET expires_at=0').run();
  assert.equal((await route('/api/admin/overview',{cookie:fresh})).status,401);
});
test('disconnect preserves the pinned identity so the mother can reconnect without a token',async()=>{
  const sessionCookie=cookie(await login()),bindings={...env(),ADMIN_GOOGLE_EMAIL:undefined};
  assert.equal((await route('/api/admin/mother',{method:'DELETE',cookie:sessionCookie,headers:{Origin:origin}},bindings)).status,200);
  assert.equal(await db.prepare('SELECT * FROM mother_account').first(),null);
  assert.equal((await (await route('/api/auth/status',{},bindings)).json() as any).google_login_available,true);
  assert.equal((await login(bindings)).status,200);
});
test('registered Web client callback automatically sets a session and redirects without exposing codes',async()=>{
  const bindings={...env(),GOOGLE_CLIENT_ID:'own-web-client',GOOGLE_CLIENT_SECRET:'own-web-secret',GOOGLE_REDIRECT_URI:origin+'/api/auth/google/callback'};
  const flow=await start(bindings);assert.equal(flow.data.manual_callback,false);
  const response=await route(new URL(flow.callback).pathname+new URL(flow.callback).search,{cookie:flow.nonce},bindings);
  assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/');assert.ok(cookie(response));
  const failed=await route(new URL(flow.callback).pathname+new URL(flow.callback).search,{cookie:flow.nonce},bindings);
  assert.equal(failed.status,303);assert.equal(failed.headers.get('Location'),'/?login_error=1');
  assert.equal(failed.headers.get('Referrer-Policy'),'no-referrer');
});
test('token bootstrap can also use the automatic Web callback, and changed owners revoke previous sessions',async()=>{
  const oldCookie=cookie(await login());
  const bindings={...env(),ADMIN_TOKEN:adminToken,ADMIN_GOOGLE_EMAIL:undefined,GOOGLE_REDIRECT_URI:origin+'/api/auth/google/callback'};
  const response=await route('/api/admin/mother/login',{body:{},headers:{Authorization:`Bearer ${adminToken}`}},bindings);
  const data=await response.json() as any,url=new URL(data.url);assert.equal(data.manual_callback,false);
  googleUser={email:'new-owner@example.com',id:'new-google-id',verified_email:true};
  const completed=await route('/api/auth/google/callback?code=x&state='+url.searchParams.get('state'),{cookie:cookie(response,'oauth')},bindings);
  assert.equal(completed.status,303);assert.equal(completed.headers.get('Location'),'/');
  assert.equal((await route('/api/admin/overview',{cookie:oldCookie},bindings)).status,401);
  assert.equal((await route('/api/admin/overview',{cookie:cookie(completed)},bindings)).status,200);
});
test('an unfinished privileged OAuth flow cannot restore the old administrator after ownership changes',async()=>{
  const oldCookie=cookie(await login()),bindings={...env(),ADMIN_GOOGLE_EMAIL:undefined};
  const response=await route('/api/admin/mother/login',{body:{},cookie:oldCookie},bindings);
  const data=await response.json() as any,url=new URL(data.url),nonce=cookie(response,'oauth');
  await db.prepare('UPDATE admin_identity SET email=?,google_id=? WHERE id=1').bind('new-owner@example.com','new-google-id').run();
  // The automatic callback needs only its short-lived OAuth proof, so it must
  // independently reject the previous owner's unfinished authorization.
  const {finishOAuth}=await import('../src/mother-account');
  await assert.rejects(()=>finishOAuth(bindings,`${data.redirect_uri}?code=x&state=${url.searchParams.get('state')}`,
    {purpose:'mother',browserHash:''}),/发起登录的浏览器/);
  const hash=await hashToken(nonce.split('=')[1]);
  await assert.rejects(()=>finishOAuth(bindings,`${data.redirect_uri}?code=x&state=${url.searchParams.get('state')}`,
    {purpose:'mother',browserHash:hash}),/管理员身份已变更/);
  assert.equal((await db.prepare('SELECT email FROM admin_identity').first<any>()).email,'new-owner@example.com');
});
test('an owner replacement between verification and the account transaction cannot be overwritten by an in-flight login',async()=>{
  assert.equal((await login()).status,200);
  const flow=await start();let raced=false;
  const proxy=new Proxy(db,{get(target,property){
    if(property==='batch')return async(statements:D1PreparedStatement[])=>{
      if(statements.length===6&&!raced){raced=true;await db.batch([
        db.prepare('UPDATE admin_identity SET email=?,google_id=? WHERE id=1').bind('new-owner@example.com','new-id'),
        db.prepare('UPDATE mother_account SET email=?,credentials=? WHERE id=1').bind('new-owner@example.com','replacement-credentials')
      ]);}
      return target.batch(statements);
    };
    const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
  const response=await route('/api/auth/google/finish',{body:{callback_url:flow.callback},cookie:flow.nonce},{...env(),DB:proxy});
  assert.equal(response.status,409);assert.ok(raced);
  assert.deepEqual(await db.prepare('SELECT email,credentials FROM mother_account').first(),{email:'new-owner@example.com',credentials:'replacement-credentials'});
});

async function addMember(overrides:Record<string,unknown>={}) {
  const response=await route('/api/admin/members',{body:{name:'成员',email:'member@gmail.com',...overrides},headers:{Authorization:`Bearer ${adminToken}`}},{...env(),ADMIN_TOKEN:adminToken});
  assert.equal(response.status,201,await response.clone().text());return await response.json() as any;
}
function asMember(email='member@gmail.com',id='google-member-id') {googleUser={email,id,verified_email:true};}

test('members bind normalized unique emails; legacy members can acquire a login without changing tokens or usage',async()=>{
  const m=await addMember({email:' Member@Gmail.com '});assert.equal(m.email,'member@gmail.com');
  const create=(body:unknown)=>route('/api/admin/members',{body,headers:{Authorization:`Bearer ${adminToken}`}},{...env(),ADMIN_TOKEN:adminToken});
  assert.equal((await create({name:'duplicate',email:'MEMBER@gmail.com'})).status,409);
  assert.equal((await create({name:'missing'})).status,400);
  assert.equal((await create({name:'bad',email:'invalid'})).status,400);
  assert.equal((await create({name:'owner',email})).status,201);
  await db.prepare("INSERT INTO members(member_id,name,token_hash,created_at) VALUES('legacy','旧成员','legacy-token',1)").run();
  const bindings={...env(),ADMIN_TOKEN:adminToken};
  assert.equal((await route('/api/admin/members/legacy',{method:'PATCH',body:{email:'legacy@gmail.com'},headers:{Authorization:`Bearer ${adminToken}`}},bindings)).status,200);
  assert.equal((await db.prepare("SELECT token_hash FROM members WHERE member_id='legacy'").first<any>()).token_hash,'legacy-token');
  asMember('legacy@gmail.com','legacy-id');assert.equal((await login()).status,200);
});

test('verified bound members log in without replacing mother credentials and receive only their own records',async()=>{
  await login();const mother=await db.prepare('SELECT * FROM mother_account').first();
  const m=await addMember(),other=await addMember({email:'other@gmail.com',name:'另一位'});
  for(const id of [m.member_id,other.member_id])await db.prepare(`INSERT INTO usage_logs(member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at)
    VALUES(?,'gemini','gemini-pro',3,?,0,'committed',1,1,1)`).bind(id,id).run();
  asMember();const response=await login();assert.equal(response.status,200);
  const sessionCookie=cookie(response);
  const status=await (await route('/api/auth/status',{cookie:sessionCookie})).json() as any;
  assert.equal(status.role,'member');assert.equal(status.email,'member@gmail.com');
  const session=await db.prepare('SELECT * FROM member_sessions').first<any>();
  assert.equal(session.token_hash,await hashToken(sessionCookie.split('=')[1]));
  assert.deepEqual(await db.prepare('SELECT * FROM mother_account').first(),mother);
  const result=await route('/api/member/overview',{cookie:sessionCookie});assert.equal(result.status,200);
  const view=await result.json() as any;
  assert.deepEqual(view.members.map((m:any)=>m.member_id),[m.member_id]);
  assert.deepEqual(view.events.map((e:any)=>e.member_id),[m.member_id]);
  assert.equal(view.mother.email,undefined);assert.equal(view.members[0].token_hash,undefined);assert.equal(view.members[0].google_id,undefined);
  assert.equal((await route('/api/admin/overview',{cookie:sessionCookie})).status,403);
  for(const path of ['/api/admin/members','/api/admin/policy','/api/admin/mother/login'])assert.equal((await route(path,{body:{},cookie:sessionCookie})).status,403);
  assert.equal((await route('/api/member/overview')).status,401);
});

test('member self-service rotates only their own token and requires same-origin writes',async()=>{
  const m=await addMember(),other=await addMember({email:'other@gmail.com'}),before=await db.prepare('SELECT token_hash FROM members WHERE member_id=?').bind(other.member_id).first();
  asMember();const sessionCookie=cookie(await login());
  assert.equal((await route('/api/member/rotate-token',{body:{},cookie:sessionCookie,headers:{Origin:'https://evil.example'}})).status,403);
  const result=await route('/api/member/rotate-token',{body:{member_id:other.member_id},cookie:sessionCookie});assert.equal(result.status,200);
  const token=await result.json() as any;assert.equal(token.member_id,m.member_id);assert.notEqual(token.token,m.token);
  assert.equal((await db.prepare('SELECT token_hash FROM members WHERE member_id=?').bind(m.member_id).first<any>()).token_hash,await hashToken(token.token));
  assert.deepEqual(await db.prepare('SELECT token_hash FROM members WHERE member_id=?').bind(other.member_id).first(),before);
  assert.equal((await route(`/api/admin/members/${other.member_id}/rotate-token`,{body:{},cookie:sessionCookie})).status,403);
});

test('member Google subjects are pinned; unknown, paused, deleted and unverified accounts cannot log in',async()=>{
  const m=await addMember();asMember();assert.equal((await login()).status,200);
  asMember('member@gmail.com','different-id');assert.equal((await login()).status,403);
  asMember('unknown@gmail.com');assert.equal((await login()).status,403);
  asMember();googleUser.verified_email=false;assert.equal((await login()).status,400);
  asMember();const sessionCookie=cookie(await login());
  await db.prepare('UPDATE members SET enabled=0 WHERE member_id=?').bind(m.member_id).run();
  assert.equal((await login()).status,403);assert.equal((await route('/api/member/overview',{cookie:sessionCookie})).status,401);
  await db.prepare('UPDATE members SET enabled=1,deleted_at=1 WHERE member_id=?').bind(m.member_id).run();
  assert.equal((await login()).status,403);
});

test('rebinding email and pausing revoke member sessions; logout and expiry apply to member sessions',async()=>{
  const m=await addMember();asMember();const sessionCookie=cookie(await login());
  const patch=(body:unknown)=>route(`/api/admin/members/${m.member_id}`,{method:'PATCH',body,headers:{Authorization:`Bearer ${adminToken}`}},{...env(),ADMIN_TOKEN:adminToken});
  assert.equal((await patch({email:'new@gmail.com'})).status,200);
  assert.equal((await route('/api/member/overview',{cookie:sessionCookie})).status,401);
  assert.equal((await login()).status,403);
  asMember('new@gmail.com','new-member-id');const fresh=cookie(await login());
  assert.equal((await patch({enabled:0})).status,200);assert.equal((await patch({enabled:1})).status,200);
  assert.equal((await route('/api/member/overview',{cookie:fresh})).status,401);
  const expired=cookie(await login());await db.prepare('UPDATE member_sessions SET expires_at=0').run();
  assert.equal((await route('/api/member/overview',{cookie:expired})).status,401);
  const loggedOut=cookie(await login());assert.equal((await route('/api/auth/logout',{body:{},cookie:loggedOut})).status,200);
  assert.equal((await route('/api/member/overview',{cookie:loggedOut})).status,401);
});

test('automatic member callback lands on installation tutorial and keeps a member-only cookie',async()=>{
  await addMember();asMember();
  const bindings={...env(),GOOGLE_REDIRECT_URI:origin+'/api/auth/google/callback'};
  const flow=await start(bindings);
  const response=await route(new URL(flow.callback).pathname+new URL(flow.callback).search,{cookie:flow.nonce},bindings);
  assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/#tutorial');
  assert.equal((await route('/api/member/overview',{cookie:cookie(response)})).status,200);
  assert.equal((await route('/api/admin/overview',{cookie:cookie(response)})).status,403);
});
