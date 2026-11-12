import {bearer, hashToken, HttpError, integer, json, newToken, readBody, real, string} from './security';
import {check, commit, invocation, limits, release, roundPoints, usage, reconciledBudget} from './quota';
import type {Env, Limits, Member, Policy} from './types';
import {motherAccount, motherAdmin, refreshMother} from './mother-account';
import {authenticateAdmin, browserSession, requireSameOrigin} from './admin-session';
import {auth} from './auth';

const limitFields = ['gemini_5h_limit', 'gemini_wk_limit', 'tp_5h_limit', 'tp_wk_limit'] as const;
const defaultLimits: Limits = {gemini_5h_limit: 25, gemini_wk_limit: 25, tp_5h_limit: 25, tp_wk_limit: 25};
function readLimits(body: Record<string, unknown>, defaults: Limits): Limits {
  return Object.fromEntries(limitFields.map(k => [k, body[k] === undefined ? defaults[k] : real(body[k], k, 0, 100)])) as unknown as Limits;
}
async function policy(db: D1Database) {
  const p = await db.prepare('SELECT * FROM policy WHERE id = 1').first<Policy>();
  if (!p) throw new HttpError(503, '数据库尚未初始化，请先执行迁移');
  return {...p, real_quota_guard: 1, real_quota_floor: 0};
}
function safeMember({token_hash: _hash, google_id: _googleId, ...member}: Member) { return member; }
async function overview(db: D1Database, now: number, memberId?: string) {
  const [p, all, events] = await Promise.all([
    policy(db),
    db.prepare(`SELECT * FROM members WHERE deleted_at IS NULL ${memberId ? 'AND member_id=?' : ''} ORDER BY created_at, member_id`).bind(...(memberId ? [memberId] : [])).all<Member>(),
    db.prepare(`SELECT u.id,u.member_id,m.name,u.pool_group,u.model_name,u.weight,u.status,u.created_at,u.committed_at,u.expires_at,u.source,u.input_tokens,u.cache_read_tokens,u.output_tokens,u.tool_calls
      FROM usage_logs u JOIN members m ON m.member_id = u.member_id ${memberId ? 'WHERE u.member_id=?' : ''} ORDER BY u.id DESC LIMIT 80`).bind(...(memberId ? [memberId] : [])).all()
  ]);
  const pools = await Promise.all((['gemini', 'third_party'] as const).map(async pool => ({
    pool,
    usage: await usage(db, pool, now),
    limits: limits(p, pool, p.buffer_percent),
    totalLimits: limits(p, pool),
    realBudget: await reconciledBudget(db, p, pool, now)
  })));
  const rateByPool = Object.fromEntries(pools.map(item => [item.pool, item.realBudget]));
  const enrichedEvents = (events.results as Record<string, any>[]).map(e => {
    const rb = rateByPool[e.pool_group];
    return {
      ...e,
      five_hour_percent: rb ? roundPoints(Number(e.weight) * rb.fiveHour.upperPercentPerUnit) : 0,
      week_percent: rb ? roundPoints(Number(e.weight) * rb.week.upperPercentPerUnit) : 0
    };
  });
  const members = await Promise.all(all.results.map(async m => ({
    ...safeMember(m),
    usage: {
      gemini: await usage(db, 'gemini', now, m.member_id),
      third_party: await usage(db, 'third_party', now, m.member_id)
    }
  })));
  const mother = await motherAccount({DB: db}, now * 1000);
  return {
    policy: p,
    pools,
    members,
    events: enrichedEvents,
    mother: memberId && mother ? {
      status: mother.status,
      checked_at: mother.checked_at,
      stale: mother.stale,
      grace_expired: mother.grace_expired,
      snapshot: mother.snapshot
    } : mother,
    now
  };
}
function memberEmail(value: unknown) {
  const email = string(value, 'Google 邮箱', 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, '请输入有效的 Google 账号邮箱');
  return email;
}
async function saveMember(statement: D1PreparedStatement) {
  try { return await statement.run(); }
  catch (error) {
    if (String(error).includes('UNIQUE constraint failed: members.email')) throw new HttpError(409, '此邮箱已绑定其他成员');
    throw error;
  }
}
async function memberPortal(req: Request, env: Env, path: string) {
  const session = await browserSession(req, env);
  if (!session) throw new HttpError(401, '请使用绑定的 Google 邮箱登录');
  if (session.role !== 'member') throw new HttpError(403, '请使用成员账号访问');
  if (path === '/api/member/overview' && req.method === 'GET') return json({...await overview(env.DB, Math.floor(Date.now() / 1000), session.member_id), viewer: {role: 'member', email: session.email}});
  if (path === '/api/member/rotate-token' && req.method === 'POST') {
    requireSameOrigin(req);
    const token = newToken();
    const updated = await env.DB.prepare(`UPDATE members SET token_hash=? WHERE member_id=? AND email=? AND google_id=? AND enabled=1 AND deleted_at IS NULL RETURNING member_id,name`)
      .bind(await hashToken(token), session.member_id, session.email, session.google_id).first<{member_id: string; name: string}>();
    if (!updated) throw new HttpError(401, '成员状态已变更，请重新登录');
    return json({...updated, token});
  }
  throw new HttpError(404, '接口不存在');
}
async function admin(req: Request, env: Env, path: string): Promise<Response> {
  await authenticateAdmin(req, env);
  const now = Math.floor(Date.now() / 1000);
  if (path === '/api/admin/overview' && req.method === 'GET') return json(await overview(env.DB, now));
  if (path.startsWith('/api/admin/mother')) return motherAdmin(req, env, path);
  if (path === '/api/admin/members' && req.method === 'POST') {
    const b = await readBody(req), l = readLimits(b, defaultLimits), name = string(b.name, 'name', 60);
    const email = memberEmail(b.email);
    const token = newToken(), id = crypto.randomUUID();
    await saveMember(env.DB.prepare(`INSERT INTO members
      (member_id,name,email,token_hash,gemini_5h_limit,gemini_wk_limit,tp_5h_limit,tp_wk_limit,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, name, email, await hashToken(token), l.gemini_5h_limit, l.gemini_wk_limit, l.tp_5h_limit, l.tp_wk_limit, now));
    return json({member_id: id, name, email, token}, 201);
  }
  const memberPath = /^\/api\/admin\/members\/([a-zA-Z0-9-]+)(\/rotate-token)?$/.exec(path);
  if (memberPath) {
    const m = await env.DB.prepare('SELECT * FROM members WHERE member_id = ? AND deleted_at IS NULL').bind(memberPath[1]).first<Member>();
    if (!m) throw new HttpError(404, '成员不存在');
    if (!memberPath[2] && req.method === 'DELETE') {
      // Keep usage and pending settlements so deletion never refunds consumed family quota.
      await env.DB.batch([
        env.DB.prepare('UPDATE members SET enabled = 0, deleted_at = ? WHERE member_id = ?').bind(now, m.member_id),
        env.DB.prepare('DELETE FROM member_sessions WHERE member_id = ?').bind(m.member_id)
      ]);
      return json({ok: true});
    }
    if (memberPath[2] && req.method === 'POST') {
      const token = newToken();
      await env.DB.prepare('UPDATE members SET token_hash = ? WHERE member_id = ?').bind(await hashToken(token), m.member_id).run();
      return json({member_id: m.member_id, name: m.name, token});
    }
    if (!memberPath[2] && req.method === 'PATCH') {
      const b = await readBody(req), l = readLimits(b, m);
      const name = b.name === undefined ? m.name : string(b.name, 'name', 60);
      const enabled = b.enabled === undefined ? m.enabled : integer(b.enabled, 'enabled', 0, 1);
      const email = b.email === undefined ? m.email : memberEmail(b.email), changed = email !== m.email;
      // Changing the email also clears the pinned Google identity. Revoke sessions
      // in the same transaction so returning to an earlier email cannot revive them.
      try {
        await env.DB.batch([
          env.DB.prepare(`UPDATE members SET name=?,email=?,google_id=?,enabled=?,gemini_5h_limit=?,gemini_wk_limit=?,tp_5h_limit=?,tp_wk_limit=? WHERE member_id=?`)
            .bind(name, email, changed ? null : m.google_id, enabled, l.gemini_5h_limit, l.gemini_wk_limit, l.tp_5h_limit, l.tp_wk_limit, m.member_id),
          env.DB.prepare('DELETE FROM member_sessions WHERE member_id=? AND ?').bind(m.member_id, changed || !enabled ? 1 : 0)
        ]);
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed: members.email')) throw new HttpError(409, '此邮箱已绑定其他成员');
        throw error;
      }
      return json({ok: true});
    }
  }
  if (path === '/api/admin/policy' && req.method === 'PATCH') {
    const b = await readBody(req), old = await policy(env.DB), l = readLimits(b, old);
    const buffer = b.buffer_percent === undefined ? old.buffer_percent : integer(b.buffer_percent, 'buffer_percent', 0, 99);
    const ttl = b.reservation_seconds === undefined ? old.reservation_seconds : integer(b.reservation_seconds, 'reservation_seconds', 30, 3600);
    const adaptive = b.calibration_enabled === undefined ? old.calibration_enabled : integer(b.calibration_enabled, 'calibration_enabled', 0, 1);
    const weights = (['flash_weight', 'gemini_weight', 'tp_weight', 'opus_weight'] as const)
      .map(k => b[k] === undefined ? old[k] : real(b[k], k, 0.1, 10000));
    await env.DB.prepare(`UPDATE policy SET gemini_5h_limit=?,gemini_wk_limit=?,tp_5h_limit=?,tp_wk_limit=?,
      buffer_percent=?,reservation_seconds=?,flash_weight=?,gemini_weight=?,tp_weight=?,opus_weight=?,real_quota_guard=?,real_quota_floor=?,calibration_enabled=? WHERE id=1`)
      .bind(l.gemini_5h_limit, l.gemini_wk_limit, l.tp_5h_limit, l.tp_wk_limit, buffer, ttl, ...weights, 1, 0, adaptive).run();
    return json({ok: true});
  }
  throw new HttpError(404, '接口不存在');
}
let cachedClientSha256: string | null = null;
async function clientScriptSha256(req: Request, env: Env): Promise<string | null> {
  if (cachedClientSha256) return cachedClientSha256;
  if (!env.ASSETS) return null;
  try {
    const asset = await env.ASSETS.fetch(new URL('/client/agy-quota.mjs', req.url));
    if (!asset.ok) return null;
    const text = await asset.text();
    if (!text.startsWith('#!/usr/bin/env node')) return null;
    cachedClientSha256 = await hashToken(text);
    return cachedClientSha256;
  } catch { return null; }
}
async function hooks(req: Request, env: Env, path: string) {
  if (req.method !== 'POST') throw new HttpError(405, '请使用 POST');
  const respond = async (data: unknown) => {
    const res = json(data);
    const sha256 = await clientScriptSha256(req, env);
    if (sha256) res.headers.set('X-Agy-Client-Sha256', sha256);
    return res;
  };
  // Batch auth and policy: hooks have a strict latency budget, including cross-region D1 access.
  const reads = await env.DB.batch([
    env.DB.prepare('SELECT * FROM members WHERE token_hash = ?').bind(await hashToken(bearer(req))),
    env.DB.prepare('SELECT * FROM policy WHERE id = 1')
  ]);
  const member = reads[0].results[0] as unknown as Member | undefined;
  if (!member) throw new HttpError(401, '成员令牌无效');
  const body = await readBody(req);
  // Disabled members must still be able to report in-flight completions and release holds.
  if ((!member.enabled || member.deleted_at !== null) && path === '/check') return respond({injectSteps: [{errorMessage: {userMessage: member.deleted_at !== null ? '家庭配额：此成员已删除，请联系管理员。' : '家庭配额：此成员已暂停，请联系管理员。'}}], terminationBehavior: 'terminate'});
  if (path === '/release') {
    const conversationId = string(body.conversationId, 'conversationId');
    if (body.fullyIdle === true) await release(env.DB, member, conversationId);
    else if (body.invocationNum !== undefined) await release(env.DB, member, conversationId, integer(body.invocationNum, 'invocationNum', 0, Number.MAX_SAFE_INTEGER));
    return respond({});
  }
  const i = invocation(body), p = reads[1].results[0] as unknown as Policy | undefined, now = Math.floor(Date.now() / 1000);
  if (!p) throw new HttpError(503, '数据库尚未初始化');
  if (path === '/check') return respond(await check(env.DB, member, p, i, now));
  // Explicit failure fields are honored when clients supply them; current official PostInvocation has none.
  if (body.success === false || (typeof body.error === 'string' && body.error.length > 0)) await release(env.DB, member, i.conversationId, i.invocationNum);
  else await commit(env.DB, member, p, i, now);
  return respond({});
}
async function handleRequest(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  try {
    if (path === '/health' && req.method === 'GET') {
      const result = await env.DB.prepare('SELECT id FROM policy WHERE id=1').all();
      const response = json({ok: true, service: 'agy-manager'});
      response.headers.set('Server-Timing', `sql;dur=${result.meta.timings?.sql_duration_ms ?? result.meta.duration}`);
      return response;
    }
    if (path.startsWith('/api/auth/')) return await auth(req, env, path);
    if (path.startsWith('/api/admin/')) return await admin(req, env, path);
    if (path.startsWith('/api/member/')) return await memberPortal(req, env, path);
    if (['/check', '/commit', '/release'].includes(path)) return await hooks(req, env, path);
    if (path.startsWith('/api/')) throw new HttpError(404, '接口不存在');
    if (env.ASSETS && ['GET', 'HEAD'].includes(req.method)) {
      const asset = await env.ASSETS.fetch(req);
      const response = new Response(asset.body, asset);
      response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      return response;
    }
    throw new HttpError(404, '页面不存在');
  } catch (error) {
    if (error instanceof HttpError) return json({error: error.message}, error.status);
    // Do not log hook payloads, tokens, prompts or database errors.
    console.error('quota_request_failed', path);
    return json({error: '配额服务暂时不可用'}, 503);
  }
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const started = performance.now();
    const response = await handleRequest(req, env);
    // Durations only: never include request headers, payloads or identities.
    response.headers.append('Server-Timing', `app;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  },
  async scheduled(_event: ScheduledController, env: Env) { await refreshMother(env); }
};
