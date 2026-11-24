import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTrainingPlan,
  capRestDays,
  computeScheduleStats,
  enforceRecoveryGate,
  filterRemainingSchedule,
  finalizePlanSchedule,
  getRemainingDaysOfWeek,
  getTodayDayName,
  normalizeDayName,
  parseDayTargetedPrompt,
  slicePlanToRemainingDays,
  MAX_AUTO_REST_DAYS,
} from './trainingPlans';
import { PredictionEngine } from './predictionEngine';
import { DEFAULT_GARMLINK_HEALTH, VERIFIED_PR_EFFORTS } from './seedData';
import type { DailyWorkout, HealthSnapshot, TrainingPlan } from './types';

// Standard zones fixture
const engine = new PredictionEngine(
  VERIFIED_PR_EFFORTS,
  54.6,
  { longest_run_miles: 8, avg_weekly_miles: 25 },
  60,
  null
);
const zones = engine.getTrainingZones();

function makeWorkout(overrides: Partial<DailyWorkout> & Pick<DailyWorkout, 'day' | 'name' | 'workout_type'>): DailyWorkout {
  return {
    distance_miles: 4.0,
    pace_target: zones.easy.label,
    hr_cap: '< 145 bpm',
    description: 'Scheduled session.',
    injury_prevention_note: 'Stay relaxed and hydrated.',
    ...overrides,
  };
}

function makeLowHrvHealth(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    ...DEFAULT_GARMLINK_HEALTH,
    hrv_last_night: 30,
    hrv_baseline_low: 48,
    hrv_status: 'LOW',
    sleep_hours: 5.0,
    sleep_score: 52,
    body_battery: 25,
    ...overrides,
  };
}

test('Requirement 1: Zero forced rest days when user customizes all 7 days to runs', () => {
  const basePlan = generateTrainingPlan('track_mid', zones);
  assert.equal(basePlan.schedule.length, 7);

  const mondayRun = makeWorkout({
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
  });

  const scheduleWith7Runs = basePlan.schedule.map((w) => (w.day === 'Monday' ? mondayRun : w));
  const restCountBefore = scheduleWith7Runs.filter((w) => w.workout_type === 'rest').length;
  assert.equal(restCountBefore, 0, 'Schedule has 0 rest days');

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
  const lowHrvHealth = makeLowHrvHealth({ hrv_last_night: 28, sleep_hours: 4.8, sleep_score: 45 });

  const userPinnedWorkout = makeWorkout({
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
  });

  const plan: TrainingPlan = {
    focus_id: 'track_mid',
    title: 'Custom Plan',
    target_race: '5K',
    weekly_mileage: 25.0,
    aerobic_deficit_focus: 'Focus',
    schedule: [
      makeWorkout({ day: 'Monday', name: 'Easy Run', workout_type: 'easy', distance_miles: 4.0 }),
      userPinnedWorkout,
      makeWorkout({ day: 'Wednesday', name: 'Easy Run', workout_type: 'easy', distance_miles: 4.0 }),
      makeWorkout({ day: 'Thursday', name: 'Tempo', workout_type: 'workout', distance_miles: 5.0, pace_target: '6:30/mi', hr_cap: '< 175 bpm' }),
      makeWorkout({ day: 'Friday', name: 'Easy Run', workout_type: 'easy', distance_miles: 3.5 }),
      makeWorkout({ day: 'Saturday', name: 'Long Run', workout_type: 'long_run', distance_miles: 8.0, hr_cap: '< 150 bpm' }),
      makeWorkout({ day: 'Sunday', name: 'Recovery', workout_type: 'recovery', distance_miles: 3.0, pace_target: '8:30/mi', hr_cap: '< 140 bpm' }),
    ],
  };

  const gated = enforceRecoveryGate(plan, lowHrvHealth, 'Tuesday');
  const tuesdayAfter = gated.schedule.find((w) => w.day === 'Tuesday');

  assert.equal(tuesdayAfter?.distance_miles, 5.5, 'User-pinned distance is NOT zeroed out');
  assert.equal(tuesdayAfter?.workout_type, 'workout', 'User-pinned workout type is preserved');
  assert.match(tuesdayAfter?.injury_prevention_note ?? '', /Advisory: HRV 28 ms/i, 'Advisory note is attached');
});

test('Requirement 1: EnforceRecoveryGate converts unpinned suppressed day to Easy Recovery Run, never forced 0-mile rest', () => {
  const lowHrvHealth = makeLowHrvHealth();
  const plan = generateTrainingPlan('track_mid', zones);
  const gated = enforceRecoveryGate(plan, lowHrvHealth, 'Tuesday');
  const tuesdayAfter = gated.schedule.find((w) => w.day === 'Tuesday');

  assert.equal(tuesdayAfter?.workout_type, 'recovery', 'Converts to recovery run, not rest');
  assert.equal(tuesdayAfter?.distance_miles, 3.0, 'Scheduled for 3.0 miles, not 0.0');
  assert.match(tuesdayAfter?.hr_cap ?? '', /140 bpm/i, 'Keeps HR controlled under 140 bpm');
});

test('Requirement 1: CapRestDays enforces max 1 automatic rest day, but keeps explicit user rest days', () => {
  const threeRestSchedule: DailyWorkout[] = [
    makeWorkout({ day: 'Monday', name: 'Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest' }),
    makeWorkout({ day: 'Tuesday', name: 'Quality', workout_type: 'workout', distance_miles: 5, pace_target: '6:15', hr_cap: '180' }),
    makeWorkout({ day: 'Wednesday', name: 'Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest' }),
    makeWorkout({ day: 'Thursday', name: 'Easy', workout_type: 'easy', distance_miles: 4 }),
    makeWorkout({ day: 'Friday', name: 'Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest' }),
    makeWorkout({ day: 'Saturday', name: 'Long', workout_type: 'long_run', distance_miles: 8, hr_cap: '150' }),
    makeWorkout({ day: 'Sunday', name: 'Easy', workout_type: 'easy', distance_miles: 4 }),
  ];

  capRestDays(threeRestSchedule, MAX_AUTO_REST_DAYS);
  const autoRestCount = threeRestSchedule.filter((w) => w.workout_type === 'rest').length;
  assert.equal(autoRestCount, 1, 'Automatic rest days capped at 1, surplus converted to recovery shakeout');

  const twoPinnedRestSchedule: DailyWorkout[] = [
    makeWorkout({ day: 'Monday', name: 'User Rest', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', is_pinned: true, user_customized: true }),
    makeWorkout({ day: 'Tuesday', name: 'Quality', workout_type: 'workout', distance_miles: 5, pace_target: '6:15', hr_cap: '180' }),
    makeWorkout({ day: 'Wednesday', name: 'Easy', workout_type: 'easy', distance_miles: 4 }),
    makeWorkout({ day: 'Thursday', name: 'Easy', workout_type: 'easy', distance_miles: 4 }),
    makeWorkout({ day: 'Friday', name: 'User Rest 2', workout_type: 'rest', distance_miles: 0, pace_target: 'Off', hr_cap: 'Rest', is_pinned: true, user_customized: true }),
    makeWorkout({ day: 'Saturday', name: 'Long', workout_type: 'long_run', distance_miles: 8, hr_cap: '150' }),
    makeWorkout({ day: 'Sunday', name: 'Easy', workout_type: 'easy', distance_miles: 4 }),
  ];

  capRestDays(twoPinnedRestSchedule, MAX_AUTO_REST_DAYS);
  const explicitRestCount = twoPinnedRestSchedule.filter((w) => w.workout_type === 'rest').length;
  assert.equal(explicitRestCount, 2, 'Explicit athlete rest days are preserved, not stripped');
});

test('Requirement 2: Full per-day customization via parseDayTargetedPrompt', () => {
  const p1 = parseDayTargetedPrompt('Change Monday to a 5 mile tempo workout', 'Wednesday', zones);
  assert.equal(p1.isTargeted, true);
  assert.equal(p1.day, 'Monday');
  assert.equal(p1.workout_type, 'workout');
  assert.equal(p1.distance_miles, 5.0);

  const p2 = parseDayTargetedPrompt('Make Thursday a rest day off', 'Monday', zones);
  assert.equal(p2.isTargeted, true);
  assert.equal(p2.day, 'Thursday');
  assert.equal(p2.workout_type, 'rest');
  assert.equal(p2.distance_miles, 0);

  const p3 = parseDayTargetedPrompt('Sunday 45 min cycling strength cross training', 'Monday', zones);
  assert.equal(p3.isTargeted, true);
  assert.equal(p3.day, 'Sunday');
  assert.equal(p3.workout_type, 'cross_train');

  const p4 = parseDayTargetedPrompt('On Saturday give me a 9.5 mile long run', 'Monday', zones);
  assert.equal(p4.isTargeted, true);
  assert.equal(p4.day, 'Saturday');
  assert.equal(p4.workout_type, 'long_run');
  assert.equal(p4.distance_miles, 9.5);
});

test('Requirement 3: Preserve user overrides across focus switches and re-generation', () => {
  const customizedDays: Record<string, DailyWorkout> = {
    Wednesday: makeWorkout({
      day: 'Wednesday',
      name: 'Custom Wednesday 6.0m Tempo',
      workout_type: 'workout',
      warmup_miles: 1.5,
      main_miles: 3.5,
      cooldown_miles: 1.0,
      distance_miles: 6.0,
      pace_target: '6:20/mi',
      hr_cap: '< 175 bpm',
      is_pinned: true,
      user_customized: true,
    }),
    Monday: makeWorkout({
      day: 'Monday',
      name: 'Monday Aerobic Shakeout',
      workout_type: 'easy',
      warmup_miles: 0.5,
      main_miles: 3.0,
      cooldown_miles: 0.5,
      distance_miles: 4.0,
      pace_target: '8:10/mi',
      hr_cap: '< 145 bpm',
      is_pinned: true,
      user_customized: true,
    }),
  };

  const baseTrack = generateTrainingPlan('track_mid', zones);
  const trackMerged = {
    ...baseTrack,
    schedule: baseTrack.schedule.map((w) => customizedDays[w.day] ?? w),
  };
  const finalizedTrack = finalizePlanSchedule(trackMerged);

  assert.equal(finalizedTrack.schedule.find((w) => w.day === 'Monday')?.distance_miles, 4.0);
  assert.equal(finalizedTrack.schedule.find((w) => w.day === 'Wednesday')?.distance_miles, 6.0);
  assert.equal(finalizedTrack.schedule.find((w) => w.day === 'Wednesday')?.workout_type, 'workout');

  const baseHalf = generateTrainingPlan('half_marathon', zones);
  const halfMerged = {
    ...baseHalf,
    schedule: baseHalf.schedule.map((w) => customizedDays[w.day] ?? w),
  };
  const finalizedHalf = finalizePlanSchedule(halfMerged);

  assert.equal(finalizedHalf.schedule.find((w) => w.day === 'Monday')?.distance_miles, 4.0, 'Monday custom run persists in half marathon focus');
  assert.equal(finalizedHalf.schedule.find((w) => w.day === 'Wednesday')?.distance_miles, 6.0, 'Wednesday custom tempo persists in half marathon focus');

  const expectedSum = Number(finalizedHalf.schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1));
  assert.equal(finalizedHalf.weekly_mileage, expectedSum, 'Weekly mileage is accurately recomputed from customized days');
});

test('Bug 1 Fix: Only remaining days of the week (today through Sunday) are included and weekly summary recalculates strictly from visible days', () => {
  const tuesdayDate = new Date(2026, 10, 24, 14, 0, 0); // Tuesday Nov 24, 2026 (local time)
  assert.equal(getTodayDayName(tuesdayDate), 'Tuesday');

  const remainingTue = getRemainingDaysOfWeek('Tuesday');
  assert.deepEqual(remainingTue, ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.ok(!remainingTue.includes('Monday'), 'Monday must be excluded when today is Tuesday');

  const remainingSun = getRemainingDaysOfWeek('Sunday');
  assert.deepEqual(remainingSun, ['Sunday']);

  const remainingMon = getRemainingDaysOfWeek('Monday');
  assert.deepEqual(remainingMon, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

  const fullPlan = generateTrainingPlan('half_marathon', zones, null);
  const withMondayRun: TrainingPlan = {
    ...fullPlan,
    schedule: fullPlan.schedule.map((w) =>
      w.day === 'Monday'
        ? makeWorkout({ day: 'Monday', workout_type: 'easy', distance_miles: 5.0, name: 'Monday Run' })
        : w
    ),
  };

  const remainingPlan = finalizePlanSchedule(withMondayRun, null, {
    todayDay: 'Tuesday',
    remainingOnly: true,
  });

  assert.equal(remainingPlan.schedule.length, 6, 'Tuesday–Sunday contains exactly 6 days');
  assert.equal(remainingPlan.schedule[0].day, 'Tuesday');
  assert.equal(remainingPlan.schedule.some((w) => w.day === 'Monday'), false, 'Monday excluded from rendered schedule');

  const stats = computeScheduleStats(remainingPlan.schedule);
  const expectedRemainingMiles = Number(
    withMondayRun.schedule
      .filter((w) => w.day !== 'Monday')
      .reduce((acc, w) => acc + w.distance_miles, 0)
      .toFixed(1)
  );
  assert.equal(remainingPlan.weekly_mileage, expectedRemainingMiles);
  assert.equal(stats.totalMiles, expectedRemainingMiles);
  assert.equal(
    stats.qualityCount + stats.raceCount + stats.easyRecoveryCount + stats.crossTrainCount + stats.restCount,
    6,
    'Summary counts strictly reflect the 6 remaining visible cards'
  );

  const sliced = slicePlanToRemainingDays(withMondayRun, 'Thursday');
  assert.deepEqual(
    sliced.schedule.map((w) => w.day),
    ['Thursday', 'Friday', 'Saturday', 'Sunday']
  );
  assert.equal(
    sliced.weekly_mileage,
    Number(sliced.schedule.reduce((sum, w) => sum + w.distance_miles, 0).toFixed(1))
  );
});

test('Bug 2 Fix: Modify Day prompts ("harder workout", "quality session") update target day (even today under low HRV) and recompute summary', () => {
  const harder = parseDayTargetedPrompt('harder workout', 'Tuesday', zones);
  assert.equal(harder.day, 'Tuesday');
  assert.equal(harder.workout_type, 'workout');
  assert.ok(harder.distance_miles >= 5.0, `Expected quality distance >= 5 mi, got ${harder.distance_miles}`);
  assert.ok(
    Math.abs(harder.warmup_miles + harder.main_miles + harder.cooldown_miles - harder.distance_miles) < 0.05
  );

  const quality = parseDayTargetedPrompt('quality session', 'Tuesday', zones);
  assert.equal(quality.day, 'Tuesday');
  assert.equal(quality.workout_type, 'workout');
  assert.ok(quality.distance_miles >= 5.0);

  const track = parseDayTargetedPrompt('5x800m track workout', 'Tuesday', zones);
  assert.equal(track.workout_type, 'workout');
  assert.ok(track.distance_miles < 15, `Track interval prompt parsed reasonable miles (${track.distance_miles})`);

  const lowHrvHealth = makeLowHrvHealth({ hrv_last_night: 32, hrv_status: 'UNBALANCED', sleep_score: 54, sleep_hours: 5.1 });

  const basePlan = generateTrainingPlan('track_mid', zones, {
    name: 'Run for Pie 5K',
    dist: '5K',
    day: 'Thursday',
  });

  const modifiedTuesday: DailyWorkout = {
    day: normalizeDayName('tuesday'),
    name: harder.name,
    workout_type: harder.workout_type,
    warmup_miles: harder.warmup_miles,
    main_miles: harder.main_miles,
    cooldown_miles: harder.cooldown_miles,
    distance_miles: harder.distance_miles,
    pace_target: harder.pace_target,
    hr_cap: harder.hr_cap,
    description: harder.description,
    injury_prevention_note: harder.injury_prevention_note,
    ai_generated: true,
    is_pinned: true,
    user_customized: true,
    adaptation_reason: harder.reason,
  };

  const customizedDays: Record<string, DailyWorkout> = {
    [modifiedTuesday.day]: modifiedTuesday,
  };

  const mergedSchedule = filterRemainingSchedule(
    basePlan.schedule.map((w) => customizedDays[w.day] ?? w),
    'Tuesday'
  );
  const finalPlan = finalizePlanSchedule(
    enforceRecoveryGate({ ...basePlan, schedule: mergedSchedule }, lowHrvHealth, 'Tuesday'),
    { name: 'Run for Pie 5K', dist: '5K', day: 'Thursday' },
    { todayDay: 'Tuesday', remainingOnly: true }
  );

  const renderedTuesday = finalPlan.schedule.find((w) => w.day === 'Tuesday');
  assert.ok(renderedTuesday, 'Tuesday card must exist in remaining schedule');
  assert.equal(renderedTuesday.name, harder.name);
  assert.equal(renderedTuesday.workout_type, 'workout');
  assert.equal(renderedTuesday.distance_miles, harder.distance_miles);
  assert.equal(renderedTuesday.is_pinned, true);
  assert.equal(renderedTuesday.user_customized, true);

  const updatedStats = computeScheduleStats(finalPlan.schedule);
  assert.equal(
    finalPlan.weekly_mileage,
    Number(finalPlan.schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1))
  );
  assert.equal(updatedStats.totalMiles, finalPlan.weekly_mileage);
});
