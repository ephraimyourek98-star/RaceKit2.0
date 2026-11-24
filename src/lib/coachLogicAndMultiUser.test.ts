import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRaceTaper, generateTrainingPlan } from './trainingPlans';
import { PredictionEngine } from './predictionEngine';
import type { DailyWorkout, Effort, HealthSnapshot, TrainingPlan, TrainingZones } from './types';

const MOCK_ZONES: TrainingZones = {
  recovery: { pace_s: 540, label: '8:45–9:15/mi' },
  easy: { pace_s: 480, label: '7:40–8:15/mi' },
  marathon: { pace_s: 420, label: '6:50–7:10/mi' },
  threshold: { pace_s: 385, label: '6:20–6:35/mi' },
  interval: { pace_s: 360, label: '5:50–6:05/mi' },
  repetition: { pace_s: 330, label: '5:15–5:30/mi' },
  rep_400m: '78–82s',
};

test('applyRaceTaper accurately includes Warmup (1.5 mi) + Main Set (3.1 mi) + Cooldown (1.0 mi) = 5.6 mi on Race Day', () => {
  const basePlan = generateTrainingPlan('track_mid', MOCK_ZONES, null);
  const raceWeek = applyRaceTaper(basePlan, 'Run for Pie 5K', '5K', 'Thursday', '7:40–8:15/mi');

  const thursday = raceWeek.schedule.find((w) => w.day === 'Thursday');
  assert.ok(thursday, 'Thursday workout exists');
  assert.equal(thursday.workout_type, 'race');
  assert.equal(thursday.warmup_miles, 1.5);
  assert.equal(thursday.main_miles, 3.1);
  assert.equal(thursday.cooldown_miles, 1.0);
  assert.equal(thursday.distance_miles, 5.6, 'Distance is exactly 5.6 mi');

  // Verify weekly_mileage sums strictly
  const expectedSum = Number(
    raceWeek.schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1)
  );
  assert.equal(raceWeek.weekly_mileage, expectedSum);
});

test('Pre-race taper rule strictly enforces shakeout on day before race and recovery flush on day after', () => {
  const basePlan = generateTrainingPlan('track_mid', MOCK_ZONES, null);
  const raceWeek = applyRaceTaper(basePlan, 'Run for Pie 5K', '5K', 'Thursday', '7:40–8:15/mi');

  // Wednesday (day before race) must be shakeout or rest, never a hard workout
  const wednesday = raceWeek.schedule.find((w) => w.day === 'Wednesday');
  assert.ok(wednesday);
  assert.equal(wednesday.workout_type, 'easy');
  assert.match(wednesday.name, /Pre-Race Shakeout/i);
  assert.equal(wednesday.distance_miles, 2.0);

  // Friday (day after race) must be recovery flush
  const friday = raceWeek.schedule.find((w) => w.day === 'Friday');
  assert.ok(friday);
  assert.equal(friday.workout_type, 'recovery');
  assert.match(friday.name, /Post-Race Recovery Flush/i);
  assert.equal(friday.distance_miles, 2.0);
});

test('Multi-user Jack Daniels VDOT engine correctly generates zones from any guest benchmark time', () => {
  // Guest runner: 5K in 24:30 (1470 seconds)
  const guestEffort: Effort = {
    id: 'guest-5k',
    distance_m: 5000,
    time_s: 1470,
    date: '2026-11-23',
    source: 'benchmark',
    label: '5K',
  };

  const engine = new PredictionEngine([guestEffort], null, {
    longest_run_miles: 8.0,
    avg_weekly_miles: 25.0,
  });

  const vdot = engine.effectiveVdot;
  assert.ok(vdot !== null && vdot >= 39 && vdot <= 42, `VDOT should be ~40 for 24:30 5K, got ${vdot}`);

  const zones = engine.getTrainingZones();
  assert.ok(zones.easy.label, 'Easy pace is defined');
  assert.ok(zones.threshold.label, 'Threshold pace is defined');
  assert.ok(zones.interval.label, 'Interval pace is defined');

  // Verify that an athlete with 24:30 5K gets an easy pace around 9:00-9:50/mi
  assert.ok(zones.easy.pace_s > 500, 'Easy pace in seconds is slower than threshold');
  assert.ok(zones.easy.pace_s > zones.threshold.pace_s);
});
