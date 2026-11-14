import type {Pool,QuotaWindow} from './types';
import {cycleStartSql} from './quota-state';
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

// Family totals sum the small per-member counters, including deleted members.
// Live reservations stay on their expiry index, so expired holds need no writes.
export function cycleUsageSql(pool:Pool,now:number) {
  return `SELECT member_id,
    SUM(CASE WHEN window_name='fiveHour' THEN units_milli ELSE 0 END)/1000.0 AS five_units,
    SUM(CASE WHEN window_name='week' THEN units_milli ELSE 0 END)/1000.0 AS week_units
    FROM usage_totals WHERE pool_group='${pool}' GROUP BY member_id
    UNION ALL SELECT member_id,SUM(weight) AS five_units,SUM(weight) AS week_units FROM usage_logs
      WHERE pool_group='${pool}' AND status='reserved' AND expires_at>${Math.floor(now)} GROUP BY member_id`;
}
