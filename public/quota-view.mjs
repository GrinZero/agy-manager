// Unified percentage-denominated quota view with 15-minute grace tolerance on mother account snapshots.
const FRESH_MS = 90_000;
const GRACE_MS = 900_000;
const round3 = value => Math.round(value * 1000) / 1000;

export function poolView(data, pool, nowMs = Date.now()) {
  const account = data.mother;
  const ageMs = account && Number.isFinite(account.checked_at) ? nowMs - account.checked_at : Infinity;
  const fresh = !!account && account.status === 'connected' && !account.stale && ageMs <= FRESH_MS;
  const graceValid = !!account && account.status !== 'auth_required' && !account.grace_expired && ageMs <= GRACE_MS;

  const buckets = (account?.snapshot?.groups || []).flatMap(group => group.buckets
    .filter(bucket => {
      const label = `${group.name} ${bucket.id || ''}`.toLowerCase();
      const type = /claude|gpt|third.party|\b3p\b/.test(label) ? 'third_party' : /gemini/.test(label) ? 'gemini' : null;
      return type === pool.pool;
    }));

  const windows = Object.fromEntries([['fiveHour', /5h|five.?hour|five_hour/], ['week', /weekly|\bweek\b|\b7d\b/]].map(([key, pattern]) => {
    const matching = buckets.filter(b => pattern.test(`${b.window} ${b.id || ''}`.toLowerCase()) && Number.isFinite(b.remaining_fraction));
    const tightest = matching.reduce((a, b) => !a || b.remaining_fraction < a.remaining_fraction ? b : a, null);
    const resetMs = tightest ? Date.parse(tightest.reset_time) : NaN;
    const rolledOverInGrace = graceValid && matching.length > 0 && Number.isFinite(resetMs) && resetMs <= nowMs && account.checked_at < resetMs;
    const effectiveFraction = tightest ? (rolledOverInGrace ? 1 : tightest.remaining_fraction) : null;
    return [key, {
      fraction: tightest?.remaining_fraction ?? null,
      effectiveFraction,
      resetTime: tightest?.reset_time ?? null,
      valid: fresh && matching.length > 0 && matching.every(b => Number.isFinite(Date.parse(b.reset_time)) && Date.parse(b.reset_time) > nowMs),
      usable: graceValid && matching.length > 0
    }];
  }));

  const buffer = data.policy?.buffer_percent ?? 0;
  const familyRem = Object.fromEntries(['fiveHour', 'week'].map(key => [
    key,
    round3(Math.max(0, (pool.limits?.[key] ?? 0) - (pool.usage?.[key] ?? 0)))
  ]));

  const hasAnyWindow = windows.fiveHour.usable || windows.week.usable;
  const officialAvail = Object.fromEntries(['fiveHour', 'week'].map(key => {
    const w = windows[key], rb = pool.realBudget?.[key];
    if (!w.usable) return [key, familyRem[key]];
    const basePct = rb && rb.officialPercent != null && rb.graceValid ? rb.remainingPercent : w.effectiveFraction * 100;
    return [key, round3(Math.max(0, basePct - buffer))];
  }));

  const gateOpen = graceValid && hasAnyWindow;
  const remaining = Object.fromEntries(['fiveHour', 'week'].map(key => [
    key,
    gateOpen ? round3(Math.min(familyRem[key], officialAvail[key])) : 0
  ]));

  const weights = pool.pool === 'gemini'
    ? [data.policy.flash_weight, data.policy.gemini_weight]
    : [data.policy.tp_weight, data.policy.opus_weight];
  const minWeight = Math.min(...weights), maxWeight = Math.max(...weights);
  const k5 = pool.realBudget?.fiveHour?.upperPercentPerUnit ?? 0.4;
  const kw = pool.realBudget?.week?.upperPercentPerUnit ?? 0.05;

  let reason = '';
  if (!account) reason = '母账号尚未连接';
  else if (account.status === 'auth_required') reason = '母账号授权已失效';
  else if (!graceValid) reason = '官方额度已超 15 分钟未同步';
  else if (!hasAnyWindow) reason = '尚未获取该池官方额度';
  else if (remaining.fiveHour <= 0 || remaining.week <= 0 ||
           remaining.fiveHour + 1e-6 < minWeight * k5 || remaining.week + 1e-6 < minWeight * kw) {
    const officialHit = (windows.fiveHour.usable && officialAvail.fiveHour + 1e-6 < minWeight * k5) ||
                        (windows.week.usable && officialAvail.week + 1e-6 < minWeight * kw);
    reason = officialHit ? '官方可用额度触底' : '家庭可用配额不足';
  }

  const canRunHeavy = !reason && remaining.fiveHour + 1e-6 >= maxWeight * k5 && remaining.week + 1e-6 >= maxWeight * kw;
  const label = reason ? '已暂停新调用' : canRunHeavy ? '可使用' : '部分模型可用';
  return {fresh, graceValid, inGrace: graceValid && !fresh, windows, remaining, familyRem, officialAvail, reason, label};
}
