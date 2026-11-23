import { useEffect, useRef, useState } from 'react';
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

function renderSafeFormattedText(text: string) {
  return text.split('\n').map((line, lineIdx) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
      <p key={lineIdx} className={lineIdx > 0 ? 'mt-2' : undefined}>
        {parts.map((part, idx) => {
          if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
            return (
              <strong key={idx} className="font-semibold text-slate-50">
                {part.slice(2, -2)}
              </strong>
            );
          }
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            return (
              <code
                key={idx}
                className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-sky-300"
              >
                {part.slice(1, -1)}
              </code>
            );
          }
          return <span key={idx}>{part}</span>;
        })}
      </p>
    );
  });
}

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
      <div className="flex flex-col rounded-2xl border border-slate-800 bg-[#111720] shadow-md lg:col-span-8 overflow-hidden">
        {/* Header + Synced Watch Context Strip */}
        <div className="border-b border-slate-800/80 bg-[#0C121B] px-5 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-400">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-slate-100">
                  AI Running Coach
                </h1>
                <p className="text-[11px] text-slate-400">
                  Grounded in your verified Garmin PRs, Critical Speed, and VDOT zones
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
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
                className="rounded-lg border border-slate-800 bg-[#111720] px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-50"
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
                    ? 'bg-sky-500 text-slate-950 font-semibold shadow-sky-500/10'
                    : m.error
                      ? 'border border-rose-500/40 bg-rose-500/10 text-rose-200'
                      : 'border border-slate-800/90 bg-[#0C121B] text-slate-200'
                }`}
              >
                {m.error && (
                  <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-rose-100">
                    <AlertCircle className="h-3.5 w-3.5 text-rose-400" />
                    <span>Gemini Coach Error</span>
                  </div>
                )}
                {m.role === 'user' ? m.content : renderSafeFormattedText(m.content)}

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
          className="flex items-center gap-2 border-t border-slate-800/80 bg-[#0C121B] px-4 py-3"
        >
          <input
            type="text"
            aria-label="Ask AI Running Coach"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask Coach to build a workout, adjust pace zones, prepare race taper, or analyze fatigue…"
            className="flex-1 rounded-xl border border-slate-700 bg-[#111720] px-3.5 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-50 whitespace-nowrap shrink-0 shadow-sm shadow-sky-500/20"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </button>
        </form>
      </div>

      {/* Right Column (4 cols): Athlete Telemetry Context Sidebar */}
      <div className="hidden lg:flex lg:col-span-4 flex-col gap-4 overflow-y-auto">
        {/* Recovery & Readiness Snapshot */}
        <div className="rounded-2xl border border-slate-800 bg-[#111720] p-4 shadow-md">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
            <h3 className="text-xs font-bold text-slate-200">Garmin Recovery Context</h3>
            <span className="font-mono text-[10px] text-emerald-400 font-semibold uppercase">
              Garmlink MCP
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-slate-800/80 bg-[#0C121B] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Body Battery</span>
                <BatteryCharging className="h-3 w-3 text-sky-400" />
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-sky-400">
                {health?.body_battery ?? 79}%
              </div>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0C121B] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Sleep Score</span>
                <Moon className="h-3 w-3 text-indigo-400" />
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-100">
                {health?.sleep_score ?? 84}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0C121B] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Overnight HRV</span>
                <Activity className="h-3 w-3 text-emerald-400" />
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-emerald-400">
                {health?.hrv_last_night ?? 61}ms
              </div>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0C121B] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Resting HR</span>
                <Heart className="h-3 w-3 text-rose-400" />
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-100">
                {health?.resting_hr ?? 53} <span className="text-[10px] text-slate-400">bpm</span>
              </div>
            </div>
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
