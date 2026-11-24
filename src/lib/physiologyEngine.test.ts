import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PhysiologyEngine,
  fitCriticalSpeed,
  calculateDynamicRiegelExponent,
  getElevationProfileForCourse,
  STANDARD_METERS,
} from './physiologyEngine';
import type { CoursePreset, CourseConditions, Effort } from './types';

const EPHRAIM_EFFORTS: Effort[] = [
  {
    id: 'pr-400m',
    distance_m: 400,
    time_s: 64.2,
    date: '2026-05-15',
    label: '400m',
    source: 'track_meet',
  },
  {
    id: 'pr-800m',
    distance_m: 800,
    time_s: 142.0,
    date: '2026-05-22',
    label: '800m',
    source: 'track_meet',
  },
  {
    id: 'pr-1600m',
    distance_m: 1600,
    time_s: 317.1,
    date: '2026-11-19',
    label: '1600m',
    source: 'track_pr',
  },
  {
    id: 'pr-1mile',
    distance_m: 1609.344,
    time_s: 318.88,
    date: '2026-11-19',
    label: '1 Mile',
    source: 'garmin_pr',
  },
  {
    id: 'pr-5k',
    distance_m: 5000,
    time_s: 1148.0,
    date: '2026-11-21',
    label: '5K',
    source: 'garmin_pr',
  },
];

const TRACK_COURSE: CoursePreset = {
  course_id: 'standard_track',
  name: 'Regulation 400m Track (All-Weather)',
  short_name: '400m Track',
  distance_label: '1600m',
  surface: 'track',
  elevation_gain_ft: 0,
  elevation_loss_ft: 0,
  altitude_ft: 50,
  lat: 39.678,
  lon: -75.75,
  max_incline_pct: 0,
  max_decline_pct: 0,
  description: 'Completely flat all-weather track.',
  profile: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  is_preset: true,
};

const ROAD_5K_COURSE: CoursePreset = {
  course_id: 'run_for_pie_glasgow',
  name: 'Run for Pie 5K — Glasgow Park',
  short_name: 'Run for Pie 5K',
  distance_label: '5K',
  surface: 'road',
  elevation_gain_ft: 55,
  elevation_loss_ft: 55,
  altitude_ft: 70,
  lat: 39.6079,
  lon: -75.7369,
  max_incline_pct: 2.4,
  max_decline_pct: -2.2,
  description: 'Fast, flat loop in Glasgow Park.',
  profile: [65, 68, 74, 82, 85, 78, 71, 66, 68, 65],
  is_preset: true,
};

const BASE_CONDITIONS: CourseConditions = {
  elevation_gain_ft: 0,
  elevation_loss_ft: 0,
  surface: 'track',
  altitude_ft: 50,
  temperature_f: 50,
  humidity_pct: 50,
  wind_mph: 0,
  wind_direction: 'mixed',
  shoe_type: 'streakfly',
  use_readiness: true,
  hrv_status: 'BALANCED',
  sleep_score: 80,
  body_battery: 70,
};

test('Critical Speed & D-Prime fits biologically plausible values from PR efforts', () => {
  const fit = fitCriticalSpeed(EPHRAIM_EFFORTS, { longest_run_miles: 8.91, avg_weekly_miles: 17.1 });

  assert.ok(fit.cs_ms >= 4.0 && fit.cs_ms <= 5.2, `CS (${fit.cs_ms} m/s) should be between 4.0 and 5.2 m/s`);
  assert.ok(fit.d_prime_m >= 100 && fit.d_prime_m <= 450, `D' (${fit.d_prime_m}m) should be between 100m and 450m`);
  assert.ok(fit.r_squared > 0.95, `R^2 (${fit.r_squared}) should be > 0.95`);
  assert.ok(fit.cs_pace_fmt.includes('/mi'), 'Should format CS pace per mile');
});

test('Track Elevation Bug Fix: 0 ft elevation gain or Track surface strictly yields flat 0 ft profile', () => {
  const trackElev = getElevationProfileForCourse(TRACK_COURSE);

  assert.deepEqual(trackElev.profile, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Profile must be flat 0 ft array');
  assert.equal(trackElev.summary, '0 ft min – 0 ft peak (+0 ft climb)', 'Summary must say 0 ft climb');
  assert.equal(trackElev.gain_ft, 0, 'Elevation gain must be 0 ft');

  // Verify prediction engine elevation penalty is strictly 0.0s for track
  const engine = new PhysiologyEngine(EPHRAIM_EFFORTS, 51.7);
  const pred = engine.predict(1600, TRACK_COURSE, BASE_CONDITIONS);

  assert.equal(pred.environmental_adjustments.elevation, 0.0, 'Track elevation adjustment must be strictly 0.0%');
  assert.equal(pred.elevation_summary, '0 ft min – 0 ft peak (+0 ft climb)');
  assert.deepEqual(pred.elevation_profile, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('Dynamic Riegel adjusts fatigue exponent based on weekly volume & profile', () => {
  const lowVol = { longest_run_miles: 5.0, avg_weekly_miles: 15.0 };
  const highVol = { longest_run_miles: 18.0, avg_weekly_miles: 55.0 };

  const bLow = calculateDynamicRiegelExponent(lowVol, 'balanced', 42195);
  const bHigh = calculateDynamicRiegelExponent(highVol, 'balanced', 42195);

  assert.ok(bLow > bHigh, `Low volume b (${bLow}) must be higher than high volume b (${bHigh})`);
  assert.ok(bLow >= 1.08, 'Low volume b should indicate steep marathon fatigue');
  assert.ok(bHigh <= 1.06, 'High volume b should indicate strong aerobic durability');
});

test('4-Model Ensemble generates contributions and lap splits', () => {
  const engine = new PhysiologyEngine(EPHRAIM_EFFORTS, 51.7);
  const pred = engine.predict(STANDARD_METERS['5K'], ROAD_5K_COURSE, {
    ...BASE_CONDITIONS,
    surface: 'road',
    elevation_gain_ft: 55,
  });

  // Verify all 4 models contributed
  assert.ok(pred.models.cs_dprime, "Must include CS + D' model");
  assert.ok(pred.models.daniels_vdot, 'Must include Daniels VDOT model');
  assert.ok(pred.models.dynamic_riegel, 'Must include Dynamic Riegel model');
  assert.ok(pred.models.garmin_vo2_lt, 'Must include Garmin VO2 model');

  // Verify splits
  assert.ok(pred.splits.length >= 3, 'Must have at least 3 splits for 5K');
  const splitTimeSum = pred.splits.reduce((acc, s) => acc + s.segment_time_s, 0);
  assert.ok(
    Math.abs(splitTimeSum - pred.predicted_time_s) < 0.5,
    `Splits sum (${splitTimeSum}s) must equal total predicted time (${pred.predicted_time_s}s)`
  );
});

test('Training Zones derive correctly from Critical Speed', () => {
  const engine = new PhysiologyEngine(EPHRAIM_EFFORTS, 51.7);
  const zones = engine.getTrainingZones();

  assert.ok(zones.z1_recovery.min_pace.includes('/mi'));
  assert.ok(zones.z2_aerobic.min_pace.includes('/mi'));
  assert.ok(zones.z4_threshold_cs.min_pace.includes('/mi'));
  assert.ok(zones.z6_repetition.rep_400m.includes('/ 400m'));
});
