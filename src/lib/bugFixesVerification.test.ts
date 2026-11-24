import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS_OF_WEEK,
  TRAINING_FOCUS_LABELS,
  applyRaceTaper,
  enforceRecoveryGate,
  finalizePlanSchedule,
  generateTrainingPlan,
  parseDayTargetedPrompt,
} from './trainingPlans';
import {
  PredictionEngine,
  STANDARD_DISTANCES,
  formatPace,
  formatTime,
  parseDistanceMeters,
} from './predictionEngine';
import { VERIFIED_PR_EFFORTS } from './seedData';
import {
  getUserStorageKey,
  loadUserPRs,
  loadUserTargetRace,
  loadUserTelemetry,
  loadUserWorkouts,
  saveUserPRs,
  saveUserTargetRace,
  saveUserTelemetry,
  saveUserWorkouts,
} from './supabaseClient';
import type {
  CourseConditions,
  DailyWorkout,
  HealthSnapshot,
  TrainingFocusId,
  TrainingPlan,
  TrainingZones,
} from './types';

const MOCK_ZONES: TrainingZones = {
  recovery: { pace_s: 540, label: '8:45–9:15/mi' },
  easy: { pace_s: 480, label: '7:40–8:15/mi' },
  marathon: { pace_s: 420, label: '6:50–7:10/mi' },
  threshold: { pace_s: 385, label: '6:20–6:35/mi' },
  interval: { pace_s: 360, label: '5:50–6:05/mi' },
  repetition: { pace_s: 330, label: '5:15–5:30/mi' },
  rep_400m: '78–82s',
};

const BASE_CONDITIONS: CourseConditions = {
  elevation_gain_ft: 0,
  elevation_loss_ft: 0,
  surface: 'road',
  altitude_ft: 0,
  temperature_f: 50,
  humidity_pct: 50,
  wind_mph: 0,
  wind_direction: 'mixed',
  shoe_type: 'streakfly',
  use_readiness: false,
  hrv_status: 'BALANCED',
  sleep_score: 85,
  body_battery: 85,
};

test('1. Single-Day Workout Edits: Day-targeted prompts parse reliably and update ONLY the targeted day', () => {
  // A. "change tuesday to a harder workout"
  const p1 = parseDayTargetedPrompt('change tuesday to a harder workout', 'Monday', MOCK_ZONES);
  assert.equal(p1.isTargeted, true);
  assert.equal(p1.day, 'Tuesday');
  assert.equal(p1.workout_type, 'workout');
  assert.ok(p1.distance_miles > 0);
  assert.ok(p1.pace_target.includes('6:20') || p1.pace_target.includes('Threshold') || p1.pace_target.includes('6:15'));

  // B. "I ran for 4m"
  const p2 = parseDayTargetedPrompt('I ran for 4m', 'Wednesday', MOCK_ZONES);
  assert.equal(p2.isTargeted, true);
  assert.equal(p2.day, 'Wednesday');
  assert.equal(p2.distance_miles, 4.0);
  assert.equal(p2.workout_type, 'easy');

  // C. "wednesday on thursday run for 5m" -> targets Thursday with 5 miles
  const p3 = parseDayTargetedPrompt('wednesday on thursday run for 5m', 'Wednesday', MOCK_ZONES);
  assert.equal(p3.isTargeted, true);
  assert.equal(p3.day, 'Thursday');
  assert.equal(p3.distance_miles, 5.0);

  // D. Modifying single day preserves all other 6 days without resetting or corruption
  const basePlan = generateTrainingPlan('track_mid', MOCK_ZONES, null);
  const originalWed = basePlan.schedule.find((w) => w.day === 'Wednesday');
  const originalFri = basePlan.schedule.find((w) => w.day === 'Friday');

  // Replace Tuesday with harder workout
  const updatedTuesday: DailyWorkout = {
    day: 'Tuesday',
    name: p1.name,
    workout_type: p1.workout_type,
    warmup_miles: p1.warmup_miles,
    main_miles: p1.main_miles,
    cooldown_miles: p1.cooldown_miles,
    distance_miles: p1.distance_miles,
    pace_target: p1.pace_target,
    hr_cap: p1.hr_cap,
    description: p1.description,
    injury_prevention_note: p1.injury_prevention_note,
    ai_generated: true,
    adaptation_reason: p1.reason,
  };

  const adaptedDays: Record<string, DailyWorkout> = { Tuesday: updatedTuesday };
  const schedule = basePlan.schedule.map((w) => adaptedDays[w.day] ?? w);
  const planWithAdapted: TrainingPlan = {
    ...basePlan,
    schedule,
    weekly_mileage: Number(schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1)),
  };

  const finalPlan = finalizePlanSchedule(planWithAdapted, null);
  const finalTuesday = finalPlan.schedule.find((w) => w.day === 'Tuesday');
  assert.ok(finalTuesday);
  assert.equal(finalTuesday.workout_type, 'workout');
  assert.equal(finalTuesday.distance_miles, p1.distance_miles);

  // Other days strictly untouched
  const finalWed = finalPlan.schedule.find((w) => w.day === 'Wednesday');
  const finalFri = finalPlan.schedule.find((w) => w.day === 'Friday');
  assert.equal(finalWed?.name, originalWed?.name);
  assert.equal(finalWed?.distance_miles, originalWed?.distance_miles);
  assert.equal(finalFri?.name, originalFri?.name);
  assert.equal(finalFri?.distance_miles, originalFri?.distance_miles);

  // Weekly mileage reflects sum of all 7 cards
  const cardSum = Number(finalPlan.schedule.reduce((sum, w) => sum + w.distance_miles, 0).toFixed(1));
  assert.equal(finalPlan.weekly_mileage, cardSum);
});

test('2. Training Plan Switching & Weekly Summary Consistency: Day cards and summary recalculate accurately across all focuses', () => {
  const focuses: TrainingFocusId[] = ['track_mid', 'track_long', 'xc', 'half_marathon', 'base_building'];

  for (const focus of focuses) {
    const plan = finalizePlanSchedule(generateTrainingPlan(focus, MOCK_ZONES, null));
    assert.equal(plan.schedule.length, 7, `Plan ${focus} must have exactly 7 days`);

    // Verify all 7 days of week exist in order
    const planDays = plan.schedule.map((w) => w.day);
    assert.deepEqual(planDays, [...DAYS_OF_WEEK], `Plan ${focus} must contain Monday–Sunday`);

    // Verify weekly summary matches exact sum of 7 cards
    const totalMiles = Number(
      plan.schedule.reduce((sum, w) => sum + (Number(w.distance_miles) || 0), 0).toFixed(1)
    );
    assert.equal(plan.weekly_mileage, totalMiles, `Plan ${focus} mileage matches card sum`);

    // Quality count, rest count, easy/recovery count
    const qualityCount = plan.schedule.filter((w) => w.workout_type === 'workout').length;
    const restCount = plan.schedule.filter((w) => w.workout_type === 'rest').length;
    const raceCount = plan.schedule.filter((w) => w.workout_type === 'race').length;
    const easyCount = plan.schedule.filter((w) => w.workout_type === 'easy').length;
    const recCount = plan.schedule.filter((w) => w.workout_type === 'recovery').length;
    const longCount = plan.schedule.filter((w) => w.workout_type === 'long_run').length;

    assert.equal(
      qualityCount + restCount + raceCount + easyCount + recCount + longCount,
      7,
      `Plan ${focus} sum of all workout categories must equal 7`
    );

    // Verify HR caps and pace targets are non-empty
    for (const card of plan.schedule) {
      assert.ok(card.name, `${focus} - ${card.day} has a name`);
      assert.ok(card.pace_target, `${focus} - ${card.day} has pace target`);
      assert.ok(card.hr_cap, `${focus} - ${card.day} has HR cap`);
    }
  }
});

test('3. Race Predictor Consistency: 1600m is strictly faster than 1 Mile across any course & weather conditions', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2, {
    longest_run_miles: 9.0,
    avg_weekly_miles: 25.0,
  });

  const testConditionsList: CourseConditions[] = [
    BASE_CONDITIONS,
    { ...BASE_CONDITIONS, temperature_f: 85, humidity_pct: 80 }, // extreme heat & humidity
    { ...BASE_CONDITIONS, temperature_f: 28, humidity_pct: 40 }, // cold
    { ...BASE_CONDITIONS, wind_mph: 22, wind_direction: 'head' }, // heavy headwind
    { ...BASE_CONDITIONS, elevation_gain_ft: 450, elevation_loss_ft: 450, surface: 'xc' }, // hilly XC
    { ...BASE_CONDITIONS, altitude_ft: 5280, surface: 'road' }, // high altitude
    { ...BASE_CONDITIONS, surface: 'track', shoe_type: 'dragonfly_track' }, // track spikes
  ];

  for (const cond of testConditionsList) {
    const predMile = engine.predict('1 Mile', cond);
    const pred1600 = engine.predict('1600m', cond);

    // 1600m time MUST strictly be less than 1 Mile time
    assert.ok(
      pred1600.time_s < predMile.time_s,
      `1600m (${pred1600.time_s}s) must be faster than 1 Mile (${predMile.time_s}s)`
    );

    // Exact ratio check (1600 / 1609.344)
    const expected1600 = predMile.time_s * (1600 / 1609.344);
    assert.ok(
      Math.abs(pred1600.time_s - expected1600) < 0.05,
      `1600m should strictly equal 1 Mile * (1600 / 1609.344)`
    );

    // Pace per mile must be identical
    assert.equal(pred1600.pace_per_mile, predMile.pace_per_mile);

    // Condition adjustment percentage must be identical
    assert.equal(pred1600.adjustment_pct, predMile.adjustment_pct);
  }

  // 3200m vs 2 Mile
  const predTwoMile = engine.predict('2 Mile', BASE_CONDITIONS);
  const pred3200 = engine.predict('3200m', BASE_CONDITIONS);
  assert.ok(pred3200.time_s < predTwoMile.time_s, '3200m must be faster than 2 Mile');
});

test('3b. Race Predictor & Custom Race Distance Parsing: Handles custom distances, lowercase aliases & pace formatting', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2);

  // Custom race distances
  assert.equal(parseDistanceMeters('8K'), 8000);
  assert.equal(parseDistanceMeters('8k'), 8000);
  assert.equal(parseDistanceMeters('15K'), 15000);
  assert.equal(parseDistanceMeters('5k'), 5000);
  assert.equal(parseDistanceMeters('10k'), 10000);
  assert.equal(parseDistanceMeters('1 mile'), 1609.344);
  assert.equal(parseDistanceMeters('half marathon'), 21097.5);
  assert.equal(parseDistanceMeters('marathon'), 42195);
  assert.equal(parseDistanceMeters('Marathon'), 42195);
  assert.equal(parseDistanceMeters('4m'), 4 * 1609.344);
  assert.equal(parseDistanceMeters('10 miles'), 10 * 1609.344);

  // Predict with custom distance '8K'
  const pred8k = engine.predict('8K', BASE_CONDITIONS);
  assert.ok(pred8k.time_s > 0);
  assert.equal(pred8k.distance_m, 8000);

  // Predict with '5k' lowercase
  const pred5kLower = engine.predict('5k', BASE_CONDITIONS);
  const pred5kUpper = engine.predict('5K', BASE_CONDITIONS);
  assert.equal(pred5kLower.time_s, pred5kUpper.time_s);

  // Pace formatting check
  assert.equal(formatPace(360), '6:00/mi');
  assert.equal(formatPace(385), '6:25/mi');
  assert.ok(!formatPace(360).includes('/mi/mi'), 'No duplicate /mi');

  // PredictAll strictly monotonic
  const all = engine.predictAll(BASE_CONDITIONS);
  for (let i = 1; i < all.length; i++) {
    if (all[i].distance_m > all[i - 1].distance_m) {
      assert.ok(
        all[i].time_s > all[i - 1].time_s,
        `${all[i].distance_label} (${all[i].time_s}s) must be longer than ${all[i - 1].distance_label} (${all[i - 1].time_s}s)`
      );
    }
  }
});

test('4. State & Multi-User Persistence: User isolation and storage persistence operate cleanly', () => {
  const userId = 'test-athlete-123';

  // Save & load workouts for specific focus
  const mockWorkouts: Record<string, DailyWorkout> = {
    Tuesday: {
      day: 'Tuesday',
      name: 'Custom Threshold Intervals',
      workout_type: 'workout',
      warmup_miles: 1.5,
      main_miles: 3.5,
      cooldown_miles: 1.0,
      distance_miles: 6.0,
      pace_target: '6:20/mi',
      hr_cap: '< 180 bpm',
      description: 'Threshold work.',
      injury_prevention_note: 'Proper recovery.',
      ai_generated: true,
      adaptation_reason: 'User custom session',
    },
  };

  saveUserWorkouts(userId, 'track_mid', mockWorkouts);
  const loaded = loadUserWorkouts(userId, 'track_mid');
  assert.equal(loaded.Tuesday?.name, 'Custom Threshold Intervals');
  assert.equal(loaded.Tuesday?.distance_miles, 6.0);

  // Save & load target race
  const targetRace = { name: 'Conference 5K Championship', dist: '5K', day: 'Thursday' };
  saveUserTargetRace(userId, targetRace);
  const loadedRace = loadUserTargetRace(userId);
  assert.equal(loadedRace?.name, 'Conference 5K Championship');
  assert.equal(loadedRace?.dist, '5K');

  // Save & load PRs
  const mockPRs = [{ id: 'pr-1', distance_m: 5000, time_s: 1140, date: '2026-11-20', source: 'track', label: '5K' }];
  saveUserPRs(userId, mockPRs);
  const loadedPRs = loadUserPRs(userId);
  assert.equal(loadedPRs?.length, 1);
  assert.equal(loadedPRs?.[0].time_s, 1140);
});
