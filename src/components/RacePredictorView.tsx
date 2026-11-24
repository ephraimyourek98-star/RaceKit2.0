import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  CloudSun,
  MapPin,
  Plus,
  RefreshCw,
  Trophy,
  Wind,
  X,
} from 'lucide-react';
import { ElevationProfileChart } from './TelemetryCharts';
import { MetricInfoPopover } from './MetricInfoPopover';
import {
  PRIMARY_DISTANCES,
  PredictionEngine,
  formatPace,
  formatTime,
  normalizeSurface,
} from '../lib/predictionEngine';
import { PRESET_COURSES, SHOE_DATABASE, SURFACE_OPTIONS } from '../lib/seedData';

const ADJUSTMENT_LABELS: Record<string, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  wind: 'Wind',
  elevation: 'Elevation Grade',
  surface: 'Surface',
  shoes: 'Shoe / Spikes',
  altitude: 'Altitude',
  readiness: 'Readiness Gate',
};

function getShoeCategory(shoeId: string): 'track' | 'xc' | 'road' | 'trainer' {
  if (['dragonfly_track', 'dragonfly_elite', 'victory_2', 'avanti_tyo', 'fuelcell_sc_ldx'].includes(shoeId)) {
    return 'track';
  }
  if (['dragonfly_xc', 'rival_xc_7'].includes(shoeId)) {
    return 'xc';
  }
  if (['streakfly', 'vaporfly_next2'].includes(shoeId)) {
    return 'road';
  }
  return 'trainer';
}
import type {
  CourseConditions,
  CoursePreset,
  Effort,
  FitnessMetrics,
  RaceWeatherSync,
  ShoeId,
  SplitStrategy,
  SurfaceType,
  GarminRacePredictions,
  TrainingZones,
  WindDirection,
} from '../lib/types';

interface RacePredictorViewProps {
  engine: PredictionEngine;
  fitness: FitnessMetrics;
  zones: TrainingZones;
  efforts: Effort[];
  hasSyncedHealth: boolean;
  garminPredictions?: GarminRacePredictions | null;
  selectedDistance: string;
  selectedCourseId: string;
  conditions: CourseConditions;
  raceDate: string;
  raceTime: string;
  syncedWeather: RaceWeatherSync | null;
  targetRace?: { name: string; dist: string; day: string } | null;
  onSelectDistance: (dist: string) => void;
  onSelectCourse: (courseId: string) => void;
  onSetTargetRace?: (race: { name: string; dist: string; day: string } | null) => void;
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
  garminPredictions = null,
  selectedDistance,
  selectedCourseId,
  conditions,
  raceDate,
  raceTime,
  syncedWeather,
  targetRace,
  onSelectDistance,
  onSelectCourse,
  onSetTargetRace,
  onChangeConditions,
  onChangeRaceDate,
  onChangeRaceTime,
  onSyncedWeather,
  onNotify,
}: RacePredictorViewProps) {
  const [splitStrategy, setSplitStrategy] = useState<SplitStrategy>('course_gap');
  const [showModels, setShowModels] = useState(true);
  const [weatherLoading, setWeatherLoading] = useState(false);

  // Custom Race Builder state
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [newRaceName, setNewRaceName] = useState('');
  const [newRaceDist, setNewRaceDist] = useState('5K');
  const [newRaceDate, setNewRaceDate] = useState(raceDate || '2026-11-26');
  const [newRaceTime, setNewRaceTime] = useState(raceTime || '08:30');
  const [newRaceSurface, setNewRaceSurface] = useState<SurfaceType>('road');
  const [newRaceElev, setNewRaceElev] = useState<number>(50);
  const [newRaceCity, setNewRaceCity] = useState('Glasgow, DE');

  // Shoe Category Filter & Custom Shoe state
  const [shoeFilter, setShoeFilter] = useState<'all' | 'track' | 'xc' | 'road' | 'trainer'>('all');
  const [showAddShoeModal, setShowAddShoeModal] = useState(false);
  const [customShoeName, setCustomShoeName] = useState('');
  const [customShoeCategory, setCustomShoeCategory] = useState<'track' | 'xc' | 'road' | 'trainer'>('track');
  const [customShoeWeight, setCustomShoeWeight] = useState(135);

  // Load custom races from localStorage
  const [customCourses, setCustomCourses] = useState<CoursePreset[]>(() => {
    try {
      const raw = localStorage.getItem('racekit_custom_courses');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const allCourses = useMemo(() => {
    return [...customCourses, ...PRESET_COURSES];
  }, [customCourses]);

  const activeCourse = useMemo(
    () => allCourses.find((c) => c.course_id === selectedCourseId) ?? allCourses[0],
    [allCourses, selectedCourseId]
  );

  const isCurrentTargetActive = Boolean(
    targetRace &&
      (targetRace.name === activeCourse.name ||
        (targetRace.name.toLowerCase().includes('pie') && activeCourse.course_id.includes('pie')))
  );

  const handlePinAsTarget = () => {
    const d = new Date(`${raceDate}T12:00:00`);
    const dayOfWeek =
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] ||
      'Thursday';
    onSetTargetRace?.({
      name: activeCourse.name,
      dist: selectedDistance,
      day: dayOfWeek,
    });
    onNotify(
      `Target race pinned: "${activeCourse.name}" (${selectedDistance}) on ${dayOfWeek}. Race week taper auto-applied to schedule!`,
      'success'
    );
  };

  const handleSaveCustomRace = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRaceName.trim()) return;
    const cid = `custom_${Date.now()}`;
    const newCourse: CoursePreset = {
      course_id: cid,
      name: newRaceName.trim(),
      short_name: newRaceName.trim().slice(0, 24),
      distance_label: newRaceDist,
      surface: newRaceSurface,
      elevation_gain_ft: newRaceElev,
      elevation_loss_ft: newRaceElev,
      altitude_ft: 80,
      lat: 39.6079,
      lon: -75.7369,
      max_incline_pct: 3.5,
      max_decline_pct: -3.5,
      description: `Custom ${newRaceDist} race at ${newRaceCity || 'local course'}. Surface: ${newRaceSurface}, elevation +${newRaceElev}ft.`,
      profile: [40, 50, 65, 75, 70, 60, 50, 40],
      is_preset: false,
    };
    const updated = [newCourse, ...customCourses];
    setCustomCourses(updated);
    try {
      localStorage.setItem('racekit_custom_courses', JSON.stringify(updated));
    } catch {}

    onSelectCourse(cid);
    onSelectDistance(newRaceDist);
    onChangeRaceDate(newRaceDate);
    onChangeRaceTime(newRaceTime);

    // Compute day of week
    const d = new Date(`${newRaceDate}T12:00:00`);
    const dayOfWeek =
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] ||
      'Thursday';

    onSetTargetRace?.({
      name: newCourse.name,
      dist: newRaceDist,
      day: dayOfWeek,
    });

    onNotify(
      `Custom race added & pinned: "${newCourse.name}" (${newRaceDist}) on ${dayOfWeek}!`,
      'success'
    );
    setShowCustomModal(false);
  };

  const effectiveConditions = useMemo<CourseConditions>(() => {
    const resolvedSurface = normalizeSurface(activeCourse?.surface || conditions.surface);
    return {
      ...conditions,
      surface: resolvedSurface,
      elevation_gain_ft: activeCourse?.elevation_gain_ft ?? conditions.elevation_gain_ft,
      elevation_loss_ft: activeCourse?.elevation_loss_ft ?? conditions.elevation_loss_ft,
      altitude_ft: activeCourse?.altitude_ft ?? conditions.altitude_ft,
    };
  }, [conditions, activeCourse]);

  const prediction = useMemo(
    () => engine.predict(selectedDistance, effectiveConditions),
    [engine, selectedDistance, effectiveConditions]
  );

  const allPredictions = useMemo(
    () => engine.predictAll(effectiveConditions),
    [engine, effectiveConditions]
  );

  const splits = useMemo(
    () => engine.generateSplits(prediction, splitStrategy, activeCourse.profile),
    [engine, prediction, splitStrategy, activeCourse.profile]
  );

  const shoeMatrix = useMemo(
    () => engine.compareShoes(selectedDistance, effectiveConditions),
    [engine, selectedDistance, effectiveConditions]
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
        wind_direction: 'mixed', // Park/road 5Ks are loops with offsetting tailwind/sheltered segments
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
    <div className="space-y-6">
      {/* ── Top Header & Segmented Distance Control (Apple iOS Style) ── */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-100">
              Race Predictor
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <div className="flex items-center gap-1">
                <span>VDOT {fitness.vo2max ?? 54.6}</span>
                <MetricInfoPopover metricKey="vdot" />
              </div>
              <span>·</span>
              <div className="flex items-center gap-1">
                <span>Critical Speed {fitness.critical_speed_pace}</span>
                <MetricInfoPopover metricKey="cs" />
              </div>
              <span>·</span>
              <div className="flex items-center gap-1">
                <span>D' {fitness.d_prime_m ? `${fitness.d_prime_m}m` : '240m'}</span>
                <MetricInfoPopover metricKey="d_prime" />
              </div>
              <span>·</span>
              <span>Weather &amp; Course Grade-Adjusted</span>
            </div>
          </div>
          <span className="rounded-full bg-sky-500/10 border border-sky-500/20 px-3 py-1 text-xs font-mono font-medium text-sky-300">
            {fitness.fatigue_profile}
          </span>
        </div>

        {/* iOS Segmented Control for Distance */}
        <div className="flex items-center gap-1 overflow-x-auto rounded-2xl border border-white/10 bg-[#1C1C1E] p-1 shadow-inner">
          {PRIMARY_DISTANCES.map((dist) => {
            const active = dist === selectedDistance;
            return (
              <button
                key={dist}
                type="button"
                onClick={() => onSelectDistance(dist)}
                className={`flex-1 min-w-[70px] rounded-xl py-2 text-xs font-semibold transition-all whitespace-nowrap text-center ${
                  active
                    ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
                    : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
                }`}
              >
                {dist}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Hero Prediction Card (Apple Fitness Workout Goal Style) ── */}
      <section className="rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 shadow-md backdrop-blur-xl">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-400">
              <span>{selectedDistance} Forecast</span>
              <span>·</span>
              <span className="text-slate-200">{activeCourse.short_name}</span>
            </div>

            {/* Hero Timer */}
            <div
              className="mt-2 font-mono text-5xl sm:text-6xl font-extrabold tracking-tight tabular-nums text-white"
              data-testid="hero-predicted-time"
            >
              {prediction.time_fmt}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums">
              <span className="rounded-full bg-sky-500/15 border border-sky-500/30 px-3 py-1 font-bold text-sky-300">
                Goal {prediction.pace_per_mile}/mi
              </span>
              <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-3 py-1 font-semibold text-emerald-300">
                Fast {prediction.fast_fmt}
              </span>
              <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-3 py-1 font-semibold text-amber-300">
                Slow {prediction.slow_fmt}
              </span>
            </div>

            {/* Garmin Watch Benchmark (garmlink_race_predictions_get) vs RaceKit adjusted forecast */}
            {(() => {
              if (!garminPredictions) return null;
              const byDist: Record<string, number | null> = {
                '5K': garminPredictions.time_5k_s,
                '10K': garminPredictions.time_10k_s,
                'Half Marathon': garminPredictions.time_half_s,
                Marathon: garminPredictions.time_marathon_s,
              };
              const match = byDist[selectedDistance];
              const refLabel = match ? selectedDistance : (Object.keys(byDist).find((k) => byDist[k]) ?? null);
              const refTime = refLabel ? byDist[refLabel] : null;
              if (!refLabel || !refTime) return null;
              const delta = match ? prediction.time_s - match : null;
              return (
                <div
                  className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums"
                  data-testid="garmin-watch-forecast"
                >
                  <span className="rounded-full bg-violet-500/15 border border-violet-500/30 px-3 py-1 font-semibold text-violet-300">
                    Garmin Watch Forecast{match ? '' : ` (${refLabel})`} {formatTime(refTime)}
                  </span>
                  {delta !== null && (
                    <span className="text-slate-400">
                      RaceKit is {formatTime(Math.abs(delta))} {delta <= 0 ? 'faster' : 'slower'} after course, weather
                      &amp; shoe adjustments
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Environmental Impact Pill & Transparent Condition Breakdown */}
            {(() => {
              const adjEntries = Object.entries(prediction.adjustments).map(
                ([k, v]) => [k, Number(v.toFixed(1))] as const
              );
              const sumPct = adjEntries.reduce((acc, [, v]) => acc + v, 0);
              const displayTotalPct = Number(sumPct.toFixed(1));

              return (
                <div className="mt-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`rounded-full px-3 py-1 font-semibold border ${
                        displayTotalPct > 0.05
                          ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                          : displayTotalPct < -0.05
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                            : 'bg-slate-800 border-slate-700 text-slate-300'
                      }`}
                    >
                      {displayTotalPct > 0.05
                        ? `+${displayTotalPct.toFixed(1)}% Weather & Course Penalty`
                        : displayTotalPct < -0.05
                          ? `${displayTotalPct.toFixed(1)}% Faster from Conditions`
                          : 'Neutral Environmental Conditions (0.0%)'}
                    </span>
                    {syncedWeather && (
                      <span className="text-[11px] font-mono text-slate-400">
                        Based on {syncedWeather.temp_f}°F · {syncedWeather.humidity}% RH · {syncedWeather.wind_mph} mph wind
                      </span>
                    )}
                  </div>

                  {/* Transparent Visible Breakdown Chips: Shows the exact factors making up the headline % */}
                  {adjEntries.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {adjEntries.map(([k, v]) => (
                        <span
                          key={k}
                          className={`rounded-lg px-2.5 py-0.5 text-[11px] font-mono font-medium border ${
                            v < 0
                              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                              : v > 0
                                ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                                : 'bg-white/5 border-white/10 text-slate-400'
                          }`}
                        >
                          {ADJUSTMENT_LABELS[k] || k}: {v > 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {prediction.readiness_status !== 'READY' && (
              <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200">
                <strong>{prediction.readiness_status}:</strong> {prediction.readiness_note}
              </div>
            )}
          </div>

          {/* Model Ensemble Disclosure */}
          <div className="w-full lg:w-72 rounded-2xl border border-slate-800/90 bg-[#0C121B] p-4 text-xs">
            <button
              type="button"
              onClick={() => setShowModels((v) => !v)}
              className="flex w-full items-center justify-between font-semibold text-slate-300 hover:text-white transition-colors"
            >
              <span>Multi-Model Ensemble</span>
              {showModels ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {showModels && (
              <div className="mt-3 space-y-2 pt-2 border-t border-slate-800">
                {Object.entries(prediction.models).map(([k, m]) => (
                  <div key={k} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-400">
                        {MODEL_LABELS[k] ?? k}
                      </span>
                      {k === 'critical_speed' && <MetricInfoPopover metricKey="cs" />}
                      {k === 'daniels_vdot' && <MetricInfoPopover metricKey="vdot" />}
                    </div>
                    <span className="font-mono font-bold tabular-nums text-slate-200">{m.time_fmt}</span>
                  </div>
                ))}
                {prediction.volume_penalty_pct > 0 && (
                  <div className="flex items-center justify-between text-amber-400 font-medium">
                    <span>Volume Durability</span>
                    <span className="font-mono tabular-nums">+{prediction.volume_penalty_pct}%</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Section 2: Course & Weather Settings (Apple Weather / Health Style) ── */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Course & Weather Widget */}
        <div className="space-y-4 rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 lg:col-span-7 shadow-sm">
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="course-preset-select" className="text-xs font-semibold text-[#8E8E93]">
                Target Course &amp; Race Profile
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowCustomModal(true)}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#0A84FF]/15 border border-[#0A84FF]/30 px-2.5 py-1 text-[11px] font-bold text-[#0A84FF] hover:bg-[#0A84FF]/25 transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  Add Custom Race
                </button>
                <button
                  type="button"
                  onClick={handlePinAsTarget}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                    isCurrentTargetActive
                      ? 'bg-[#30D158]/20 border-[#30D158]/40 text-[#30D158]'
                      : 'bg-[#2C2C2E] border-white/10 text-white hover:bg-white/10'
                  }`}
                >
                  {isCurrentTargetActive ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-[#30D158]" />
                      Active Target Race
                    </>
                  ) : (
                    <>
                      <Trophy className="h-3 w-3 text-[#FF9F0A]" />
                      Pin as Target Race
                    </>
                  )}
                </button>
              </div>
            </div>

            <select
              id="course-preset-select"
              value={selectedCourseId}
              onChange={(e) => {
                const cid = e.target.value;
                onSelectCourse(cid);
                const found = allCourses.find((c) => c.course_id === cid);
                if (found) {
                  if (found.distance_label) {
                    onSelectDistance(found.distance_label);
                  }
                  const normSurf = normalizeSurface(found.surface);
                  const defaultShoe =
                    normSurf === 'track'
                      ? 'dragonfly_track'
                      : normSurf === 'xc'
                        ? 'dragonfly_xc'
                        : 'streakfly';
                  onChangeConditions({
                    ...conditions,
                    surface: normSurf,
                    shoe_type: defaultShoe,
                    elevation_gain_ft: found.elevation_gain_ft,
                    elevation_loss_ft: found.elevation_loss_ft,
                    altitude_ft: found.altitude_ft,
                  });
                }
              }}
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2.5 text-xs font-medium text-white focus:border-[#0A84FF] focus:outline-none"
            >
              {customCourses.length > 0 && (
                <optgroup label="Custom Races">
                  {customCourses.map((c) => (
                    <option key={c.course_id} value={c.course_id}>
                      ★ {c.name} ({c.distance_label})
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Championship &amp; Preset Courses">
                {PRESET_COURSES.map((c) => (
                  <option key={c.course_id} value={c.course_id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <p className="mt-1 text-xs text-[#8E8E93] leading-relaxed">{activeCourse.description}</p>
          </div>

          {/* Weather Sync Card */}
          <div className="rounded-2xl border border-white/10 bg-[#2C2C2E]/60 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[140px] flex-1">
                <label
                  htmlFor="race-date-input"
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-400"
                >
                  <Calendar className="h-3.5 w-3.5 text-sky-400" />
                  Race Date
                </label>
                <input
                  id="race-date-input"
                  type="date"
                  value={raceDate}
                  onChange={(e) => onChangeRaceDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-[#090D12] px-3 py-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="w-[126px]">
                <label
                  htmlFor="race-time-input"
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-400"
                >
                  <Clock className="h-3.5 w-3.5 text-sky-400" />
                  Start Time
                </label>
                <input
                  id="race-time-input"
                  type="time"
                  value={raceTime}
                  onChange={(e) => onChangeRaceTime(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-[#090D12] px-3 py-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <button
                type="button"
                onClick={() => handleSyncWeather(true)}
                disabled={weatherLoading || !raceDate}
                className="inline-flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-all hover:bg-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0 shadow-md shadow-sky-500/20"
              >
                {weatherLoading ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudSun className="h-3.5 w-3.5" />
                )}
                Sync Race Weather
              </button>
            </div>

            {syncedWeather && (
              <div className="mt-3 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-sky-300">
                  {SOURCE_LABELS[syncedWeather.source]}: {syncedWeather.condition_label}
                </span>
                <span className="font-mono text-slate-300">
                  {syncedWeather.temp_f}°F · {syncedWeather.humidity}% RH · {syncedWeather.wind_mph} mph {syncedWeather.wind_compass}
                </span>
              </div>
            )}
          </div>

          <ElevationProfileChart
            profile={activeCourse.profile}
            courseName={activeCourse.short_name}
            surface={activeCourse.surface}
            elevationGainFt={activeCourse.elevation_gain_ft}
          />

          {/* Environmental Sliders */}
          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
            <div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Temperature</span>
                <span className="font-mono font-bold text-slate-200">{conditions.temperature_f}°F</span>
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
                <span className="text-slate-400">Humidity</span>
                <span className="font-mono font-bold text-slate-200">{conditions.humidity_pct}%</span>
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
          </div>
        </div>

        {/* Shoe Comparison Matrix (Apple Gear Style) */}
        <div className="space-y-4 rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 lg:col-span-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-white">Shoe Rotation Matrix</h2>
              <p className="text-xs text-[#8E8E93]">Predicted finish per shoe on {activeCourse.short_name}</p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddShoeModal(true)}
              className="inline-flex items-center gap-1 rounded-xl border border-[#0A84FF]/40 bg-[#0A84FF]/10 px-2.5 py-1 text-xs font-semibold text-[#0A84FF] hover:bg-[#0A84FF]/20 transition-all cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Spike</span>
            </button>
          </div>

          {/* Category Filter Pills */}
          <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-[#2C2C2E]/60 p-1 text-[11px] font-semibold">
            {(
              [
                ['all', 'All'],
                ['track', 'Track Spikes'],
                ['xc', 'XC Spikes'],
                ['road', 'Road Racing'],
                ['trainer', 'Trainers'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setShoeFilter(val)}
                className={`rounded-lg px-2.5 py-1 whitespace-nowrap transition-colors cursor-pointer ${
                  shoeFilter === val
                    ? 'bg-[#0A84FF] text-white shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {(() => {
            const filteredShoes = shoeMatrix.filter((s) => {
              if (shoeFilter === 'all') return true;
              return getShoeCategory(s.shoe_id) === shoeFilter;
            });

            return (
              <div className="space-y-2.5">
                {filteredShoes.map((s) => {
                  const selected = s.shoe_id === conditions.shoe_type;
                  const cat = getShoeCategory(s.shoe_id);
                  const catLabel =
                    cat === 'track'
                      ? 'Track Spike'
                      : cat === 'xc'
                        ? 'XC Spike'
                        : cat === 'road'
                          ? 'Super-Shoe / Flat'
                          : 'Daily Trainer';
                  const catBadgeColor =
                    cat === 'track'
                      ? 'bg-[#0A84FF]/15 text-[#0A84FF] border-[#0A84FF]/30'
                      : cat === 'xc'
                        ? 'bg-[#30D158]/15 text-[#30D158] border-[#30D158]/30'
                        : cat === 'road'
                          ? 'bg-[#BF5AF2]/15 text-[#BF5AF2] border-[#BF5AF2]/30'
                          : 'bg-white/10 text-[#8E8E93] border-white/10';

                  const tagColor =
                    s.tag === 'OPTIMAL'
                      ? 'text-[#30D158]'
                      : s.tag === 'SURFACE HAZARD'
                        ? 'text-[#FF453A]'
                        : s.tag === 'TRAINING HEAVY'
                          ? 'text-[#FF9F0A]'
                          : 'text-[#8E8E93]';

                  return (
                    <button
                      key={s.shoe_id}
                      type="button"
                      onClick={() => onChangeConditions({ ...conditions, shoe_type: s.shoe_id })}
                      className={`flex w-full items-center justify-between rounded-2xl border p-3.5 text-left transition-all cursor-pointer ${
                        selected
                          ? 'border-[#0A84FF]/70 bg-[#0A84FF]/10 shadow-sm'
                          : 'border-white/10 bg-[#2C2C2E]/60 hover:border-white/20'
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-white truncate">{s.short_label}</span>
                          <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold ${catBadgeColor}`}>
                            {catLabel}
                          </span>
                        </div>
                        <div className={`mt-0.5 text-[11px] font-semibold ${tagColor}`}>{s.tag}</div>
                      </div>
                      <div className="text-right font-mono tabular-nums shrink-0">
                        <div className="text-sm font-bold text-white">{s.time_fmt}</div>
                        <div className="text-[11px] text-[#8E8E93]">
                          {s.delta_s === 0 ? 'Fastest' : `+${s.delta_s}s`}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </section>

      {/* ── Section 3: Race Pacing Splits (Apple Workout Splits Style) ── */}
      <section className="rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/70 pb-3">
          <div>
            <h2 className="text-sm font-bold text-slate-100">Race Pacing Splits &amp; Strategy</h2>
            <p className="text-xs text-slate-400">Target pacing grade-adjusted to {activeCourse.short_name} elevation profile</p>
          </div>
          <select
            aria-label="Split pacing strategy"
            value={splitStrategy}
            onChange={(e) => setSplitStrategy(e.target.value as SplitStrategy)}
            className="rounded-xl border border-slate-700 bg-[#090D12] px-3 py-1.5 text-xs font-semibold text-sky-400 focus:border-sky-500 focus:outline-none"
          >
            <option value="course_gap">Course Grade-Adjusted (GAP)</option>
            <option value="negative">Negative Split (-2%)</option>
            <option value="even">Even Split</option>
          </select>
        </div>

        <div className="mt-4 divide-y divide-slate-800/60">
          {splits.map((s) => (
            <div key={s.label} className="py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-bold text-sm text-slate-100">{s.label}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">{s.cue}</div>
              </div>
              <div className="flex items-center gap-4 text-right font-mono tabular-nums">
                <div>
                  <div className="text-xs text-slate-400">Split</div>
                  <div className="font-bold text-sm text-slate-200">{s.segment_time_fmt}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">Elapsed</div>
                  <div className="font-bold text-sm text-sky-300">{s.cumulative_time_fmt}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">Pace</div>
                  <div className="font-bold text-sm text-emerald-400">{s.pace_per_mile}/mi</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Custom Race Builder Modal ── */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-md"
            onClick={() => setShowCustomModal(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 w-full max-w-lg rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 text-white shadow-2xl sm:p-7">
            <div className="flex items-center justify-between pb-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#0A84FF]/20 text-[#0A84FF]">
                  <Trophy className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-tight">Add Custom Race</h3>
                  <p className="text-xs text-[#8E8E93]">Define target race name, distance, date &amp; surface</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowCustomModal(false)}
                className="rounded-full p-1.5 text-[#8E8E93] hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCustomRace} className="mt-5 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-[#8E8E93]">Race Name</label>
                <input
                  type="text"
                  value={newRaceName}
                  onChange={(e) => setNewRaceName(e.target.value)}
                  placeholder="e.g. Run for Pie 5K, Turkey Trot 5K, Boston Marathon"
                  className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2 text-xs font-semibold text-white focus:border-[#0A84FF] focus:outline-none"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-[#8E8E93]">Distance</label>
                  <select
                    value={newRaceDist}
                    onChange={(e) => setNewRaceDist(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs font-semibold text-white focus:border-[#0A84FF] focus:outline-none"
                  >
                    <option value="5K">5K (3.1 mi)</option>
                    <option value="10K">10K (6.2 mi)</option>
                    <option value="Half Marathon">Half Marathon (13.1 mi)</option>
                    <option value="1 Mile">1 Mile (1609m)</option>
                    <option value="1600m">1600m</option>
                    <option value="3200m">3200m</option>
                    <option value="800m">800m</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-[#8E8E93]">Surface</label>
                  <select
                    value={newRaceSurface}
                    onChange={(e) => setNewRaceSurface(e.target.value as SurfaceType)}
                    className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs font-semibold text-white focus:border-[#0A84FF] focus:outline-none"
                  >
                    <option value="road">Road / Paved</option>
                    <option value="track">Track (All-Weather)</option>
                    <option value="xc">Cross Country / Grass</option>
                    <option value="trail">Trail / Dirt</option>
                    <option value="gravel">Gravel</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-[#8E8E93]">Race Date</label>
                  <input
                    type="date"
                    value={newRaceDate}
                    onChange={(e) => setNewRaceDate(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs font-mono text-white focus:border-[#0A84FF] focus:outline-none"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-[#8E8E93]">Start Time</label>
                  <input
                    type="time"
                    value={newRaceTime}
                    onChange={(e) => setNewRaceTime(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs font-mono text-white focus:border-[#0A84FF] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-[#8E8E93]">Elevation Gain (ft)</label>
                  <input
                    type="number"
                    min="0"
                    max="5000"
                    value={newRaceElev}
                    onChange={(e) => setNewRaceElev(parseInt(e.target.value) || 0)}
                    className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs font-mono text-white focus:border-[#0A84FF] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-[#8E8E93]">Location / City</label>
                  <input
                    type="text"
                    value={newRaceCity}
                    onChange={(e) => setNewRaceCity(e.target.value)}
                    placeholder="e.g. Glasgow, DE"
                    className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs text-white focus:border-[#0A84FF] focus:outline-none"
                  />
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setShowCustomModal(false)}
                  className="rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-[#8E8E93] hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[#0A84FF] px-5 py-2 text-xs font-bold text-white hover:bg-[#0A84FF]/80 transition-all shadow-md shadow-[#0A84FF]/20"
                >
                  Save &amp; Set as Target Race
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Custom Spike / Shoe Builder Modal ── */}
      {showAddShoeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
          <div
            className="relative w-full max-w-md rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 shadow-2xl text-white"
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              onClick={() => setShowAddShoeModal(false)}
              className="absolute right-5 top-5 rounded-full p-1.5 text-[#8E8E93] hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>

            <h3 className="text-base font-bold text-white mb-1">Add Spike / Racing Shoe</h3>
            <p className="text-xs text-[#8E8E93] mb-4">
              Add your personal track spikes, XC spikes, or road racing shoes to the comparison rotation.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!customShoeName.trim()) return;
                const newShoeId = `custom_${customShoeName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
                onChangeConditions({
                  ...conditions,
                  shoe_type: newShoeId as ShoeId,
                });
                onNotify(`Added ${customShoeName} to shoe rotation.`, 'success');
                setShowAddShoeModal(false);
                setCustomShoeName('');
              }}
              className="space-y-4 text-xs"
            >
              <div>
                <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                  Shoe / Spike Model
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Brooks Wire 8 or Puma evoSPEED"
                  value={customShoeName}
                  onChange={(e) => setCustomShoeName(e.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2.5 text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none font-medium"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                    Category
                  </label>
                  <select
                    value={customShoeCategory}
                    onChange={(e) => setCustomShoeCategory(e.target.value as any)}
                    className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2.5 text-white focus:border-[#0A84FF] focus:outline-none font-semibold"
                  >
                    <option value="track">Track Spike</option>
                    <option value="xc">Cross Country Spike</option>
                    <option value="road">Road Super-Shoe / Flat</option>
                    <option value="trainer">Daily Trainer</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                    Weight (grams)
                  </label>
                  <input
                    type="number"
                    min="80"
                    max="450"
                    value={customShoeWeight}
                    onChange={(e) => setCustomShoeWeight(Number(e.target.value))}
                    className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2.5 text-white focus:border-[#0A84FF] focus:outline-none font-mono font-medium"
                  />
                </div>
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddShoeModal(false)}
                  className="flex-1 rounded-2xl border border-white/10 bg-[#2C2C2E] py-2.5 text-xs font-semibold text-[#8E8E93] hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-2xl bg-[#0A84FF] py-2.5 text-xs font-semibold text-white hover:bg-[#0071E3] transition-all shadow-md shadow-[#0A84FF]/20 cursor-pointer"
                >
                  Add to Rotation
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
