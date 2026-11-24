import { createClient } from '@supabase/supabase-js';
import type { DailyWorkout, Effort, HealthSnapshot, TrainingFocusId, WatchActivity } from './types';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  is_demo: boolean;
  weekly_target_miles: number;
  longest_run_miles: number;
  garmlink_connected?: boolean;
  created_at: string;
}

const RAW_SUPABASE_URL = (import.meta.env?.VITE_SUPABASE_URL as string) || '';
const SUPABASE_URL = RAW_SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '').trim();
const RAW_ANON_KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string) || '';
const SUPABASE_ANON_KEY = RAW_ANON_KEY.replace(/^-[a-zA-Z]-/, '').trim();

export const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes('your-project') &&
    !SUPABASE_ANON_KEY.includes('your-anon-key')
);

// Real Supabase client instance (null if env vars are unset)
export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;

const DEMO_USER_ID = 'demo-guest-preview';
const ACTIVE_SESSION_KEY = 'racekit_active_session';

// ── Authentication API ─────────────────────────────────────────────────────

export async function getCurrentUser(): Promise<UserProfile | null> {
  if (supabase) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const u = session.user;
        const name =
          u.user_metadata?.full_name ||
          u.user_metadata?.name ||
          (u.email ? u.email.split('@')[0] : 'Athlete');
        return {
          id: u.id,
          email: u.email || '',
          name,
          avatar_url: u.user_metadata?.avatar_url,
          is_demo: false,
          weekly_target_miles: 30,
          longest_run_miles: 10,
          created_at: u.created_at,
        };
      }
    } catch (err) {
      console.warn('Error fetching Supabase session:', err);
    }
  }

  // Check if active session is an explicit Demo Mode session
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as UserProfile;
      if (parsed && parsed.is_demo) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function onAuthStateChanged(callback: (user: UserProfile | null) => void): () => void {
  if (!supabase) return () => {};
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
      const u = session.user;
      const name =
        u.user_metadata?.full_name ||
        u.user_metadata?.name ||
        (u.email ? u.email.split('@')[0] : 'Athlete');
      callback({
        id: u.id,
        email: u.email || '',
        name,
        avatar_url: u.user_metadata?.avatar_url,
        is_demo: false,
        weekly_target_miles: 30,
        longest_run_miles: 10,
        created_at: u.created_at,
      });
    } else {
      callback(null);
    }
  });
  return () => {
    subscription.unsubscribe();
  };
}

export async function signInWithGoogle(): Promise<{ error: Error | null }> {
  if (!supabase) {
    return {
      error: new Error(
        'Supabase Auth is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env to enable real Google OAuth.'
      ),
    };
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
    },
  });

  return { error: error ? new Error(error.message) : null };
}

export async function signInWithEmailPassword(
  email: string,
  pass: string
): Promise<{ user: UserProfile | null; error: Error | null }> {
  if (!supabase) {
    return {
      user: null,
      error: new Error(
        'Supabase Auth is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env to log in with email.'
      ),
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password: pass,
  });

  if (error) return { user: null, error: new Error(error.message) };
  if (data.user) {
    const u = data.user;
    const name =
      u.user_metadata?.full_name ||
      u.user_metadata?.name ||
      cleanEmail.split('@')[0];
    const user: UserProfile = {
      id: u.id,
      email: u.email || cleanEmail,
      name,
      avatar_url: u.user_metadata?.avatar_url,
      is_demo: false,
      weekly_target_miles: 30,
      longest_run_miles: 10,
      created_at: u.created_at,
    };
    return { user, error: null };
  }

  return { user: null, error: new Error('Failed to retrieve user session.') };
}

export async function signUpWithEmailPassword(
  email: string,
  pass: string,
  name?: string
): Promise<{ user: UserProfile | null; error: Error | null }> {
  if (!supabase) {
    return {
      user: null,
      error: new Error(
        'Supabase Auth is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env to create an account.'
      ),
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  const displayName = name?.trim() || cleanEmail.split('@')[0] || 'Athlete';

  if (pass.length < 6) {
    return { user: null, error: new Error('Password must be at least 6 characters.') };
  }

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password: pass,
    options: {
      data: { full_name: displayName },
    },
  });

  if (error) return { user: null, error: new Error(error.message) };
  if (data.user) {
    const user: UserProfile = {
      id: data.user.id,
      email: data.user.email || cleanEmail,
      name: displayName,
      is_demo: false,
      weekly_target_miles: 30,
      longest_run_miles: 10,
      created_at: data.user.created_at,
    };
    return { user, error: null };
  }

  return { user: null, error: new Error('Sign up failed.') };
}

export async function resetUserPassword(email: string): Promise<{ error: Error | null }> {
  if (!supabase) {
    return {
      error: new Error(
        'Supabase Auth is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env to reset password.'
      ),
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  return { error: error ? new Error(error.message) : null };
}

export function startDemoModeSession(): UserProfile {
  const demoProfile: UserProfile = {
    id: DEMO_USER_ID,
    email: 'guest@racekit.ai',
    name: 'Guest Athlete (Demo)',
    is_demo: true,
    weekly_target_miles: 25,
    longest_run_miles: 8.5,
    created_at: new Date().toISOString(),
  };
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(demoProfile));
  return demoProfile;
}

export async function signOutUser(): Promise<void> {
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
  }
  localStorage.removeItem(ACTIVE_SESSION_KEY);
}

// ── Per-User Data Isolation Helpers ────────────────────────────────────────

export function getUserStorageKey(userId: string, dataKey: string): string {
  return `racekit_user_${userId}_${dataKey}`;
}

export function loadUserWorkouts(
  userId: string,
  focus: TrainingFocusId
): Record<string, DailyWorkout> {
  try {
    const key = getUserStorageKey(userId, `workouts_${focus}`);
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveUserWorkouts(
  userId: string,
  focus: TrainingFocusId,
  workouts: Record<string, DailyWorkout>
): void {
  try {
    const key = getUserStorageKey(userId, `workouts_${focus}`);
    localStorage.setItem(key, JSON.stringify(workouts));
  } catch (err) {
    console.warn(`Failed to save workouts for user ${userId}:`, err);
  }
}

export function loadUserTargetRace(userId: string): { name: string; dist: string; day: string } | null {
  try {
    const key = getUserStorageKey(userId, 'target_race');
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveUserTargetRace(
  userId: string,
  race: { name: string; dist: string; day: string } | null
): void {
  try {
    const key = getUserStorageKey(userId, 'target_race');
    if (race) {
      localStorage.setItem(key, JSON.stringify(race));
    } else {
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn(`Failed to save target race for user ${userId}:`, err);
  }
}

export function loadUserPRs(userId: string): Effort[] | null {
  try {
    const key = getUserStorageKey(userId, 'prs');
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveUserPRs(userId: string, prs: Effort[]): void {
  try {
    const key = getUserStorageKey(userId, 'prs');
    localStorage.setItem(key, JSON.stringify(prs));
  } catch (err) {
    console.warn(`Failed to save PRs for user ${userId}:`, err);
  }
}

export function loadUserTelemetry(userId: string): { health: HealthSnapshot | null; activities: WatchActivity[] } | null {
  try {
    const key = getUserStorageKey(userId, 'telemetry');
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveUserTelemetry(
  userId: string,
  telemetry: { health: HealthSnapshot | null; activities: WatchActivity[] }
): void {
  try {
    const key = getUserStorageKey(userId, 'telemetry');
    localStorage.setItem(key, JSON.stringify(telemetry));
  } catch (err) {
    console.warn(`Failed to save telemetry for user ${userId}:`, err);
  }
}
