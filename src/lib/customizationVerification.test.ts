import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTrainingPlan,
  capRestDays,
  enforceRecoveryGate,
  finalizePlanSchedule,
  parseDayTargetedPrompt,
  MAX_AUTO_REST_DAYS,
} from './trainingPlans';
import { PredictionEngine } from './predictionEngine';
import { VERIFIED_PR_EFFORTS } from './seedData';
import type { DailyWorkout, HealthSnapshot, TrainingPlan, WorkoutType } from './types';

// Standard zones fixture
const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 54.6, { longest_run_miles: 8, avg_weekly_miles: 25 }, 60, null);
const zones = engine.getTrainingZones();

test('Requirement 1: Zero forced rest days when user customizes all 7 days to runs', () => {
  const basePlan = generateTrainingPlan('track_mid', zones);
  assert.equal(basePlan.schedule.length, 7);

  // User customizes Monday (previously Rest) into a 4.0 mi Easy Run
  const mondayRun: DailyWorkout = {
    day: 'Monday',
    name: 'Easy Zone 2 Run',
    workout_type: 'easy',
    warmup_miles: 0.5,
    main_miles: 3.0,
    cooldown_miles: 0.5,
    distance_miles: 4.0,
    pace_target: zones.easy.label,
    hr_cap: '< 145 bpm',
    description: 'Custom user run.',
    is_pinned: true,
    user_customized: true,
  };

  const scheduleWith7Runs = basePlan.schedule.map((w) => (w.day === 'Monday' ? mondayRun : w));
  
  // Verify all 7 days are non-rest
  const restCountBefore = scheduleWith7Runs.filter((w) => w.workout_type === 'rest').length;
  assert.equal(restCountBefore, 0, 'Schedule has 0 rest days');

  // Run through finalizePlanSchedule and capRestDays
  const finalized = finalizePlanSchedule({
    ...basePlan,
    schedule: scheduleWith7Runs,
  });

  const restCountAfter = finalized.schedule.filter((w) => w.workout_type === 'rest').length;
  assert.equal(restCountAfter, 0, 'Never automatically forces a rest day when athlete has 0 rest days');
  
  const mondayWorkout = finalized.schedule.find((w) => w.day === 'Monday');
  assert.equal(mondayWorkout?.workout_type, 'easy');
  assert.equal(mondayWorkout?.distance_miles, 4.0);
  assert.equal(mondayWorkout?.is_pinned, true);
});

test('Requirement 1: EnforceRecoveryGate keeps user-pinned/customized runs intact and advisory only', () => {
  const lowHrvHealth: HealthSnapshot = {
    date: '2026-11-24',
    hrv_last_night: 28,
    hrv_baseline_low: 48,
    hrv_status: 'LOW',
    sleep_hours: 4.8,
    sleep_score: 45,
    body_battery: 22,
    resting_hr: 58,
    vo2max: 54.6,
  };

  const userPinnedWorkout: DailyWorkout = {
    day: 'Tuesday',
    name: 'Tuesday Quality Intervals',
    workout_type: 'workout',
    warmup_miles: 1.5,
    main_miles: 3.0,
    cooldown_miles: 1.0,
    distance_miles: 5.5,
    pace_target: '6:15/mi',
    hr_cap: '< 180 bpm',
    description: 'Intervals',
    is_pinned: true,
    user_customized: true,
  };

  const plan: TrainingPlan = {
    focus_id: 'track_mid',
    title: 'Custom Plan',
    target_race: '5K',
    weekly_mileage: 25.0,
    aerobic_deficit_focus: 'Focus',
    schedule: [
      {
        day: 'Monday',
        name: 'Easy Run',
        workout_type: 'easy',
        distance_miles: 4.0,
        pace_target: '8:00/mi',
        hr_cap: '< 145 bpm',
        description: 'Easy',
      },
      userPinnedWorkout,
      {
        day: 'Wednesday',
        name: 'Easy Run',
        workout_type: 'easy',
        distance_miles: 4.0,
        pace_target: '8:00/mi',
        hr_cap: '< 145 bpm',
        description: 'Easy',
      },
      {
        day: 'Thursday',
        name: 'Tempo',
        workout_type: 'workout',
        distance_miles: 5.0,
        pace_target: '6:30/mi',
        hr_cap: '< 175 bpm',
        description: 'Tempo',
      },
      {
        day: 'Friday',
        name: 'Easy Run',
        workout_type: 'easy',
        distance_miles: 3.5,
        pace_target: '8:00/mi',
        hr_cap: '< 145 bpm',
        description: 'Easy',
      },
      {
        day: 'Saturday',
        name: 'Long Run',
        workout_type: 'long_run',
        distance_miles: 8.0,
        pace_target: '8:00/mi',
        hr_cap: '< 150 bpm',
        description: 'Long',
      },
      {
        day: 'Sunday',
        name: 'Recovery',
        workout_type: 'recovery',
        distance_miles: 3.0,
        pace_target: '8:30/mi',
        hr_cap: '< 140 bpm',
        description: 'Recovery',
      },
    ],
  };

  // Run enforceRecoveryGate for Tuesday (the pinned day)
  const gated = enforceRecoveryGate(plan, lowHrvHealth, 'Tuesday');
  const tuesdayAfter = gated.schedule.find((w) => w.day === 'Tuesday');

  assert.equal(tuesdayAfter?.distance_miles, 5.5, 'User-pinned distance is NOT zeroed out');
  assert.equal(tuesdayAfter?.workout_type, 'workout', 'User-pinned workout type is preserved');
  assert.match(tuesdayAfter?.injury_prevention_note ?? '', /Advisory: HRV 28 ms/i, 'Advisory note is attached');
});

test('Requirement 1: EnforceRecoveryGate converts unpinned suppressed day to Easy Recovery Run, never forced 0-mile rest', () => {
  const lowHrvHealth: HealthSnapshot = {
    date: '2026-11-24',
    hrv_last_night: 30,
    hrv_baseline_low: 48,
    hrv_status: 'LOW',
    sleep_hours: 5.0,
    sleep_score: 52,
    body_battery: 25,
    resting_hr: 56,
    vo2max: 54.6,
  };

  const plan = generateTrainingPlan('track_mid', zones);
  const gated = enforceRecoveryGate(plan, lowHrvHealth, 'Tuesday');
  const tuesdayAfter = gated.schedule.find((w) => w.day === 'Tuesday');

  assert.equal(tuesdayAfter?.workout_type, 'recovery', 'Converts to recovery run, not rest');
  assert.equal(tuesdayAfter?.distance_miles, 3.0, 'Scheduled for 3.0 miles, not 0.0');
  assert.match(tuesdayAfter?.hr_cap ?? '', /140 bpm/i, 'Keeps HR controlled under 140 bpm');
});

test('Requirement 1: CapRestDays enforces max 1 automatic rest day, but keeps explicit user rest days', () => {
  // Plan with 3 rest days (none pinned/customized)
  const threeRestSchedule: DailyWorkout[] = [
    { day: 'Monday', name: 'Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', description: 'Rest' },
    { day: 'Tuesday', name: 'Quality', workout_type: 'workout', distance_miles: 5, pace_target: '6:15', hr_cap: '180', description: 'Run' },
    { day: 'Wednesday', name: 'Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', description: 'Rest' },
    { day: 'Thursday', name: 'Easy', workout_type: 'easy', distance_miles: 4, pace_target: '8:00', hr_cap: '145', description: 'Run' },
    { day: 'Friday', name: 'Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', description: 'Rest' },
    { day: 'Saturday', name: 'Long', workout_type: 'long_run', distance_miles: 8, pace_target: '8:00', hr_cap: '150', description: 'Run' },
    { day: 'Sunday', name: 'Easy', workout_type: 'easy', distance_miles: 4, pace_target: '8:00', hr_cap: '145', description: 'Run' },
  ];

  capRestDays(threeRestSchedule, MAX_AUTO_REST_DAYS);
  const autoRestCount = threeRestSchedule.filter((w) => w.workout_type === 'rest').length;
  assert.equal(autoRestCount, 1, 'Automatic rest days capped at 1, surplus converted to recovery shakeout');

  // If user explicitly pinned 2 rest days:
  const twoPinnedRestSchedule: DailyWorkout[] = [
    { day: 'Monday', name: 'User Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', description: 'Rest', is_pinned: true, user_customized: true },
    { day: 'Tuesday', name: 'Quality', workout_type: 'workout', distance_miles: 5, pace_target: '6:15', hr_cap: '180', description: 'Run' },
    { day: 'Wednesday', name: 'Easy', workout_type: 'easy', distance_miles: 4, pace_target: '8:00', hr_cap: '145', description: 'Run' },
    { day: 'Thursday', name: 'Easy', workout_type: 'easy', distance_miles: 4, pace_target: '8:00', hr_cap: '145', description: 'Run' },
    { day: 'Friday', name: 'User Rest 2', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', description: 'Rest', is_pinned: true, user_customized: true },
    { day: 'Saturday', name: 'Long', workout_type: 'long_run', distance_miles: 8, pace_target: '8:00', hr_cap: '150', description: 'Run' },
    { day: 'Sunday', name: 'Easy', workout_type: 'easy', distance_miles: 4, pace_target: '8:00', hr_cap: '145', description: 'Run' },
  ];

  capRestDays(twoPinnedRestSchedule, MAX_AUTO_REST_DAYS);
  const explicitRestCount = twoPinnedRestSchedule.filter((w) => w.workout_type === 'rest').length;
  assert.equal(explicitRestCount, 2, 'Explicit athlete rest days are preserved, not stripped');
});

test('Requirement 2: Full per-day customization via parseDayTargetedPrompt', () => {
  // Test Monday 5 mile tempo
  const p1 = parseDayTargetedPrompt('Change Monday to a 5 mile tempo workout', 'Wednesday', zones);
  assert.equal(p1.isTargeted, true);
  assert.equal(p1.day, 'Monday');
  assert.equal(p1.workout_type, 'workout');
  assert.equal(p1.distance_miles, 5.0);

  // Test Thursday rest day
  const p2 = parseDayTargetedPrompt('Make Thursday a rest day off', 'Monday', zones);
  assert.equal(p2.isTargeted, true);
  assert.equal(p2.day, 'Thursday');
  assert.equal(p2.workout_type, 'rest');
  assert.equal(p2.distance_miles, 0);

  // Test Sunday cross training
  const p3 = parseDayTargetedPrompt('Sunday 45 min cycling strength cross training', 'Monday', zones);
  assert.equal(p3.isTargeted, true);
  assert.equal(p3.day, 'Sunday');
  assert.equal(p3.workout_type, 'cross_train');

  // Test Saturday 9.5 mile long run
  const p4 = parseDayTargetedPrompt('On Saturday give me a 9.5 mile long run', 'Monday', zones);
  assert.equal(p4.isTargeted, true);
  assert.equal(p4.day, 'Saturday');
  assert.equal(p4.workout_type, 'long_run');
  assert.equal(p4.distance_miles, 9.5);
});

test('Requirement 3: Preserve user overrides across focus switches and re-generation', () => {
  const customizedDays: Record<string, DailyWorkout> = {
    Wednesday: {
      day: 'Wednesday',
      name: 'Custom Wednesday 6.0m Tempo',
      workout_type: 'workout',
      warmup_miles: 1.5,
      main_miles: 3.5,
      cooldown_miles: 1.0,
      distance_miles: 6.0,
      pace_target: '6:20/mi',
      hr_cap: '< 175 bpm',
      description: 'Custom threshold tempo.',
      is_pinned: true,
      user_customized: true,
    },
    Monday: {
      day: 'Monday',
      name: 'Monday Aerobic Shakeout',
      workout_type: 'easy',
      warmup_miles: 0.5,
      main_miles: 3.0,
      cooldown_miles: 0.5,
      distance_miles: 4.0,
      pace_target: '8:10/mi',
      hr_cap: '< 145 bpm',
      description: 'Replaces rest with 4 miles.',
      is_pinned: true,
      user_customized: true,
    },
  };

  // 1. Focus 1: track_mid
  const baseTrack = generateTrainingPlan('track_mid', zones);
  const trackMerged = {
    ...baseTrack,
    schedule: baseTrack.schedule.map((w) => customizedDays[w.day] ?? w),
  };
  const finalizedTrack = finalizePlanSchedule(trackMerged);

  assert.equal(finalizedTrack.schedule.find((w) => w.day === 'Monday')?.distance_miles, 4.0);
  assert.equal(finalizedTrack.schedule.find((w) => w.day === 'Wednesday')?.distance_miles, 6.0);
  assert.equal(finalizedTrack.schedule.find((w) => w.day === 'Wednesday')?.workout_type, 'workout');

  // 2. Switch Focus to half_marathon
  const baseHalf = generateTrainingPlan('half_marathon', zones);
  const halfMerged = {
    ...baseHalf,
    schedule: baseHalf.schedule.map((w) => customizedDays[w.day] ?? w),
  };
  const finalizedHalf = finalizePlanSchedule(halfMerged);

  assert.equal(finalizedHalf.schedule.find((w) => w.day === 'Monday')?.distance_miles, 4.0, 'Monday custom run persists in half marathon focus');
  assert.equal(finalizedHalf.schedule.find((w) => w.day === 'Wednesday')?.distance_miles, 6.0, 'Wednesday custom tempo persists in half marathon focus');

  // Recalculated weekly mileage matches the sum of the schedule
  const expectedSum = Number(finalizedHalf.schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1));
  assert.equal(finalizedHalf.weekly_mileage, expectedSum, 'Weekly mileage is accurately recomputed from customized days');
});
