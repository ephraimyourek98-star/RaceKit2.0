import React, { useState } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Compass,
  Flame,
  Gauge,
  Sparkles,
  Trophy,
  User,
  Watch,
  X,
  Zap,
} from 'lucide-react';
import { PRESET_COURSES } from '../lib/seedData';
import type { CoursePreset, Effort } from '../lib/types';
import type { UserProfile } from '../lib/supabaseClient';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (data: {
    user: UserProfile;
    targetRaceName: string;
    targetRaceDist: string;
    weeklyTargetMiles: number;
    initialEffort?: Effort;
  }) => void;
  onOpenGarmlinkSync: () => void;
  currentUser: UserProfile | null;
}

export function OnboardingModal({
  isOpen,
  onClose,
  onComplete,
  onOpenGarmlinkSync,
  currentUser,
}: OnboardingModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1: Athlete Identity
  const [athleteName, setAthleteName] = useState(currentUser?.name || '');
  const [athleteEmail, setAthleteEmail] = useState(currentUser?.email || '');

  // Step 2: Fitness Baseline
  const [baselineType, setBaselineType] = useState<'garmin' | 'manual'>('manual');
  const [manualDistance, setManualDistance] = useState<'5K' | '1600m' | '10K'>('5K');
  const [manualMinutes, setManualMinutes] = useState<number>(19);
  const [manualSeconds, setManualSeconds] = useState<number>(8);

  // Step 3: Target Race Goal
  const [selectedCourseId, setSelectedCourseId] = useState('run_for_pie_glasgow');
  const [weeklyMileage, setWeeklyMileage] = useState<number>(30);

  if (!isOpen) return null;

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else if (step === 3) {
      // Build final object and complete
      const course = PRESET_COURSES.find((c) => c.course_id === selectedCourseId) || PRESET_COURSES[0];

      let initialEffort: Effort | undefined;
      if (baselineType === 'manual') {
        const totalSec = manualMinutes * 60 + manualSeconds;
        const distM = manualDistance === '5K' ? 5000 : manualDistance === '1600m' ? 1600 : 10000;
        initialEffort = {
          id: `onboarding-pr-${Date.now()}`,
          distance_m: distM,
          time_s: totalSec,
          date: new Date().toISOString().split('T')[0],
          label: `${manualDistance} (Benchmark)`,
          source: 'manual_onboarding',
        };
      }

      const activeUser: UserProfile = currentUser || {
        id: `guest-${Date.now().toString(36)}`,
        email: athleteEmail || 'guest@racekit.ai',
        name: athleteName.trim() || 'Athlete',
        is_demo: !currentUser,
        weekly_target_miles: weeklyMileage,
        longest_run_miles: Math.round(weeklyMileage * 0.35),
        created_at: new Date().toISOString(),
      };

      onComplete({
        user: activeUser,
        targetRaceName: course.name,
        targetRaceDist: course.distance_label,
        weeklyTargetMiles: weeklyMileage,
        initialEffort,
      });
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
      <div
        className="relative w-full max-w-lg rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 shadow-2xl text-white"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        {/* Step Indicator Progress Bar */}
        <div className="mb-6">
          <div className="flex items-center justify-between text-xs font-semibold text-[#8E8E93] mb-2">
            <span>Step {step} of 3</span>
            <span>
              {step === 1 && 'Welcome & Profile'}
              {step === 2 && 'Athletic Baseline'}
              {step === 3 && 'Target Race Goal'}
            </span>
          </div>
          <div className="flex gap-2">
            <div className={`h-1.5 flex-1 rounded-full transition-all ${step >= 1 ? 'bg-[#0A84FF]' : 'bg-white/10'}`} />
            <div className={`h-1.5 flex-1 rounded-full transition-all ${step >= 2 ? 'bg-[#0A84FF]' : 'bg-white/10'}`} />
            <div className={`h-1.5 flex-1 rounded-full transition-all ${step >= 3 ? 'bg-[#0A84FF]' : 'bg-white/10'}`} />
          </div>
        </div>

        {/* ── STEP 1: WELCOME & ATHLETE IDENTITY ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="text-center space-y-1.5">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0A84FF]/20 text-[#0A84FF] mb-1">
                <Zap className="h-6 w-6" />
              </div>
              <h2 id="onboarding-title" className="text-xl font-bold tracking-tight text-white">
                Welcome to RaceKit
              </h2>
              <p className="text-xs text-[#8E8E93] max-w-sm mx-auto">
                Next-generation running performance modeling. Calibrate Critical Speed, Daniels VDOT, and course-aware splits.
              </p>
            </div>

            <div className="space-y-3 pt-2">
              <div>
                <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                  What should the coach call you?
                </label>
                <div className="relative">
                  <User className="absolute left-3.5 top-3 h-4 w-4 text-[#8E8E93]" />
                  <input
                    type="text"
                    value={athleteName}
                    onChange={(e) => setAthleteName(e.target.value)}
                    placeholder="e.g. Ephraim"
                    className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E]/80 py-2.5 pl-10 pr-4 text-xs text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                  Email (Optional for Demo Mode)
                </label>
                <input
                  type="email"
                  value={athleteEmail}
                  onChange={(e) => setAthleteEmail(e.target.value)}
                  placeholder="runner@example.com"
                  className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E]/80 py-2.5 px-4 text-xs text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                />
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#2C2C2E]/40 p-3.5 space-y-2 text-xs text-[#8E8E93]">
                <div className="flex items-center gap-2 text-[#30D158]">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span className="font-semibold text-white">Authentic Apple Dark Mode UI</span>
                </div>
                <div className="flex items-center gap-2 text-[#30D158]">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span className="font-semibold text-white">Private per-user data sandbox</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 2: ATHLETIC BASELINE ── */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="text-center space-y-1">
              <h2 id="onboarding-title" className="text-xl font-bold tracking-tight text-white">
                Establish Your Fitness Baseline
              </h2>
              <p className="text-xs text-[#8E8E93]">
                Calibrates your Critical Speed, Daniels VDOT, and pace zones.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setBaselineType('manual')}
                className={`rounded-2xl border p-3.5 text-left transition-all ${
                  baselineType === 'manual'
                    ? 'border-[#0A84FF] bg-[#0A84FF]/15'
                    : 'border-white/10 bg-[#2C2C2E]/60 hover:bg-[#2C2C2E]'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <Activity className="h-4 w-4 text-[#0A84FF]" />
                  {baselineType === 'manual' && <CheckCircle2 className="h-4 w-4 text-[#0A84FF]" />}
                </div>
                <div className="font-bold text-xs text-white">Recent Race Time</div>
                <div className="text-[11px] text-[#8E8E93] mt-0.5">Enter a recent 5K, Mile, or 10K PR</div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setBaselineType('garmin');
                  onOpenGarmlinkSync();
                }}
                className={`rounded-2xl border p-3.5 text-left transition-all ${
                  baselineType === 'garmin'
                    ? 'border-[#30D158] bg-[#30D158]/15'
                    : 'border-white/10 bg-[#2C2C2E]/60 hover:bg-[#2C2C2E]'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <Watch className="h-4 w-4 text-[#30D158]" />
                  {baselineType === 'garmin' && <CheckCircle2 className="h-4 w-4 text-[#30D158]" />}
                </div>
                <div className="font-bold text-xs text-white">Connect Garmin</div>
                <div className="text-[11px] text-[#8E8E93] mt-0.5">Link watch via Garmlink (48 tools)</div>
              </button>
            </div>

            {baselineType === 'manual' && (
              <div className="rounded-2xl border border-white/10 bg-[#2C2C2E]/60 p-4 space-y-3">
                <div className="flex gap-2">
                  {(['1600m', '5K', '10K'] as const).map((dist) => (
                    <button
                      key={dist}
                      type="button"
                      onClick={() => setManualDistance(dist)}
                      className={`flex-1 rounded-xl py-1.5 text-xs font-semibold transition-all ${
                        manualDistance === dist
                          ? 'bg-[#0A84FF] text-white shadow-sm'
                          : 'bg-white/5 text-[#8E8E93] hover:text-white'
                      }`}
                    >
                      {dist}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="block text-[10px] font-semibold text-[#8E8E93] uppercase mb-1">
                      Minutes
                    </label>
                    <input
                      type="number"
                      min={3}
                      max={90}
                      value={manualMinutes}
                      onChange={(e) => setManualMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full rounded-xl border border-white/10 bg-black/40 py-2 px-3 font-mono text-center text-sm font-bold text-white focus:border-[#0A84FF] focus:outline-none"
                    />
                  </div>
                  <span className="text-xl font-bold text-slate-500 pt-4">:</span>
                  <div className="flex-1">
                    <label className="block text-[10px] font-semibold text-[#8E8E93] uppercase mb-1">
                      Seconds
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={manualSeconds}
                      onChange={(e) => setManualSeconds(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                      className="w-full rounded-xl border border-white/10 bg-black/40 py-2 px-3 font-mono text-center text-sm font-bold text-white focus:border-[#0A84FF] focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 3: TARGET RACE & MILEAGE ── */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="text-center space-y-1">
              <h2 id="onboarding-title" className="text-xl font-bold tracking-tight text-white">
                Select Your Goal Race & Volume
              </h2>
              <p className="text-xs text-[#8E8E93]">
                Pins your race day and calibrates pre-race taper workouts.
              </p>
            </div>

            <div className="space-y-3 pt-1">
              <div>
                <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                  Target Race Course
                </label>
                <select
                  value={selectedCourseId}
                  onChange={(e) => setSelectedCourseId(e.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E] py-2.5 px-3 text-xs text-white focus:border-[#0A84FF] focus:outline-none"
                >
                  {PRESET_COURSES.map((c) => (
                    <option key={c.course_id} value={c.course_id}>
                      {c.name} ({c.distance_label})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1 text-xs">
                  <span className="text-[#8E8E93] font-semibold">Weekly Training Target</span>
                  <span className="font-mono font-bold text-white">{weeklyMileage} mpw</span>
                </div>
                <input
                  type="range"
                  min={15}
                  max={70}
                  step={5}
                  value={weeklyMileage}
                  onChange={(e) => setWeeklyMileage(parseInt(e.target.value))}
                  className="w-full accent-[#0A84FF] cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-[#8E8E93] font-mono mt-1">
                  <span>15 mpw (Base)</span>
                  <span>35 mpw (Mid)</span>
                  <span>70 mpw (Elite)</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Navigation Buttons */}
        <div className="mt-6 flex items-center justify-between gap-3 pt-4 border-t border-white/10">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s - 1) as any)}
              className="rounded-2xl border border-white/10 bg-[#2C2C2E] px-4 py-2.5 text-xs font-semibold text-[#8E8E93] hover:text-white transition-colors"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl px-3 py-2.5 text-xs font-semibold text-[#8E8E93] hover:text-white transition-colors"
            >
              Skip for now
            </button>
          )}

          <button
            type="button"
            onClick={handleNext}
            className="inline-flex items-center gap-2 rounded-2xl bg-[#0A84FF] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#0071E3] transition-all active:scale-[0.99] shadow-md shadow-[#0A84FF]/20"
          >
            <span>{step === 3 ? 'Launch RaceKit Dashboard' : 'Continue'}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
