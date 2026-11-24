import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  Flame,
  KeyRound,
  Lock,
  Sparkles,
  Trophy,
  Unlock,
  User,
  X,
  Zap,
} from 'lucide-react';
import { PredictionEngine } from '../lib/predictionEngine';
import type { Effort, RunnerProfile, TrainingFocusId } from '../lib/types';

interface RunnerProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: RunnerProfile;
  efforts?: Effort[];
  onSaveProfile: (updated: RunnerProfile, passcode?: string) => void;
  isOwnerUnlocked: boolean;
  onToggleOwnerLock: (passcode: string) => boolean;
  /** Display name of the signed-in user (prefills Athlete Name instead of "Guest Runner") */
  signedInName?: string | null;
}

const BENCHMARK_PRESETS = [
  { label: '5K', distM: 5000, defaultMin: 22, defaultSec: 30 },
  { label: '1 Mile', distM: 1609.344, defaultMin: 6, defaultSec: 15 },
  { label: '1600m', distM: 1600, defaultMin: 6, defaultSec: 10 },
  { label: '3200m', distM: 3200, defaultMin: 13, defaultSec: 30 },
  { label: '10K', distM: 10000, defaultMin: 47, defaultSec: 0 },
  { label: 'Half Marathon', distM: 21097.5, defaultMin: 105, defaultSec: 0 },
];

const FOCUS_OPTIONS: Array<{ id: TrainingFocusId; title: string; desc: string }> = [
  { id: 'track_mid', title: 'Track Mid-Distance', desc: '800m / 1600m / Mile speed & aerobic balance' },
  { id: 'track_long', title: 'Track Long-Distance', desc: '3200m / 5K track endurance & sustained tempo' },
  { id: 'xc', title: 'Cross Country', desc: '5K / 8K terrain resilience & anaerobic tolerance' },
  { id: 'half_marathon', title: 'Half Marathon', desc: 'Threshold cruise intervals & long aerobic runs' },
  { id: 'base_building', title: 'Base Building', desc: 'Pure low-aerobic Zone 2 mitochondrial capacity' },
];

export function RunnerProfileModal({
  isOpen,
  onClose,
  profile,
  efforts = [],
  onSaveProfile,
  isOwnerUnlocked,
  onToggleOwnerLock,
  signedInName,
}: RunnerProfileModalProps) {
  const isPlaceholderName = !profile.name || profile.name === 'Guest Runner' || profile.name === 'Runner';
  const [name, setName] = useState(
    isPlaceholderName && signedInName ? signedInName : profile.name || 'Runner'
  );
  // Prefill from the signed-in user's display name whenever the profile still has the guest placeholder
  useEffect(() => {
    if (isOpen && isPlaceholderName && signedInName) setName(signedInName);
  }, [isOpen, isPlaceholderName, signedInName]);
  const [units, setUnits] = useState<'mi' | 'km'>(profile.units || 'mi');
  const [selectedPresetLabel, setSelectedPresetLabel] = useState(profile.benchmark_label || '5K');

  const initialTimeS = profile.benchmark_time_s || 1350;
  const [min, setMin] = useState(Math.floor(initialTimeS / 60));
  const [sec, setSec] = useState(initialTimeS % 60);

  // Cache user-adjusted or distance-specific times during session
  const [customTimes, setCustomTimes] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    if (profile.benchmark_label && profile.benchmark_time_s) {
      initial[profile.benchmark_label] = profile.benchmark_time_s;
    }
    return initial;
  });

  // Re-sync when modal opens or profile changes
  useEffect(() => {
    if (isOpen) {
      const bTime = profile.benchmark_time_s || 1350;
      const bLabel = profile.benchmark_label || '5K';
      setSelectedPresetLabel(bLabel);
      setMin(Math.floor(bTime / 60));
      setSec(bTime % 60);
      setCustomTimes((prev) => ({
        ...prev,
        [bLabel]: bTime,
      }));
    }
  }, [isOpen, profile.benchmark_time_s, profile.benchmark_label]);

  const [weeklyMiles, setWeeklyMiles] = useState(profile.weekly_miles || 25);
  const [primaryFocus, setPrimaryFocus] = useState<TrainingFocusId>(profile.primary_focus || 'track_mid');

  // Passcode state
  const [passcode, setPasscode] = useState('');
  const [passcodeError, setPasscodeError] = useState('');
  const [showPasscodeField, setShowPasscodeField] = useState(false);

  // Compute distance for currently selected preset
  const currentDistM = useMemo(() => {
    const preset = BENCHMARK_PRESETS.find((p) => p.label === selectedPresetLabel);
    return preset ? preset.distM : 5000;
  }, [selectedPresetLabel]);

  // Total seconds
  const totalSeconds = useMemo(() => {
    return Math.max(1, min * 60 + sec);
  }, [min, sec]);

  // Live VDOT and Paces computation
  const liveFitness = useMemo(() => {
    const dummyEffort: Effort = {
      id: 'benchmark-effort',
      distance_m: currentDistM,
      time_s: totalSeconds,
      date: new Date().toISOString().split('T')[0],
      source: 'benchmark',
      label: selectedPresetLabel,
    };
    try {
      const engine = new PredictionEngine([dummyEffort], null, {
        longest_run_miles: Math.round(weeklyMiles * 0.35),
        avg_weekly_miles: weeklyMiles,
      });
      const zones = engine.getTrainingZones();
      const vdot = engine.effectiveVdot ?? Math.round(54.6);
      return {
        vdot: Number(vdot.toFixed(1)),
        easyPace: zones.easy.label,
        thresholdPace: zones.threshold.label,
        intervalPace: zones.interval.label,
      };
    } catch {
      return {
        vdot: 50.0,
        easyPace: '8:00–8:40/mi',
        thresholdPace: '6:40–6:55/mi',
        intervalPace: '6:05–6:20/mi',
      };
    }
  }, [currentDistM, totalSeconds, selectedPresetLabel, weeklyMiles]);

  if (!isOpen) return null;

  const handleMinChange = (val: number) => {
    const m = Math.max(0, val);
    setMin(m);
    setCustomTimes((prev) => ({
      ...prev,
      [selectedPresetLabel]: m * 60 + sec,
    }));
  };

  const handleSecChange = (val: number) => {
    const s = Math.min(59, Math.max(0, val));
    setSec(s);
    setCustomTimes((prev) => ({
      ...prev,
      [selectedPresetLabel]: min * 60 + s,
    }));
  };

  const handleSelectPreset = (p: typeof BENCHMARK_PRESETS[0]) => {
    // 1. If previously entered or saved in customTimes for this session:
    let targetSeconds = customTimes[p.label];

    // 2. If it matches the profile's saved benchmark:
    if (!targetSeconds && profile.benchmark_label === p.label && profile.benchmark_time_s) {
      targetSeconds = profile.benchmark_time_s;
    }

    // 3. Look up existing saved PR in efforts for this distance:
    if (!targetSeconds && efforts && efforts.length > 0) {
      const matchingEfforts = efforts.filter((e) => {
        if (e.label && e.label.toLowerCase() === p.label.toLowerCase()) return true;
        if (p.distM && Math.abs(e.distance_m - p.distM) < 25) return true;
        return false;
      });
      if (matchingEfforts.length > 0) {
        const best = Math.min(...matchingEfforts.map((e) => e.time_s));
        if (best > 0) {
          targetSeconds = best;
        }
      }
    }

    // 4. Derive sensible time from the runner's current PR/VDOT/prediction state for that exact distance:
    if (!targetSeconds) {
      try {
        const dummyEffort: Effort = {
          id: 'benchmark-effort',
          distance_m: currentDistM,
          time_s: totalSeconds,
          date: new Date().toISOString().split('T')[0],
          source: 'benchmark',
          label: selectedPresetLabel,
        };
        const allEfforts = [dummyEffort, ...(efforts ?? [])];
        const engine = new PredictionEngine(allEfforts, null, {
          longest_run_miles: Math.round(weeklyMiles * 0.35),
          avg_weekly_miles: weeklyMiles,
        });
        const pred = engine.predictBase(p.distM, p.label);
        if (pred && pred.time_s > 0) {
          targetSeconds = Math.round(pred.time_s);
        }
      } catch {
        // Fall through
      }
    }

    // 5. Fallback only if no runner PR/VDOT data is available:
    if (!targetSeconds || targetSeconds <= 0) {
      targetSeconds = p.defaultMin * 60 + p.defaultSec;
    }

    const s = Math.round(targetSeconds);
    const m = Math.floor(s / 60);
    const remSec = s % 60;

    setSelectedPresetLabel(p.label);
    setMin(m);
    setSec(remSec);
    setCustomTimes((prev) => ({
      ...prev,
      [p.label]: s,
    }));
  };

  const handleUnlockPasscode = (e: React.FormEvent) => {
    e.preventDefault();
    setPasscodeError('');
    const success = onToggleOwnerLock(passcode.trim());
    if (!success) {
      setPasscodeError('Invalid Owner Passcode. (Passcode required for personal Garmin MCP link)');
    } else {
      setPasscode('');
      setShowPasscodeField(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const timeFmt = `${min}:${sec.toString().padStart(2, '0')}`;
    const updated: RunnerProfile = {
      name: name.trim() || 'Runner',
      units,
      benchmark_dist_m: currentDistM,
      benchmark_label: selectedPresetLabel,
      benchmark_time_s: totalSeconds,
      benchmark_time_fmt: timeFmt,
      vdot: liveFitness.vdot,
      weekly_miles: weeklyMiles,
      primary_focus: primaryFocus,
      is_owner: isOwnerUnlocked,
      onboarded: true,
    };
    onSaveProfile(updated, passcode.trim() || undefined);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* iOS Apple Dark Mode Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity"
        onClick={profile.onboarded ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal Dialog */}
      <div className="relative z-10 w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 text-white shadow-2xl sm:p-8">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#0A84FF]/20 text-[#0A84FF]">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-white">Runner Profile &amp; Fitness</h2>
              <p className="text-xs text-[#8E8E93]">Personalized paces, Daniels VDOT, and multi-user preferences</p>
            </div>
          </div>
          {profile.onboarded && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1.5 text-[#8E8E93] hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          {/* Athlete Name & Units */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2 space-y-1.5">
              <label htmlFor="runner-name" className="text-xs font-semibold text-[#8E8E93] uppercase tracking-wider">
                Athlete Name
              </label>
              <input
                id="runner-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Ephraim, Sarah, Alex"
                className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3.5 py-2.5 text-sm font-semibold text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8E8E93] uppercase tracking-wider">
                Units
              </label>
              <div className="flex rounded-xl border border-white/10 bg-[#2C2C2E] p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setUnits('mi')}
                  className={`flex-1 rounded-lg py-1.5 transition-colors ${
                    units === 'mi' ? 'bg-[#0A84FF] text-white shadow-sm' : 'text-[#8E8E93] hover:text-white'
                  }`}
                >
                  Miles (mi)
                </button>
                <button
                  type="button"
                  onClick={() => setUnits('km')}
                  className={`flex-1 rounded-lg py-1.5 transition-colors ${
                    units === 'km' ? 'bg-[#0A84FF] text-white shadow-sm' : 'text-[#8E8E93] hover:text-white'
                  }`}
                >
                  Kilometers (km)
                </button>
              </div>
            </div>
          </div>

          {/* Benchmark Race / Time Trial Performance */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[#8E8E93] uppercase tracking-wider flex items-center gap-1.5">
                <Trophy className="h-3.5 w-3.5 text-[#FF9F0A]" />
                Recent Benchmark Performance (PR or Time Trial)
              </label>
              <span className="text-[11px] text-[#8E8E93]">Calculates your true VDOT &amp; zones</span>
            </div>

            {/* Presets Grid */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {BENCHMARK_PRESETS.map((p) => {
                const active = selectedPresetLabel === p.label;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => handleSelectPreset(p)}
                    className={`rounded-xl border py-2 text-center text-xs font-bold transition-all ${
                      active
                        ? 'border-[#0A84FF] bg-[#0A84FF]/20 text-[#0A84FF]'
                        : 'border-white/10 bg-[#2C2C2E] text-[#8E8E93] hover:border-white/20 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            {/* Time Inputs */}
            <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#2C2C2E] p-3">
              <div className="flex-1 flex items-center gap-2">
                <span className="text-xs font-semibold text-[#8E8E93]">Time:</span>
                <div className="flex items-center gap-1.5 font-mono">
                  <input
                    type="number"
                    min="1"
                    max="300"
                    value={min}
                    onChange={(e) => handleMinChange(parseInt(e.target.value) || 0)}
                    className="w-16 rounded-lg border border-white/10 bg-[#1C1C1E] px-2 py-1.5 text-center text-sm font-bold text-white focus:border-[#0A84FF] focus:outline-none"
                  />
                  <span className="text-[#8E8E93] font-bold">:</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={sec.toString().padStart(2, '0')}
                    onChange={(e) => handleSecChange(parseInt(e.target.value) || 0)}
                    className="w-14 rounded-lg border border-white/10 bg-[#1C1C1E] px-2 py-1.5 text-center text-sm font-bold text-white focus:border-[#0A84FF] focus:outline-none"
                  />
                </div>
                <span className="text-xs text-[#8E8E93]">(mm:ss)</span>
              </div>

              {/* VDOT Badge */}
              <div className="flex items-center gap-2 rounded-xl bg-[#0A84FF]/15 border border-[#0A84FF]/30 px-3 py-1.5">
                <Sparkles className="h-3.5 w-3.5 text-[#0A84FF]" />
                <span className="text-xs font-bold text-[#0A84FF] font-mono">
                  VDOT {liveFitness.vdot}
                </span>
              </div>
            </div>

            {/* Live Calculated Paces Preview */}
            <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-[#2C2C2E]/60 p-3 text-xs">
              <div>
                <div className="text-[10px] uppercase font-semibold text-[#8E8E93]">Easy (Zone 2)</div>
                <div className="mt-0.5 font-mono font-bold text-[#30D158]">{liveFitness.easyPace}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-[#8E8E93]">Threshold (Tempo)</div>
                <div className="mt-0.5 font-mono font-bold text-[#FF9F0A]">{liveFitness.thresholdPace}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-[#8E8E93]">Interval (VO2)</div>
                <div className="mt-0.5 font-mono font-bold text-[#FF453A]">{liveFitness.intervalPace}</div>
              </div>
            </div>
          </div>

          {/* Weekly Mileage & Training Focus */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-[#8E8E93] uppercase tracking-wider">
                  Target Weekly Mileage
                </label>
                <span className="font-mono text-xs font-bold text-white">{weeklyMiles} mi / week</span>
              </div>
              <input
                type="range"
                min="10"
                max="80"
                step="5"
                value={weeklyMiles}
                onChange={(e) => setWeeklyMiles(parseInt(e.target.value) || 25)}
                className="w-full accent-[#0A84FF] bg-white/10 rounded-lg cursor-pointer h-2"
              />
              <div className="flex justify-between text-[10px] text-[#8E8E93] font-mono">
                <span>10 mi</span>
                <span>35 mi</span>
                <span>80 mi</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8E8E93] uppercase tracking-wider">
                Primary Focus
              </label>
              <select
                value={primaryFocus}
                onChange={(e) => setPrimaryFocus(e.target.value as TrainingFocusId)}
                aria-label="Primary Focus"
                className="w-full rounded-xl border border-white/10 bg-[#2C2C2E] px-3 py-2 text-xs font-semibold text-white focus:border-[#0A84FF] focus:outline-none"
              >
                {FOCUS_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id} className="bg-[#1C1C1E] text-white">
                    {opt.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Owner Mode / Passcode Section */}
          <div className="rounded-2xl border border-white/10 bg-[#2C2C2E]/40 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isOwnerUnlocked ? (
                  <Unlock className="h-4 w-4 text-[#30D158]" />
                ) : (
                  <Lock className="h-4 w-4 text-[#8E8E93]" />
                )}
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    {isOwnerUnlocked ? 'Owner Mode Active' : 'Guest Mode (Safe & Private)'}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        isOwnerUnlocked
                          ? 'bg-[#30D158]/20 text-[#30D158]'
                          : 'bg-white/10 text-[#8E8E93]'
                      }`}
                    >
                      {isOwnerUnlocked ? 'Garmin MCP Synced' : 'Clean Slate'}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8E8E93]">
                    {isOwnerUnlocked
                      ? 'Connected to Garmin watch data. Dover runs and health metrics are unlocked.'
                      : 'Visitors and guests use their own customized paces and personal watch telemetry.'}
                  </p>
                </div>
              </div>

              {!isOwnerUnlocked && !showPasscodeField && (
                <button
                  type="button"
                  onClick={() => setShowPasscodeField(true)}
                  className="rounded-xl border border-white/10 bg-[#1C1C1E] px-3 py-1.5 text-xs font-semibold text-[#8E8E93] hover:text-white transition-colors"
                >
                  Enter Owner Code
                </button>
              )}
            </div>

            {showPasscodeField && !isOwnerUnlocked && (
              <div className="pt-2 border-t border-white/10 flex items-center gap-2">
                <input
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Enter 4-digit Owner Passcode"
                  className="flex-1 rounded-xl border border-white/10 bg-[#1C1C1E] px-3 py-1.5 text-xs font-mono text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleUnlockPasscode}
                  className="rounded-xl bg-[#0A84FF] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#0A84FF]/80 transition-colors"
                >
                  Unlock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowPasscodeField(false);
                    setPasscodeError('');
                  }}
                  className="rounded-xl px-2 py-1.5 text-xs text-[#8E8E93] hover:text-white"
                >
                  Cancel
                </button>
              </div>
            )}

            {passcodeError && (
              <p className="text-[11px] text-[#FF453A] font-semibold">{passcodeError}</p>
            )}
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex items-center justify-end gap-3">
            {profile.onboarded && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-[#8E8E93] hover:bg-white/10 hover:text-white transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className="rounded-xl bg-[#0A84FF] px-6 py-2.5 text-xs font-bold text-white hover:bg-[#0A84FF]/80 transition-all shadow-md shadow-[#0A84FF]/20"
            >
              {profile.onboarded ? 'Save Changes' : 'Start Training with RaceKit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
