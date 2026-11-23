import type {Pool,QuotaWindow} from './types';
import {activeUsageSql,cycleStartSql,FRESH_SECONDS,upperRateSql} from './quota-state';
import {HttpError} from './security';

export function cyclesReadySql(pool:Pool,now:number) {
  return `((SELECT COUNT(*) FROM usage_cycles WHERE pool_group='${pool}' AND (
    window_name='fiveHour' AND cycle_started_at=${cycleStartSql(pool,'fiveHour',now)} OR
    window_name='week' AND cycle_started_at=${cycleStartSql(pool,'week',now)}))=2)`;
}

// Rebuild once when a cycle first appears or its official boundary changes.
// Every statement is guarded and the batch is atomic with respect to ledger writes.
export async function ensureUsageTotals(db:D1Database,pool:Pool,now:number) {
  for(let attempt=0;attempt<3;attempt++) {
    const cycles=await db.prepare(`WITH expected(window_name,cycle_started_at) AS (
      VALUES ('fiveHour',${cycleStartSql(pool,'fiveHour',now)}),('week',${cycleStartSql(pool,'week',now)})
    ) SELECT e.*,c.cycle_started_at AS saved_start FROM expected e LEFT JOIN usage_cycles c
      ON c.pool_group=? AND c.window_name=e.window_name`).bind(pool)
      .all<{window_name:QuotaWindow;cycle_started_at:number;saved_start:number|null}>();
    const changed=cycles.results.filter(c=>c.saved_start!==c.cycle_started_at);
    if(!changed.length)return;
    if(attempt===2)break;
    const writes=changed.flatMap(c=>{
      const start=c.cycle_started_at;
      const guard=`${cycleStartSql(pool,c.window_name,now)}=${start} AND NOT EXISTS(
        SELECT 1 FROM usage_cycles WHERE pool_group='${pool}' AND window_name='${c.window_name}' AND cycle_started_at=${start})`;
      return [
        db.prepare(`DELETE FROM usage_totals WHERE pool_group=? AND window_name=? AND ${guard}`).bind(pool,c.window_name),
        db.prepare(`INSERT INTO usage_totals(pool_group,window_name,member_id,units_milli)
          SELECT ?,?,member_id,SUM(CAST(ROUND(weight*1000) AS INTEGER)) FROM usage_logs
          WHERE pool_group=? AND status='committed' AND committed_at>=? AND ${guard} GROUP BY member_id`)
          .bind(pool,c.window_name,pool,start),
        db.prepare(`INSERT INTO usage_cycles(pool_group,window_name,cycle_started_at) SELECT ?,?,? WHERE ${guard}
          ON CONFLICT(pool_group,window_name) DO UPDATE SET cycle_started_at=excluded.cycle_started_at`)
          .bind(pool,c.window_name,start)
      ];
    });
    await db.batch(writes);
  }
  throw new HttpError(503,'额度账期正在切换，请稍后重试');
}

function activeWeeklyResetSql(pool:Pool,now:number) {
  return `r.pool_group='${pool}' AND r.cycle_started_at=${cycleStartSql(pool,'week',now)}
    AND r.account_email=(SELECT email FROM mother_account WHERE id=1)`;
}

export function weeklyScaleSql(pool:Pool,now:number) {
  return `COALESCE((SELECT r.remaining_fraction FROM manual_week_resets r WHERE ${activeWeeklyResetSql(pool,now)}),1.0)`;
}

export async function resetWeeklyUsage(db:D1Database,now:number) {
  const pools=['gemini','third_party'] as const;
  await Promise.all(pools.map(pool=>ensureUsageTotals(db,pool,now)));
  // A single transaction snapshots already settled counters for both pools.
  // Commits that serialize afterwards count toward the new allowance.
  const resetId=crypto.randomUUID();
  const candidates=pools.map(pool=>`SELECT b.pool_group,c.cycle_started_at,m.email AS account_email,b.snapshot_at,
      MAX(0,b.remaining_fraction-COALESCE((
        SELECT SUM(weight) FROM (${activeUsageSql(pool,'b.snapshot_at',now)}) WHERE status='committed'
      ),0)*${upperRateSql(pool,'week')}) AS remaining_fraction
    FROM real_quota_budgets b JOIN mother_account m ON m.id=1
    JOIN usage_cycles c ON c.pool_group=b.pool_group AND c.window_name='week'
    LEFT JOIN manual_week_resets r ON r.pool_group=b.pool_group
    WHERE b.pool_group='${pool}' AND b.window_name='week' AND m.status='connected'
      AND b.snapshot_at=CAST(m.checked_at/1000 AS INTEGER)
      AND b.snapshot_at>=c.cycle_started_at AND b.snapshot_at>=${now-FRESH_SECONDS} AND b.snapshot_at<=${now}
      AND (r.snapshot_at IS NULL OR r.account_email<>m.email OR r.snapshot_at<b.snapshot_at)
      AND c.cycle_started_at=${cycleStartSql(pool,'week',now)}`).join(' UNION ALL ');
  const [result]=await db.batch([
    db.prepare(`WITH candidates AS (${candidates})
      INSERT INTO manual_week_resets(pool_group,cycle_started_at,account_email,snapshot_at,remaining_fraction,reset_id)
      SELECT pool_group,cycle_started_at,account_email,snapshot_at,remaining_fraction,? FROM candidates
      WHERE (SELECT COUNT(*) FROM candidates)=2
      ON CONFLICT(pool_group) DO UPDATE SET cycle_started_at=excluded.cycle_started_at,
        account_email=excluded.account_email,snapshot_at=excluded.snapshot_at,
        remaining_fraction=excluded.remaining_fraction,reset_id=excluded.reset_id`).bind(resetId),
    db.prepare('DELETE FROM manual_week_usage WHERE pool_group IN (SELECT pool_group FROM manual_week_resets WHERE reset_id=?)').bind(resetId),
    db.prepare(`INSERT INTO manual_week_usage(pool_group,member_id,units_milli)
      SELECT u.pool_group,u.member_id,u.units_milli FROM usage_totals u
      JOIN manual_week_resets r ON r.pool_group=u.pool_group WHERE u.window_name='week' AND r.reset_id=?`).bind(resetId)
  ]);
  if(result.meta.changes!==2)throw new HttpError(409,'需要两组最新的官方周余额，且同一次同步只能重置一次。请等下次同步后重试。');
}

// Family totals sum the small per-member counters, including deleted members.
// Live reservations stay on their expiry index, so expired holds need no writes.
export function cycleUsageSql(pool:Pool,now:number) {
  return `SELECT u.member_id,
    SUM(CASE WHEN window_name='fiveHour' THEN u.units_milli ELSE 0 END)/1000.0 AS five_units,
    SUM(CASE WHEN window_name='week' THEN MAX(u.units_milli-COALESCE(b.units_milli,0),0) ELSE 0 END)/1000.0 AS week_units
    FROM usage_totals u
    LEFT JOIN manual_week_resets r ON r.pool_group=u.pool_group AND ${activeWeeklyResetSql(pool,now)}
    LEFT JOIN manual_week_usage b ON b.pool_group=r.pool_group AND b.member_id=u.member_id
    WHERE u.pool_group='${pool}' GROUP BY u.member_id
    UNION ALL SELECT member_id,SUM(weight) AS five_units,SUM(weight) AS week_units FROM usage_logs
      WHERE pool_group='${pool}' AND status='reserved' AND expires_at>${Math.floor(now)} GROUP BY member_id`;
}
