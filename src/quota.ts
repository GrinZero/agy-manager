import {HttpError, integer, string} from './security';
import type {Invocation, Limits, Member, Policy, Pool, UsageRow} from './types';
import {
  FIVE_HOURS, WEEK, MOTHER_GRACE_SECONDS,
  upperRateSql, activeUsageSql, budgetStatement, budgetView, type BudgetRow
} from './quota-state';
import {cyclesReadySql,cycleUsageSql,ensureUsageTotals} from './usage-totals';

export {FIVE_HOURS, WEEK, MOTHER_GRACE_SECONDS};
export {overviewUsage} from './usage-statistics';

export function roundPoints(value: number) {
  return Math.round(value * 1000) / 1000;
}
export function invocation(body: Record<string, unknown>): Invocation {
  const opt = (key: string) => body[key] === undefined ? undefined : integer(body[key], key, 0, 100_000_000);
  return {
    modelName: string(body.modelName, 'modelName'),
    conversationId: string(body.conversationId, 'conversationId'),
    invocationNum: integer(body.invocationNum, 'invocationNum', 0, Number.MAX_SAFE_INTEGER),
    contextTokens: opt('contextTokens'),
    inputTokens: opt('inputTokens'),
    cacheReadTokens: opt('cacheReadTokens'),
    outputTokens: opt('outputTokens'),
    toolCalls: opt('toolCalls')
  };
}
function effortFactor(model: string) {
  if (/(?:^|[-_\s(])low(?:$|[-_\s)])/.test(model)) return 0.6;
  if (/(?:^|[-_\s(])high(?:$|[-_\s)])/.test(model)) return 1.5;
  return 1;
}
export function resolveRule(model: string, p: Policy): {pool: Pool; weight: number} {
  const m = model.trim().toLowerCase();
  const factor = effortFactor(m);
  if (m.includes('claude')) {
    const base = m.includes('opus') ? p.opus_weight : m.includes('haiku') ? roundPoints(p.tp_weight * 0.4) : p.tp_weight;
    return {pool: 'third_party', weight: Math.max(0.05, roundPoints(base * factor))};
  }
  if (m.includes('gpt')) {
    const base = m.includes('mini') || m.includes('nano') ? roundPoints(p.tp_weight * 0.4) : p.tp_weight;
    return {pool: 'third_party', weight: Math.max(0.05, roundPoints(base * factor))};
  }
  // Orchestrator has no provider prefix in the picker. Until an official cost
  // ratio is available, use the same Gemini base prior as Hydrogen and Auto.
  const orchestrator = /^orchestrator(?:[-_\s]+(?:low|medium|high)|\s*\((?:low|medium|high)\))?$/.test(m);
  if (m.includes('gemini') || orchestrator || m === 'auto' || m.startsWith('auto ') || m.startsWith('auto-')) {
    const base = m.includes('flash') ? p.flash_weight : m.includes('carbon') ? roundPoints(p.gemini_weight * 0.75) : m.includes('argon') ? roundPoints(p.gemini_weight * 1.15) : p.gemini_weight;
    return {pool: 'gemini', weight: Math.max(0.05, roundPoints(base * factor))};
  }
  throw new HttpError(422, '未识别模型，请先确认模型分组');
}

// High-percentile pre-invocation reservation in Standard Consumption Units (u):
// scales up automatically when known conversation context exceeds ~166k tokens.
export function reserveUnits(ruleWeight: number, contextTokens = 0): number {
  const ctx = Math.max(0, contextTokens);
  const factor = Math.max(1, (25_000 + 0.15 * ctx) / 50_000);
  return Math.max(0.05, roundPoints(ruleWeight * factor));
}

// Piecewise-linear, strictly uncapped token settlement in Standard Consumption Units (u):
// Incremental uncached input up to 25k is 1x; uncached context >25k (such as 5-minute implicit prompt cache
// expiry re-prefilling conversation history) is 0.2x (2x warm cache 0.1x), preventing an 8x-10x single-step
// penalty after a short pause while staying strictly uncapped for arbitrarily large inputs and outputs.
export function settleWeight(ruleWeight: number, i: Invocation): number {
  if (i.inputTokens === undefined && i.cacheReadTokens === undefined && i.outputTokens === undefined) return ruleWeight;
  const input = i.inputTokens ?? 0, cache = i.cacheReadTokens ?? 0, output = i.outputTokens ?? 0;
  const freshInput = Math.min(input, 25_000), coldPrefix = Math.max(0, input - 25_000);
  const effectiveTokens = 500 + freshInput + 0.2 * coldPrefix + 0.1 * cache + 5 * output;
  return Math.max(0.01, roundPoints(ruleWeight * (effectiveTokens / 50_000)));
}

export function limits(l: Limits, pool: Pool, buffer = 0) {
  const factor = (100 - buffer) / 100;
  return {
    fiveHour: roundPoints((pool === 'gemini' ? l.gemini_5h_limit : l.tp_5h_limit) * factor),
    week: roundPoints((pool === 'gemini' ? l.gemini_wk_limit : l.tp_wk_limit) * factor)
  };
}

// Returns tracked usage (committed in current cycle + live holds) in percentage points (0..100%).
function usageStatement(db: D1Database, pool: Pool, now: number, memberId?: string) {
  const k5 = upperRateSql(pool, 'fiveHour'), kw = upperRateSql(pool, 'week');
  return db.prepare(`SELECT
    ROUND(COALESCE(SUM(five_units),0) * ${k5} * 100, 3) AS fiveHour,
    ROUND(COALESCE(SUM(week_units),0) * ${kw} * 100, 3) AS week
    FROM (${cycleUsageSql(pool,now)}) ${memberId ? 'WHERE member_id=?' : ''}`)
    .bind(...(memberId ? [memberId] : []));
}
export async function usage(db: D1Database, pool: Pool, now: number, memberId?: string) {
  await ensureUsageTotals(db,pool,now);
  const res = (await usageStatement(db, pool, now, memberId).first<{fiveHour: number; week: number}>())!;
  return {fiveHour: roundPoints(res.fiveHour), week: roundPoints(res.week)};
}
export async function reconciledBudget(db: D1Database, p: Policy, pool: Pool, now: number) {
  const rows = await budgetStatement(db, pool, now).all<BudgetRow>();
  return budgetView(rows.results, p, pool, now);
}
export function quotaMessage(quota: ReturnType<typeof budgetView>, units: number, reserved = true) {
  const describe = (key: 'fiveHour' | 'week') => {
    const b = quota[key];
    const upper = b.upperPercentPerUnit.toLocaleString('zh-CN', {maximumFractionDigits: 4});
    const cost = roundPoints(units * b.upperPercentPerUnit);
    const source = b.source === 'learned' ? `区间上界 ${upper}%/当量，${b.sampleCount} 个样本` : b.source === 'disabled' ? '固定先验' : '初始保守上界';
    return `${key === 'fiveHour' ? '5 小时' : '周'}：预计 ${cost}%（${source}）；${b.graceValid ? `官方可用 ${b.remainingPercent}%` : '官方快照待刷新'}`;
  };
  const prefix = reserved ? `预冻结 ${roundPoints(units)} 当量（完成后按实际 Token 结算）` : `本轮预估 ${roundPoints(units)} 当量（未冻结）`;
  return `【动态配额账本】${prefix}。${describe('fiveHour')}。${describe('week')}。`;
}
export function memberBalanceMessage(
  member: Pick<Member, 'name'>,
  pool: Pool,
  mu: {fiveHour: number; week: number},
  ml: {fiveHour: number; week: number},
  reqPct: {fiveHour: number; week: number}
) {
  const rem5 = Math.max(0, roundPoints(ml.fiveHour - mu.fiveHour));
  const remw = Math.max(0, roundPoints(ml.week - mu.week));
  return `【个人配额余额】${member.name} 的 ${pool} 池：个人 5h ${roundPoints(mu.fiveHour)}%/${ml.fiveHour}%，7d ${roundPoints(mu.week)}%/${ml.week}%。本轮预冻结 5h ${reqPct.fiveHour}% / 7d ${reqPct.week}%，个人剩余可用 5h ${rem5}% / 7d ${remw}%。`;
}
function existingStatement(db: D1Database, m: Member, i: Invocation) {
  return db.prepare('SELECT * FROM usage_logs WHERE member_id = ? AND conversation_id = ? AND invocation_num = ?')
    .bind(m.member_id, i.conversationId, i.invocationNum);
}
function match(row: UsageRow, i: Invocation) {
  if (row.model_name !== i.modelName) throw new HttpError(409, '同一调用标识的模型不一致');
}

function windowAvailSql(pool: Pool, window: 'fiveHour' | 'week', now: number, kExpr: string, buffer: number) {
  const after = `MAX(b.snapshot_at, CASE WHEN c.reset_at IS NOT NULL AND c.reset_at <= ${now} AND b.snapshot_at < c.reset_at THEN c.reset_at ELSE 0 END)`;
  return `COALESCE((
    SELECT (
      (CASE WHEN c.reset_at IS NOT NULL AND c.reset_at <= ${now} AND b.snapshot_at < c.reset_at THEN 1.0 ELSE b.remaining_fraction END)
      - COALESCE((SELECT SUM(weight) FROM (${activeUsageSql(pool, after, now)})), 0) * ${kExpr}
    ) * 100.0 - ${buffer}
    FROM real_quota_budgets b
    LEFT JOIN quota_calibration c ON c.pool_group='${pool}' AND c.window_name='${window}'
    WHERE b.pool_group='${pool}' AND b.window_name='${window}' AND b.snapshot_at >= ${now - MOTHER_GRACE_SECONDS}
  ), 100.0)`;
}

export async function check(db: D1Database, member: Member, p: Policy, i: Invocation, now: number) {
  const {pool, weight: ruleWeight} = resolveRule(i.modelName, p);
  await ensureUsageTotals(db,pool,now);
  const ml = limits(member, pool), fl = limits(p, pool, p.buffer_percent);
  const k5 = upperRateSql(pool, 'fiveHour'), kw = upperRateSql(pool, 'week');
  const real5Expr = windowAvailSql(pool, 'fiveHour', now, 'rates.k5', p.buffer_percent);
  const realwExpr = windowAvailSql(pool, 'week', now, 'rates.kw', p.buffer_percent);

  // Single serialized SQL write: checks mother account grace health, context-aware P95 reservation,
  // member share %, family cap %, and real mother official % ceiling without last-drop overdrafts.
  const reservation = db.prepare(`WITH
    rates AS (SELECT ${k5} AS k5, ${kw} AS kw),
    ctx AS (
      SELECT MAX(?, COALESCE((
        SELECT COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(output_tokens,0)
        FROM usage_logs WHERE member_id=? AND conversation_id=? AND status='committed'
        ORDER BY id DESC LIMIT 1
      ), 0)) AS tokens
    ),
    req AS (SELECT ROUND(MAX(0.05, ? * MAX(1.0, (25000.0 + 0.15 * tokens) / 50000.0)), 3) AS u FROM ctx),
    mother_gate AS (
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM mother_account m
        WHERE m.id=1 AND m.status!='auth_required' AND m.checked_at IS NOT NULL AND m.checked_at >= (? - ${MOTHER_GRACE_SECONDS}) * 1000
      ) AND EXISTS (
        SELECT 1 FROM real_quota_budgets b
        WHERE b.pool_group=? AND b.snapshot_at >= ? - ${MOTHER_GRACE_SECONDS}
      ) THEN 1 ELSE 0 END AS ok
    ),
    active AS (
      ${cycleUsageSql(pool,now)}
    ),
    totals AS (
      SELECT
        COALESCE(SUM(CASE WHEN member_id=? THEN five_units ELSE 0 END),0) AS mu5,
        COALESCE(SUM(CASE WHEN member_id=? THEN week_units ELSE 0 END),0) AS muw,
        COALESCE(SUM(five_units),0) AS fu5,
        COALESCE(SUM(week_units),0) AS fuw
      FROM active
    ),
    real_caps AS (
      SELECT ${real5Expr} AS avail5, ${realwExpr} AS availw FROM rates
    )
    INSERT INTO usage_logs (member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at)
    SELECT ?,?,?,req.u,?,?,'reserved',?,?
    FROM totals, rates, req, mother_gate, real_caps
    WHERE mother_gate.ok = 1 AND ${cyclesReadySql(pool,now)}
      AND ? > 0 AND ? > 0 AND ? > 0 AND ? > 0
      AND (totals.mu5 + req.u) * rates.k5 * 100.0 <= ? + 1e-6
      AND (totals.muw + req.u) * rates.kw * 100.0 <= ? + 1e-6
      AND (totals.fu5 + req.u) * rates.k5 * 100.0 <= ? + 1e-6
      AND (totals.fuw + req.u) * rates.kw * 100.0 <= ? + 1e-6
      AND real_caps.avail5 >= req.u * rates.k5 * 100.0 - 1e-6
      AND real_caps.availw >= req.u * rates.kw * 100.0 - 1e-6
    ON CONFLICT(member_id,conversation_id,invocation_num) DO UPDATE SET
      model_name=excluded.model_name,status='reserved',created_at=excluded.created_at,expires_at=excluded.expires_at,
      weight=excluded.weight,pool_group=excluded.pool_group
    WHERE usage_logs.status='released' OR usage_logs.status='reserved' AND usage_logs.expires_at<=?`)
    .bind(
      i.contextTokens ?? 0, member.member_id, i.conversationId,
      ruleWeight,
      now, pool, now,
      member.member_id, member.member_id,
      member.member_id, pool, i.modelName, i.conversationId, i.invocationNum, now, now + p.reservation_seconds,
      ml.fiveHour, ml.week, fl.fiveHour, fl.week,
      ml.fiveHour, ml.week, fl.fiveHour, fl.week,
      now
    );

  const motherStmt = db.prepare(`SELECT status, checked_at,${cyclesReadySql(pool,now)} AS totals_ready FROM mother_account WHERE id = 1`);
  const latestCtxStmt = db.prepare(`SELECT COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(output_tokens,0) AS tokens
    FROM usage_logs WHERE member_id=? AND conversation_id=? AND status='committed' ORDER BY id DESC LIMIT 1`)
    .bind(member.member_id, i.conversationId);

  const [result, identity, budgets, motherRes, ctxRes] = await db.batch([
    reservation,
    existingStatement(db, member, i),
    budgetStatement(db, pool, now),
    motherStmt,
    latestCtxStmt
  ]);

  const quota = budgetView(budgets.results as unknown as BudgetRow[], p, pool, now);
  const row = identity.results[0] as unknown as UsageRow | undefined;
  const motherRow = motherRes.results[0] as unknown as {status: string; checked_at: number | null;totals_ready:number} | undefined;
  if(motherRow&&!motherRow.totals_ready)throw new HttpError(503,'额度账期正在切换，请稍后重试');
  const dbCtx = (ctxRes.results[0] as unknown as {tokens?: number} | undefined)?.tokens ?? 0;

  if (row && (row.status === 'committed' || row.status === 'reserved' && row.expires_at > now)) match(row, i);
  const admitted = result.meta.changes > 0 || row?.status === 'reserved' && row.expires_at > now;
  const effectiveUnits = row?.status === 'reserved' && row.expires_at > now
    ? roundPoints(row.weight)
    : reserveUnits(ruleWeight, Math.max(i.contextTokens ?? 0, dbCtx));
  const reqPct = {
    fiveHour: roundPoints(effectiveUnits * quota.fiveHour.upperPercentPerUnit),
    week: roundPoints(effectiveUnits * quota.week.upperPercentPerUnit)
  };
  if(admitted&&i.invocationNum%10_000!==0)return {quota,injectSteps:[]};
  // Only balance notifications and denied calls need the display totals.
  const [memberUsage,familyUsage]=await db.batch([
    usageStatement(db,pool,now,member.member_id),usageStatement(db,pool,now)
  ]);
  const mu=memberUsage.results[0] as unknown as {fiveHour:number;week:number};
  const fu=familyUsage.results[0] as unknown as {fiveHour:number;week:number};

  if (!admitted) {
    if (!motherRow) {
      return {
        quota,
        injectSteps: [{errorMessage: {userMessage: '【母账号未连接】家庭管理员尚未连接母账号，无法核实官方额度池，本次调用已暂停。请联系管理员连接母账号。'}}],
        terminationBehavior: 'terminate'
      };
    }
    if (motherRow.status === 'auth_required') {
      return {
        quota,
        injectSteps: [{errorMessage: {userMessage: '【母账号授权失效】母账号 Google 授权已失效，无法同步官方额度，本次调用已暂停。请联系管理员重新连接母账号。'}}],
        terminationBehavior: 'terminate'
      };
    }
    const motherAgeMs = motherRow.checked_at === null ? Infinity : now * 1000 - motherRow.checked_at;
    if (motherAgeMs > MOTHER_GRACE_SECONDS * 1000 || !quota.fiveHour.graceValid && !quota.week.graceValid) {
      return {
        quota,
        injectSteps: [{errorMessage: {userMessage: '【官方额度同步超时】母账号额度快照已超过 15 分钟未刷新，无法确认安全配额，本次调用已暂停。请稍后重试或联系管理员刷新母账号。'}}],
        terminationBehavior: 'terminate'
      };
    }
    const realExhausted =
      quota.fiveHour.graceValid && quota.fiveHour.officialPercent !== null && quota.fiveHour.remainingPercent - p.buffer_percent < reqPct.fiveHour - 1e-6 ||
      quota.week.graceValid && quota.week.officialPercent !== null && quota.week.remainingPercent - p.buffer_percent < reqPct.week - 1e-6;
    if (realExhausted) {
      const msg = `【官方配额触底】${pool} 池官方可用余量不足（官方扣除在途后 5h 剩 ${quota.fiveHour.remainingPercent}%，7d 剩 ${quota.week.remainingPercent}%，安全留白 ${p.buffer_percent}%；本轮需预留 5h ${reqPct.fiveHour}% / 7d ${reqPct.week}%）。请切换轻量模型、切换其他模型池或等待官方重置。`;
      return {quota, injectSteps: [{errorMessage: {userMessage: msg}}], terminationBehavior: 'terminate'};
    }
    const message = `【家庭配额上限】${member.name} 的 ${pool} 池：个人 5h ${roundPoints(mu.fiveHour)}%/${ml.fiveHour}%，7d ${roundPoints(mu.week)}%/${ml.week}%；家庭 5h ${roundPoints(fu.fiveHour)}%/${fl.fiveHour}%，7d ${roundPoints(fu.week)}%/${fl.week}%。本轮需预留 5h ${reqPct.fiveHour}% / 7d ${reqPct.week}%，超出可用配额，请切换轻量模型、等待重置或联系管理员调整比例。`;
    return {quota, injectSteps: [{errorMessage: {userMessage: message}}], terminationBehavior: 'terminate'};
  }

  const officialLow =
    quota.fiveHour.graceValid && quota.fiveHour.officialPercent !== null && quota.fiveHour.remainingPercent - p.buffer_percent < 20 ||
    quota.week.graceValid && quota.week.officialPercent !== null && quota.week.remainingPercent - p.buffer_percent < 20;
  const lowBalance = officialLow || [
    [mu.fiveHour, ml.fiveHour], [mu.week, ml.week], [fu.fiveHour, fl.fiveHour], [fu.week, fl.week]
  ].some(([used, cap]) => cap > 0 && (cap - used) / cap < 0.2);

  if (i.invocationNum % 10_000 === 0) {
    const base = memberBalanceMessage(member, pool, mu, ml, reqPct);
    const userMarkdown = lowBalance ? `${base} 配额余量不足 20%，请留意后续用量。` : base;
    return {quota, injectSteps: [{systemMessage: {systemMessage: '', metadata: {user_markdown: userMarkdown}}}]};
  }
  return {quota, injectSteps: []};
}

export async function commit(db: D1Database, member: Member, p: Policy, i: Invocation, now: number) {
  const rule = resolveRule(i.modelName, p);
  const hasTelemetry = i.inputTokens !== undefined || i.cacheReadTokens !== undefined || i.outputTokens !== undefined;
  const settled = settleWeight(rule.weight, i);
  // Late/offline commits record real use even if it exceeds limits. Never silently lose usage.
  // When token telemetry is present, update weight to the settled token-based cost; otherwise preserve the reserved weight.
  const write = db.prepare(`INSERT INTO usage_logs
    (member_id,pool_group,model_name,weight,conversation_id,invocation_num,status,created_at,expires_at,committed_at,source,input_tokens,cache_read_tokens,output_tokens,tool_calls)
    VALUES (?,?,?,?,?,?,'committed',?,?,?,'offline_commit',?,?,?,?)
    ON CONFLICT(member_id,conversation_id,invocation_num) DO UPDATE SET
      status = 'committed',
      committed_at = excluded.committed_at,
      weight = CASE WHEN ? THEN excluded.weight ELSE usage_logs.weight END,
      input_tokens = COALESCE(excluded.input_tokens, usage_logs.input_tokens),
      cache_read_tokens = COALESCE(excluded.cache_read_tokens, usage_logs.cache_read_tokens),
      output_tokens = COALESCE(excluded.output_tokens, usage_logs.output_tokens),
      tool_calls = COALESCE(excluded.tool_calls, usage_logs.tool_calls)
    WHERE usage_logs.status != 'committed' AND usage_logs.model_name = excluded.model_name`)
    .bind(
      member.member_id, rule.pool, i.modelName, settled, i.conversationId, i.invocationNum, now, now, now,
      i.inputTokens ?? null, i.cacheReadTokens ?? null, i.outputTokens ?? null, i.toolCalls ?? null,
      hasTelemetry ? 1 : 0
    );
  const [, identity] = await db.batch([write, existingStatement(db, member, i)]);
  const saved = identity.results[0] as unknown as UsageRow | undefined;
  if (saved) match(saved, i);
}

export async function release(db: D1Database, member: Member, conversationId: string, invocationNum?: number) {
  await db.prepare(`UPDATE usage_logs SET status = 'released' WHERE member_id = ? AND conversation_id = ?
    AND status = 'reserved'${invocationNum === undefined ? '' : ' AND invocation_num = ?'}`)
    .bind(...(invocationNum === undefined ? [member.member_id, conversationId] : [member.member_id, conversationId, invocationNum])).run();
}
