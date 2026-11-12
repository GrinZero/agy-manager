import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeQuota,budgetView,type QuotaObservation,type CalibrationState,type CalibrationEvidence} from '../src/quota-state';
import type {Policy} from '../src/types';

const at=2_000_000_000;
const observation=(time=at,fraction=.9,window:'fiveHour'|'week'='fiveHour'):QuotaObservation=>({
  pool:'gemini',window,fraction,at:time,resetAt:at+(window==='fiveHour'?18000:604800),bucketKey:'gemini-'+window
});
const ev=(overrides:Partial<CalibrationEvidence>={}):CalibrationEvidence=>({
  done:0,span:0,pending:0,recent:0,stepDone:0,recentOffline:0,...overrides
});
const initial=()=>observeQuota(null,observation(),'mother@example.com',ev(),true)!.state;

test('initial consumption survives refresh, calibration changes and bucket switches and clears on reset',()=>{
  const first=initial();
  assert.equal(first.initial_fraction,.9);assert.equal(first.initial_at,at);
  const refreshed=observeQuota(first,observation(at+60,.8),'mother@example.com',ev({done:10,stepDone:10}),true)!.state;
  assert.equal(refreshed.initial_fraction,.9);assert.equal(refreshed.initial_at,at);
  const changed=observeQuota(refreshed,{...observation(at+120,.7),bucketKey:'other'},'mother@example.com',ev(),false)!.state;
  assert.equal(changed.initial_fraction,.9);assert.equal(changed.initial_at,at);
  const reset=observeQuota(changed,{...observation(at+180,1),bucketKey:'other'},'mother@example.com',ev(),true)!.state;
  assert.equal(reset.initial_fraction,1);
  const account=observeQuota(refreshed,observation(at+120,.5),'other@example.com',ev(),true)!.state;
  assert.equal(account.initial_fraction,.5);assert.equal(account.initial_at,at+120);
});

test('cumulative interval bounds converge even when in-flight calls remain active across Cron ticks',()=>{
  // Previously, pending > 0 wiped the anchor every minute ("inflight" starvation).
  // Now cumulative done units converge while widening lower bound safely for pending uncertainty.
  const s0=initial();
  const r1=observeQuota(s0,observation(at+60,.85),'mother@example.com',ev({done:10,pending:3,stepDone:10}),true)!;
  assert.equal(r1.state.status,'learned');
  assert.ok(r1.sample!==null);
  assert.equal(r1.state.sample_count,1);
  // True drop = 0.05 over 10 done units (+ 3 pending). Upper bound = (0.05 + 0.002)/10 = 0.0052; lower = (0.05 - 0.002)/13 = 0.00369...
  assert.ok(Math.abs(r1.state.upper_fraction_per_unit!-0.0052)<1e-9);
  assert.ok(r1.state.lower_fraction_per_unit!<r1.state.fraction_per_point!);
  assert.ok(r1.state.fraction_per_point!<r1.state.upper_fraction_per_unit!);

  // Second minute: 30 cumulative done units, 0.15 cumulative drop, still 2 pending in flight -> interval tightens!
  const r2=observeQuota(r1.state,observation(at+120,.75),'mother@example.com',ev({done:30,pending:2,stepDone:20}),true)!;
  assert.equal(r2.state.status,'learned');
  assert.equal(r2.state.sample_count,2);
  assert.ok(r2.state.upper_fraction_per_unit!<r1.state.upper_fraction_per_unit!);
  assert.ok(r2.state.lower_fraction_per_unit!>r1.state.lower_fraction_per_unit!);

  // Weekly window learns its own distinct interval independently:
  const w0=observeQuota(null,observation(at,.9,'week'),'mother@example.com',ev(),true)!.state;
  const w1=observeQuota(w0,observation(at+60,.89,'week'),'mother@example.com',ev({done:10,stepDone:10}),true)!;
  assert.equal(w1.state.status,'learned');
  assert.ok(Math.abs(w1.state.upper_fraction_per_unit!-(0.01+0.0004)/10)<1e-9);
});

test('20-second recent commit lag protection prevents unreflected commits from understating upper bound',()=>{
  const s0=initial();
  const r1=observeQuota(s0,observation(at+60,.85),'mother@example.com',ev({done:10,stepDone:10}),true)!;
  const firstUpper=r1.state.upper_fraction_per_unit!; // 0.0052
  // Suppose 10 more units committed 2 seconds before snapshot, and upstream fraction hasn't ticked down yet (.85):
  const lagged=observeQuota(r1.state,observation(at+120,.85),'mother@example.com',ev({done:20,recent:10,stepDone:10}),true)!;
  // Without lag protection rawUpper would drop to 0.052/20 = 0.0026; lag protection keeps upper at 0.0052!
  assert.equal(lagged.state.upper_fraction_per_unit,firstUpper);
});

test('unchanged upstream counters wait until drop exceeds rounding tolerance before publishing first bound',()=>{
  const s0=initial();
  const tiny=observeQuota(s0,observation(at+60,.899),'mother@example.com',ev({done:5,stepDone:5}),true)!;
  assert.equal(tiny.sample,null);assert.equal(tiny.state.anchor_at,at);
  const measurable=observeQuota(tiny.state,observation(at+120,.85),'mother@example.com',ev({done:10,stepDone:5}),true)!;
  assert.ok(measurable.sample!==null);
  assert.equal(measurable.sample!.points,10);
});

test('untracked drops, offline commits, and replenishments reanchor cleanly while folding prior valid cycle evidence',()=>{
  const s0=initial();
  // Untracked drop with zero tracked activity:
  const untracked=observeQuota(s0,observation(at+60,.8),'mother@example.com',ev(),true)!;
  assert.equal(untracked.sample,null);assert.equal(untracked.state.status,'untracked');
  assert.equal(untracked.state.anchor_fraction,.8);

  // Valid cycle learning followed by an idle untracked spike folds prior cycle into hist_units/hist_fraction:
  const learned=observeQuota(s0,observation(at+60,.85),'mother@example.com',ev({done:10,stepDone:10}),true)!.state;
  const spiked=observeQuota(learned,observation(at+120,.70),'mother@example.com',ev({done:10,stepDone:0}),true)!;
  assert.equal(spiked.state.status,'untracked');
  assert.equal(spiked.state.anchor_fraction,.70);
  assert.equal(spiked.state.hist_units,10);
  assert.ok(Math.abs(spiked.state.hist_fraction-0.05)<1e-9);

  // Offline commit reanchors:
  const offline=observeQuota(s0,observation(at+60,.85),'mother@example.com',ev({done:10,recentOffline:1}),true)!;
  assert.equal(offline.state.status,'offline');assert.equal(offline.sample,null);

  // Replenished balance reanchors:
  const rep=observeQuota(s0,observation(at+60,.95),'mother@example.com',ev({done:2}),true)!;
  assert.equal(rep.state.status,'replenished');assert.equal(rep.sample,null);
});

test('scheduled and early full resets clear the usage cycle while retaining cross-cycle memory and learned bounds',()=>{
  const learned=observeQuota(initial(),observation(at+60,.85),'mother@example.com',ev({done:10,stepDone:10}),true)!.state;
  const early=observeQuota(learned,observation(at+120,1),'mother@example.com',ev(),true)!;
  assert.equal(early.sample,null);assert.equal(early.state.status,'reset');
  assert.equal(early.state.cycle_started_at,at+120);
  assert.equal(early.state.upper_fraction_per_unit,learned.upper_fraction_per_unit);
  assert.equal(early.state.hist_units,10);

  const scheduled=observeQuota(learned,{...observation(at+18000,.7),resetAt:at+36000},'mother@example.com',ev({done:20}),true)!;
  assert.equal(scheduled.state.cycle_started_at,at+18000);assert.equal(scheduled.sample,null);
  assert.equal(scheduled.state.sample_count,1);
});

test('rescheduled reset alone keeps cycle; duplicate timestamps, changed buckets and account switches behave safely',()=>{
  const old=observeQuota(initial(),observation(at+60,.85),'mother@example.com',ev({done:10,stepDone:10}),true)!.state;
  const shifted=observeQuota(old,{...observation(at+120,.80),resetAt:at+19000},'mother@example.com',ev({done:20,stepDone:10}),true)!;
  assert.equal(shifted.state.cycle_started_at,old.cycle_started_at);
  assert.equal(observeQuota(old,observation(at+60,.7),'mother@example.com',ev({done:10}),true),null);
  assert.equal(observeQuota(old,{...observation(),resetAt:null},'mother@example.com',ev(),true),null);
  const changed=observeQuota(old,{...observation(at+120,.7),bucketKey:'different'},'mother@example.com',ev({done:10}),true)!;
  assert.equal(changed.state.upper_fraction_per_unit,null);assert.equal(changed.state.cycle_started_at,old.cycle_started_at);
  const other=observeQuota(old,observation(at+120,.7),'another@example.com',ev({done:10}),true)!;
  assert.equal(other.state.sample_count,0);
  const disabled=observeQuota(old,observation(at+120,.7),'mother@example.com',ev({done:10}),false)!;
  assert.equal(disabled.sample,null);assert.equal(disabled.state.status,'disabled');
});

test('budgetView returns percentage balances, 90s fresh vs 15m grace states, and post-reset grace rollover',()=>{
  const p={gemini_5h_limit:100,gemini_wk_limit:100,real_quota_floor:0,calibration_enabled:1} as Policy;
  const view=budgetView((['fiveHour','week'] as const).map(window_key=>({
    window_key,remaining_fraction:.5,snapshot_at:at,expires_at:at+900,since_snapshot:10,
    reset_at:at+300,cycle_started_at:at-100
  })),p,'gemini',at);
  // Seed rates: 5h = 0.1%/unit, week = 0.025%/unit -> 50% - 10*0.1% = 49%; 50% - 10*0.025% = 49.75%
  assert.equal(view.fiveHour.upperPercentPerUnit,.1);assert.equal(view.week.upperPercentPerUnit,.025);
  assert.equal(view.fiveHour.remainingPercent,49);assert.equal(view.week.remainingPercent,49.75);
  assert.equal(view.fiveHour.fresh,true);assert.equal(view.fiveHour.graceValid,true);

  // At +120s (>90s fresh, <=900s grace): stale=true, graceValid=true
  const inGrace=budgetView([{window_key:'fiveHour',remaining_fraction:.5,snapshot_at:at,expires_at:at+900,
    since_snapshot:0,reset_at:at+300,cycle_started_at:at-100}],p,'gemini',at+120).fiveHour;
  assert.equal(inGrace.stale,true);assert.equal(inGrace.graceValid,true);

  // If official reset_at passed while still within 15-minute grace window, balance rolls over to 100%:
  const rolled=budgetView([{window_key:'fiveHour',remaining_fraction:0,snapshot_at:at,expires_at:at+900,
    since_snapshot:0,reset_at:at+30,cycle_started_at:at-100}],p,'gemini',at+60).fiveHour;
  assert.equal(rolled.officialReset,false);assert.equal(rolled.graceValid,true);assert.equal(rolled.remainingPercent,100);

  // Past 900s grace window: graceValid=false
  const expiredGrace=budgetView([{window_key:'fiveHour',remaining_fraction:.5,snapshot_at:at,expires_at:at+900,
    since_snapshot:0,reset_at:at+3000,cycle_started_at:at-100}],p,'gemini',at+901).fiveHour;
  assert.equal(expiredGrace.graceValid,false);
});

test('multi-replica upward jitter never double-counts drops; zero-drop safe units tighten cold-start upper bound seamlessly',()=>{
  // 1. Zero-drop cold start with 25 lag-safe units tightens upper bound from 0.10% down to (0 + 0.01 + 0.002)/25 = 0.048%:
  const s0=observeQuota(null,observation(at,.9344238),'mother@example.com',ev(),true)!.state;
  const preStep=observeQuota(s0,observation(at+90,.9344238),'mother@example.com',ev({done:25,stepDone:25}),true)!;
  assert.equal(preStep.sample,null);
  assert.ok(Math.abs(preStep.state.upper_fraction_per_unit!-0.00048)<1e-9);

  // 2. First 1% step lands at 26 units (.9344238 -> .9244205): upper smoothly transitions to (0.0100033 + 0.002)/26 = 0.0004617:
  const step1=observeQuota(preStep.state,observation(at+150,.9244205),'mother@example.com',ev({done:26,stepDone:1}),true)!;
  assert.equal(step1.state.status,'learned');
  assert.equal(step1.state.sample_count,1);
  assert.ok(step1.state.upper_fraction_per_unit!<preStep.state.upper_fraction_per_unit!);

  // 3. Stale replica bounces UP (.9244205 -> .93099433) then back DOWN (.9244205), then UP (.9299092):
  // Must NOT re-anchor, must NOT fold phantom drops into hist_fraction, and must NOT emit fake samples!
  const bounceUp1=observeQuota(step1.state,observation(at+210,.93099433),'mother@example.com',ev({done:48,stepDone:22}),true)!;
  assert.equal(bounceUp1.state.status,'learned');
  assert.equal(bounceUp1.state.anchor_at,at);
  assert.equal(bounceUp1.state.hist_fraction,0);
  assert.equal(bounceUp1.sample,null);

  const bounceBack1=observeQuota(bounceUp1.state,observation(at+255,.9244205),'mother@example.com',ev({done:50,stepDone:2}),true)!;
  assert.equal(bounceBack1.sample,null);
  assert.equal(bounceBack1.state.sample_count,1);
  assert.equal(bounceBack1.state.anchor_at,at);

  const bounceUp2=observeQuota(bounceBack1.state,observation(at+300,.9299092),'mother@example.com',ev({done:70,stepDone:20}),true)!;
  assert.equal(bounceUp2.sample,null);
  assert.equal(bounceUp2.state.hist_fraction,0);

  // 4. Second real 1% step lands (.9144205) at 98 units: exact 2.00033% cumulative drop over all 98 units!
  const step2=observeQuota(bounceUp2.state,observation(at+360,.9144205),'mother@example.com',ev({done:98,stepDone:28}),true)!;
  assert.equal(step2.state.sample_count,2);
  assert.ok(Math.abs(step2.sample!.points-72)<1e-9);
  assert.ok(Math.abs(step2.sample!.fraction-0.01)<1e-6);
  assert.ok(Math.abs(step2.state.upper_fraction_per_unit!-(0.0200033+0.002)/98)<1e-9);
});
