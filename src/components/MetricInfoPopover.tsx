import React, { useState, useRef, useEffect } from 'react';
import { HelpCircle, Info, X } from 'lucide-react';

export type MetricKey = 'cs' | 'd_prime' | 'vdot' | 'acwr' | 'hrv';

interface MetricInfo {
  title: string;
  badge: string;
  summary: string;
  details: string;
  formula?: string;
  actionableTip: string;
}

export const METRIC_EXPLANATIONS: Record<MetricKey, MetricInfo> = {
  cs: {
    title: 'Critical Speed (CS)',
    badge: 'Threshold Anchor',
    summary:
      'The highest running speed you can sustain aerobically without progressive lactate accumulation and exhaustion.',
    details:
      'Often called your "true physiological threshold," Critical Speed represents the asymptotic boundary between sustainable aerobic metabolism and rapid fatigue. It closely corresponds to your 45–60 minute race pace.',
    formula: 'd = CS × t + D\' (linear regression slope)',
    actionableTip:
      'Paces at or slightly below CS build massive aerobic stamina; paces above CS immediately begin depleting your anaerobic reserve.',
  },
  d_prime: {
    title: 'D\' (D-Prime Anaerobic Reserve)',
    badge: 'Anaerobic Battery',
    summary:
      'Your finite anaerobic work capacity measured in meters (typically 150m–350m).',
    details:
      'Think of D\' as an anaerobic sprint battery. Whenever you run faster than Critical Speed (e.g. hill surges, race starts, or the final kick), this battery drains. When you drop below CS, it slowly recharges.',
    formula: 'Intercept in the distance-time linear model (d = CS × t + D\')',
    actionableTip:
      'Speed-oriented runners have a larger D\' (>260m) giving them explosive kick power, while endurance runners have a smaller D\' (<190m) but higher sustained CS.',
  },
  vdot: {
    title: 'Jack Daniels VDOT',
    badge: 'Running Fitness Score',
    summary:
      'A universal running fitness index derived from your race performances.',
    details:
      'Developed by legendary coach Dr. Jack Daniels, VDOT measures your effective oxygen cost and running economy. It equates performances across 400m to the Marathon and establishes your exact training zones.',
    formula: 'Inverted Daniels %vVO2max & oxygen cost curves',
    actionableTip:
      'Train at your current VDOT, not your goal VDOT. This guarantees physiological stimulus without overtraining.',
  },
  acwr: {
    title: 'Acute-to-Chronic Workload Ratio (ACWR)',
    badge: 'Load & Injury Shield',
    summary:
      'The ratio of fatigue (last 7 days of training load) to fitness base (last 28 days of load).',
    details:
      'A proven sports science metric. An ACWR between 0.8 and 1.3 represents the optimal "sweet spot" where fitness builds while injury risk remains lowest. Ratios exceeding 1.5 indicate a spike in injury risk.',
    formula: 'ACWR = Acute Load (7d sum) / Chronic Load (28d weekly avg)',
    actionableTip:
      'Keep your weekly training load increases under 10–15% to maintain an ACWR inside the green 0.8–1.3 safety band.',
  },
  hrv: {
    title: 'HRV Baseline & Autonomic Recovery',
    badge: 'Autonomic Balance',
    summary:
      'Overnight Heart Rate Variability compared to your rolling 7-day baseline.',
    details:
      'HRV measures the variation in milliseconds between consecutive heartbeats. When your parasympathetic ("rest and digest") nervous system is recovered, HRV is within or above your baseline. A drop below baseline signals systemic fatigue, illness, or incomplete recovery.',
    formula: 'rMSSD (root mean square of successive differences)',
    actionableTip:
      'When HRV is below your baseline, prioritize easy recovery flush runs or rest instead of scheduled hard interval sessions.',
  },
};

interface MetricInfoPopoverProps {
  metricKey: MetricKey;
  inlineLabel?: string;
  iconOnly?: boolean;
}

export function MetricInfoPopover({
  metricKey,
  inlineLabel,
  iconOnly = false,
}: MetricInfoPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const info = METRIC_EXPLANATIONS[metricKey];
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  if (!info) return null;

  return (
    <div className="relative inline-flex items-center" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 text-[#8E8E93] hover:text-[#0A84FF] transition-colors focus:outline-none"
        aria-label={`Explain ${info.title}`}
        title={`Click for ${info.title} explanation`}
      >
        {inlineLabel && <span className="text-xs font-semibold">{inlineLabel}</span>}
        <Info className="h-3.5 w-3.5" />
      </button>

      {isOpen && (
        <div
          className="absolute left-1/2 bottom-full mb-2 z-50 w-72 -translate-x-1/2 rounded-2xl border border-white/15 bg-[#1C1C1E] p-4 text-xs text-white shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150"
          role="tooltip"
        >
          <div className="flex items-center justify-between pb-2 border-b border-white/10">
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-xs">{info.title}</span>
              <span className="rounded-full bg-[#0A84FF]/20 px-2 py-0.5 text-[9px] font-bold text-[#0A84FF] uppercase">
                {info.badge}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-[#8E8E93] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <p className="mt-2 text-xs text-slate-200 leading-relaxed font-medium">
            {info.summary}
          </p>

          <p className="mt-1.5 text-[11px] text-[#8E8E93] leading-relaxed">
            {info.details}
          </p>

          {info.formula && (
            <div className="mt-2 rounded-xl bg-black/40 p-2 font-mono text-[10px] text-emerald-400 border border-white/5">
              {info.formula}
            </div>
          )}

          <div className="mt-2.5 pt-2 border-t border-white/10 text-[11px] text-[#0A84FF] font-medium">
            <strong>Coach's Tip:</strong> {info.actionableTip}
          </div>

          {/* Pointer caret */}
          <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-[#1C1C1E]" />
        </div>
      )}
    </div>
  );
}
