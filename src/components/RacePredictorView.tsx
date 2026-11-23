import { useMemo, useState } from 'react';
import { Calendar, ChevronDown, ChevronUp, Clock, CloudSun, RefreshCw, Wind } from 'lucide-react';
import { ElevationProfileChart } from './TelemetryCharts';
import {
  PRIMARY_DISTANCES,
  PredictionEngine,
  formatPace,
  formatTime,
} from '../lib/predictionEngine';
import { PRESET_COURSES, SHOE_DATABASE, SURFACE_OPTIONS } from '../lib/seedData';
import type {
  CourseConditions,
  Effort,
  FitnessMetrics,
  RaceWeatherSync,
  ShoeId,
  SplitStrategy,
  SurfaceType,
  TrainingZones,
  WindDirection,
} from '../lib/types';

interface RacePredictorViewProps {
  engine: PredictionEngine;
  fitness: FitnessMetrics;
  zones: TrainingZones;
  efforts: Effort[];
  hasSyncedHealth: boolean;
  selectedDistance: string;
  selectedCourseId: string;
  conditions: CourseConditions;
  raceDate: string;
  raceTime: string;
  syncedWeather: RaceWeatherSync | null;
  onSelectDistance: (dist: string) => void;
  onSelectCourse: (courseId: string) => void;
  onChangeConditions: (next: CourseConditions) => void;
  onChangeRaceDate: (date: string) => void;
  onChangeRaceTime: (time: string) => void;
  onSyncedWeather: (w: RaceWeatherSync) => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

const MODEL_LABELS: Record<string, string> = {
  calibrated_riegel: 'Calibrated Pete Riegel Curve',
  critical_speed: "Critical Speed + D' (Monod-Scherrer)",
  daniels_vdot: 'Jack Daniels VDOT',
  standard_riegel: 'Standard Riegel Fallback',
};

const SOURCE_LABELS: Record<RaceWeatherSync['source'], string> = {
  hourly_forecast: 'Race-Time Hourly Forecast',
  current: 'Current Conditions',
  historical_actual: 'Historical Race-Day Weather',
  historical_reference: 'Seasonal Historical Reference',
};

export function RacePredictorView({
  engine,
  fitness,
  zones,
  efforts,
  hasSyncedHealth,
  selectedDistance,
  selectedCourseId,
  conditions,
  raceDate,
  raceTime,
  syncedWeather,
  onSelectDistance,
  onSelectCourse,
  onChangeConditions,
  onChangeRaceDate,
  onChangeRaceTime,
  onSyncedWeather,
  onNotify,
}: RacePredictorViewProps) {
  const [splitStrategy, setSplitStrategy] = useState<SplitStrategy>('course_gap');
  const [showModels, setShowModels] = useState(true);
  const [weatherLoading, setWeatherLoading] = useState(false);

  const activeCourse = useMemo(
    () => PRESET_COURSES.find((c) => c.course_id === selectedCourseId) ?? PRESET_COURSES[0],
    [selectedCourseId]
  );

  const prediction = useMemo(
    () => engine.predict(selectedDistance, conditions),
    [engine, selectedDistance, conditions]
  );

  const allPredictions = useMemo(
    () => engine.predictAll(conditions),
    [engine, conditions]
  );

  const splits = useMemo(
    () => engine.generateSplits(prediction, splitStrategy, activeCourse.profile),
    [engine, prediction, splitStrategy, activeCourse.profile]
  );

  const shoeMatrix = useMemo(
    () => engine.compareShoes(selectedDistance, conditions),
    [engine, selectedDistance, conditions]
  );

  const handleSurfaceChange = (surface: SurfaceType) => {
    const defaultShoe = SURFACE_OPTIONS[surface].default_shoe;
    onChangeConditions({
      ...conditions,
      surface,
      shoe_type: defaultShoe,
    });
  };

  const handleSyncWeather = async (useRaceSchedule: boolean) => {
    setWeatherLoading(true);
    try {
      const qs = new URLSearchParams({
        lat: String(activeCourse.lat),
        lon: String(activeCourse.lon),
      });
      if (useRaceSchedule && raceDate) {
        qs.set('date', raceDate);
        qs.set('time', raceTime || '08:30');
      }

      const res = await fetch(`/api/weather?${qs.toString()}`);
      const data = (await res.json()) as Partial<RaceWeatherSync> & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Weather fetch failed');

      const nextTemp = Math.max(10, Math.min(100, Number(data.temp_f ?? 50)));
      const nextHumid = Math.max(10, Math.min(100, Number(data.humidity ?? 50)));
      const nextWind = Math.max(0, Math.min(40, Number(data.wind_mph ?? 0)));

      onChangeConditions({
        ...conditions,
        temperature_f: nextTemp,
        humidity_pct: nextHumid,
        wind_mph: nextWind,
      });

      const weatherRecord: RaceWeatherSync = {
        temp_f: nextTemp,
        humidity: nextHumid,
        wind_mph: nextWind,
        wind_deg: data.wind_deg ?? null,
        wind_compass: data.wind_compass ?? 'Var',
        weather_code: data.weather_code ?? 0,
        condition_label: data.condition_label ?? 'Fair',
        target_datetime: data.target_datetime ?? `${raceDate} ${raceTime}`,
        timezone_abbr: data.timezone_abbr ?? 'Local',
        source: data.source ?? (useRaceSchedule ? 'hourly_forecast' : 'current'),
        note: data.note,
      };
      onSyncedWeather(weatherRecord);

      onNotify(
        `Synced ${SOURCE_LABELS[weatherRecord.source]} for ${activeCourse.short_name}: ${nextTemp}°F · ${nextHumid}% RH · ${nextWind} mph ${weatherRecord.wind_compass}.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Weather unavailable', 'error');
    } finally {
      setWeatherLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Section 1: Physiology & VDOT Training Zones ── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold tracking-tight text-slate-50">
            Race Prediction Engine &amp; Course Physics
          </h1>
          <span className="text-xs text-slate-400">
            {fitness.fatigue_profile} · {fitness.num_efforts} verified efforts · LT HR {fitness.lt_hr_bpm} bpm
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-4">
            <div className="text-xs text-slate-400">Critical Speed</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-sky-400">
              {fitness.critical_speed_pace}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-slate-500">
              {fitness.critical_speed_mps} m/s
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-4">
            <div className="text-xs text-slate-400">Effective VDOT</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-400">
              {fitness.vo2max ?? '—'}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">ml/kg/min</div>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-4">
            <div className="text-xs text-slate-400">D&apos; Reserve</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-100">
              {fitness.d_prime_m ? `${Math.round(fitness.d_prime_m)}m` : '—'}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">Anaerobic tank</div>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-4">
            <div className="text-xs text-slate-400">Riegel Exponent</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-100">
              {fitness.riegel_exponent ?? '—'}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">Fatigue decay</div>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-4">
            <div className="text-xs text-slate-400">Weekly Volume</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-amber-400">
              {fitness.avg_weekly_miles}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">mi/wk</div>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-4">
            <div className="text-xs text-slate-400">Longest Run</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-100">
              {fitness.longest_run_miles}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">miles</div>
          </div>
        </div>

        {/* VDOT Training Zones Bar */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-800/80 bg-[#111720] px-4 py-3 text-xs">
          <span className="font-medium text-slate-400">VDOT Pace Zones:</span>
          <span>
            <span className="text-slate-400">Easy Z2 </span>
            <strong className="font-mono tabular-nums text-emerald-400">{zones.easy.label}</strong>
          </span>
          <span>
            <span className="text-slate-400">Marathon </span>
            <strong className="font-mono tabular-nums text-slate-100">{zones.marathon.label}</strong>
          </span>
          <span>
            <span className="text-slate-400">Threshold </span>
            <strong className="font-mono tabular-nums text-sky-400">{zones.threshold.label}</strong>
          </span>
          <span>
            <span className="text-slate-400">VO2 Interval </span>
            <strong className="font-mono tabular-nums text-amber-400">{zones.interval.label}</strong>
          </span>
          <span>
            <span className="text-slate-400">400m Rep </span>
            <strong className="font-mono tabular-nums text-slate-100">{zones.rep_400m}</strong>
          </span>
        </div>
      </section>

      {/* ── Section 2: Hero Prediction + Race-Time Weather & Course Conditions ── */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Hero Prediction */}
        <div className="flex flex-col justify-between rounded-xl border border-slate-800/80 bg-[#111720] p-6 lg:col-span-5">
          <div>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Race distance">
              {PRIMARY_DISTANCES.map((dist) => {
                const active = dist === selectedDistance;
                return (
                  <button
                    key={dist}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => onSelectDistance(dist)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-sky-500 text-slate-950 font-semibold'
                        : 'bg-[#0D131B] text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {dist}
                  </button>
                );
              })}
            </div>

            <div className="mt-6">
              <div className="text-xs text-slate-400">
                {selectedDistance} Forecast · {activeCourse.short_name}
              </div>
              <div
                className="mt-1 font-mono text-5xl font-bold tracking-tight tabular-nums text-slate-50"
                data-testid="hero-predicted-time"
              >
                {prediction.time_fmt}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums">
                <span className="text-emerald-400">Fast {prediction.fast_fmt}</span>
                <span className="text-slate-600" aria-hidden="true">/</span>
                <span className="text-amber-400">Slow {prediction.slow_fmt}</span>
                <span className="text-slate-600" aria-hidden="true">·</span>
                <span className="text-slate-200">Goal {prediction.pace_per_mile}/mi</span>
              </div>

              <div className="mt-3 text-xs">
                <span
                  className={
                    prediction.adjustment_pct > 0.1
                      ? 'font-medium text-rose-400'
                      : prediction.adjustment_pct < -0.1
                        ? 'font-medium text-emerald-400'
                        : 'text-slate-400'
                  }
                >
                  {prediction.adjustment_pct > 0.1
                    ? `+${prediction.adjustment_pct.toFixed(1)}% slower from conditions`
                    : prediction.adjustment_pct < -0.1
                      ? `${prediction.adjustment_pct.toFixed(1)}% faster from conditions`
                      : 'Neutral environmental conditions (0.0%)'}
                </span>
              </div>

              {Object.keys(prediction.adjustments).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-slate-400">
                  {Object.entries(prediction.adjustments).map(([key, val]) => (
                    <span
                      key={key}
                      className={val > 0 ? 'text-rose-300/90' : 'text-emerald-300/90'}
                    >
                      {key} {val > 0 ? `+${val}%` : `${val}%`}
                    </span>
                  ))}
                </div>
              )}

              {prediction.readiness_status !== 'READY' && (
                <div className="mt-4 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
                  <strong className="font-semibold text-amber-100">
                    {prediction.readiness_status}:
                  </strong>{' '}
                  {prediction.readiness_note}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 border-t border-slate-800/80 pt-3">
            <button
              type="button"
              onClick={() => setShowModels((v) => !v)}
              aria-expanded={showModels}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-100"
            >
              {showModels ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {showModels ? 'Hide Model Ensemble Breakdown' : 'Show Model Ensemble Breakdown'}
            </button>

            {showModels && (
              <div className="mt-3 space-y-1.5 text-xs">
                {Object.entries(prediction.models).map(([k, m]) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-slate-400">
                      {MODEL_LABELS[k] ?? k} ({Math.round(m.weight * 100)}%)
                    </span>
                    <span className="font-mono tabular-nums text-slate-200">{m.time_fmt}</span>
                  </div>
                ))}
                {prediction.volume_penalty_pct > 0 && (
                  <div className="flex items-center justify-between text-amber-400">
                    <span>Volume Durability Penalty</span>
                    <span className="font-mono tabular-nums">
                      +{prediction.volume_penalty_pct}% (vs {prediction.theoretical_time_fmt})
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Course Selector + Race-Time Weather Sync + Sliders */}
        <div className="space-y-4 rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-7">
          <div>
            <label htmlFor="course-preset-select" className="block text-xs text-slate-400">
              Verified Course Profile
            </label>
            <select
              id="course-preset-select"
              value={selectedCourseId}
              onChange={(e) => onSelectCourse(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D12] px-3 py-2 text-xs font-medium text-slate-100 focus:border-sky-500 focus:outline-none"
            >
              {PRESET_COURSES.map((c) => (
                <option key={c.course_id} value={c.course_id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Race Date & Start Time Weather Sync Row */}
          <div className="rounded-lg border border-slate-800/80 bg-[#0D131B] p-3.5">
            <div className="flex flex-wrap items-end gap-2.5">
              <div className="min-w-[140px] flex-1">
                <label
                  htmlFor="race-date-input"
                  className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400"
                >
                  <Calendar className="h-3 w-3 text-sky-400" />
                  Race Date
                </label>
                <input
                  id="race-date-input"
                  type="date"
                  value={raceDate}
                  onChange={(e) => onChangeRaceDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="w-[126px]">
                <label
                  htmlFor="race-time-input"
                  className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400"
                >
                  <Clock className="h-3 w-3 text-sky-400" />
                  Start Time
                </label>
                <input
                  id="race-time-input"
                  type="time"
                  value={raceTime}
                  onChange={(e) => onChangeRaceTime(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <button
                type="button"
                onClick={() => handleSyncWeather(true)}
                disabled={weatherLoading || !raceDate}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                {weatherLoading ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudSun className="h-3.5 w-3.5" />
                )}
                Sync Race Weather
              </button>

              <button
                type="button"
                onClick={() => handleSyncWeather(false)}
                disabled={weatherLoading}
                className="rounded-lg border border-slate-700 px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0"
                title="Sync live current weather at this course"
              >
                Now
              </button>
            </div>

            {syncedWeather && (
              <div
                className="mt-3 border-t border-slate-800/80 pt-2.5 text-xs"
                data-testid="synced-weather-banner"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-x-2 text-slate-200">
                    <span className="font-semibold text-sky-300">
                      {SOURCE_LABELS[syncedWeather.source]}
                    </span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-slate-300">
                      {syncedWeather.target_datetime} {syncedWeather.timezone_abbr}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-slate-300">
                    <span>{syncedWeather.condition_label}</span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span>{syncedWeather.temp_f}°F</span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span>{syncedWeather.humidity}% RH</span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <Wind className="h-3 w-3 text-slate-400" />
                      {syncedWeather.wind_mph} mph {syncedWeather.wind_compass}
                    </span>
                  </div>
                </div>
                {syncedWeather.note && (
                  <p className="mt-1 text-[11px] text-amber-300/90">{syncedWeather.note}</p>
                )}
              </div>
            )}
          </div>

          <p className="text-xs leading-relaxed text-slate-400">{activeCourse.description}</p>

          <ElevationProfileChart
            profile={activeCourse.profile}
            courseName={activeCourse.short_name}
          />

          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
            <div>
              <label htmlFor="cond-surface" className="block text-xs text-slate-400">
                Surface (Auto-Matches Shoe)
              </label>
              <select
                id="cond-surface"
                value={conditions.surface}
                onChange={(e) => handleSurfaceChange(e.target.value as SurfaceType)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D12] px-3 py-2 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                {(Object.keys(SURFACE_OPTIONS) as SurfaceType[]).map((k) => (
                  <option key={k} value={k}>
                    {SURFACE_OPTIONS[k].label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="cond-shoe" className="block text-xs text-slate-400">
                5-Shoe Rotation
              </label>
              <select
                id="cond-shoe"
                value={conditions.shoe_type}
                onChange={(e) =>
                  onChangeConditions({ ...conditions, shoe_type: e.target.value as ShoeId })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D12] px-3 py-2 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                {(Object.keys(SHOE_DATABASE) as ShoeId[]).map((k) => (
                  <option key={k} value={k}>
                    {SHOE_DATABASE[k].label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cond-temp" className="text-slate-400">Temperature</label>
                <span className="font-mono tabular-nums text-slate-200">{conditions.temperature_f}°F</span>
              </div>
              <input
                id="cond-temp"
                type="range"
                min={10}
                max={100}
                value={conditions.temperature_f}
                onChange={(e) =>
                  onChangeConditions({ ...conditions, temperature_f: Number(e.target.value) })
                }
                className="racekit-slider mt-2 w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cond-humidity" className="text-slate-400">Humidity</label>
                <span className="font-mono tabular-nums text-slate-200">{conditions.humidity_pct}%</span>
              </div>
              <input
                id="cond-humidity"
                type="range"
                min={10}
                max={100}
                value={conditions.humidity_pct}
                onChange={(e) =>
                  onChangeConditions({ ...conditions, humidity_pct: Number(e.target.value) })
                }
                className="racekit-slider mt-2 w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cond-wind" className="text-slate-400">Wind Speed</label>
                <span className="font-mono tabular-nums text-slate-200">{conditions.wind_mph} mph</span>
              </div>
              <input
                id="cond-wind"
                type="range"
                min={0}
                max={40}
                value={conditions.wind_mph}
                onChange={(e) =>
                  onChangeConditions({ ...conditions, wind_mph: Number(e.target.value) })
                }
                className="racekit-slider mt-2 w-full"
              />
            </div>

            <div>
              <label htmlFor="cond-wind-dir" className="block text-xs text-slate-400">
                Wind Direction
              </label>
              <select
                id="cond-wind-dir"
                value={conditions.wind_direction}
                onChange={(e) =>
                  onChangeConditions({
                    ...conditions,
                    wind_direction: e.target.value as WindDirection,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                <option value="head">Headwind</option>
                <option value="tail">Tailwind</option>
                <option value="cross">Crosswind</option>
                <option value="mixed">Mixed / Out-and-Back</option>
              </select>
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cond-elev" className="text-slate-400">Elevation Gain</label>
                <span className="font-mono tabular-nums text-slate-200">{conditions.elevation_gain_ft} ft</span>
              </div>
              <input
                id="cond-elev"
                type="range"
                min={0}
                max={600}
                step={5}
                value={conditions.elevation_gain_ft}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  onChangeConditions({
                    ...conditions,
                    elevation_gain_ft: val,
                    elevation_loss_ft: val,
                  });
                }}
                className="racekit-slider mt-2 w-full"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <label htmlFor="cond-readiness" className="text-xs text-slate-300">
                Apply Watch Readiness Modifier
                {!hasSyncedHealth && (
                  <span className="ml-1 text-[11px] text-slate-500">(sync watch first)</span>
                )}
              </label>
              <input
                id="cond-readiness"
                type="checkbox"
                disabled={!hasSyncedHealth}
                checked={hasSyncedHealth && conditions.use_readiness}
                onChange={(e) =>
                  onChangeConditions({ ...conditions, use_readiness: e.target.checked })
                }
                className="h-4 w-4 rounded border-slate-600 bg-[#090D12] accent-sky-500 disabled:opacity-40"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 3: Course Splits & 5-Shoe Comparison Matrix ── */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">Race Pacing Splits</h2>
            <select
              aria-label="Split pacing strategy"
              value={splitStrategy}
              onChange={(e) => setSplitStrategy(e.target.value as SplitStrategy)}
              className="rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1 text-xs font-medium text-sky-400 focus:border-sky-500 focus:outline-none"
            >
              <option value="course_gap">Course Grade-Adjusted (GAP)</option>
              <option value="negative">Negative Split</option>
              <option value="even">Even Split</option>
            </select>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400">
                  <th className="pb-2.5 pr-2">Segment</th>
                  <th className="px-2 pb-2.5 text-right">Split</th>
                  <th className="px-2 pb-2.5 text-right">Elapsed</th>
                  <th className="px-2 pb-2.5 text-right">Pace</th>
                  <th className="pb-2.5 pl-3">Execution Cue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {splits.map((s) => (
                  <tr key={s.label}>
                    <td className="py-2.5 pr-2 font-medium text-slate-100">{s.label}</td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-200">
                      {s.segment_time_fmt}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-sky-300">
                      {s.cumulative_time_fmt}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {s.pace_per_mile}/mi
                    </td>
                    <td className="py-2.5 pl-3 text-[11px] text-slate-400">{s.cue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">5-Shoe Comparison Matrix</h2>
            <span className="text-xs text-slate-400">
              {SURFACE_OPTIONS[conditions.surface].label} · {selectedDistance}
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {shoeMatrix.map((s) => {
              const selected = s.shoe_id === conditions.shoe_type;
              const tagColor =
                s.tag === 'OPTIMAL'
                  ? 'text-emerald-400'
                  : s.tag === 'SURFACE HAZARD'
                    ? 'text-rose-400'
                    : s.tag === 'TRAINING HEAVY'
                      ? 'text-amber-400'
                      : 'text-slate-400';

              return (
                <button
                  key={s.shoe_id}
                  type="button"
                  onClick={() => onChangeConditions({ ...conditions, shoe_type: s.shoe_id })}
                  className={`flex w-full items-center justify-between rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                    selected
                      ? 'border-sky-500/70 bg-sky-500/10'
                      : 'border-slate-800/80 bg-[#0D131B] hover:border-slate-700'
                  }`}
                >
                  <div>
                    <div className="text-xs font-semibold text-slate-100">{s.short_label}</div>
                    <div className={`mt-0.5 text-[11px] font-medium ${tagColor}`}>{s.tag}</div>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className="text-sm font-bold text-slate-50">{s.time_fmt}</div>
                    <div className="text-[11px] text-slate-400">
                      {s.delta_s === 0 ? 'Fastest' : `+${s.delta_s}s`}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Section 4: All Distances Table & Verified PRs ── */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-8">
          <h2 className="text-sm font-semibold text-slate-100">All Standard Distances</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400">
                  <th className="pb-2.5 pr-2">Distance</th>
                  <th className="px-2 pb-2.5 text-right">Predicted</th>
                  <th className="px-2 pb-2.5 text-right">Range</th>
                  <th className="px-2 pb-2.5 text-right">Pace</th>
                  <th className="px-2 pb-2.5 text-right">Adj.</th>
                  <th className="pb-2.5 pl-3 text-right">Base Durability</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {allPredictions.map((p) => (
                  <tr
                    key={p.distance_label}
                    onClick={() => onSelectDistance(p.distance_label)}
                    className={`cursor-pointer transition-colors hover:bg-slate-800/40 ${
                      p.distance_label === selectedDistance ? 'bg-sky-500/10' : ''
                    }`}
                  >
                    <td className="py-2.5 pr-2 font-semibold text-slate-100">{p.distance_label}</td>
                    <td className="px-2 py-2.5 text-right font-mono font-bold tabular-nums text-slate-50">
                      {p.time_fmt}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-400">
                      {p.fast_fmt}–{p.slow_fmt}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-200">
                      {p.pace_per_mile}/mi
                    </td>
                    <td
                      className={`px-2 py-2.5 text-right font-mono tabular-nums ${
                        p.adjustment_pct > 0.1
                          ? 'text-rose-400'
                          : p.adjustment_pct < -0.1
                            ? 'text-emerald-400'
                            : 'text-slate-500'
                      }`}
                    >
                      {p.adjustment_pct > 0 ? `+${p.adjustment_pct.toFixed(1)}%` : `${p.adjustment_pct.toFixed(1)}%`}
                    </td>
                    <td
                      className={`py-2.5 pl-3 text-right text-[11px] font-semibold ${
                        p.readiness_status === 'READY'
                          ? 'text-emerald-400'
                          : p.readiness_status === 'VOLUME STRETCH'
                            ? 'text-amber-400'
                            : 'text-rose-400'
                      }`}
                    >
                      {p.readiness_status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-4">
          <h2 className="text-sm font-semibold text-slate-100">Verified Best Efforts (PRs)</h2>
          <div className="mt-4 divide-y divide-slate-800/60">
            {efforts.map((e) => {
              const paceS = e.time_s / (e.distance_m / 1609.344);
              return (
                <div key={e.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">{e.label}</div>
                    <div className="text-[11px] text-slate-500">
                      {e.date} {e.hr_avg ? `· ${e.hr_avg} bpm` : ''}
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className="text-sm font-bold text-sky-400">{formatTime(e.time_s)}</div>
                    <div className="text-[11px] text-slate-400">{formatPace(paceS)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
