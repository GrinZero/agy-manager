import type {Policy, Pool, QuotaWindow} from './types';

export const FIVE_HOURS = 18_000;
export const WEEK = 604_800;
export const FRESH_SECONDS = 90;
export const MOTHER_GRACE_SECONDS = 900;
export const SEED_RATE: Record<QuotaWindow, number> = {fiveHour: 0.001, week: 0.00025};
export const DELTA_TOLERANCE: Record<QuotaWindow, number> = {fiveHour: 0.002, week: 0.0004};
// Upstream Google quota counters can buffer up to ~1% (5h) / ~0.5% (week) before flushing a step.
export const UPSTREAM_STEP: Record<QuotaWindow, number> = {fiveHour: 0.01, week: 0.005};
export const duration = (window: QuotaWindow) => window === 'fiveHour' ? FIVE_HOURS : WEEK;

export interface QuotaObservation {
  pool: Pool; window: QuotaWindow; fraction: number; at: number; resetAt: number | null; bucketKey: string;
}
export interface CalibrationState {
  pool_group: Pool; window_name: QuotaWindow; account_email: string; bucket_key: string;
  cycle_started_at: number; reset_at: number; observed_at: number; last_fraction: number;
  anchor_at: number; anchor_fraction: number;
  lower_fraction_per_unit: number | null; fraction_per_point: number | null; upper_fraction_per_unit: number | null;
  hist_units: number; hist_fraction: number; cycle_units: number; cycle_drop: number;
  sample_count: number; total_points: number;
  updated_at: number | null; status: string;
  initial_fraction: number; initial_at: number;
}
export interface CalibrationEvidence {
  done: number;
  span: number;
  pending: number;
  recent: number;
  stepDone: number;
  recentOffline: number;
}
const EPSILON = 1e-9;

// Cycle-cumulative conservation bounds: instead of discarding anchors when in-flight
// calls exist, accumulate completed units from the cycle baseline and widen bounds
// explicitly by pending/recent uncertainty so continuous concurrency still converges.
export function observeQuota(
  previous: CalibrationState | null,
  b: QuotaObservation,
  email: string,
  evidence: CalibrationEvidence,
  enabled: boolean
) {
  if (b.resetAt === null || b.resetAt <= b.at) return null;
  const sameAccount = previous?.account_email === email;
  const sameSource = sameAccount && previous?.bucket_key === b.bucketKey;
  const old = sameSource ? previous : null;
  if (old && b.at <= old.observed_at) return null;
  const cycleOld = sameAccount ? previous : null;
  const reset = !!cycleOld && (b.at >= cycleOld.reset_at || !!old && b.fraction >= 1 - EPSILON && old.last_fraction < 1 - EPSILON);
  const delta = DELTA_TOLERANCE[b.window];

  let histUnits = old?.hist_units ?? 0;
  let histFraction = old?.hist_fraction ?? 0;
  const foldCycle = () => {
    if (old && old.cycle_units >= 1 && old.cycle_drop + EPSILON >= 2 * delta) {
      histUnits = histUnits * 0.7 + old.cycle_units;
      histFraction = histFraction * 0.7 + old.cycle_drop;
    }
  };

  const state: CalibrationState = {
    pool_group: b.pool, window_name: b.window, account_email: email, bucket_key: b.bucketKey,
    cycle_started_at: cycleOld?.cycle_started_at ?? Math.min(b.at, b.resetAt - duration(b.window)),
    reset_at: b.resetAt, observed_at: b.at, last_fraction: b.fraction,
    anchor_at: old?.anchor_at ?? b.at, anchor_fraction: old?.anchor_fraction ?? b.fraction,
    lower_fraction_per_unit: old?.lower_fraction_per_unit ?? null,
    fraction_per_point: old?.fraction_per_point ?? null,
    upper_fraction_per_unit: old?.upper_fraction_per_unit ?? null,
    hist_units: histUnits, hist_fraction: histFraction,
    cycle_units: old?.cycle_units ?? 0, cycle_drop: old?.cycle_drop ?? 0,
    sample_count: old?.sample_count ?? 0, total_points: old?.total_points ?? 0,
    updated_at: old?.updated_at ?? null, status: 'collecting',
    initial_fraction: cycleOld?.initial_fraction ?? b.fraction,
    initial_at: cycleOld?.initial_at ?? b.at
  };

  if (previous && !sameSource && sameAccount) state.cycle_started_at = previous.cycle_started_at;
  if (reset) {
    state.cycle_started_at = b.at >= cycleOld!.reset_at
      ? Math.max(cycleOld!.reset_at, Math.min(b.at, b.resetAt - duration(b.window)))
      : b.at;
    state.initial_fraction = 1;
    state.initial_at = b.at;
  }

  const reanchor = (status: string, fold = false) => {
    if (fold) foldCycle();
    state.hist_units = histUnits;
    state.hist_fraction = histFraction;
    state.anchor_at = b.at;
    state.anchor_fraction = b.fraction;
    state.cycle_units = 0;
    state.cycle_drop = 0;
    state.status = status;
    return {state, sample: null};
  };

  if (!enabled) return reanchor('disabled');
  if (reset) return reanchor('reset', true);
  if (!old) return reanchor(previous ? 'source_changed' : 'collecting');
  // Only re-anchor on genuine mid-cycle replenishments (>5% jump, or >2% jump rising above cycle anchor).
  // Small upward blips (<=2-5%) from multi-replica lag or streaming hold refunds must NOT fold and re-anchor,
  // which would violate telescope conservation and double-count the same drop on the next tick.
  const genuineReplenish = b.fraction > old.last_fraction + 0.05 ||
    b.fraction > old.last_fraction + 0.02 && b.fraction > old.anchor_fraction + delta;
  if (genuineReplenish) return reanchor('replenished', true);
  if (evidence.recentOffline > 0) return reanchor('offline', true);

  const totalDrop = Math.max(0, old.anchor_fraction - b.fraction);
  if (totalDrop + EPSILON < old.cycle_drop) {
    state.last_fraction = old.last_fraction;
    state.status = state.fraction_per_point ? 'learned' : evidence.pending > 0 ? 'inflight' : 'collecting';
    return {state, sample: null};
  }
  state.last_fraction = Math.min(old.last_fraction, b.fraction);

  const stepDrop = Math.max(0, old.last_fraction - b.fraction);
  const noTrackedActivity = evidence.done === 0 && evidence.span === 0 && evidence.pending === 0;
  const idleUntrackedSpike = b.at - old.observed_at >= 45 && evidence.stepDone === 0 && evidence.pending === 0 &&
    evidence.recent === 0 && stepDrop > Math.max(0.01, 4 * delta);
  if (noTrackedActivity && totalDrop > delta || idleUntrackedSpike) return reanchor('untracked', true);

  const wUnits = histUnits + evidence.done;
  const wDrop = histFraction + totalDrop;
  const safeUnits = wUnits - evidence.recent;

  if (b.at - old.anchor_at < 15 || wUnits < 1 || wDrop + EPSILON < 2 * delta) {
    // Even when upstream has not yet flushed its first quantized step, enough lag-safe units
    // strictly bound the maximum rate: k <= (wDrop + UPSTREAM_STEP + delta) / safeUnits.
    if (b.at - old.anchor_at >= 45 && safeUnits >= 5) {
      const stepBound = (wDrop + UPSTREAM_STEP[b.window] + delta) / safeUnits;
      const currentUpper = state.upper_fraction_per_unit ?? SEED_RATE[b.window];
      if (stepBound < currentUpper) state.upper_fraction_per_unit = stepBound;
    }
    state.status = state.fraction_per_point ? 'learned' : evidence.pending > 0 ? 'inflight' : 'collecting';
    return {state, sample: null};
  }

  const inFlightUncertainty = evidence.pending + evidence.span;
  const est = wDrop / (wUnits + 0.5 * inFlightUncertainty);
  const low = Math.max(0, wDrop - delta) / (wUnits + inFlightUncertainty);
  const rawUpper = (wDrop + delta) / wUnits;
  const lagProtectedUpper = evidence.recent > 0 && old.upper_fraction_per_unit
    ? Math.min(old.upper_fraction_per_unit, (wDrop + delta) / Math.max(1, safeUnits))
    : 0;
  const upper = Math.max(rawUpper, lagProtectedUpper, est);

  const minRate = b.window === 'fiveHour' ? 1e-6 : 2e-7, maxRate = 0.25;
  if (!Number.isFinite(est) || !Number.isFinite(upper) || est < minRate || upper > maxRate) {
    return reanchor('invalid');
  }

  state.lower_fraction_per_unit = Math.min(low, est);
  state.fraction_per_point = est;
  state.upper_fraction_per_unit = upper;
  state.status = 'learned';

  const deltaUnits = Math.max(0, evidence.done - old.cycle_units);
  const deltaDrop = Math.max(0, totalDrop - old.cycle_drop);
  const firstInCycle = old.cycle_units < 1 && evidence.done >= 1;
  if (firstInCycle || deltaUnits >= 0.5 && deltaDrop > EPSILON) {
    const sampleUnits = firstInCycle ? evidence.done : deltaUnits;
    const sampleDrop = firstInCycle ? Math.max(delta, totalDrop) : deltaDrop;
    state.cycle_units = evidence.done;
    state.cycle_drop = totalDrop;
    state.sample_count++;
    state.total_points += sampleUnits;
    state.updated_at = b.at;
    return {
      state,
      sample: {points: sampleUnits, fraction: sampleDrop, rate: est, upper}
    };
  }
  return {state, sample: null};
}

// UTC Monday is only a fallback when no official reset has been observed.
function fallbackStart(window: QuotaWindow, now: number) {
  const offset = window === 'week' ? 345600 : 0, seconds = duration(window);
  return Math.floor((now - offset) / seconds) * seconds + offset;
}
export function cycleStartSql(pool: Pool, window: QuotaWindow, now: number) {
  const at = Math.floor(now), seconds = duration(window);
  return `COALESCE((SELECT CASE WHEN reset_at>${at} THEN cycle_started_at
    ELSE reset_at+CAST((${at}-reset_at)/${seconds} AS INTEGER)*${seconds} END
    FROM quota_calibration WHERE pool_group='${pool}' AND window_name='${window}'),${fallbackStart(window, at)})`;
}
export function upperRateSql(pool: Pool, window: QuotaWindow) {
  const seed = SEED_RATE[window];
  return `(CASE WHEN COALESCE((SELECT calibration_enabled FROM policy WHERE id=1),1)=1
    THEN COALESCE((SELECT upper_fraction_per_unit FROM quota_calibration WHERE pool_group='${pool}' AND window_name='${window}'),${seed})
    ELSE ${seed} END)`;
}
export function budgetStatement(db: D1Database, pool: Pool, now: number) {
  return db.prepare(`WITH windows(window_name) AS (VALUES ('fiveHour'),('week'))
    SELECT w.window_name,b.remaining_fraction,b.snapshot_at,b.expires_at,c.*,
    w.window_name AS window_key,
    COALESCE((SELECT SUM(u.weight) FROM usage_logs u WHERE u.pool_group=? AND
      (u.status='reserved' AND u.expires_at>? OR u.status='committed' AND u.committed_at>=MAX(COALESCE(b.snapshot_at,0),
        CASE WHEN c.reset_at IS NOT NULL AND c.reset_at<=? AND COALESCE(b.snapshot_at,0)<c.reset_at THEN c.reset_at ELSE 0 END))),0) AS since_snapshot
    FROM windows w LEFT JOIN real_quota_budgets b ON b.pool_group=? AND b.window_name=w.window_name
    LEFT JOIN quota_calibration c ON c.pool_group=? AND c.window_name=w.window_name`).bind(pool, now, now, pool, pool);
}
export type BudgetRow = Partial<CalibrationState> & {
  window_key: QuotaWindow;
  remaining_fraction: number | null;
  snapshot_at: number | null;
  expires_at: number | null;
  since_snapshot: number;
};
export function budgetView(rows: BudgetRow[], p: Policy, _pool: Pool, now: number) {
  return Object.fromEntries(rows.map(b => {
    const seed = SEED_RATE[b.window_key];
    const upperRate = p.calibration_enabled && b.upper_fraction_per_unit ? b.upper_fraction_per_unit : seed;
    const pointRate = p.calibration_enabled && b.fraction_per_point ? b.fraction_per_point : Math.min(seed, upperRate);
    const lowerRate = p.calibration_enabled && b.lower_fraction_per_unit != null ? b.lower_fraction_per_unit : null;
    const seconds = duration(b.window_key), hasOfficial = !!b.reset_at, official = hasOfficial && b.reset_at! > now;
    const start = hasOfficial ? (official ? b.cycle_started_at! : b.reset_at! + Math.floor((now - b.reset_at!) / seconds) * seconds) : fallbackStart(b.window_key, now);
    const reset = official ? b.reset_at! : start + seconds;
    const graceValid = b.snapshot_at !== null && now - b.snapshot_at <= MOTHER_GRACE_SECONDS;
    const fresh = b.snapshot_at !== null && now - b.snapshot_at <= FRESH_SECONDS && (!hasOfficial || official);
    // If official reset rolled over while inside the 15-minute grace window, upstream refilled to 100%.
    const rolledOverInGrace = graceValid && hasOfficial && !official && b.snapshot_at! < b.reset_at!;
    const effectiveFraction = b.remaining_fraction === null ? null : rolledOverInGrace ? 1 : b.remaining_fraction;
    const officialPercent = effectiveFraction === null ? null : Math.round(effectiveFraction * 100_000) / 1000;
    const remainingPercent = effectiveFraction === null ? 0 :
      Math.round(Math.max(0, (effectiveFraction - b.since_snapshot * upperRate) * 100) * 1000) / 1000;
    return [b.window_key, {
      officialPercent,
      remainingPercent,
      remaining: remainingPercent,
      snapshot_at: b.snapshot_at,
      fresh,
      graceValid,
      stale: !fresh,
      fractionPerPoint: pointRate,
      upperFractionPerUnit: upperRate,
      lowerFractionPerUnit: lowerRate,
      percentPerPoint: pointRate * 100,
      upperPercentPerUnit: upperRate * 100,
      lowerPercentPerUnit: lowerRate === null ? null : lowerRate * 100,
      fullQuotaUnits: Math.round(1 / upperRate * 100) / 100,
      source: !p.calibration_enabled ? 'disabled' : b.upper_fraction_per_unit ? 'learned' : 'initial',
      sampleCount: b.sample_count ?? 0,
      samplePoints: Math.round((b.total_points ?? 0) * 1000) / 1000,
      updated_at: b.updated_at ?? null,
      status: !p.calibration_enabled ? 'disabled' : b.status ?? 'collecting',
      cycle_started_at: start,
      reset_at: reset,
      officialReset: official
    }];
  }));
}

// All returned writes are guarded by the caller's account refresh lock and must
// be committed with the snapshot. An obsolete refresh cannot publish new rates.
export async function observationWrites(
  db: D1Database,
  observations: QuotaObservation[],
  email: string,
  lock: number,
  enabled: boolean
) {
  if (!observations.length) return [];
  const states = await db.prepare('SELECT * FROM quota_calibration').all<CalibrationState>();
  const oldFor = (b: QuotaObservation) => states.results.find(s => s.pool_group === b.pool && s.window_name === b.window) ?? null;
  const evidence = await db.batch(observations.map(b => {
    const old = oldFor(b), anchorAt = old?.anchor_at ?? b.at, prevObsAt = old?.observed_at ?? b.at;
    return db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='committed' AND source!='offline_commit' AND created_at>=? AND committed_at>=? AND committed_at<=? THEN weight ELSE 0 END),0) AS done,
      COALESCE(SUM(CASE WHEN status='committed' AND source!='offline_commit' AND created_at<? AND committed_at>=? AND committed_at<=? THEN weight ELSE 0 END),0) AS span,
      COALESCE(SUM(CASE WHEN status='reserved' AND expires_at>? THEN weight ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN status='committed' AND committed_at>? AND committed_at<=? THEN weight ELSE 0 END),0) AS recent,
      COALESCE(SUM(CASE WHEN status='committed' AND committed_at>? AND committed_at<=? THEN weight ELSE 0 END),0) AS stepDone,
      COALESCE(SUM(CASE WHEN source='offline_commit' AND committed_at>=? AND committed_at<=? THEN 1 ELSE 0 END),0) AS recentOffline
      FROM usage_logs WHERE pool_group=?`)
      .bind(anchorAt, anchorAt, b.at, anchorAt, anchorAt, b.at, b.at, b.at - 20, b.at, prevObsAt, b.at, prevObsAt, b.at, b.pool);
  }));
  const writes: D1PreparedStatement[] = [];
  const guard = 'EXISTS(SELECT 1 FROM mother_account WHERE id=1 AND email=? AND refresh_lock=?)';
  for (const [index, b] of observations.entries()) {
    const next = observeQuota(oldFor(b), b, email, evidence[index].results[0] as unknown as CalibrationEvidence, enabled);
    if (!next) continue;
    const fields = Object.keys(next.state), values = Object.values(next.state);
    writes.push(db.prepare(`INSERT INTO quota_calibration (${fields.join(',')}) SELECT ${fields.map(() => '?').join(',')}
      WHERE ${guard} ON CONFLICT(pool_group,window_name) DO UPDATE SET
      ${fields.filter(f => f !== 'pool_group' && f !== 'window_name').map(f => `${f}=excluded.${f}`).join(',')}
      WHERE quota_calibration.observed_at<excluded.observed_at OR quota_calibration.account_email<>excluded.account_email`)
      .bind(...values, email, lock));
    if (next.sample) writes.push(db.prepare(`INSERT OR IGNORE INTO quota_samples
      (pool_group,window_name,observed_at,points,fraction_used,fraction_per_point,upper_fraction_per_unit) SELECT ?,?,?,?,?,?,? WHERE ${guard}`)
      .bind(b.pool, b.window, b.at, next.sample.points, next.sample.fraction, next.sample.rate, next.sample.upper, email, lock));
  }
  return writes;
}
