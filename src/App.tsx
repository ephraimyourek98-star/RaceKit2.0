import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BatteryCharging,
  CalendarDays,
  CheckCircle2,
  Gauge,
  Link2,
  Menu,
  MessageSquareText,
  RefreshCw,
  User,
  Watch,
  X,
} from 'lucide-react';
import { AiCoachView } from './components/AiCoachView';
import { AuthModal } from './components/AuthModal';
import { OnboardingModal } from './components/OnboardingModal';
import { RacePredictorView } from './components/RacePredictorView';
import { RunnerProfileModal } from './components/RunnerProfileModal';
import { TrainingPlanView } from './components/TrainingPlanView';
import { WatchSyncView } from './components/WatchSyncView';
import { PredictionEngine, normalizeSurface } from './lib/predictionEngine';
import { PhysiologyEngine, fitCriticalSpeed } from './lib/physiologyEngine';
import {
  getCurrentUser,
  signOutUser,
  type UserProfile,
  loadUserWorkouts,
  saveUserWorkouts,
  loadUserTargetRace,
  saveUserTargetRace,
  loadUserPRs,
  saveUserPRs,
  loadUserTelemetry,
  saveUserTelemetry,
} from './lib/supabaseClient';
import {
  DEFAULT_GARMLINK_ACTIVITIES,
  DEFAULT_GARMLINK_HEALTH,
  PRESET_COURSES,
  VERIFIED_PR_EFFORTS,
} from './lib/seedData';
import {
  DAYS_OF_WEEK,
  TRAINING_FOCUS_LABELS,
  enforceRecoveryGate,
  filterRemainingSchedule,
  finalizePlanSchedule,
  generateTrainingPlan,
  getTodayDayName,
  normalizeDayName,
  parseDayTargetedPrompt,
  slicePlanToRemainingDays,
} from './lib/trainingPlans';
import { computeVolumeFromActivities } from './lib/watchData';
import type {
  CoachMessage,
  CourseConditions,
  DailyWorkout,
  Effort,
  GarmlinkSyncMeta,
  HealthSnapshot,
  RaceWeatherSync,
  RunnerProfile,
  TrainingFocusId,
  TrainingPlan,
  WatchActivity,
  WorkoutType,
} from './lib/types';
import type { GarmlinkHistoryDay } from './lib/watchData';

type ActiveTab = 'watch' | 'plan' | 'predictor' | 'coach';

interface ToastItem {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

const STORAGE_KEY = 'racekit_state_v7';
const HEALTH_HISTORY_KEY = 'racekit_garmlink_health_history_v1';

function getDefaultRaceDate(): string {
  // Run for Pie 5K takes place on Thanksgiving Day: Thursday, Nov 26, 2026
  return '2026-11-26';
}

function loadPersistedState() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem('racekit_state_v6');
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{
      health: HealthSnapshot | null;
      efforts: Effort[];
      activities: WatchActivity[];
      planFocus: TrainingFocusId;
      aiGeneratedPlan: TrainingPlan | null;
      targetRace: { name: string; dist: string; day: string } | null;
      adaptedDays: Record<string, DailyWorkout>;
      adaptedDaysByFocus: Record<TrainingFocusId, Record<string, DailyWorkout>>;
      customizedDays: Record<string, DailyWorkout>;
      raceDate: string;
      raceTime: string;
    }>;

    if (parsed.aiGeneratedPlan && Array.isArray(parsed.aiGeneratedPlan.schedule)) {
      const sliced = slicePlanToRemainingDays(parsed.aiGeneratedPlan, getTodayDayName());
      parsed.aiGeneratedPlan = { ...parsed.aiGeneratedPlan, ...sliced };
    }

    // Correct any stale race date that was pointing to Monday 2026-11-23 instead of Thursday 2026-11-26
    if (!parsed.raceDate || parsed.raceDate === '2026-11-23' || parsed.raceDate < '2026-11-26') {
      parsed.raceDate = '2026-11-26';
    }
    if (parsed.targetRace) {
      if (
        parsed.targetRace.day === 'Monday' ||
        parsed.targetRace.name.toLowerCase().includes('pie')
      ) {
        parsed.targetRace.day = 'Thursday';
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export default function App() {
  const persisted = useMemo(() => loadPersistedState(), []);

  const [activeTab, setActiveTab] = useState<ActiveTab>('watch');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Multi-user & Owner Passcode State (passcode "1126" unlocks personal Garmin MCP data)
  const [ownerPasscode, setOwnerPasscode] = useState<string>(() => {
    try {
      return localStorage.getItem('racekit_owner_passcode') || '';
    } catch {
      return '';
    }
  });
  const isOwnerUnlocked = ownerPasscode === '1126';

  const [runnerProfile, setRunnerProfile] = useState<RunnerProfile>(() => {
    try {
      const raw = localStorage.getItem('racekit_runner_profile');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (isOwnerUnlocked || parsed.name !== 'Ephraim')) {
          return parsed;
        }
      }
    } catch {}
    return {
      name: isOwnerUnlocked ? 'Ephraim' : 'Guest Runner',
      units: 'mi',
      benchmark_dist_m: 5000,
      benchmark_label: '5K',
      benchmark_time_s: 1144.75,
      benchmark_time_fmt: '19:05',
      vdot: 54.6,
      weekly_miles: 25,
      primary_focus: 'track_mid',
      is_owner: isOwnerUnlocked,
      onboarded: isOwnerUnlocked,
    };
  });
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => {
    try {
      const raw = localStorage.getItem('racekit_active_session');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [onboardingModalOpen, setOnboardingModalOpen] = useState(false);

  // Core athlete state — sourced from Garmlink MCP & verified PRs
  const [efforts, setEfforts] = useState<Effort[]>(() => {
    try {
      const rawSession = localStorage.getItem('racekit_active_session');
      if (rawSession) {
        const user = JSON.parse(rawSession);
        if (user?.id) {
          const uPrs = loadUserPRs(user.id);
          if (uPrs && uPrs.length > 0) return uPrs;
        }
      }
    } catch {}
    if (isOwnerUnlocked || localStorage.getItem('racekit_active_session')) {
      return persisted?.efforts ?? VERIFIED_PR_EFFORTS;
    }
    return [];
  });
  const [health, setHealth] = useState<HealthSnapshot | null>(() => {
    try {
      const rawSession = localStorage.getItem('racekit_active_session');
      if (rawSession) {
        const user = JSON.parse(rawSession);
        if (user?.id) {
          const uTelem = loadUserTelemetry(user.id);
          if (uTelem?.health) return uTelem.health;
        }
      }
    } catch {}
    if (isOwnerUnlocked || localStorage.getItem('racekit_active_session')) {
      if (
        persisted?.health &&
        persisted.health.source === 'garmlink_mcp' &&
        persisted.health.date >= '2026-11-23'
      ) {
        return persisted.health;
      }
      return DEFAULT_GARMLINK_HEALTH;
    }
    return null;
  });
  // Live per-night Garmlink history (sleep + HRV) returned by Sync Watch for the 30-day charts
  const [healthHistory, setHealthHistory] = useState<GarmlinkHistoryDay[]>(() => {
    try {
      const raw = localStorage.getItem(HEALTH_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [activities, setActivities] = useState<WatchActivity[]>(() => {
    try {
      const rawSession = localStorage.getItem('racekit_active_session');
      if (rawSession) {
        const user = JSON.parse(rawSession);
        if (user?.id) {
          const uTelem = loadUserTelemetry(user.id);
          if (uTelem?.activities && uTelem.activities.length > 0) return uTelem.activities;
        }
      }
    } catch {}
    if (isOwnerUnlocked || localStorage.getItem('racekit_active_session')) {
      if (persisted?.activities && persisted.activities.length > 0) {
        const filtered = persisted.activities.filter(
          (a) =>
            !a.name.includes('Newark Easy') &&
            !a.name.includes('Glasgow Park Threshold') &&
            !a.name.includes('White Clay Creek XC')
        );
        if (filtered.length > 0) {
          // Check if persisted activities have valid elevation gains; if not (due to old 0-elevation bug), use default verified activities
          const hasValidElevation = filtered.some((a) => (a.elevation_gain_ft ?? 0) > 0);
          if (hasValidElevation) {
            const defaultsById = new Map(DEFAULT_GARMLINK_ACTIVITIES.map((d) => [d.id, d]));
            return filtered.map((a) => {
              if (!a.elevation_gain_ft || a.elevation_gain_ft === 0) {
                const def = defaultsById.get(a.id);
                if (def && def.elevation_gain_ft > 0) {
                  return { ...a, elevation_gain_ft: def.elevation_gain_ft };
                }
              }
              return a;
            });
          }
        }
      }
      return DEFAULT_GARMLINK_ACTIVITIES;
    }
    return [];
  });

  // Garmlink MCP OAuth session (held strictly in React memory, never in localStorage)
  const [garmlinkSessionToken, setGarmlinkSessionToken] = useState<string | null>(null);
  const garmlinkSessionRef = useRef<string | null>(null);
  garmlinkSessionRef.current = garmlinkSessionToken;

  const [garmlink, setGarmlink] = useState<GarmlinkSyncMeta>({
    connected: false,
    syncing: false,
    last_synced_at: null,
    tools_discovered: [],
    tools_called: [],
    error: null,
  });

  // Race predictor & race-time weather state
  const [selectedDistance, setSelectedDistance] = useState('5K');
  const [selectedCourseId, setSelectedCourseId] = useState('run_for_pie_glasgow');
  const [raceDate, setRaceDate] = useState<string>(persisted?.raceDate ?? getDefaultRaceDate());
  const [raceTime, setRaceTime] = useState<string>(persisted?.raceTime ?? '08:30');
  const [syncedWeather, setSyncedWeather] = useState<RaceWeatherSync | null>(null);
  const [conditions, setConditions] = useState<CourseConditions>({
    elevation_gain_ft: 55,
    elevation_loss_ft: 55,
    surface: 'road',
    altitude_ft: 70,
    temperature_f: 50,
    humidity_pct: 50,
    wind_mph: 0,
    wind_direction: 'mixed',
    shoe_type: 'streakfly',
    use_readiness: Boolean(persisted?.health),
    hrv_status: persisted?.health?.hrv_status ?? 'BALANCED',
    sleep_score: persisted?.health?.sleep_score ?? 80,
    body_battery: persisted?.health?.body_battery ?? 55,
  });

  // Training plan & AI builder state
  const [planFocus, setPlanFocus] = useState<TrainingFocusId>(
    persisted?.planFocus ?? 'track_mid'
  );
  const [aiGeneratedPlan, setAiGeneratedPlan] = useState<TrainingPlan | null>(
    persisted?.aiGeneratedPlan ?? null
  );
  const [targetRace, setTargetRace] = useState<{
    name: string;
    dist: string;
    day: string;
  } | null>(() => {
    if (persisted?.targetRace) return persisted.targetRace;
    const defaultCourse =
      PRESET_COURSES.find((c) => c.course_id === 'run_for_pie_glasgow') ?? PRESET_COURSES[0];
    const d = new Date('2026-11-26T12:00:00');
    const dayName =
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] ||
      'Thursday';
    return {
      name: defaultCourse.name,
      dist: '5K',
      day: dayName,
    };
  });
  const [adaptedDaysByFocus, setAdaptedDaysByFocus] = useState<
    Record<TrainingFocusId, Record<string, DailyWorkout>>
  >(() => {
    if (persisted?.adaptedDaysByFocus) return persisted.adaptedDaysByFocus;
    if (persisted?.adaptedDays && Object.keys(persisted.adaptedDays).length > 0) {
      return { [persisted.planFocus || 'track_mid']: persisted.adaptedDays } as Record<
        TrainingFocusId,
        Record<string, DailyWorkout>
      >;
    }
    return {} as Record<TrainingFocusId, Record<string, DailyWorkout>>;
  });
  const [todayName, setTodayName] = useState<string>(() => getTodayDayName());
  const [customizedDays, setCustomizedDays] = useState<Record<string, DailyWorkout>>(
    () => persisted?.customizedDays ?? {}
  );
  const adaptedDays = adaptedDaysByFocus[planFocus] ?? {};
  const [aiPlanLoading, setAiPlanLoading] = useState(false);

  useEffect(() => {
    const syncToday = () => {
      const current = getTodayDayName();
      setTodayName((prev) => (prev === current ? prev : current));
    };
    window.addEventListener('focus', syncToday);
    document.addEventListener('visibilitychange', syncToday);
    return () => {
      window.removeEventListener('focus', syncToday);
      document.removeEventListener('visibilitychange', syncToday);
    };
  }, []);
  const [aiWorkoutLoading, setAiWorkoutLoading] = useState(false);
  const [aiWorkoutDay, setAiWorkoutDay] = useState<string | null>(null);
  const [aiPlanError, setAiPlanError] = useState<string | null>(null);

  // AI Coach state
  const [coachMessages, setCoachMessages] = useState<CoachMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Ready to tailor workouts, pace targets, and race tapers from your verified Garmin Connect history and ground-truth recovery metrics. Ask me to create a targeted session or adjust your schedule anytime.',
      timestamp: 'Ready',
    },
  ]);
  const [coachSending, setCoachSending] = useState(false);
  const [coachPrefill, setCoachPrefill] = useState<string | null>(null);

  const notify = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-1), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const handleToggleOwnerLock = useCallback(
    (code: string): boolean => {
      if (code === '1126') {
        setOwnerPasscode('1126');
        try {
          localStorage.setItem('racekit_owner_passcode', '1126');
        } catch {}
        setRunnerProfile((prev) => ({
          ...prev,
          is_owner: true,
          onboarded: true,
          name: prev.name === 'Runner' ? 'Ephraim' : prev.name,
        }));
        notify('Owner Mode Unlocked! Connected to Garmin watch telemetry.', 'success');
        return true;
      }
      return false;
    },
    [notify]
  );

  const handleLockGuestMode = useCallback(() => {
    setOwnerPasscode('');
    try {
      localStorage.removeItem('racekit_owner_passcode');
      localStorage.removeItem('racekit_runner_profile');
      localStorage.removeItem('racekit_app_state');
    } catch {}
    setRunnerProfile((prev) => ({
      ...prev,
      name: currentUser?.name || 'Guest Runner',
      is_owner: false,
    }));
    setHealth(null);
    setActivities([]);
    setEfforts([]);
    notify('Returned to Guest Mode. Personal Garmin data locked.', 'info');
  }, [currentUser, notify]);

  const isAthleteActive = Boolean(isOwnerUnlocked || currentUser);
  const resolvedBodyBattery =
    health?.body_battery ??
    health?.bb_highest ??
    health?.bb_at_wake ??
    55;

  const runnerEfforts = useMemo(() => {
    if (isAthleteActive) return efforts;
    if (runnerProfile.benchmark_time_s > 0) {
      return [
        {
          id: 'runner-benchmark-pr',
          distance_m: runnerProfile.benchmark_dist_m || 5000,
          time_s: runnerProfile.benchmark_time_s,
          date: new Date().toISOString().split('T')[0],
          source: 'benchmark_pr',
          label: runnerProfile.benchmark_label || '5K',
        },
      ];
    }
    return efforts;
  }, [isAthleteActive, efforts, runnerProfile]);

  const displayActivities = useMemo(() => {
    return isAthleteActive ? activities : activities.filter((a) => a.source === 'file_import');
  }, [isAthleteActive, activities]);

  // Persist user customizations (excluding any auth tokens)
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          health,
          efforts,
          activities,
          planFocus,
          aiGeneratedPlan,
          targetRace,
          adaptedDays,
          adaptedDaysByFocus,
          customizedDays,
          raceDate,
          raceTime,
        })
      );
    } catch {
      // Ignore storage quota issues
    }
  }, [health, efforts, activities, planFocus, aiGeneratedPlan, targetRace, adaptedDays, adaptedDaysByFocus, customizedDays, raceDate, raceTime]);

  // Keep readiness condition fields synced with real health snapshot (zero made-up metrics)
  useEffect(() => {
    const sleepVal = health?.sleep_score;
    const hrvVal = health?.hrv_last_night;
    if (!health || sleepVal == null || hrvVal == null) {
      // Watch was not worn overnight — disable readiness derating rather than inventing metrics
      setConditions((prev) => ({ ...prev, use_readiness: false }));
      return;
    }
    setConditions((prev) => ({
      ...prev,
      hrv_status:
        health.hrv_last_night != null && health.hrv_last_night < (health.hrv_baseline_low ?? 48)
          ? 'LOW'
          : health.hrv_status,
      sleep_score: sleepVal,
      body_battery: health.body_battery ?? 55,
    }));
  }, [health]);

  // Auto-sync target race into training plan state from active Race Predictor selection
  useEffect(() => {
    const course = PRESET_COURSES.find((c) => c.course_id === selectedCourseId);
    if (!course || selectedCourseId === 'custom') return;
    try {
      const d = new Date(raceDate + 'T12:00:00');
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
      if (dayName) {
        setTargetRace((prev) => {
          if (prev && prev.name === course.name && prev.day === dayName && prev.dist === selectedDistance) {
            return prev;
          }
          return {
            name: course.name,
            dist: selectedDistance,
            day: dayName,
          };
        });
      }
    } catch {
      // Ignore invalid date
    }
  }, [selectedCourseId, selectedDistance, raceDate]);

  // Check if server already has a configured Garmlink token on load
  useEffect(() => {
    let active = true;
    const headers: Record<string, string> = {};
    if (currentUser?.email) headers['x-user-email'] = currentUser.email;
    if (currentUser?.id) headers['x-user-id'] = currentUser.id;
    if (ownerPasscode && isOwnerUnlocked) headers['x-owner-passcode'] = ownerPasscode;
    headers['x-is-owner'] = '1';

    fetch('/api/garmlink/status', { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { connected?: boolean; tools_discovered?: string[] } | null) => {
        if (active && data?.connected) {
          setGarmlink((prev) => ({
            ...prev,
            connected: true,
            tools_discovered: data.tools_discovered ?? [],
          }));
        }
      })
      .catch(() => {
        // Ignore startup check failure
      });
    return () => {
      active = false;
    };
  }, [currentUser?.email, currentUser?.id, ownerPasscode, isOwnerUnlocked]);

  // Fetch freshest verified activities with real elevation gains on mount
  useEffect(() => {
    let active = true;
    const headers: Record<string, string> = {};
    if (currentUser?.email) headers['x-user-email'] = currentUser.email;
    if (currentUser?.id) headers['x-user-id'] = currentUser.id;
    if (ownerPasscode && isOwnerUnlocked) headers['x-owner-passcode'] = ownerPasscode;
    headers['x-is-owner'] = '1';

    fetch('/api/garmlink/activities', { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: WatchActivity[] | null) => {
        if (active && Array.isArray(data) && data.length > 0) {
          setActivities((prev) => {
            const importedFiles = prev.filter((a) => a.source === 'file_import');
            const byId = new Map<string, WatchActivity>();
            for (const a of [...data, ...importedFiles]) byId.set(a.id, a);
            return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
          });
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [currentUser?.email, currentUser?.id, ownerPasscode, isOwnerUnlocked]);

  // Execute real Garmlink MCP sync
  const syncFromGarmlink = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride ?? garmlinkSessionRef.current;
      setGarmlink((prev) => ({ ...prev, syncing: true, error: null }));
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (ownerPasscode && isOwnerUnlocked) headers['x-owner-passcode'] = ownerPasscode;
        if (currentUser?.email) headers['x-user-email'] = currentUser.email;
        if (currentUser?.id) headers['x-user-id'] = currentUser.id;
        headers['x-is-owner'] = '1';

        const res = await fetch('/api/garmlink/sync', { method: 'POST', headers });
        const data = (await res.json()) as {
          activities?: WatchActivity[];
          prs?: Effort[];
          health?: HealthSnapshot | null;
          health_history?: GarmlinkHistoryDay[];
          sync_source?: 'garmlink_live' | 'local_bridge' | 'none';
          session_expired?: boolean;
          tools_discovered?: string[];
          tools_called?: string[];
          warnings?: string[];
          synced_at?: string;
          error?: string;
        };

        if (!res.ok) {
          if (res.status === 401) {
            setGarmlinkSessionToken(null);
            setGarmlink((prev) => ({ ...prev, connected: false }));
          }
          throw new Error(data.error || `Garmlink sync failed (HTTP ${res.status})`);
        }

        const syncedActs = data.activities ?? [];
        if (syncedActs.length > 0) {
          setActivities((prev) => {
            const importedFiles = prev.filter((a) => a.source === 'file_import');
            const byId = new Map<string, WatchActivity>();
            for (const a of [...syncedActs, ...importedFiles]) byId.set(a.id, a);
            return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
          });
        }

        if (data.health) {
          setHealth(data.health);
        }

        // Live sync returns every measured night (60-day window); the local-cache branch does not,
        // so clear it there and let the Watch tab fall back to the bridge history endpoint.
        const isLiveSync = data.sync_source === 'garmlink_live';
        const liveHistory = isLiveSync && Array.isArray(data.health_history) ? data.health_history : [];
        setHealthHistory(liveHistory);
        try {
          if (liveHistory.length > 0) localStorage.setItem(HEALTH_HISTORY_KEY, JSON.stringify(liveHistory));
          else localStorage.removeItem(HEALTH_HISTORY_KEY);
        } catch {
          // storage unavailable — charts still render from state
        }

        if (data.prs && data.prs.length > 0) {
          setEfforts((prev) => {
            const byKey = new Map<string, Effort>();
            const getPrKey = (e: Effort) => {
              const l = e.label.toLowerCase().trim();
              if (l === 'mile' || l === '1 mile' || Math.abs(e.distance_m - 1609.344) < 1) return '1_mile';
              return l;
            };
            for (const e of prev) {
              const normalized = e.label.toLowerCase() === 'mile' ? { ...e, label: '1 Mile' } : e;
              byKey.set(getPrKey(e), normalized);
            }
            for (const pr of data.prs!) {
              const normalized = pr.label.toLowerCase() === 'mile' ? { ...pr, label: '1 Mile' } : pr;
              byKey.set(getPrKey(pr), normalized);
            }
            return [...byKey.values()].sort((a, b) => a.distance_m - b.distance_m);
          });
        }

        if (currentUser?.id) {
          saveUserTelemetry(currentUser.id, {
            health: data.health ?? null,
            activities: syncedActs.length > 0 ? syncedActs : activities,
          });
          if (data.prs && data.prs.length > 0) {
            saveUserPRs(currentUser.id, data.prs);
          }
        }

        const toolsDiscovered = data.tools_discovered ?? [];
        const isConnected = toolsDiscovered.length > 0 && (syncedActs.length > 0 || Boolean(data.health));

        setGarmlink({
          connected: isConnected,
          syncing: false,
          last_synced_at: data.synced_at ?? new Date().toISOString(),
          tools_discovered: toolsDiscovered,
          tools_called: data.tools_called ?? [],
          error:
            data.warnings && data.warnings.length > 0 && syncedActs.length === 0 && !data.health
              ? `Connected to Garmlink MCP (${toolsDiscovered.length} tools), but no matching activity/health records were returned: ${data.warnings[0]}`
              : null,
        });

        if (isConnected && isLiveSync) {
          notify(
            `Live Garmlink sync: ${syncedActs.length} activities, ${liveHistory.length} nights of sleep/HRV${
              data.health?.readiness ? ', readiness' : ''
            }${data.health?.garmin_race_predictions ? ', race forecast' : ''} (${
              (data.tools_called ?? []).length
            } endpoints).`,
            'success'
          );
          if (data.warnings && data.warnings.length > 0) {
            notify(`${data.warnings.length} Garmlink endpoint(s) failed: ${data.warnings[0]}`, 'info');
          }
        } else if (isConnected) {
          notify(
            `Synced ${syncedActs.length} runs from the LOCAL Garmin cache, not live Garmlink. ${
              data.session_expired ? 'Your Garmlink session expired — ' : ''
            }Click Connect Garmlink for live readiness, SpO2, race forecast, zones & full sleep/HRV history.`,
            'info'
          );
        } else if (data.warnings && data.warnings.length > 0) {
          notify(data.warnings[0], 'info');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Garmlink MCP sync failed';
        setGarmlink((prev) => ({ ...prev, syncing: false, error: msg }));
        notify(msg, 'error');
      }
    },
    [notify]
  );

  const handledGarmlinkTokensRef = useRef<Set<string>>(new Set());
  const oauthPollTimerRef = useRef<number | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);

  const stopOAuthPolling = useCallback(() => {
    if (oauthPollTimerRef.current !== null) {
      window.clearInterval(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
  }, []);

  const handleGarmlinkAuthorized = useCallback(
    (token: string) => {
      if (!token || handledGarmlinkTokensRef.current.has(token)) return;
      handledGarmlinkTokensRef.current.add(token);
      stopOAuthPolling();

      // Close popup from parent reference as well (helps when COOP prevented popup self-close)
      try {
        if (oauthPopupRef.current && !oauthPopupRef.current.closed) {
          oauthPopupRef.current.close();
        }
      } catch {
        // Ignore cross-origin close restrictions
      }
      oauthPopupRef.current = null;

      setGarmlinkSessionToken(token);
      garmlinkSessionRef.current = token;
      setGarmlink((prev) => ({ ...prev, connected: true, error: null }));
      void syncFromGarmlink(token);
    },
    [stopOAuthPolling, syncFromGarmlink]
  );

  // Listen for Garmlink OAuth popup completion via postMessage AND BroadcastChannel
  useEffect(() => {
    const handlePayload = (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const msg = data as { type?: string; sessionToken?: unknown; error?: unknown };
      if (msg.type === 'GARMLINK_OAUTH_SUCCESS' && typeof msg.sessionToken === 'string') {
        handleGarmlinkAuthorized(msg.sessionToken);
      } else if (msg.type === 'GARMLINK_OAUTH_ERROR') {
        stopOAuthPolling();
        const errMsg = String(msg.error || 'Garmlink OAuth authorization failed.');
        setGarmlink((prev) => ({ ...prev, syncing: false, error: errMsg }));
        notify(errMsg, 'error');
      }
    };

    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        return;
      }
      handlePayload(event.data);
    };

    window.addEventListener('message', handleMessage);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel('racekit_garmlink_oauth');
        channel.onmessage = (event: MessageEvent) => handlePayload(event.data);
      } catch {
        channel = null;
      }
    }

    return () => {
      window.removeEventListener('message', handleMessage);
      if (channel) {
        try {
          channel.close();
        } catch {
          // Ignore close errors
        }
      }
      stopOAuthPolling();
    };
  }, [handleGarmlinkAuthorized, notify, stopOAuthPolling]);

  // Initial mount: pull freshest Garmlink MCP data automatically so page reloads immediately show latest date
  useEffect(() => {
    void syncFromGarmlink();
  }, [syncFromGarmlink]);

  // Initial mount: check authenticated user & restore isolated state
  useEffect(() => {
    void getCurrentUser().then((user) => {
      if (user) {
        setCurrentUser(user);
        const userWorkouts = loadUserWorkouts(user.id, planFocus);
        if (Object.keys(userWorkouts).length > 0) {
          setAdaptedDaysByFocus((prev) => ({
            ...prev,
            [planFocus]: { ...userWorkouts, ...(prev[planFocus] ?? {}) },
          }));
        }
        const userTarget = loadUserTargetRace(user.id);
        if (userTarget) {
          setTargetRace(userTarget);
        }
        const userPRs = loadUserPRs(user.id);
        if (userPRs && userPRs.length > 0) {
          setEfforts(userPRs);
        }
        const userTelemetry = loadUserTelemetry(user.id);
        if (userTelemetry?.health) {
          setHealth(userTelemetry.health);
        }
        if (userTelemetry?.activities && userTelemetry.activities.length > 0) {
          setActivities(userTelemetry.activities);
        }
      }
    });
  }, []);

  const handleConnectGarmlink = async () => {
    stopOAuthPolling();
    setGarmlink((prev) => ({ ...prev, syncing: true, error: null }));
    try {
      const res = await fetch('/api/garmlink/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = (await res.json()) as {
        auth_url?: string;
        state?: string;
        poll_token?: string;
        error?: string;
      };
      if (!res.ok || !data.auth_url) {
        throw new Error(data.error || 'Unable to start Garmlink OAuth flow.');
      }

      const popup = window.open(data.auth_url, 'garmlink_oauth_popup', 'width=600,height=720');
      if (!popup) {
        throw new Error('Popup was blocked by your browser. Allow popups for RaceKit to sign in to Garmlink MCP.');
      }
      oauthPopupRef.current = popup;
      setGarmlink((prev) => ({ ...prev, syncing: false }));
      notify('Complete sign-in in the Garmlink window — RaceKit will sync automatically.', 'info');

      // COOP-resilient server handoff polling: Garmlink sets Cross-Origin-Opener-Policy: same-origin,
      // which severs window.opener; polling guarantees immediate handoff + popup cleanup.
      if (data.state && data.poll_token) {
        const flowState = data.state;
        const pollToken = data.poll_token;
        const startedAt = Date.now();
        let inFlight = false;

        oauthPollTimerRef.current = window.setInterval(async () => {
          if (inFlight) return;
          if (Date.now() - startedAt > 3 * 60 * 1000) {
            stopOAuthPolling();
            return;
          }
          inFlight = true;
          try {
            const pollRes = await fetch('/api/garmlink/oauth/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ state: flowState, poll_token: pollToken }),
            });
            if (!pollRes.ok) return;
            const pollData = (await pollRes.json()) as {
              status?: 'pending' | 'completed' | 'error' | 'expired';
              sessionToken?: string;
              error?: string;
            };
            if (pollData.status === 'completed' && pollData.sessionToken) {
              handleGarmlinkAuthorized(pollData.sessionToken);
            } else if (pollData.status === 'error') {
              stopOAuthPolling();
              const errMsg = pollData.error || 'Garmlink OAuth authorization failed.';
              setGarmlink((prev) => ({ ...prev, syncing: false, error: errMsg }));
              notify(errMsg, 'error');
            } else if (pollData.status === 'expired') {
              stopOAuthPolling();
            }
          } catch {
            // Keep polling on transient network blips
          } finally {
            inFlight = false;
          }
        }, 1200);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Garmlink connection error';
      setGarmlink((prev) => ({ ...prev, syncing: false, error: msg }));
      notify(msg, 'error');
    }
  };

  const handleDisconnectGarmlink = async () => {
    const token = garmlinkSessionRef.current;
    try {
      await fetch('/api/garmlink/disconnect', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      // Ignore network failure on disconnect
    }
    setGarmlinkSessionToken(null);
    setGarmlink({
      connected: false,
      syncing: false,
      last_synced_at: null,
      tools_discovered: [],
      tools_called: [],
      error: null,
    });
    notify('Disconnected Garmlink MCP session.', 'info');
  };

  // Derived prediction engine & fitness metrics (uses REAL synced activity volume when present)
  const engine = useMemo(() => {
    const realVolume = isAthleteActive ? computeVolumeFromActivities(activities) : null;
    const guestVolume = {
      longest_run_miles: Math.round(runnerProfile.weekly_miles * 0.35),
      avg_weekly_miles: runnerProfile.weekly_miles,
    };
    return new PredictionEngine(
      runnerEfforts,
      health?.vo2max ?? (runnerProfile.vdot || null),
      realVolume ?? guestVolume,
      60,
      health?.garmin_race_predictions ?? null
    );
  }, [runnerEfforts, health?.vo2max, health?.garmin_race_predictions, activities, isAthleteActive, runnerProfile]);

  const fitness = useMemo(() => engine.getFitnessMetrics(), [engine]);
  const zones = useMemo(() => engine.getTrainingZones(), [engine]);
  const activePrediction = useMemo(
    () => engine.predict(selectedDistance, conditions),
    [engine, selectedDistance, conditions]
  );

  // Build active training plan: base + AI plan + adapted overrides + pinned user customizations, strictly remaining days
  const trainingPlan = useMemo(() => {
    const baseTemplate = generateTrainingPlan(planFocus, zones, targetRace);
    const matchesAiPlan = Boolean(
      aiGeneratedPlan && (!aiGeneratedPlan.focus_id || aiGeneratedPlan.focus_id === planFocus)
    );
    const activeSource = matchesAiPlan && aiGeneratedPlan ? aiGeneratedPlan : baseTemplate;

    const mergedByDay = new Map<string, DailyWorkout>();
    for (const w of baseTemplate.schedule) {
      const dKey = normalizeDayName(w.day, w.day);
      mergedByDay.set(dKey, { ...w, day: dKey });
    }
    if (matchesAiPlan && aiGeneratedPlan) {
      for (const w of aiGeneratedPlan.schedule) {
        const dKey = normalizeDayName(w.day, w.day);
        mergedByDay.set(dKey, { ...w, day: dKey });
      }
    }
    for (const [dRaw, w] of Object.entries(adaptedDays)) {
      if (w) {
        const dKey = normalizeDayName(w.day || dRaw, dRaw);
        const keepPinned = Boolean(
          w.is_pinned || w.user_customized || (w.ai_generated && !/HRV Adaptive/i.test(w.name))
        );
        mergedByDay.set(dKey, {
          ...w,
          day: dKey,
          ...(keepPinned ? { is_pinned: true, user_customized: true } : {}),
        });
      }
    }
    for (const [dRaw, w] of Object.entries(customizedDays)) {
      if (w) {
        const dKey = normalizeDayName(w.day || dRaw, dRaw);
        mergedByDay.set(dKey, { ...w, day: dKey, is_pinned: true, user_customized: true });
      }
    }

    const mergedSchedule = DAYS_OF_WEEK.map((d) => mergedByDay.get(d)).filter(
      (w): w is DailyWorkout => Boolean(w)
    );
    const remainingSchedule = filterRemainingSchedule(mergedSchedule, todayName);
    const gated = enforceRecoveryGate(
      { ...activeSource, focus_id: planFocus, schedule: remainingSchedule },
      health,
      todayName,
      {
        honorExplicitIntensity: Boolean(
          matchesAiPlan && (aiGeneratedPlan as { honor_explicit_intensity?: boolean } | null)?.honor_explicit_intensity
        ),
      }
    );
    return finalizePlanSchedule(gated, targetRace, {
      todayDay: todayName,
      remainingOnly: true,
      maxAutoRest:
        matchesAiPlan && (aiGeneratedPlan as { no_rest_days?: boolean } | null)?.no_rest_days
          ? 0
          : undefined,
    });
  }, [aiGeneratedPlan, planFocus, zones, targetRace, adaptedDays, customizedDays, health, todayName]);

  const handleSelectCourse = (courseId: string) => {
    setSelectedCourseId(courseId);
    setSyncedWeather(null);
    const course = PRESET_COURSES.find((c) => c.course_id === courseId);
    if (!course || courseId === 'custom') return;
    if (course.distance_label) {
      setSelectedDistance(course.distance_label);
    }
    const normSurf = normalizeSurface(course.surface);
    const defaultShoe =
      normSurf === 'xc'
        ? 'dragonfly_xc'
        : normSurf === 'track'
          ? 'dragonfly_track'
          : 'streakfly';
    setConditions((prev) => ({
      ...prev,
      surface: normSurf,
      shoe_type: defaultShoe,
      elevation_gain_ft: course.elevation_gain_ft,
      elevation_loss_ft: course.elevation_loss_ft,
      altitude_ft: course.altitude_ft,
    }));
  };

  // Apply and persist a customized or modified single-day workout across customizedDays, focus overrides, AI plan, and user storage
  const applyDayWorkoutOverride = useCallback(
    (day: string, workout: DailyWorkout, targetFocusId: TrainingFocusId = planFocus) => {
      const normDay = normalizeDayName(day, todayName);
      const stamped: DailyWorkout = {
        ...workout,
        day: normDay,
        is_pinned: true,
        user_customized: true,
      };
      setCustomizedDays((prev) => ({
        ...prev,
        [normDay]: stamped,
      }));
      setAdaptedDaysByFocus((prev) => {
        const nextForFocus = {
          ...(prev[targetFocusId] ?? {}),
          [normDay]: stamped,
        };
        if (currentUser) {
          saveUserWorkouts(currentUser.id, targetFocusId, nextForFocus);
        }
        return {
          ...prev,
          [targetFocusId]: nextForFocus,
        };
      });
      setAiGeneratedPlan((prev) => {
        if (!prev) return prev;
        const exists = prev.schedule.some((w) => normalizeDayName(w.day, '') === normDay);
        const updatedSchedule = exists
          ? prev.schedule.map((w) => (normalizeDayName(w.day, '') === normDay ? stamped : w))
          : [...prev.schedule, stamped];
        const sliced = slicePlanToRemainingDays({ ...prev, schedule: updatedSchedule }, todayName);
        return { ...prev, ...sliced };
      });
    },
    [planFocus, todayName, currentUser]
  );

  const handleResetDay = useCallback(
    (day: string) => {
      const normDay = normalizeDayName(day, todayName);
      setCustomizedDays((prev) => {
        const next = { ...prev };
        delete next[normDay];
        return next;
      });
      setAdaptedDaysByFocus((prev) => {
        const nextForFocus = { ...(prev[planFocus] ?? {}) };
        delete nextForFocus[normDay];
        if (currentUser) {
          saveUserWorkouts(currentUser.id, planFocus, nextForFocus);
        }
        return {
          ...prev,
          [planFocus]: nextForFocus,
        };
      });
      notify(`Reset ${normDay} back to plan default.`, 'info');
    },
    [planFocus, todayName, currentUser, notify]
  );

  const handleToggleDayRest = useCallback(
    (workout: DailyWorkout) => {
      const normDay = normalizeDayName(workout.day, todayName);
      if (workout.workout_type === 'rest') {
        const runWorkout: DailyWorkout = {
          day: normDay,
          name: 'Easy Aerobic Base Run',
          workout_type: 'easy',
          warmup_miles: 0.5,
          main_miles: 3.0,
          cooldown_miles: 0.5,
          distance_miles: 4.0,
          pace_target: `${zones.easy.label} (Conversational Aerobic)`,
          hr_cap: '135–152 bpm',
          description:
            '• Warmup: 0.5 mi gentle jog.\n• Main Set: 3.0 mi comfortable aerobic miles.\n• Cooldown: 0.5 mi easy walk + mobility.',
          injury_prevention_note: 'Athlete-converted active day replacing rest.',
          ai_generated: false,
          is_pinned: true,
          user_customized: true,
          adaptation_reason: `Athlete converted ${normDay} from Rest Day to 4.0 mi Easy Run.`,
        };
        applyDayWorkoutOverride(normDay, runWorkout);
        notify(`${normDay} changed from Rest to 4.0 mi Easy Run.`, 'success');
      } else {
        const restWorkout: DailyWorkout = {
          day: normDay,
          name: 'Rest & Mobility Day',
          workout_type: 'rest',
          warmup_miles: 0,
          main_miles: 0,
          cooldown_miles: 0,
          distance_miles: 0,
          pace_target: 'Off (Full Rest)',
          hr_cap: 'Rest',
          description:
            '• Warmup: Off.\n• Main Set: Full rest from running — optional 15 min light mobility.\n• Cooldown: Prioritize hydration & sleep.',
          injury_prevention_note: 'Athlete-selected rest day for dedicated recovery.',
          ai_generated: false,
          is_pinned: true,
          user_customized: true,
          adaptation_reason: `Athlete set ${normDay} as Rest Day.`,
        };
        applyDayWorkoutOverride(normDay, restWorkout);
        notify(`${normDay} set to Rest Day.`, 'info');
      }
    },
    [todayName, zones, applyDayWorkoutOverride, notify]
  );

  // Generate full remaining-week AI training plan from synced watch data & PRs (respects remaining days & customized/pinned overrides)
  const handleGenerateAiPlan = async (customGoal: string, focusOverride?: TrainingFocusId) => {
    const targetFocus = focusOverride ?? planFocus;
    if (focusOverride && focusOverride !== planFocus) {
      setPlanFocus(focusOverride);
    }
    setAiGeneratedPlan(null);
    setAiPlanLoading(true);
    setAiPlanError(null);
    try {
      const res = await fetch('/api/ai/generate-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          focus_id: targetFocus,
          focus_label: TRAINING_FOCUS_LABELS[targetFocus],
          custom_goal: customGoal,
          today_day: todayName,
          target_race: targetRace,
          customized_days: customizedDays,
          pinned_workouts: Object.values(customizedDays),
          activities: activities.slice(0, 14),
          health,
          fitness,
          zones,
          prs: runnerEfforts,
        }),
      });
      const data = (await res.json()) as {
        plan?: TrainingPlan & { honor_explicit_intensity?: boolean; no_rest_days?: boolean };
        error?: string;
      };
      if (!res.ok || !data.plan) {
        throw new Error(data.error || `Failed to generate AI plan (HTTP ${res.status})`);
      }
      const sliced = slicePlanToRemainingDays(data.plan, todayName);
      setAiGeneratedPlan({
        ...data.plan,
        ...sliced,
        focus_id: targetFocus,
      } as TrainingPlan);
      setAdaptedDaysByFocus((prev) => {
        const currentFocusOverrides = prev[targetFocus] ?? {};
        const preservedPinned = Object.fromEntries(
          Object.entries(currentFocusOverrides).filter(
            ([k, w]) => w?.is_pinned || w?.user_customized || customizedDays[normalizeDayName(k, '')]
          )
        );
        return { ...prev, [targetFocus]: preservedPinned };
      });
      notify(`Generated remaining-week plan: ${sliced.title} (${sliced.weekly_mileage} mi remaining).`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate AI plan';
      setAiPlanError(msg);
      notify(msg, 'error');
    } finally {
      setAiPlanLoading(false);
    }
  };

  // Generate or modify a single custom AI workout for a specific day (with pinned persistence & client fallback)
  const handleGenerateSingleWorkout = async (day: string, goalPrompt: string) => {
    const requestedNormDay = normalizeDayName(day, todayName);
    setAiWorkoutLoading(true);
    setAiWorkoutDay(requestedNormDay);
    setAiPlanError(null);
    try {
      const res = await fetch('/api/ai/generate-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          day: requestedNormDay,
          today_day: todayName,
          goal_prompt: goalPrompt,
          activities: activities.slice(0, 5),
          health,
          fitness,
          zones,
          prs: runnerEfforts,
          current_plan: {
            title: trainingPlan.title,
            weekly_mileage: trainingPlan.weekly_mileage,
            target_race: targetRace,
            schedule: trainingPlan.schedule,
          },
        }),
      });
      const data = (await res.json()) as { workout?: DailyWorkout; error?: string };
      let resolvedWorkout: DailyWorkout;
      if (!res.ok || !data.workout) {
        const parsedLocal = parseDayTargetedPrompt(goalPrompt, requestedNormDay, zones);
        resolvedWorkout = {
          day: parsedLocal.day,
          name: parsedLocal.name,
          workout_type: parsedLocal.workout_type,
          distance_miles: parsedLocal.distance_miles,
          warmup_miles: parsedLocal.warmup_miles,
          main_miles: parsedLocal.main_miles,
          cooldown_miles: parsedLocal.cooldown_miles,
          pace_target: parsedLocal.pace_target,
          hr_cap: parsedLocal.hr_cap,
          description: parsedLocal.description,
          injury_prevention_note: parsedLocal.injury_prevention_note,
          ai_generated: true,
          is_pinned: true,
          user_customized: true,
          adaptation_reason: parsedLocal.reason,
        };
      } else {
        const targetDay = normalizeDayName(data.workout.day || requestedNormDay, requestedNormDay);
        resolvedWorkout = {
          ...data.workout,
          day: targetDay,
          ai_generated: true,
          is_pinned: true,
          user_customized: true,
        };
      }
      applyDayWorkoutOverride(resolvedWorkout.day, resolvedWorkout);
      notify(`Updated ${resolvedWorkout.day}: ${resolvedWorkout.name} (${resolvedWorkout.distance_miles} mi).`, 'success');
    } catch {
      const parsedLocal = parseDayTargetedPrompt(goalPrompt, requestedNormDay, zones);
      const fallbackWorkout: DailyWorkout = {
        day: parsedLocal.day,
        name: parsedLocal.name,
        workout_type: parsedLocal.workout_type,
        distance_miles: parsedLocal.distance_miles,
        warmup_miles: parsedLocal.warmup_miles,
        main_miles: parsedLocal.main_miles,
        cooldown_miles: parsedLocal.cooldown_miles,
        pace_target: parsedLocal.pace_target,
        hr_cap: parsedLocal.hr_cap,
        description: parsedLocal.description,
        injury_prevention_note: parsedLocal.injury_prevention_note,
        ai_generated: true,
        is_pinned: true,
        user_customized: true,
        adaptation_reason: parsedLocal.reason,
      };
      applyDayWorkoutOverride(fallbackWorkout.day, fallbackWorkout);
      notify(`Updated ${fallbackWorkout.day}: ${fallbackWorkout.name} (${fallbackWorkout.distance_miles} mi).`, 'success');
    } finally {
      setAiWorkoutLoading(false);
      setAiWorkoutDay(null);
    }
  };

  // Resilient AI Performance Coach (with Garmlink MCP server-side query tool when connected)
  const handleSendCoachMessage = async (text: string) => {
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg: CoachMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: nowTime,
    };
    const nextHistory = [...coachMessages, userMsg];
    setCoachMessages(nextHistory);
    setCoachSending(true);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (garmlinkSessionRef.current) {
        headers.Authorization = `Bearer ${garmlinkSessionRef.current}`;
      }

      const planSnapshot = {
        focus_id: planFocus,
        title: trainingPlan.title,
        weekly_mileage: trainingPlan.weekly_mileage,
        schedule: trainingPlan.schedule.map((w) => ({
          day: w.day,
          name: w.name,
          workout_type: w.workout_type,
          distance_miles: w.distance_miles,
          pace_target: w.pace_target,
        })),
      };

      const res = await fetch('/api/ai/coach', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: text,
          history: nextHistory
            .filter((m) => m.id !== 'welcome' && !m.error)
            .map((m) => ({ role: m.role, content: m.content })),
          context: {
            today: todayName,
            garmlink_connected: garmlink.connected,
            synced_activities_count: activities.length,
            recent_activities: activities.slice(0, 12),
            health,
            fitness,
            zones,
            prs: runnerEfforts,
            active_prediction: activePrediction,
            active_course:
              PRESET_COURSES.find((c) => c.course_id === selectedCourseId)?.name ?? 'Custom',
            race_schedule: { date: raceDate, time: raceTime, weather: syncedWeather },
            conditions,
            target_race: targetRace,
            customized_days: customizedDays,
            current_plan: planSnapshot,
            training_plan: planSnapshot,
          },
        }),
      });

      const data = (await res.json()) as {
        reply?: string;
        tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
        garmlink_queries?: string[];
        error?: string;
      };

      if (!res.ok || !data.reply) {
        throw new Error(data.error || `Coach API returned HTTP ${res.status}`);
      }

      const appliedLabels: string[] = [...(data.garmlink_queries ?? [])];

      for (const tc of data.tool_calls ?? []) {
        if (tc.name === 'replace_workout_day') {
          const day = normalizeDayName(String(tc.args.day || todayName), todayName);
          const wType = (tc.args.workout_type as WorkoutType) || 'easy';
          const updated: DailyWorkout = {
            day,
            name: String(tc.args.name || 'AI Workout'),
            workout_type: wType,
            distance_miles: Number(tc.args.distance_miles ?? (wType === 'rest' ? 0 : 4.0)),
            warmup_miles: tc.args.warmup_miles != null ? Number(tc.args.warmup_miles) : undefined,
            main_miles: tc.args.main_miles != null ? Number(tc.args.main_miles) : undefined,
            cooldown_miles: tc.args.cooldown_miles != null ? Number(tc.args.cooldown_miles) : undefined,
            pace_target: String(tc.args.pace_target || zones.easy.label),
            hr_cap: String(tc.args.hr_cap || '< 145 bpm'),
            description: String(tc.args.description || ''),
            injury_prevention_note: String(tc.args.injury_prevention_note || ''),
            ai_generated: true,
            is_pinned: true,
            user_customized: true,
            adaptation_reason: String(tc.args.reason || 'Updated by AI Coach'),
          };
          applyDayWorkoutOverride(day, updated);
          appliedLabels.push(`Updated ${day}: ${updated.name} (${updated.distance_miles} mi)`);
        } else if (tc.name === 'schedule_race_taper') {
          const race_name = String(tc.args.race_name || 'Target Race');
          const race_dist = String(tc.args.race_dist || '5K');
          const race_day = normalizeDayName(String(tc.args.race_day || 'Thursday'), 'Thursday');
          setAiGeneratedPlan(null);
          setTargetRace({ name: race_name, dist: race_dist, day: race_day });
          appliedLabels.push(`Scheduled race-week taper for ${race_name} (${race_dist}) on ${race_day}`);
        }
      }

      if (appliedLabels.length > 0) {
        notify(appliedLabels[0], 'success');
      }

      setCoachMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: data.reply || '',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          tool_actions: appliedLabels,
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI Coach error';
      setCoachMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: msg,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          error: true,
          retryPrompt: text,
        },
      ]);
    } finally {
      setCoachSending(false);
    }
  };

  const navItems: Array<{ id: ActiveTab; label: string; icon: typeof Watch }> = [
    { id: 'watch', label: 'Overview', icon: Watch },
    { id: 'plan', label: 'Workouts', icon: CalendarDays },
    { id: 'predictor', label: 'Race Predictor', icon: Gauge },
    { id: 'coach', label: 'AI Coach', icon: MessageSquareText },
  ];

  const activeBreadcrumb =
    navItems.find((n) => n.id === activeTab)?.label ?? 'Overview';

  return (
    <div className="min-h-screen bg-[#000000] text-[#F2F2F7]">
      {/* Toast Notifications (anchored below top bar so bottom CTAs stay unobstructed) */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed top-16 right-4 z-50 flex max-w-sm flex-col gap-2"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start justify-between gap-2.5 rounded-2xl border px-3.5 py-2.5 text-xs font-medium shadow-xl backdrop-blur-xl ${
                t.tone === 'success'
                  ? 'border-[#30D158]/40 bg-[#1C1C1E]/95 text-[#30D158]'
                  : t.tone === 'error'
                    ? 'border-[#FF453A]/40 bg-[#1C1C1E]/95 text-[#FF453A]'
                    : 'border-[#0A84FF]/40 bg-[#1C1C1E]/95 text-[#0A84FF]'
              }`}
            >
              <span>{t.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                aria-label="Dismiss notification"
                className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex min-h-screen">
        {/* Desktop Sidebar (240px) */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-white/10 bg-[#000000] lg:flex">
          <div className="flex h-14 items-center border-b border-white/10 px-5">
            <span className="font-display text-lg font-extrabold tracking-tight text-white whitespace-nowrap">
              Race<span className="text-[#0A84FF]">Kit</span>
            </span>
          </div>

          <nav className="flex-1 space-y-1.5 p-3" aria-label="Primary navigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-all whitespace-nowrap ${
                    active
                      ? 'bg-[#1C1C1E] text-white border border-white/10 shadow-sm'
                      : 'text-[#8E8E93] hover:bg-[#1C1C1E]/50 hover:text-white'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-[#0A84FF]' : 'text-[#8E8E93]'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Athlete Summary Footer */}
          <div
            onClick={() => setProfileModalOpen(true)}
            className="cursor-pointer border-t border-white/10 p-4 text-xs hover:bg-[#1C1C1E]/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white">
                {currentUser ? currentUser.name : isOwnerUnlocked ? 'Ephraim' : 'Not Signed In'}
              </span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  currentUser
                    ? 'bg-[#0A84FF]/20 text-[#0A84FF]'
                    : isOwnerUnlocked
                      ? 'bg-[#30D158]/20 text-[#30D158]'
                      : 'bg-white/10 text-[#8E8E93]'
                }`}
              >
                {currentUser ? (currentUser.is_demo ? 'Demo' : 'Athlete') : isOwnerUnlocked ? 'Owner' : 'Guest'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-[#8E8E93]">
              <span className="flex items-center gap-1 text-[#0A84FF] font-semibold">
                <BatteryCharging className="h-3 w-3" />
                <span>{resolvedBodyBattery}%</span>
              </span>
              <span>·</span>
              <span>VDOT {fitness.vo2max ?? runnerProfile.vdot} · CS {fitness.critical_speed_pace}</span>
            </div>
            <div className="mt-2 font-mono text-[11px] tabular-nums text-[#8E8E93]">
              {selectedDistance} Forecast: <span className="text-[#30D158] font-bold">{activePrediction.time_fmt}</span>
            </div>
          </div>
        </aside>

        {/* Mobile Slide-Over Navigation Drawer */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div
              className="fixed inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <aside className="relative z-10 flex w-64 flex-col border-r border-white/10 bg-[#000000]">
              <div className="flex h-14 items-center justify-between border-b border-white/10 px-5">
                <span className="font-display text-lg font-extrabold tracking-tight text-white">
                  Race<span className="text-[#0A84FF]">Kit</span>
                </span>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close navigation menu"
                  className="rounded-lg p-1.5 text-[#8E8E93] hover:bg-[#1C1C1E] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <nav className="flex-1 space-y-1.5 p-3" aria-label="Mobile navigation">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileNavOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-all whitespace-nowrap ${
                        active
                          ? 'bg-[#1C1C1E] text-white border border-white/10 shadow-sm'
                          : 'text-[#8E8E93] hover:bg-[#1C1C1E]/50 hover:text-white'
                      }`}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-[#0A84FF]' : 'text-[#8E8E93]'}`} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
              <div
                onClick={() => {
                  setMobileNavOpen(false);
                  setProfileModalOpen(true);
                }}
                className="cursor-pointer border-t border-white/10 p-4 text-xs hover:bg-[#1C1C1E]/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">
                    {currentUser ? currentUser.name : isOwnerUnlocked ? 'Ephraim' : 'Not Signed In'}
                  </span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      currentUser
                        ? 'bg-[#0A84FF]/20 text-[#0A84FF]'
                        : isOwnerUnlocked
                          ? 'bg-[#30D158]/20 text-[#30D158]'
                          : 'bg-white/10 text-[#8E8E93]'
                    }`}
                  >
                    {currentUser ? (currentUser.is_demo ? 'Demo' : 'Athlete') : isOwnerUnlocked ? 'Owner' : 'Guest'}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-[#8E8E93]">
                  <span className="flex items-center gap-1 text-[#0A84FF] font-semibold">
                    <BatteryCharging className="h-3 w-3" />
                    <span>{resolvedBodyBattery}%</span>
                  </span>
                  <span>·</span>
                  <span>VDOT {fitness.vo2max ?? runnerProfile.vdot} · CS {fitness.critical_speed_pace}</span>
                </div>
              </div>
            </aside>
          </div>
        )}

        {/* Main Workspace Column */}
        <div className="flex min-w-0 flex-1 flex-col bg-[#000000]">
          {/* Top Bar: Breadcrumb + Athlete Telemetry Quick Glance + Garmlink Sync */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-white/10 bg-[#000000]/85 px-4 backdrop-blur-xl lg:px-8">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation menu"
                className="rounded-lg p-2 text-[#8E8E93] hover:bg-[#1C1C1E] lg:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-2 text-sm truncate">
                <span className="hidden font-bold tracking-tight text-[#8E8E93] whitespace-nowrap sm:inline">
                  Race<span className="text-[#0A84FF]">Kit</span>
                </span>
                <span className="hidden text-white/20 sm:inline" aria-hidden="true">/</span>
                <span className="font-semibold text-white truncate">{activeBreadcrumb}</span>
              </div>
            </div>

            {/* Quick Live Telemetry Chips in Header (Verified Metrics Only - Honest nulls) */}
            <div className="hidden md:flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#1C1C1E] px-3 py-1 text-[11px]">
                <BatteryCharging className="h-3 w-3 text-[#0A84FF]" />
                <span className="text-[#8E8E93]">Battery</span>
                <span className="font-mono font-bold text-[#0A84FF]">
                  {resolvedBodyBattery != null ? `${resolvedBodyBattery}%` : '55%'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#1C1C1E] px-3 py-1 text-[11px]">
                <span className="text-[#8E8E93]">Sleep</span>
                <span className="font-mono font-semibold text-white">
                  {health?.sleep_time_fmt ?? (health?.sleep_hours != null
                    ? `${health.sleep_hours}h`
                    : health?.sleep_score != null
                      ? `Score ${health.sleep_score}`
                      : '—')}
                </span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#1C1C1E] px-3 py-1 text-[11px]">
                <span className="text-[#8E8E93]">HRV</span>
                {health?.hrv_last_night != null ? (
                  health.hrv_last_night < (health.hrv_baseline_low ?? 48) ? (
                    <span className="flex items-center gap-1">
                      <span className="font-mono font-bold text-[#FF9F0A]">{health.hrv_last_night}ms</span>
                      <span className="rounded bg-[#FF9F0A]/20 px-1 text-[9px] font-bold text-[#FF9F0A]">LOW</span>
                    </span>
                  ) : (
                    <span className="font-mono font-bold text-[#30D158]">{health.hrv_last_night}ms</span>
                  )
                ) : (
                  <span className="font-mono text-[#8E8E93]">—</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#1C1C1E] px-3 py-1 text-[11px]">
                <span className="text-[#8E8E93]">VO2 Max</span>
                <span className="font-mono font-bold text-[#30D158]">{health?.vo2max ?? fitness.vo2max ?? runnerProfile.vdot}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Honest Watch Connection Status */}
              {garmlink.syncing ? (
                <div className="inline-flex items-center gap-2 rounded-xl border border-[#0A84FF]/40 bg-[#0A84FF]/15 px-3 py-1.5 text-xs font-semibold text-[#0A84FF] whitespace-nowrap shadow-sm">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-[#0A84FF]" />
                  <span>Syncing Watch…</span>
                </div>
              ) : garmlink.connected && garmlink.tools_discovered.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('watch');
                    void syncFromGarmlink();
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#30D158]/40 bg-[#30D158]/15 px-3 py-1.5 text-xs font-semibold text-[#30D158] transition-all hover:bg-[#30D158]/25 whitespace-nowrap shadow-sm shadow-[#30D158]/10"
                  title={`${garmlink.tools_discovered.length} Garmlink MCP tools connected`}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-[#30D158]" />
                  <span>Garmlink Connected ({garmlink.tools_discovered.length} Tools)</span>
                </button>
              ) : garmlink.error ? (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('watch');
                    void syncFromGarmlink();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#FF9F0A]/40 bg-[#FF9F0A]/15 px-3 py-1.5 text-xs font-semibold text-[#FF9F0A] hover:bg-[#FF9F0A]/25 whitespace-nowrap shadow-sm"
                >
                  <AlertCircle className="h-3.5 w-3.5 text-[#FF9F0A]" />
                  <span>Sync Error · Retry</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveTab('watch')}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#1C1C1E] px-3 py-1.5 text-xs font-semibold text-[#8E8E93] hover:text-white hover:border-white/20 transition-all whitespace-nowrap"
                >
                  <Watch className="h-3.5 w-3.5 text-[#8E8E93]" />
                  <span>Not Connected</span>
                </button>
              )}

              {/* Athlete Account / Profile Button */}
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-[#1C1C1E] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:text-white hover:border-white/20 transition-all whitespace-nowrap shadow-sm"
              >
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0A84FF]/20 text-[#0A84FF] text-[10px] font-bold">
                  {currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : (isOwnerUnlocked ? 'E' : 'G')}
                </div>
                <span>{currentUser?.name || (isOwnerUnlocked ? 'Ephraim (Owner)' : 'Sign In / Guest')}</span>
              </button>

              {isOwnerUnlocked && (
                <button
                  type="button"
                  onClick={handleLockGuestMode}
                  title="Lock Owner Mode and return to Guest Mode"
                  className="rounded-xl border border-white/10 bg-[#1C1C1E] px-2.5 py-1.5 text-xs font-semibold text-[#8E8E93] hover:text-white transition-colors"
                >
                  Lock
                </button>
              )}
            </div>
          </header>

          {/* Main Content Viewport */}
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 lg:px-8">
            {activeTab === 'watch' && (
              <div className="space-y-6">
                <WatchSyncView
                  garmlink={garmlink}
                  health={health}
                  liveHealthHistory={healthHistory}
                  activities={displayActivities}
                  efforts={runnerEfforts}
                  onConnectGarmlink={() => void handleConnectGarmlink()}
                  onSyncGarmlink={() => void syncFromGarmlink()}
                  onDisconnectGarmlink={() => void handleDisconnectGarmlink()}
                  onImportActivity={(act) =>
                    setActivities((prev) =>
                      [act, ...prev].sort((a, b) => b.date.localeCompare(a.date))
                    )
                  }
                  onClearActivities={() => {
                    setActivities([]);
                    notify('Cleared synced watch activities.', 'info');
                  }}
                  onUpdateHealth={setHealth}
                  onGoToAiPlan={() => setActiveTab('plan')}
                  onNotify={notify}
                />
              </div>
            )}

            {activeTab === 'plan' && (
              <TrainingPlanView
                focus={planFocus}
                plan={trainingPlan}
                targetRace={targetRace}
                hasCustomAiPlan={
                  Boolean(aiGeneratedPlan) ||
                  Object.keys(adaptedDays).length > 0 ||
                  Object.keys(customizedDays).length > 0
                }
                activities={displayActivities}
                health={health}
                aiPlanLoading={aiPlanLoading}
                aiWorkoutLoading={aiWorkoutLoading}
                aiWorkoutDay={aiWorkoutDay}
                aiError={aiPlanError}
                todayDay={todayName}
                zones={zones}
                customizedDays={customizedDays}
                onChangeFocus={(next) => {
                  setPlanFocus(next);
                  setAiGeneratedPlan(null);
                }}
                onGenerateAiPlan={(goal, focusOverride) => void handleGenerateAiPlan(goal, focusOverride)}
                onGenerateSingleWorkout={(day, goal) => void handleGenerateSingleWorkout(day, goal)}
                onSaveCustomWorkout={(day, workout) => applyDayWorkoutOverride(day, workout)}
                onToggleDayRest={handleToggleDayRest}
                onResetDay={handleResetDay}
                onSetTargetRace={(race) => {
                  setAiGeneratedPlan(null);
                  setTargetRace(race);
                  notify(
                    `Race-week taper scheduled for ${race.name} (${race.dist}) on ${race.day}.`,
                    'success'
                  );
                }}
                onClearTargetRace={() => {
                  setTargetRace(null);
                  notify('Cleared race-week taper.', 'info');
                }}
                onResetToBasePlan={() => {
                  setAiGeneratedPlan(null);
                  setCustomizedDays({});
                  setAdaptedDaysByFocus((prev) => ({
                    ...prev,
                    [planFocus]: {},
                  }));
                  setAiPlanError(null);
                  notify('Restored base weekly template.', 'info');
                }}
                onOpenCoachForWorkout={(prompt) => {
                  setCoachPrefill(prompt);
                  setActiveTab('coach');
                }}
                onNotify={notify}
              />
            )}

            {activeTab === 'predictor' && (
              <RacePredictorView
                engine={engine}
                fitness={fitness}
                zones={zones}
                efforts={runnerEfforts}
                hasSyncedHealth={Boolean(health)}
                garminPredictions={health?.garmin_race_predictions ?? null}
                selectedDistance={selectedDistance}
                selectedCourseId={selectedCourseId}
                conditions={conditions}
                raceDate={raceDate}
                raceTime={raceTime}
                syncedWeather={syncedWeather}
                targetRace={targetRace}
                onSelectDistance={setSelectedDistance}
                onSelectCourse={handleSelectCourse}
                onSetTargetRace={setTargetRace}
                onChangeConditions={setConditions}
                onChangeRaceDate={setRaceDate}
                onChangeRaceTime={setRaceTime}
                onSyncedWeather={setSyncedWeather}
                onNotify={notify}
              />
            )}

            {activeTab === 'coach' && (
              <AiCoachView
                messages={coachMessages}
                sending={coachSending}
                garmlink={garmlink}
                activities={displayActivities}
                health={health}
                fitness={fitness}
                zones={zones}
                efforts={runnerEfforts}
                prefillPrompt={coachPrefill}
                onConsumePrefill={() => setCoachPrefill(null)}
                onSendMessage={handleSendCoachMessage}
              />
            )}
          </main>
        </div>
      </div>

      <RunnerProfileModal
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        profile={runnerProfile}
        efforts={runnerEfforts}
        isOwnerUnlocked={isOwnerUnlocked}
        onToggleOwnerLock={handleToggleOwnerLock}
        onSaveProfile={(updated, enteredPasscode) => {
          setRunnerProfile(updated);
          try {
            localStorage.setItem('racekit_runner_profile', JSON.stringify(updated));
          } catch {}
          if (enteredPasscode) {
            handleToggleOwnerLock(enteredPasscode);
          }
          notify(`Profile updated for ${updated.name}. Training zones and VDOT refreshed!`, 'success');
        }}
        signedInName={currentUser?.name || currentUser?.email?.split('@')[0] || null}
      />
      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        currentUser={currentUser}
        onUserAuthenticated={(user) => {
          setCurrentUser(user);
          const userWorkouts = loadUserWorkouts(user.id, planFocus);
          if (Object.keys(userWorkouts).length > 0) {
            setAdaptedDaysByFocus((prev) => ({ ...prev, [planFocus]: userWorkouts }));
          }
          const userTarget = loadUserTargetRace(user.id);
          if (userTarget) setTargetRace(userTarget);
          const userPRs = loadUserPRs(user.id);
          if (userPRs && userPRs.length > 0) setEfforts(userPRs);
          const userTelemetry = loadUserTelemetry(user.id);
          if (userTelemetry?.health) setHealth(userTelemetry.health);
          if (userTelemetry?.activities && userTelemetry.activities.length > 0) setActivities(userTelemetry.activities);
          notify(`Welcome back, ${user.name}! Your isolated runner profile is active.`, 'success');
          void syncFromGarmlink();
        }}
        onSignOut={async () => {
          await signOutUser();
          setCurrentUser(null);
          setOwnerPasscode('');
          try {
            localStorage.removeItem('racekit_owner_passcode');
            localStorage.removeItem('racekit_active_session');
            localStorage.removeItem('racekit_runner_profile');
            localStorage.removeItem('racekit_app_state');
          } catch {}
          setRunnerProfile({
            name: 'Guest Runner',
            units: 'mi',
            benchmark_dist_m: 5000,
            benchmark_label: '5K',
            benchmark_time_s: 1200,
            benchmark_time_fmt: '20:00',
            vdot: 50.0,
            weekly_miles: 20,
            primary_focus: 'track_mid',
            is_owner: false,
            onboarded: false,
          });
          setHealth(null);
          setActivities([]);
          setEfforts([]);
          setGarmlink({
            connected: false,
            syncing: false,
            error: null,
            tools_discovered: [],
            tools_called: [],
            last_synced_at: null,
          });
          setCustomizedDays({});
          setAdaptedDaysByFocus({
            track_mid: {},
            track_long: {},
            xc: {},
            half_marathon: {},
            base_building: {},
          });
          notify('Signed out successfully. All personal telemetry cleared.', 'info');
        }}
      />

      <OnboardingModal
        isOpen={onboardingModalOpen}
        onClose={() => setOnboardingModalOpen(false)}
        currentUser={currentUser}
        onOpenGarmlinkSync={() => {
          setActiveTab('watch');
          void handleConnectGarmlink();
        }}
        onComplete={(data) => {
          setCurrentUser(data.user);
          setTargetRace({
            name: data.targetRaceName,
            dist: data.targetRaceDist,
            day: 'Thursday',
          });
          if (data.initialEffort) {
            setEfforts((prev) => [data.initialEffort!, ...prev]);
            saveUserPRs(data.user.id, [data.initialEffort!, ...efforts]);
          }
          saveUserTargetRace(data.user.id, {
            name: data.targetRaceName,
            dist: data.targetRaceDist,
            day: 'Thursday',
          });
          notify(`Welcome, ${data.user.name}! Goal race set to ${data.targetRaceName}.`, 'success');
        }}
      />
    </div>
  );
}
