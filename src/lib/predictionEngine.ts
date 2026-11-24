import { ATHLETE_PROFILE, SHOE_DATABASE } from './seedData';
import type {
  CourseConditions,
  Effort,
  FitnessMetrics,
  HrvStatus,
  ModelContribution,
  RacePrediction,
  RaceSplit,
  ShoeComparison,
  ShoeId,
  SplitStrategy,
  SurfaceType,
  TrainingZones,
  VolumeProfile,
  WindDirection,
} from './types';

export const STANDARD_DISTANCES: Record<string, number> = {
  '400m': 400,
  '800m': 800,
  '1000m': 1000,
  '1500m': 1500,
  '1600m': 1600,
  '1 Mile': 1609.344,
  Mile: 1609.344,
  '3000m': 3000,
  '3200m': 3200,
  '2 Mile': 3218.688,
  '5K': 5000,
  '10K': 10000,
  '15K': 15000,
  'Half Marathon': 21097.5,
  Marathon: 42195,
};

export const PRIMARY_DISTANCES = [
  '800m',
  '1500m',
  '1600m',
  '1 Mile',
  '3000m',
  '3200m',
  '5K',
  '10K',
  'Half Marathon',
  'Marathon',
];

export const ROTATION_SHOES: ShoeId[] = [
  'dragonfly_track',
  'dragonfly_elite',
  'victory_2',
  'avanti_tyo',
  'fuelcell_sc_ldx',
  'dragonfly_xc',
  'rival_xc_7',
  'streakfly',
  'vaporfly_next2',
  'nb_1080',
];

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function formatPace(secPerMile: number | null | undefined): string {
  if (secPerMile == null || !Number.isFinite(secPerMile) || secPerMile <= 0) return '—';
  let m = Math.floor(secPerMile / 60);
  let s = Math.round(secPerMile % 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

// ── Condition Adjustment Functions (% change: + slower, - faster) ──────────

export function temperatureAdjustment(tempF: number, distanceM: number): number {
  // Optimal distance running temperature window is 40°F–55°F (0.0% penalty)
  if (tempF >= 40 && tempF <= 55) {
    return 0.0;
  }
  if (tempF < 40) {
    // Cool/cold temps (30°F–39°F) carry minimal penalty: ~0.1%–0.3% (+1–4s on 5K, not +10s)
    if (tempF < 20) {
      return 0.5 + (20 - tempF) * 0.06;
    }
    return (40 - tempF) * 0.025; // at 32°F: (40-32)*0.025 = +0.20%
  }
  // Warm/Hot conditions (>55°F)
  const excess = tempF - 55;
  const baseRate =
    distanceM <= 1650
      ? 0.06
      : distanceM <= 5000
        ? 0.08
        : distanceM <= 10000
          ? 0.14
          : distanceM <= 21097
            ? 0.22
            : 0.30;
  const linearPenalty = excess * baseRate;
  const extremeHeat = Math.max(0, tempF - 80);
  const nonLinearPenalty = 0.015 * extremeHeat * extremeHeat * (distanceM <= 5000 ? 1.0 : 1.2);
  return linearPenalty + nonLinearPenalty;
}

export function humidityAdjustment(humidityPct: number, tempF: number): number {
  // High humidity does NOT impair cooling below 60°F (evaporation is not heat-limiting in cold air)
  if (tempF < 60 || humidityPct < 50) return 0.0;
  const excessHumid = humidityPct - 50;
  const excessTemp = tempF - 60;
  const baseInter = excessHumid * excessTemp * 0.0018;
  if (tempF > 80 && humidityPct > 70) {
    const surge = ((tempF - 80) / 20) * ((humidityPct - 70) / 30) * 5.0;
    return baseInter + surge;
  }
  return baseInter;
}

export function windAdjustment(windMph: number, direction: WindDirection): number {
  if (windMph < 2) return 0.0;
  if (direction === 'head') {
    // Pure headwind capped and scaled realistically (~1.5%–2.8% for 15–22 mph)
    return Math.min(0.08 * windMph + 0.0018 * windMph * windMph, 4.5);
  }
  if (direction === 'tail') {
    // Tailwind benefit (-0.5% to -1.2%)
    return Math.max(-(0.035 * windMph + 0.0004 * windMph * windMph), -1.5);
  }
  if (direction === 'cross') {
    return 0.03 * windMph + 0.0008 * windMph * windMph;
  }
  // Loop / Out-and-Back (Mixed): headwind is partially offset by tailwind/sheltered segments
  // (+0.3% to +1.0% for 15–22 mph, e.g. ~3–11s on 18:30 5K)
  return 0.025 * windMph + 0.0007 * windMph * windMph;
}

export function elevationAdjustment(
  gainFt: number,
  lossFt: number | null | undefined,
  distanceM: number,
  surface?: SurfaceType
): number {
  if (distanceM <= 0) return 0.0;
  if (surface === 'track' || (gainFt <= 0 && (!lossFt || lossFt <= 0))) return 0.0;
  const gainM = gainFt * 0.3048;
  const lossM = (lossFt ?? gainFt) * 0.3048;
  const distanceFactor = Math.pow(5000 / distanceM, 0.4);
  const climbPenalty = (gainM / 100) * 3.6;
  const descentRecovery = (lossM / 100) * 1.9;
  const lossPerKm = lossM / (distanceM / 1000);
  const brakingPenalty = lossPerKm > 25 ? Math.min((lossPerKm - 25) * 0.02, 1.2) : 0;
  return Math.max((climbPenalty - descentRecovery + brakingPenalty) * distanceFactor, -4.5);
}

export function surfaceAdjustment(surface: SurfaceType): number {
  const penalties: Record<SurfaceType, number> = {
    track: -0.5,
    road: 0.0,
    treadmill: -1.0,
    grass: 3.0,
    xc: 3.6,
    trail: 4.5,
    gravel: 2.5,
  };
  return penalties[surface] ?? 0.0;
}

export function normalizeSurface(surface: string | undefined | null): SurfaceType {
  const s = String(surface ?? '').toLowerCase().trim();
  if (s.includes('track')) return 'track';
  if (s.includes('xc') || s.includes('cross') || s.includes('grass')) return 'xc';
  if (s.includes('trail')) return 'trail';
  if (s.includes('gravel')) return 'gravel';
  if (s.includes('treadmill')) return 'treadmill';
  return 'road';
}

export function shoeAdjustment(shoe: ShoeId, surface: SurfaceType): number {
  const norm = normalizeSurface(surface);
  if (norm === 'track') {
    const map: Record<string, number> = {
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
    return map[shoe] ?? -1.5;
  }
  if (norm === 'xc' || norm === 'grass') {
    const map: Record<string, number> = {
      dragonfly_xc: -2.5,
      rival_xc_7: -2.2,
      dragonfly_elite: -1.9,
      dragonfly_track: -1.8,
      fuelcell_sc_ldx: -1.7,
      avanti_tyo: -1.7,
      victory_2: -1.6,
      streakfly: -1.2,
      vaporfly_next2: -0.4,
      nb_1080: 0.6,
    };
    return map[shoe] ?? -1.2;
  }
  if (norm === 'trail' || norm === 'gravel') {
    const map: Record<string, number> = {
      dragonfly_xc: -1.0,
      rival_xc_7: -1.0,
      streakfly: -0.5,
      vaporfly_next2: -0.2,
      nb_1080: 0.4,
      dragonfly_track: 1.2,
      dragonfly_elite: 1.2,
      victory_2: 1.5,
      avanti_tyo: 1.2,
      fuelcell_sc_ldx: 1.2,
    };
    return map[shoe] ?? 0;
  }
  // Road / asphalt / treadmill default
  // Racing shoes & road super-shoes provide ~1.5%–1.8% economy benefit over daily trainers
  // Metal pin spikes on asphalt road have a 2.0%–3.0% hazard/braking penalty
  const map: Record<string, number> = {
    streakfly: -1.8,
    vaporfly_next2: -1.6,
    nb_1080: 0.2,
    dragonfly_xc: 2.0,
    rival_xc_7: 2.0,
    dragonfly_track: 2.5,
    dragonfly_elite: 2.8,
    victory_2: 3.0,
    avanti_tyo: 2.5,
    fuelcell_sc_ldx: 2.5,
  };
  return map[shoe] ?? 0;
}

export function altitudeAdjustment(altitudeFt: number, distanceM: number): number {
  const altitudeM = altitudeFt * 0.3048;
  if (altitudeM < 500) return 0.0;
  const penaltyPer1000 = altitudeM < 1500 ? 2.0 : altitudeM < 2500 ? 4.0 : 6.5;
  const base = ((altitudeM - 500) / 1000) * penaltyPer1000;
  const factor = distanceM > 21000 ? 1.4 : distanceM > 10000 ? 1.2 : 1.0;
  return base * factor;
}

export function readinessAdjustment(
  hrvStatus: HrvStatus,
  sleepScore: number | null | undefined,
  bodyBattery: number | null | undefined
): number {
  let total = 0;
  const hrvPenalties: Record<HrvStatus, number> = {
    BALANCED: 0.0,
    LOW: 0.6,
    UNBALANCED: 0.8,
    POOR: 1.2,
  };
  total += hrvPenalties[hrvStatus] ?? 0.0;

  if (sleepScore != null) {
    if (sleepScore >= 80) total -= 0.2;
    else if (sleepScore < 40) total += 0.8;
    else if (sleepScore < 60) total += 0.5;
  }

  if (bodyBattery != null) {
    if (bodyBattery >= 80) total -= 0.2;
    else if (bodyBattery < 25) total += 0.8;
    else if (bodyBattery < 50) total += 0.4;
    else if (bodyBattery < 65) total += 0.1;
  }
  // Realistic readiness derating capped strictly to [0.0%, 2.0%]
  return Math.max(0.0, Math.min(2.0, Number(total.toFixed(1))));
}

// ── Multi-Model Ensemble Prediction Engine ─────────────────────────────────

export class PredictionEngine {
  efforts: Effort[];
  vo2max: number | null;
  recencyHalflifeDays: number;
  volume: VolumeProfile;

  cs: number | null = null;
  dPrime: number | null = null;
  csR2: number | null = null;
  bMileTo5k: number | null = null;
  mileEffort: Effort | null = null;
  fiveKEffort: Effort | null = null;
  effectiveVdot: number | null = null;
  vdotSource: 'race_pr' | 'garmin_race_prediction' | 'garmin_vo2max' | null = null;
  garminPredictions: { time_5k_s?: number | null; time_10k_s?: number | null } | null = null;

  constructor(
    efforts: Effort[],
    vo2max: number | null = null,
    volume: VolumeProfile = { longest_run_miles: 8.91, avg_weekly_miles: 17.1 },
    recencyHalflifeDays = 60,
    garminPredictions: { time_5k_s?: number | null; time_10k_s?: number | null } | null = null
  ) {
    this.garminPredictions = garminPredictions;
    this.efforts = [...efforts].sort((a, b) => a.distance_m - b.distance_m);
    this.vo2max = vo2max;
    this.volume = volume;
    this.recencyHalflifeDays = recencyHalflifeDays;
    this.fitModels();
    this.resolveVdot();
  }

  private recencyWeight(dateStr: string): number {
    const parsed = Date.parse(dateStr);
    if (Number.isNaN(parsed)) return 0.5;
    const daysAgo = Math.max(0, (Date.now() - parsed) / 86_400_000);
    return Math.pow(2, -daysAgo / this.recencyHalflifeDays);
  }

  private fitModels() {
    if (!this.efforts.length) return;

    for (const e of this.efforts) {
      if (Math.abs(e.distance_m - 1609.344) < 100 || e.label.toLowerCase().includes('mile')) {
        if (!this.mileEffort || e.time_s < this.mileEffort.time_s) {
          this.mileEffort = e;
        }
      } else if (Math.abs(e.distance_m - 5000) < 100 || e.label.toLowerCase().includes('5k')) {
        if (!this.fiveKEffort || e.time_s < this.fiveKEffort.time_s) {
          this.fiveKEffort = e;
        }
      }
    }

    if (this.mileEffort && this.fiveKEffort) {
      this.bMileTo5k =
        Math.log(this.fiveKEffort.time_s / this.mileEffort.time_s) /
        Math.log(this.fiveKEffort.distance_m / this.mileEffort.distance_m);
    } else if (this.efforts.length >= 2) {
      const e1 = this.efforts[0];
      const e2 = this.efforts[this.efforts.length - 1];
      this.bMileTo5k =
        Math.log(e2.time_s / e1.time_s) / Math.log(e2.distance_m / e1.distance_m);
    } else {
      this.bMileTo5k = 1.08;
    }

    // Fit Critical Speed (CS) and D-prime ONLY from verified race distances >= 1500m (Mile, 5K, 10K)
    // Never fit CS or D-prime from short track intervals/sprints (< 1500m)
    let csEfforts = this.efforts.filter(
      (e) => e.distance_m >= 1500 && e.distance_m <= 12000 && e.time_s >= 240 && e.time_s <= 3600
    );
    if (csEfforts.length < 2) {
      csEfforts = this.efforts.filter((e) => e.distance_m >= 1500);
    }

    if (csEfforts.length >= 2) {
      const weights = csEfforts.map((e) => this.recencyWeight(e.date));
      const wSum = weights.reduce((acc, w) => acc + w, 0);
      const tBar = csEfforts.reduce((acc, e, i) => acc + weights[i] * e.time_s, 0) / wSum;
      const dBar = csEfforts.reduce((acc, e, i) => acc + weights[i] * e.distance_m, 0) / wSum;

      const covTd = csEfforts.reduce(
        (acc, e, i) => acc + weights[i] * (e.time_s - tBar) * (e.distance_m - dBar),
        0
      );
      const varT = csEfforts.reduce(
        (acc, e, i) => acc + weights[i] * (e.time_s - tBar) ** 2,
        0
      );

      if (varT > 0) {
        let cs = covTd / varT;
        let dPrime = dBar - cs * tBar;

        if (this.fiveKEffort) {
          const v5k = this.fiveKEffort.distance_m / this.fiveKEffort.time_s;
          const maxSustainableCs = v5k * (this.volume.avg_weekly_miles < 25 ? 0.86 : 0.9);
          if (cs > maxSustainableCs) {
            cs = maxSustainableCs;
            if (this.mileEffort) {
              dPrime = Math.max(50, this.mileEffort.distance_m - cs * this.mileEffort.time_s);
            }
          }
        }

        if (cs > 2.5 && cs < 6.0 && dPrime > 50 && dPrime < 800) {
          this.cs = cs;
          this.dPrime = dPrime;
          const ssTot = csEfforts.reduce(
            (acc, e, i) => acc + weights[i] * (e.distance_m - dBar) ** 2,
            0
          );
          const ssRes = csEfforts.reduce(
            (acc, e, i) => acc + weights[i] * (e.distance_m - (cs * e.time_s + dPrime)) ** 2,
            0
          );
          this.csR2 = ssTot > 0 ? 1 - ssRes / ssTot : 0.99;
        }
      }
    } else if (csEfforts.length === 1) {
      // Derive sustainable CS anchor from the single verified race effort (e.g. 5K)
      const e = csEfforts[0];
      const cs = (e.distance_m / e.time_s) * (e.distance_m >= 5000 ? 0.92 : 0.88);
      this.cs = cs;
      this.dPrime = Math.max(100, e.distance_m - cs * e.time_s);
      this.csR2 = 0.95;
    }

  }

  private resolveVdot() {
    // VDOT source priority (never short track intervals < 1500m):
    //   1. Verified race-distance PRs (5K preferred, then the PR closest to 5K: 10K / 1 Mile)
    //   2. Garmin watch race prediction (garmlink_race_predictions_get: 5K, then 10K)
    //   3. Garmin running VO2max (garmlink_vo2max_history)
    const raceEfforts = this.efforts.filter(
      (e) => e.distance_m >= 1500 && e.distance_m <= 42200 && e.time_s >= 200
    );
    const anchor =
      this.fiveKEffort && this.fiveKEffort.distance_m >= 1500
        ? this.fiveKEffort
        : [...raceEfforts].sort(
            (x, y) => Math.abs(Math.log(x.distance_m / 5000)) - Math.abs(Math.log(y.distance_m / 5000))
          )[0];
    const anchorVdot = anchor ? this.vdotFromPerformance(anchor.distance_m, anchor.time_s) : null;
    const g5k = this.garminPredictions?.time_5k_s;
    const g10k = this.garminPredictions?.time_10k_s;
    const garminVdot =
      (g5k ? this.vdotFromPerformance(5000, g5k) : null) ??
      (g10k ? this.vdotFromPerformance(10000, g10k) : null);

    if (anchorVdot !== null && anchorVdot >= 20 && anchorVdot <= 90) {
      this.effectiveVdot = Number(anchorVdot.toFixed(1)); // e.g. 19:04.8 5K -> 52.6
      this.vdotSource = 'race_pr';
    } else if (garminVdot !== null && garminVdot >= 20 && garminVdot <= 90) {
      this.effectiveVdot = Number(garminVdot.toFixed(1));
      this.vdotSource = 'garmin_race_prediction';
    } else if (this.vo2max && this.vo2max >= 20 && this.vo2max <= 90) {
      this.effectiveVdot = Number(this.vo2max.toFixed(1));
      this.vdotSource = 'garmin_vo2max';
    }
  }

  /** Raw Jack Daniels / Gilbert VDOT formula (no distance guard — used to invert predictions). */
  private danielsVdot(distM: number, timeS: number): number | null {
    const tMin = timeS / 60;
    if (tMin <= 0) return null;
    const vMMin = distM / tMin;
    const vo2 = -4.6 + 0.182258 * vMMin + 0.000104 * vMMin * vMMin;
    const pctMax =
      0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
    if (pctMax <= 0) return null;
    return vo2 / pctMax;
  }

  vdotFromPerformance(distM: number, timeS: number): number | null {
    // Fitting VDOT is physiologically valid only for race endurance efforts >= 1400m
    if (distM < 1400 || timeS < 180) return null;
    return this.danielsVdot(distM, timeS);
  }

  private predictDaniels(distM: number): number | null {
    const vdot = this.effectiveVdot;
    if (!vdot) return null;
    let low = 30;
    let high = 20000;
    let mid = 300;
    for (let i = 0; i < 50; i++) {
      mid = (low + high) / 2;
      const vEst = this.danielsVdot(distM, mid);
      if (vEst === null) break;
      if (vEst < vdot) high = mid;
      else low = mid;
    }
    return mid;
  }

  private predictRiegel(distM: number): number | null {
    const baseEffort = this.mileEffort ?? this.efforts[0];
    if (!baseEffort) return null;

    if (this.fiveKEffort && Math.abs(distM - 5000) < 100) {
      return this.fiveKEffort.time_s;
    }

    const bBase = this.bMileTo5k ?? 1.1;
    let b: number;
    let refDist = baseEffort.distance_m;
    let refTime = baseEffort.time_s;

    if (distM <= 800) {
      b = 1.082;
    } else if (distM <= 1609.344) {
      b = 1.06;
    } else if (distM <= 3200) {
      b = this.bMileTo5k ?? 1.1;
    } else if (distM <= 5000) {
      b = bBase;
    } else {
      b = 1.09;
      if (this.fiveKEffort) {
        refDist = this.fiveKEffort.distance_m;
        refTime = this.fiveKEffort.time_s;
      }
    }
    return refTime * Math.pow(distM / refDist, b);
  }

  private predictCs(distM: number): number | null {
    if (this.cs === null || this.dPrime === null) return null;
    if (distM <= this.dPrime) {
      return distM / (this.cs * 1.35);
    }
    if (distM <= 1000) {
      const v = Math.min(this.cs * (1 + this.dPrime / distM), this.cs * 1.32);
      return distM / v;
    }
    const t = (distM - this.dPrime) / this.cs;
    return t > 0 ? t : null;
  }

  predictBase(distanceM: number, label = ''): RacePrediction {
    // Exact 1600m / Mile coupling
    if ((Math.abs(distanceM - 1600) < 1 || label === '1600m') && Math.abs(distanceM - 1609.344) > 1) {
      const milePred = this.predictBase(1609.344, 'Mile');
      const ratio = 1600 / 1609.344;
      const models: Record<string, ModelContribution> = {};
      for (const [k, m] of Object.entries(milePred.models)) {
        const tSub = m.time_s * ratio;
        models[k] = { time_s: Number(tSub.toFixed(2)), time_fmt: formatTime(tSub), weight: m.weight };
      }
      const timeS = milePred.time_s * ratio;
      const fastS = milePred.fast_s * ratio;
      const slowS = milePred.slow_s * ratio;
      const theoS = milePred.theoretical_time_s * ratio;

      return {
        distance_m: 1600,
        distance_label: '1600m',
        time_s: Number(timeS.toFixed(2)),
        time_fmt: formatTime(timeS),
        fast_s: Number(fastS.toFixed(2)),
        fast_fmt: formatTime(fastS),
        slow_s: Number(slowS.toFixed(2)),
        slow_fmt: formatTime(slowS),
        pace_per_mile_s: milePred.pace_per_mile_s,
        pace_per_mile: milePred.pace_per_mile,
        theoretical_time_s: Number(theoS.toFixed(2)),
        theoretical_time_fmt: formatTime(theoS),
        volume_penalty_pct: milePred.volume_penalty_pct,
        readiness_status: milePred.readiness_status,
        readiness_note: milePred.readiness_note,
        models,
        adjustments: {},
        adjustment_pct: 0,
      };
    }

    const rawModels: Record<string, number> = {};
    const riegel = this.predictRiegel(distanceM);
    if (riegel !== null && riegel > 5) rawModels.calibrated_riegel = riegel;
    const cs = this.predictCs(distanceM);
    if (cs !== null && cs > 5) rawModels.critical_speed = cs;
    const daniels = this.predictDaniels(distanceM);
    if (daniels !== null && daniels > 5) rawModels.daniels_vdot = daniels;

    if (Object.keys(rawModels).length === 0) {
      rawModels.standard_riegel = 300 * (distanceM / 1600);
    }

    const weightMap: Record<string, number> =
      distanceM <= 850
        ? { calibrated_riegel: 0.6, critical_speed: 0.2, daniels_vdot: 0.2 }
        : distanceM <= 1650
          ? { calibrated_riegel: 0.65, critical_speed: 0.1, daniels_vdot: 0.25 }
          : distanceM <= 5500
            ? { calibrated_riegel: 0.55, critical_speed: 0.05, daniels_vdot: 0.4 }
            : { calibrated_riegel: 0.55, critical_speed: 0.05, daniels_vdot: 0.4 };

    const keys = Object.keys(rawModels);
    const totalW = keys.reduce((acc, k) => acc + (weightMap[k] ?? 0.2), 0);
    const theoreticalS =
      keys.reduce((acc, k) => acc + rawModels[k] * (weightMap[k] ?? 0.2), 0) / totalW;

    const distMi = distanceM / 1609.344;
    const longestMi = this.volume.longest_run_miles;
    const weeklyMi = this.volume.avg_weekly_miles;
    const ratio = distMi / Math.max(longestMi, 1.0);

    const longPenalty =
      ratio > 1.05 ? Math.min(40, 14 * Math.pow(ratio - 1.0, 1.35)) : 0;
    const targetMpw =
      distMi <= 3.1 ? 15 : distMi <= 6.2 ? 25 : distMi <= 13.1 ? 35 : 50;
    const volPenalty =
      weeklyMi < targetMpw && distMi > 5.0
        ? Math.min(25, ((targetMpw - weeklyMi) / targetMpw) * 22 * (distMi / 26.2))
        : 0;
    const volumePenaltyPct = Number((longPenalty + volPenalty).toFixed(1));
    const realisticS = theoreticalS * (1 + volumePenaltyPct / 100);

    let readinessStatus: RacePrediction['readiness_status'] = 'READY';
    let readinessNote = 'Fully supported by current weekly volume and long run base.';
    if (ratio <= 1.05 && distMi <= 6.2) {
      readinessStatus = 'READY';
    } else if (ratio <= 1.6 && distMi <= 14.0) {
      readinessStatus = 'VOLUME STRETCH';
      readinessNote = `Distance (${distMi.toFixed(1)} mi) exceeds your ${longestMi.toFixed(1)} mi long run. Late aerobic fade expected.`;
    } else {
      readinessStatus = 'HIGH BONK RISK';
      readinessNote = `Aerobic base deficit: longest run is ${longestMi.toFixed(1)} mi on ${weeklyMi.toFixed(0)} mpw (vs ${targetMpw}+ mpw recommended). Glycogen depletion will force pace collapse.`;
    }

    const vals = Object.values(rawModels);
    const margin =
      vals.length > 1
        ? Math.max(Math.min(((Math.max(...vals) - Math.min(...vals)) / theoreticalS) * 0.45, 0.035), 0.012)
        : 0.02;

    const fastS = realisticS * (1 - margin);
    const slowS = realisticS * (1 + margin);
    const paceS = realisticS / distMi;

    let resolvedLabel = label;
    if (!resolvedLabel) {
      const closest = Object.entries(STANDARD_DISTANCES).reduce((best, curr) =>
        Math.abs(curr[1] - distanceM) < Math.abs(best[1] - distanceM) ? curr : best
      );
      resolvedLabel = Math.abs(closest[1] - distanceM) < 40 ? closest[0] : `${Math.round(distanceM)}m`;
    }

    const models: Record<string, ModelContribution> = {};
    for (const k of keys) {
      models[k] = {
        time_s: Number(rawModels[k].toFixed(2)),
        time_fmt: formatTime(rawModels[k]),
        weight: Number(((weightMap[k] ?? 0.2) / totalW).toFixed(3)),
      };
    }

    return {
      distance_m: distanceM,
      distance_label: resolvedLabel,
      time_s: Number(realisticS.toFixed(2)),
      time_fmt: formatTime(realisticS),
      fast_s: Number(fastS.toFixed(2)),
      fast_fmt: formatTime(fastS),
      slow_s: Number(slowS.toFixed(2)),
      slow_fmt: formatTime(slowS),
      pace_per_mile_s: Number(paceS.toFixed(2)),
      pace_per_mile: formatTime(paceS),
      theoretical_time_s: Number(theoreticalS.toFixed(2)),
      theoretical_time_fmt: formatTime(theoreticalS),
      volume_penalty_pct: volumePenaltyPct,
      readiness_status: readinessStatus,
      readiness_note: readinessNote,
      models,
      adjustments: {},
      adjustment_pct: 0,
    };
  }

  applyConditions(base: RacePrediction, cond: CourseConditions): RacePrediction {
    const adjustments: Record<string, number> = {};
    const d = base.distance_m;

    const add = (key: string, val: number) => {
      const rounded = Number(val.toFixed(1));
      if (Math.abs(rounded) >= 0.1) adjustments[key] = rounded;
    };

    add('temperature', temperatureAdjustment(cond.temperature_f, d));
    add('humidity', humidityAdjustment(cond.humidity_pct, cond.temperature_f));
    add('wind', windAdjustment(cond.wind_mph, cond.wind_direction));
    add('elevation', elevationAdjustment(cond.elevation_gain_ft, cond.elevation_loss_ft, d, cond.surface));
    add('surface', surfaceAdjustment(cond.surface));
    add('shoes', shoeAdjustment(cond.shoe_type, cond.surface));
    add('altitude', altitudeAdjustment(cond.altitude_ft, d));

    if (cond.use_readiness) {
      add('readiness', readinessAdjustment(cond.hrv_status, cond.sleep_score, cond.body_battery));
    }

    const totalPct = Number(
      Object.values(adjustments)
        .reduce((a, b) => a + b, 0)
        .toFixed(1)
    );
    const factor = 1 + totalPct / 100;
    const timeS = base.time_s * factor;
    const fastS = base.fast_s * factor;
    const slowS = base.slow_s * factor;
    const paceS = timeS / (d / 1609.344);

    return {
      ...base,
      time_s: Number(timeS.toFixed(2)),
      time_fmt: formatTime(timeS),
      fast_s: Number(fastS.toFixed(2)),
      fast_fmt: formatTime(fastS),
      slow_s: Number(slowS.toFixed(2)),
      slow_fmt: formatTime(slowS),
      pace_per_mile_s: Number(paceS.toFixed(2)),
      pace_per_mile: formatTime(paceS),
      adjustments,
      adjustment_pct: totalPct,
    };
  }

  predict(distanceLabel: string, conditions: CourseConditions): RacePrediction {
    const distM = STANDARD_DISTANCES[distanceLabel] ?? 5000;
    const base = this.predictBase(distM, distanceLabel);
    return this.applyConditions(base, conditions);
  }

  predictAll(conditions: CourseConditions): RacePrediction[] {
    return PRIMARY_DISTANCES.map((d) => this.predict(d, conditions));
  }

  compareShoes(distanceLabel: string, conditions: CourseConditions): ShoeComparison[] {
    const distM = STANDARD_DISTANCES[distanceLabel] ?? 5000;
    const base = this.predictBase(distM, distanceLabel);
    const surfaceNorm = normalizeSurface(conditions.surface);
    const isTrack = surfaceNorm === 'track';
    const isRoadOrTreadmill = surfaceNorm === 'road' || surfaceNorm === 'treadmill';

    // On track: filter out dedicated XC muddy spikes
    // On XC / grass: filter out fragile track sprint/distance spikes without rubber outsoles
    let candidateShoes = ROTATION_SHOES;
    if (isTrack) {
      candidateShoes = ROTATION_SHOES.filter((s) => s !== 'rival_xc_7');
    } else if (surfaceNorm === 'xc' || surfaceNorm === 'grass') {
      candidateShoes = ROTATION_SHOES.filter((s) => s !== 'victory_2');
    }

    const isSpike = (id: string) =>
      [
        'dragonfly_track',
        'dragonfly_elite',
        'victory_2',
        'avanti_tyo',
        'fuelcell_sc_ldx',
        'dragonfly_xc',
        'rival_xc_7',
      ].includes(id);

    const isTrackSpike = (id: string) =>
      ['dragonfly_track', 'dragonfly_elite', 'victory_2', 'avanti_tyo', 'fuelcell_sc_ldx'].includes(id);

    const isXcSpike = (id: string) =>
      ['dragonfly_xc', 'rival_xc_7'].includes(id);

    const rows = candidateShoes.map((shoeId) => {
      const adj = this.applyConditions(base, { ...conditions, surface: surfaceNorm, shoe_type: shoeId });
      const shoePct = adj.adjustments.shoes ?? 0;
      const info = SHOE_DATABASE[shoeId] ?? {
        label: shoeId,
        short_label: shoeId,
        default_surface: 'road',
        weight_g: 200,
        description: '',
      };
      return {
        shoe_id: shoeId,
        label: info.label,
        short_label: info.short_label,
        time_s: adj.time_s,
        time_fmt: adj.time_fmt,
        pace_per_mile: adj.pace_per_mile,
        shoe_pct: shoePct,
        delta_s: 0,
        tag: 'VIABLE' as ShoeComparison['tag'],
      };
    });

    rows.sort((a, b) => a.time_s - b.time_s);
    const best = rows[0].time_s;

    return rows.map((r, idx) => {
      const isSpikeOnRoad = isRoadOrTreadmill && isSpike(r.shoe_id);

      let tag: ShoeComparison['tag'];
      if (isSpikeOnRoad) {
        tag = 'SURFACE HAZARD';
      } else if (isTrack) {
        if (isTrackSpike(r.shoe_id)) {
          tag = 'OPTIMAL';
        } else if (isXcSpike(r.shoe_id)) {
          tag = 'VIABLE';
        } else if (idx === 0) {
          tag = 'OPTIMAL';
        } else if (r.shoe_pct <= 0) {
          tag = 'VIABLE';
        } else {
          tag = 'TRAINING HEAVY';
        }
      } else if (idx === 0) {
        tag = 'OPTIMAL';
      } else if (r.shoe_pct <= 0) {
        tag = 'VIABLE';
      } else {
        tag = 'TRAINING HEAVY';
      }

      return {
        ...r,
        delta_s: Number((r.time_s - best).toFixed(1)),
        tag,
      };
    });
  }

  generateSplits(
    prediction: RacePrediction,
    strategy: SplitStrategy = 'course_gap',
    courseProfileFt?: number[]
  ): RaceSplit[] {
    const distM = prediction.distance_m;
    const totalS = prediction.time_s;
    if (distM <= 0 || totalS <= 0) return [];

    const checkpoints: Array<{ label: string; segM: number }> = [];
    if (distM <= 1650) {
      let cur = 0;
      let lap = 1;
      while (cur + 400 < distM - 15) {
        cur += 400;
        checkpoints.push({ label: `Lap ${lap} (${cur}m)`, segM: 400 });
        lap++;
      }
      if (distM - cur > 1) {
        checkpoints.push({ label: `Finish (${Math.round(distM)}m)`, segM: distM - cur });
      }
    } else if (distM <= 3250) {
      let cur = 0;
      while (cur + 800 < distM - 25) {
        cur += 800;
        checkpoints.push({ label: `${cur}m`, segM: 800 });
      }
      if (distM - cur > 1) {
        checkpoints.push({ label: `Finish (${Math.round(distM)}m)`, segM: distM - cur });
      }
    } else {
      const mileM = 1609.344;
      let cur = 0;
      let mi = 1;
      while (cur + mileM < distM - 60) {
        cur += mileM;
        checkpoints.push({ label: `Mile ${mi}`, segM: mileM });
        mi++;
      }
      if (distM - cur > 1) {
        const remMi = (distM - cur) / mileM;
        checkpoints.push({
          label: remMi < 0.9 ? `Kick (${remMi.toFixed(2)} mi)` : `Mile ${mi}`,
          segM: distM - cur,
        });
      }
    }

    const interpElev = (frac: number) => {
      if (!courseProfileFt || courseProfileFt.length < 2) return 0;
      const pos = Math.max(0, Math.min(1, frac)) * (courseProfileFt.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, courseProfileFt.length - 1);
      const f = pos - lo;
      return courseProfileFt[lo] * (1 - f) + courseProfileFt[hi] * f;
    };

    const n = checkpoints.length;
    const avgSpeedMps = distM / totalS;
    const rawTimes: number[] = [];
    const metas: Array<{
      label: string;
      segM: number;
      elevDeltaFt: number;
      gradePct: number;
      cue: string;
    }> = [];

    let cumDist = 0;
    checkpoints.forEach((cp, idx) => {
      const startFrac = cumDist / distM;
      const endFrac = (cumDist + cp.segM) / distM;
      cumDist += cp.segM;

      const deltaFt = interpElev(endFrac) - interpElev(startFrac);
      const gradePct = cp.segM > 0 ? ((deltaFt * 0.3048) / cp.segM) * 100 : 0;

      let factor = 1.0;
      let cue = 'Hold steady rhythm';

      if (strategy === 'negative') {
        const prog = idx / Math.max(n - 1, 1);
        factor = 1.018 - 0.04 * prog;
        cue =
          prog < 0.35
            ? 'Controlled patience'
            : prog < 0.7
              ? 'Lock into rhythm'
              : 'Empty anaerobic reserve';
      } else if (strategy === 'course_gap') {
        const gradeAdj = gradePct >= 0 ? gradePct * 0.034 : Math.max(gradePct * 0.018, -0.05);
        const kickAdj = idx === n - 1 && n >= 3 ? -0.012 : idx === 0 ? 0.008 : 0;
        factor = Math.max(0.9, 1 + gradeAdj + kickAdj);

        if (deltaFt >= 12) cue = `Climb (+${Math.round(deltaFt)} ft) · Shorten stride`;
        else if (deltaFt <= -12) cue = `Descent (${Math.round(deltaFt)} ft) · Open turnover`;
        else if (idx === n - 1) cue = "Final kick · Empty D' reserve";
        else if (idx === 0) cue = 'Controlled opening · Avoid early redline';
        else cue = 'Aerobic lock · Smooth cadence';
      }

      rawTimes.push((cp.segM / avgSpeedMps) * factor);
      metas.push({
        label: cp.label,
        segM: Number(cp.segM.toFixed(1)),
        elevDeltaFt: Number(deltaFt.toFixed(1)),
        gradePct: Number(gradePct.toFixed(1)),
        cue,
      });
    });

    const sumRaw = rawTimes.reduce((a, b) => a + b, 0);
    const scale = totalS / sumRaw;
    let cumT = 0;

    return rawTimes.map((rt, i) => {
      const segT = rt * scale;
      cumT += segT;
      const meta = metas[i];
      const paceS = segT / (meta.segM / 1609.344);
      return {
        label: meta.label,
        segment_m: meta.segM,
        segment_time_s: Number(segT.toFixed(2)),
        segment_time_fmt: formatTime(segT),
        cumulative_time_s: Number(cumT.toFixed(2)),
        cumulative_time_fmt: formatTime(cumT),
        pace_per_mile: formatTime(paceS),
        elev_delta_ft: meta.elevDeltaFt,
        grade_pct: meta.gradePct,
        cue: meta.cue,
      };
    });
  }

  private paceAtVo2Pct(pct: number): number | null {
    const vdot = this.effectiveVdot ?? this.vo2max;
    if (!vdot || vdot <= 0) return null;
    const targetVo2 = vdot * pct;
    const disc = 0.182258 ** 2 + 4 * 0.000104 * (4.6 + targetVo2);
    if (disc <= 0) return null;
    const vMMin = (-0.182258 + Math.sqrt(disc)) / (2 * 0.000104);
    const vMps = vMMin / 60;
    return vMps > 0 ? 1609.344 / vMps : null;
  }

  getTrainingZones(): TrainingZones {
    const easySlow = this.paceAtVo2Pct(0.62) ?? 525; // ~8:42/mi at VDOT 52.7
    const easyFast = this.paceAtVo2Pct(0.70) ?? 475; // ~7:54/mi at VDOT 52.7
    const marathon = this.paceAtVo2Pct(0.82) ?? 417; // ~6:57/mi at VDOT 52.7
    const thresholdVdot = this.paceAtVo2Pct(0.89) ?? 390; // ~6:30/mi at VDOT 52.7
    const csPace = this.cs ? 1609.344 / this.cs : thresholdVdot;
    const threshold = (thresholdVdot * 2 + Math.min(csPace, thresholdVdot + 10)) / 3;
    const interval = this.paceAtVo2Pct(0.985) ?? 359; // ~5:59/mi at VDOT 52.7
    const rep = this.paceAtVo2Pct(1.072) ?? 335; // ~5:35/mi at VDOT 52.7
    const rep400S = rep / 4.02336;

    return {
      recovery: {
        pace_s: Number((easySlow + 20).toFixed(1)),
        label: `${formatPace(easySlow + 10)}–${formatPace(easySlow + 35)}`,
      },
      easy: {
        pace_s: Number(((easySlow + easyFast) / 2).toFixed(1)),
        label: `${formatPace(easyFast)}–${formatPace(easySlow)}`,
      },
      marathon: { pace_s: Number(marathon.toFixed(1)), label: formatPace(marathon) },
      threshold: {
        pace_s: Number(threshold.toFixed(1)),
        label: `${formatPace(threshold - 4)}–${formatPace(threshold + 4)}`,
      },
      interval: { pace_s: Number(interval.toFixed(1)), label: formatPace(interval) },
      repetition: { pace_s: Number(rep.toFixed(1)), label: formatPace(rep) },
      rep_400m: `${Math.floor(rep400S / 60)}:${(rep400S % 60).toFixed(1).padStart(4, '0')}`,
    };
  }

  getFitnessMetrics(): FitnessMetrics {
    const pace = this.cs ? formatTime(1609.344 / this.cs) + '/mi' : '—';
    let fatigueProfile = 'Balanced Distance';
    if (this.bMileTo5k !== null) {
      if (this.bMileTo5k < 1.05) fatigueProfile = 'Endurance Specialist';
      else if (this.bMileTo5k < 1.09) fatigueProfile = 'Balanced Distance';
      else if (this.bMileTo5k < 1.14) fatigueProfile = 'Middle-Distance / Fast-Twitch';
      else fatigueProfile = 'High Anaerobic Bias';
    }

    return {
      critical_speed_mps: this.cs ? Number(this.cs.toFixed(3)) : null,
      critical_speed_pace: pace,
      d_prime_m: this.dPrime ? Number(this.dPrime.toFixed(1)) : null,
      riegel_exponent: this.bMileTo5k ? Number(this.bMileTo5k.toFixed(3)) : null,
      vo2max: this.effectiveVdot
        ? Number(this.effectiveVdot.toFixed(1))
        : this.vo2max
          ? Number(this.vo2max.toFixed(1))
          : null,
      fatigue_profile: fatigueProfile,
      num_efforts: this.efforts.length,
      model_fit_r2: this.csR2 ? Number(this.csR2.toFixed(3)) : null,
      longest_run_miles: this.volume.longest_run_miles,
      avg_weekly_miles: this.volume.avg_weekly_miles,
      lt_hr_bpm: ATHLETE_PROFILE.lt_hr_bpm,
    };
  }
}
