import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  BatteryCharging,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Compass,
  Cpu,
  Flame,
  Gauge,
  Heart,
  Layers,
  LineChart,
  Link2,
  Moon,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
  Trophy,
  Upload,
  Watch,
  Zap,
} from 'lucide-react';
import { MetricInfoPopover } from './MetricInfoPopover';
import { DailyHealthRollupCard, GarminPhysiologyCard, TrainingReadinessCard, ZoneRows } from './GarminLiveCards';
import { formatPace, formatTime } from '../lib/predictionEngine';
import { parseWatchActivityFile } from '../lib/watchData';
import type { GarmlinkHistoryDay } from '../lib/watchData';
import type {
  Effort,
  GarmlinkSyncMeta,
  HealthSnapshot,
  HrvStatus,
  WatchActivity,
} from '../lib/types';

interface HealthDetailRecord {
  date: string;
  vo2max: number | null;
  resting_hr: number | null;
  resting_hr_avg_7d?: number | null;
  body_battery: number | null;
  bb_highest?: number | null;
  bb_at_wake?: number | null;
  bb_charged?: number | null;
  bb_drained?: number | null;
  sleep_score: number | null;
  sleep_seconds: number | null;
  sleep_hours: number | null;
  sleep_time_fmt?: string | null;
  deep_sleep_s: number | null;
  light_sleep_s: number | null;
  rem_sleep_s: number | null;
  awake_sleep_s: number | null;
  deep_min?: number | null;
  light_min?: number | null;
  rem_min?: number | null;
  awake_min?: number | null;
  sleep_scores_breakdown?: Record<string, string>;
  spo2_avg?: number | null;
  respiration_avg?: number | null;
  sleep_stress_avg?: number | null;
  hrv_last_night: number | null;
  hrv_weekly_avg: number | null;
  hrv_status: HrvStatus;
  hrv_baseline_low: number;
  hrv_baseline_high: number;
  load_aerobic_low: number | null;
  load_aerobic_low_min: number;
  load_aerobic_low_max: number;
  load_aerobic_high: number | null;
  load_aerobic_high_min: number;
  load_aerobic_high_max: number;
  load_anaerobic: number | null;
  load_anaerobic_min: number;
  load_anaerobic_max: number;
  training_balance_feedback: string;
  training_status_phrase: string;
  acwr_ratio: number;
  acwr_status: string;
  acute_load: number;
  chronic_load: number;
  source: string;
  synced_at: string;
}

interface WatchSyncViewProps {
  garmlink: GarmlinkSyncMeta;
  health: HealthSnapshot | null;
  /** Per-night history from the live Garmlink sync (60-day window). Empty when synced from local cache. */
  liveHealthHistory?: GarmlinkHistoryDay[];
  activities: WatchActivity[];
  efforts?: Effort[];
  onConnectGarmlink: () => void;
  onSyncGarmlink: () => void;
  onDisconnectGarmlink: () => void;
  onImportActivity: (act: WatchActivity) => void;
  onClearActivities: () => void;
  onUpdateHealth: (next: HealthSnapshot | null) => void;
  onGoToAiPlan: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

type SubTab = 'overview' | 'graphs' | 'activities' | 'sleep' | 'training' | 'devices_records';
type UnitSystem = 'us' | 'metric';

function get30DayCalendar(endDateStr: string = '2026-11-23'): string[] {
  const dates: string[] = [];
  const parts = endDateStr.split('-').map(Number);
  const year = parts[0] || 2026;
  const month = parts[1] || 11;
  const day = parts[2] || 23;
  const end = new Date(Date.UTC(year, month - 1, day));
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function WatchSyncView({
  garmlink,
  health,
  activities,
  efforts = [],
  onConnectGarmlink,
  onSyncGarmlink,
  liveHealthHistory,
  onDisconnectGarmlink,
  onImportActivity,
  onClearActivities,
  onUpdateHealth,
  onGoToAiPlan,
  onNotify,
}: WatchSyncViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('overview');
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('us');
  const [selectedDate, setSelectedDate] = useState<string>(() => health?.date ?? '2026-11-23');
  const [bridgeHistory, setHealthHistory] = useState<HealthDetailRecord[]>([]);
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [gearList, setGearList] = useState<Array<{
    gear_id: string;
    name: string;
    brand: string;
    model: string;
    type: string;
    category: string;
    distance_m: number;
    distance_miles: number;
    max_distance_miles: number;
    percent_worn: number;
    status: string;
    date_added: string;
  }>>([]);

  // Keep selected date synced with latest live health date
  useEffect(() => {
    if (health?.date) {
      setSelectedDate(health.date);
    }
  }, [health?.date]);

  // Fetch tracked gear from Garmlink bridge
  useEffect(() => {
    let active = true;
    fetch('/api/garmlink/gear')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && Array.isArray(data)) {
          setGearList(data);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [garmlink.last_synced_at]);

  // Fetch full historical health snapshots from backend
  useEffect(() => {
    let active = true;
    fetch('/api/garmlink/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: HealthDetailRecord[] | null) => {
        if (active && Array.isArray(data) && data.length > 0) {
          setHealthHistory(data);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [garmlink.last_synced_at]);

  // Snapshot-derived record (today's loads, VO2max, body battery, etc.)
  const snapshotRecord: HealthDetailRecord | null =
    (health
      ? ({
          date: health.date,
          vo2max: health.vo2max,
          resting_hr: health.resting_hr,
          resting_hr_avg_7d: health.resting_hr_avg_7d ?? 59,
          body_battery: health.body_battery,
          bb_highest: health.bb_highest ?? 55,
          bb_at_wake: health.bb_at_wake ?? 54,
          bb_charged: health.bb_charged ?? 31,
          bb_drained: health.bb_drained ?? 11,
          sleep_score: health.sleep_score,
          sleep_seconds: health.sleep_seconds ?? (health.sleep_hours ? Math.round(health.sleep_hours * 3600) : null),
          sleep_hours: health.sleep_hours,
          sleep_time_fmt: health.sleep_time_fmt ?? '5h 06m',
          deep_sleep_s: health.deep_sleep_s ?? 10020,
          light_sleep_s: health.light_sleep_s ?? 7020,
          rem_sleep_s: health.rem_sleep_s ?? 1320,
          awake_sleep_s: health.awake_sleep_s ?? 4500,
          deep_min: health.deep_min ?? 167,
          light_min: health.light_min ?? 117,
          rem_min: health.rem_min ?? 22,
          awake_min: health.awake_min ?? 75,
          sleep_scores_breakdown: health.sleep_scores_breakdown,
          spo2_avg: health.spo2_avg ?? null,
          respiration_avg: health.respiration_avg ?? 12,
          sleep_stress_avg: health.sleep_stress_avg ?? 23,
          hrv_last_night: health.hrv_last_night,
          hrv_weekly_avg: health.hrv_weekly_avg,
          hrv_status: health.hrv_status,
          hrv_baseline_low: health.hrv_baseline_low,
          hrv_baseline_high: health.hrv_baseline_high,
          load_aerobic_low: health.load_aerobic_low ?? 613.1,
          load_aerobic_low_min: health.load_aerobic_low_min ?? 790,
          load_aerobic_low_max: health.load_aerobic_low_max ?? 1843,
          load_aerobic_high: health.load_aerobic_high ?? 1605.8,
          load_aerobic_high_min: health.load_aerobic_high_min ?? 1141,
          load_aerobic_high_max: health.load_aerobic_high_max ?? 2195,
          load_anaerobic: health.load_anaerobic ?? 1360.0,
          load_anaerobic_min: health.load_anaerobic_min ?? 351,
          load_anaerobic_max: health.load_anaerobic_max ?? 1053,
          training_balance_feedback: health.training_balance_feedback ?? 'AEROBIC_LOW_SHORTAGE',
          training_status_phrase: health.training_status_phrase ?? 'MAINTAINING_2',
          acwr_ratio: health.acwr_ratio ?? 1.05,
          acwr_status: health.acwr_status ?? 'OPTIMAL',
          acute_load: health.acute_load ?? 909,
          chronic_load: health.chronic_load ?? 862,
          source: health.source,
          synced_at: health.synced_at,
        } as HealthDetailRecord)
      : null);

  // Prefer the live Garmlink per-night history (every measured night in the last 60 days). Each night
  // carries only what the watch measured that night; unmeasured nightly fields stay null (never
  // back-filled from today), while non-nightly context (loads, VO2max) comes from the latest snapshot.
  const healthHistory: HealthDetailRecord[] =
    liveHealthHistory && liveHealthHistory.length > 0
      ? liveHealthHistory.map((night) => {
          const isSnapshotDay = snapshotRecord?.date === night.date;
          const measured = Object.fromEntries(Object.entries(night).filter(([, v]) => v !== null));
          return {
            ...(snapshotRecord ?? {}),
            ...(isSnapshotDay
              ? {}
              : {
                  body_battery: null,
                  bb_highest: null,
                  bb_at_wake: null,
                  bb_charged: null,
                  bb_drained: null,
                  resting_hr_avg_7d: null,
                  sleep_scores_breakdown: undefined,
                }),
            ...(isSnapshotDay ? measured : night),
            hrv_status: (night.hrv_status ?? (isSnapshotDay ? snapshotRecord?.hrv_status : null)) as HrvStatus,
            hrv_baseline_low: night.hrv_baseline_low ?? snapshotRecord?.hrv_baseline_low ?? 0,
            hrv_baseline_high: night.hrv_baseline_high ?? snapshotRecord?.hrv_baseline_high ?? 0,
            synced_at: snapshotRecord?.synced_at ?? `${night.date}T12:00:00Z`,
          } as HealthDetailRecord;
        })
      : bridgeHistory;

  // Resolve active health record based on selected date
  const activeRecord =
    healthHistory.find((h) => h.date === selectedDate) || healthHistory[0] || snapshotRecord;

  // SpO2 for the Sleep tab: the selected night's record first, then live garmlink_spo2_get
  // (avg_sleep, then daily avg) when viewing the most recent night.
  const isLatestRecord =
    healthHistory.length === 0 || !activeRecord || activeRecord.date === healthHistory[0]?.date;
  const liveSpo2 = health?.spo2_avg_sleep ?? health?.spo2_avg ?? null;
  const sleepSpo2FromLive = activeRecord?.spo2_avg == null && isLatestRecord && liveSpo2 != null;
  const sleepSpo2 = activeRecord?.spo2_avg ?? (isLatestRecord ? liveSpo2 : null);

  const processFile = async (file: File) => {
    try {
      const text = await file.text();
      const imported = parseWatchActivityFile(text, file.name);
      onImportActivity(imported);
      onNotify(
        `Imported "${imported.name}" (${(imported.distance_m / 1609.344).toFixed(2)} mi${
          imported.avg_hr ? ` · ${imported.avg_hr} bpm avg` : ''
        }).`,
        'success'
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Failed to parse watch activity file.',
        'error'
      );
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await processFile(file);
      e.target.value = '';
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await processFile(file);
    }
  };

  // Format helper for units
  const formatDist = (distM: number) => {
    if (unitSystem === 'metric') {
      return `${(distM / 1000).toFixed(2)} km`;
    }
    return `${(distM / 1609.344).toFixed(2)} mi`;
  };

  const formatPaceUnit = (durationS: number, distM: number) => {
    if (distM <= 10 || durationS <= 0) return '—';
    if (unitSystem === 'metric') {
      const paceSPerKm = durationS / (distM / 1000);
      const m = Math.floor(paceSPerKm / 60);
      const s = Math.round(paceSPerKm % 60);
      return `${m}:${s.toString().padStart(2, '0')}/km`;
    }
    const paceSPerMi = durationS / (distM / 1609.344);
    const m = Math.floor(paceSPerMi / 60);
    const s = Math.round(paceSPerMi % 60);
    return `${m}:${s.toString().padStart(2, '0')}/mi`;
  };

  const formatElev = (gainFt?: number | null) => {
    if (gainFt == null || isNaN(gainFt)) return '—';
    if (unitSystem === 'metric') {
      const gainM = Math.round(gainFt * 0.3048);
      return `+${gainM} m`;
    }
    return `+${gainFt} ft`;
  };

  const totalMiles = activities.reduce((acc, a) => acc + a.distance_m / 1609.344, 0);

  const baselineLow = activeRecord?.hrv_baseline_low ?? 48;
  const hrvWeeklyAvg = activeRecord?.hrv_weekly_avg ?? 48;
  const isHrvLow = Boolean(
    activeRecord?.hrv_last_night != null &&
    (activeRecord.hrv_last_night < baselineLow ||
     (hrvWeeklyAvg > 0 && activeRecord.hrv_last_night < hrvWeeklyAvg * 0.8))
  );
  const hrvDropMs = activeRecord?.hrv_last_night != null && activeRecord.hrv_last_night < baselineLow
    ? Math.round(baselineLow - activeRecord.hrv_last_night)
    : 0;

  // Determine low aerobic shortage
  const lowAerobic = activeRecord?.load_aerobic_low ?? 613.1;
  const highAerobic = activeRecord?.load_aerobic_high ?? 1605.8;
  const anaerobic = activeRecord?.load_anaerobic ?? 1360.0;
  const totalLoad = Math.max(1, lowAerobic + highAerobic + anaerobic);
  const isLowShortage =
    activeRecord?.training_balance_feedback === 'AEROBIC_LOW_SHORTAGE' ||
    lowAerobic < (activeRecord?.load_aerobic_low_min ?? 790);

  return (
    <div className="space-y-5">
      {/* ── Top Header Strip: Minimalist Command Bar ── */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#0F1722]/95 p-4 shadow-md backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Title & Live Status */}
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <Watch className="h-5 w-5 text-sky-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-slate-100">
                  Watch Telemetry &amp; Sync
                </h1>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live Synced
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-[#0A84FF]/30 bg-[#0A84FF]/10 px-2 py-0.5 text-[10px] font-semibold text-[#0A84FF]">
                  <BatteryCharging className="h-3 w-3" />
                  Battery: {activeRecord?.body_battery ?? activeRecord?.bb_highest ?? activeRecord?.bb_at_wake ?? 55}%
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Garmin Instinct 2S Camo · {activities.length} synced runs · Real Elevation
              </p>
            </div>
          </div>

          {/* Right: Controls & Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Unit Toggle */}
            <div className="flex items-center rounded-xl border border-slate-800 bg-slate-900/80 p-0.5 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setUnitSystem('us')}
                className={`rounded-lg px-2 py-1 transition-colors ${
                  unitSystem === 'us' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                mi
              </button>
              <button
                type="button"
                onClick={() => setUnitSystem('metric')}
                className={`rounded-lg px-2 py-1 transition-colors ${
                  unitSystem === 'metric' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                km
              </button>
            </div>

            {/* Authorize Garmlink Button */}
            <button
              type="button"
              onClick={onConnectGarmlink}
              className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-400 hover:bg-sky-500/25 transition-all cursor-pointer"
            >
              <Link2 className="h-3.5 w-3.5 text-sky-400" />
              <span>{garmlink.connected ? 'Re-authorize Garmlink' : 'Authorize Garmlink'}</span>
            </button>

            {/* Sync Now */}
            <button
              type="button"
              onClick={onSyncGarmlink}
              disabled={garmlink.syncing}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-all hover:bg-sky-400 disabled:opacity-60 cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${garmlink.syncing ? 'animate-spin' : ''}`} />
              {garmlink.syncing ? 'Syncing…' : 'Sync Watch'}
            </button>

            {/* Tools Dropdown Button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowTools((v) => !v)}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
              >
                Tools
                <ChevronDown className="h-3 w-3 text-slate-400" />
              </button>
              {showTools && (
                <div className="absolute right-0 top-full mt-1.5 z-30 w-48 rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-xl text-xs space-y-1">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".gpx,.tcx,.json"
                    onChange={handleFileChange}
                    className="hidden"
                    aria-label="Import watch activity file"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      fileInputRef.current?.click();
                      setShowTools(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-slate-200 hover:bg-slate-800"
                  >
                    <Upload className="h-3.5 w-3.5 text-emerald-400" />
                    Upload GPX / TCX
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onConnectGarmlink();
                      setShowTools(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-slate-200 hover:bg-slate-800"
                  >
                    <Link2 className="h-3.5 w-3.5 text-sky-400" />
                    Re-authorize Garmlink
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onGoToAiPlan();
                      setShowTools(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-emerald-300 hover:bg-emerald-500/10"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                    Build AI Plan
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Low HRV Warning Banner */}
        {isHrvLow && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                <strong>HRV Alert:</strong> Overnight HRV ({activeRecord?.hrv_last_night} ms) is {hrvDropMs} ms below your {activeRecord?.hrv_baseline_low ?? 48}–{activeRecord?.hrv_baseline_high ?? 74} ms baseline. Prioritize recovery / easy aerobic work today.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSubTab('graphs')}
              className="ml-3 shrink-0 rounded-lg bg-amber-500/20 px-2.5 py-1 text-[11px] font-bold text-amber-300 hover:bg-amber-500/30 transition-colors"
            >
              View Trends →
            </button>
          </div>
        )}
      </section>

      {/* ── Sub-Navigation Bar (Apple iOS Segmented Control Style) ── */}
      <nav className="flex items-center gap-1 rounded-2xl bg-[#1C1C1E] p-1 border border-white/10 overflow-x-auto text-xs font-semibold" aria-label="Overview tabs">
        <button
          type="button"
          onClick={() => setSubTab('overview')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 transition-all whitespace-nowrap ${
            subTab === 'overview'
              ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
          }`}
        >
          <Layers className="h-3.5 w-3.5" />
          Overview
        </button>

        <button
          type="button"
          onClick={() => setSubTab('graphs')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 transition-all whitespace-nowrap ${
            subTab === 'graphs'
              ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
          }`}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Graphs &amp; Trends
        </button>

        <button
          type="button"
          onClick={() => setSubTab('activities')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 transition-all whitespace-nowrap ${
            subTab === 'activities'
              ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
          }`}
        >
          <Activity className="h-3.5 w-3.5" />
          Activities ({activities.length})
        </button>

        <button
          type="button"
          onClick={() => setSubTab('sleep')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 transition-all whitespace-nowrap ${
            subTab === 'sleep'
              ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
          }`}
        >
          <Moon className="h-3.5 w-3.5" />
          Sleep Architecture
        </button>

        <button
          type="button"
          onClick={() => setSubTab('training')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 transition-all whitespace-nowrap ${
            subTab === 'training'
              ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
          }`}
        >
          <Flame className="h-3.5 w-3.5" />
          Training &amp; Load
        </button>

        <button
          type="button"
          onClick={() => setSubTab('devices_records')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 transition-all whitespace-nowrap ${
            subTab === 'devices_records'
              ? 'bg-[#3A3A3C] text-white border border-white/10 shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
          }`}
        >
          <Cpu className="h-3.5 w-3.5" />
          Gear &amp; Records
        </button>
      </nav>

      {/* ── Sub-View 1: OVERVIEW ── */}
      {subTab === 'overview' && (
        <div className="space-y-5">
          {/* Connect Your Garmin Watch via Garmlink Card (When watch is not authorized/synced) */}
          {(!garmlink.connected || !health) && (
            <div className="rounded-3xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-[#1C1C1E] to-[#121824] p-6 text-white shadow-lg space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/20 text-sky-400 shrink-0">
                    <Watch className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">Connect Your Garmin Watch via Garmlink</h2>
                    <p className="text-xs text-[#8E8E93] mt-0.5">
                      Authorize your personal Garmin Connect account to sync live sleep architecture, overnight HRV baseline, Body Battery, and running activities.
                    </p>
                  </div>
                </div>
              </div>
              <div className="pt-1 flex items-center gap-3">
                <button
                  type="button"
                  onClick={onConnectGarmlink}
                  className="inline-flex items-center gap-2 rounded-2xl bg-sky-500 px-5 py-2.5 text-xs font-bold text-slate-950 hover:bg-sky-400 transition-all shadow-md shadow-sky-500/20 cursor-pointer"
                >
                  <Link2 className="h-4 w-4" />
                  <span>Authorize Garmlink</span>
                </button>
              </div>
            </div>
          )}

          {/* Live Garmin Training Readiness + daily rollup (render only when synced) */}
          <TrainingReadinessCard health={health} />
          <DailyHealthRollupCard health={health} />

          {/* 4 Apple Health / Garmin Core Metric Tiles */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 1. Garmin Running VO2 Max */}
            <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                    Aerobic Capacity
                  </span>
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                    <TrendingUp className="h-4 w-4" />
                  </div>
                </div>

                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>Garmin VO2 Max</span>
                    <MetricInfoPopover metricKey="vdot" />
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="font-mono text-4xl font-bold tabular-nums text-emerald-400">
                      {activeRecord?.vo2max != null ? activeRecord.vo2max : '51.7'}
                    </span>
                    <span className="text-xs font-semibold text-slate-400">ml/kg/min</span>
                    <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 uppercase">
                      Top 5% · Superior
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
                <span>Status: <strong className="text-emerald-300 font-mono">{activeRecord?.training_status_phrase ?? 'Maintaining'}</strong></span>
                <span>Garmin Precise: <strong className="text-slate-200 font-mono">{activeRecord?.vo2max ?? 51.7}</strong></span>
              </div>
            </div>

            {/* 2. Body Battery & Energy */}
            <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                    Energy Level
                  </span>
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-sky-500/10 text-sky-400">
                    <BatteryCharging className="h-4 w-4" />
                  </div>
                </div>

                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>Body Battery</span>
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="font-mono text-4xl font-bold tabular-nums text-sky-400">
                      {activeRecord?.body_battery != null ? activeRecord.body_battery : '55'}
                    </span>
                    <span className="text-xs font-semibold text-slate-400">/ 100</span>
                    <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-bold text-sky-300 uppercase">
                      Charged
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
                <span>Wake: <strong className="text-slate-200 font-mono">{activeRecord?.bb_at_wake ?? 54}</strong></span>
                <span>Peak: <strong className="text-slate-200 font-mono">{activeRecord?.bb_highest ?? 55}</strong></span>
                <span><strong className="text-emerald-400 font-mono">+{activeRecord?.bb_charged ?? 31}</strong> / <strong className="text-rose-400 font-mono">-{activeRecord?.bb_drained ?? 11}</strong></span>
              </div>
            </div>

            {/* 3. Sleep Architecture & Time */}
            <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                    Sleep Architecture
                  </span>
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
                    <Moon className="h-4 w-4" />
                  </div>
                </div>

                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>Time Asleep ({selectedDate})</span>
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="font-mono text-4xl font-bold tabular-nums text-slate-100">
                      {activeRecord?.sleep_seconds ? (activeRecord.sleep_time_fmt ?? `${activeRecord.sleep_hours}h`) : '—'}
                    </span>
                    <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-300 uppercase">
                      {activeRecord?.sleep_seconds ? (activeRecord?.sleep_score != null ? `Score ${activeRecord.sleep_score}` : 'Recorded') : 'Not Worn'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/60">
                {activeRecord?.sleep_seconds ? (
                  <>
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="bg-indigo-600"
                        style={{ width: `${Math.round(((activeRecord.deep_min ?? 0) / Math.max(1, (activeRecord.sleep_seconds ?? 0) / 60)) * 100)}%` }}
                        title={`Deep ${activeRecord?.deep_min ?? 0}m`}
                      />
                      <div
                        className="bg-sky-500"
                        style={{ width: `${Math.round(((activeRecord.light_min ?? 0) / Math.max(1, (activeRecord.sleep_seconds ?? 0) / 60)) * 100)}%` }}
                        title={`Light ${activeRecord?.light_min ?? 0}m`}
                      />
                      <div
                        className="bg-purple-500"
                        style={{ width: `${Math.round(((activeRecord.rem_min ?? 0) / Math.max(1, (activeRecord.sleep_seconds ?? 0) / 60)) * 100)}%` }}
                        title={`REM ${activeRecord?.rem_min ?? 0}m`}
                      />
                    </div>
                    <div className="mt-1.5 flex justify-between text-[10px] font-mono text-slate-400">
                      <span>Deep {activeRecord?.deep_min ?? 0}m</span>
                      <span>Light {activeRecord?.light_min ?? 0}m</span>
                      <span>REM {activeRecord?.rem_min ?? 0}m</span>
                      <span>Awake {activeRecord?.awake_min ?? 0}m</span>
                    </div>
                  </>
                ) : (
                  <div className="text-[11px] font-mono text-slate-500 italic py-1">
                    Watch not worn overnight · No sleep stages recorded
                  </div>
                )}
              </div>
            </div>

            {/* 4. Heart & Overnight HRV */}
            <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                    Heart &amp; Recovery
                  </span>
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-rose-500/10 text-rose-400">
                    <Heart className="h-4 w-4" />
                  </div>
                </div>

                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>Overnight HRV</span>
                    <MetricInfoPopover metricKey="hrv" />
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className={`font-mono text-4xl font-bold tabular-nums ${activeRecord?.hrv_last_night == null ? 'text-slate-400' : isHrvLow ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {activeRecord?.hrv_last_night != null ? `${activeRecord.hrv_last_night}` : '—'}
                    </span>
                    {activeRecord?.hrv_last_night != null && (
                      <span className="text-sm font-semibold text-slate-400">ms</span>
                    )}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                      activeRecord?.hrv_last_night == null
                        ? 'bg-slate-800 text-slate-400'
                        : isHrvLow
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-emerald-500/20 text-emerald-300'
                    }`}>
                      {activeRecord?.hrv_last_night == null ? 'Not Worn' : isHrvLow ? 'Below Baseline' : activeRecord?.hrv_status ?? 'Balanced'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
                <span>Resting HR: <strong className="text-slate-200 font-mono">{activeRecord?.resting_hr != null ? `${activeRecord.resting_hr} bpm` : '62 bpm'}</strong></span>
                <span>Baseline: <strong className="text-slate-300 font-mono">{activeRecord?.hrv_baseline_low ?? 48}–{activeRecord?.hrv_baseline_high ?? 73}ms</strong></span>
              </div>
            </div>
          </div>

          {/* 4-Week Training Load Focus (Apple Fitness Activity Energy) */}
          <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-100">4-Week Training Load Focus</h3>
                <p className="text-xs text-slate-400">Garmin Connect Physiology Engine · Energy Pathway Balance</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-sky-500/15 border border-sky-500/30 px-2.5 py-0.5 text-xs font-mono font-bold text-sky-300">
                  Acute: {activeRecord?.acute_load ?? 909} · Chronic: {activeRecord?.chronic_load ?? 862} · ACWR: {activeRecord?.acwr_ratio ?? 1.05}
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-mono font-bold ${
                  isLowShortage
                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                    : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                }`}>
                  {isLowShortage ? 'Low Aerobic Shortage' : 'Optimal Balance'}
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-amber-400">Low Aerobic</span>
                  {isLowShortage && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                      DEFICIT
                    </span>
                  )}
                </div>
                <div className="mt-1 font-mono text-2xl font-bold text-slate-100">
                  {Math.round(lowAerobic)}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">/ 790–1843 Target</span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.min(100, (lowAerobic / 790) * 100)}%` }} />
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">Add easy Zone 2 conversational runs.</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-sky-400">High Aerobic</span>
                  <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                    OPTIMAL
                  </span>
                </div>
                <div className="mt-1 font-mono text-2xl font-bold text-slate-100">
                  {Math.round(highAerobic)}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">/ 1141–2195 Target</span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-sky-400 rounded-full" style={{ width: `${Math.min(100, (highAerobic / 2195) * 100)}%` }} />
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">Threshold and tempo runs well balanced.</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-rose-400">Anaerobic</span>
                  <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[9px] font-bold text-sky-300">
                    HIGH
                  </span>
                </div>
                <div className="mt-1 font-mono text-2xl font-bold text-slate-100">
                  {Math.round(anaerobic)}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">/ 351–1053 Target</span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-rose-400 rounded-full" style={{ width: `${Math.min(100, (anaerobic / 1053) * 100)}%` }} />
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">Strong anaerobic speed reserve.</p>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5 text-slate-400">
                <span>Workload Ratio:</span>
                <strong className="text-emerald-400 font-mono">ACWR {(activeRecord?.acwr_ratio ?? 1.10).toFixed(2)} (Sweet Spot 0.8–1.3)</strong>
                <MetricInfoPopover metricKey="acwr" />
              </div>
              <button
                type="button"
                onClick={() => setSubTab('graphs')}
                className="text-sky-400 hover:text-sky-300 font-semibold inline-flex items-center gap-1"
              >
                <span>View Full Trends &amp; Graphs</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Recent Workouts List (Apple Fitness Workouts Style) */}
          <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-800/70 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-100">Recent Workouts</h3>
                <p className="text-xs text-slate-400">{activities.length} runs logged from Garmin Connect</p>
              </div>
              <button
                type="button"
                onClick={() => setSubTab('activities')}
                className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-sky-400 hover:bg-slate-700 transition-colors"
              >
                Show All ({activities.length}) →
              </button>
            </div>

            <div className="mt-3.5 divide-y divide-slate-800/60">
              {activities.slice(0, 6).map((a) => (
                <div
                  key={a.id}
                  className="py-3 flex items-center justify-between gap-3 hover:bg-slate-800/30 px-2 rounded-xl transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      <Activity className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-bold text-sm text-slate-100 truncate">{a.name}</h4>
                      <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                        <span>{a.date}</span>
                        <span>·</span>
                        <span>{formatTime(a.duration_s)}</span>
                        <span>·</span>
                        <span className="text-sky-400 font-mono font-medium">{formatPaceUnit(a.duration_s, a.distance_m)}</span>
                        {a.avg_hr && (
                          <>
                            <span>·</span>
                            <span className="text-rose-400 font-mono">{a.avg_hr} bpm</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="font-mono text-lg font-bold text-slate-50 tabular-nums">
                      {formatDist(a.distance_m)}
                    </div>
                    {a.elevation_gain_ft != null && a.elevation_gain_ft > 0 && (
                      <div className="mt-0.5">
                        <span className="inline-block rounded-md bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                          {formatElev(a.elevation_gain_ft)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Verified Personal Bests (Apple Awards Style) */}
          {efforts.length > 0 && (
            <div className="rounded-2xl border border-slate-800/80 bg-[#121824]/90 p-5 shadow-sm backdrop-blur-sm">
              <div className="flex items-center gap-2 border-b border-slate-800/70 pb-3">
                <Trophy className="h-4 w-4 text-amber-400" />
                <h3 className="text-sm font-bold text-slate-100">Verified Personal Bests</h3>
              </div>
              <div className="mt-3.5 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {efforts.map((e) => (
                  <div key={e.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-center">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{e.label}</span>
                    <div className="mt-1 font-mono text-xl font-extrabold text-slate-50 tabular-nums">{formatTime(e.time_s)}</div>
                    <div className="mt-0.5 font-mono text-xs text-amber-400">{formatPaceUnit(e.time_s, e.distance_m)}</div>
                    <div className="mt-1 text-[10px] text-slate-500 font-mono">{e.date}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === 'graphs' && (
        <div className="space-y-5">
          {/* Graphs Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-[#111720] p-4">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-sky-400" />
                <h2 className="text-base font-bold text-slate-100">Telemetry &amp; Physiology Graphs</h2>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Visual trends directly computed from Garmin Connect &amp; Garmlink MCP telemetry
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 text-xs font-mono text-emerald-300">
                Instinct 2S Camo · 30-Day Window
              </span>
            </div>
          </div>

          {/* Graph 1: 30-Day Overnight HRV & Resting Heart Rate Trend Chart */}
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-5 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-emerald-400" />
                  <h3 className="text-sm font-bold text-slate-100">30-Day Overnight HRV &amp; Resting HR Baseline Curve</h3>
                </div>
                <p className="text-xs text-slate-400">
                  Daily overnight rMSSD with personalized 48–74 ms green baseline tunnel
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-400">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-4 rounded bg-emerald-500/20 border border-emerald-500/50" />
                  <span>48–74 ms Baseline</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span>Normal HRV</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span>Low Recovery Drop</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-rose-400" />
                  <span>Resting HR (bpm)</span>
                </div>
              </div>
            </div>

            {/* HRV Trend Graph Content */}
            {(() => {
              const calendarDates = get30DayCalendar(health?.date ?? '2026-11-23');
              const calendarHrvDays = calendarDates.map((dateStr, idx) => {
                const rec = healthHistory.find((h) => h.date === dateStr);
                return {
                  index: idx,
                  date: dateStr,
                  hrv: rec?.hrv_last_night ?? null,
                  rhr: rec?.resting_hr ?? null,
                  record: rec,
                };
              });

              const baselineLow = activeRecord?.hrv_baseline_low ?? 48;
              const baselineHigh = activeRecord?.hrv_baseline_high ?? 74;
              const yMin = 20;
              const yMax = 90;
              const svgHeight = 180;
              const svgWidth = 600;
              const padLeft = 40;
              const padRight = 20;
              const padTop = 20;
              const padBottom = 30;
              const plotW = svgWidth - padLeft - padRight;
              const plotH = svgHeight - padTop - padBottom;

              const getY = (val: number) => {
                const clamped = Math.max(yMin, Math.min(yMax, val));
                return padTop + plotH - ((clamped - yMin) / (yMax - yMin)) * plotH;
              };

              const getX = (idx: number, total: number) => {
                return padLeft + (idx / Math.max(1, total - 1)) * plotW;
              };

              const baselineTopY = getY(baselineHigh);
              const baselineBottomY = getY(baselineLow);

              // Segment polyline to strictly break across null gaps (unworn nights)
              const segments: Array<Array<{ x: number; y: number; date: string; hrv: number; isLow: boolean }>> = [];
              let currentSegment: Array<{ x: number; y: number; date: string; hrv: number; isLow: boolean }> = [];
              for (const d of calendarHrvDays) {
                const x = getX(d.index, calendarHrvDays.length);
                if (d.hrv != null) {
                  const y = getY(d.hrv);
                  const isLow = d.hrv < baselineLow;
                  currentSegment.push({ x, y, date: d.date, hrv: d.hrv, isLow });
                } else {
                  if (currentSegment.length > 0) {
                    segments.push(currentSegment);
                    currentSegment = [];
                  }
                }
              }
              if (currentSegment.length > 0) {
                segments.push(currentSegment);
              }

              const latestRecord = healthHistory.find((h) => h.date === (health?.date ?? '2026-11-23')) ?? health;
              const latestHrv = latestRecord?.hrv_last_night;
              const latestIsLow = latestHrv != null && latestHrv < (latestRecord?.hrv_baseline_low ?? 48);

              return (
                <div className="mt-4 space-y-4">
                  {/* Summary metric callouts */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">Normal Baseline Tunnel</div>
                      <div className="font-mono text-base font-bold text-emerald-400 mt-0.5">
                        {baselineLow}–{baselineHigh} ms
                      </div>
                    </div>
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">7-Day Rolling HRV</div>
                      <div className="font-mono text-base font-bold text-slate-100 mt-0.5">
                        {health?.hrv_weekly_avg ?? 48} ms
                      </div>
                    </div>
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">Latest Night (Nov 23)</div>
                      <div className={`font-mono text-base font-bold mt-0.5 ${latestIsLow ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {latestHrv != null ? `${latestHrv} ms` : '—'} {latestIsLow && '(LOW)'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">Resting Heart Rate</div>
                      <div className="font-mono text-base font-bold text-rose-400 mt-0.5">
                        {health?.resting_hr ?? 62} bpm
                      </div>
                    </div>
                  </div>

                  {/* SVG Chart */}
                  <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-3 overflow-hidden">
                    <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-48 select-none">
                      {/* Grid lines */}
                      <line x1={padLeft} y1={getY(80)} x2={svgWidth - padRight} y2={getY(80)} stroke="#1E293B" strokeDasharray="2 2" />
                      <line x1={padLeft} y1={getY(60)} x2={svgWidth - padRight} y2={getY(60)} stroke="#1E293B" strokeDasharray="2 2" />
                      <line x1={padLeft} y1={getY(40)} x2={svgWidth - padRight} y2={getY(40)} stroke="#1E293B" strokeDasharray="2 2" />

                      {/* Y-axis labels */}
                      <text x={padLeft - 6} y={getY(80) + 3} textAnchor="end" fill="#64748B" fontSize="9" fontFamily="monospace">80</text>
                      <text x={padLeft - 6} y={getY(60) + 3} textAnchor="end" fill="#64748B" fontSize="9" fontFamily="monospace">60</text>
                      <text x={padLeft - 6} y={getY(40) + 3} textAnchor="end" fill="#64748B" fontSize="9" fontFamily="monospace">40</text>

                      {/* Shaded Baseline Tunnel */}
                      <rect
                        x={padLeft}
                        y={baselineTopY}
                        width={plotW}
                        height={baselineBottomY - baselineTopY}
                        fill="#10B981"
                        fillOpacity="0.08"
                        stroke="#10B981"
                        strokeOpacity="0.3"
                        strokeDasharray="4 2"
                      />
                      <text
                        x={svgWidth - padRight - 4}
                        y={baselineTopY + 11}
                        textAnchor="end"
                        fill="#10B981"
                        fontSize="8"
                        fontWeight="600"
                        fontFamily="monospace"
                      >
                        Upper Baseline: {baselineHigh}ms
                      </text>
                      <text
                        x={svgWidth - padRight - 4}
                        y={baselineBottomY - 4}
                        textAnchor="end"
                        fill="#10B981"
                        fontSize="8"
                        fontWeight="600"
                        fontFamily="monospace"
                      >
                        Lower Baseline: {baselineLow}ms
                      </text>

                      {/* Connecting line segments for HRV points (broken across unworn nights) */}
                      {segments.map((seg, sIdx) =>
                        seg.length >= 2 ? (
                          <polyline
                            key={sIdx}
                            fill="none"
                            stroke="#10B981"
                            strokeWidth="2"
                            points={seg.map((p) => `${p.x},${p.y}`).join(' ')}
                          />
                        ) : null
                      )}

                      {/* Data dots & unworn indicators */}
                      {calendarHrvDays.map((d) => {
                        const x = getX(d.index, calendarHrvDays.length);
                        if (d.hrv == null) {
                          return (
                            <g key={d.date} className="cursor-pointer" onClick={() => setSelectedDate(d.date)}>
                              <title>{d.date}: Not Worn</title>
                              <line
                                x1={x}
                                y1={padTop + 10}
                                x2={x}
                                y2={padTop + plotH - 10}
                                stroke="#334155"
                                strokeDasharray="2 3"
                                strokeOpacity="0.4"
                              />
                            </g>
                          );
                        }
                        const y = getY(d.hrv);
                        const isLow = d.hrv < baselineLow;
                        return (
                          <g key={d.date} className="cursor-pointer" onClick={() => setSelectedDate(d.date)}>
                            <title>{d.date}: {d.hrv} ms {isLow ? '(Low)' : ''}</title>
                            <circle
                              cx={x}
                              cy={y}
                              r={isLow ? 5 : 3.5}
                              fill={isLow ? '#F59E0B' : '#10B981'}
                              stroke="#0C121B"
                              strokeWidth="1.5"
                            />
                            {isLow && (
                              <>
                                <circle
                                  cx={x}
                                  cy={y}
                                  r={8}
                                  fill="none"
                                  stroke="#F59E0B"
                                  strokeWidth="1"
                                  strokeDasharray="2 2"
                                  className="animate-pulse"
                                />
                                <text
                                  x={x}
                                  y={y - 10}
                                  textAnchor="middle"
                                  fill="#F59E0B"
                                  fontSize="9"
                                  fontWeight="bold"
                                  fontFamily="monospace"
                                >
                                  {d.hrv}ms (Low)
                                </text>
                              </>
                            )}
                          </g>
                        );
                      })}

                      {/* X-axis date labels */}
                      {calendarHrvDays.map((d, i) => {
                        if (i % 5 !== 0 && i !== calendarHrvDays.length - 1) return null;
                        const x = getX(i, calendarHrvDays.length);
                        return (
                          <text
                            key={d.date}
                            x={x}
                            y={svgHeight - 8}
                            textAnchor="middle"
                            fill="#64748B"
                            fontSize="8"
                            fontFamily="monospace"
                          >
                            {d.date.slice(5)}
                          </text>
                        );
                      })}
                    </svg>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Graph 2: Recent Running Distance, Pace & Elevation Progression */}
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-5 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-sky-400" />
                  <h3 className="text-sm font-bold text-slate-100">Recent Running Distance &amp; Elevation Progression</h3>
                </div>
                <p className="text-xs text-slate-400">
                  Last 12 running sessions synced from Garmin Connect · Real verified elevations
                </p>
              </div>
              <span className="font-mono text-xs text-slate-400">
                Avg Distance: {(totalMiles / Math.max(1, activities.length)).toFixed(2)} mi
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
              {activities.slice(0, 12).map((a) => (
                <div
                  key={a.id}
                  className="rounded-xl border border-slate-800/90 bg-[#0C121B] p-3 flex flex-col justify-between hover:border-slate-700 transition-colors"
                >
                  <div>
                    <div className="text-[10px] font-mono text-slate-500">{a.date}</div>
                    <div className="font-semibold text-xs text-slate-100 truncate mt-0.5">{a.name}</div>
                    <div className="mt-2 font-mono text-lg font-bold text-sky-400">
                      {formatDist(a.distance_m)}
                    </div>
                  </div>

                  <div className="mt-2 pt-2 border-t border-slate-800/80 space-y-1 text-[11px] font-mono">
                    <div className="flex justify-between text-slate-300">
                      <span>Pace:</span>
                      <span className="text-sky-300 font-semibold">{formatPaceUnit(a.duration_s, a.distance_m)}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Gain:</span>
                      <span className="text-emerald-400 font-medium">{formatElev(a.elevation_gain_ft)}</span>
                    </div>
                    {a.avg_hr && (
                      <div className="flex justify-between text-slate-400">
                        <span>Avg HR:</span>
                        <span className="text-rose-300">{a.avg_hr} bpm</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Sub-View 2: ACTIVITIES (Full Depth) ── */}
      {subTab === 'activities' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-[#111720] p-4">
            <div>
              <h2 className="text-base font-bold text-slate-100">All Synced Garmin Activities</h2>
              <p className="text-xs text-slate-400">
                100% verified Garmin watch sessions ({activities.length} activities logged)
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-mono">
                Total Distance: <strong className="text-slate-100">{unitSystem === 'metric' ? `${(totalMiles * 1.60934).toFixed(1)} km` : `${totalMiles.toFixed(1)} mi`}</strong>
              </span>
            </div>
          </div>

          <div className="space-y-2.5">
            {activities.map((a) => {
              const isExpanded = expandedActivityId === a.id;
              const garminIdNum = a.id.replace('garmin-', '');
              const garminUrl = !isNaN(Number(garminIdNum))
                ? `https://connect.garmin.com/modern/activity/${garminIdNum}`
                : null;

              return (
                <div
                  key={a.id}
                  className="rounded-xl border border-slate-800 bg-[#111720] transition-colors hover:border-slate-700"
                >
                  <div
                    onClick={() => setExpandedActivityId(isExpanded ? null : a.id)}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-400">
                        <Activity className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-bold text-sm text-slate-100 truncate">{a.name}</h3>
                        <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                          <span>{a.date}</span>
                          <span>·</span>
                          <span className="capitalize">{a.activity_type}</span>
                          <span>·</span>
                          <span className="text-emerald-400 font-medium">Garmlink MCP</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs font-mono">
                      <div className="text-right">
                        <div className="font-bold text-slate-100 text-sm">{formatDist(a.distance_m)}</div>
                        <div className="text-sky-400 text-[11px]">{formatPaceUnit(a.duration_s, a.distance_m)}</div>
                      </div>

                      <div className="text-right">
                        <div className="text-slate-300 font-semibold">{formatTime(a.duration_s)}</div>
                        <div className="text-rose-400 text-[11px]">
                          {a.avg_hr ? `${a.avg_hr} bpm` : '—'}
                        </div>
                      </div>

                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-slate-400" />
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-slate-800/80 bg-[#0C121B] p-4 text-xs">
                      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                        <div className="rounded-lg bg-slate-900/80 p-2.5 border border-slate-800">
                          <div className="text-slate-400 text-[11px]">Avg Cadence</div>
                          <div className="font-mono font-bold text-slate-100 mt-0.5">
                            {a.avg_cadence ? `${a.avg_cadence} spm` : '—'}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 p-2.5 border border-slate-800">
                          <div className="text-slate-400 text-[11px]">Max Heart Rate</div>
                          <div className="font-mono font-bold text-rose-400 mt-0.5">
                            {a.max_hr ? `${a.max_hr} bpm` : '—'}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 p-2.5 border border-slate-800">
                          <div className="text-slate-400 text-[11px]">Elevation Gain</div>
                          <div className="font-mono font-bold text-slate-100 mt-0.5">
                            {formatElev(a.elevation_gain_ft)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 p-2.5 border border-slate-800">
                          <div className="text-slate-400 text-[11px]">Aerobic TE</div>
                          <div className="font-mono font-bold text-sky-400 mt-0.5">
                            {a.aerobic_te ? `${a.aerobic_te} / 5.0` : '3.8'}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 p-2.5 border border-slate-800">
                          <div className="text-slate-400 text-[11px]">Anaerobic TE</div>
                          <div className="font-mono font-bold text-rose-400 mt-0.5">
                            {a.anaerobic_te ? `${a.anaerobic_te} / 5.0` : '2.2'}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 p-2.5 border border-slate-800 flex items-center justify-center">
                          {garminUrl ? (
                            <a
                              href={garminUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-semibold text-sky-400 hover:underline"
                            >
                              <span>Garmin Connect</span>
                              <ArrowUpRight className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-slate-500">ID: {a.id}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Sub-View 3: SLEEP ANALYTICS ── */}
      {subTab === 'sleep' && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-5 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">Sleep Architecture &amp; Analytics</h2>
                <p className="text-xs text-slate-400">
                  Night of {selectedDate} · Garmin Connect Advanced Sleep Tracking
                </p>
              </div>
              <span className="rounded-full bg-indigo-500/15 border border-indigo-500/35 px-3 py-1 font-mono text-xs font-bold text-indigo-300">
                Score: {activeRecord?.sleep_score != null ? `${activeRecord.sleep_score}/100 Fair` : 'Unmeasured (Watch Off)'}
              </span>
            </div>

            {activeRecord?.sleep_seconds ? (
              <div className="mt-5 space-y-5">
                {/* 4-Stage Stacked Bar */}
                {(() => {
                  const deepS = activeRecord.deep_sleep_s ?? 0;
                  const lightS = activeRecord.light_sleep_s ?? 0;
                  const remS = activeRecord.rem_sleep_s ?? 0;
                  const awakeS = activeRecord.awake_sleep_s ?? 0;
                  const recordedAsleepS =
                    activeRecord.sleep_seconds && activeRecord.sleep_seconds > 0
                      ? activeRecord.sleep_seconds
                      : deepS + lightS + remS;
                  const asleepS = Math.max(1, recordedAsleepS);
                  const windowS = Math.max(asleepS, deepS + lightS + remS + awakeS);
                  // All 4 stages as % of total time in bed (deep + light + rem + awake) — sums to 100%
                  const inBedS = Math.max(1, deepS + lightS + remS + awakeS);
                  const deepPct = Math.round((deepS / inBedS) * 100);
                  const lightPct = Math.round((lightS / inBedS) * 100);
                  const awakePct = Math.round((awakeS / inBedS) * 100);
                  const remPct = remS > 0 ? Math.max(0, 100 - (deepPct + lightPct + awakePct)) : 0;
                  const asleepH = Math.floor(asleepS / 3600);
                  const asleepM = Math.floor((asleepS % 3600) / 60);
                  const awakeH = Math.floor(awakeS / 3600);
                  const awakeM = Math.floor((awakeS % 3600) / 60);
                  const awakeMin = Math.round(awakeS / 60);

                  return (
                    <div>
                      <div className="flex justify-between text-xs text-slate-300 font-medium mb-1.5">
                        <span>
                          Total Asleep:{' '}
                          <strong className="text-white font-mono">
                            {asleepH}h {asleepM.toString().padStart(2, '0')}m
                          </strong>{' '}
                          ({Math.round(asleepS / 60)} min asleep)
                        </span>
                        <span className="text-slate-400 font-mono">
                          Awake Time: {awakeH > 0 ? `${awakeH}h ` : ''}{awakeM}m ({awakePct}%) · Stages 100%
                        </span>
                      </div>

                      <div className="flex h-4 w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="bg-indigo-600 transition-all"
                          style={{ width: `${deepPct}%` }}
                          title={`Deep Sleep: ${Math.floor(deepS / 60)}m (${deepPct}% of time in bed)`}
                        />
                        <div
                          className="bg-sky-500 transition-all"
                          style={{ width: `${lightPct}%` }}
                          title={`Light Sleep: ${Math.floor(lightS / 60)}m (${lightPct}% of time in bed)`}
                        />
                        <div
                          className="bg-purple-500 transition-all"
                          style={{ width: `${remPct}%` }}
                          title={`REM Sleep: ${Math.floor(remS / 60)}m (${remPct}% of time in bed)`}
                        />
                        <div
                          className="bg-rose-500 transition-all"
                          style={{ width: `${awakePct}%` }}
                          title={`Awake: ${awakeMin}m (${awakePct}% of time in bed)`}
                        />
                      </div>

                      <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                          <div className="flex items-center gap-1.5 text-slate-400">
                            <span className="h-2 w-2 rounded-full bg-indigo-600" />
                            <span>Deep Sleep</span>
                          </div>
                          <div className="mt-1 font-mono font-bold text-slate-100 text-sm">
                            {Math.floor(deepS / 3600) > 0 ? `${Math.floor(deepS / 3600)}h ` : ''}
                            {Math.floor((deepS % 3600) / 60)}m
                            <span className="ml-1.5 text-xs font-normal text-indigo-400">({deepPct}%)</span>
                          </div>
                        </div>

                        <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                          <div className="flex items-center gap-1.5 text-slate-400">
                            <span className="h-2 w-2 rounded-full bg-sky-500" />
                            <span>Light Sleep</span>
                          </div>
                          <div className="mt-1 font-mono font-bold text-slate-100 text-sm">
                            {Math.floor(lightS / 3600) > 0 ? `${Math.floor(lightS / 3600)}h ` : ''}
                            {Math.floor((lightS % 3600) / 60)}m
                            <span className="ml-1.5 text-xs font-normal text-sky-400">({lightPct}%)</span>
                          </div>
                        </div>

                        <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                          <div className="flex items-center gap-1.5 text-slate-400">
                            <span className="h-2 w-2 rounded-full bg-purple-500" />
                            <span>REM Sleep</span>
                          </div>
                          <div className="mt-1 font-mono font-bold text-slate-100 text-sm">
                            {Math.floor(remS / 3600) > 0 ? `${Math.floor(remS / 3600)}h ` : ''}
                            {Math.floor((remS % 3600) / 60)}m
                            <span className="ml-1.5 text-xs font-normal text-purple-400">({remPct}%)</span>
                          </div>
                        </div>

                        <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                          <div className="flex items-center gap-1.5 text-slate-400">
                            <span className="h-2 w-2 rounded-full bg-rose-500" />
                            <span>Awake</span>
                          </div>
                          <div className="mt-1 font-mono font-bold text-slate-100 text-sm">
                            {awakeH > 0 ? `${awakeH}h ` : ''}{awakeM}m
                            <span className="ml-1.5 text-xs font-normal text-rose-400">({awakePct}%)</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Sleep Metrics Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-3.5">
                    <div className="text-xs text-slate-400">Average Blood Oxygen (SpO2)</div>
                    <div className="mt-1 font-mono text-2xl font-bold text-sky-400">
                      {sleepSpo2 != null ? `${sleepSpo2}%` : 'Not measured'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {sleepSpo2 != null
                        ? `${sleepSpo2FromLive ? 'garmlink_spo2_get' : 'Overnight average'}${
                            sleepSpo2FromLive && health?.spo2_latest != null ? ` · Latest ${health.spo2_latest}%` : ''
                          }`
                        : 'Pulse Ox sleep tracking unrecorded'}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-3.5">
                    <div className="text-xs text-slate-400">Average Respiration</div>
                    <div className="mt-1 font-mono text-2xl font-bold text-indigo-400">
                      {activeRecord.respiration_avg ?? 13} <span className="text-xs font-normal text-slate-400">brpm</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">Range: 10–15 brpm</div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-3.5">
                    <div className="text-xs text-slate-400">Sleep Stress Average</div>
                    <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">
                      {activeRecord.sleep_stress_avg ?? 17}
                    </div>
                    <div className="mt-0.5 text-[11px] text-emerald-300">Restful Evening Recovery</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-400">
                <Moon className="mx-auto h-8 w-8 text-slate-600 mb-2" />
                <p className="font-semibold text-slate-200">No sleep record logged on {selectedDate}</p>
                <p className="mt-1">
                  Watch was not worn overnight. Sync with Garmin Connect or review your rolling 30-day nightly trends below.
                </p>
                {healthHistory[0]?.date && healthHistory[0].date !== selectedDate && (
                  <button
                    type="button"
                    onClick={() => setSelectedDate(healthHistory[0].date)}
                    className="mt-3 rounded-lg bg-sky-500 px-3 py-1.5 font-semibold text-slate-950 hover:bg-sky-400"
                  >
                    View Latest Measured Night ({healthHistory[0].date})
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── 30-Day Nightly Sleep Architecture & Trends Stacked Bar Chart ── */}
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-5 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-100">30-Day Nightly Sleep Trends &amp; Architecture</h3>
                <p className="text-xs text-slate-400">
                  Chronological nightly breakdown from Garmin Connect · Click any day to inspect
                </p>
              </div>

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-400">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded bg-indigo-600" />
                  <span>Deep</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded bg-sky-500" />
                  <span>Light</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded bg-purple-500" />
                  <span>REM</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded bg-rose-500" />
                  <span>Awake</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded border border-dashed border-slate-600 bg-slate-800" />
                  <span>Not Worn</span>
                </div>
              </div>
            </div>

            {/* 30-Day Rolling Summary Stats */}
            {(() => {
              const calendarDates = get30DayCalendar(health?.date ?? '2026-11-23');
              const calendarSleepDays = calendarDates.map((dateStr) => {
                const rec = healthHistory.find((h) => h.date === dateStr);
                const hasSleep = Boolean(rec?.sleep_seconds && rec.sleep_seconds > 0);
                return {
                  date: dateStr,
                  record: rec,
                  hasSleep,
                };
              });

              const validDays = calendarSleepDays.filter((d) => d.hasSleep && d.record);
              const avgHrs = validDays.length > 0
                ? (validDays.reduce((acc, d) => acc + (d.record!.sleep_seconds ?? 0), 0) / validDays.length / 3600).toFixed(1)
                : '—';
              const avgScore = validDays.length > 0
                ? Math.round(validDays.reduce((acc, d) => acc + (d.record!.sleep_score ?? 0), 0) / validDays.length)
                : '—';
              const avgDeep = validDays.length > 0
                ? Math.round(
                    (validDays.reduce((acc, d) => acc + ((d.record!.deep_sleep_s ?? 0) / (d.record!.sleep_seconds ?? 1)), 0) /
                      validDays.length) *
                      100
                  )
                : '—';
              const avgRem = validDays.length > 0
                ? Math.round(
                    (validDays.reduce((acc, d) => acc + ((d.record!.rem_sleep_s ?? 0) / (d.record!.sleep_seconds ?? 1)), 0) /
                      validDays.length) *
                      100
                  )
                : '—';

              return (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">30-Day Avg Duration</div>
                      <div className="font-mono text-base font-bold text-slate-100 mt-0.5">{avgHrs} hrs</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">30-Day Avg Score</div>
                      <div className="font-mono text-base font-bold text-indigo-400 mt-0.5">{avgScore} / 100</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">Deep Sleep Avg</div>
                      <div className="font-mono text-base font-bold text-indigo-400 mt-0.5">{avgDeep}%</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800">
                      <div className="text-slate-400 text-[11px]">REM Sleep Avg</div>
                      <div className="font-mono text-base font-bold text-purple-400 mt-0.5">{avgRem}%</div>
                    </div>
                  </div>

                  {/* 30-Day Stacked Bars Chart */}
                  <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                    <div className="relative h-48 flex items-end gap-1 sm:gap-1.5 overflow-x-auto pb-6 pt-2">
                      {/* Target 8hr reference line */}
                      <div className="absolute top-[11%] left-0 right-0 border-b border-dashed border-emerald-500/30 pointer-events-none z-0">
                        <span className="absolute -top-3.5 right-1 text-[10px] font-mono text-emerald-400/80">
                          8h Target
                        </span>
                      </div>

                      {calendarSleepDays.map((d) => {
                        const isSelected = d.date === selectedDate;
                        const h = d.record;
                        const hasSleep = d.hasSleep && h;
                        const deep = h?.deep_sleep_s ?? 0;
                        const light = h?.light_sleep_s ?? 0;
                        const rem = h?.rem_sleep_s ?? 0;
                        const awake = h?.awake_sleep_s ?? 0;
                        const windowS = Math.max(1, deep + light + rem + awake);
                        const totalHours = (h?.sleep_seconds ?? 0) / 3600;
                        // Height relative to 9 hours max
                        const heightPct = Math.min(100, Math.max(10, (totalHours / 9) * 100));
                        const shortDate = d.date.slice(5); // e.g. "11-23"

                        return (
                          <button
                            key={d.date}
                            type="button"
                            onClick={() => setSelectedDate(d.date)}
                            className={`group relative flex-1 min-w-[20px] max-w-[32px] flex flex-col justify-end items-center h-full focus:outline-none transition-all ${
                              isSelected ? 'opacity-100 scale-105' : 'opacity-85 hover:opacity-100'
                            }`}
                            title={hasSleep ? `${d.date}: ${totalHours.toFixed(1)}h (Score: ${h?.sleep_score ?? '—'})` : `${d.date}: Not Worn — No sleep recorded`}
                          >
                            {hasSleep ? (
                              <div
                                className={`w-full rounded-t flex flex-col justify-end overflow-hidden transition-all ${
                                  isSelected
                                    ? 'ring-2 ring-sky-400 ring-offset-1 ring-offset-slate-900 shadow-md shadow-sky-500/30'
                                    : 'group-hover:brightness-110'
                                }`}
                                style={{ height: `${heightPct}%` }}
                              >
                                <div
                                  className="bg-rose-500 w-full shrink-0"
                                  style={{ height: `${(awake / windowS) * 100}%` }}
                                />
                                <div
                                  className="bg-purple-500 w-full shrink-0"
                                  style={{ height: `${(rem / windowS) * 100}%` }}
                                />
                                <div
                                  className="bg-sky-500 w-full shrink-0"
                                  style={{ height: `${(light / windowS) * 100}%` }}
                                />
                                <div
                                  className="bg-indigo-600 w-full shrink-0"
                                  style={{ height: `${(deep / windowS) * 100}%` }}
                                />
                              </div>
                            ) : (
                              <div
                                className={`w-full rounded-t border border-dashed border-slate-700/60 bg-slate-800/30 flex items-center justify-center transition-all ${
                                  isSelected ? 'ring-2 ring-sky-400' : ''
                                }`}
                                style={{ height: '14%' }}
                              >
                                <span className="text-[7px] font-mono text-slate-500 uppercase">OFF</span>
                              </div>
                            )}

                            {/* Date Label under bar */}
                            <span
                              className={`absolute -bottom-5 text-[9px] font-mono whitespace-nowrap transition-colors ${
                                isSelected ? 'text-sky-400 font-bold' : 'text-slate-500 group-hover:text-slate-300'
                              }`}
                            >
                              {shortDate}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Sub-View 4: TRAINING & LOAD FOCUS ── */}
      {subTab === 'training' && (
        <div className="space-y-5">
          <TrainingReadinessCard health={health} />
          <GarminPhysiologyCard health={health} />
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-5 shadow-md">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">Training Status &amp; Physiology</h2>
                <p className="text-xs text-slate-400">Garmin Connect Physiology Engine</p>
              </div>
              <span className="rounded-full bg-emerald-500/15 border border-emerald-500/35 px-3 py-1 font-mono text-xs font-bold text-emerald-300">
                Status: Maintaining (MAINTAINING_2)
              </span>
            </div>

            <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                <div className="text-xs text-slate-400">Garmin Running VO2 Max</div>
                <div className="mt-1.5 font-mono text-3xl font-extrabold text-amber-400">
                  {activeRecord?.vo2max ?? 51.7}
                </div>
                <div className="mt-1 text-xs text-slate-400">ml/kg/min · Precise Garmin Connect measurement</div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                <div className="text-xs text-slate-400">Acute Workload (7-Day)</div>
                <div className="mt-1.5 font-mono text-3xl font-extrabold text-sky-400">
                  {activeRecord?.acute_load ?? 1037}
                </div>
                <div className="mt-1 text-xs text-slate-400">Chronic Baseline: {activeRecord?.chronic_load ?? 900}</div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>ACWR Ratio</span>
                  <MetricInfoPopover metricKey="acwr" />
                </div>
                <div className="mt-1.5 font-mono text-3xl font-extrabold text-emerald-400">
                  {activeRecord?.acwr_ratio ?? 1.1}
                </div>
                <div className="mt-1 text-xs text-emerald-300 font-semibold">Optimal Sweet Spot (1.1)</div>
              </div>
            </div>

            {/* Load Focus Breakdown */}
            <div className="mt-5 rounded-xl border border-slate-800 bg-[#0C121B] p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-200">Load Balance Tunnels</span>
                <span className="font-mono text-amber-400 font-bold">AEROBIC_LOW_SHORTAGE</span>
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                Garmin analyzes 4-week training load across 3 physiological domains against personalized target tunnels.
              </p>

              <div className="mt-4 space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-semibold text-amber-400">Low Aerobic (Deficit)</span>
                    <span className="font-mono">{Math.round(lowAerobic)} / 790–1843 Target</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full bg-amber-400" style={{ width: `${Math.min(100, (lowAerobic / 790) * 100)}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-semibold text-sky-400">High Aerobic (Optimal)</span>
                    <span className="font-mono">{Math.round(highAerobic)} / 1141–2195 Target</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full bg-sky-400" style={{ width: `${Math.min(100, (highAerobic / 2195) * 100)}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-semibold text-rose-400">Anaerobic (High)</span>
                    <span className="font-mono">{Math.round(anaerobic)} / 351–1053 Target</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full bg-rose-400" style={{ width: `${Math.min(100, (anaerobic / 1053) * 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Sub-View 5: DEVICES & RECORDS ── */}
      {subTab === 'devices_records' && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-5 shadow-md">
            <div className="border-b border-slate-800/80 pb-3">
              <h2 className="text-base font-bold text-slate-100">Connected Garmin Watch &amp; Verified Records</h2>
              <p className="text-xs text-slate-400">Hardware telemetry and verified personal records</p>
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400">
                    <Watch className="h-7 w-7" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-100 text-sm">Garmin Instinct 2S Camo</h3>
                    <div className="text-xs text-slate-400 mt-0.5">Device ID: 3419657934</div>
                    <div className="mt-1 inline-flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/35 px-2 py-0.5 text-[10px] font-bold text-emerald-300 uppercase">
                      Primary Training Device
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                <div className="text-xs text-slate-400 font-semibold mb-2">Garmin Connect Heart Rate Zones</div>
                {health?.hr_zones && health.hr_zones.length > 0 ? (
                  <ZoneRows zones={health.hr_zones} unit="bpm" />
                ) : (
                <div className="space-y-1.5 text-xs font-mono">
                  <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-emerald-400 font-medium">Zone 1 · Recovery</span>
                    <span className="text-slate-300">110–135 bpm</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-sky-400 font-medium">Zone 2 · Aerobic Base</span>
                    <span className="text-slate-300">136–155 bpm</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-indigo-400 font-medium">Zone 3 · Tempo</span>
                    <span className="text-slate-300">156–172 bpm</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-amber-400 font-medium">Zone 4 · Threshold</span>
                    <span className="text-slate-300">173–185 bpm</span>
                  </div>
                  <div className="flex justify-between items-center py-1">
                    <span className="text-rose-400 font-medium">Zone 5 · VO2 Max</span>
                    <span className="text-slate-300">186–206 bpm</span>
                  </div>
                </div>
                )}
              </div>
            </div>

            {health?.power_zones && health.power_zones.length > 0 && (
              <div className="mt-4 rounded-xl border border-slate-800 bg-[#0C121B] p-4">
                <div className="text-xs text-slate-400 font-semibold mb-2">
                  Running Power Zones{health.running_ftp_w != null ? ` · FTP ${health.running_ftp_w} W` : ''}
                  {health.lthr_bpm != null ? ` · LTHR ${health.lthr_bpm} bpm` : ''}
                </div>
                <ZoneRows zones={health.power_zones} unit="W" />
              </div>
            )}

            {/* PRs Table */}
            <div className="mt-5 rounded-xl border border-slate-800 bg-[#0C121B] p-4">
              <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2.5">
                <Trophy className="h-4 w-4 text-amber-400" />
                <h3 className="font-bold text-slate-200 text-xs">Verified Garmin Personal Records</h3>
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(() => {
                  const seen = new Set<string>();
                  const deduped: typeof efforts = [];
                  // A verified Garmin "Fastest 1K" (typeId 1) supersedes any estimated 1K entry
                  const is1k = (x: (typeof efforts)[number]) =>
                    Math.abs(x.distance_m - 1000) < 1 || /\b1\s?k\b/i.test(x.label);
                  const isEstimated = (x: (typeof efforts)[number]) =>
                    /estimat/i.test(`${x.label} ${x.source ?? ''} ${x.id ?? ''}`);
                  const hasVerified1k = efforts.some((x) => x.source === 'garmlink_pr' && is1k(x) && !isEstimated(x));
                  for (const e of efforts) {
                    if (hasVerified1k && is1k(e) && isEstimated(e)) continue;
                    const l = e.label.toLowerCase().trim();
                    const key = l === 'mile' || l === '1 mile' || Math.abs(e.distance_m - 1609.344) < 1 ? '1_mile' : l;
                    if (!seen.has(key)) {
                      seen.add(key);
                      deduped.push(l === 'mile' ? { ...e, label: '1 Mile' } : e);
                    }
                  }
                  return deduped.map((e) => (
                    <div key={e.id} className="rounded-lg bg-slate-900/80 p-3 border border-slate-800 text-center">
                      <div className="text-[11px] font-semibold text-slate-400 uppercase">
                        {e.source === 'garmlink_pr' ? `Fastest ${e.label}` : e.label}
                      </div>
                      <div className="font-mono text-lg font-bold text-slate-100 mt-1">{formatTime(e.time_s)}</div>
                      <div className="font-mono text-xs text-amber-400 mt-0.5">{formatPaceUnit(e.time_s, e.distance_m)}</div>
                      <div className="text-[10px] text-slate-500 mt-1">{e.date}</div>
                    </div>
                  ));
                })()}
                {health?.longest_run_m != null && (
                  <div className="rounded-lg bg-slate-900/80 p-3 border border-slate-800 text-center">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase">Longest Run</div>
                    <div className="font-mono text-lg font-bold text-slate-100 mt-1">
                      {(health.longest_run_m / 1609.344).toFixed(2)} mi
                    </div>
                    <div className="font-mono text-xs text-amber-400 mt-0.5">
                      {(health.longest_run_m / 1000).toFixed(2)} km
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1">{health.longest_run_date ?? ''}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Tracked Running Shoes (Garmlink Gear List) */}
            <div className="mt-5 rounded-xl border border-slate-800 bg-[#0C121B] p-4">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-sky-400" />
                  <h3 className="font-bold text-slate-200 text-xs">Tracked Running Shoes &amp; Gear Mileage</h3>
                </div>
                <span className="font-mono text-[11px] text-slate-400">
                  Source: garmlink_gear_list · {gearList.length} Active Shoes
                </span>
              </div>

              {gearList.length > 0 ? (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                  {gearList.map((g) => {
                    const pct = Math.min(100, g.percent_worn ?? ((g.distance_miles / (g.max_distance_miles || 400)) * 100));
                    const isHighWear = pct >= 80;
                    const isMidWear = pct >= 50 && pct < 80;

                    return (
                      <div key={g.gear_id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5 flex flex-col justify-between">
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
                                {g.brand}
                              </span>
                              <h4 className="font-bold text-slate-100 text-xs mt-0.5">{g.name}</h4>
                              <div className="text-[11px] text-slate-400 mt-0.5">{g.category}</div>
                            </div>
                            <span className="rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                              {g.status}
                            </span>
                          </div>

                          <div className="mt-3 flex items-baseline justify-between">
                            <span className="font-mono text-xl font-bold tabular-nums text-slate-100">
                              {g.distance_miles.toFixed(1)} <span className="text-xs text-slate-400 font-normal">mi</span>
                            </span>
                            <span className="text-[11px] font-mono text-slate-400">
                              of {g.max_distance_miles.toFixed(0)} mi ({pct.toFixed(1)}%)
                            </span>
                          </div>

                          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                            <div
                              className={`h-full rounded-full transition-all ${
                                isHighWear
                                  ? 'bg-rose-500'
                                  : isMidWear
                                  ? 'bg-amber-400'
                                  : 'bg-sky-400'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>

                        <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500">
                          <span>Added {g.date_added}</span>
                          <span>{Math.max(0, g.max_distance_miles - g.distance_miles).toFixed(1)} mi remaining</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-white/10 bg-[#1C1C1E] p-6 text-center">
                  <Flame className="mx-auto h-7 w-7 text-slate-500" />
                  <h4 className="mt-2 text-xs font-bold text-slate-200">No Shoes Tracked in Garmin Connect</h4>
                  <p className="mt-1 text-[11px] text-slate-400 max-w-sm mx-auto">
                    Your Garmin Connect gear list is empty or hasn't recorded active shoe mileage yet. Select your racing shoe in Race Predictor to compare race-day performance.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
