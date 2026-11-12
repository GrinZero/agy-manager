import test from 'node:test';
import assert from 'node:assert/strict';
import {poolView} from '../public/quota-view.mjs';

const now = Date.parse('2026-11-11T12:30:00Z');
function fixture() {
  const bucket = (window, fraction) => ({id: window, window, remaining_fraction: fraction, reset_time: new Date(now + 3_600_000).toISOString()});
  return {
    policy: {buffer_percent: 0, real_quota_guard: 1, real_quota_floor: 0, flash_weight: 1, gemini_weight: 3, tp_weight: 3, opus_weight: 8},
    mother: {status: 'connected', checked_at: now, stale: false, grace_expired: false, snapshot: {groups: [{name: 'Gemini', buckets: [bucket('5h', .68), bucket('weekly', .72)]}]}},
    pools: [{
      pool: 'gemini',
      limits: {fiveHour: 100, week: 100},
      usage: {fiveHour: 12, week: 16},
      realBudget: {
        fiveHour: {officialPercent: 68, remainingPercent: 67.2, remaining: 67.2, graceValid: true, stale: false, upperPercentPerUnit: 0.4},
        week: {officialPercent: 72, remainingPercent: 71.9, remaining: 71.9, graceValid: true, stale: false, upperPercentPerUnit: 0.05}
      }
    }]
  };
}
const view = data => poolView(data, data.pools[0], now);

test('available percentage combines family cap and mother official balance, distinguishing full vs light model availability', () => {
  const data = fixture();
  const result = view(data);
  assert.equal(result.label, '可使用');
  assert.equal(result.windows.fiveHour.fraction, .68);
  // familyRem = {fiveHour: 88, week: 84}, officialAvail = {fiveHour: 67.2, week: 71.9} -> min = {67.2, 71.9}
  assert.deepEqual(result.remaining, {fiveHour: 67.2, week: 71.9});

  // Leave 0.8% remaining in 5h: enough for Flash (1 * 0.4% = 0.4%), not enough for Gemini Pro (3 * 0.4% = 1.2%):
  data.pools[0].usage.fiveHour = 99.2;
  assert.equal(view(data).remaining.fiveHour, 0.8);
  assert.equal(view(data).label, '部分模型可用');

  // Leave 0.2% remaining in 5h: below Flash requirement (0.4%) -> paused!
  data.pools[0].usage.fiveHour = 99.8;
  assert.equal(view(data).remaining.fiveHour, 0.2);
  assert.equal(view(data).label, '已暂停新调用');
  assert.equal(view(data).reason, '家庭可用配额不足');
});

test('snapshots between 90s and 15m enter grace mode without pausing, then pause past 15 minutes', () => {
  const data = fixture();
  const inGrace = poolView(data, data.pools[0], now + 120_000);
  assert.equal(inGrace.fresh, false);
  assert.equal(inGrace.graceValid, true);
  assert.equal(inGrace.inGrace, true);
  assert.equal(inGrace.windows.fiveHour.valid, false);
  assert.equal(inGrace.label, '可使用');
  assert.equal(inGrace.reason, '');

  const expired = poolView(data, data.pools[0], now + 900_001);
  assert.equal(expired.graceValid, false);
  assert.equal(expired.remaining.fiveHour, 0);
  assert.equal(expired.label, '已暂停新调用');
  assert.equal(expired.reason, '官方额度已超 15 分钟未同步');
});

test('transient upstream error stays in grace, while disconnected, auth_required, or exhausted mother account blocks', () => {
  const data = fixture();
  data.mother.status = 'error';
  assert.equal(view(data).graceValid, true);
  assert.equal(view(data).label, '可使用');

  data.mother.status = 'auth_required';
  assert.equal(view(data).label, '已暂停新调用');
  assert.equal(view(data).reason, '母账号授权已失效');

  data.mother.status = 'connected';
  data.mother.snapshot.groups[0].buckets[0].remaining_fraction = 0;
  data.pools[0].realBudget.fiveHour.remainingPercent = 0;
  assert.equal(view(data).label, '已暂停新调用');
  assert.equal(view(data).reason, '官方可用额度触底');

  data.mother = null;
  assert.equal(view(data).label, '已暂停新调用');
  assert.equal(view(data).reason, '母账号尚未连接');
});

test('missing weekly bucket uses remaining 5h bucket; reset rollover inside grace refills to 100%', () => {
  const data = fixture();
  data.mother.snapshot.groups[0].buckets.pop();
  assert.equal(view(data).windows.week.fraction, null);
  assert.equal(view(data).label, '可使用');

  // Bucket that was 0% before reset_time rolls over to 100% once reset_time passes inside 15m grace:
  data.mother.snapshot.groups[0].buckets[0] = {window: '5h', id: '5h', remaining_fraction: 0, reset_time: new Date(now + 10_000).toISOString()};
  data.pools[0].realBudget = null;
  const rolled = poolView(data, data.pools[0], now + 20_000);
  assert.equal(rolled.windows.fiveHour.effectiveFraction, 1);
  assert.equal(rolled.label, '可使用');
});

test('the strictest matching upstream bucket wins and unrecognized groups remain separate', () => {
  const data = fixture();
  data.mother.snapshot.groups.push({name: 'Gemini Pro', buckets: [{window: '5h', id: 'pro', remaining_fraction: .2, reset_time: new Date(now + 3_600_000).toISOString()}]});
  data.mother.snapshot.groups.push({name: 'Other', buckets: [{window: '5h', id: 'other', remaining_fraction: 0, reset_time: new Date(now + 3_600_000).toISOString()}]});
  assert.equal(view(data).windows.fiveHour.fraction, .2);
  assert.equal(view(data).reason, '');
});
