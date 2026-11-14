import {hashToken,HttpError,json,newToken,readBody,string} from './security';
import type {Env,Policy} from './types';
import {adminIdentity,configuredEmail,cookieValue,createBrowserSession,createMemberSession,setCookie,verifyGoogleAdmin} from './admin-session';
import {FRESH_SECONDS,MOTHER_GRACE_SECONDS,observationWrites,type QuotaObservation} from './quota-state';
import {ensureUsageTotals} from './usage-totals';

// Installed-app OAuth identity published by Antigravity-Manager. A registered
// web OAuth client can override both values and use a direct HTTPS callback.
const DEFAULT_CLIENT_ID='1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const DEFAULT_CLIENT_SECRET='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';
const DEFAULT_REDIRECT='http://localhost:50987/oauth-callback';
// Antigravity IDE's live quota ledger lives exclusively on daily-cloudcode-pa.googleapis.com.
// Never fail over to sandbox.googleapis.com or cloudcode-pa.googleapis.com, which maintain
// separate, independent quota ledgers and would inject phantom drops or false 100% resets.
const UPSTREAM_API='https://daily-cloudcode-pa.googleapis.com/v1internal:';
const UPSTREAM_UA='antigravity/hub/2.28.0 (aidev_client; os_type=linux; arch=x86_64; cl=1008300195)';
const SCOPES=['openid','https://www.googleapis.com/auth/cloud-platform','https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/cclog','https://www.googleapis.com/auth/experimentsandconfigs'];
interface Credentials {access_token:string;refresh_token:string;expires_at:number}
interface Account {email:string;credentials:string;status:string;snapshot_json:string|null;checked_at:number|null;attempted_at:number|null;last_error:string|null;refresh_lock:number;last_activity_at:number;has_reservations:number}
export interface QuotaBucket {id:string;window:string;remaining_fraction:number;reset_time:string|null}
export interface QuotaGroup {name:string;buckets:QuotaBucket[]}
interface Snapshot {groups:QuotaGroup[];tier:string|null;project?:string|null}
// Leave five seconds of scheduling tolerance for the once-per-minute Cron.
const REFRESH_INTERVAL_MS=55_000;
const IDLE_AFTER_MS=300_000,IDLE_REFRESH_MS=300_000;
function accountStatement(db:D1Database,nowMs:number) {
  const at=Math.floor(nowMs/1000);
  return db.prepare(`SELECT m.*,COALESCE((SELECT MAX(last_activity_at) FROM usage_activity),0) AS last_activity_at,
    (EXISTS(SELECT 1 FROM usage_logs WHERE pool_group='gemini' AND status='reserved' AND expires_at>${at}) OR
     EXISTS(SELECT 1 FROM usage_logs WHERE pool_group='third_party' AND status='reserved' AND expires_at>${at})) AS has_reservations
    FROM mother_account m WHERE m.id=1`);
}
function idle(row:Account,nowMs:number) {return !row.has_reservations&&nowMs-row.last_activity_at*1000>=IDLE_AFTER_MS;}
const base64=(data:Uint8Array)=>btoa(String.fromCharCode(...data));
const bytes=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const base64url=(data:Uint8Array)=>base64(data).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function key(env:Env) {
  if(!env.ACCOUNT_ENCRYPTION_KEY || !/^[a-f0-9]{64}$/.test(env.ACCOUNT_ENCRYPTION_KEY))throw new HttpError(503,'请配置云端账号加密密钥');
  const raw=Uint8Array.from(env.ACCOUNT_ENCRYPTION_KEY.match(/../g)!,v=>parseInt(v,16));
  return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
export async function seal(env:Env,value:unknown) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),new TextEncoder().encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function unseal<T>(env:Env,value:string):Promise<T> {
  const [iv,data]=value.split('.');
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv)},await key(env),bytes(data));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
function oauthClient(env:Env) {return {client_id:env.GOOGLE_CLIENT_ID||DEFAULT_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET||DEFAULT_CLIENT_SECRET};}
async function remote(url:string,init:RequestInit,timeout=10_000):Promise<Record<string,any>> {
  // Workers supports manual/follow only. Reject 3xx below without forwarding credentials.
  const response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new HttpError(response.status===401 || url==='https://oauth2.googleapis.com/token'&&response.status===400?401:502,`上游查询失败（HTTP ${response.status}）`);
  return await response.json() as Record<string,any>;
}
async function upstreamRpc(method:string,headers:Record<string,string>,body:string,deadline?:number):Promise<Record<string,any>> {
  let lastError:unknown;
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const timeout=deadline===undefined?9_000:Math.min(9_000,deadline-Date.now());
      if(timeout<=0)throw new HttpError(504,'官方余额同步超时');
      return await remote(UPSTREAM_API+method,{method:'POST',headers,body},timeout);
    }
    catch(error) {
      if(error instanceof HttpError&&error.status===401)throw error;
      lastError=error;
    }
  }
  throw lastError instanceof Error?lastError:new HttpError(502,'上游查询失败');
}
function credentials(data:Record<string,any>,oldRefresh?:string):Credentials {
  if(typeof data.access_token!=='string'||!data.access_token||typeof data.expires_in!=='number'||data.expires_in<=0)
    throw new HttpError(502,'Google 未返回有效授权信息');
  const refresh=data.refresh_token||oldRefresh;
  if(typeof refresh!=='string'||!refresh)throw new HttpError(400,'Google 未返回长期授权，请重新登录并同意授权');
  return {access_token:data.access_token,refresh_token:refresh,expires_at:Date.now()+data.expires_in*1000};
}
export function parseSummary(data:Record<string,any>):QuotaGroup[] {
  if(!Array.isArray(data.groups)||!data.groups.length||data.groups.length>32)throw new HttpError(502,'上游未返回分组额度');
  return data.groups.map((g:any)=>{
    if(!g||typeof g.displayName!=='string'||!g.displayName||!Array.isArray(g.buckets)||!g.buckets.length||g.buckets.length>32)
      throw new HttpError(502,'上游额度分组格式变化');
    return {name:g.displayName.slice(0,200),buckets:g.buckets.map((b:any)=>{
      if(typeof b.remainingFraction!=='number'||!Number.isFinite(b.remainingFraction)||b.remainingFraction<0||b.remainingFraction>1 ||
        typeof b.bucketId!=='string'||!b.bucketId||typeof b.window!=='string'||!b.window)
        throw new HttpError(502,'上游额度项格式变化');
      const reset=typeof b.resetTime==='string'&&Number.isFinite(Date.parse(b.resetTime))?new Date(b.resetTime).toISOString():null;
      return {id:b.bucketId.slice(0,150),window:b.window.slice(0,60),remaining_fraction:b.remainingFraction,reset_time:reset};
    })};
  });
}
export async function motherAccount(env:Pick<Env,'DB'>,nowMs=Date.now()) {
  const row=await accountStatement(env.DB,nowMs).first<Account>();
  if(!row)return null;
  return motherAccountView(row,nowMs);
}
function motherAccountView(row:Account,nowMs:number) {
  const age=row.checked_at===null?Infinity:nowMs-row.checked_at;
  return {
    email:row.email,status:row.status,checked_at:row.checked_at,attempted_at:row.attempted_at,last_error:row.last_error,
    stale:age>FRESH_SECONDS*1000,
    sync_mode:idle(row,nowMs)?'idle':'active',
    sync_interval_seconds:idle(row,nowMs)?300:60,
    grace_expired:row.status==='auth_required'||age>MOTHER_GRACE_SECONDS*1000,
    snapshot:row.snapshot_json?JSON.parse(row.snapshot_json) as Snapshot:null
  };
}
export async function refreshMother(env:Env,options:{background?:boolean;maxDurationMs?:number}={}) {
  const row=await accountStatement(env.DB,Date.now()).first<Account>();
  if(!row)return null;
  const now=Date.now();
  const interval=options.background&&idle(row,now)?IDLE_REFRESH_MS:REFRESH_INTERVAL_MS;
  const deadline=options.maxDurationMs===undefined?undefined:now+options.maxDurationMs;
  // Shared D1 state coordinates Cron, tabs and isolates. Failed attempts back off
  // too, while reconnecting OAuth resets attempted_at and can sync immediately.
  if(row.refresh_lock>now||row.attempted_at!==null&&row.attempted_at>now-interval)return motherAccountView(row,now);
  const lock=await env.DB.prepare(`UPDATE mother_account SET refresh_lock=? WHERE id=1 AND credentials=? AND refresh_lock<=?
    AND (attempted_at IS NULL OR attempted_at<=?)`)
    .bind(now+35_000,row.credentials,now,now-interval).run();
  if(!lock.meta.changes)return motherAccount(env,now);
  try {
    let auth=await unseal<Credentials>(env,row.credentials);
    if(auth.expires_at<now+60_000) {
      const result=await remote('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({...oauthClient(env),grant_type:'refresh_token',refresh_token:auth.refresh_token})},
        deadline===undefined?10_000:Math.max(1,Math.min(10_000,deadline-Date.now())));
      auth=credentials(result,auth.refresh_token);
      // Persist refresh immediately; later quota failures must not discard rotated credentials.
      await env.DB.prepare('UPDATE mother_account SET credentials=? WHERE id=1 AND email=? AND refresh_lock=?').bind(await seal(env,auth),row.email,now+35_000).run();
    }
    const cached=row.snapshot_json?JSON.parse(row.snapshot_json) as Snapshot:null;
    const headers={Authorization:`Bearer ${auth.access_token}`,'Content-Type':'application/json','User-Agent':UPSTREAM_UA};
    const needMeta=!cached?.project||!cached?.tier||now-(row.checked_at??0)>3_600_000;
    const tier=needMeta?await upstreamRpc('loadCodeAssist',headers,JSON.stringify({metadata:{ideType:'ANTIGRAVITY'}}),
      deadline===undefined?undefined:Math.min(deadline,Date.now()+2_000)).catch(()=>null):null;
    const rawProject=tier?.cloudaicompanionProject;
    const project=(typeof rawProject==='string'&&rawProject?rawProject:typeof rawProject?.id==='string'&&rawProject.id?rawProject.id:null)??cached?.project??null;
    // Summary is the authoritative source for both windows; reuse cached project to halve RPC load and prevent parameter drift.
    const summary=await upstreamRpc('retrieveUserQuotaSummary',headers,JSON.stringify(project?{project}:{}),deadline);
    const snapshot:Snapshot={
      groups:parseSummary(summary),
      tier:tier?.paidTier?.name||tier?.paidTier?.id||tier?.currentTier?.name||tier?.currentTier?.id||cached?.tier||null,
      project
    };
    const reconciled=reconciliation(snapshot.groups,Math.floor(now/1000));
    const policy=await env.DB.prepare('SELECT * FROM policy WHERE id=1').first<Policy>();
    const calibration=await observationWrites(env.DB,reconciled,row.email,now+35_000,!!policy?.calibration_enabled);
    const writes=reconciled.map(b=>env.DB.prepare(`INSERT INTO real_quota_budgets
      (pool_group,window_name,remaining_fraction,snapshot_at,expires_at) SELECT ?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM mother_account WHERE id=1 AND email=? AND refresh_lock=?)
      ON CONFLICT(pool_group,window_name) DO UPDATE SET remaining_fraction=excluded.remaining_fraction,
        snapshot_at=excluded.snapshot_at,expires_at=excluded.expires_at`)
      .bind(b.pool,b.window,b.fraction,b.at,b.at+MOTHER_GRACE_SECONDS,row.email,now+35_000));
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM real_quota_budgets WHERE (pool_group||':'||window_name) NOT IN (${reconciled.map(()=>'?').join(',')||"''"})
        AND EXISTS(SELECT 1 FROM mother_account WHERE id=1 AND email=? AND refresh_lock=?)`)
        .bind(...reconciled.map(b=>`${b.pool}:${b.window}`),row.email,now+35_000),
      ...writes,
      ...calibration,
      env.DB.prepare(`UPDATE mother_account SET snapshot_json=?,checked_at=?,attempted_at=?,status='connected',last_error=NULL,refresh_lock=0
        WHERE id=1 AND email=? AND refresh_lock=?`).bind(JSON.stringify(snapshot),now,now,row.email,now+35_000)
    ]);
    await Promise.all((['gemini','third_party'] as const).map(pool=>ensureUsageTotals(env.DB,pool,Math.floor(now/1000))));
  } catch(error) {
    const message=error instanceof HttpError?error.message:'额度查询暂时不可用，请稍后刷新';
    await env.DB.prepare('UPDATE mother_account SET status=?,last_error=?,attempted_at=?,refresh_lock=0 WHERE id=1 AND email=? AND refresh_lock=?')
      .bind(error instanceof HttpError&&error.status===401?'auth_required':'error',message,now,row.email,now+35_000).run();
  }
  return motherAccount(env,Date.now());
}
// Resume an idle service before admitting a call; preserve the existing 15m error grace.
export async function refreshMotherForCall(env:Env) {
  const now=Date.now(),row=await accountStatement(env.DB,now).first<Account>();
  if(row&&row.status!=='auth_required'&&idle(row,now)&&(row.checked_at===null||now-row.checked_at>FRESH_SECONDS*1000))
    await refreshMother(env,{maxDurationMs:8_000});
}
interface OAuthContext {purpose:'mother'|'login';browserHash:string;origin?:string;request?:Request}
export async function startOAuth(env:Env,context:OAuthContext={purpose:'mother',browserHash:''}) {
  await key(env);
  const state=newToken(),verifier=newToken().slice(4),redirect=env.GOOGLE_REDIRECT_URI||DEFAULT_REDIRECT;
  const proof={verifier,owner:context.purpose==='mother'?await adminIdentity(env):null};
  const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_sessions WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('INSERT INTO oauth_sessions (state_hash,verifier,redirect_uri,expires_at,purpose,browser_hash) VALUES (?,?,?,?,?,?)')
      .bind(await hashToken(state),await seal(env,proof),redirect,Date.now()+600_000,context.purpose,context.browserHash)
  ]);
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v] of Object.entries({client_id:oauthClient(env).client_id,redirect_uri:redirect,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(k,v);
  if(context.purpose==='mother'&&configuredEmail(env))url.searchParams.set('login_hint',configuredEmail(env)!);
  const automatic=redirect===`${context.origin}/api/auth/google/callback`;
  return json({url:url.href,manual_callback:!automatic,redirect_uri:redirect});
}
export async function finishOAuth(env:Env,callback:string,context:OAuthContext={purpose:'mother',browserHash:''}) {
  let url:URL;try{url=new URL(callback);}catch{throw new HttpError(400,'请粘贴浏览器跳转后的完整地址');}
  const state=url.searchParams.get('state');
  if(!state)throw new HttpError(400,'回调地址缺少 state');
  const session=await env.DB.prepare('SELECT * FROM oauth_sessions WHERE state_hash=?').bind(await hashToken(state))
    .first<{verifier:string;redirect_uri:string;expires_at:number;purpose:string;browser_hash:string}>();
  if(!session||session.expires_at<Date.now())throw new HttpError(400,'登录已过期或已使用，请重新开始');
  if(session.purpose!==context.purpose||session.browser_hash!==context.browserHash)throw new HttpError(400,'请在发起登录的浏览器完成授权');
  const expected=new URL(session.redirect_uri);
  if(url.origin!==expected.origin||url.pathname!==expected.pathname)throw new HttpError(400,'回调地址与登录会话不匹配');
  if(url.searchParams.has('error'))throw new HttpError(400,'Google 授权未完成，请重新登录');
  const code=url.searchParams.get('code');if(!code)throw new HttpError(400,'回调地址缺少授权码');
  const consumed=await env.DB.prepare('DELETE FROM oauth_sessions WHERE state_hash=? AND expires_at>?').bind(await hashToken(state),Date.now()).run();
  if(!consumed.meta.changes)throw new HttpError(400,'登录会话已使用，请重新开始');
  const proof=await unseal<{verifier:string;owner:{email:string;google_id:string|null}|null}>(env,session.verifier);
  if(!proof||typeof proof.verifier!=='string')throw new HttpError(400,'登录已过期，请重新开始');
  const result=await remote('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({...oauthClient(env),grant_type:'authorization_code',code,redirect_uri:session.redirect_uri,code_verifier:proof.verifier})});
  if(typeof result.access_token!=='string'||!result.access_token)throw new HttpError(502,'Google 未返回有效授权信息');
  const accessToken=result.access_token;
  const info=await remote('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{Authorization:`Bearer ${accessToken}`}});
  if(typeof info.email!=='string'||info.verified_email!==true||typeof info.id!=='string'||!info.id||info.id.length>256)throw new HttpError(400,'无法确认 Google 账号身份');
  const email=info.email.trim().toLowerCase();
  const expectedEmail=configuredEmail(env)||(await adminIdentity(env))?.email;
  if(context.purpose==='login'&&email!==expectedEmail) {
    if(!context.request)throw new HttpError(400,'请在发起登录的浏览器完成授权');
    const response=json({role:'member'});
    response.headers.append('Set-Cookie',await createMemberSession(context.request,env,email,info.id));
    return response;
  }
  const auth=credentials(result);
  const owner=await verifyGoogleAdmin(env,email,info.id,context.purpose==='mother');
  if(context.purpose==='mother'&&(proof.owner?.email!==owner?.email||proof.owner?.google_id!==owner?.google_id))
    throw new HttpError(409,'管理员身份已变更，请重新登录');
  // Compare the owner inside the same transaction as the account write. A login
  // already in flight must not restore a previous administrator after replacement.
  const saved=await env.DB.batch([
    env.DB.prepare(`INSERT INTO admin_identity (id,email,google_id) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET
      email=excluded.email,google_id=excluded.google_id WHERE admin_identity.email IS ? AND admin_identity.google_id IS ?`)
      .bind(email,info.id,owner?.email??null,owner?.google_id??null),
    env.DB.prepare(`INSERT INTO mother_account (id,email,credentials) SELECT 1,?,? FROM admin_identity
      WHERE id=1 AND email=? AND google_id=? ON CONFLICT(id) DO UPDATE SET
      email=excluded.email,credentials=excluded.credentials,status='connected',snapshot_json=NULL,checked_at=NULL,attempted_at=NULL,last_error=NULL,refresh_lock=0`)
      .bind(email,await seal(env,auth),email,info.id),
    env.DB.prepare(`DELETE FROM admin_sessions WHERE (email<>? OR google_id<>?)
      AND EXISTS (SELECT 1 FROM admin_identity WHERE id=1 AND email=? AND google_id=?)`).bind(email,info.id,email,info.id),
    env.DB.prepare(`DELETE FROM quota_calibration WHERE account_email<>?
      AND EXISTS (SELECT 1 FROM mother_account WHERE id=1 AND email=?)`).bind(email,email),
    env.DB.prepare(`DELETE FROM quota_samples WHERE EXISTS (SELECT 1 FROM admin_identity WHERE id=1 AND email=? AND google_id=?)
      AND NOT EXISTS (SELECT 1 FROM quota_calibration)`).bind(email,info.id),
    env.DB.prepare('UPDATE policy SET real_quota_guard=1,real_quota_floor=0 WHERE id=1 AND EXISTS (SELECT 1 FROM admin_identity WHERE id=1 AND email=? AND google_id=?)').bind(email,info.id)
  ]);
  if(!saved[1].meta.changes)throw new HttpError(409,'管理员身份已变更，请重新登录');
  const response=json({account:await refreshMother(env)});
  if(context.request)response.headers.append('Set-Cookie',await createBrowserSession(context.request,env,{email,google_id:info.id}));
  return response;
}
export async function motherAdmin(req:Request,env:Env,path:string) {
  if(path==='/api/admin/mother/login'&&req.method==='POST') {
    const nonce=newToken();
    const response=await startOAuth(env,{purpose:'mother',browserHash:await hashToken(nonce),origin:new URL(req.url).origin});
    response.headers.append('Set-Cookie',setCookie(req,'oauth',nonce,600));
    return response;
  }
  if(path==='/api/admin/mother/callback'&&req.method==='POST') {
    const nonce=cookieValue(req,'oauth');
    if(!/^agy_[a-f0-9]{64}$/.test(nonce))throw new HttpError(400,'请在发起登录的浏览器完成授权');
    const response=await finishOAuth(env,string((await readBody(req)).callback_url,'回调地址',6000),{purpose:'mother',browserHash:await hashToken(nonce),request:req});
    response.headers.append('Set-Cookie',setCookie(req,'oauth','',0));
    return response;
  }
  if(path==='/api/admin/mother/refresh'&&req.method==='POST')return json({account:await refreshMother(env)});
  if(path==='/api/admin/mother'&&req.method==='DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM mother_account'),env.DB.prepare('DELETE FROM oauth_sessions'),env.DB.prepare('DELETE FROM real_quota_budgets')]);
    return json({ok:true});
  }
  throw new HttpError(404,'接口不存在');
}
export function reconciliation(groups:QuotaGroup[],at:number) {
  const values=new Map<string,QuotaObservation>();
  for(const group of groups)for(const bucket of group.buckets) {
    const label=(group.name+' '+bucket.id).toLowerCase();
    const pool=/claude|gpt|third.party|\b3p\b/.test(label)?'third_party':/gemini/.test(label)?'gemini':null;
    const w=(bucket.window+' '+bucket.id).toLowerCase();
    const window=/weekly|\bweek\b|\b7d\b/.test(w)?'week':/5h|five.?hour|five_hour/.test(w)?'fiveHour':null;
    if(!pool||!window)continue;
    const key=pool+window,old=values.get(key);
    // A family pool can cover several upstream buckets: its tightest bucket wins.
    const bucketKey=JSON.stringify([group.name,bucket.id]);
    if(!old||bucket.remaining_fraction<old.fraction||bucket.remaining_fraction===old.fraction&&bucketKey<old.bucketKey)
      values.set(key,{pool,window,fraction:bucket.remaining_fraction,at,bucketKey,
        resetAt:bucket.reset_time?Math.floor(Date.parse(bucket.reset_time)/1000):null});
  }
  return [...values.values()];
}
