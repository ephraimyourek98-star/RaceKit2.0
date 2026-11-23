import type {
  DailyWorkout,
  TrainingFocusId,
  TrainingPlan,
  TrainingZones,
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

export const TRAINING_FOCUS_LABELS: Record<TrainingFocusId, string> = {
  track_mid: 'Track Mid-Distance (800m / 1600m / Mile)',
  track_long: 'Track Distance (3200m / 2 Mile / 5000m)',
  xc: 'Cross Country 5K (Hills / Grass / Power)',
  half_marathon: 'Half Marathon Prep (Aerobic Durability)',
  base_building: 'Aerobic Base Building & Injury Immunity',
};

function distToRaceMiles(distLabel: string): number {
  const map: Record<string, number> = {
    '800m': 2.5,
    '1600m': 3.0,
    Mile: 3.0,
    '3200m': 4.0,
    '5K': 5.1,
    '10K': 7.7,
    'Half Marathon': 14.1,
  };
  return map[distLabel] ?? 4.5;
}

export function getTodayDayName(): string {
  const idx = new Date().getDay();
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][idx];
}

export function applyRaceTaper(
  plan: TrainingPlan,
  raceName: string,
  raceDist: string,
  raceDay: string,
  easyPace = '8:00–8:30/mi'
): TrainingPlan {
  const raceIdx = Math.max(0, DAYS_OF_WEEK.indexOf(raceDay as (typeof DAYS_OF_WEEK)[number]));
  const raceTotalMi = distToRaceMiles(raceDist);

  const schedule: DailyWorkout[] = DAYS_OF_WEEK.map((dayName, i) => {
    const diff = (i - raceIdx + 7) % 7;
    const daysBefore = diff > 3 ? 7 - diff : -diff;

    if (daysBefore === 0) {
      return {
        day: dayName,
        name: `Race Day: ${raceName} (${raceDist})`,
        workout_type: 'race',
        distance_miles: raceTotalMi,
        pace_target: 'Goal Race Execution',
        hr_cap: 'Race Effort',
        description: `1.2 mi progressive warm-up + dynamic drills + 4x100m strides. Execute ${raceDist} race plan, followed by 0.8 mi cooldown.`,
        injury_prevention_note: 'Pre-race meal 3h prior. Double-knot racing shoes; electrolytes 60 min out.',
      };
    }
    if (daysBefore === 1) {
      return {
        day: dayName,
        name: 'Pre-Race Shakeout & Strides',
        workout_type: 'easy',
        distance_miles: 2.0,
        pace_target: `${easyPace} + 4x100m strides`,
        hr_cap: '< 140 bpm',
        description: '1.5 mi light shakeout jog + 4x100m smooth neuromuscular strides in racing footwear.',
        injury_prevention_note: 'Zero straining on strides — stay tall, bouncy, and relaxed.',
      };
    }
    if (daysBefore === 2) {
      return {
        day: dayName,
        name: 'Taper Sharpening (Mini-Tempo)',
        workout_type: 'workout',
        distance_miles: 3.5,
        pace_target: '2 x 800m @ goal race pace (3 min rest)',
        hr_cap: 'Controlled · Low fatigue',
        description: '1.5 mi WU + 2 x 800m at goal race pace with full standing recovery + 1.0 mi CD.',
        injury_prevention_note: 'Primes fast-twitch motor units without depleting muscle glycogen.',
      };
    }
    if (daysBefore === 3) {
      if (dayName === 'Monday') {
        return {
          day: dayName,
          name: 'Full Rest & Prehab Mobility',
          workout_type: 'rest',
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
        distance_miles: 3.0,
        pace_target: easyPace,
        hr_cap: '< 145 bpm',
        description: 'Short relaxed aerobic flush on soft grass or trail.',
        injury_prevention_note: 'Volume trimmed ~35% for glycogen supercompensation.',
      };
    }
    if (dayName === 'Monday') {
      return {
        day: dayName,
        name: 'Full Rest & Prehab Mobility',
        workout_type: 'rest',
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
        distance_miles: 2.0,
        pace_target: 'Slow jog or 30 min brisk walk',
        hr_cap: '< 130 bpm',
        description: 'Light flush to clear metabolites + 15 min mobility and rehydration.',
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
  targetRace?: { name: string; dist: string; day: string } | null
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

  if (targetRace && targetRace.name && targetRace.day) {
    return applyRaceTaper(plan, targetRace.name, targetRace.dist || '5K', targetRace.day, easyP);
  }
  return plan;
}
