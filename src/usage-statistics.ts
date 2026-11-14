import type {Pool} from './types';
import {upperRateSql} from './quota-state';
import {cycleUsageSql,ensureUsageTotals} from './usage-totals';

export async function overviewUsage(db:D1Database,pool:Pool,now:number) {
  await ensureUsageTotals(db,pool,now);
  const rows=await db.prepare(`WITH totals AS (
    SELECT member_id,SUM(five_units) AS five_units,SUM(week_units) AS week_units
    FROM (${cycleUsageSql(pool,now)}) GROUP BY member_id
  ) SELECT member_id,
    ROUND(five_units*${upperRateSql(pool,'fiveHour')}*100,3) AS fiveHour,
    ROUND(week_units*${upperRateSql(pool,'week')}*100,3) AS week,
    ROUND(SUM(five_units) OVER ()*${upperRateSql(pool,'fiveHour')}*100,3) AS familyFiveHour,
    ROUND(SUM(week_units) OVER ()*${upperRateSql(pool,'week')}*100,3) AS familyWeek FROM totals`)
    .all<{member_id:string;fiveHour:number;week:number;familyFiveHour:number;familyWeek:number}>();
  return {
    family:{fiveHour:rows.results[0]?.familyFiveHour??0,week:rows.results[0]?.familyWeek??0},
    members:new Map(rows.results.map(r=>[r.member_id,{fiveHour:r.fiveHour,week:r.week}]))
  };
}
