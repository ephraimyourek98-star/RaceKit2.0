import test from 'node:test';
import assert from 'node:assert/strict';
import { PredictionEngine, formatTime } from './predictionEngine';
import { VERIFIED_PR_EFFORTS } from './seedData';
import type { CourseConditions } from './types';

const BASE_CONDITIONS: CourseConditions = {
  elevation_gain_ft: 0,
  elevation_loss_ft: 0,
  surface: 'road',
  altitude_ft: 0,
  temperature_f: 50,
  humidity_pct: 50,
  wind_mph: 0,
  wind_direction: 'head',
  shoe_type: 'streakfly',
  use_readiness: false,
  hrv_status: 'BALANCED',
  sleep_score: 77,
  body_battery: 68,
};

test('PredictionEngine fits Critical Speed, D-prime, and VDOT from Ephraim efforts', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2, {
    longest_run_miles: 8.91,
    avg_weekly_miles: 17.1,
  });
  const metrics = engine.getFitnessMetrics();
  assert.ok(metrics.critical_speed_mps && metrics.critical_speed_mps > 3.5);
  assert.ok(metrics.d_prime_m && metrics.d_prime_m > 50);
  assert.ok(metrics.vo2max && metrics.vo2max > 50);
});

test('1600m prediction scales strictly from 1 Mile distance ratio', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2);
  const mile = engine.predictBase(1609.344, 'Mile');
  const m1600 = engine.predictBase(1600, '1600m');
  const expected = mile.time_s * (1600 / 1609.344);
  assert.ok(Math.abs(m1600.time_s - expected) < 0.05);
});

test('Volume durability flags 5K as READY and Marathon as HIGH BONK RISK on 17 mpw', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2, {
    longest_run_miles: 8.91,
    avg_weekly_miles: 17.1,
  });
  const pred5k = engine.predict('5K', BASE_CONDITIONS);
  const predMarathon = engine.predict('Marathon', BASE_CONDITIONS);
  assert.equal(pred5k.readiness_status, 'READY');
  assert.equal(pred5k.volume_penalty_pct, 0);
  assert.equal(predMarathon.readiness_status, 'HIGH BONK RISK');
  assert.ok(predMarathon.volume_penalty_pct > 25);
});

test('Shoe Rotation Matrix ranks Streakfly #1 on Road and Dragonfly XC #1 on XC grass', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2);
  const roadMatrix = engine.compareShoes('5K', { ...BASE_CONDITIONS, surface: 'road' });
  assert.equal(roadMatrix[0].shoe_id, 'streakfly');
  assert.equal(roadMatrix[0].tag, 'OPTIMAL');
  const spikeOnRoad = roadMatrix.find((s) => s.shoe_id === 'dragonfly_xc');
  assert.equal(spikeOnRoad?.tag, 'SURFACE HAZARD');

  const xcMatrix = engine.compareShoes('5K', { ...BASE_CONDITIONS, surface: 'xc' });
  assert.equal(xcMatrix[0].shoe_id, 'dragonfly_xc');
  assert.equal(xcMatrix[0].tag, 'OPTIMAL');
});

test('Course-aware splits sum strictly to total predicted race time', () => {
  const engine = new PredictionEngine(VERIFIED_PR_EFFORTS, 53.2);
  const pred = engine.predict('5K', {
    ...BASE_CONDITIONS,
    surface: 'xc',
    shoe_type: 'dragonfly_xc',
    elevation_gain_ft: 380,
    elevation_loss_ft: 380,
  });
  const splits = engine.generateSplits(pred, 'course_gap', [180, 230, 310, 410, 310, 240, 350, 280, 220, 180]);
  assert.equal(splits.length, 4); // 3 miles + final 0.11 mi kick
  const lastCum = splits[splits.length - 1].cumulative_time_s;
  assert.ok(Math.abs(lastCum - pred.time_s) < 0.1);
  assert.equal(formatTime(318.88), '5:18.9');
});
