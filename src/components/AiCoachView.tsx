import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, RotateCw, Send, Sparkles } from 'lucide-react';
import type {
  CoachMessage,
  GarmlinkSyncMeta,
  HealthSnapshot,
  WatchActivity,
} from '../lib/types';

interface AiCoachViewProps {
  messages: CoachMessage[];
  sending: boolean;
  garmlink: GarmlinkSyncMeta;
  activities: WatchActivity[];
  health: HealthSnapshot | null;
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
    <div className="flex h-[calc(100vh-140px)] min-h-[560px] flex-col rounded-xl border border-slate-800/80 bg-[#111720]">
      {/* Header + Synced Watch Context Strip */}
      <div className="border-b border-slate-800 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sky-400" />
            <h1 className="text-base font-bold text-slate-50">
              AI Running Coach
            </h1>
          </div>
          <div className="font-mono text-[11px] tabular-nums text-slate-400">
            {garmlink.connected ? (
              <span className="text-emerald-400">Garmlink MCP Live</span>
            ) : (
              <span>Garmlink MCP Offline</span>
            )}{' '}
            ·{' '}
            <span className="text-slate-200">{activities.length} synced runs</span>
            {health?.hrv_last_night != null && (
              <>
                {' '}
                · HRV <span className="text-emerald-400">{health.hrv_last_night} ms</span>
              </>
            )}
            {health?.sleep_score != null && (
              <>
                {' '}
                · Sleep <span className="text-slate-200">{health.sleep_score}</span>
              </>
            )}
          </div>
        </div>

        {/* Quick prompts */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              disabled={sending}
              onClick={() => onSendMessage(q)}
              className="rounded-md border border-slate-800 bg-[#0D131B] px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-50"
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
              className={`max-w-[85%] rounded-xl px-4 py-3 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-sky-500 text-slate-950 font-medium'
                  : m.error
                    ? 'border border-rose-500/40 bg-rose-500/10 text-rose-200'
                    : 'border border-slate-800 bg-[#0D131B] text-slate-200'
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
                    className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/40 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-100 transition-colors hover:bg-rose-500/30 disabled:opacity-50"
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
            <div className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-[#0D131B] px-4 py-3 text-xs text-slate-300">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-sky-400" />
              Building your coaching response…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input Composer */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t border-slate-800 bg-[#0D131B] px-4 py-3"
      >
        <input
          type="text"
          aria-label="Ask AI Running Coach"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask Coach to create a workout, taper for a race, pick shoes, or analyze your synced Garmlink data…"
          className="flex-1 rounded-lg border border-slate-700 bg-[#111720] px-3.5 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
      </form>
    </div>
  );
}
