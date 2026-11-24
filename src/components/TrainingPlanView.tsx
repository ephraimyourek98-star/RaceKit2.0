import { useState, useEffect, useMemo } from 'react';
import {
  Activity,
  AlertCircle,
  Calendar,
  ChevronRight,
  Download,
  Flag,
  Flame,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Watch,
  X,
} from 'lucide-react';
import {
  TRAINING_FOCUS_LABELS,
  computeScheduleStats,
  filterRemainingSchedule,
  getRemainingDaysOfWeek,
  getTodayDayName,
  normalizeDayName,
} from '../lib/trainingPlans';
import { buildGarminWorkoutJson, buildGarminWorkoutTcx } from '../lib/watchData';
import { DayEditorModal } from './DayEditorModal';
import type {
  DailyWorkout,
  HealthSnapshot,
  TrainingFocusId,
  TrainingPlan,
  TrainingZones,
  WatchActivity,
} from '../lib/types';

interface TrainingPlanViewProps {
  focus: TrainingFocusId;
  plan: TrainingPlan;
  targetRace: { name: string; dist: string; day: string } | null;
  hasCustomAiPlan: boolean;
  activities: WatchActivity[];
  health: HealthSnapshot | null;
  aiPlanLoading: boolean;
  aiWorkoutLoading: boolean;
  aiWorkoutDay?: string | null;
  aiError: string | null;
  todayDay?: string;
  zones?: TrainingZones;
  customizedDays?: Record<string, DailyWorkout>;
  onChangeFocus: (focus: TrainingFocusId) => void;
  onGenerateAiPlan: (customGoal: string, focusOverride?: TrainingFocusId) => void;
  onGenerateSingleWorkout: (day: string, goalPrompt: string) => void;
  onSaveCustomWorkout?: (day: string, workout: DailyWorkout) => void;
  onToggleDayRest?: (workout: DailyWorkout) => void;
  onResetDay?: (day: string) => void;
  onSetTargetRace: (race: { name: string; dist: string; day: string }) => void;
  onClearTargetRace: () => void;
  onResetToBasePlan: () => void;
  onOpenCoachForWorkout: (prompt: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

const WORKOUT_TYPE_LABEL: Record<DailyWorkout['workout_type'], { label: string; colorClass: string }> = {
  workout: { label: 'Quality Session', colorClass: 'text-sky-400' },
  long_run: { label: 'Long Run', colorClass: 'text-indigo-300' },
  easy: { label: 'Zone 2 Aerobic', colorClass: 'text-emerald-400' },
  recovery: { label: 'Active Recovery', colorClass: 'text-amber-400' },
  rest: { label: 'Rest & Mobility', colorClass: 'text-slate-400' },
  race: { label: 'Race Day', colorClass: 'text-amber-300' },
  cross_train: { label: 'Cross-Train', colorClass: 'text-teal-400' },
};

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function TrainingPlanView({
  focus,
  plan,
  targetRace,
  hasCustomAiPlan,
  activities,
  health,
  aiPlanLoading,
  aiWorkoutLoading,
  aiWorkoutDay,
  aiError,
  todayDay,
  zones,
  customizedDays,
  onChangeFocus,
  onGenerateAiPlan,
  onGenerateSingleWorkout,
  onSaveCustomWorkout,
  onToggleDayRest,
  onResetDay,
  onSetTargetRace,
  onClearTargetRace,
  onResetToBasePlan,
  onOpenCoachForWorkout,
  onNotify,
}: TrainingPlanViewProps) {
  const todayName = normalizeDayName(todayDay ?? getTodayDayName(), getTodayDayName());
  const remainingDays = useMemo(() => getRemainingDaysOfWeek(todayName), [todayName]);
  const visibleSchedule = useMemo(
    () => filterRemainingSchedule(plan.schedule, todayName),
    [plan.schedule, todayName]
  );

  const [customGoal, setCustomGoal] = useState('');
  const [workoutDay, setWorkoutDay] = useState<string>(remainingDays[0] ?? todayName);
  const [workoutPrompt, setWorkoutPrompt] = useState('');
  const [workoutFormError, setWorkoutFormError] = useState<string | null>(null);
  const [editingWorkout, setEditingWorkout] = useState<DailyWorkout | null>(null);

  const [raceName, setRaceName] = useState(targetRace?.name ?? '');
  const [raceDist, setRaceDist] = useState(targetRace?.dist ?? '5K');
  const [raceDay, setRaceDay] = useState(targetRace?.day ?? 'Thursday');
  const [raceFormError, setRaceFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!remainingDays.includes(workoutDay)) {
      setWorkoutDay(remainingDays[0] ?? todayName);
    }
  }, [remainingDays, todayName, workoutDay]);

  useEffect(() => {
    if (targetRace) {
      setRaceName(targetRace.name);
      setRaceDist(targetRace.dist);
      setRaceDay(targetRace.day);
    }
  }, [targetRace]);

  const handleSubmitRace = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = raceName.trim();
    if (!cleaned) {
      setRaceFormError('Enter a target race name before applying the race-week taper.');
      return;
    }
    setRaceFormError(null);
    onSetTargetRace({ name: cleaned, dist: raceDist, day: raceDay });
  };

  const handleSubmitSingleWorkout = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = workoutPrompt.trim();
    if (!cleaned) {
      setWorkoutFormError('Describe the workout you want Gemini to build (e.g., "40 min Zone 2 easy run").');
      return;
    }
    setWorkoutFormError(null);
    onGenerateSingleWorkout(workoutDay, cleaned);
  };

  const handleExport = (w: DailyWorkout, format: 'tcx' | 'json') => {
    const slug = `${w.day}-${w.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    if (format === 'tcx') {
      const xml = buildGarminWorkoutTcx(w);
      triggerDownload(xml, `racekit-${slug}.tcx`, 'application/xml');
      onNotify(`Downloaded "${w.name}.tcx" for Garmin watch import.`, 'success');
    } else {
      const json = buildGarminWorkoutJson(w);
      triggerDownload(json, `racekit-${slug}.json`, 'application/json');
      onNotify(`Downloaded "${w.name}.json" Garmin Connect workout payload.`, 'success');
    }
  };

  const watchContextSummary =
    activities.length > 0 || health
      ? `Grounded in synced watch data (${activities.length} runs${
          health?.hrv_last_night ? ` · HRV ${health.hrv_last_night} ms` : ''
        }${health?.sleep_score ? ` · Sleep ${health.sleep_score}` : ''})`
      : 'Using verified PRs & VDOT pace zones (connect Garmlink MCP in Watch Sync to include live Garmin history)';

  const scheduleStats = useMemo(() => computeScheduleStats(visibleSchedule), [visibleSchedule]);
  const dynamicTotalMiles = scheduleStats.totalMiles;
  const dynamicLongRun = scheduleStats.longestRunMiles;
  const qualityCount = scheduleStats.qualityCount;
  const raceCount = scheduleStats.raceCount;
  const easyRecoveryCount = scheduleStats.easyRecoveryCount;
  const crossTrainCount = scheduleStats.crossTrainCount;
  const restCount = scheduleStats.restCount;

  return (
    <div className="space-y-6">
      {/* ── Header & Segmented Training Focus Capsule (Apple Fitness Style) ── */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-100">
              Workouts &amp; Schedule
            </h1>
            <p className="mt-0.5 text-xs text-slate-400">
              {plan.title} · <strong className="text-slate-200 font-mono">{dynamicTotalMiles} mi scheduled</strong>
              {aiPlanLoading ? (
                <span className="text-sky-400 ml-1.5 font-semibold inline-flex items-center gap-1">
                  <RefreshCw className="h-3 w-3 animate-spin inline" /> Generating…
                </span>
              ) : plan.ai_generated ? (
                <span className="text-emerald-400 ml-1.5 font-semibold">· AI Adapted</span>
              ) : null}
            </p>
          </div>

          {hasCustomAiPlan && (
            <button
              type="button"
              onClick={onResetToBasePlan}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/80 px-3.5 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-700"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset Plan
            </button>
          )}
        </div>

        {/* Focus Capsule Segmented Control (Apple iOS Dark Style) */}
        <div className="flex items-center gap-1 overflow-x-auto rounded-2xl border border-white/10 bg-[#1C1C1E] p-1 shadow-inner">
          {(Object.keys(TRAINING_FOCUS_LABELS) as TrainingFocusId[]).map((id) => {
            const active = focus === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  onChangeFocus(id);
                  onGenerateAiPlan(customGoal, id);
                }}
                className={`flex-1 min-w-[100px] rounded-xl py-2 px-3 text-xs font-semibold transition-all whitespace-nowrap text-center ${
                  active
                    ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
                    : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
                }`}
              >
                {TRAINING_FOCUS_LABELS[id]}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Apple Intelligence AI Workout Assistant Pill ── */}
      <section className="rounded-3xl border border-white/10 bg-[#1C1C1E] p-5 shadow-sm backdrop-blur-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#30D158]" />
            <h2 className="text-sm font-bold text-white">
              AI Coach Workout Builder
            </h2>
          </div>
          <span className="text-[11px] font-mono text-[#8E8E93]">{watchContextSummary}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            aria-label="Custom instructions for AI training plan"
            value={customGoal}
            onChange={(e) => setCustomGoal(e.target.value)}
            placeholder="Ask AI Coach (e.g. 5 runs/wk, Tuesday track intervals, build low-aerobic Zone 2 base)…"
            className="min-w-[240px] flex-1 rounded-2xl border border-white/10 bg-[#2C2C2E] px-4 py-2.5 text-xs text-white placeholder:text-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => onGenerateAiPlan(customGoal)}
            disabled={aiPlanLoading || aiWorkoutLoading}
            className="inline-flex items-center gap-2 rounded-2xl bg-[#0A84FF] px-4 py-2.5 text-xs font-bold text-white transition-all hover:brightness-110 disabled:opacity-50 whitespace-nowrap shrink-0 shadow-sm"
          >
            {aiPlanLoading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {aiPlanLoading ? 'Building Remaining Week…' : 'Generate Full Plan'}
          </button>
        </div>

        {/* Quick Workout Modifier Bar */}
        <form
          onSubmit={handleSubmitSingleWorkout}
          className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10"
        >
          <span className="text-xs text-[#8E8E93] font-medium">Modify Day:</span>
          <select
            aria-label="Day for AI workout"
            value={workoutDay}
            onChange={(e) => setWorkoutDay(e.target.value)}
            className="rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-1.5 text-xs font-semibold text-white focus:border-[#0A84FF] focus:outline-none"
          >
            {remainingDays.map((d) => (
              <option key={d} value={d}>
                {d === todayName ? `${d} (Today)` : d}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Workout description for AI"
            value={workoutPrompt}
            onChange={(e) => {
              setWorkoutPrompt(e.target.value);
              if (workoutFormError) setWorkoutFormError(null);
            }}
            placeholder="e.g., harder workout today, 5 mile tempo, rest day, or 45 min cycling"
            className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-1.5 text-xs text-white placeholder:text-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
          />
          <button
            type="submit"
            disabled={aiWorkoutLoading || aiPlanLoading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#30D158]/40 bg-[#30D158]/15 px-3.5 py-1.5 text-xs font-bold text-[#30D158] hover:bg-[#30D158]/25 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {aiWorkoutLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {aiWorkoutLoading ? 'Modifying…' : 'Modify Day'}
          </button>
        </form>

        {workoutFormError && (
          <p className="text-[11px] text-amber-300 px-1">{workoutFormError}</p>
        )}

        {aiError && (
          <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
            <span>{aiError}</span>
          </div>
        )}
      </section>

      {/* Target Race Auto-Taper Banner (if target race set) */}
      {targetRace && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-center justify-between text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              <strong>Target Race Taper:</strong> {targetRace.name} ({targetRace.dist}) scheduled on <strong>{targetRace.day}</strong>. Workouts adjusted for fresh legs.
            </span>
          </div>
          <button
            type="button"
            onClick={onClearTargetRace}
            className="inline-flex items-center gap-1 rounded-lg bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-300 hover:bg-amber-500/30"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      )}

      {/* ── Remaining-Week Workout Cards (Apple Fitness Daily Workout Style) ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" data-testid="schedule-grid">
        {visibleSchedule.map((w) => {
          const normDay = normalizeDayName(w.day, w.day);
          const isToday = normDay === todayName;
          const isPinned = Boolean(w.is_pinned || w.user_customized || customizedDays?.[normDay]);
          const typeMeta = WORKOUT_TYPE_LABEL[w.workout_type] ?? WORKOUT_TYPE_LABEL.easy;

          return (
            <article
              key={normDay}
              data-testid={`workout-card-${normDay.toLowerCase()}`}
              className={`relative rounded-3xl border p-5 flex flex-col justify-between transition-all ${
                isToday
                  ? 'border-[#0A84FF]/60 bg-[#1C1C1E] shadow-lg shadow-[#0A84FF]/10'
                  : isPinned
                    ? 'border-amber-400/45 bg-[#1C1C1E]'
                    : w.workout_type === 'race'
                      ? 'border-[#FF9F0A]/50 bg-[#1C1C1E]'
                      : w.ai_generated
                        ? 'border-[#30D158]/40 bg-[#1C1C1E]'
                        : 'border-white/10 bg-[#1C1C1E]'
              }`}
            >
              {aiWorkoutLoading && (aiWorkoutDay ? normalizeDayName(aiWorkoutDay, '') === normDay : workoutDay === normDay) && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-3xl bg-[#1C1C1E]/90 backdrop-blur-sm p-4 text-center">
                  <RefreshCw className="h-6 w-6 animate-spin text-[#0A84FF] mb-2" />
                  <span className="text-xs font-bold text-white">Updating {normDay}…</span>
                  <span className="text-[10px] text-slate-400 mt-1">Applying VDOT pacing &amp; custom targets</span>
                </div>
              )}
              <div>
                {/* Day Header Row */}
                <div className="flex items-center justify-between gap-1 text-xs">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-extrabold text-sm text-white uppercase tracking-wide">
                      {normDay}
                    </span>
                    {isToday && (
                      <span className="rounded-full bg-[#0A84FF] px-2 py-0.5 text-[10px] font-extrabold text-white uppercase">
                        Today
                      </span>
                    )}
                    {isPinned && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 uppercase">
                        <Pin className="h-2.5 w-2.5" />
                        Pinned
                      </span>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                    w.workout_type === 'race'
                      ? 'bg-[#FF9F0A]/20 text-[#FF9F0A]'
                      : w.workout_type === 'workout'
                        ? 'bg-[#0A84FF]/20 text-[#0A84FF]'
                        : w.workout_type === 'long_run'
                          ? 'bg-[#BF5AF2]/20 text-[#BF5AF2]'
                          : w.workout_type === 'cross_train'
                            ? 'bg-teal-500/20 text-teal-300'
                            : w.workout_type === 'rest'
                              ? 'bg-[#2C2C2E] text-[#8E8E93]'
                              : 'bg-[#30D158]/20 text-[#30D158]'
                  }`}>
                    {typeMeta.label}
                  </span>
                </div>

                {/* Hero Workout Distance */}
                <div className="mt-3">
                  <div className="font-mono text-3xl font-extrabold text-white tracking-tight">
                    {w.workout_type === 'rest'
                      ? 'Rest Day'
                      : w.workout_type === 'cross_train' && w.distance_miles <= 0
                        ? 'Cross-Train'
                        : `${w.distance_miles} mi`}
                  </div>
                  {w.warmup_miles != null && w.main_miles != null && w.cooldown_miles != null && (w.warmup_miles > 0 || w.cooldown_miles > 0) && (
                    <div className="mt-0.5 text-[11px] font-mono text-[#8E8E93]">
                      {w.warmup_miles} WU · {w.main_miles} Main · {w.cooldown_miles} CD
                    </div>
                  )}
                  <h3 className="mt-1 font-bold text-sm text-slate-200">{w.name}</h3>
                </div>

                {/* Target Pace & HR Badge */}
                {w.workout_type !== 'rest' && (w.distance_miles > 0 || w.workout_type === 'cross_train') && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                    <span className="rounded-md bg-slate-800/90 px-2 py-0.5 text-slate-300 font-semibold">
                      {w.pace_target}
                    </span>
                    <span className="rounded-md bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-rose-300 font-semibold">
                      HR {w.hr_cap}
                    </span>
                  </div>
                )}

                <p className="mt-3 text-xs text-slate-300 leading-relaxed whitespace-pre-line">{w.description}</p>
                <div className="mt-2 pt-2 border-t border-slate-800/60 text-[10px] text-slate-400">
                  {w.injury_prevention_note}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-4 pt-3 border-t border-slate-800/60 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {w.distance_miles > 0 && (
                    <button
                      type="button"
                      onClick={() => handleExport(w, 'tcx')}
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition-colors"
                    >
                      <Download className="h-3 w-3 text-sky-400" />
                      Watch
                    </button>
                  )}
                  {onSaveCustomWorkout && (
                    <button
                      type="button"
                      onClick={() => setEditingWorkout(w)}
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition-colors"
                    >
                      <Pencil className="h-3 w-3 text-amber-300" />
                      Edit
                    </button>
                  )}
                  {onToggleDayRest && (
                    <button
                      type="button"
                      onClick={() => onToggleDayRest(w)}
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-700 transition-colors"
                    >
                      {w.workout_type === 'rest' ? 'Add Run' : 'Set Rest'}
                    </button>
                  )}
                  {isPinned && onResetDay && (
                    <button
                      type="button"
                      onClick={() => onResetDay(normDay)}
                      title={`Reset ${normDay} to default`}
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-700/80 px-2 py-1 text-[11px] font-semibold text-slate-400 hover:text-white transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    onOpenCoachForWorkout(
                      `Review my ${normDay} session ("${w.name}", ${w.distance_miles} mi) against my synced watch data and adjust the workout if needed.`
                    )
                  }
                  className="inline-flex items-center gap-1 text-xs font-semibold text-sky-400 hover:text-sky-300 transition-colors"
                >
                  <Sparkles className="h-3 w-3" />
                  Tweak
                </button>
              </div>
            </article>
          );
        })}

        {/* Remaining-Week Summary Card */}
        <div className="rounded-3xl border border-white/10 bg-[#1C1C1E] p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-300 uppercase tracking-wide">Remaining Week</span>
              <span className="font-mono text-[#30D158] font-bold">
                {visibleSchedule.length} days ({remainingDays[0]}–Sun)
              </span>
            </div>

            <div className="mt-3">
              <div className="text-xs text-slate-400">Remaining Scheduled Miles</div>
              <div className="mt-1 flex items-baseline gap-2 font-mono">
                <span className="text-4xl font-extrabold text-white">{dynamicTotalMiles}</span>
                <span className="text-xs font-semibold text-slate-400">miles</span>
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs">
              <div className="flex justify-between text-slate-300">
                <span>Active Days:</span>
                <strong className="font-mono text-slate-100">{scheduleStats.activeDays}</strong>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Long Run:</span>
                <strong className="font-mono text-slate-100">{dynamicLongRun} mi</strong>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Quality Days:</span>
                <strong className="font-mono text-[#0A84FF]">{qualityCount}</strong>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Race Days:</span>
                <strong className="font-mono text-[#FF9F0A]">{raceCount}</strong>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Easy / Recovery Days:</span>
                <strong className="font-mono text-[#30D158]">{easyRecoveryCount}</strong>
              </div>
              {crossTrainCount > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>Cross-Train Days:</span>
                  <strong className="font-mono text-teal-300">{crossTrainCount}</strong>
                </div>
              )}
              <div className="flex justify-between text-slate-300">
                <span>Rest Days:</span>
                <strong className="font-mono text-slate-400">{restCount}</strong>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-white/10 text-[11px] text-slate-400">
            {plan.aerobic_deficit_focus}
          </div>
        </div>
      </div>

      {editingWorkout && onSaveCustomWorkout && (
        <DayEditorModal
          isOpen={Boolean(editingWorkout)}
          workout={editingWorkout}
          availableDays={remainingDays}
          zones={zones}
          isCustomized={Boolean(
            editingWorkout.is_pinned ||
              editingWorkout.user_customized ||
              customizedDays?.[normalizeDayName(editingWorkout.day, '')]
          )}
          onSave={(updated) => {
            onSaveCustomWorkout(updated.day, updated);
            setEditingWorkout(null);
          }}
          onResetDay={(day) => {
            onResetDay?.(day);
            setEditingWorkout(null);
          }}
          onClose={() => setEditingWorkout(null)}
        />
      )}
    </div>
  );
}
