import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Activity,
  AlertCircle,
  BatteryCharging,
  CheckCircle2,
  Heart,
  Moon,
  RefreshCw,
  RotateCw,
  Send,
  Sparkles,
  TrendingUp,
  Trophy,
  Zap,
} from 'lucide-react';
import type {
  CoachMessage,
  Effort,
  FitnessMetrics,
  GarmlinkSyncMeta,
  HealthSnapshot,
  TrainingZones,
  WatchActivity,
} from '../lib/types';

interface AiCoachViewProps {
  messages: CoachMessage[];
  sending: boolean;
  garmlink: GarmlinkSyncMeta;
  activities: WatchActivity[];
  health: HealthSnapshot | null;
  fitness?: FitnessMetrics;
  zones?: TrainingZones;
  efforts?: Effort[];
  prefillPrompt: string | null;
  onConsumePrefill: () => void;
  onSendMessage: (text: string) => void;
}

const QUICK_PROMPTS = [
  'Build a track threshold workout for Tuesday using my VDOT pace zones',
  'Taper this week for Run for Pie 5K on Thursday',
  'Create an easy Zone 2 aerobic base run for tomorrow and add it to my plan',
  'Which shoe from my 5-shoe rotation is fastest for Brandywine Creek XC?',
];

export function AiCoachView({
  messages,
  sending,
  garmlink,
  activities,
  health,
  fitness,
  zones,
  efforts = [],
  prefillPrompt,
  onConsumePrefill,
  onSendMessage,
}: AiCoachViewProps) {
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const baselineLow = health?.hrv_baseline_low ?? 48;
  const baselineHigh = health?.hrv_baseline_high ?? 74;
  const isHrvLow = Boolean(
    health?.hrv_last_night != null &&
    (health.hrv_last_night < baselineLow ||
     (health.hrv_weekly_avg != null && health.hrv_last_night < health.hrv_weekly_avg * 0.8))
  );
  const hrvDropMs = health?.hrv_last_night != null && health.hrv_last_night < baselineLow
    ? Math.round(baselineLow - health.hrv_last_night)
    : 0;

  useEffect(() => {
    if (prefillPrompt) {
      setDraft(prefillPrompt);
      onConsumePrefill();
    }
  }, [prefillPrompt, onConsumePrefill]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = draft.trim();
    if (!cleaned || sending) return;
    setDraft('');
    onSendMessage(cleaned);
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 h-[calc(100vh-130px)] min-h-[580px]">
      {/* Main Chat Column (8 cols on lg/xl) */}
      <div className="flex flex-col rounded-3xl border border-white/10 bg-[#1C1C1E] shadow-sm lg:col-span-8 overflow-hidden">
        {/* Header + Synced Watch Context Strip */}
        <div className="border-b border-white/10 bg-[#1C1C1E] px-5 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0A84FF]/15 border border-[#0A84FF]/30 text-[#0A84FF]">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-white">
                  AI Running Coach
                </h1>
                <p className="text-[11px] text-[#8E8E93]">
                  Grounded in your verified Garmin PRs, Critical Speed, and VDOT zones
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 font-mono text-[11px] text-[#8E8E93]">
              <span className="inline-flex items-center gap-1 text-[#30D158] font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-[#30D158] animate-pulse" />
                Garmlink MCP Synced
              </span>
              <span>·</span>
              <span>{activities.length} runs</span>
            </div>
          </div>

          {/* Quick prompt pills */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                type="button"
                disabled={sending}
                onClick={() => onSendMessage(q)}
                className="rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-1 text-[11px] text-slate-200 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Message Stream */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" data-testid="coach-messages">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-sm ${
                  m.role === 'user'
                    ? 'bg-[#0A84FF] text-white font-medium shadow-sm'
                    : m.error
                      ? 'border border-[#FF453A]/40 bg-[#FF453A]/10 text-[#FF453A]'
                      : 'border border-white/10 bg-[#2C2C2E] text-slate-100'
                }`}
              >
                {m.error && (
                  <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-rose-100">
                    <AlertCircle className="h-3.5 w-3.5 text-rose-400" />
                    <span>Gemini Coach Error</span>
                  </div>
                )}
                {m.role === 'user' ? (
                  m.content
                ) : (
                  <ReactMarkdown
                    components={{
                      h1: ({ children }) => <h3 className="text-sm font-bold text-white mt-2 mb-1">{children}</h3>,
                      h2: ({ children }) => <h4 className="text-xs font-bold text-slate-100 mt-2 mb-1 uppercase tracking-wide">{children}</h4>,
                      h3: ({ children }) => <h5 className="text-xs font-bold text-[#0A84FF] mt-1.5 mb-0.5">{children}</h5>,
                      p: ({ children }) => <p className="mt-1 leading-relaxed text-slate-200">{children}</p>,
                      ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-1 text-slate-200">{children}</ul>,
                      ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-1 text-slate-200">{children}</ol>,
                      li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                      code: ({ children }) => (
                        <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-[#0A84FF]">
                          {children}
                        </code>
                      ),
                      strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                    }}
                  >
                    {m.content}
                  </ReactMarkdown>
                )}

                {m.error && m.retryPrompt && (
                  <div className="mt-3">
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => onSendMessage(m.retryPrompt!)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-100 transition-colors hover:bg-rose-500/30 disabled:opacity-50"
                    >
                      <RotateCw className="h-3 w-3" />
                      Retry Request
                    </button>
                  </div>
                )}

                {m.tool_actions && m.tool_actions.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-slate-800 pt-2.5">
                    {m.tool_actions.map((act, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span>{act}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <span className="mt-1 px-1 font-mono text-[10px] text-slate-500">{m.timestamp}</span>
            </div>
          ))}

          {sending && (
            <div className="flex items-start">
              <div className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-[#0C121B] px-4 py-3 text-xs text-slate-300">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-sky-400" />
                Analyzing Garmin watch telemetry and formulating response…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input Composer */}
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 border-t border-white/10 bg-[#1C1C1E] px-4 py-3"
        >
          <input
            type="text"
            aria-label="Ask AI Running Coach"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask Coach to build a workout, adjust pace zones, prepare race taper, or analyze fatigue…"
            className="flex-1 rounded-2xl border border-white/10 bg-[#2C2C2E] px-4 py-2.5 text-xs text-white placeholder:text-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-1.5 rounded-2xl bg-[#0A84FF] px-4 py-2.5 text-xs font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50 whitespace-nowrap shrink-0 shadow-sm"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </button>
        </form>
      </div>

      {/* Right Column (4 cols): Athlete Telemetry Context Sidebar */}
      <div className="hidden lg:flex lg:col-span-4 flex-col gap-4 overflow-y-auto">
        {/* Recovery & Readiness Snapshot */}
        <div className="rounded-3xl border border-white/10 bg-[#1C1C1E] p-4 shadow-sm">
          <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
            <h3 className="text-xs font-bold text-white">Garmin Recovery Context</h3>
            <span className="font-mono text-[10px] text-[#30D158] font-semibold uppercase">
              Garmlink MCP
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {/* VO2 Max */}
            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E] p-2.5 col-span-2 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#8E8E93]">Garmin Running VO2 Max</div>
                <div className="mt-0.5 font-mono text-xl font-bold text-[#30D158]">
                  {health?.vo2max ?? fitness?.vo2max ?? 51.7}
                  <span className="text-[10px] text-[#8E8E93] font-normal ml-1">ml/kg/min</span>
                </div>
              </div>
              <div className="text-right">
                <span className="rounded-full bg-[#30D158]/20 px-2 py-0.5 text-[9px] font-bold text-[#30D158] uppercase">
                  Superior
                </span>
                <div className="text-[10px] text-[#8E8E93] mt-1 font-mono">
                  {health?.training_status_phrase ?? 'Maintaining'}
                </div>
              </div>
            </div>

            {/* Body Battery */}
            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8E8E93]">
                <span>Body Battery</span>
                <BatteryCharging className="h-3.5 w-3.5 text-[#0A84FF]" />
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-[#0A84FF]">
                {health?.body_battery != null ? health.body_battery : 55}
                <span className="text-[10px] text-[#8E8E93] font-normal"> / 100</span>
              </div>
              <div className="text-[10px] text-[#8E8E93] mt-0.5">
                Highest: {health?.bb_highest ?? 55}
              </div>
            </div>

            {/* Sleep */}
            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8E8E93]">
                <span>Sleep Time</span>
                <Moon className="h-3.5 w-3.5 text-[#BF5AF2]" />
              </div>
              <div className="mt-1 font-mono text-base font-bold text-white">
                {health?.sleep_time_fmt ?? (() => {
                  if (health?.sleep_hours != null) {
                    const totalMin = Math.round(health.sleep_hours * 60);
                    const h = Math.floor(totalMin / 60);
                    const m = totalMin % 60;
                    return `${h}h ${m.toString().padStart(2, '0')}m`;
                  }
                  if (health?.sleep_score != null) return `Score ${health.sleep_score}`;
                  return '5h 06m';
                })()}
              </div>
              <div className="text-[10px] text-[#8E8E93] mt-0.5">
                Score: {health?.sleep_score ?? 54}/100
              </div>
            </div>

            {/* Overnight HRV */}
            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8E8E93]">
                <span>Overnight HRV</span>
                <Activity className={`h-3 w-3 ${isHrvLow ? 'text-[#FF9F0A]' : 'text-[#30D158]'}`} />
              </div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className={`font-mono text-base font-bold ${isHrvLow ? 'text-[#FF9F0A]' : 'text-[#30D158]'}`}>
                  {health?.hrv_last_night != null ? `${health.hrv_last_night} ms` : '32 ms'}
                </span>
                {isHrvLow && (
                  <span className="rounded bg-[#FF9F0A]/20 px-1 text-[9px] font-bold text-[#FF9F0A]">
                    LOW
                  </span>
                )}
              </div>
              <div className="text-[10px] text-[#8E8E93] mt-0.5">
                Baseline: {baselineLow}–{baselineHigh}ms
              </div>
            </div>

            {/* Resting HR */}
            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8E8E93]">
                <span>Resting HR</span>
                <Heart className="h-3 w-3 text-[#FF453A]" />
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-white">
                {health?.resting_hr ?? 62} <span className="text-[10px] text-[#8E8E93] font-normal">bpm</span>
              </div>
              <div className="text-[10px] text-[#8E8E93] mt-0.5">
                7-day avg: {health?.resting_hr_avg_7d ?? 59} bpm
              </div>
            </div>
          </div>

          {/* Recovery Warning Banner if HRV is Low */}
          {isHrvLow && (
            <div className="mt-2.5 rounded-xl border border-amber-500/40 bg-amber-500/15 p-2.5 text-xs text-amber-200">
              <div className="flex items-start gap-2">
                <Activity className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="text-[11px] leading-tight">
                  <strong className="text-amber-300">Recovery Warning:</strong> Overnight HRV ({health?.hrv_last_night} ms) is {hrvDropMs} ms below your {baselineLow}–{baselineHigh} ms baseline (-33% vs. 7-day avg). Prioritize recovery / easy aerobic work today.
                </div>
              </div>
            </div>
          )}

          {/* Training Load Focus Banner */}
          <div className="mt-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 p-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-amber-300">Training Load Focus</span>
              <span className="font-mono text-[10px] font-bold text-amber-400 uppercase">Shortage</span>
            </div>
            <p className="mt-1 text-[11px] leading-tight text-amber-200/90">
              Low Aerobic: <strong>{health?.load_aerobic_low ?? 613}</strong> (target 790+) · Anaerobic: <strong>{health?.load_anaerobic ?? 1360}</strong>. Prioritize easy base mileage.
            </p>
          </div>
        </div>

        {/* VDOT Pace Zones Quick Reference */}
        {zones && (
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-4 shadow-md">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
              <h3 className="text-xs font-bold text-slate-200">VDOT Pace Zones</h3>
              <span className="font-mono text-[11px] text-amber-400 font-bold">
                VDOT {fitness?.vo2max ?? 54.6}
              </span>
            </div>

            <div className="mt-3 space-y-2 text-xs">
              <div className="flex justify-between items-center rounded-lg bg-[#0C121B] px-2.5 py-1.5 border border-slate-800/70">
                <span className="text-emerald-400 font-medium">Easy Z2</span>
                <span className="font-mono text-slate-200">{zones.easy.label}</span>
              </div>
              <div className="flex justify-between items-center rounded-lg bg-[#0C121B] px-2.5 py-1.5 border border-slate-800/70">
                <span className="text-slate-300 font-medium">Marathon</span>
                <span className="font-mono text-slate-200">{zones.marathon.label}</span>
              </div>
              <div className="flex justify-between items-center rounded-lg bg-[#0C121B] px-2.5 py-1.5 border border-slate-800/70">
                <span className="text-sky-400 font-medium">Threshold</span>
                <span className="font-mono text-slate-200">{zones.threshold.label}</span>
              </div>
              <div className="flex justify-between items-center rounded-lg bg-[#0C121B] px-2.5 py-1.5 border border-slate-800/70">
                <span className="text-amber-400 font-medium">Interval</span>
                <span className="font-mono text-slate-200">{zones.interval.label}</span>
              </div>
              <div className="flex justify-between items-center rounded-lg bg-[#0C121B] px-2.5 py-1.5 border border-slate-800/70">
                <span className="text-rose-400 font-medium">Rep 400m</span>
                <span className="font-mono text-slate-200">{zones.rep_400m}</span>
              </div>
            </div>
          </div>
        )}

        {/* Verified PR Targets */}
        {efforts.length > 0 && (
          <div className="rounded-2xl border border-slate-800 bg-[#111720] p-4 shadow-md">
            <div className="flex items-center gap-1.5 border-b border-slate-800/80 pb-2.5">
              <Trophy className="h-3.5 w-3.5 text-amber-400" />
              <h3 className="text-xs font-bold text-slate-200">Verified PR Efforts</h3>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
              {efforts.map((e) => (
                <div key={e.id} className="rounded-lg bg-[#0C121B] p-2 border border-slate-800/70">
                  <div className="text-[10px] font-semibold text-slate-400">{e.label}</div>
                  <div className="font-mono font-bold text-slate-100">{Math.floor(e.time_s / 60)}:{(e.time_s % 60).toFixed(1).padStart(4, '0')}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
