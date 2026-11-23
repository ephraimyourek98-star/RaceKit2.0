import { useState } from 'react';
import {
  AlertCircle,
  Download,
  Flag,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  DAYS_OF_WEEK,
  TRAINING_FOCUS_LABELS,
  getTodayDayName,
} from '../lib/trainingPlans';
import { buildGarminWorkoutJson, buildGarminWorkoutTcx } from '../lib/watchData';
import type {
  DailyWorkout,
  HealthSnapshot,
  TrainingFocusId,
  TrainingPlan,
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
  aiError: string | null;
  onChangeFocus: (focus: TrainingFocusId) => void;
  onGenerateAiPlan: (customGoal: string) => void;
  onGenerateSingleWorkout: (day: string, goalPrompt: string) => void;
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
  aiError,
  onChangeFocus,
  onGenerateAiPlan,
  onGenerateSingleWorkout,
  onSetTargetRace,
  onClearTargetRace,
  onResetToBasePlan,
  onOpenCoachForWorkout,
  onNotify,
}: TrainingPlanViewProps) {
  const [customGoal, setCustomGoal] = useState('');
  const [workoutDay, setWorkoutDay] = useState<string>(getTodayDayName());
  const [workoutPrompt, setWorkoutPrompt] = useState('');
  const [workoutFormError, setWorkoutFormError] = useState<string | null>(null);

  const [raceName, setRaceName] = useState(targetRace?.name ?? '');
  const [raceDist, setRaceDist] = useState(targetRace?.dist ?? '5K');
  const [raceDay, setRaceDay] = useState(targetRace?.day ?? 'Thursday');
  const [raceFormError, setRaceFormError] = useState<string | null>(null);

  const todayName = getTodayDayName();

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

  return (
    <div className="space-y-6">
      {/* Header & Focus Select */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-50">
            AI Training Plan &amp; Workout Builder
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {plan.title} ·{' '}
            <span className="font-mono tabular-nums text-slate-200">{plan.weekly_mileage} mpw</span>
            {plan.ai_generated && (
              <span className="ml-2 font-medium text-emerald-400">· AI Generated</span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="plan-focus-select" className="sr-only">
            Training Focus
          </label>
          <select
            id="plan-focus-select"
            value={focus}
            onChange={(e) => onChangeFocus(e.target.value as TrainingFocusId)}
            className="rounded-lg border border-slate-700 bg-[#111720] px-3 py-2 text-xs font-medium text-sky-400 focus:border-sky-500 focus:outline-none"
          >
            {(Object.keys(TRAINING_FOCUS_LABELS) as TrainingFocusId[]).map((id) => (
              <option key={id} value={id}>
                {TRAINING_FOCUS_LABELS[id]}
              </option>
            ))}
          </select>

          {hasCustomAiPlan && (
            <button
              type="button"
              onClick={onResetToBasePlan}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#171F2B] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to Template
            </button>
          )}
        </div>
      </div>

      {/* ── AI Plan & Single Workout Builder Panel ── */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-slate-100">
              Generate Workouts &amp; Plans with Gemini AI
            </h2>
          </div>
          <span className="text-[11px] text-slate-400">{watchContextSummary}</span>
        </div>

        {/* Full 7-day AI plan builder */}
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            aria-label="Custom instructions for AI training plan"
            value={customGoal}
            onChange={(e) => setCustomGoal(e.target.value)}
            placeholder="Optional instructions (e.g., 5 runs/wk, Tuesday track speed, build low-aerobic Zone 2 base)…"
            className="min-w-[240px] flex-1 rounded-lg border border-slate-700 bg-[#090D12] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => onGenerateAiPlan(customGoal)}
            disabled={aiPlanLoading || aiWorkoutLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {aiPlanLoading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {aiPlanLoading ? 'Building 7-Day Plan…' : 'Generate AI 7-Day Plan'}
          </button>
        </div>

        {/* Single AI workout builder */}
        <form
          onSubmit={handleSubmitSingleWorkout}
          className="flex flex-wrap items-center gap-2.5 border-t border-slate-800/80 pt-4"
        >
          <span className="text-xs font-medium text-slate-300 whitespace-nowrap">
            Create Single Workout:
          </span>
          <select
            aria-label="Day for AI workout"
            value={workoutDay}
            onChange={(e) => setWorkoutDay(e.target.value)}
            className="rounded-lg border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={d}>
                {d}
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
            placeholder="e.g., 5K threshold cruise intervals on track, or 40 min Zone 2 recovery run"
            className="min-w-[220px] flex-1 rounded-lg border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={aiWorkoutLoading || aiPlanLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/45 bg-emerald-500/15 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {aiWorkoutLoading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {aiWorkoutLoading ? 'Creating…' : 'Build AI Workout'}
          </button>
        </form>

        {workoutFormError && (
          <p role="alert" className="text-xs text-rose-400">
            {workoutFormError}
          </p>
        )}

        {aiError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
            <span>{aiError}</span>
          </div>
        )}
      </section>

      {/* Race-Week Auto-Taper Bar */}
      <form
        onSubmit={handleSubmitRace}
        className="rounded-xl border border-slate-800/80 bg-[#111720] p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <Flag className="h-3.5 w-3.5 text-sky-400" />
            <span>Target Race Auto-Taper</span>
          </div>

          <input
            type="text"
            aria-label="Target race name"
            value={raceName}
            onChange={(e) => {
              setRaceName(e.target.value);
              if (raceFormError) setRaceFormError(null);
            }}
            placeholder="Race name (e.g., Run for Pie 5K)"
            className="min-w-[200px] flex-1 rounded-lg border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
          />

          <select
            aria-label="Target race distance"
            value={raceDist}
            onChange={(e) => setRaceDist(e.target.value)}
            className="rounded-lg border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            <option value="5K">5K</option>
            <option value="800m">800m</option>
            <option value="1600m">1600m</option>
            <option value="3200m">3200m</option>
            <option value="10K">10K</option>
            <option value="Half Marathon">Half Marathon</option>
          </select>

          <select
            aria-label="Target race day"
            value={raceDay}
            onChange={(e) => setRaceDay(e.target.value)}
            className="rounded-lg border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          <button
            type="submit"
            className="rounded-lg bg-slate-200 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-white whitespace-nowrap shrink-0"
          >
            Set Race &amp; Taper
          </button>

          {targetRace && (
            <button
              type="button"
              onClick={() => {
                setRaceName('');
                onClearTargetRace();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20 whitespace-nowrap shrink-0"
            >
              <X className="h-3.5 w-3.5" />
              Clear Taper
            </button>
          )}
        </div>

        {raceFormError && (
          <p role="alert" className="mt-2 text-xs text-rose-400">
            {raceFormError}
          </p>
        )}
      </form>

      {/* Physiological Focus Callout */}
      <div className="rounded-xl border border-slate-800/80 bg-[#111720] px-5 py-3.5 text-xs leading-relaxed text-slate-300">
        <span className="font-semibold text-slate-100">Training Focus: </span>
        {plan.aerobic_deficit_focus}
      </div>

      {/* 7-Day Schedule Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="schedule-grid">
        {plan.schedule.map((w) => {
          const isToday = w.day === todayName;
          const typeMeta = WORKOUT_TYPE_LABEL[w.workout_type] ?? WORKOUT_TYPE_LABEL.easy;

          return (
            <article
              key={w.day}
              className={`flex flex-col justify-between rounded-xl border p-5 transition-colors ${
                w.workout_type === 'race'
                  ? 'border-amber-500/50 bg-[#161A22]'
                  : w.ai_generated
                    ? 'border-emerald-500/45 bg-[#11191E]'
                    : isToday
                      ? 'border-sky-500/45 bg-[#111720]'
                      : 'border-slate-800/80 bg-[#111720]'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5 text-slate-400">
                    <span className="font-semibold text-slate-200">{w.day}</span>
                    {isToday && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-sky-400">Today</span>
                      </>
                    )}
                    {w.ai_generated && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-emerald-400">AI Built</span>
                      </>
                    )}
                  </div>
                  <span className="font-mono font-bold tabular-nums text-slate-100">
                    {w.distance_miles > 0 ? `${w.distance_miles} mi` : 'Rest'}
                  </span>
                </div>

                <h3 className="mt-2 text-sm font-bold text-slate-50">{w.name}</h3>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px]">
                  <span className={`font-medium ${typeMeta.colorClass}`}>{typeMeta.label}</span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-300">{w.pace_target}</span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-amber-300/90">HR {w.hr_cap}</span>
                </div>

                <p className="mt-3 text-xs leading-relaxed text-slate-300">{w.description}</p>
                <p className="mt-2.5 border-t border-slate-800/70 pt-2 text-[11px] text-slate-400">
                  Guardrail: {w.injury_prevention_note}
                </p>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-3">
                {w.distance_miles > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleExport(w, 'tcx')}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-[#0D131B] px-2.5 py-1 text-[11px] font-medium text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-300"
                    >
                      <Download className="h-3 w-3 text-sky-400" />
                      Watch .TCX
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExport(w, 'json')}
                      className="rounded-md border border-slate-700 bg-[#0D131B] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800"
                    >
                      JSON
                    </button>
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500">Recovery Day</span>
                )}

                <button
                  type="button"
                  onClick={() =>
                    onOpenCoachForWorkout(
                      `Review my ${w.day} session ("${w.name}", ${w.distance_miles} mi) against my synced watch data and adjust the workout if needed.`
                    )
                  }
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-400 transition-colors hover:text-sky-300"
                >
                  <Sparkles className="h-3 w-3" />
                  Tweak with AI
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
