import {adminIdentity,browserSession,configuredEmail,cookieValue,requireSameOrigin,setCookie} from './admin-session';
import {finishOAuth,startOAuth} from './mother-account';
import {hashToken,HttpError,json,newToken,readBody,string} from './security';
import type {Env} from './types';

export async function auth(req:Request,env:Env,path:string):Promise<Response> {
  try {return await handleAuth(req,env,path);}
  catch(error) {
    if(path!=='/api/auth/google/callback'||req.method!=='GET')throw error;
    // Discard authorization codes from the address bar on every callback outcome.
    return new Response(null,{status:303,headers:{Location:'/?login_error=1','Cache-Control':'no-store',
      'Referrer-Policy':'no-referrer','Set-Cookie':setCookie(req,'oauth','',0)}});
  }
}
async function handleAuth(req:Request,env:Env,path:string):Promise<Response> {
  if(path==='/api/auth/status'&&req.method==='GET') {
    const session=await browserSession(req,env);
    return json({authenticated:!!session,google_login_available:!!(configuredEmail(env)||await adminIdentity(env)),
      ...(session?{role:session.role,email:session.email}: {})});
  }
  if(path==='/api/auth/logout'&&req.method==='POST') {
    requireSameOrigin(req);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await hashToken(cookieValue(req,'admin'))),
      env.DB.prepare('DELETE FROM member_sessions WHERE token_hash=?').bind(await hashToken(cookieValue(req,'admin'))),
      env.DB.prepare('DELETE FROM oauth_sessions WHERE browser_hash=?').bind(await hashToken(cookieValue(req,'oauth')))
    ]);
    const response=json({ok:true});
    response.headers.append('Set-Cookie',setCookie(req,'admin','',0));
    response.headers.append('Set-Cookie',setCookie(req,'oauth','',0));
    return response;
  }
  if(path==='/api/auth/google/start'&&req.method==='POST') {
    requireSameOrigin(req);
    if(!configuredEmail(env)&&!await adminIdentity(env))throw new HttpError(503,'请先配置母账号管理员邮箱，或用管理员令牌连接一次母账号');
    const nonce=newToken();
    const response=await startOAuth(env,{purpose:'login',browserHash:await hashToken(nonce),origin:new URL(req.url).origin});
    response.headers.append('Set-Cookie',setCookie(req,'oauth',nonce,600));
    return response;
  }
  const direct=path==='/api/auth/google/callback'&&req.method==='GET';
  if(direct||path==='/api/auth/google/finish'&&req.method==='POST') {
    if(!direct)requireSameOrigin(req);
    const nonce=cookieValue(req,'oauth');
    if(!/^agy_[a-f0-9]{64}$/.test(nonce))throw new HttpError(400,'请在发起登录的浏览器完成授权');
    const callback=direct?req.url:string((await readBody(req)).callback_url,'回调地址',6000);
    let purpose:'login'|'mother'='login';
    if(direct) {
      const state=new URL(req.url).searchParams.get('state')||'';
      const session=await env.DB.prepare('SELECT purpose FROM oauth_sessions WHERE state_hash=?').bind(await hashToken(state)).first<{purpose:string}>();
      if(session?.purpose==='mother')purpose='mother';
    }
    const result=await finishOAuth(env,callback,{purpose,browserHash:await hashToken(nonce),request:req});
    const landing=direct&&(await result.clone().json() as {role?:string}).role==='member'?'/#tutorial':'/';
    const response=direct?new Response(null,{status:303,headers:{Location:landing, 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':result.headers.get('Set-Cookie')!}}):result;
    response.headers.append('Set-Cookie',setCookie(req,'oauth','',0));
    return response;
  }
  throw new HttpError(404,'接口不存在');
}
