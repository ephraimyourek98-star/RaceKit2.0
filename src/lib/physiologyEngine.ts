/**
 * Advanced Physiological Calculation & Prediction Engine
 *
 * Implements:
 * 1. Critical Speed (CS) & D' (D-Prime) Linear Distance-Time Fit (d = CS * t + D')
 *    with R^2 goodness of fit, physiological guardrails, and Speed vs Endurance profiling.
 * 2. Unified 4-Model Ensemble:
 *    - Model 1: CS + D' (Anaerobic Reserve Model)
 *    - Model 2: Jack Daniels VDOT (Oxygen Cost / %vVO2max)
 *    - Model 3: Dynamic Personalized Riegel (fatigue exponent b adjusted dynamically from volume/durability)
 *    - Model 4: Garmin VO2 Max / Lactate Threshold Anchor
 * 3. Track Elevation Guardrail: 0 ft elevation gain or Track surface strictly yields
 *    a flat 0 ft profile ([0,0,...]), "0 ft min – 0 ft peak (+0 ft climb)", 0% grade, and 0s penalty.
 * 4. Course-aware Splits for 400m through Marathon.
 * 5. Critical Speed Anchored Training Zones (Recovery, Aerobic, Marathon, Threshold, Interval, Repetition).
 */

import type {
  CourseConditions,
  CoursePreset,
  Effort,
  ShoeId,
  SplitStrategy,
  SurfaceType,
  VolumeProfile,
} from './types';

// ── Standard Distances in Meters ───────────────────────────────────────────
export const STANDARD_METERS: Record<string, number> = {
  '400m': 400,
  '800m': 800,
  '1600m': 1600,
  '1 Mile': 1609.344,
  '3K': 3000,
  '2 Mile': 3218.688,
  '5K': 5000,
  '8K': 8000,
  '10K': 10000,
  '15K': 15000,
  '10 Mile': 16093.44,
  'Half Marathon': 21097.5,
  'Marathon': 42195,
};

// ── Types ──────────────────────────────────────────────────────────────────
export type RunnerProfileType = 'speed_oriented' | 'balanced' | 'endurance_oriented';

export interface CriticalSpeedFit {
  cs_ms: number;             // Critical Speed in meters per second
  cs_pace_s: number;         // CS pace in seconds per mile
  cs_pace_fmt: string;       // Formatted pace (e.g. "5:44/mi")
  d_prime_m: number;         // Anaerobic work capacity in meters
  r_squared: number;         // R^2 fit quality (e.g. 0.998)
  profile_type: RunnerProfileType;
  profile_label: string;     // e.g. "Speed-Oriented"
  profile_description: string;
  is_estimated_fallback: boolean;
}

export interface EnsembleContribution {
  model_key: 'cs_dprime' | 'daniels_vdot' | 'dynamic_riegel' | 'garmin_vo2_lt';
  model_label: string;
  time_s: number;
  time_fmt: string;
  weight: number;
  description: string;
}

export interface PhysiologySplit {
  split_index: number;
  label: string;
  distance_m: number;
  segment_distance_m: number;
  segment_time_s: number;
  segment_time_fmt: string;
  cumulative_time_s: number;
  cumulative_time_fmt: string;
  pace_per_mile: string;
  pace_per_km: string;
  elevation_ft: number;
  grade_pct: number;
  tactical_cue: string;
}

export interface AdvancedPhysiologyPrediction {
  distance_m: number;
  distance_label: string;
  predicted_time_s: number;
  predicted_time_fmt: string;
  pace_per_mile: string;
  pace_per_km: string;
  fast_time_s: number;
  fast_time_fmt: string;
  slow_time_s: number;
  slow_time_fmt: string;
  splits: PhysiologySplit[];
  models: Record<string, EnsembleContribution>;
  cs_fit: CriticalSpeedFit;
  effective_vdot: number;
  riegel_b: number;
  readiness_status: 'READY' | 'VOLUME STRETCH' | 'HIGH BONK RISK';
  readiness_note: string;
  volume_penalty_pct: number;
  environmental_adjustments: Record<string, number>;
  net_adjustment_pct: number;
  elevation_profile: number[];
  elevation_summary: string;
}

export interface PhysiologyTrainingZones {
  z1_recovery: { min_pace: string; max_pace: string; description: string };
  z2_aerobic: { min_pace: string; max_pace: string; description: string };
  z3_marathon: { min_pace: string; max_pace: string; description: string };
  z4_threshold_cs: { min_pace: string; max_pace: string; description: string };
  z5_interval: { min_pace: string; max_pace: string; description: string };
  z6_repetition: { min_pace: string; max_pace: string; description: string; rep_400m: string };
}

// ── Time & Pace Utilities ──────────────────────────────────────────────────
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const totalSeconds = Math.round(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatPace(secondsPerMile: number): string {
  if (!Number.isFinite(secondsPerMile) || secondsPerMile <= 0) return '—';
  const totalSeconds = Math.round(secondsPerMile);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}/mi`;
}

export function formatPaceKm(secondsPerKm: number): string {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '—';
  const totalSeconds = Math.round(secondsPerKm);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}/km`;
}

// ── 1. Critical Speed & D' (D-Prime) Linear Regression ──────────────────────
/**
 * Fits the linear distance-time model: d = CS * t + D'
 *
 * Slope = Critical Speed (CS) in m/s
 * Intercept = D' (anaerobic work capacity) in meters
 *
 * Biological boundaries:
 * - CS must lie between 2.5 m/s (10:44/mi) and 6.5 m/s (4:07/mi)
 * - D' must lie between 70m and 600m
 */
export function fitCriticalSpeed(
  efforts: Effort[],
  volume: VolumeProfile = { longest_run_miles: 8.91, avg_weekly_miles: 17.1 }
): CriticalSpeedFit {
  const sorted = [...efforts]
    .filter((e) => e.distance_m >= 350 && e.distance_m <= 15000 && e.time_s >= 45 && e.time_s <= 4000)
    .sort((a, b) => a.distance_m - b.distance_m);

  // If at least 2 distinct efforts exist, perform linear regression
  if (sorted.length >= 2) {
    const n = sorted.length;
    const tValues = sorted.map((e) => e.time_s);
    const dValues = sorted.map((e) => e.distance_m);

    const tMean = tValues.reduce((a, b) => a + b, 0) / n;
    const dMean = dValues.reduce((a, b) => a + b, 0) / n;

    let covTD = 0;
    let varT = 0;
    for (let i = 0; i < n; i++) {
      covTD += (tValues[i] - tMean) * (dValues[i] - dMean);
      varT += (tValues[i] - tMean) ** 2;
    }

    if (varT > 0) {
      let cs = covTD / varT;
      let dPrime = dMean - cs * tMean;

      // Check if fit is biologically plausible
      const isPlausible = cs >= 2.5 && cs <= 6.5 && dPrime >= 70 && dPrime <= 600;

      if (isPlausible) {
        // Compute R^2
        let ssTot = 0;
        let ssRes = 0;
        for (let i = 0; i < n; i++) {
          ssTot += (dValues[i] - dMean) ** 2;
          const dPred = cs * tValues[i] + dPrime;
          ssRes += (dValues[i] - dPred) ** 2;
        }
        const r2 = ssTot > 0 ? Math.max(0, Math.min(1.0, 1 - ssRes / ssTot)) : 0.99;

        return buildCriticalSpeedResult(cs, dPrime, r2, false);
      }
    }
  }

  // Fallback: estimate from best available PR (5K or 1600m/Mile)
  const best5k = sorted.find((e) => Math.abs(e.distance_m - 5000) < 400);
  const bestMile = sorted.find((e) => Math.abs(e.distance_m - 1609.344) < 100);

  let fallbackCs = 4.65; // ~5:46/mi default
  let fallbackDPrime = 240;

  if (best5k && bestMile) {
    const dt = best5k.time_s - bestMile.time_s;
    const dd = best5k.distance_m - bestMile.distance_m;
    fallbackCs = dd / dt;
    fallbackDPrime = Math.max(80, bestMile.distance_m - fallbackCs * bestMile.time_s);
  } else if (best5k) {
    const v5k = 5000 / best5k.time_s;
    // Critical speed is typically 88-90% of 5K velocity for aerobic runners
    const discount = volume.avg_weekly_miles < 25 ? 0.87 : 0.895;
    fallbackCs = v5k * discount;
    fallbackDPrime = 220;
  } else if (bestMile) {
    const vMile = 1609.344 / bestMile.time_s;
    fallbackCs = vMile * 0.82;
    fallbackDPrime = Math.max(80, 1609.344 - fallbackCs * bestMile.time_s);
  } else if (sorted.length > 0) {
    const single = sorted[0];
    const v = single.distance_m / single.time_s;
    fallbackCs = v * 0.85;
    fallbackDPrime = 200;
  }

  return buildCriticalSpeedResult(fallbackCs, fallbackDPrime, 0.985, true);
}

function buildCriticalSpeedResult(
  cs: number,
  dPrime: number,
  r2: number,
  isFallback: boolean
): CriticalSpeedFit {
  const csPaceS = 1609.344 / cs;
  const csPaceFmt = formatPace(csPaceS);

  // Profile classification based on D'
  let profileType: RunnerProfileType = 'balanced';
  let profileLabel = 'Balanced Runner';
  let profileDescription =
    'Even balance of aerobic threshold and anaerobic kick capacity across middle distance and 5K.';

  if (dPrime > 260) {
    profileType = 'speed_oriented';
    profileLabel = 'Speed-Oriented';
    profileDescription =
      'High anaerobic work capacity (D\'). Excels in 400m–1600m with explosive kick reserve and surge tolerance.';
  } else if (dPrime < 190) {
    profileType = 'endurance_oriented';
    profileLabel = 'Endurance-Oriented';
    profileDescription =
      'Aerobic diesel engine. High sustained threshold with lower anaerobic depletion over 10K–Marathon.';
  }

  return {
    cs_ms: Number(cs.toFixed(3)),
    cs_pace_s: Number(csPaceS.toFixed(2)),
    cs_pace_fmt: csPaceFmt,
    d_prime_m: Math.round(dPrime),
    r_squared: Number(r2.toFixed(3)),
    profile_type: profileType,
    profile_label: profileLabel,
    profile_description: profileDescription,
    is_estimated_fallback: isFallback,
  };
}

// ── 2. Daniels VDOT & Oxygen Cost Inversion ────────────────────────────────
export function timeToVdot(timeS: number, distanceM: number): number {
  const tMin = timeS / 60;
  if (tMin <= 0) return 30;
  const vMMin = distanceM / tMin;
  const vo2 = -4.60 + 0.182258 * vMMin + 0.000104 * vMMin * vMMin;
  const pctMax =
    0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
  if (pctMax <= 0) return 30;
  return Number((vo2 / pctMax).toFixed(2));
}

export function vdotToTime(vdot: number, distanceM: number): number {
  let low = 30;
  let high = 25000;
  let mid = 300;

  for (let i = 0; i < 50; i++) {
    mid = (low + high) / 2;
    const vEst = timeToVdot(mid, distanceM);
    if (vEst < vdot) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return mid;
}

// ── 3. Dynamic Personalized Riegel Fatigue Exponent ────────────────────────
/**
 * Calculates a personalized fatigue exponent b for Riegel formula: t2 = t1 * (d2 / d1)^b
 *
 * Base b is 1.06 (standard Peter Riegel model).
 * Dynamically calibrated using:
 * - Weekly volume profile (low volume mpw elevates fatigue exponent)
 * - Longest run durability (prevents overly optimistic half/marathon predictions)
 * - Athlete's speed vs endurance profile (speed-oriented runners experience steeper drop-off)
 */
export function calculateDynamicRiegelExponent(
  volume: VolumeProfile,
  profileType: RunnerProfileType,
  targetDistanceM: number
): number {
  let b = 1.06;

  // Volume adjustment
  const mpw = volume.avg_weekly_miles;
  if (mpw >= 45) {
    b -= 0.012; // High aerobic volume decreases fatigue rate
  } else if (mpw >= 30) {
    b -= 0.005;
  } else if (mpw < 20) {
    b += 0.018; // Low mileage elevates fatigue on long distances
  } else if (mpw < 25) {
    b += 0.009;
  }

  // Distance & Long Run durability adjustment
  const distMi = targetDistanceM / 1609.344;
  const longestMi = volume.longest_run_miles;

  if (distMi > 10.0) {
    const ratio = distMi / Math.max(longestMi, 1.0);
    if (ratio > 1.2) {
      b += Math.min(0.04, (ratio - 1.2) * 0.025);
    }
  }

  // Profile-based adjustment
  if (profileType === 'speed_oriented' && targetDistanceM > 5000) {
    b += 0.014; // Speed-oriented athletes fatigue faster beyond 5K
  } else if (profileType === 'endurance_oriented') {
    b -= 0.008;
  }

  return Number(Math.max(1.045, Math.min(1.12, b)).toFixed(4));
}

// ── 4. Garmin VO2 Max & Lactate Threshold Anchor ───────────────────────────
export function garminVo2ToRaceTime(vo2max: number, distanceM: number): number {
  // Invert Daniels oxygen model directly using watch VO2 Max
  return vdotToTime(vo2max, distanceM);
}

// ── 5. Environmental Modifiers ─────────────────────────────────────────────
export function computeThermalAdjustment(tempF: number, humidityPct: number, distanceM: number): number {
  // Optimal distance running temperature is 48°F - 54°F
  let tempAdj = 0;
  if (tempF > 55) {
    const delta = tempF - 55;
    const distanceFactor = Math.min(1.8, Math.max(0.6, Math.log10(distanceM / 800)));
    tempAdj = Math.min(12, Math.pow(delta / 10, 1.3) * 0.9 * distanceFactor);
  } else if (tempF < 35) {
    const delta = 35 - tempF;
    tempAdj = Math.min(5, (delta / 10) * 0.8);
  }

  // Humidity thermal index adjustment
  let humAdj = 0;
  if (tempF > 60 && humidityPct > 65) {
    humAdj = Math.min(4.0, ((humidityPct - 65) / 10) * 0.5 * ((tempF - 55) / 20));
  }

  return Number((tempAdj + humAdj).toFixed(1));
}

export function computeWindAdjustment(windMph: number, direction: CourseConditions['wind_direction']): number {
  if (windMph <= 2) return 0.0;
  // Minetti aerodynamic drag model: on a loop/mixed track, headwind penalty outweighs tailwind benefit
  if (direction === 'mixed') {
    return Number(Math.min(6.0, Math.pow(windMph / 10, 1.2) * 0.9).toFixed(1));
  }
  if (direction === 'head') {
    return Number(Math.min(10.0, (windMph / 10) * 2.8).toFixed(1));
  }
  if (direction === 'tail') {
    return Number(Math.max(-4.0, -((windMph / 10) * 1.4)).toFixed(1));
  }
  return Number(Math.min(3.0, (windMph / 10) * 0.6).toFixed(1));
}

export function computeShoeAdjustment(shoe: ShoeId, surface: SurfaceType): number {
  const norm = (surface || 'road').toLowerCase().trim();
  if (norm === 'track') {
    const trackMap: Partial<Record<ShoeId, number>> = {
      dragonfly_elite: -3.2,
      victory_2: -3.0,
      dragonfly_track: -2.8,
      fuelcell_sc_ldx: -2.6,
      avanti_tyo: -2.5,
      dragonfly_xc: -2.0,
      rival_xc_7: -1.8,
      streakfly: -1.5,
      vaporfly_next2: -1.2,
      nb_1080: 0.6,
    };
    return trackMap[shoe] ?? -1.5;
  }
  if (surface === 'xc' || surface === 'grass') {
    const xcMap: Partial<Record<ShoeId, number>> = {
      dragonfly_xc: -2.5,
      rival_xc_7: -2.2,
      dragonfly_elite: -1.9,
      dragonfly_track: -1.8,
      fuelcell_sc_ldx: -1.7,
      avanti_tyo: -1.7,
      victory_2: -1.6,
      streakfly: -1.2,
      vaporfly_next2: -0.4,
      nb_1080: 0.8,
    };
    return xcMap[shoe] ?? -1.2;
  }
  // Road
  const roadMap: Partial<Record<ShoeId, number>> = {
    streakfly: -2.0,
    vaporfly_next2: -1.8,
    nb_1080: 0.5,
    dragonfly_xc: 1.5,
    rival_xc_7: 1.5,
    dragonfly_track: 2.0,
    dragonfly_elite: 2.2,
    victory_2: 2.5,
    avanti_tyo: 2.0,
    fuelcell_sc_ldx: 2.0,
  };
  return roadMap[shoe] ?? 0;
}

// ── 6. Track Elevation Profile & Grade Guardrails ──────────────────────────
export function getElevationProfileForCourse(course: CoursePreset): {
  profile: number[];
  summary: string;
  gain_ft: number;
  loss_ft: number;
} {
  const isTrack =
    course.surface === 'track' ||
    course.course_id.includes('track') ||
    course.name.toLowerCase().includes('track');

  // CRITICAL REQUIREMENT: If elevation gain is 0 ft or track surface, profile is flat 0 ft
  if (isTrack || course.elevation_gain_ft === 0) {
    return {
      profile: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      summary: '0 ft min – 0 ft peak (+0 ft climb)',
      gain_ft: 0,
      loss_ft: 0,
    };
  }

  const profile = course.profile && course.profile.length >= 2
    ? course.profile
    : [course.altitude_ft, course.altitude_ft];

  const minE = Math.min(...profile);
  const maxE = Math.max(...profile);
  const climb = Math.max(0, maxE - minE);

  return {
    profile,
    summary: `${Math.round(minE)} ft min – ${Math.round(maxE)} ft peak (+${Math.round(climb)} ft climb)`,
    gain_ft: course.elevation_gain_ft,
    loss_ft: course.elevation_loss_ft,
  };
}

// ── 7. Course-Aware Split Generation ───────────────────────────────────────
export function generateCourseSplits(
  totalTimeS: number,
  distanceM: number,
  course: CoursePreset,
  strategy: SplitStrategy = 'course_gap'
): PhysiologySplit[] {
  const isTrack =
    course.surface === 'track' ||
    course.course_id.includes('track') ||
    course.name.toLowerCase().includes('track') ||
    course.elevation_gain_ft === 0;

  const splits: PhysiologySplit[] = [];
  const distMi = distanceM / 1609.344;

  // Segment distance definition based on race distance
  let segmentDistances: number[] = [];
  let labels: string[] = [];

  if (distanceM <= 800) {
    // 400m / 800m track laps
    const numSplits = distanceM <= 450 ? 2 : 4;
    const segM = distanceM / numSplits;
    for (let i = 1; i <= numSplits; i++) {
      segmentDistances.push(segM);
      labels.push(`${Math.round(segM * i)}m`);
    }
  } else if (distanceM <= 1700) {
    // 1600m / 1 Mile Track Laps (4 x 400m)
    segmentDistances = [400, 400, 400, distanceM - 1200];
    labels = ['Lap 1 (400m)', 'Lap 2 (800m)', 'Lap 3 (1200m)', 'Lap 4 (Finish)'];
  } else if (distanceM <= 5500) {
    // 5K: Mile 1, Mile 2, Mile 3, Final 0.1 mi
    const m1 = 1609.344;
    const m2 = 1609.344;
    const m3 = 1609.344;
    const rem = distanceM - (m1 + m2 + m3);
    segmentDistances = [m1, m2, m3, Math.max(rem, 50)];
    labels = ['Mile 1', 'Mile 2', 'Mile 3', 'Final Kick (0.1 mi)'];
  } else if (distanceM <= 11000) {
    // 10K: 6 x 1 Mile + Final 0.2 mi
    const fullMiles = Math.floor(distMi);
    for (let i = 1; i <= fullMiles; i++) {
      segmentDistances.push(1609.344);
      labels.push(`Mile ${i}`);
    }
    const rem = distanceM - fullMiles * 1609.344;
    if (rem > 50) {
      segmentDistances.push(rem);
      labels.push(`Finish (${(rem / 1609.344).toFixed(2)} mi)`);
    }
  } else {
    // Half Marathon or Marathon: 5K checkpoints
    const num5k = Math.floor(distanceM / 5000);
    for (let i = 1; i <= num5k; i++) {
      segmentDistances.push(5000);
      labels.push(`${i * 5}K`);
    }
    const rem = distanceM - num5k * 5000;
    if (rem > 100) {
      segmentDistances.push(rem);
      labels.push(`Finish (${(rem / 1609.344).toFixed(1)} mi)`);
    }
  }

  // Calculate base split times
  const basePaceSPerM = totalTimeS / distanceM;
  let cumTimeS = 0;

  for (let i = 0; i < segmentDistances.length; i++) {
    const segM = segmentDistances[i];
    let segTimeS = segM * basePaceSPerM;

    // Apply strategy pacing curve
    if (strategy === 'negative') {
      const progress = i / (segmentDistances.length - 1 || 1);
      const factor = 1.015 - progress * 0.03; // ~3% negative split
      segTimeS *= factor;
    }

    cumTimeS += segTimeS;
    const segDistMi = segM / 1609.344;
    const segPacePerMi = segTimeS / segDistMi;
    const segPacePerKm = segTimeS / (segM / 1000);

    let cue = 'Settle into rhythm and hold steady cadence.';
    if (isTrack) {
      if (i === 0) cue = 'Smooth clean start; settle into inside rail on lane 1.';
      else if (i === segmentDistances.length - 1) cue = 'Final turn kick — open stride and drive arms.';
      else cue = 'Maintain rhythm and relaxed shoulders along backstretch.';
    } else {
      if (i === 0) cue = 'Controlled start without early anaerobic spiking.';
      else if (i === segmentDistances.length - 1) cue = 'Empty the anaerobic reserve (D\') through the finish.';
    }

    splits.push({
      split_index: i + 1,
      label: labels[i] || `Split ${i + 1}`,
      distance_m: Number(segM.toFixed(1)),
      segment_distance_m: Number(segM.toFixed(1)),
      segment_time_s: Number(segTimeS.toFixed(2)),
      segment_time_fmt: formatTime(segTimeS),
      cumulative_time_s: Number(cumTimeS.toFixed(2)),
      cumulative_time_fmt: formatTime(cumTimeS),
      pace_per_mile: formatPace(segPacePerMi),
      pace_per_km: formatPaceKm(segPacePerKm),
      elevation_ft: isTrack ? 0 : Math.round(course.elevation_gain_ft / segmentDistances.length),
      grade_pct: isTrack ? 0.0 : 0.4,
      tactical_cue: cue,
    });
  }

  // Normalize split times strictly so cumulative sum matches totalTimeS
  const rawSum = splits.reduce((acc, s) => acc + s.segment_time_s, 0);
  if (rawSum > 0 && Math.abs(rawSum - totalTimeS) > 0.1) {
    const scale = totalTimeS / rawSum;
    let runningCum = 0;
    for (const s of splits) {
      s.segment_time_s = Number((s.segment_time_s * scale).toFixed(2));
      s.segment_time_fmt = formatTime(s.segment_time_s);
      runningCum += s.segment_time_s;
      s.cumulative_time_s = Number(runningCum.toFixed(2));
      s.cumulative_time_fmt = formatTime(runningCum);
      const segMi = s.segment_distance_m / 1609.344;
      s.pace_per_mile = formatPace(s.segment_time_s / segMi);
    }
  }

  return splits;
}

// ── 8. Unified Physiology Engine Class ─────────────────────────────────────
export class PhysiologyEngine {
  private efforts: Effort[];
  private volume: VolumeProfile;
  private vo2max: number | null;
  public csFit: CriticalSpeedFit;
  public effectiveVdot: number;

  constructor(
    efforts: Effort[],
    vo2max: number | null = null,
    volume: VolumeProfile = { longest_run_miles: 8.91, avg_weekly_miles: 17.1 }
  ) {
    this.efforts = [...efforts].sort((a, b) => a.distance_m - b.distance_m);
    this.volume = volume;
    this.vo2max = vo2max;

    this.csFit = fitCriticalSpeed(this.efforts, this.volume);

    // Compute effective VDOT from PRs
    const vdots = this.efforts
      .map((e) => timeToVdot(e.time_s, e.distance_m))
      .filter((v) => Number.isFinite(v) && v > 20);

    if (vdots.length > 0) {
      this.effectiveVdot = Math.max(...vdots);
    } else if (vo2max && vo2max > 25) {
      this.effectiveVdot = vo2max;
    } else {
      this.effectiveVdot = 51.7;
    }
  }

  /**
   * Run the 4-Model Ensemble to predict race time
   */
  public predict(
    distanceM: number,
    course: CoursePreset,
    conditions: CourseConditions
  ): AdvancedPhysiologyPrediction {
    const isTrack =
      course.surface === 'track' ||
      course.course_id.includes('track') ||
      course.name.toLowerCase().includes('track') ||
      course.elevation_gain_ft === 0;

    // ── Model 1: CS + D' (Anaerobic Reserve Model) ─────────────────────────
    // Formula: t = (d - D') / CS
    let csTimeS: number;
    if (distanceM <= this.csFit.d_prime_m) {
      // Sprint distance: velocity capped at 115% CS
      csTimeS = distanceM / (this.csFit.cs_ms * 1.15);
    } else {
      csTimeS = (distanceM - this.csFit.d_prime_m) / this.csFit.cs_ms;
    }

    // ── Model 2: Jack Daniels VDOT ─────────────────────────────────────────
    const danielsTimeS = vdotToTime(this.effectiveVdot, distanceM);

    // ── Model 3: Dynamic Personalized Riegel ───────────────────────────────
    const bDynamic = calculateDynamicRiegelExponent(
      this.volume,
      this.csFit.profile_type,
      distanceM
    );

    // Anchor on best reference effort (Mile or 5K)
    const refEffort =
      this.efforts.find((e) => Math.abs(e.distance_m - 1609.344) < 50) ||
      this.efforts.find((e) => Math.abs(e.distance_m - 5000) < 300) ||
      this.efforts[0] || { distance_m: 1609.344, time_s: 318.88 };

    const riegelTimeS = refEffort.time_s * Math.pow(distanceM / refEffort.distance_m, bDynamic);

    // ── Model 4: Garmin VO2 Max / LT Anchor ────────────────────────────────
    const garminVo2 = this.vo2max ?? this.effectiveVdot;
    const garminTimeS = garminVo2ToRaceTime(garminVo2, distanceM);

    // ── Ensemble Blending Weights ──────────────────────────────────────────
    let wCs = 0.30;
    let wDaniels = 0.35;
    let wRiegel = 0.25;
    let wGarmin = 0.10;

    if (distanceM <= 1000) {
      wCs = 0.45;
      wDaniels = 0.30;
      wRiegel = 0.15;
      wGarmin = 0.10;
    } else if (distanceM <= 1700) {
      wCs = 0.40;
      wDaniels = 0.30;
      wRiegel = 0.20;
      wGarmin = 0.10;
    } else if (distanceM >= 20000) {
      // Half Marathon & Marathon: Riegel & Daniels dominant
      wCs = distanceM >= 40000 ? 0.05 : 0.12;
      wDaniels = 0.40;
      wRiegel = distanceM >= 40000 ? 0.45 : 0.38;
      wGarmin = 0.10;
    }

    const totalW = wCs + wDaniels + wRiegel + wGarmin;
    const theoreticalS =
      (csTimeS * wCs + danielsTimeS * wDaniels + riegelTimeS * wRiegel + garminTimeS * wGarmin) /
      totalW;

    // ── Volume & Durability Aerobic Fade ───────────────────────────────────
    const distMi = distanceM / 1609.344;
    const longestMi = this.volume.longest_run_miles;
    const weeklyMi = this.volume.avg_weekly_miles;
    const ratio = distMi / Math.max(longestMi, 1.0);

    const longPenalty = ratio > 1.05 ? Math.min(35, 14 * Math.pow(ratio - 1.0, 1.35)) : 0;
    const targetMpw = distMi <= 3.1 ? 15 : distMi <= 6.2 ? 25 : distMi <= 13.1 ? 35 : 50;
    const volPenalty =
      weeklyMi < targetMpw && distMi > 5.0
        ? Math.min(22, ((targetMpw - weeklyMi) / targetMpw) * 20 * (distMi / 26.2))
        : 0;

    const volumePenaltyPct = Number((longPenalty + volPenalty).toFixed(1));
    const realisticS = theoreticalS * (1 + volumePenaltyPct / 100);

    // Readiness note
    let readinessStatus: AdvancedPhysiologyPrediction['readiness_status'] = 'READY';
    let readinessNote = 'Fully supported by current weekly volume and long run base.';
    if (ratio > 1.6 || (distMi > 14.0 && weeklyMi < 30)) {
      readinessStatus = 'HIGH BONK RISK';
      readinessNote = `Aerobic base deficit: race distance (${distMi.toFixed(1)} mi) far exceeds longest run (${longestMi.toFixed(1)} mi) on ${weeklyMi.toFixed(0)} mpw. Severe glycogen depletion expected.`;
    } else if (ratio > 1.05 && distMi > 6.0) {
      readinessStatus = 'VOLUME STRETCH';
      readinessNote = `Distance (${distMi.toFixed(1)} mi) exceeds longest training run (${longestMi.toFixed(1)} mi). Late aerobic fade expected.`;
    }

    // ── Environmental & Course Modifiers ───────────────────────────────────
    const adjustments: Record<string, number> = {};

    adjustments.temperature = computeThermalAdjustment(
      conditions.temperature_f,
      conditions.humidity_pct,
      distanceM
    );
    adjustments.wind = computeWindAdjustment(conditions.wind_mph, conditions.wind_direction);
    adjustments.shoes = computeShoeAdjustment(conditions.shoe_type, course.surface);

    // CRITICAL REQUIREMENT: If track or 0 ft gain, elevation penalty is strictly 0.0s (0.0%)
    if (isTrack || course.elevation_gain_ft === 0) {
      adjustments.elevation = 0.0;
    } else {
      const gainM = course.elevation_gain_ft * 0.3048;
      const lossM = course.elevation_loss_ft * 0.3048;
      const distFactor = Math.pow(5000 / distanceM, 0.4);
      const climbCost = (gainM / 100) * 3.6;
      const descentRecovery = (lossM / 100) * 1.8;
      adjustments.elevation = Number(Math.max(0, (climbCost - descentRecovery) * distFactor).toFixed(1));
    }

    // Surface
    if (course.surface === 'track') adjustments.surface = -0.5;
    else if (course.surface === 'xc') adjustments.surface = 3.6;
    else if (course.surface === 'grass') adjustments.surface = 3.0;
    else if (course.surface === 'trail') adjustments.surface = 4.2;
    else adjustments.surface = 0.0;

    // Readiness derating
    if (conditions.use_readiness) {
      let rAdj = 0;
      if (conditions.hrv_status === 'LOW' || conditions.hrv_status === 'UNBALANCED') rAdj += 0.8;
      if (conditions.sleep_score < 60) rAdj += 0.5;
      if (conditions.body_battery < 50) rAdj += 0.4;
      if (rAdj > 0) adjustments.readiness = Number(Math.min(2.0, rAdj).toFixed(1));
    }

    const netAdjustmentPct = Number(
      Object.values(adjustments)
        .reduce((a, b) => a + b, 0)
        .toFixed(1)
    );
    const finalTimeS = realisticS * (1 + netAdjustmentPct / 100);

    const margin = 0.02; // ±2% confidence interval
    const fastTimeS = finalTimeS * (1 - margin);
    const slowTimeS = finalTimeS * (1 + margin);

    const pacePerMiS = finalTimeS / distMi;
    const pacePerKmS = finalTimeS / (distanceM / 1000);

    const elevData = getElevationProfileForCourse(course);
    const splits = generateCourseSplits(finalTimeS, distanceM, course, 'course_gap');

    return {
      distance_m: distanceM,
      distance_label: course.distance_label || `${Math.round(distMi * 10) / 10} mi`,
      predicted_time_s: Number(finalTimeS.toFixed(2)),
      predicted_time_fmt: formatTime(finalTimeS),
      pace_per_mile: formatPace(pacePerMiS),
      pace_per_km: formatPaceKm(pacePerKmS),
      fast_time_s: Number(fastTimeS.toFixed(2)),
      fast_time_fmt: formatTime(fastTimeS),
      slow_time_s: Number(slowTimeS.toFixed(2)),
      slow_time_fmt: formatTime(slowTimeS),
      splits,
      models: {
        cs_dprime: {
          model_key: 'cs_dprime',
          model_label: "Critical Speed + D'",
          time_s: Number(csTimeS.toFixed(2)),
          time_fmt: formatTime(csTimeS),
          weight: Number((wCs / totalW).toFixed(3)),
          description: `Linear anaerobic work capacity model (CS: ${this.csFit.cs_pace_fmt}, D': ${this.csFit.d_prime_m}m).`,
        },
        daniels_vdot: {
          model_key: 'daniels_vdot',
          model_label: 'Jack Daniels VDOT',
          time_s: Number(danielsTimeS.toFixed(2)),
          time_fmt: formatTime(danielsTimeS),
          weight: Number((wDaniels / totalW).toFixed(3)),
          description: `Oxygen cost & %vVO2max model (effective VDOT: ${this.effectiveVdot.toFixed(1)}).`,
        },
        dynamic_riegel: {
          model_key: 'dynamic_riegel',
          model_label: 'Dynamic Riegel',
          time_s: Number(riegelTimeS.toFixed(2)),
          time_fmt: formatTime(riegelTimeS),
          weight: Number((wRiegel / totalW).toFixed(3)),
          description: `Personalized fatigue curve (exponent b = ${bDynamic.toFixed(3)}).`,
        },
        garmin_vo2_lt: {
          model_key: 'garmin_vo2_lt',
          model_label: 'Garmin VO2 Max / LT',
          time_s: Number(garminTimeS.toFixed(2)),
          time_fmt: formatTime(garminTimeS),
          weight: Number((wGarmin / totalW).toFixed(3)),
          description: `Watch physiological telemetry anchor (${garminVo2.toFixed(1)} VO2 Max).`,
        },
      },
      cs_fit: this.csFit,
      effective_vdot: this.effectiveVdot,
      riegel_b: bDynamic,
      readiness_status: readinessStatus,
      readiness_note: readinessNote,
      volume_penalty_pct: volumePenaltyPct,
      environmental_adjustments: adjustments,
      net_adjustment_pct: netAdjustmentPct,
      elevation_profile: elevData.profile,
      elevation_summary: elevData.summary,
    };
  }

  /**
   * Derive Critical Speed anchored training zones
   */
  public getTrainingZones(): PhysiologyTrainingZones {
    const csPaceS = this.csFit.cs_pace_s;

    // Zone 1: Recovery (< 72% CS)
    const z1Fast = csPaceS / 0.72;
    const z1Slow = csPaceS / 0.65;

    // Zone 2: Aerobic Base (72% - 82% CS)
    const z2Fast = csPaceS / 0.82;
    const z2Slow = csPaceS / 0.72;

    // Zone 3: Marathon / Steady (82% - 90% CS)
    const z3Fast = csPaceS / 0.90;
    const z3Slow = csPaceS / 0.82;

    // Zone 4: Threshold / Critical Speed (90% - 100% CS)
    const z4Fast = csPaceS;
    const z4Slow = csPaceS / 0.90;

    // Zone 5: Interval / VO2 Max (100% - 110% CS)
    const z5Fast = csPaceS / 1.10;
    const z5Slow = csPaceS;

    // Zone 6: Repetition / Anaerobic (> 110% CS)
    const z6Fast = csPaceS / 1.25;
    const z6Slow = csPaceS / 1.10;
    const rep400mS = (z6Fast / 1609.344) * 400;

    return {
      z1_recovery: {
        min_pace: formatPace(z1Fast),
        max_pace: formatPace(z1Slow),
        description: 'Active recovery and flushing runs; keeps blood flowing without fatigue.',
      },
      z2_aerobic: {
        min_pace: formatPace(z2Fast),
        max_pace: formatPace(z2Slow),
        description: 'Conversational aerobic base building; drives mitochondrial biogenesis.',
      },
      z3_marathon: {
        min_pace: formatPace(z3Fast),
        max_pace: formatPace(z3Slow),
        description: 'Steady aerobic tempo; optimizes fat oxidation and carbohydrate sparing.',
      },
      z4_threshold_cs: {
        min_pace: formatPace(z4Fast),
        max_pace: formatPace(z4Slow),
        description: 'Critical Speed / Lactate balance threshold; maximum sustainable pace.',
      },
      z5_interval: {
        min_pace: formatPace(z5Fast),
        max_pace: formatPace(z5Slow),
        description: 'VO2 Max intervals (3–5 min bouts); maximizes maximal stroke volume.',
      },
      z6_repetition: {
        min_pace: formatPace(z6Fast),
        max_pace: formatPace(z6Slow),
        description: 'Anaerobic power and neuromuscular speed; full recovery between reps.',
        rep_400m: `${Math.round(rep400mS)}s / 400m`,
      },
    };
  }
}
