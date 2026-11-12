import {hashToken,HttpError,newToken,requireAdmin} from './security';
import type {Env} from './types';

const SESSION_SECONDS=7*24*60*60;
interface Identity {email:string;google_id:string|null}
export function configuredEmail(env:Env) {return env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase()||null;}
export async function adminIdentity(env:Env) {
  return env.DB.prepare('SELECT email,google_id FROM admin_identity WHERE id=1').first<Identity>();
}
type CookieKind='admin'|'oauth';
function cookieName(req:Request,kind:CookieKind) {
  return `${new URL(req.url).protocol==='https:'?'__Host-':''}agy_${kind}`;
}
export function cookieValue(req:Request,kind:CookieKind) {
  const name=cookieName(req,kind)+'=';
  return (req.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name))?.slice(name.length)||'';
}
export function setCookie(req:Request,kind:CookieKind,value:string,seconds:number) {
  return `${cookieName(req,kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(req.url).protocol==='https:'?'; Secure':''}`;
}
export function requireSameOrigin(req:Request) {
  if(req.headers.get('Origin')!==new URL(req.url).origin || req.headers.get('Sec-Fetch-Site')==='cross-site')
    throw new HttpError(403,'请从管理页面发起操作');
}
export async function browserSession(req:Request,env:Env) {
  const token=cookieValue(req,'admin');
  if(!/^agy_[a-f0-9]{64}$/.test(token))return null;
  const session=await env.DB.prepare(`SELECT s.email,s.google_id FROM admin_sessions s JOIN admin_identity i
    ON i.id=1 AND i.email=s.email AND i.google_id=s.google_id WHERE s.token_hash=? AND s.expires_at>?`)
    .bind(await hashToken(token),Date.now()).first<Identity>();
  if(session&&(!configuredEmail(env)||configuredEmail(env)===session.email))return {...session,role:'admin' as const};
  return env.DB.prepare(`SELECT s.email,s.google_id,s.member_id,'member' AS role FROM member_sessions s JOIN members m
    ON m.member_id=s.member_id AND m.email=s.email AND m.google_id=s.google_id
    WHERE s.token_hash=? AND s.expires_at>? AND m.enabled=1 AND m.deleted_at IS NULL`)
    .bind(await hashToken(token),Date.now()).first<Identity & {role:'member';member_id:string}>();
}
export async function authenticateAdmin(req:Request,env:Env) {
  if(req.headers.has('Authorization'))return requireAdmin(req,env.ADMIN_TOKEN||'');
  const session=await browserSession(req,env);
  if(!session)throw new HttpError(401,'请使用 Google 账号登录');
  if(session.role!=='admin')throw new HttpError(403,'此操作仅限家庭管理员');
  if(!['GET','HEAD'].includes(req.method))requireSameOrigin(req);
}
export async function createMemberSession(req:Request,env:Env,email:string,googleId:string) {
  const token=newToken(),hash=await hashToken(token),now=Date.now();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE members SET google_id=? WHERE email=? AND deleted_at IS NULL AND enabled=1
      AND (google_id IS NULL OR google_id=?)`).bind(googleId,email,googleId),
    env.DB.prepare('DELETE FROM member_sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare(`INSERT INTO member_sessions (token_hash,member_id,email,google_id,expires_at)
      SELECT ?,member_id,email,google_id,? FROM members
      WHERE email=? AND google_id=? AND enabled=1 AND deleted_at IS NULL`).bind(hash,now+SESSION_SECONDS*1000,email,googleId)
  ]);
  if(!results[2].meta.changes)throw new HttpError(403,'此邮箱尚未绑定可用成员，请联系管理员确认邮箱和成员状态');
  return setCookie(req,'admin',token,SESSION_SECONDS);
}
export async function verifyGoogleAdmin(env:Env,email:string,googleId:string,allowReplacement:boolean) {
  const owner=await adminIdentity(env),configured=configuredEmail(env);
  const expected=configured||owner?.email;
  if(!allowReplacement&&!expected)throw new HttpError(503,'请先配置母账号管理员邮箱，或用管理员令牌连接一次母账号');
  if((configured||!allowReplacement)&&email!==expected)throw new HttpError(403,'此 Google 账号不是家庭管理员，请选择母账号');
  if(owner?.email===email&&owner.google_id&&owner.google_id!==googleId)throw new HttpError(403,'Google 账号身份与管理员记录不匹配');
  return owner;
}
export async function createBrowserSession(req:Request,env:Env,owner:{email:string;google_id:string}) {
  const token=newToken();
  const results=await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(Date.now()),
    env.DB.prepare(`INSERT INTO admin_sessions (token_hash,email,google_id,expires_at)
      SELECT ?,email,google_id,? FROM admin_identity WHERE id=1 AND email=? AND google_id=?`)
      .bind(await hashToken(token),Date.now()+SESSION_SECONDS*1000,owner.email,owner.google_id)
  ]);
  if(!results[1].meta.changes)throw new HttpError(409,'管理员身份已变更，请重新登录');
  return setCookie(req,'admin',token,SESSION_SECONDS);
}
