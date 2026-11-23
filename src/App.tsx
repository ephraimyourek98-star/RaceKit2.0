import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Gauge,
  Link2,
  Menu,
  MessageSquareText,
  Watch,
  X,
} from 'lucide-react';
import { AiCoachView } from './components/AiCoachView';
import { RacePredictorView } from './components/RacePredictorView';
import { TrainingPlanView } from './components/TrainingPlanView';
import { WatchSyncView } from './components/WatchSyncView';
import { PredictionEngine } from './lib/predictionEngine';
import { PRESET_COURSES, VERIFIED_PR_EFFORTS } from './lib/seedData';
import {
  TRAINING_FOCUS_LABELS,
  generateTrainingPlan,
  getTodayDayName,
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
  TrainingFocusId,
  TrainingPlan,
  WatchActivity,
  WorkoutType,
} from './lib/types';

type ActiveTab = 'watch' | 'plan' | 'predictor' | 'coach';

interface ToastItem {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

const STORAGE_KEY = 'racekit_state_v3';

function getDefaultRaceDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<{
      health: HealthSnapshot | null;
      efforts: Effort[];
      activities: WatchActivity[];
      planFocus: TrainingFocusId;
      aiGeneratedPlan: TrainingPlan | null;
      targetRace: { name: string; dist: string; day: string } | null;
      adaptedDays: Record<string, DailyWorkout>;
      raceDate: string;
      raceTime: string;
    }>;
  } catch {
    return null;
  }
}

export default function App() {
  const persisted = useMemo(() => loadPersistedState(), []);

  const [activeTab, setActiveTab] = useState<ActiveTab>('watch');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Core athlete state — zero fake watch activities or fake health snapshots!
  const [efforts, setEfforts] = useState<Effort[]>(persisted?.efforts ?? VERIFIED_PR_EFFORTS);
  const [health, setHealth] = useState<HealthSnapshot | null>(persisted?.health ?? null);
  const [activities, setActivities] = useState<WatchActivity[]>(persisted?.activities ?? []);

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
    wind_direction: 'head',
    shoe_type: 'streakfly',
    use_readiness: Boolean(persisted?.health),
    hrv_status: persisted?.health?.hrv_status ?? 'BALANCED',
    sleep_score: persisted?.health?.sleep_score ?? 80,
    body_battery: persisted?.health?.body_battery ?? 75,
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
  } | null>(persisted?.targetRace ?? null);
  const [adaptedDays, setAdaptedDays] = useState<Record<string, DailyWorkout>>(
    persisted?.adaptedDays ?? {}
  );
  const [aiPlanLoading, setAiPlanLoading] = useState(false);
  const [aiWorkoutLoading, setAiWorkoutLoading] = useState(false);
  const [aiPlanError, setAiPlanError] = useState<string | null>(null);

  // AI Coach state
  const [coachMessages, setCoachMessages] = useState<CoachMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Ready to build workouts and training plans from your Garmin watch data and verified PRs. Connect Garmlink MCP in Watch Sync to pull your real run history and recovery metrics, or ask me to create a workout or race taper anytime.',
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
          raceDate,
          raceTime,
        })
      );
    } catch {
      // Ignore storage quota issues
    }
  }, [health, efforts, activities, planFocus, aiGeneratedPlan, targetRace, adaptedDays, raceDate, raceTime]);

  // Keep readiness condition fields synced with real health snapshot
  useEffect(() => {
    if (!health) {
      setConditions((prev) => ({ ...prev, use_readiness: false }));
      return;
    }
    setConditions((prev) => ({
      ...prev,
      hrv_status: health.hrv_status,
      sleep_score: health.sleep_score ?? 80,
      body_battery: health.body_battery ?? 75,
    }));
  }, [health]);

  // Check if server already has a configured Garmlink token on load
  useEffect(() => {
    let active = true;
    fetch('/api/garmlink/status')
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
  }, []);

  // Execute real Garmlink MCP sync
  const syncFromGarmlink = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride ?? garmlinkSessionRef.current;
      setGarmlink((prev) => ({ ...prev, syncing: true, error: null }));
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch('/api/garmlink/sync', { method: 'POST', headers });
        const data = (await res.json()) as {
          activities?: WatchActivity[];
          prs?: Effort[];
          health?: HealthSnapshot | null;
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

        if (data.prs && data.prs.length > 0) {
          setEfforts((prev) => {
            const byLabel = new Map<string, Effort>();
            for (const e of prev) byLabel.set(e.label, e);
            for (const pr of data.prs!) byLabel.set(pr.label, pr);
            return [...byLabel.values()].sort((a, b) => a.distance_m - b.distance_m);
          });
        }

        setGarmlink({
          connected: true,
          syncing: false,
          last_synced_at: data.synced_at ?? new Date().toISOString(),
          tools_discovered: data.tools_discovered ?? [],
          tools_called: data.tools_called ?? [],
          error:
            data.warnings && data.warnings.length > 0 && syncedActs.length === 0 && !data.health
              ? `Connected to Garmlink MCP (${data.tools_discovered?.length ?? 0} tools), but no matching activity/health records were returned: ${data.warnings[0]}`
              : null,
        });

        notify(
          `Synced Garmlink MCP: ${syncedActs.length} runs${
            data.health ? ' + recovery snapshot' : ''
          } (${data.tools_discovered?.length ?? 0} MCP tools available).`,
          'success'
        );
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
    const realVolume = computeVolumeFromActivities(activities);
    return new PredictionEngine(
      efforts,
      health?.vo2max ?? null,
      realVolume ?? { longest_run_miles: 8.91, avg_weekly_miles: 17.1 }
    );
  }, [efforts, health?.vo2max, activities]);

  const fitness = useMemo(() => engine.getFitnessMetrics(), [engine]);
  const zones = useMemo(() => engine.getTrainingZones(), [engine]);
  const activePrediction = useMemo(
    () => engine.predict(selectedDistance, conditions),
    [engine, selectedDistance, conditions]
  );

  // Build active training plan: AI-generated full plan if present, otherwise deterministic template + day overrides
  const trainingPlan = useMemo(() => {
    const base = aiGeneratedPlan ?? generateTrainingPlan(planFocus, zones, targetRace);
    if (Object.keys(adaptedDays).length === 0) return base;
    const schedule = base.schedule.map((w) => adaptedDays[w.day] ?? w);
    const weeklyMileage = Number(
      schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1)
    );
    return { ...base, weekly_mileage: weeklyMileage, schedule };
  }, [aiGeneratedPlan, planFocus, zones, targetRace, adaptedDays]);

  const handleSelectCourse = (courseId: string) => {
    setSelectedCourseId(courseId);
    setSyncedWeather(null);
    const course = PRESET_COURSES.find((c) => c.course_id === courseId);
    if (!course || courseId === 'custom') return;
    const defaultShoe =
      course.surface === 'xc'
        ? 'dragonfly_xc'
        : course.surface === 'track'
          ? 'dragonfly_track'
          : 'streakfly';
    setConditions((prev) => ({
      ...prev,
      surface: course.surface,
      shoe_type: defaultShoe,
      elevation_gain_ft: course.elevation_gain_ft,
      elevation_loss_ft: course.elevation_loss_ft,
      altitude_ft: course.altitude_ft,
    }));
  };

  // Generate full 7-day AI training plan from synced watch data & PRs
  const handleGenerateAiPlan = async (customGoal: string) => {
    setAiPlanLoading(true);
    setAiPlanError(null);
    try {
      const res = await fetch('/api/ai/generate-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          focus_id: planFocus,
          focus_label: TRAINING_FOCUS_LABELS[planFocus],
          custom_goal: customGoal,
          target_race: targetRace,
          activities: activities.slice(0, 14),
          health,
          fitness,
          zones,
        }),
      });
      const data = (await res.json()) as { plan?: TrainingPlan; error?: string };
      if (!res.ok || !data.plan) {
        throw new Error(data.error || `Failed to generate AI plan (HTTP ${res.status})`);
      }
      setAiGeneratedPlan(data.plan);
      setAdaptedDays({});
      notify(`Generated AI 7-day plan: ${data.plan.title} (${data.plan.weekly_mileage} mpw).`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate AI plan';
      setAiPlanError(msg);
      notify(msg, 'error');
    } finally {
      setAiPlanLoading(false);
    }
  };

  // Generate a single custom AI workout for a specific day
  const handleGenerateSingleWorkout = async (day: string, goalPrompt: string) => {
    setAiWorkoutLoading(true);
    setAiPlanError(null);
    try {
      const res = await fetch('/api/ai/generate-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          day,
          goal_prompt: goalPrompt,
          activities: activities.slice(0, 10),
          health,
          fitness,
          zones,
          current_plan: {
            title: trainingPlan.title,
            weekly_mileage: trainingPlan.weekly_mileage,
            target_race: targetRace,
          },
        }),
      });
      const data = (await res.json()) as { workout?: DailyWorkout; error?: string };
      if (!res.ok || !data.workout) {
        throw new Error(data.error || `Failed to build workout (HTTP ${res.status})`);
      }
      setAdaptedDays((prev) => ({ ...prev, [day]: data.workout! }));
      notify(`Built AI workout for ${day}: ${data.workout.name} (${data.workout.distance_miles} mi).`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create AI workout';
      setAiPlanError(msg);
      notify(msg, 'error');
    } finally {
      setAiWorkoutLoading(false);
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

      const res = await fetch('/api/ai/coach', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: text,
          history: nextHistory
            .filter((m) => m.id !== 'welcome' && !m.error)
            .map((m) => ({ role: m.role, content: m.content })),
          context: {
            today: getTodayDayName(),
            garmlink_connected: garmlink.connected,
            synced_activities_count: activities.length,
            recent_activities: activities.slice(0, 12),
            health,
            fitness,
            zones,
            active_prediction: activePrediction,
            active_course:
              PRESET_COURSES.find((c) => c.course_id === selectedCourseId)?.name ?? 'Custom',
            race_schedule: { date: raceDate, time: raceTime, weather: syncedWeather },
            conditions,
            training_plan: {
              title: trainingPlan.title,
              weekly_mileage: trainingPlan.weekly_mileage,
              schedule: trainingPlan.schedule.map((w) => ({
                day: w.day,
                name: w.name,
                distance_miles: w.distance_miles,
                pace_target: w.pace_target,
              })),
            },
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
          const day = String(tc.args.day || getTodayDayName());
          const updated: DailyWorkout = {
            day,
            name: String(tc.args.name || 'AI Workout'),
            workout_type: (tc.args.workout_type as WorkoutType) || 'easy',
            distance_miles: Number(tc.args.distance_miles ?? 3.0),
            pace_target: String(tc.args.pace_target || zones.easy.label),
            hr_cap: String(tc.args.hr_cap || '< 145 bpm'),
            description: String(tc.args.description || ''),
            injury_prevention_note: String(tc.args.injury_prevention_note || ''),
            ai_generated: true,
            adaptation_reason: String(tc.args.reason || 'Created by AI Coach'),
          };
          setAdaptedDays((prev) => ({ ...prev, [day]: updated }));
          appliedLabels.push(`Updated ${day}: ${updated.name} (${updated.distance_miles} mi)`);
        } else if (tc.name === 'schedule_race_taper') {
          const race_name = String(tc.args.race_name || 'Target Race');
          const race_dist = String(tc.args.race_dist || '5K');
          const race_day = String(tc.args.race_day || 'Thursday');
          setAiGeneratedPlan(null);
          setTargetRace({ name: race_name, dist: race_dist, day: race_day });
          setAdaptedDays({});
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
    { id: 'watch', label: 'Watch Sync', icon: Watch },
    { id: 'plan', label: 'AI Training Plan', icon: CalendarDays },
    { id: 'predictor', label: 'Race Predictor', icon: Gauge },
    { id: 'coach', label: 'AI Coach', icon: MessageSquareText },
  ];

  const activeBreadcrumb =
    navItems.find((n) => n.id === activeTab)?.label ?? 'Watch Sync';

  return (
    <div className="min-h-screen bg-[#090D12] text-[#F3F6FA]">
      {/* Toast Notifications (anchored below top bar so bottom CTAs stay unobstructed) */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed top-16 right-4 z-50 flex max-w-sm flex-col gap-2"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start justify-between gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs font-medium shadow-xl ${
                t.tone === 'success'
                  ? 'border-emerald-500/40 bg-[#0D1E18]/95 text-emerald-200'
                  : t.tone === 'error'
                    ? 'border-rose-500/40 bg-[#241015]/95 text-rose-200'
                    : 'border-sky-500/40 bg-[#0E1A2A]/95 text-sky-200'
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
        <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800/80 bg-[#0C1118] lg:flex">
          <div className="flex h-14 items-center border-b border-slate-800/80 px-5">
            <span className="font-display text-lg font-extrabold tracking-tight text-slate-50 whitespace-nowrap">
              Race<span className="text-sky-400">Kit</span>
            </span>
          </div>

          <nav className="flex-1 space-y-1 p-3" aria-label="Primary navigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-sky-500/12 text-sky-300'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Athlete Summary Footer */}
          <div className="border-t border-slate-800/80 p-4 text-xs">
            <div className="font-medium text-slate-200">Ephraim Yourek</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-400">
              VDOT {fitness.vo2max ?? '—'} · CS {fitness.critical_speed_pace}
            </div>
            <div className="mt-2 font-mono text-[11px] tabular-nums text-slate-500">
              5K Forecast: {activePrediction.time_fmt}
            </div>
          </div>
        </aside>

        {/* Mobile Slide-Over Navigation Drawer */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div
              className="fixed inset-0 bg-black/70"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <aside className="relative z-10 flex w-64 flex-col border-r border-slate-800 bg-[#0C1118]">
              <div className="flex h-14 items-center justify-between border-b border-slate-800 px-5">
                <span className="font-display text-lg font-extrabold tracking-tight text-slate-50">
                  Race<span className="text-sky-400">Kit</span>
                </span>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close navigation menu"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <nav className="flex-1 space-y-1 p-3" aria-label="Mobile navigation">
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
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-sky-500/12 text-sky-300'
                          : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>
          </div>
        )}

        {/* Main Workspace Column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top Bar: Breadcrumb on left, 1 Garmlink Watch action on right */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-slate-800/80 bg-[#090D12]/95 px-4 backdrop-blur-sm lg:px-8">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation menu"
                className="rounded-md p-2 text-slate-300 hover:bg-slate-800 lg:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-2 text-sm truncate">
                <span className="hidden font-semibold text-slate-400 whitespace-nowrap sm:inline">
                  RaceKit
                </span>
                <span className="hidden text-slate-600 sm:inline" aria-hidden="true">/</span>
                <span className="font-semibold text-slate-100 truncate">{activeBreadcrumb}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {garmlink.connected ? (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('watch');
                    void syncFromGarmlink();
                  }}
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20 whitespace-nowrap shrink-0"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Garmlink Synced</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('watch');
                    void handleConnectGarmlink();
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 whitespace-nowrap shrink-0"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Connect Garmlink
                </button>
              )}
            </div>
          </header>

          {/* Main Content Viewport */}
          <main className="mx-auto w-full max-w-[1220px] flex-1 px-4 py-6 lg:px-8 lg:py-8">
            {activeTab === 'watch' && (
              <WatchSyncView
                garmlink={garmlink}
                health={health}
                activities={activities}
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
            )}

            {activeTab === 'plan' && (
              <TrainingPlanView
                focus={planFocus}
                plan={trainingPlan}
                targetRace={targetRace}
                hasCustomAiPlan={Boolean(aiGeneratedPlan) || Object.keys(adaptedDays).length > 0}
                activities={activities}
                health={health}
                aiPlanLoading={aiPlanLoading}
                aiWorkoutLoading={aiWorkoutLoading}
                aiError={aiPlanError}
                onChangeFocus={(next) => {
                  setPlanFocus(next);
                  setAiGeneratedPlan(null);
                  setAdaptedDays({});
                }}
                onGenerateAiPlan={(goal) => void handleGenerateAiPlan(goal)}
                onGenerateSingleWorkout={(day, goal) => void handleGenerateSingleWorkout(day, goal)}
                onSetTargetRace={(race) => {
                  setAiGeneratedPlan(null);
                  setTargetRace(race);
                  setAdaptedDays({});
                  notify(
                    `Race-week taper scheduled for ${race.name} (${race.dist}) on ${race.day}.`,
                    'success'
                  );
                }}
                onClearTargetRace={() => {
                  setTargetRace(null);
                  setAdaptedDays({});
                  notify('Cleared race-week taper.', 'info');
                }}
                onResetToBasePlan={() => {
                  setAiGeneratedPlan(null);
                  setAdaptedDays({});
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
                efforts={efforts}
                hasSyncedHealth={Boolean(health)}
                selectedDistance={selectedDistance}
                selectedCourseId={selectedCourseId}
                conditions={conditions}
                raceDate={raceDate}
                raceTime={raceTime}
                syncedWeather={syncedWeather}
                onSelectDistance={setSelectedDistance}
                onSelectCourse={handleSelectCourse}
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
                activities={activities}
                health={health}
                prefillPrompt={coachPrefill}
                onConsumePrefill={() => setCoachPrefill(null)}
                onSendMessage={handleSendCoachMessage}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
