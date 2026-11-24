import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PredictionEngine,
  ROTATION_SHOES,
  shoeAdjustment,
} from './predictionEngine';
import {
  PRESET_COURSES,
  SHOE_DATABASE,
  VERIFIED_PR_EFFORTS,
} from './seedData';
import {
  enforceRecoveryGate,
  generateTrainingPlan,
  shouldEnforceRecoveryGate,
} from './trainingPlans';
import type { CourseConditions, HealthSnapshot, TrainingZones } from './types';

const MOCK_ZONES: TrainingZones = {
  easy: { pace_s: 480, label: '7:45–8:15/mi' },
  marathon: { pace_s: 430, label: '7:05–7:20/mi' },
  threshold: { pace_s: 390, label: '6:25–6:35/mi' },
  interval: { pace_s: 360, label: '5:55–6:05/mi' },
  repetition: { pace_s: 325, label: '5:20–5:30/mi' },
  rep_400m: '79–81s',
  recovery: { pace_s: 510, label: '8:25–8:45/mi' },
};

test('1. Hard Recovery Gate enforces Rest Day (0 mi) on suppressed HRV or poor sleep', () => {
  const lowHrvHealth: HealthSnapshot = {
    date: '2026-11-23',
    vo2max: 54.6,
    resting_hr: 52,
    body_battery: 45,
    sleep_score: 54,
    sleep_hours: 5.1,
    stress_avg: 35,
    hrv_last_night: 32,
    hrv_weekly_avg: 58,
    hrv_baseline_low: 48,
    hrv_baseline_high: 73,
    hrv_status: 'LOW',
    load_aerobic_low: 600,
    load_aerobic_high: 1200,
    load_anaerobic: 400,
    acwr_ratio: 1.1,
    consecutive_run_days: 2,
    source: 'garmlink_mcp',
    synced_at: new Date().toISOString(),
  };

  assert.equal(shouldEnforceRecoveryGate(lowHrvHealth), true);

  // Generate track_mid plan
  const plan = generateTrainingPlan('track_mid', MOCK_ZONES, null);
  const gated = enforceRecoveryGate(plan, lowHrvHealth, 'Monday');

  const mondayWorkout = gated.schedule.find((w) => w.day === 'Monday');
  assert.ok(mondayWorkout, 'Monday workout must exist');
  assert.equal(mondayWorkout.workout_type, 'rest');
  assert.equal(mondayWorkout.distance_miles, 0);
  assert.ok(mondayWorkout.name.includes('Recovery Gate') || mondayWorkout.name.includes('Rest'));
  assert.ok(mondayWorkout.description.includes('Zero running') || mondayWorkout.description.includes('Complete rest'));

  // Test when health is optimal (HRV 62 in 48-73 baseline, sleep 8h)
  const goodHealth: HealthSnapshot = {
    ...lowHrvHealth,
    hrv_last_night: 62,
    hrv_status: 'BALANCED',
    sleep_score: 88,
    sleep_hours: 8.0,
  };
  assert.equal(shouldEnforceRecoveryGate(goodHealth), false);
});

test('2. Track Spikes Catalog: Spikes on Track are OPTIMAL and never SURFACE HAZARD', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS);

  // Check Conference Finals Track course exists and has 0 ft elevation gain
  const trackCourse = PRESET_COURSES.find((c) => c.course_id === 'conference_finals_track_1mi');
  assert.ok(trackCourse, 'Conference Finals Track (1 Mile) must exist in PRESET_COURSES');
  assert.ok(
    trackCourse.distance_label === '1 Mile' || trackCourse.distance_label === '1600m',
    'distance_label should be 1 Mile'
  );
  assert.equal(trackCourse.surface, 'track');
  assert.equal(trackCourse.elevation_gain_ft, 0);

  const trackConditions: CourseConditions = {
    elevation_gain_ft: 0,
    elevation_loss_ft: 0,
    surface: 'track',
    altitude_ft: 50,
    temperature_f: 55,
    humidity_pct: 50,
    wind_mph: 3,
    wind_direction: 'mixed',
    shoe_type: 'dragonfly_track',
    use_readiness: false,
    hrv_status: 'BALANCED',
    sleep_score: 80,
    body_battery: 75,
  };

  const shoes = engine.compareShoes('1600m', trackConditions);
  assert.ok(shoes.length >= 8, 'Should compare expanded spike and shoe rotation');

  // Verify track spikes: Dragonfly 2, Dragonfly 2 Elite, Victory 2
  const dragonfly = shoes.find((s) => s.shoe_id === 'dragonfly_track');
  const elite = shoes.find((s) => s.shoe_id === 'dragonfly_elite');
  const trainer = shoes.find((s) => s.shoe_id === 'nb_1080');

  assert.ok(dragonfly, 'Dragonfly 2 must be present');
  assert.ok(elite, 'Dragonfly 2 Elite must be present');
  assert.ok(trainer, 'NB 1080 must be present');

  // Critical: Spikes on Track must NEVER be SURFACE HAZARD
  const trackSpikes = shoes.filter((s) =>
    ['dragonfly_track', 'dragonfly_elite', 'victory_2', 'avanti_tyo', 'fuelcell_sc_ldx'].includes(s.shoe_id)
  );
  for (const spike of trackSpikes) {
    assert.notEqual(
      spike.tag,
      'SURFACE HAZARD',
      `${spike.label} must NEVER be tagged SURFACE HAZARD on Track (All-Weather)`
    );
  }

  // The fastest shoe on track must be an OPTIMAL track spike
  const fastest = shoes[0];
  assert.equal(fastest.tag, 'OPTIMAL');
  assert.ok(
    ['dragonfly_elite', 'dragonfly_track', 'victory_2'].includes(fastest.shoe_id),
    'Fastest shoe on track must be a track spike'
  );

  // Spikes must be faster than the daily trainer (NB 1080)
  assert.ok(
    dragonfly.time_s < trainer.time_s,
    `Dragonfly (${dragonfly.time_fmt}) must predict faster than NB 1080 (${trainer.time_fmt}) on track`
  );
});

test('3. Track Spikes on Road Asphalt are strictly tagged SURFACE HAZARD', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS);

  const roadConditions: CourseConditions = {
    elevation_gain_ft: 50,
    elevation_loss_ft: 50,
    surface: 'road',
    altitude_ft: 70,
    temperature_f: 55,
    humidity_pct: 50,
    wind_mph: 5,
    wind_direction: 'mixed',
    shoe_type: 'streakfly',
    use_readiness: false,
    hrv_status: 'BALANCED',
    sleep_score: 80,
    body_battery: 75,
  };

  const roadShoes = engine.compareShoes('5K', roadConditions);
  const roadSpike = roadShoes.find((s) => s.shoe_id === 'dragonfly_track');
  assert.ok(roadSpike);
  assert.equal(
    roadSpike.tag,
    'SURFACE HAZARD',
    'Track spikes on road asphalt MUST be tagged SURFACE HAZARD'
  );

  const roadRacer = roadShoes.find((s) => s.shoe_id === 'streakfly');
  assert.ok(roadRacer);
  assert.equal(roadRacer.tag, 'OPTIMAL');
});
