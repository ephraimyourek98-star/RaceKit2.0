import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Lock,
  Mail,
  Sparkles,
  User,
  X,
  Zap,
} from 'lucide-react';
import {
  isSupabaseConfigured,
  resetUserPassword,
  signInWithEmailPassword,
  signInWithGoogle,
  signUpWithEmailPassword,
  startDemoModeSession,
  type UserProfile,
} from '../lib/supabaseClient';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUserAuthenticated: (user: UserProfile) => void;
  currentUser: UserProfile | null;
  onSignOut: () => void;
}

export function AuthModal({
  isOpen,
  onClose,
  onUserAuthenticated,
  currentUser,
  onSignOut,
}: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setLoading(true);
    try {
      const { error } = await signInWithGoogle();
      if (error) {
        setErrorMsg(error.message);
      }
      // When Supabase is configured, this initiates external Google OAuth redirect to accounts.google.com
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (mode === 'login') {
        const { user, error } = await signInWithEmailPassword(email, password);
        if (error) throw error;
        if (user) {
          onUserAuthenticated(user);
          onClose();
        }
      } else if (mode === 'signup') {
        const { user, error } = await signUpWithEmailPassword(email, password, name);
        if (error) throw error;
        if (user) {
          onUserAuthenticated(user);
          onClose();
        }
      } else if (mode === 'forgot') {
        const { error } = await resetUserPassword(email);
        if (error) throw error;
        setSuccessMsg(`Password reset instructions sent to ${email}. Check your inbox.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoMode = () => {
    const demo = startDemoModeSession();
    onUserAuthenticated(demo);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
      <div
        className="relative w-full max-w-md rounded-3xl border border-white/10 bg-[#1C1C1E] p-6 shadow-2xl text-white"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-5 rounded-full p-1.5 text-[#8E8E93] hover:text-white hover:bg-white/10 transition-colors"
          aria-label="Close dialog"
        >
          <X className="h-5 w-5" />
        </button>

        {currentUser ? (
          /* Active Account State */
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0A84FF]/20 text-[#0A84FF]">
                <User className="h-6 w-6" />
              </div>
              <div>
                <h2 id="auth-modal-title" className="text-lg font-bold text-white">
                  {currentUser.name}
                </h2>
                <p className="text-xs text-[#8E8E93]">
                  {currentUser.is_demo ? 'Guest Demo Account' : currentUser.email}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#2C2C2E]/60 p-4 space-y-2 text-xs">
              <div className="flex justify-between text-[#8E8E93]">
                <span>Account Type:</span>
                <span className="font-semibold text-white">
                  {currentUser.is_demo ? 'Demo / Guest' : 'Authenticated Runner'}
                </span>
              </div>
              <div className="flex justify-between text-[#8E8E93]">
                <span>Weekly Volume Target:</span>
                <span className="font-semibold text-white">{currentUser.weekly_target_miles} mpw</span>
              </div>
              <div className="flex justify-between text-[#8E8E93]">
                <span>Data Isolation:</span>
                <span className="font-semibold text-[#30D158]">Active (Private Sandbox)</span>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  onSignOut();
                  setMode('login');
                }}
                className="flex-1 rounded-2xl border border-rose-500/30 bg-rose-500/10 py-3 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 transition-colors cursor-pointer"
              >
                Sign Out
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl bg-[#0A84FF] py-3 text-xs font-semibold text-white hover:bg-[#0071E3] transition-colors cursor-pointer"
              >
                Continue Training
              </button>
            </div>
          </div>
        ) : (
          /* Sign In / Sign Up Form */
          <div className="space-y-4">
            <div className="text-center space-y-1">
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0A84FF]/20 text-[#0A84FF] mb-1">
                <Zap className="h-5 w-5" />
              </div>
              <h2 id="auth-modal-title" className="text-xl font-bold tracking-tight text-white">
                {mode === 'login'
                  ? 'Sign in to RaceKit'
                  : mode === 'signup'
                    ? 'Create RaceKit Account'
                    : 'Reset Password'}
              </h2>
              <p className="text-xs text-[#8E8E93]">
                {mode === 'forgot'
                  ? 'Enter your email to receive recovery instructions.'
                  : 'Multi-model race predictions, critical speed modeling & coach.'}
              </p>
            </div>

            {/* Honest Supabase Configuration Banner when env vars are missing */}
            {!isSupabaseConfigured && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                <div className="flex items-center gap-2 font-semibold text-amber-300 mb-1">
                  <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
                  <span>Supabase Auth Not Configured</span>
                </div>
                <p className="text-[11px] text-amber-200/90 leading-relaxed">
                  Add <code className="rounded bg-black/40 px-1 py-0.5 text-amber-300 font-mono">VITE_SUPABASE_URL</code> and{' '}
                  <code className="rounded bg-black/40 px-1 py-0.5 text-amber-300 font-mono">VITE_SUPABASE_ANON_KEY</code> to your{' '}
                  <code className="rounded bg-black/40 px-1 py-0.5 text-amber-300 font-mono">.env</code> file to enable real Google OAuth and Email accounts. Or try <strong>Demo Mode</strong> below for instant preview.
                </p>
              </div>
            )}

            {errorMsg && (
              <div className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/15 p-3 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/15 p-3 text-xs text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* Google OAuth (Primary OAuth Button) */}
            {mode !== 'forgot' && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-3 rounded-2xl border border-white/15 bg-white py-3 px-4 text-xs font-semibold text-slate-900 hover:bg-slate-100 transition-all shadow-sm active:scale-[0.99] disabled:opacity-60 cursor-pointer"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span>Continue with Google</span>
                </button>

                <div className="relative flex items-center justify-center">
                  <div className="w-full border-t border-white/10" />
                  <span className="relative bg-[#1C1C1E] px-3 text-[11px] font-semibold text-[#8E8E93] uppercase tracking-wider">
                    or with email
                  </span>
                </div>
              </div>
            )}

            {/* Email / Password Form */}
            <form onSubmit={handleSubmit} className="space-y-3">
              {mode === 'signup' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                    Your Name
                  </label>
                  <div className="relative">
                    <User className="absolute left-3.5 top-3 h-4 w-4 text-[#8E8E93]" />
                    <input
                      type="text"
                      required
                      placeholder="e.g. Alex"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E]/80 py-2.5 pl-10 pr-4 text-xs text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-[#8E8E93] mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-3 h-4 w-4 text-[#8E8E93]" />
                  <input
                    type="email"
                    required
                    placeholder="runner@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E]/80 py-2.5 pl-10 pr-4 text-xs text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                  />
                </div>
              </div>

              {mode !== 'forgot' && (
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-[11px] font-semibold text-[#8E8E93]">
                      Password
                    </label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot');
                          setErrorMsg(null);
                        }}
                        className="text-[11px] font-semibold text-[#0A84FF] hover:underline"
                      >
                        Forgot?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-3 h-4 w-4 text-[#8E8E93]" />
                    <input
                      type="password"
                      required
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-2xl border border-white/10 bg-[#2C2C2E]/80 py-2.5 pl-10 pr-4 text-xs text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-2xl bg-[#0A84FF] py-3 text-xs font-semibold text-white hover:bg-[#0071E3] transition-all active:scale-[0.99] disabled:opacity-60 cursor-pointer shadow-md shadow-[#0A84FF]/20"
              >
                {loading
                  ? 'Please wait…'
                  : mode === 'login'
                    ? 'Log In'
                    : mode === 'signup'
                      ? 'Create Account'
                      : 'Send Reset Link'}
              </button>
            </form>

            {/* Toggle Modes */}
            <div className="pt-2 text-center text-xs text-[#8E8E93]">
              {mode === 'login' ? (
                <span>
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signup');
                      setErrorMsg(null);
                    }}
                    className="font-bold text-[#0A84FF] hover:underline cursor-pointer"
                  >
                    Sign Up
                  </button>
                </span>
              ) : (
                <span>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setErrorMsg(null);
                    }}
                    className="font-bold text-[#0A84FF] hover:underline cursor-pointer"
                  >
                    Log In
                  </button>
                </span>
              )}
            </div>

            {/* Try Demo Mode Button (Clean Apple Glass Pill) */}
            <div className="pt-3 border-t border-white/10 text-center">
              <button
                type="button"
                onClick={handleDemoMode}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-[#2C2C2E]/60 py-2.5 px-4 text-xs font-semibold text-[#8E8E93] hover:text-white hover:bg-[#2C2C2E] transition-all cursor-pointer"
              >
                <Sparkles className="h-3.5 w-3.5 text-[#0A84FF]" />
                <span>Try Demo Mode (Instant Preview)</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
