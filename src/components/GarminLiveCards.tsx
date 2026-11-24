import type { GarminZone, HealthSnapshot } from '../lib/types';

const CARD = 'rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm';
const TILE = 'rounded-xl border border-slate-800 bg-[#0C121B] p-3';

function scoreColor(v: number | null | undefined): string {
  if (v == null) return 'bg-slate-600';
  if (v >= 75) return 'bg-emerald-400';
  if (v >= 50) return 'bg-sky-400';
  if (v >= 25) return 'bg-amber-400';
  return 'bg-rose-400';
}

function prettyEnum(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Compact Garmin Training Readiness card with the six factor bars (garmlink_readiness_get). */
export function TrainingReadinessCard({ health }: { health: HealthSnapshot | null }) {
  const rd = health?.readiness;
  if (!rd || rd.score == null) return null;
  const factors: Array<[string, number | null]> = [
    ['Sleep Score', rd.factors.sleep_score_pct],
    ['Recovery Time', rd.factors.recovery_pct],
    ['HRV Status', rd.factors.hrv_pct],
    ['Sleep History', rd.factors.sleep_history_pct],
    ['Stress History', rd.factors.stress_history_pct],
    ['Acute Load (ACWR)', rd.factors.acwr_pct],
  ];
  return (
    <div className={CARD} data-testid="training-readiness-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">Training Readiness</div>
          <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-4xl font-extrabold text-slate-50">{rd.score}</span>
            <span className="text-xs text-slate-400">/ 100</span>
            {rd.level && (
              <span className="rounded-full border border-sky-500/30 bg-sky-500/15 px-2.5 py-0.5 text-[11px] font-bold text-sky-300">
                {prettyEnum(rd.level)}
              </span>
            )}
          </div>
          {rd.feedback && <div className="mt-1 text-xs text-slate-400">{prettyEnum(rd.feedback)}</div>}
        </div>
        {rd.recovery_hours != null && (
          <div className="text-right">
            <div className="text-[11px] text-slate-400">Recovery Time</div>
            <div className="font-mono text-xl font-bold tabular-nums text-amber-400">
              {rd.recovery_hours} <span className="text-xs font-normal text-slate-400">h</span>
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-2.5">
        {factors.map(([label, pct]) => (
          <div key={label}>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="text-slate-300">{label}</span>
              <span className="font-mono tabular-nums text-slate-400">{pct != null ? `${pct}%` : '—'}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full rounded-full ${scoreColor(pct)}`}
                style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Daily health rollup: stress, respiration, SpO2, steps, calories, floors, intensity minutes. */
export function DailyHealthRollupCard({ health }: { health: HealthSnapshot | null }) {
  if (!health) return null;
  const h = health;
  const fmtInt = (n: number) => n.toLocaleString('en-US');
  const tiles: Array<{ label: string; value: string; sub?: string }> = [];

  if (h.stress_avg != null) {
    tiles.push({ label: 'Stress', value: `${h.stress_avg}`, sub: h.stress_max != null ? `Max ${h.stress_max}` : 'Daily average' });
  }
  if (h.respiration_avg_sleep != null || h.respiration_avg_waking != null) {
    tiles.push({
      label: 'Respiration',
      value: `${h.respiration_avg_sleep ?? '—'} brpm`,
      sub: `Asleep · ${h.respiration_avg_waking ?? '—'} awake`,
    });
  }
  if (h.spo2_avg != null || h.spo2_avg_sleep != null) {
    tiles.push({
      label: 'SpO2',
      value: `${h.spo2_avg_sleep ?? h.spo2_avg}%`,
      sub: `${h.spo2_avg_sleep != null ? 'Sleep avg' : 'Daily avg'}${h.spo2_latest != null ? ` · Latest ${h.spo2_latest}%` : ''}`,
    });
  }
  if (h.steps != null) {
    tiles.push({
      label: 'Steps',
      value: fmtInt(h.steps),
      sub: h.step_goal ? `Goal ${fmtInt(h.step_goal)} (${Math.round((h.steps / h.step_goal) * 100)}%)` : undefined,
    });
  }
  if (h.calories_total != null) {
    tiles.push({
      label: 'Calories',
      value: fmtInt(h.calories_total),
      sub:
        h.bmr_calories != null && h.active_calories != null
          ? `${fmtInt(h.bmr_calories)} BMR + ${fmtInt(h.active_calories)} active`
          : undefined,
    });
  }
  if (h.floors != null) tiles.push({ label: 'Floors', value: `${h.floors}`, sub: 'Climbed today' });
  if (h.intensity_weekly_total != null) {
    tiles.push({
      label: 'Intensity Minutes',
      value: `${h.intensity_weekly_total}`,
      sub: h.intensity_week_goal ? `Weekly goal ${h.intensity_week_goal}` : 'This week',
    });
  }
  if (tiles.length === 0) return null;

  return (
    <div className={CARD} data-testid="daily-health-rollup">
      <div className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">Daily Health Rollup</div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className={TILE}>
            <div className="text-[11px] text-slate-400">{t.label}</div>
            <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">{t.value}</div>
            {t.sub && <div className="mt-0.5 text-[10px] text-slate-500">{t.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ZoneRows({ zones, unit }: { zones: GarminZone[]; unit: string }) {
  const colors = ['text-emerald-400', 'text-sky-400', 'text-indigo-400', 'text-amber-400', 'text-rose-400'];
  return (
    <div className="space-y-1.5 text-xs font-mono">
      {zones.map((z, i) => (
        <div
          key={z.zone}
          className={`flex justify-between items-center py-1 ${i < zones.length - 1 ? 'border-b border-slate-800/60' : ''}`}
        >
          <span className={`${colors[i % colors.length]} font-medium`}>Zone {z.zone}</span>
          <span className="text-slate-300 tabular-nums">
            {z.low ?? '—'}
            {z.high != null ? `–${z.high}` : '+'} {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Lactate threshold, running FTP, running power zones and fitness age. */
export function GarminPhysiologyCard({ health }: { health: HealthSnapshot | null }) {
  if (!health) return null;
  const h = health;
  const hasAny =
    h.lthr_bpm != null || h.running_ftp_w != null || h.fitness_age != null || (h.power_zones?.length ?? 0) > 0;
  if (!hasAny) return null;
  return (
    <div className={CARD} data-testid="garmin-physiology-card">
      <div className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
        Lactate Threshold, Running Power &amp; Fitness Age
      </div>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="grid grid-cols-2 gap-3 content-start">
          <div className={TILE}>
            <div className="text-[11px] text-slate-400">Lactate Threshold HR</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-rose-400">
              {h.lthr_bpm ?? '—'} <span className="text-xs font-normal text-slate-400">bpm</span>
            </div>
          </div>
          <div className={TILE}>
            <div className="text-[11px] text-slate-400">Running FTP</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-amber-400">
              {h.running_ftp_w ?? '—'} <span className="text-xs font-normal text-slate-400">W</span>
            </div>
            {h.running_ftp_wkg != null && (
              <div className="mt-0.5 text-[10px] text-slate-500 font-mono">{h.running_ftp_wkg} W/kg</div>
            )}
          </div>
          <div className={TILE}>
            <div className="text-[11px] text-slate-400">Fitness Age</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-400">{h.fitness_age ?? '—'}</div>
          </div>
          <div className={TILE}>
            <div className="text-[11px] text-slate-400">Vigorous Minutes (avg)</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-sky-400">
              {h.vigorous_minutes_avg ?? '—'}
            </div>
          </div>
        </div>
        {h.power_zones && h.power_zones.length > 0 && (
          <div className={TILE}>
            <div className="mb-2 text-[11px] font-semibold text-slate-400">Running Power Zones</div>
            <ZoneRows zones={h.power_zones} unit="W" />
          </div>
        )}
      </div>
    </div>
  );
}
