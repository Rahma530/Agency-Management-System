import React, { useState } from 'react';
import { KeyRound, Eye, EyeOff, AlertCircle, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface SetPasswordScreenProps {
  // Called once supabase.auth.updateUser({ password }) succeeds — the
  // caller is responsible for resolving the now-normal session back to a
  // UserRecord and completing login (see App.tsx's
  // handlePasswordRecoveryComplete).
  onComplete: () => void;
}

// Shown instead of logging someone straight into the app when their
// session arrived via a PASSWORD_RECOVERY event (a provisioning or
// password-reset link). Recovery links are correctly single-use — this
// screen is what makes that one use actually set a durable password,
// instead of just leaking the person into the app on a token that then
// can never be used again.
export const SetPasswordScreen: React.FC<SetPasswordScreenProps> = ({ onComplete }) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      onComplete();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Unable to set your password. Please try again or request a new link.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 font-sans text-[#e9d9fb] relative"
      dir="ltr"
      style={{ background: 'var(--gradient-page)' }}
    >
      {/* Background ambient lighting */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute -top-32 right-1/3 w-96 h-96 rounded-full blur-[150px] opacity-25"
          style={{ background: 'var(--purple-dark)' }}
        />
        <div
          className="absolute -bottom-32 left-1/3 w-96 h-96 rounded-full blur-[150px] opacity-20"
          style={{ background: '#3b82f6' }}
        />
      </div>

      <div className="relative w-full max-w-md">
        {/* Header Branding */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-2xl border"
            style={{ background: 'var(--gradient-badge)', borderColor: 'var(--border-strong)' }}
          >
            <KeyRound className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white mb-2">
            Set Your Password
          </h1>
          <p className="text-xs sm:text-sm text-[#a89bb8]">
            Choose a password to finish setting up your account
          </p>
        </div>

        {/* Form Card */}
        <div
          className="rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl border relative"
          style={{ background: 'rgba(21, 16, 32, 0.88)', borderColor: 'var(--border-strong)' }}
        >
          <div className="mb-6">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-purple-400" />
              <span>New Password</span>
            </h2>
            <p className="text-xs text-[#a89bb8] mt-1">
              This link is single-use — once your password is set, sign in normally from now on
            </p>
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
              <label className="block text-xs font-semibold text-stone-300 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="At least 8 characters"
                  dir="ltr"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  minLength={8}
                  className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-3 pl-4 pr-10 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all font-mono disabled:opacity-50"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-3.5 text-stone-400 hover:text-white transition-colors"
                  tabIndex={-1}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-300 mb-1.5">Confirm Password</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                }}
                placeholder="Re-enter your password"
                dir="ltr"
                autoComplete="new-password"
                disabled={isSubmitting}
                minLength={8}
                className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-3 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all font-mono disabled:opacity-50"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-bold text-white shadow-lg transition-all hover:opacity-90 disabled:opacity-60 mt-2"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              <ShieldCheck className="w-4 h-4" />
              {isSubmitting ? 'Setting password...' : 'Set Password & Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
