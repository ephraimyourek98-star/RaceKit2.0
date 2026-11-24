import type {
  DailyWorkout,
  HealthSnapshot,
  TrainingFocusId,
  TrainingPlan,
  TrainingZones,
  WorkoutType,
} from './types';

export const DAYS_OF_WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const DAY_ABBREV_MAP: Array<[RegExp, (typeof DAYS_OF_WEEK)[number]]> = [
  [/^mon(?:day)?$/i, 'Monday'],
  [/^tue(?:s|sday)?$/i, 'Tuesday'],
  [/^wed(?:nesday)?$/i, 'Wednesday'],
  [/^thu(?:r|rs|rsday)?$/i, 'Thursday'],
  [/^fri(?:day)?$/i, 'Friday'],
  [/^sat(?:urday)?$/i, 'Saturday'],
  [/^sun(?:day)?$/i, 'Sunday'],
];

/** Canonicalize a day name or abbreviation; returns `fallback` when unrecognized. */
export function normalizeDayName(day?: string | null, fallback = 'Monday'): string {
  const cleaned = String(day ?? '').trim().replace(/[.,:!?]+$/, '');
  if (!cleaned) return fallback;
  for (const [rx, canonical] of DAY_ABBREV_MAP) {
    if (rx.test(cleaned)) return canonical;
  }
  return fallback;
}

/** Return remaining weekday names from `todayDay` through Sunday. */
export function getRemainingDaysOfWeek(todayDay: string = getTodayDayName()): string[] {
  const normalizedToday = normalizeDayName(todayDay, getTodayDayName());
  const idx = DAYS_OF_WEEK.indexOf(normalizedToday as (typeof DAYS_OF_WEEK)[number]);
  if (idx < 0) return [...DAYS_OF_WEEK];
  return DAYS_OF_WEEK.slice(idx);
}

/** Filter and canonically order a schedule strictly to remaining days starting at `todayDay`. */
export function filterRemainingSchedule<T extends { day?: string }>(
  schedule: T[],
  todayDay: string = getTodayDayName()
): T[] {
  if (!Array.isArray(schedule)) return [];
  const remaining = getRemainingDaysOfWeek(todayDay);
  const allowed = new Set(remaining);
  const byDay = new Map<string, T>();
  for (const item of schedule) {
    if (!item || !item.day) continue;
    const canonical = normalizeDayName(item.day, '');
    if (canonical && allowed.has(canonical)) {
      byDay.set(canonical, { ...item, day: canonical });
    }
  }
  return remaining.map((d) => byDay.get(d)).filter((item): item is T => Boolean(item));
}

export interface ScheduleStats {
  totalMiles: number;
  activeDays: number;
  qualityCount: number;
  raceCount: number;
  easyRecoveryCount: number;
  crossTrainCount: number;
  restCount: number;
  longestRunMiles: number;
}

/** Compute weekly summary metrics strictly from the provided visible workout cards. */
export function computeScheduleStats(schedule: DailyWorkout[]): ScheduleStats {
  let totalMiles = 0;
  let activeDays = 0;
  let qualityCount = 0;
  let raceCount = 0;
  let easyRecoveryCount = 0;
  let crossTrainCount = 0;
  let restCount = 0;
  let longestRunMiles = 0;

  for (const w of schedule) {
    const miles = Number.isFinite(w.distance_miles) ? Math.max(0, w.distance_miles) : 0;
    if (w.workout_type === 'rest') {
      restCount += 1;
      continue;
    }
    if (w.workout_type === 'cross_train') {
      crossTrainCount += 1;
      activeDays += 1;
      totalMiles += miles;
      continue;
    }
    if (w.workout_type === 'race') {
      raceCount += 1;
      activeDays += 1;
    } else if (w.workout_type === 'workout') {
      qualityCount += 1;
      activeDays += 1;
    } else {
      easyRecoveryCount += 1;
      if (miles > 0) activeDays += 1;
    }
    totalMiles += miles;
    if (w.workout_type !== 'race' && miles > longestRunMiles) {
      longestRunMiles = miles;
    }
  }

  return {
    totalMiles: Number(totalMiles.toFixed(1)),
    activeDays,
    qualityCount,
    raceCount,
    easyRecoveryCount,
    crossTrainCount,
    restCount,
    longestRunMiles: Number(longestRunMiles.toFixed(1)),
  };
}

/** Slice a training plan strictly to remaining days of the current week and recompute totals. */
export function slicePlanToRemainingDays(
  plan: TrainingPlan,
  todayDay: string = getTodayDayName()
): TrainingPlan {
  const schedule = filterRemainingSchedule(plan.schedule, todayDay);
  const stats = computeScheduleStats(schedule);
  return {
    ...plan,
    schedule,
    weekly_mileage: stats.totalMiles,
  };
}

export const TRAINING_FOCUS_LABELS: Record<TrainingFocusId, string> = {
  track_mid: 'Track Mid-Distance (800m / 1600m / Mile)',
  track_long: 'Track Distance (3200m / 2 Mile / 5000m)',
  xc: 'Cross Country 5K (Hills / Grass / Power)',
  half_marathon: 'Half Marathon Prep (Aerobic Durability)',
  base_building: 'Aerobic Base Building & Injury Immunity',
};

/** Pure race distance in miles (no warm-up / cooldown — those are added exactly once by the caller). */
export function raceDistanceMiles(distLabel: string): number {
  const map: Record<string, number> = {
    '400m': 0.25,
    '800m': 0.5,
    '1000m': 0.6,
    '1500m': 0.9,
    '1600m': 1.0,
    Mile: 1.0,
    '1 Mile': 1.0,
    '3000m': 1.9,
    '3200m': 2.0,
    '2 Mile': 2.0,
    '5K': 3.1,
    '10K': 6.2,
    '15K': 9.3,
    'Half Marathon': 13.1,
    Marathon: 26.2,
  };
  return map[distLabel] ?? 3.1;
}

/**
 * Single source of truth for card mileage: total = warmup + main + cooldown, counted once.
 * Falls back to the "Warmup / Main Set / Cooldown" lines in the description when the numeric
 * fields are missing, and repairs race cards whose total had the race distance added twice.
 */
export function normalizeWorkoutMiles(w: DailyWorkout, raceMiles?: number): DailyWorkout {
  if (w.workout_type === 'rest') {
    if (
      w.distance_miles === 0 &&
      (w.warmup_miles ?? 0) === 0 &&
      (w.main_miles ?? 0) === 0 &&
      (w.cooldown_miles ?? 0) === 0
    ) {
      return w;
    }
    return { ...w, distance_miles: 0, warmup_miles: 0, main_miles: 0, cooldown_miles: 0 };
  }
  if (w.workout_type === 'cross_train') {
    const safeMiles = Number.isFinite(w.distance_miles) ? Math.max(0, Number(w.distance_miles.toFixed(1))) : 0;
    return safeMiles === w.distance_miles ? w : { ...w, distance_miles: safeMiles };
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let wu = num(w.warmup_miles);
  let main = num(w.main_miles);
  let cd = num(w.cooldown_miles);

  if (wu === null || main === null || cd === null) {
    const desc = w.description || '';
    const pWu = desc.match(/Warm-?up:[^\n]*?([\d.]+)\s*mi\b/i);
    const pMain = desc.match(/Main Set:[^\n]*?([\d.]+)\s*mi\b/i);
    const pCd = desc.match(/Cool-?down:[^\n]*?([\d.]+)\s*mi\b/i);
    if (pWu && pMain && pCd) {
      wu = parseFloat(pWu[1]);
      main = parseFloat(pMain[1]);
      cd = parseFloat(pCd[1]);
    } else if (w.workout_type === 'race' && raceMiles) {
      // Race card without a breakdown: the race distance is the main set, never added on top of itself
      wu = wu ?? 1.5;
      cd = cd ?? 1.0;
      main = raceMiles;
    } else {
      return w;
    }
  }
  if (![wu, main, cd].every((v) => v !== null && Number.isFinite(v) && v >= 0)) return w;
  // Race main set that already had the race distance doubled (e.g. 6.2 for a 5K) -> count it once
  if (w.workout_type === 'race' && raceMiles && Math.abs(main! - 2 * raceMiles) < 0.15) {
    main = raceMiles;
  }

  const total = Number((wu! + main! + cd!).toFixed(1));
  if (
    total === w.distance_miles &&
    w.warmup_miles === wu &&
    w.main_miles === main &&
    w.cooldown_miles === cd
  ) {
    return w;
  }
  return { ...w, warmup_miles: wu!, main_miles: main!, cooldown_miles: cd!, distance_miles: total };
}

/** Hard cap on automatically scheduled rest days per week (default plans schedule at most 1). */
export const MAX_AUTO_REST_DAYS = 1;

const AUTO_REST_REASON = /automatic|recovery gate|low recovery/i;

/**
 * Ensure generated/adapted weeks never stack 2+ unpinned rest days (and never override user-pinned
 * rest days). Excess unpinned rest days become active Zone 1-2 Easy/Recovery runs.
 */
export function capRestDays(schedule: DailyWorkout[], maxAuto: number = MAX_AUTO_REST_DAYS): void {
  const isRest = (w: DailyWorkout) => w.workout_type === 'rest';
  const isUserPinned = (w: DailyWorkout) =>
    Boolean(
      w.is_pinned ||
        w.user_customized ||
        (w.adaptation_reason && !AUTO_REST_REASON.test(w.adaptation_reason))
    );
  const explicitCount = schedule.filter((w) => isRest(w) && isUserPinned(w)).length;
  const auto = schedule.map((w, i) => ({ w, i })).filter(({ w }) => isRest(w) && !isUserPinned(w));
  let allowed = Math.max(0, maxAuto - explicitCount);
  if (auto.length <= allowed) return;

  const keepOrder = [...auto].sort(
    (a, b) => Number(Boolean(b.w.adaptation_reason)) - Number(Boolean(a.w.adaptation_reason)) || a.i - b.i
  );
  const keep = new Set<number>();
  for (const { i } of keepOrder) {
    if (allowed <= 0) break;
    keep.add(i);
    allowed -= 1;
  }
  const easyRef = schedule.find((w) => w.workout_type === 'recovery' || w.workout_type === 'easy');
  for (const { w, i } of auto) {
    if (keep.has(i)) continue;
    schedule[i] = {
      day: w.day,
      name: maxAuto === 0 ? 'Easy Aerobic Base Run' : 'Recovery Shakeout (Zone 1–2)',
      workout_type: maxAuto === 0 ? 'easy' : 'recovery',
      warmup_miles: 0.5,
      main_miles: maxAuto === 0 ? 2.5 : 2.0,
      cooldown_miles: 0.5,
      distance_miles: maxAuto === 0 ? 3.5 : 3.0,
      pace_target: easyRef?.pace_target ?? 'Very easy, fully conversational',
      hr_cap: '< 145 bpm (Zone 1–2)',
      description:
        maxAuto === 0
          ? '• Warmup: 0.5 mi walk-jog.\n• Main Set: 2.5 mi relaxed conversational aerobic miles (no forced rest).\n• Cooldown: 0.5 mi easy walk + mobility.'
          : '• Warmup: 0.5 mi walk-jog.\n• Main Set: 2.0 mi very easy Zone 1–2 shakeout on soft surface. Walk if HR drifts above 140 bpm.\n• Cooldown: 0.5 mi walk + 10 min mobility.',
      injury_prevention_note:
        'Optional rest if fatigued: light aerobic blood flow supports recovery without forcing a zero-mile day.',
    };
  }
}

/**
 * Final pass applied to whatever plan is rendered (template, AI plan, or coach-edited days):
 * optional remaining-day slicing, strict per-card mileage, post-race labeling, rest-day cap, and weekly total.
 */
export function finalizePlanSchedule(
  plan: TrainingPlan,
  targetRace?: { name: string; dist: string; day: string } | null,
  options?: { todayDay?: string; remainingOnly?: boolean; maxAutoRest?: number }
): TrainingPlan {
  const sourceSchedule = options?.remainingOnly
    ? filterRemainingSchedule(plan.schedule, options.todayDay ?? getTodayDayName())
    : plan.schedule;

  const raceIdx = sourceSchedule.findIndex((w) => w.workout_type === 'race');
  const raceMiles = targetRace?.dist ? raceDistanceMiles(targetRace.dist) : undefined;

  const schedule = sourceSchedule.map((w, i) => {
    let next = normalizeWorkoutMiles(w, raceMiles);
    if (raceIdx !== -1 && i > raceIdx && /taper|pre-?race|shakeout/i.test(next.name)) {
      next = {
        ...next,
        name:
          next.workout_type === 'rest'
            ? 'Post-Race Rest & Mobility'
            : i === raceIdx + 1
              ? 'Post-Race Recovery'
              : 'Easy Aerobic Re-Entry',
      };
    }
    return next;
  });

  capRestDays(schedule, options?.maxAutoRest ?? MAX_AUTO_REST_DAYS);

  const stats = computeScheduleStats(schedule);
  const unchanged =
    schedule.length === plan.schedule.length &&
    schedule.every((w, i) => w === plan.schedule[i]) &&
    stats.totalMiles === plan.weekly_mileage;
  return unchanged
    ? plan
    : {
        ...plan,
        schedule,
        weekly_mileage: stats.totalMiles,
      };
}

export function getTodayDayName(referenceDate: Date = new Date()): string {
  const idx = referenceDate.getDay();
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][idx];
}

export function applyRaceTaper(
  plan: TrainingPlan,
  raceName: string,
  raceDist: string,
  raceDay: string,
  easyPace = '8:00–8:30/mi'
): TrainingPlan {
  // Run for Pie 5K is on Thanksgiving Day (Thursday, Nov 26, 2026). Strictly normalize to Thursday.
  let effectiveDay = raceDay;
  if (!effectiveDay || effectiveDay === 'Monday' || (raceName && raceName.toLowerCase().includes('pie'))) {
    effectiveDay = 'Thursday';
  }
  const normalizedDay =
    DAYS_OF_WEEK.find((d) => d.toLowerCase() === (effectiveDay || '').trim().toLowerCase()) ?? 'Thursday';
  const raceIdx = DAYS_OF_WEEK.indexOf(normalizedDay);

  const schedule: DailyWorkout[] = DAYS_OF_WEEK.map((dayName, i) => {
    // Position within this Mon–Sun week: positive = days before the race, negative = days after.
    // (No wrap-around: every day after Race Day in the same week is post-race, never "pre-taper".)
    const daysBefore = raceIdx - i;

    if (daysBefore === 0) {
      const raceMi = raceDistanceMiles(raceDist);
      const wuMi = 1.5;
      const cdMi = 1.0;
      const totalMi = Number((wuMi + raceMi + cdMi).toFixed(1));
      return {
        day: dayName,
        name: `${raceName} — ${raceDist} Race`,
        workout_type: 'race',
        warmup_miles: wuMi,
        main_miles: raceMi,
        cooldown_miles: cdMi,
        distance_miles: totalMi,
        pace_target: 'Goal Race Pace (~5:58–6:05/mi)',
        hr_cap: 'Race Effort (Max VO2)',
        description: `• Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.\n• Main Set: Execute ${raceDist} race (${raceMi} mi) at Goal Race Pace.\n• Cooldown: 1.0 mi easy cooldown flush on soft grass.`,
        injury_prevention_note: 'Pre-race meal 3h prior. Double-knot racing shoes; electrolytes 60 min out.',
      };
    }
    if (daysBefore === 1) {
      return {
        day: dayName,
        name: 'Pre-Race Shakeout & Strides',
        workout_type: 'easy',
        warmup_miles: 0.5,
        main_miles: 1.0,
        cooldown_miles: 0.5,
        distance_miles: 2.0,
        pace_target: `${easyPace} + 4x100m strides`,
        hr_cap: '< 140 bpm',
        description: '• Warmup: 0.5 mi progressive jog.\n• Main Set: 1.0 mi relaxed shakeout + 4x100m smooth neuromuscular strides.\n• Cooldown: 0.5 mi walk and mobility.',
        injury_prevention_note: 'Zero straining on strides — stay tall, bouncy, and relaxed.',
      };
    }
    if (daysBefore === 2) {
      return {
        day: dayName,
        name: 'Taper Sharpening (Mini-Tempo)',
        workout_type: 'workout',
        warmup_miles: 1.5,
        main_miles: 1.0,
        cooldown_miles: 1.0,
        distance_miles: 3.5,
        pace_target: '2 x 800m @ goal race pace (3 min rest)',
        hr_cap: 'Controlled · Low fatigue',
        description: '• Warmup: 1.5 mi easy jog + drills.\n• Main Set: 2 x 800m at goal race pace with full standing recovery.\n• Cooldown: 1.0 mi easy flush.',
        injury_prevention_note: 'Primes fast-twitch motor units without depleting muscle glycogen.',
      };
    }
    if (daysBefore === 3) {
      if (dayName === 'Monday') {
        return {
          day: dayName,
          name: 'Full Rest & Prehab Mobility',
          workout_type: 'rest',
          warmup_miles: 0,
          main_miles: 0,
          cooldown_miles: 0,
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: 'Zero running. 20 min foam rolling IT bands, calves, and quads to trigger glycogen supercompensation.',
          injury_prevention_note: 'Connective tissues adapt and remodel during rest.',
        };
      }
      return {
        day: dayName,
        name: 'Taper Aerobic Maintenance (Zone 2)',
        workout_type: 'easy',
        warmup_miles: 0.5,
        main_miles: 2.0,
        cooldown_miles: 0.5,
        distance_miles: 3.0,
        pace_target: easyPace,
        hr_cap: '< 145 bpm',
        description: '• Warmup: 0.5 mi jog.\n• Main Set: 2.0 mi relaxed aerobic flush on soft grass.\n• Cooldown: 0.5 mi walk.',
        injury_prevention_note: 'Volume trimmed ~35% for glycogen supercompensation.',
      };
    }
    if (dayName === 'Monday') {
      return {
        day: dayName,
        name: 'Full Rest & Prehab Mobility',
        workout_type: 'rest',
        warmup_miles: 0,
        main_miles: 0,
        cooldown_miles: 0,
        distance_miles: 0,
        pace_target: 'Off',
        hr_cap: 'Rest',
        description: 'Zero running. Foam roll IT bands, calves, and quads.',
        injury_prevention_note: 'Mandatory weekly recovery day.',
      };
    }
    if (daysBefore === -1) {
      return {
        day: dayName,
        name: 'Post-Race Recovery Flush',
        workout_type: 'recovery',
        warmup_miles: 0.5,
        main_miles: 1.0,
        cooldown_miles: 0.5,
        distance_miles: 2.0,
        pace_target: 'Slow jog or 30 min brisk walk',
        hr_cap: '< 130 bpm',
        description: '• Warmup: 0.5 mi light walk.\n• Main Set: 1.0 mi gentle recovery flush on soft grass.\n• Cooldown: 0.5 mi mobility & rehydration.',
        injury_prevention_note: 'Zero pounding. Prioritize protein and sleep.',
      };
    }
    if (daysBefore === -2) {
      return {
        day: dayName,
        name: 'Aerobic Base Re-Entry (Zone 2)',
        workout_type: 'easy',
        distance_miles: 4.0,
        pace_target: easyPace,
        hr_cap: '< 145 bpm',
        description: 'Easy aerobic miles on soft grass or trail. Monitor calves and Achilles.',
        injury_prevention_note: 'If sore from spikes/carbon, swap for easy spin or rest.',
      };
    }
    if (daysBefore < 0) {
      return {
        day: dayName,
        name: 'Easy Aerobic Re-Entry (Zone 2)',
        workout_type: 'easy',
        distance_miles: 4.0,
        pace_target: easyPace,
        hr_cap: '< 145 bpm',
        description: 'Relaxed aerobic miles to rebuild rhythm after the race. Keep it conversational.',
        injury_prevention_note: 'Cut it short if any post-race soreness lingers.',
      };
    }
    return {
      day: dayName,
      name: 'Pre-Taper Easy Aerobic (Zone 2)',
      workout_type: 'easy',
      distance_miles: 4.0,
      pace_target: easyPace,
      hr_cap: '< 145 bpm',
      description: 'Controlled aerobic mileage. Stay hydrated.',
      injury_prevention_note: 'Strictly aerobic; zero anaerobic drift.',
    };
  });

  const weeklyMileage = Number(
    schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1)
  );

  return {
    focus_id: plan.focus_id,
    title: `${plan.title} — Race Week`,
    target_race: `${raceName} (${raceDist}) · ${raceDay}`,
    weekly_mileage: weeklyMileage,
    aerobic_deficit_focus: `Race-week taper active for ${raceName} (${raceDist}) on ${raceDay}. Volume reduced ~35% for glycogen supercompensation and neuromuscular snap.`,
    schedule,
  };
}

export function generateTrainingPlan(
  focus: TrainingFocusId,
  zones: TrainingZones,
  targetRace?: { name: string; dist: string; day: string } | null,
  weekIndex: number = currentWeekIndex()
): TrainingPlan {
  const easyP = zones.easy.label;
  const recP = zones.recovery.label;
  const tP = zones.threshold.label;
  const iP = zones.interval.label;
  const mP = zones.marathon.label;
  const rep400 = zones.rep_400m;

  let plan: TrainingPlan;

  if (focus === 'track_mid') {
    plan = {
      focus_id: 'track_mid',
      title: 'Track Middle-Distance (800m / 1600m / Mile)',
      target_race: 'Track 800m & 1600m Season',
      weekly_mileage: 24.5,
      aerobic_deficit_focus:
        'Closes the Garmin low-aerobic shortage (613 vs 1,318 anaerobic) while sharpening 800m/Mile fast-twitch pop.',
      schedule: [
        {
          day: 'Monday',
          name: 'Full Rest & Hip Mobility',
          workout_type: 'rest',
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: 'Zero running. 15 min hip flexor, glute medius activation & foam rolling.',
          injury_prevention_note: 'Non-negotiable connective tissue remodeling window.',
        },
        {
          day: 'Tuesday',
          name: 'Track Speed Intervals (800m/1600m Prep)',
          workout_type: 'workout',
          distance_miles: 4.5,
          pace_target: `~${rep400} per 400m (R-Pace)`,
          hr_cap: 'WU/CD < 150 bpm',
          description: `1.5 mi easy WU + 4x400m @ ${rep400} with 90s walk rest + 4x100m smooth strides + 1.5 mi CD.`,
          injury_prevention_note: 'Keep strides relaxed at 90% effort to protect hamstrings.',
        },
        {
          day: 'Wednesday',
          name: 'Aerobic Base Anchor (Zone 2)',
          workout_type: 'easy',
          distance_miles: 4.0,
          pace_target: easyP,
          hr_cap: 'Strict < 145 bpm',
          description: 'Continuous steady running. If watch HR exceeds 145 bpm, walk until it drops to 130.',
          injury_prevention_note: 'Directly builds capillary beds without adding bone stress.',
        },
        {
          day: 'Thursday',
          name: 'Threshold Cruise Intervals',
          workout_type: 'workout',
          distance_miles: 4.5,
          pace_target: tP,
          hr_cap: '180–184 bpm (LT)',
          description: `1.5 mi WU + 3 x 1000m @ ${tP} with 60s jog rest + 1.5 mi CD.`,
          injury_prevention_note: 'Raises lactate clearance ceiling for lap 3 of the 1600m.',
        },
        {
          day: 'Friday',
          name: 'Active Recovery Shakeout',
          workout_type: 'recovery',
          distance_miles: 3.0,
          pace_target: recP,
          hr_cap: 'Strict < 140 bpm',
          description: 'Easy flush run + 4 x 50m light grass strides + mobility.',
          injury_prevention_note: 'Clears metabolic fatigue before weekend volume anchor.',
        },
        {
          day: 'Saturday',
          name: 'Aerobic Volume Long Run',
          workout_type: 'long_run',
          distance_miles: 6.5,
          pace_target: easyP,
          hr_cap: '< 150 bpm (Zone 2)',
          description: 'Controlled continuous aerobic distance. Hydrate every 2 miles.',
          injury_prevention_note: 'Capped at 26% of weekly mileage to protect knees and plantar fascia.',
        },
        {
          day: 'Sunday',
          name: 'Recovery Flush',
          workout_type: 'easy',
          distance_miles: 2.0,
          pace_target: recP,
          hr_cap: '< 135 bpm',
          description: 'Relaxed Zone 1/2 recovery jog.',
          injury_prevention_note: 'Zero anaerobic accumulation.',
        },
      ],
    };
  } else if (focus === 'track_long') {
    plan = {
      focus_id: 'track_long',
      title: 'Track Distance (3200m / 2 Mile / 5000m)',
      target_race: '3200m / 5000m Track Focus',
      weekly_mileage: 27.0,
      aerobic_deficit_focus: 'Expands VO2max plateau and threshold durability for the 8-lap track grind.',
      schedule: [
        {
          day: 'Monday',
          name: 'Full Rest Day',
          workout_type: 'rest',
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: 'Complete rest. Core stability and hamstring mobility routine.',
          injury_prevention_note: 'Allows muscular micro-tears from weekend volume to heal.',
        },
        {
          day: 'Tuesday',
          name: 'Mile Repeat Threshold Session',
          workout_type: 'workout',
          distance_miles: 5.0,
          pace_target: tP,
          hr_cap: '182–185 bpm',
          description: `1.5 mi WU + 2 x 1 Mile @ ${tP} with 2 min walk rest + 4x150m strides + 1.5 mi CD.`,
          injury_prevention_note: 'Holds race rhythm without hyper-acidosis.',
        },
        {
          day: 'Wednesday',
          name: 'Mid-Week Aerobic Foundation',
          workout_type: 'easy',
          distance_miles: 4.5,
          pace_target: easyP,
          hr_cap: '< 145 bpm',
          description: 'Pure Zone 2 aerobic development with steady nasal/relaxed breathing.',
          injury_prevention_note: 'Builds mitochondrial density for late-race 3200m survival.',
        },
        {
          day: 'Thursday',
          name: 'VO2max Tempo Intervals',
          workout_type: 'workout',
          distance_miles: 5.0,
          pace_target: iP,
          hr_cap: '185–190 bpm',
          description: `1.5 mi WU + 4 x 800m @ ${iP} with 90s jog rest + 1.5 mi CD.`,
          injury_prevention_note: 'Neuromuscular pacing lock without glycogen depletion.',
        },
        {
          day: 'Friday',
          name: 'Easy Recovery Shakeout',
          workout_type: 'recovery',
          distance_miles: 3.0,
          pace_target: recP,
          hr_cap: '< 140 bpm',
          description: 'Relaxed recovery jog plus leg swings and light mobility.',
          injury_prevention_note: 'Lowers resting cortisol before Saturday progression.',
        },
        {
          day: 'Saturday',
          name: 'Progressive Long Run',
          workout_type: 'long_run',
          distance_miles: 7.5,
          pace_target: `${easyP} -> ${mP}`,
          hr_cap: 'Start < 145, peak < 165 bpm',
          description: `Miles 1–5 @ ${easyP}, Miles 6–7.5 progressing smoothly toward ${mP}.`,
          injury_prevention_note: 'Respects historical 8.9 mi long-run ceiling.',
        },
        {
          day: 'Sunday',
          name: 'Easy Aerobic Flush',
          workout_type: 'easy',
          distance_miles: 2.0,
          pace_target: recP,
          hr_cap: '< 130 bpm',
          description: 'Low-impact active recovery.',
          injury_prevention_note: 'Zero pounding.',
        },
      ],
    };
  } else if (focus === 'xc') {
    plan = {
      focus_id: 'xc',
      title: 'Cross Country 5K (Grass / Hills / Power)',
      target_race: '5K Cross Country Championship',
      weekly_mileage: 36.0,
      aerobic_deficit_focus: 'Builds competitive XC volume, hill power, and late-race aerobic durability.',
      schedule: [
        {
          day: 'Monday',
          name: 'Rest & Joint Durability',
          workout_type: 'rest',
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: 'Single-leg balance drills, ankle mobility, calf eccentrics, and foam rolling.',
          injury_prevention_note: 'Strengthens ankle stabilizers for uneven grass and mud.',
        },
        {
          day: 'Tuesday',
          name: 'Hill Power Repeats & Strides',
          workout_type: 'workout',
          distance_miles: 6.0,
          pace_target: 'Hard uphill drive (Mile effort)',
          hr_cap: 'Walk-down full recovery',
          description: '1.5 mi WU + 8 x 200m steep hill charges + 4x100m flat strides + 1.5 mi CD.',
          injury_prevention_note: 'Builds hip drive with less joint impact than flat sprints.',
        },
        {
          day: 'Wednesday',
          name: 'Aerobic Foundation Miles (Zone 2)',
          workout_type: 'easy',
          distance_miles: 6.0,
          pace_target: easyP,
          hr_cap: '< 145 bpm',
          description: 'Continuous aerobic running on soft grass/dirt trails.',
          injury_prevention_note: 'Soft surfaces cut tibial bone stress by ~30%.',
        },
        {
          day: 'Thursday',
          name: 'XC Threshold Cruise Repeats',
          workout_type: 'workout',
          distance_miles: 6.5,
          pace_target: tP,
          hr_cap: '180–185 bpm',
          description: `1.5 mi WU + 4 x 1-mile cruise repeats @ ${tP} with 75s jog rest + 1.5 mi CD.`,
          injury_prevention_note: 'Trains lactate clearance under undulating terrain.',
        },
        {
          day: 'Friday',
          name: 'Aerobic Recovery & Turnover',
          workout_type: 'recovery',
          distance_miles: 4.5,
          pace_target: recP,
          hr_cap: '< 140 bpm',
          description: 'Easy recovery jog on grass + 6 relaxed turf strides.',
          injury_prevention_note: 'Prepares musculoskeletal system for weekend long run.',
        },
        {
          day: 'Saturday',
          name: 'XC Over-Distance Long Run',
          workout_type: 'long_run',
          distance_miles: 8.5,
          pace_target: `${easyP} -> ${mP}`,
          hr_cap: 'Start < 145, finish < 160 bpm',
          description: 'Rolling terrain long run: 5.5 mi relaxed aerobic, final 3 mi steady progression.',
          injury_prevention_note: 'Builds eccentric quad control on steep descents.',
        },
        {
          day: 'Sunday',
          name: 'Aerobic Flush & Active Recovery',
          workout_type: 'easy',
          distance_miles: 4.5,
          pace_target: recP,
          hr_cap: '< 138 bpm',
          description: 'Gentle conversational aerobic run.',
          injury_prevention_note: 'Keep strictly aerobic; zero sprinting.',
        },
      ],
    };
  } else if (focus === 'half_marathon') {
    plan = {
      focus_id: 'half_marathon',
      title: 'Half Marathon Prep (Aerobic Durability)',
      target_race: 'Half Marathon 13.1 mi Build',
      weekly_mileage: 31.0,
      aerobic_deficit_focus: 'Safely bridges volume toward 30+ mpw without tendon breakdown.',
      schedule: [
        {
          day: 'Monday',
          name: 'Complete Rest',
          workout_type: 'rest',
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: 'Zero running. Foam roll IT bands, calves, and quads.',
          injury_prevention_note: 'Prevents overuse tendinitis during volume ramp.',
        },
        {
          day: 'Tuesday',
          name: 'Half Marathon Tempo Hold',
          workout_type: 'workout',
          distance_miles: 5.5,
          pace_target: mP,
          hr_cap: '170–178 bpm',
          description: `1.5 mi WU + 3 Miles continuous @ ${mP} + 1 mi CD.`,
          injury_prevention_note: 'Builds glycogen-sparing efficiency at sub-threshold speed.',
        },
        {
          day: 'Wednesday',
          name: 'Mid-Week Aerobic Cruise',
          workout_type: 'easy',
          distance_miles: 5.0,
          pace_target: easyP,
          hr_cap: '< 145 bpm (Zone 2)',
          description: 'Zone 2 continuous run with hydration.',
          injury_prevention_note: 'Expands stroke volume and capillary density.',
        },
        {
          day: 'Thursday',
          name: 'Aerobic Progression Run',
          workout_type: 'easy',
          distance_miles: 5.0,
          pace_target: `${easyP} -> ${mP}`,
          hr_cap: 'Finish < 170 bpm',
          description: 'Controlled negative split aerobic progression.',
          injury_prevention_note: 'Simulates late-race fatigue without track trauma.',
        },
        {
          day: 'Friday',
          name: 'Flush Run',
          workout_type: 'recovery',
          distance_miles: 3.0,
          pace_target: recP,
          hr_cap: '< 138 bpm',
          description: 'Gentle shakeout focusing on tall posture and cadence.',
          injury_prevention_note: 'Keeps connective tissues pliable for Saturday.',
        },
        {
          day: 'Saturday',
          name: 'Long Run Endurance Anchor',
          workout_type: 'long_run',
          distance_miles: 9.5,
          pace_target: easyP,
          hr_cap: '< 152 bpm',
          description: 'Step long run smoothly toward 9.5 mi. Carry hydration and 1 gel.',
          injury_prevention_note: 'Follows 10% progression guardrail.',
        },
        {
          day: 'Sunday',
          name: 'Easy Flush Run',
          workout_type: 'easy',
          distance_miles: 3.0,
          pace_target: recP,
          hr_cap: '< 135 bpm',
          description: 'Easy shakeout promoting recovery circulation.',
          injury_prevention_note: 'Low impact only.',
        },
      ],
    };
  } else {
    plan = {
      focus_id: 'base_building',
      title: 'Aerobic Base Building & Injury Immunity',
      target_race: 'Zone 2 Engine Construction',
      weekly_mileage: 23.0,
      aerobic_deficit_focus: 'Strictly cures low-aerobic shortage without high-injury speed spikes.',
      schedule: [
        {
          day: 'Monday',
          name: 'Rest & Prehab Day',
          workout_type: 'rest',
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: 'Zero running. 20 min core, glutes, and plantar fascia mobility.',
          injury_prevention_note: 'Prehab prevents overuse setbacks.',
        },
        {
          day: 'Tuesday',
          name: 'Easy Aerobic Base + Strides',
          workout_type: 'easy',
          distance_miles: 4.5,
          pace_target: easyP,
          hr_cap: '< 145 bpm (Strict Z2)',
          description: '4 miles strictly in Zone 2 + 4 x 80m relaxed strides on grass.',
          injury_prevention_note: 'Strides maintain turnover without lactic accumulation.',
        },
        {
          day: 'Wednesday',
          name: 'Continuous Aerobic Zone 2',
          workout_type: 'easy',
          distance_miles: 4.0,
          pace_target: easyP,
          hr_cap: '< 145 bpm',
          description: 'Continuous aerobic run. Walk hills if watch HR drifts above 145 bpm.',
          injury_prevention_note: 'Maximizes stroke volume without cortisol spikes.',
        },
        {
          day: 'Thursday',
          name: 'Sub-Threshold Aerobic Cruise',
          workout_type: 'easy',
          distance_miles: 4.5,
          pace_target: mP,
          hr_cap: '< 165 bpm (Zone 3 ceiling)',
          description: `1 mi WU + 2.5 mi steady @ ${mP} + 1 mi CD.`,
          injury_prevention_note: 'Comfortably below lactate threshold.',
        },
        {
          day: 'Friday',
          name: 'Recovery Jog',
          workout_type: 'recovery',
          distance_miles: 3.0,
          pace_target: recP,
          hr_cap: '< 138 bpm',
          description: 'Conversational shakeout.',
          injury_prevention_note: 'Boosts lymphatic drainage.',
        },
        {
          day: 'Saturday',
          name: 'Aerobic Base Long Run',
          workout_type: 'long_run',
          distance_miles: 6.0,
          pace_target: easyP,
          hr_cap: '< 148 bpm',
          description: 'Steady weekend anchor with relaxed breathing.',
          injury_prevention_note: 'Low joint impact while accumulating aerobic volume.',
        },
        {
          day: 'Sunday',
          name: 'Rest / Light Shakeout',
          workout_type: 'easy',
          distance_miles: 1.0,
          pace_target: recP,
          hr_cap: '< 130 bpm',
          description: 'Easy walk or light 1-mile jog.',
          injury_prevention_note: 'Resets the central nervous system.',
        },
      ],
    };
  }

  if (targetRace && targetRace.name) {
    let raceDay = targetRace.day;
    if (!raceDay || raceDay === 'Monday' || targetRace.name.toLowerCase().includes('pie')) {
      raceDay = 'Thursday';
    }
    return applyRaceTaper(plan, targetRace.name, targetRace.dist || '5K', raceDay, easyP);
  }
  return rotateWorkoutVariety(plan, zones, weekIndex);
}

/** Monday-aligned week counter so the workout rotation changes every calendar week. */
export function currentWeekIndex(date: Date = new Date()): number {
  return Math.floor((date.getTime() / 86400000 + 3) / 7);
}

interface QualitySession {
  name: string;
  main_miles: number;
  pace_target: string;
  hr_cap: string;
  main: string;
  note: string;
  /** Too intense for pure base-building weeks */
  hard?: boolean;
}

/** Diverse quality-session library, paced from the athlete's VDOT zones. */
export function buildWorkoutLibrary(zones: TrainingZones): Record<string, QualitySession[]> {
  const tP = zones.threshold.label;
  const iP = zones.interval.label;
  const rP = zones.repetition.label;
  const eP = zones.easy.label;
  const lt = '175–184 bpm (LT)';
  return {
    threshold: [
      { name: 'Threshold Cruise Intervals (5x1K)', main_miles: 3.6, pace_target: tP, hr_cap: lt, main: `5 x 1000m @ ${tP} with 60s jog recovery`, note: 'Comfortably hard — you should finish feeling you could do one more rep.' },
      { name: 'Threshold Mile Repeats (3x1 mi)', main_miles: 3.4, pace_target: tP, hr_cap: lt, main: `3 x 1 mile @ ${tP} with 90s jog recovery (add a 4th only if HR stays under LT)`, note: 'Even splits; do not race the last rep.' },
      { name: 'Continuous Tempo Run (20 min)', main_miles: 3.0, pace_target: tP, hr_cap: lt, main: `15–25 min continuous @ ${tP} (start at 15 min, build toward 25 over the block)`, note: 'Lock into rhythm; stop if form breaks down.' },
    ],
    vo2: [
      { name: 'VO2max Track Intervals (5x800m)', main_miles: 3.7, pace_target: iP, hr_cap: '> 185 bpm on reps', main: `5 x 800m @ ${iP} with 2:30 jog recovery`, note: 'Equal work:rest. Shut it down if pace fades more than 3s per rep.', hard: true },
      { name: 'VO2max Track Intervals (6x600m)', main_miles: 3.4, pace_target: iP, hr_cap: '> 185 bpm on reps', main: `6 x 600m @ ${iP} with 2:00 jog recovery`, note: 'Stay tall through the final 150m of each rep.', hard: true },
      { name: 'VO2max Track Intervals (4x1000m)', main_miles: 3.7, pace_target: iP, hr_cap: '> 185 bpm on reps', main: `4 x 1000m @ ${iP} with 3:00 jog recovery`, note: 'Longest VO2 stimulus — respect the full recovery.', hard: true },
      { name: 'VO2max Track Intervals (8x400m)', main_miles: 3.2, pace_target: `${zones.rep_400m} per 400m`, hr_cap: '> 185 bpm on reps', main: `8 x 400m @ ${zones.rep_400m} with 75–90s jog recovery`, note: 'Smooth and fast, not sprinting. Protect the hamstrings.', hard: true },
    ],
    speed: [
      { name: 'Speed Repetitions (10x200m)', main_miles: 2.5, pace_target: `${rP} (R-pace)`, hr_cap: 'Not HR-governed', main: `10 x 200m @ ${rP} with full 200m walk/jog recovery`, note: 'Full recovery is the point — quality mechanics over fatigue.', hard: true },
      { name: 'Speed Repetitions (6x300m)', main_miles: 2.3, pace_target: `${rP} (R-pace)`, hr_cap: 'Not HR-governed', main: `6 x 300m @ ${rP} with full 3:00 walk recovery`, note: 'Relaxed speed. Stop if any hamstring or calf tightness appears.', hard: true },
    ],
    fartlek: [
      { name: 'Fartlek Ladder (1-2-3-2-1 min)', main_miles: 3.0, pace_target: `Hard @ ${iP} · float @ ${eP}`, hr_cap: 'By feel', main: `1-2-3-2-1 min hard @ ${iP} effort with equal-time easy float, then repeat the 1-2-1 if fresh`, note: 'Run by effort on grass or trail — no watch-staring.' },
      { name: 'Fartlek (8x2 min hard / 1 min float)', main_miles: 3.4, pace_target: `Hard @ ${tP} · float @ ${eP}`, hr_cap: 'By feel', main: `8 x 2 min hard @ ${tP}–${iP} effort with 1 min float jog (never walk)`, note: 'The float is the workout — keep it honest but relaxed.' },
    ],
    hills: [
      { name: 'Hill Repeats (6–8x45–60s)', main_miles: 2.6, pace_target: '5K effort uphill', hr_cap: 'By effort', main: '6–8 x 45–60s uphill (4–6% grade) at 5K effort, easy jog down recovery + 4 x 100m flat strides', note: 'Drive knees, quick ground contact. Uphill running is low-impact strength work.' },
    ],
    progression: [
      { name: 'Progression Run (Easy → Steady → Threshold)', main_miles: 4.0, pace_target: `${eP} → ${zones.marathon.label} → ${tP}`, hr_cap: 'Finish at LT (< 184 bpm)', main: `2 mi easy @ ${eP}, 1.25 mi steady @ ${zones.marathon.label}, final 0.75 mi @ ${tP}`, note: 'Each segment should feel earned — never start fast.' },
    ],
  };
}

/**
 * Rotate the two weekly quality days (and the long run / an easy day) through the workout library so
 * consecutive weeks are not identical. Week 0 of every 4-week cycle keeps the base template.
 */
export function rotateWorkoutVariety(plan: TrainingPlan, zones: TrainingZones, weekIndex: number): TrainingPlan {
  const phase = ((weekIndex % 4) + 4) % 4;
  if (phase === 0) return plan;
  const cycle = Math.floor(weekIndex / 4);
  const lib = buildWorkoutLibrary(zones);
  const isBase = plan.focus_id === 'base_building';
  const pick = (key: string) => {
    const pool = lib[key].filter((s) => !isBase || !s.hard);
    return pool.length > 0 ? pool[((cycle % pool.length) + pool.length) % pool.length] : null;
  };
  // [first quality day, second quality day] for phases 1–3
  const rotation: Array<[string, string]> = [
    ['vo2', 'threshold'],
    ['fartlek', 'progression'],
    [cycle % 2 === 0 ? 'hills' : 'speed', 'threshold'],
  ];
  const [k1, k2] = rotation[phase - 1];
  const sessions = [pick(k1) ?? pick('fartlek'), pick(k2) ?? pick('progression')];
  // Offset the threshold pick on phase 3 so it differs from phase 1
  if (phase === 3 && k2 === 'threshold') sessions[1] = lib.threshold[(cycle + 1) % lib.threshold.length];

  let q = 0;
  let stridesAdded = false;
  const schedule = plan.schedule.map((w): DailyWorkout => {
    if (w.workout_type === 'workout' && q < sessions.length && sessions[q]) {
      const s = sessions[q++]!;
      const wu = 1.5;
      const cd = 1.0;
      return {
        ...w,
        name: s.name,
        warmup_miles: wu,
        main_miles: s.main_miles,
        cooldown_miles: cd,
        distance_miles: Number((wu + s.main_miles + cd).toFixed(1)),
        pace_target: s.pace_target,
        hr_cap: s.hr_cap,
        description: `• Warmup: ${wu} mi easy + dynamic drills + 4x100m strides.\n• Main Set: ${s.main}.\n• Cooldown: ${cd} mi easy flush.`,
        injury_prevention_note: s.note,
      };
    }
    if (w.workout_type === 'long_run' && phase === 2 && !isBase) {
      return {
        ...w,
        name: 'Long Run w/ Fast Finish',
        pace_target: `${zones.easy.label}, last 1–1.5 mi @ ${zones.marathon.label}`,
        description: `Easy aerobic running @ ${zones.easy.label}, then close the final 1–1.5 mi at steady ${zones.marathon.label}. Total distance unchanged.`,
        injury_prevention_note: 'Only pick it up if the legs feel good at halfway; otherwise keep it all easy.',
      };
    }
    if (w.workout_type === 'easy' && !stridesAdded && phase !== 2 && !/stride/i.test(`${w.name} ${w.description}`)) {
      stridesAdded = true;
      return {
        ...w,
        name: 'Easy Aerobic + Strides (4–6x100m)',
        description: `${w.description} Finish with 4–6 x 100m relaxed strides (full walk-back recovery).`,
      };
    }
    return w;
  });

  const weeklyMileage = Number(schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1));
  return { ...plan, schedule, weekly_mileage: weeklyMileage };
}

export function shouldEnforceRecoveryGate(health: HealthSnapshot | null | undefined): boolean {
  if (!health) return false;
  const isHrvLow =
    (health.hrv_last_night != null &&
      health.hrv_baseline_low != null &&
      health.hrv_last_night < health.hrv_baseline_low) ||
    health.hrv_status === 'LOW' ||
    health.hrv_status === 'UNBALANCED';
  const isSleepScoreLow =
    health.sleep_score != null && health.sleep_score < 60;
  const isSleepDurationLow =
    health.sleep_hours != null && health.sleep_hours < 5.5;

  return Boolean(isHrvLow || isSleepScoreLow || isSleepDurationLow);
}

export function enforceRecoveryGate(
  plan: TrainingPlan,
  health: HealthSnapshot | null | undefined,
  todayDay: string = getTodayDayName(),
  options?: { honorExplicitIntensity?: boolean }
): TrainingPlan {
  if (!shouldEnforceRecoveryGate(health)) return plan;

  const hrvVal = health?.hrv_last_night;
  const hrvBase = health?.hrv_baseline_low ?? 48;
  const sleepH = health?.sleep_hours;
  const sleepScore = health?.sleep_score;

  const reasonItems = [
    hrvVal != null && hrvVal < hrvBase ? `HRV ${hrvVal} ms (< ${hrvBase} ms baseline)` : '',
    sleepH != null && sleepH < 5.5 ? `Sleep ${sleepH}h (< 5.5h)` : '',
    sleepScore != null && sleepScore < 60 ? `Sleep Score ${sleepScore}/100` : '',
  ].filter(Boolean);
  const reasonDetail = reasonItems.join(', ');
  const normalizedToday = normalizeDayName(todayDay, getTodayDayName());

  const schedule = plan.schedule.map((workout) => {
    if (normalizeDayName(workout.day, '') === normalizedToday) {
      if (
        workout.workout_type === 'race' ||
        workout.workout_type === 'rest' ||
        workout.workout_type === 'cross_train'
      ) {
        return workout;
      }

      // Preserve user-pinned/customized days OR explicit intensity requests (advisory HRV guidance only)
      if (workout.user_customized || workout.is_pinned || options?.honorExplicitIntensity) {
        const advisory = `Advisory: ${reasonDetail || 'HRV/sleep below baseline'} — keep warm-up patient and adjust effort by feel.`;
        const existingNote = workout.injury_prevention_note || '';
        return existingNote.includes('Advisory:')
          ? workout
          : {
              ...workout,
              injury_prevention_note: existingNote ? `${existingNote} ${advisory}` : advisory,
            };
      }

      // When recovery is subdued on unpinned/default plans, suggest an easy recovery run rather than forcing rest
      const recoveryWorkout: DailyWorkout = {
        day: workout.day,
        name: 'Easy Recovery Run (HRV Adaptive)',
        workout_type: 'recovery',
        warmup_miles: 0.5,
        main_miles: 2.0,
        cooldown_miles: 0.5,
        distance_miles: 3.0,
        pace_target: 'Zone 1/2 Easy Recovery',
        hr_cap: '< 140 bpm',
        description: `• Warmup: 0.5 mi light jog + dynamic mobility.\n• Main Set: 2.0 mi conversational aerobic running. Keep heart rate strictly under 140 bpm. Promotes active blood flow, lymphatic drainage, and muscle recovery without autonomic strain.\n• Cooldown: 0.5 mi easy walk + light stretching and hydration.`,
        injury_prevention_note: `Active Recovery: Lower overnight HRV (${hrvVal ?? 32} ms) indicates subdued autonomic readiness, but gentle Zone 1–2 aerobic running promotes circulation and recovery without sympathetic strain.`,
        adaptation_reason: `Adapted to an Easy Recovery Run (${reasonDetail || 'HRV below baseline'}) so you can run comfortably today.`,
        ai_generated: true,
      };
      return recoveryWorkout;
    }
    return workout;
  });

  const stats = computeScheduleStats(schedule);
  return {
    ...plan,
    weekly_mileage: stats.totalMiles,
    schedule,
  };
}

export interface ParsedDayPromptResult {
  isTargeted: boolean;
  day: string;
  name: string;
  workout_type: WorkoutType;
  distance_miles: number;
  warmup_miles: number;
  main_miles: number;
  cooldown_miles: number;
  pace_target: string;
  hr_cap: string;
  description: string;
  injury_prevention_note: string;
  reason: string;
}

const PREPOSITION_DAY_RX =
  /\b(?:on|for|this|next|to|make|change|set|move|swap|replace|update|edit|give\s+me)\s+(monday|mon|tuesday|tues?|wednesday|wed|thursday|thu(?:rs?)?|friday|fri|saturday|sat|sunday|sun)\b/i;
const FULL_DAY_RX = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const SHORT_DAY_RX = /\b(mon|tues?|wed|thurs?|fri|sat|sun)\b/i;

function computeRunBreakdown(
  totalMiles: number,
  workoutType: WorkoutType
): { wu: number; main: number; cd: number; total: number } {
  if (workoutType === 'rest') return { wu: 0, main: 0, cd: 0, total: 0 };
  const safe = Math.max(0.5, Number(totalMiles.toFixed(1)));
  if (workoutType === 'cross_train') {
    return { wu: 0, main: Number(totalMiles.toFixed(1)), cd: 0, total: Number(totalMiles.toFixed(1)) };
  }
  if (workoutType === 'workout' || workoutType === 'race') {
    if (safe <= 2.5) {
      const wu = 0.5;
      const cd = 0.5;
      const main = Math.max(0.5, Number((safe - wu - cd).toFixed(1)));
      return { wu, main, cd, total: Number((wu + main + cd).toFixed(1)) };
    }
    const wu = safe >= 5 ? 1.5 : 1.0;
    const cd = safe >= 5 ? 1.0 : 0.5;
    const main = Math.max(0.5, Number((safe - wu - cd).toFixed(1)));
    return { wu, main, cd, total: Number((wu + main + cd).toFixed(1)) };
  }
  if (safe < 2.5) {
    return { wu: 0.5, main: Math.max(0.5, Number((safe - 0.5).toFixed(1))), cd: 0, total: Number(safe.toFixed(1)) };
  }
  const wu = workoutType === 'long_run' ? 1.0 : 0.5;
  const cd = 0.5;
  const main = Math.max(0.5, Number((safe - wu - cd).toFixed(1)));
  return { wu, main, cd, total: Number((wu + main + cd).toFixed(1)) };
}

/**
 * Deterministically parse single-day customization or workout modification prompts into a full
 * structured DailyWorkout update respecting target day, workout category, and mileage.
 */
export function parseDayTargetedPrompt(
  prompt: string,
  defaultDay: string = getTodayDayName(),
  zones?: TrainingZones
): ParsedDayPromptResult {
  const raw = String(prompt ?? '').trim();
  const lower = raw.toLowerCase();
  const resolvedDefault = normalizeDayName(defaultDay, getTodayDayName());

  let matchedDay: string | null = null;
  const prepMatch = raw.match(PREPOSITION_DAY_RX);
  if (prepMatch) {
    matchedDay = normalizeDayName(prepMatch[1], resolvedDefault);
  } else if (/\btomorrow\b/i.test(lower)) {
    const idx = DAYS_OF_WEEK.indexOf(resolvedDefault as (typeof DAYS_OF_WEEK)[number]);
    matchedDay = DAYS_OF_WEEK[(Math.max(0, idx) + 1) % DAYS_OF_WEEK.length];
  } else if (/\btoday\b/i.test(lower)) {
    matchedDay = resolvedDefault;
  } else {
    const fullMatch = raw.match(FULL_DAY_RX);
    if (fullMatch) {
      matchedDay = normalizeDayName(fullMatch[1], resolvedDefault);
    } else {
      const shortMatch = raw.match(SHORT_DAY_RX);
      if (shortMatch) {
        matchedDay = normalizeDayName(shortMatch[1], resolvedDefault);
      }
    }
  }
  const day = matchedDay ?? resolvedDefault;

  // Strip track interval rep syntax like "5x800m" or "1600m" so meters are never read as miles
  const strippedForMiles = raw
    .replace(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:m|meters?)?\b/gi, ' ')
    .replace(/\b(?:100|200|300|400|600|800|1000|1200|1500|1600|2000|3000|3200|5000|10000)\s*m\b/gi, ' ');

  let explicitMiles: number | undefined;
  const milesMatch = strippedForMiles.match(/(\d+(?:\.\d+)?)\s*(?:miles?|mi\b|m\b)/i);
  const kmMatch = strippedForMiles.match(/(\d+(?:\.\d+)?)\s*(?:kms?|km\b)/i);
  if (milesMatch) {
    const parsed = parseFloat(milesMatch[1]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 50) explicitMiles = parsed;
  } else if (kmMatch) {
    const parsed = parseFloat(kmMatch[1]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 80) {
      explicitMiles = Number((parsed * 0.621371).toFixed(1));
    }
  }

  const wantsNoRest = /\b(no\s+rest|not\s+a?\s*rest|replace\s+rest|skip\s+rest|active\s+day)\b/i.test(lower);
  const hasExplicitAction =
    Boolean(matchedDay) ||
    explicitMiles !== undefined ||
    wantsNoRest ||
    /\b(change|modify|update|make|switch|set|swap|replace|turn|convert|give|today|tomorrow|harder|hard|quality|tempo|threshold|interval|track|speed|repeat|fartlek|long\s+run|recovery|shakeout|rest\s+day|day\s+off|cross[\s-]*train|cycl(?:e|ing)|bike|swim|strength|lift|yoga|row|race|time\s+trial|workout|session)\b/i.test(
      lower
    );

  const repMatch = raw.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(m|meters?|mi|miles?|k|km)?\b/i);
  const repLabel = repMatch ? `${repMatch[1]}x${repMatch[2]}${repMatch[3] || 'm'}` : '';

  let workoutType: WorkoutType = 'easy';
  if (!wantsNoRest && /\b(rest(?:\s+day)?|day\s+off|off\s+day|take\s+off|no\s+run)\b/i.test(lower)) {
    workoutType = 'rest';
  } else if (
    /\b(cross[\s-]*train(?:ing)?|cycl(?:e|ing)|bike|biking|swim(?:ming)?|strength|lift(?:ing)?|yoga|row(?:ing)?|elliptical)\b/i.test(
      lower
    )
  ) {
    workoutType = 'cross_train';
  } else if (
    /\b(race(?:\s+day)?|time\s+trial|invitational|meet)\b/i.test(lower) &&
    !/\b(interval|tempo|threshold|repeat)\b/i.test(lower)
  ) {
    workoutType = 'race';
  } else if (
    repMatch ||
    /\b(interval|intervals|track|speed|repeat|repeats|fartlek|vo2|tempo|threshold|lactate|cruise|progression|harder|hard|quality|intense|tougher|workout)\b/i.test(
      lower
    )
  ) {
    workoutType = 'workout';
  } else if (/\b(long(?:\s+run)?|endurance)\b/i.test(lower)) {
    workoutType = 'long_run';
  } else if (/\b(recovery|shakeout|very\s+easy|light\s+jog)\b/i.test(lower)) {
    workoutType = 'recovery';
  }

  const easyPace = zones?.easy?.label || '8:20–9:00/mi';
  const thresholdPace = zones?.threshold?.label || '6:40–6:55/mi';
  const intervalPace = zones?.interval?.label || '6:05–6:25/mi';
  const longPace = zones?.marathon?.label || zones?.easy?.label || '7:55–8:35/mi';

  if (workoutType === 'rest') {
    return {
      isTargeted: hasExplicitAction,
      day,
      name: 'Rest & Mobility Day',
      workout_type: 'rest',
      distance_miles: 0,
      warmup_miles: 0,
      main_miles: 0,
      cooldown_miles: 0,
      pace_target: 'Off (Full Rest)',
      hr_cap: 'Rest',
      description:
        '• Warmup: Off.\n• Main Set: Full rest from running — optional 15 min light mobility or walk.\n• Cooldown: Prioritize hydration and sleep.',
      injury_prevention_note: 'Athlete-requested rest day for targeted tissue & nervous system recovery.',
      reason: `Updated ${day} to a Rest Day per your request.`,
    };
  }

  if (workoutType === 'cross_train') {
    const miles = explicitMiles ?? 0;
    const minMatch = raw.match(/\b(\d+)\s*(?:min|minute|minutes)\b/i);
    const durationLabel = minMatch ? `${minMatch[1]} min` : '45 min';
    const activity = /\bswim/i.test(lower)
      ? 'Pool Swim / Aqua Jogging'
      : /\b(strength|lift)/i.test(lower)
        ? 'Strength & Core Conditioning'
        : /\byoga/i.test(lower)
          ? 'Mobility & Yoga Flow'
          : 'Aerobic Cycling / Cross-Train';
    return {
      isTargeted: hasExplicitAction,
      day,
      name: `${activity} (${durationLabel})`,
      workout_type: 'cross_train',
      distance_miles: miles,
      warmup_miles: 0,
      main_miles: miles,
      cooldown_miles: 0,
      pace_target: 'Zone 1–2 Low-Impact Effort',
      hr_cap: '< 145 bpm',
      description: `• Warmup: 10 min easy dynamic prep.\n• Main Set: ${durationLabel} ${activity.toLowerCase()} maintaining smooth Zone 1–2 aerobic output with zero impact loading.\n• Cooldown: 10 min foam rolling & hip mobility.`,
      injury_prevention_note:
        'Builds aerobic mitochondria and joint stability while giving impact structures a low-stress day.',
      reason: `Updated ${day} to ${activity} (${durationLabel}).`,
    };
  }

  if (workoutType === 'race') {
    const raceMiles = explicitMiles ?? 3.1;
    const { wu, main, cd, total } = computeRunBreakdown(raceMiles + 2.5, 'race');
    return {
      isTargeted: hasExplicitAction,
      day,
      name: 'Race Day / Time Trial Effort',
      workout_type: 'race',
      distance_miles: explicitMiles != null ? Number((wu + explicitMiles + cd).toFixed(1)) : total,
      warmup_miles: wu,
      main_miles: explicitMiles ?? main,
      cooldown_miles: cd,
      pace_target: zones?.repetition?.label || zones?.interval?.label || 'Goal Race Pace',
      hr_cap: 'Race Effort (Max Safe)',
      description: `• Warmup: ${wu} mi progressive jog + 4x100m strides.\n• Main Set: ${explicitMiles ?? main} mi race effort — commit cleanly from 400m onward.\n• Cooldown: ${cd} mi easy flush jog + fueling.`,
      injury_prevention_note: 'Complete structured warm-up strides prior to race start to prime neuromuscular firing.',
      reason: `Scheduled Race Day on ${day}.`,
    };
  }

  if (workoutType === 'workout') {
    const isTrack =
      Boolean(repMatch) || /\b(interval|intervals|track|speed|repeat|repeats|fartlek|vo2|800m|400m|1000m|1600m)\b/i.test(lower);
    const defaultTotal = isTrack ? 6.0 : 6.5;
    const targetTotal = explicitMiles ?? defaultTotal;
    const { wu, main, cd, total } = computeRunBreakdown(targetTotal, 'workout');
    const workoutName = isTrack
      ? repLabel
        ? `Track Speed Intervals (${repLabel})`
        : 'Track Speed & VO2 Intervals'
      : /\b(tempo|threshold|lactate|cruise)\b/i.test(lower)
        ? 'Lactate Threshold Tempo Workout'
        : 'Quality Threshold & Progression Workout';
    const mainSetText = isTrack
      ? `${main} mi total interval work (${repLabel || '5x800m @ 5K effort'} w/ 400m easy jog recoveries)`
      : `${main} mi continuous lactate-threshold tempo + steady closing strides`;
    return {
      isTargeted: hasExplicitAction,
      day,
      name: workoutName,
      workout_type: 'workout',
      distance_miles: total,
      warmup_miles: wu,
      main_miles: main,
      cooldown_miles: cd,
      pace_target: isTrack ? `${intervalPace} (Track / VO2)` : `${thresholdPace} (Threshold)`,
      hr_cap: isTrack ? '175–188 bpm' : '165–178 bpm',
      description: `• Warmup: ${wu} mi easy build + A/B skips + 4x80m strides.\n• Main Set: ${mainSetText}.\n• Cooldown: ${cd} mi easy aerobic jog + calves/hamstring mobility.`,
      injury_prevention_note:
        'Full progressive warm-up before hitting quality paces; relax shoulders and maintain high cadence.',
      reason: `Updated ${day} to ${workoutName} (${total} mi) per your request.`,
    };
  }

  if (workoutType === 'long_run') {
    const targetTotal = explicitMiles ?? 10.0;
    const { wu, main, cd, total } = computeRunBreakdown(targetTotal, 'long_run');
    return {
      isTargeted: hasExplicitAction,
      day,
      name: 'Aerobic Endurance Long Run',
      workout_type: 'long_run',
      distance_miles: total,
      warmup_miles: wu,
      main_miles: main,
      cooldown_miles: cd,
      pace_target: `${longPace} (Steady Aerobic)`,
      hr_cap: '145–160 bpm',
      description: `• Warmup: ${wu} mi gentle relaxed settling miles.\n• Main Set: ${main} mi sustained aerobic cruise, finishing controlled.\n• Cooldown: ${cd} mi easy walk/jog + carb & electrolyte recovery.`,
      injury_prevention_note: 'Open the first 2 miles patiently so cardiac drift stays controlled late.',
      reason: `Updated ${day} to ${total} mi Aerobic Long Run.`,
    };
  }

  if (workoutType === 'recovery') {
    const targetTotal = explicitMiles ?? 3.5;
    const { wu, main, cd, total } = computeRunBreakdown(targetTotal, 'recovery');
    return {
      isTargeted: hasExplicitAction,
      day,
      name: 'Easy Recovery Shakeout',
      workout_type: 'recovery',
      distance_miles: total,
      warmup_miles: wu,
      main_miles: main,
      cooldown_miles: cd,
      pace_target: `${easyPace} (Zone 1–2)`,
      hr_cap: '< 140 bpm',
      description: `• Warmup: ${wu} mi gentle walk-jog.\n• Main Set: ${main} mi light Zone 1–2 recovery miles on soft terrain.\n• Cooldown: ${cd} mi easy walk + mobility.`,
      injury_prevention_note: 'Prioritize low impact and smooth relaxed turnover; skip strides if tired.',
      reason: `Updated ${day} to ${total} mi Easy Recovery Run.`,
    };
  }

  const targetTotal = explicitMiles ?? 4.5;
  const { wu, main, cd, total } = computeRunBreakdown(targetTotal, 'easy');
  return {
    isTargeted: hasExplicitAction,
    day,
    name: 'Easy Aerobic Base Run',
    workout_type: 'easy',
    distance_miles: total,
    warmup_miles: wu,
    main_miles: main,
    cooldown_miles: cd,
    pace_target: `${easyPace} (Conversational Aerobic)`,
    hr_cap: '135–152 bpm',
    description: `• Warmup: ${wu} mi relaxed easy jog.\n• Main Set: ${main} mi smooth conversational aerobic miles.\n• Cooldown: ${cd} mi easy jog + calf/hip mobility.`,
    injury_prevention_note: 'Keep breathing rhythmic and easy enough to speak in full sentences.',
    reason: `Updated ${day} to ${total} mi Easy Aerobic Run.`,
  };
}
