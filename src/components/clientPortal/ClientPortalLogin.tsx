import React, { useState } from 'react';
import { Lock, Mail, Eye, EyeOff, Building2, AlertCircle, KeyRound } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface ClientPortalLoginProps {
  onLoggedIn: () => void;
}

// Two explicit, user-chosen modes rather than the app trying to auto-detect "is this a first-time
// visitor" — that would require reading client_portal_users before authentication, which isn't
// possible (the table has no grant for the anon role, deliberately: nothing about who's been
// invited should be readable pre-auth). The AM already tells a new client out of band that
// they're setting up an account for the first time, so asking them to pick the right mode
// themselves is a completely normal login-screen pattern, not a UX gap.
export const ClientPortalLogin: React.FC<ClientPortalLoginProps> = ({ onLoggedIn }) => {
  const [mode, setMode] = useState<'signin' | 'activate'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const isValidEmail = (val: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);

  const handleSignIn = async (trimmedEmail: string, trimmedPassword: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password: trimmedPassword });
    if (error) {
      setErrorMessage(error.message || 'Incorrect email or password.');
      return false;
    }
    return true;
  };

  const handleActivate = async (trimmedEmail: string, trimmedPassword: string) => {
    const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
      email: trimmedEmail,
      password: trimmedPassword,
    });
    if (signUpErr || !signUpData?.session?.user) {
      setErrorMessage(signUpErr?.message || 'Unable to set up your account. Please try again.');
      return false;
    }

    // Claim the pre-provisioned invite row matching this exact email — gated by
    // client_portal_users_claim_rls, which only permits linking a row that's still unclaimed and
    // whose email matches this session's own. A 0-row result means no invite was ever created
    // for this email — the account now exists in Supabase Auth but isn't linked to any client.
    const { data: claimed, error: claimErr } = await supabase
      .from('client_portal_users')
      .update({ auth_id: signUpData.session.user.id })
      .eq('email', trimmedEmail)
      .select();

    if (claimErr || !claimed || claimed.length === 0) {
      setErrorMessage(
        'We could not find a pending portal invite for this email. Please contact your Account Manager to be invited before setting up your account.'
      );
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPassword = password.trim();

    if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (!trimmedPassword) {
      setErrorMessage(mode === 'signin' ? 'Please enter your password.' : 'Please choose a password.');
      return;
    }
    if (mode === 'activate' && trimmedPassword.length < 8) {
      setErrorMessage('Password must be at least 8 characters.');
      return;
    }

    setIsLoading(true);
    try {
      const success = mode === 'signin' ? await handleSignIn(trimmedEmail, trimmedPassword) : await handleActivate(trimmedEmail, trimmedPassword);
      if (success) onLoggedIn();
    } catch (err: any) {
      setErrorMessage(err?.message || 'An unexpected error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 font-sans text-[#e9d9fb] relative"
      dir="ltr"
      style={{ background: 'var(--gradient-page)' }}
    >
      <div className="relative w-full max-w-md">
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-2xl border"
            style={{ background: 'var(--gradient-badge)', borderColor: 'var(--border-strong)' }}
          >
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white mb-2">Client Portal</h1>
          <p className="text-xs sm:text-sm text-[#a89bb8]">Your reports and performance, in one place</p>
        </div>

        <div
          className="rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl border relative"
          style={{ background: 'rgba(21, 16, 32, 0.88)', borderColor: 'var(--border-strong)' }}
        >
          <div className="flex items-center gap-1 p-1 mb-6 rounded-xl bg-stone-900 border border-stone-800">
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setErrorMessage(null);
              }}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                mode === 'signin' ? 'bg-purple-600/40 text-white' : 'text-stone-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('activate');
                setErrorMessage(null);
              }}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                mode === 'activate' ? 'bg-purple-600/40 text-white' : 'text-stone-400 hover:text-white'
              }`}
            >
              First Time? Set Up Account
            </button>
          </div>

          {errorMessage && (
            <div
              className="mb-5 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border animate-fadeIn"
              style={{ background: 'rgba(245, 163, 163, 0.12)', borderColor: 'var(--roas-bad)', color: 'var(--roas-bad)' }}
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-stone-300 mb-1.5">Email</label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="you@company.com"
                  dir="ltr"
                  autoComplete="email"
                  disabled={isLoading}
                  className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-3 pl-10 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all font-mono disabled:opacity-50"
                  required
                />
                <Mail className="absolute left-3.5 top-3.5 w-4 h-4 text-purple-400/70 pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-300 mb-1.5">
                {mode === 'signin' ? 'Password' : 'Choose a Password'}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="••••••••"
                  dir="ltr"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  disabled={isLoading}
                  className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-3 pl-10 pr-10 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all font-mono disabled:opacity-50"
                  required
                />
                <KeyRound className="absolute left-3.5 top-3.5 w-4 h-4 text-purple-400/70 pointer-events-none" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-3.5 text-stone-400 hover:text-white transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {mode === 'activate' && <p className="text-[10px] text-stone-500 mt-1.5">At least 8 characters.</p>}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-3 py-3 px-4 rounded-xl text-sm font-bold text-white shadow-xl transition-all flex items-center justify-center gap-2 hover:opacity-95 active:scale-[0.99] disabled:opacity-50"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>{mode === 'signin' ? 'Signing in...' : 'Setting up...'}</span>
                </>
              ) : (
                <span>{mode === 'signin' ? 'Sign In' : 'Activate Account'}</span>
              )}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-purple-900/30 flex items-center gap-1 text-[11px] text-stone-400">
            <Lock className="w-3 h-3 text-purple-400" />
            <span>Access to your own account data only.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
