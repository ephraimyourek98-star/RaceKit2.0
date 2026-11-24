import { useState, useEffect } from 'react';
import { X, Check, RotateCcw, Sparkles, Pin } from 'lucide-react';
import type { DailyWorkout, TrainingZones, WorkoutType } from '../lib/types';
import { DAYS_OF_WEEK } from '../lib/trainingPlans';

interface DayEditorModalProps {
  isOpen: boolean;
  workout: DailyWorkout | null;
  zones?: TrainingZones | null;
  isCustomized: boolean;
  onClose: () => void;
  onSave: (updated: DailyWorkout) => void;
  onResetDay: (day: string) => void;
}

interface TypeOption {
  value: WorkoutType;
  subType?: 'tempo' | 'intervals';
  label: string;
  badgeColor: string;
  defaultPace: (z?: TrainingZones | null) => string;
  defaultHr: string;
  defaultDist: number;
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    value: 'easy',
    label: 'Easy Run (Zone 2)',
    badgeColor: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    defaultPace: (z) => z?.easy?.label ?? '7:40–8:15/mi',
    defaultHr: '< 145 bpm (Zone 2)',
    defaultDist: 4.0,
  },
  {
    value: 'recovery',
    label: 'Recovery Run (Zone 1–2)',
    badgeColor: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    defaultPace: (z) => z?.recovery?.label ?? '8:45–9:15/mi',
    defaultHr: '< 140 bpm (Zone 1–2)',
    defaultDist: 3.0,
  },
  {
    value: 'workout',
    subType: 'tempo',
    label: 'Tempo / Threshold',
    badgeColor: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    defaultPace: (z) => `${z?.threshold?.label ?? '6:20–6:35/mi'} (Threshold)`,
    defaultHr: '< 185 bpm (LT)',
    defaultDist: 5.5,
  },
  {
    value: 'workout',
    subType: 'intervals',
    label: 'Intervals / Speed',
    badgeColor: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    defaultPace: (z) => `${z?.interval?.label ?? '5:50–6:05/mi'} (Interval)`,
    defaultHr: 'Max effort reps',
    defaultDist: 5.0,
  },
  {
    value: 'long_run',
    label: 'Long Run',
    badgeColor: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
    defaultPace: (z) => z?.easy?.label ?? '7:45–8:15/mi',
    defaultHr: '< 150 bpm (Zone 2)',
    defaultDist: 7.5,
  },
  {
    value: 'race',
    label: 'Race Day',
    badgeColor: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    defaultPace: () => 'Goal Race Pace (~5:58–6:05/mi)',
    defaultHr: 'Race Effort (Max VO2)',
    defaultDist: 5.6,
  },
  {
    value: 'cross_train',
    label: 'Strength / Cross-Train',
    badgeColor: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
    defaultPace: () => 'Strength & Prehab',
    defaultHr: 'Controlled effort',
    defaultDist: 0.0,
  },
  {
    value: 'rest',
    label: 'Rest & Mobility',
    badgeColor: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
    defaultPace: () => 'Off',
    defaultHr: 'Rest',
    defaultDist: 0.0,
  },
];

export function DayEditorModal({
  isOpen,
  workout,
  zones,
  isCustomized,
  onClose,
  onSave,
  onResetDay,
}: DayEditorModalProps) {
  const [day, setDay] = useState(workout?.day ?? 'Monday');
  const [workoutType, setWorkoutType] = useState<WorkoutType>(workout?.workout_type ?? 'easy');
  const [name, setName] = useState(workout?.name ?? '');
  const [distance, setDistance] = useState(workout?.distance_miles ?? 4.0);
  const [warmup, setWarmup] = useState(workout?.warmup_miles ?? 0.5);
  const [mainMiles, setMainMiles] = useState(workout?.main_miles ?? 3.0);
  const [cooldown, setCooldown] = useState(workout?.cooldown_miles ?? 0.5);
  const [paceTarget, setPaceTarget] = useState(workout?.pace_target ?? '');
  const [hrCap, setHrCap] = useState(workout?.hr_cap ?? '');
  const [description, setDescription] = useState(workout?.description ?? '');
  const [injuryNote, setInjuryNote] = useState(workout?.injury_prevention_note ?? '');

  useEffect(() => {
    if (workout) {
      setDay(workout.day);
      setWorkoutType(workout.workout_type);
      setName(workout.name);
      setDistance(workout.distance_miles);
      setWarmup(workout.warmup_miles ?? (workout.distance_miles >= 3 ? 0.5 : 0));
      setMainMiles(
        workout.main_miles ??
          Math.max(0, workout.distance_miles - (workout.warmup_miles ?? 0) - (workout.cooldown_miles ?? 0))
      );
      setCooldown(workout.cooldown_miles ?? (workout.distance_miles >= 3 ? 0.5 : 0));
      setPaceTarget(workout.pace_target);
      setHrCap(workout.hr_cap);
      setDescription(workout.description);
      setInjuryNote(workout.injury_prevention_note);
    }
  }, [workout]);

  if (!isOpen || !workout) return null;

  const handleTypeSelect = (opt: TypeOption) => {
    setWorkoutType(opt.value);
    setPaceTarget(opt.defaultPace(zones));
    setHrCap(opt.defaultHr);

    if (opt.value === 'rest') {
      setDistance(0);
      setWarmup(0);
      setMainMiles(0);
      setCooldown(0);
      setName('Rest & Mobility Day');
      setDescription('Zero running. 20 min foam rolling, hip mobility, and tissue recovery.');
      setInjuryNote('Rest enables tissue remodeling and glycogen supercompensation.');
    } else if (opt.value === 'cross_train') {
      setDistance(0);
      setWarmup(0);
      setMainMiles(0);
      setCooldown(0);
      setName('Strength & Cross-Training');
      setDescription('Full body resistance, core stability, single-leg balance, and mobility work.');
      setInjuryNote('Builds injury resilience without running impact.');
    } else {
      const targetDist = distance > 0 ? distance : opt.defaultDist;
      setDistance(targetDist);
      const wu = opt.value === 'race' || opt.value === 'workout' ? 1.5 : (targetDist >= 3 ? 0.5 : 0);
      const cd = opt.value === 'race' || opt.value === 'workout' ? 1.0 : (targetDist >= 3 ? 0.5 : 0);
      const main = Math.max(0.1, Number((targetDist - wu - cd).toFixed(1)));
      setWarmup(wu);
      setCooldown(cd);
      setMainMiles(main);

      if (opt.value === 'race') {
        setName('Race Day Execution');
        setDescription(`• Warmup: ${wu} mi progressive warm-up + drills + strides.\n• Main Set: ${main} mi race effort at Goal Pace.\n• Cooldown: ${cd} mi easy flush.`);
        setInjuryNote('Pre-race hydration and dynamic mobility. Double-knot racing shoes.');
      } else if (opt.value === 'workout') {
        setName(opt.subType === 'intervals' ? 'Track VO2max Speed Intervals' : 'Threshold Quality Session');
        setDescription(`• Warmup: ${wu} mi progressive jog + dynamic drills + strides.\n• Main Set: ${main} mi quality effort at target pace.\n• Cooldown: ${cd} mi easy flush.`);
        setInjuryNote('Controlled effort; finish feeling you could do one more rep.');
      } else if (opt.value === 'long_run') {
        setName('Aerobic Long Run');
        setDescription(`• Warmup: ${wu} mi gentle ramp.\n• Main Set: ${main} mi continuous Zone 2 aerobic running.\n• Cooldown: ${cd} mi walk + mobility.`);
        setInjuryNote('Keep strictly conversational; hydrate every 20-30 minutes.');
      } else if (opt.value === 'recovery') {
        setName('Active Recovery Shakeout');
        setDescription(`• Warmup: ${wu} mi light jog.\n• Main Set: ${main} mi conversational recovery flush.\n• Cooldown: ${cd} mi walk and stretching.`);
        setInjuryNote('Promotes blood flow and lymphatic drainage without sympathetic strain.');
      } else {
        setName('Zone 2 Aerobic Base Run');
        setDescription(`• Warmup: ${wu} mi progressive jog.\n• Main Set: ${main} mi continuous aerobic base running.\n• Cooldown: ${cd} mi walk and light stretching.`);
        setInjuryNote('Builds capillary density and mitochondrial base.');
      }
    }
  };

  const handleTotalDistanceChange = (newTotal: number) => {
    const val = Math.max(0, Number(newTotal.toFixed(1)));
    setDistance(val);
    if (val === 0) {
      setWarmup(0);
      setMainMiles(0);
      setCooldown(0);
      return;
    }
    const wu = workoutType === 'workout' || workoutType === 'race' ? 1.5 : (val >= 3 ? 0.5 : 0);
    const cd = workoutType === 'workout' || workoutType === 'race' ? 1.0 : (val >= 3 ? 0.5 : 0);
    const main = Math.max(0, Number((val - wu - cd).toFixed(1)));
    setWarmup(wu);
    setCooldown(cd);
    setMainMiles(main);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalDist = workoutType === 'rest' ? 0 : Number((warmup + mainMiles + cooldown).toFixed(1));

    const updated: DailyWorkout = {
      day,
      name: name.trim() || (workoutType === 'rest' ? 'Rest Day' : 'Custom Run'),
      workout_type: workoutType,
      distance_miles: finalDist,
      warmup_miles: workoutType === 'rest' ? 0 : warmup,
      main_miles: workoutType === 'rest' ? 0 : mainMiles,
      cooldown_miles: workoutType === 'rest' ? 0 : cooldown,
      pace_target: paceTarget.trim() || (workoutType === 'rest' ? 'Off' : 'Conversational pace'),
      hr_cap: hrCap.trim() || (workoutType === 'rest' ? 'Rest' : '< 150 bpm'),
      description: description.trim() || 'Customized workout session.',
      injury_prevention_note: injuryNote.trim() || 'Listen to body signals and stay hydrated.',
      is_pinned: true,
      user_customized: true,
      ai_generated: true,
      adaptation_reason: `Athlete customized ${day} (${finalDist} mi, ${workoutType}).`,
    };

    onSave(updated);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="day-editor-title"
    >
      <div className="relative w-full max-w-xl rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 shadow-2xl space-y-5 my-8">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#0A84FF]/15 border border-[#0A84FF]/30 text-[#0A84FF]">
              <Pin className="h-4 w-4" />
            </div>
            <div>
              <h2 id="day-editor-title" className="text-base font-bold text-white">
                Customize {day} Workout
              </h2>
              <p className="text-xs text-[#8E8E93]">
                Full per-day customization · Saved and pinned across plan regenerations
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-[#8E8E93] hover:bg-white/10 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Day of Week Selector */}
          <div>
            <label className="block text-xs font-semibold text-[#8E8E93] mb-1.5">
              Target Day of Week
            </label>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-1">
              {DAYS_OF_WEEK.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  className={`rounded-xl py-1.5 px-2 text-xs font-bold transition-all text-center ${
                    day === d
                      ? 'bg-[#0A84FF] text-white shadow-sm'
                      : 'border border-white/10 bg-[#2C2C2E] text-[#8E8E93] hover:text-white'
                  }`}
                >
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          {/* Workout Type Selector */}
          <div>
            <label className="block text-xs font-semibold text-[#8E8E93] mb-1.5">
              Workout Category (Any Type)
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {TYPE_OPTIONS.map((opt, i) => {
                const isSelected =
                  workoutType === opt.value &&
                  (opt.subType ? name.toLowerCase().includes(opt.subType) : true);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleTypeSelect(opt)}
                    className={`rounded-2xl border p-2.5 text-left transition-all flex flex-col justify-between ${
                      isSelected
                        ? 'border-[#0A84FF] bg-[#0A84FF]/15 text-white shadow-sm'
                        : 'border-white/10 bg-[#2C2C2E] text-slate-300 hover:border-white/20'
                    }`}
                  >
                    <span className="text-xs font-bold">{opt.label}</span>
                    <span className="text-[10px] text-[#8E8E93] font-mono mt-1">
                      {opt.value === 'rest'
                        ? '0 mi off'
                        : opt.value === 'cross_train'
                          ? 'Non-impact'
                          : `${opt.defaultDist} mi`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Workout Name & Total Distance */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-[#8E8E93] mb-1">
                Workout Title
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Zone 2 Aerobic Base Run"
                className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs text-white placeholder:text-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#8E8E93] mb-1">
                Total Distance (mi)
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="50"
                value={distance}
                disabled={workoutType === 'rest'}
                onChange={(e) => handleTotalDistanceChange(parseFloat(e.target.value) || 0)}
                className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 font-mono text-xs font-bold text-white disabled:opacity-40 focus:border-[#0A84FF] focus:outline-none"
              />
            </div>
          </div>

          {/* Mileage Breakdown (WU / Main / CD) - visible only for runs */}
          {workoutType !== 'rest' && workoutType !== 'cross_train' && (
            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E]/60 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-[#8E8E93]">
                <span className="font-semibold">Distance Breakdown</span>
                <span className="font-mono text-[11px] text-[#30D158]">
                  Total: {(warmup + mainMiles + cooldown).toFixed(1)} mi
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-0.5">Warmup (mi)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={warmup}
                    onChange={(e) => {
                      const w = Math.max(0, parseFloat(e.target.value) || 0);
                      setWarmup(w);
                      setDistance(Number((w + mainMiles + cooldown).toFixed(1)));
                    }}
                    className="w-full rounded-lg border border-white/10 bg-[#1C1C1E] px-2 py-1 font-mono text-xs text-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-0.5">Main Set (mi)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={mainMiles}
                    onChange={(e) => {
                      const m = Math.max(0, parseFloat(e.target.value) || 0);
                      setMainMiles(m);
                      setDistance(Number((warmup + m + cooldown).toFixed(1)));
                    }}
                    className="w-full rounded-lg border border-white/10 bg-[#1C1C1E] px-2 py-1 font-mono text-xs text-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-0.5">Cooldown (mi)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={cooldown}
                    onChange={(e) => {
                      const c = Math.max(0, parseFloat(e.target.value) || 0);
                      setCooldown(c);
                      setDistance(Number((warmup + mainMiles + c).toFixed(1)));
                    }}
                    className="w-full rounded-lg border border-white/10 bg-[#1C1C1E] px-2 py-1 font-mono text-xs text-white focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Pace Target & HR Cap */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[#8E8E93] mb-1">
                Pace Target
              </label>
              <input
                type="text"
                value={paceTarget}
                onChange={(e) => setPaceTarget(e.target.value)}
                placeholder="e.g. 7:40–8:15/mi or Off"
                className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs text-white focus:border-[#0A84FF] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#8E8E93] mb-1">
                Heart Rate Cap
              </label>
              <input
                type="text"
                value={hrCap}
                onChange={(e) => setHrCap(e.target.value)}
                placeholder="e.g. < 145 bpm or Rest"
                className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs text-white focus:border-[#0A84FF] focus:outline-none"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-[#8E8E93] mb-1">
              Workout Structure &amp; Description
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] p-3 text-xs text-white placeholder:text-[#8E8E93] focus:border-[#0A84FF] focus:outline-none leading-relaxed"
            />
          </div>

          {/* Injury Prevention / Guardrail Note */}
          <div>
            <label className="block text-xs font-semibold text-[#8E8E93] mb-1">
              Guardrail / Form Cue
            </label>
            <input
              type="text"
              value={injuryNote}
              onChange={(e) => setInjuryNote(e.target.value)}
              placeholder="e.g. Strict Zone 2 discipline; walk if HR exceeds 145 bpm"
              className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs text-white focus:border-[#0A84FF] focus:outline-none"
            />
          </div>

          {/* Action Footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/10">
            {isCustomized ? (
              <button
                type="button"
                onClick={() => {
                  onResetDay(day);
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset Day to Template
              </button>
            ) : (
              <div className="text-[11px] text-[#8E8E93]">
                Pins this day to your custom schedule
              </div>
            )}

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0A84FF] px-4 py-2 text-xs font-bold text-white hover:brightness-110 shadow-sm"
              >
                <Check className="h-3.5 w-3.5" />
                Save &amp; Pin Day
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
