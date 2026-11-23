import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Link2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlink,
  Upload,
  Watch,
} from 'lucide-react';
import { formatPace, formatTime } from '../lib/predictionEngine';
import { parseWatchActivityFile } from '../lib/watchData';
import type {
  GarmlinkSyncMeta,
  HealthSnapshot,
  HrvStatus,
  WatchActivity,
} from '../lib/types';

interface WatchSyncViewProps {
  garmlink: GarmlinkSyncMeta;
  health: HealthSnapshot | null;
  activities: WatchActivity[];
  onConnectGarmlink: () => void;
  onSyncGarmlink: () => void;
  onDisconnectGarmlink: () => void;
  onImportActivity: (act: WatchActivity) => void;
  onClearActivities: () => void;
  onUpdateHealth: (next: HealthSnapshot | null) => void;
  onGoToAiPlan: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

export function WatchSyncView({
  garmlink,
  health,
  activities,
  onConnectGarmlink,
  onSyncGarmlink,
  onDisconnectGarmlink,
  onImportActivity,
  onClearActivities,
  onUpdateHealth,
  onGoToAiPlan,
  onNotify,
}: WatchSyncViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editingHealth, setEditingHealth] = useState(false);
  const [showTools, setShowTools] = useState(false);

  const [manualDraft, setManualDraft] = useState<{
    vo2max: string;
    hrv_last_night: string;
    hrv_status: HrvStatus;
    sleep_score: string;
    sleep_hours: string;
    body_battery: string;
    resting_hr: string;
  }>({
    vo2max: health?.vo2max != null ? String(health.vo2max) : '',
    hrv_last_night: health?.hrv_last_night != null ? String(health.hrv_last_night) : '',
    hrv_status: health?.hrv_status ?? 'BALANCED',
    sleep_score: health?.sleep_score != null ? String(health.sleep_score) : '',
    sleep_hours: health?.sleep_hours != null ? String(health.sleep_hours) : '',
    body_battery: health?.body_battery != null ? String(health.body_battery) : '',
    resting_hr: health?.resting_hr != null ? String(health.resting_hr) : '',
  });

  const handleOpenManualEditor = () => {
    if (!editingHealth) {
      setManualDraft({
        vo2max: health?.vo2max != null ? String(health.vo2max) : '',
        hrv_last_night: health?.hrv_last_night != null ? String(health.hrv_last_night) : '',
        hrv_status: health?.hrv_status ?? 'BALANCED',
        sleep_score: health?.sleep_score != null ? String(health.sleep_score) : '',
        sleep_hours: health?.sleep_hours != null ? String(health.sleep_hours) : '',
        body_battery: health?.body_battery != null ? String(health.body_battery) : '',
        resting_hr: health?.resting_hr != null ? String(health.resting_hr) : '',
      });
    }
    setEditingHealth((v) => !v);
  };

  const handleSaveManualHealth = (e: React.FormEvent) => {
    e.preventDefault();
    const parseOpt = (v: string) => {
      const trimmed = v.trim();
      if (!trimmed) return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    };

    const next: HealthSnapshot = {
      date: new Date().toISOString().slice(0, 10),
      vo2max: parseOpt(manualDraft.vo2max),
      hrv_last_night: parseOpt(manualDraft.hrv_last_night),
      hrv_weekly_avg: health?.hrv_weekly_avg ?? null,
      hrv_status: manualDraft.hrv_status,
      hrv_baseline_low: health?.hrv_baseline_low ?? 48,
      hrv_baseline_high: health?.hrv_baseline_high ?? 74,
      sleep_score: parseOpt(manualDraft.sleep_score),
      sleep_hours: parseOpt(manualDraft.sleep_hours),
      body_battery: parseOpt(manualDraft.body_battery),
      resting_hr: parseOpt(manualDraft.resting_hr),
      stress_avg: health?.stress_avg ?? null,
      load_anaerobic: health?.load_anaerobic ?? null,
      load_aerobic_low: health?.load_aerobic_low ?? null,
      load_aerobic_high: health?.load_aerobic_high ?? null,
      consecutive_run_days: health?.consecutive_run_days ?? 0,
      source: 'manual',
      synced_at: new Date().toISOString(),
    };

    onUpdateHealth(next);
    setEditingHealth(false);
    onNotify('Saved manual watch recovery metrics.', 'success');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
    } finally {
      e.target.value = '';
    }
  };

  const totalLoad =
    health &&
    (health.load_aerobic_low != null ||
      health.load_aerobic_high != null ||
      health.load_anaerobic != null)
      ? Math.max(
          (health.load_aerobic_low ?? 0) +
            (health.load_aerobic_high ?? 0) +
            (health.load_anaerobic ?? 0),
          1
        )
      : null;

  return (
    <div className="space-y-8">
      {/* ── Section 1: Garmlink MCP Watch Connection Card ── */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111720] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
              {garmlink.connected ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="font-medium text-emerald-300">
                    Garmlink MCP Connected
                  </span>
                </>
              ) : (
                <>
                  <Watch className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span>Garmlink MCP · Not Connected</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px] text-slate-500">
                https://api.garmlink.ai/mcp
              </span>
              {garmlink.last_synced_at && (
                <span className="whitespace-nowrap font-mono text-[11px] text-slate-400">
                  · Synced {new Date(garmlink.last_synced_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            <h1 className="mt-1.5 text-xl font-bold tracking-tight text-slate-50">
              Watch Data Sync (Garmlink MCP)
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
              Connect your Garmin Connect account through Garmlink MCP to import your real recent runs, personal records, HRV, sleep, Body Battery, and VO2max—then generate AI workouts and training plans directly from your watch history.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {garmlink.connected ? (
              <>
                <button
                  type="button"
                  onClick={onSyncGarmlink}
                  disabled={garmlink.syncing}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${garmlink.syncing ? 'animate-spin' : ''}`} />
                  {garmlink.syncing ? 'Syncing Garmlink…' : 'Sync Watch Now'}
                </button>
                <button
                  type="button"
                  onClick={onDisconnectGarmlink}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#171F2B] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Unlink className="h-3.5 w-3.5 text-slate-400" />
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onConnectGarmlink}
                disabled={garmlink.syncing}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <Link2 className="h-3.5 w-3.5" />
                {garmlink.syncing ? 'Opening Garmlink…' : 'Connect Garmlink MCP'}
              </button>
            )}

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
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#171F2B] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Upload className="h-3.5 w-3.5 text-slate-300" />
              Import GPX / TCX
            </button>
          </div>
        </div>

        {garmlink.error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <span>{garmlink.error}</span>
          </div>
        )}

        {/* Discovered MCP Tools disclosure when connected */}
        {garmlink.tools_discovered.length > 0 && (
          <div className="mt-4 border-t border-slate-800/80 pt-3">
            <button
              type="button"
              onClick={() => setShowTools((v) => !v)}
              aria-expanded={showTools}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-100"
            >
              {showTools ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <span>
                {garmlink.tools_discovered.length} Garmlink MCP tools discovered ({garmlink.tools_called.length} queried on last sync)
              </span>
            </button>
            {showTools && (
              <div className="mt-2.5 flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-400">
                {garmlink.tools_discovered.map((tool) => {
                  const called = garmlink.tools_called.includes(tool);
                  return (
                    <span
                      key={tool}
                      className={`rounded border px-2 py-0.5 ${
                        called
                          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                          : 'border-slate-800 bg-[#0D131B] text-slate-400'
                      }`}
                    >
                      {tool}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Quick Next-Step Action Banner */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-[#0D131B] px-4 py-3">
          <div className="text-xs text-slate-300">
            <span className="font-semibold text-slate-100">Ready to build your training week?</span>{' '}
            Gemini uses your synced Garmlink watch data and verified PRs to generate tailored workouts and 7-day plans.
          </div>
          <button
            type="button"
            onClick={onGoToAiPlan}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Open AI Training Plan Builder
          </button>
        </div>
      </section>

      {/* ── Section 2: Real Synced Recovery Metrics & Activities (Zero Fake Data) ── */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Recovery & Training Metrics */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Watch Recovery &amp; Load
              </h2>
              <p className="text-xs text-slate-400">
                {health
                  ? `Source: ${health.source === 'garmlink_mcp' ? 'Garmlink MCP' : 'Manual Entry'} · ${health.date}`
                  : 'No watch recovery snapshot synced yet'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenManualEditor}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 whitespace-nowrap"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {editingHealth ? 'Cancel' : health ? 'Edit' : 'Log Manually'}
            </button>
          </div>

          {editingHealth ? (
            <form
              onSubmit={handleSaveManualHealth}
              className="mt-4 space-y-3 border-t border-slate-800/80 pt-4 text-xs"
            >
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-slate-400">VO2max</span>
                  <input
                    type="number"
                    step="0.1"
                    placeholder="e.g. 54.5"
                    value={manualDraft.vo2max}
                    onChange={(e) => setManualDraft({ ...manualDraft, vo2max: e.target.value })}
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Overnight HRV (ms)</span>
                  <input
                    type="number"
                    placeholder="e.g. 58"
                    value={manualDraft.hrv_last_night}
                    onChange={(e) =>
                      setManualDraft({ ...manualDraft, hrv_last_night: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">HRV Status</span>
                  <select
                    value={manualDraft.hrv_status}
                    onChange={(e) =>
                      setManualDraft({ ...manualDraft, hrv_status: e.target.value as HrvStatus })
                    }
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 text-slate-100"
                  >
                    <option value="BALANCED">BALANCED</option>
                    <option value="LOW">LOW</option>
                    <option value="UNBALANCED">UNBALANCED</option>
                    <option value="POOR">POOR</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Sleep Score (0–100)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="e.g. 82"
                    value={manualDraft.sleep_score}
                    onChange={(e) =>
                      setManualDraft({ ...manualDraft, sleep_score: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Sleep Hours</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={16}
                    placeholder="e.g. 7.5"
                    value={manualDraft.sleep_hours}
                    onChange={(e) =>
                      setManualDraft({ ...manualDraft, sleep_hours: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Body Battery (0–100)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="e.g. 76"
                    value={manualDraft.body_battery}
                    onChange={(e) =>
                      setManualDraft({ ...manualDraft, body_battery: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Resting HR (bpm)</span>
                  <input
                    type="number"
                    min={30}
                    max={110}
                    placeholder="e.g. 54"
                    value={manualDraft.resting_hr}
                    onChange={(e) =>
                      setManualDraft({ ...manualDraft, resting_hr: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-700 bg-[#090D12] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
              </div>
              <div className="flex items-center justify-between pt-2">
                {health && (
                  <button
                    type="button"
                    onClick={() => {
                      onUpdateHealth(null);
                      setEditingHealth(false);
                      onNotify('Cleared watch health snapshot.', 'info');
                    }}
                    className="text-xs text-rose-400 hover:text-rose-300"
                  >
                    Clear Snapshot
                  </button>
                )}
                <button
                  type="submit"
                  className="ml-auto rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400"
                >
                  Save Metrics
                </button>
              </div>
            </form>
          ) : !health ? (
            <div
              className="mt-4 rounded-lg border border-dashed border-slate-800 bg-[#0D131B] p-5 text-center"
              data-testid="health-empty-state"
            >
              <p className="text-xs font-medium text-slate-300">
                No Garmin health data synced yet
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                Connect Garmlink MCP above to pull your real overnight HRV, sleep score, Body Battery, VO2max, and training load directly from Garmin Connect.
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-4 border-t border-slate-800/80 pt-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-slate-800/80 bg-[#0D131B] p-3">
                  <div className="text-slate-400">Overnight HRV</div>
                  <div className="mt-1 font-mono text-lg font-bold tabular-nums text-emerald-400">
                    {health.hrv_last_night != null ? `${health.hrv_last_night} ms` : '—'}
                  </div>
                  <div className="text-[11px] text-slate-500">{health.hrv_status}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-[#0D131B] p-3">
                  <div className="text-slate-400">Sleep Score</div>
                  <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
                    {health.sleep_score != null ? `${health.sleep_score}/100` : '—'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {health.sleep_hours != null ? `${health.sleep_hours} hrs` : 'Duration N/A'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-[#0D131B] p-3">
                  <div className="text-slate-400">Body Battery</div>
                  <div className="mt-1 font-mono text-lg font-bold tabular-nums text-sky-400">
                    {health.body_battery != null ? `${health.body_battery}/100` : '—'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {health.resting_hr != null ? `RHR ${health.resting_hr} bpm` : 'RHR N/A'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-[#0D131B] p-3">
                  <div className="text-slate-400">Garmin VO2max</div>
                  <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
                    {health.vo2max != null ? health.vo2max : '—'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {health.consecutive_run_days > 0
                      ? `${health.consecutive_run_days} day run streak`
                      : 'ml/kg/min'}
                  </div>
                </div>
              </div>

              {totalLoad !== null && (
                <div className="space-y-2 border-t border-slate-800/80 pt-3 text-xs">
                  <div className="font-medium text-slate-300">Synced 4-Week Load Focus</div>
                  {health.load_aerobic_low != null && (
                    <div>
                      <div className="mb-1 flex justify-between text-[11px]">
                        <span className="text-slate-400">Low Aerobic</span>
                        <span className="font-mono tabular-nums text-amber-400">
                          {health.load_aerobic_low}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-amber-400"
                          style={{
                            width: `${Math.min(100, (health.load_aerobic_low / totalLoad) * 180)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {health.load_aerobic_high != null && (
                    <div>
                      <div className="mb-1 flex justify-between text-[11px]">
                        <span className="text-slate-400">High Aerobic</span>
                        <span className="font-mono tabular-nums text-sky-400">
                          {health.load_aerobic_high}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-sky-400"
                          style={{
                            width: `${Math.min(100, (health.load_aerobic_high / totalLoad) * 180)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {health.load_anaerobic != null && (
                    <div>
                      <div className="mb-1 flex justify-between text-[11px]">
                        <span className="text-slate-400">Anaerobic</span>
                        <span className="font-mono tabular-nums text-rose-400">
                          {health.load_anaerobic}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-rose-400"
                          style={{
                            width: `${Math.min(100, (health.load_anaerobic / totalLoad) * 180)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Real Synced Watch Activities Table (Zero Fake Activities) */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111720] p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Recent Watch Activities
              </h2>
              <p className="text-xs text-slate-400">
                Real runs pulled via Garmlink MCP or uploaded watch files ({activities.length} synced)
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs font-medium text-sky-400 transition-colors hover:text-sky-300"
              >
                + Upload GPX / TCX
              </button>
              {activities.length > 0 && (
                <button
                  type="button"
                  onClick={onClearActivities}
                  className="inline-flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </button>
              )}
            </div>
          </div>

          {activities.length === 0 ? (
            <div
              className="mt-4 flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-800 bg-[#0D131B] px-6 py-12 text-center"
              data-testid="activities-empty-state"
            >
              <Watch className="h-6 w-6 text-slate-500" />
              <p className="mt-3 text-sm font-medium text-slate-200">
                No watch activities synced yet
              </p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-400">
                RaceKit displays only your real watch activities—no placeholder runs. Connect Garmlink MCP to sync from Garmin Connect, or upload a real GPX, TCX, or Garmin JSON export.
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={garmlink.connected ? onSyncGarmlink : onConnectGarmlink}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {garmlink.connected ? 'Sync from Garmlink MCP' : 'Connect Garmlink MCP'}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#171F2B] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload GPX / TCX
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto" data-testid="activities-table">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400">
                    <th className="pb-2.5 pr-3">Session</th>
                    <th className="px-2 pb-2.5 text-right">Dist</th>
                    <th className="px-2 pb-2.5 text-right">Time</th>
                    <th className="px-2 pb-2.5 text-right">Pace</th>
                    <th className="px-2 pb-2.5 text-right">Avg HR</th>
                    <th className="pb-2.5 pl-2 text-right">Gain</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {activities.slice(0, 20).map((a) => {
                    const mi = a.distance_m / 1609.344;
                    const paceS = mi > 0.05 && a.duration_s > 0 ? a.duration_s / mi : null;
                    return (
                      <tr key={a.id} className="hover:bg-slate-800/30">
                        <td className="py-3 pr-3">
                          <div className="font-medium text-slate-100">{a.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {a.date} · {a.source_label}
                          </div>
                        </td>
                        <td className="px-2 py-3 text-right font-mono tabular-nums text-slate-200">
                          {mi.toFixed(2)} mi
                        </td>
                        <td className="px-2 py-3 text-right font-mono tabular-nums text-slate-200">
                          {formatTime(a.duration_s)}
                        </td>
                        <td className="px-2 py-3 text-right font-mono tabular-nums text-slate-300">
                          {paceS ? formatPace(paceS) : '—'}
                        </td>
                        <td className="px-2 py-3 text-right font-mono tabular-nums text-slate-200">
                          {a.avg_hr ? `${Math.round(a.avg_hr)} bpm` : '—'}
                        </td>
                        <td className="py-3 pl-2 text-right font-mono tabular-nums text-slate-400">
                          +{a.elevation_gain_ft} ft
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
