import React, { useState } from 'react';
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  Building2,
  AlertCircle,
  ArrowLeft,
  KeyRound,
  CheckCircle2,
  HelpCircle,
  X,
} from 'lucide-react';
import { UserRecord } from '../types/database';
import { isActiveEmployee } from '../lib/permissions';
import { getRoleInfo } from '../data/roles';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

interface EmployeeLoginProps {
  users: UserRecord[];
  onLoginSuccess: (user: UserRecord) => void;
  supabaseActive: boolean;
}

export const EmployeeLogin: React.FC<EmployeeLoginProps> = ({
  users,
  onLoginSuccess,
  supabaseActive,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);

  // Demo login (no-password instant sign-in) is opt-in via env flag, off by default
  const isDemoLoginEnabled = import.meta.env.VITE_ENABLE_DEMO_LOGIN === 'true';

  // Email format validation helper
  const isValidEmail = (val: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPassword = password.trim();

    // 1. Validation
    if (!trimmedEmail) {
      setErrorMessage('Please enter your employee email address.');
      return;
    }

    if (!isValidEmail(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    if (!trimmedPassword) {
      setErrorMessage('Please enter your password.');
      return;
    }

    setIsLoading(true);

    try {
      // Authenticate exclusively against Supabase Auth
      const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password: trimmedPassword,
      });

      if (authErr || !authData?.user) {
        setErrorMessage(authErr?.message || 'Incorrect email or password.');
        setIsLoading(false);
        return;
      }

      // Retrieve the employee's profile from the database 'users' table by auth_id or email
      const { data: dbUser, error: dbErr } = await supabase
        .from('users')
        .select('*')
        .or(`auth_id.eq.${authData.user.id},email.eq.${trimmedEmail}`)
        .single();

      if (dbErr || !dbUser) {
        setErrorMessage('No employee profile found for this account. Please contact your administrator.');
        setIsLoading(false);
        return;
      }

      if (rememberMe) {
        try {
          localStorage.setItem('agency_auth_user_id', dbUser.id);
        } catch {}
      }
      onLoginSuccess(dbUser as UserRecord);
    } catch (err: any) {
      setErrorMessage(
        err?.message || 'An unexpected error occurred during login. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Demo mode only: sign in instantly as the chosen role, no password required
  const handleDemoLogin = (user: UserRecord) => {
    if (rememberMe) {
      try {
        localStorage.setItem('agency_auth_user_id', user.id);
      } catch {}
    }
    setShowDemoModal(false);
    onLoginSuccess(user);
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
            style={{
              background: 'var(--gradient-badge)',
              borderColor: 'var(--border-strong)',
            }}
          >
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white mb-2">
            Agency Management System
          </h1>
          <p className="text-xs sm:text-sm text-[#a89bb8]">
            Employee Authentication Portal
          </p>

          <div
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs"
            style={{
              background: supabaseActive ? 'rgba(169, 245, 193, 0.12)' : 'rgba(216, 180, 254, 0.12)',
              border: `1px solid ${supabaseActive ? 'var(--roas-good)' : 'var(--border-soft)'}`,
              color: supabaseActive ? 'var(--roas-good)' : '#d8b4fe',
            }}
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Role-Based Access Control Active</span>
          </div>
        </div>

        {/* Login Form Card */}
        <div
          className="rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl border relative"
          style={{
            background: 'rgba(21, 16, 32, 0.88)',
            borderColor: 'var(--border-strong)',
          }}
        >
          <div className="mb-6">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-purple-400" />
              <span>Sign In</span>
            </h2>
            <p className="text-xs text-[#a89bb8] mt-1">
              Enter your work email and password to access your role portal
            </p>
          </div>

          {/* Error Message Alert */}
          {errorMessage && (
            <div
              className="mb-5 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border animate-fadeIn"
              style={{
                background: 'rgba(245, 163, 163, 0.12)',
                borderColor: 'var(--roas-bad)',
                color: 'var(--roas-bad)',
              }}
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email Field */}
            <div>
              <label className="block text-xs font-semibold text-stone-300 mb-1.5">
                Work Email
              </label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="employee@agency.com"
                  dir="ltr"
                  autoComplete="email"
                  disabled={isLoading}
                  className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-3 pl-10 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all font-mono disabled:opacity-50"
                  required
                />
                <Mail className="absolute left-3.5 top-3.5 w-4 h-4 text-purple-400/70 pointer-events-none" />
              </div>
            </div>

            {/* Password Field */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-semibold text-stone-300">
                  Password
                </label>
              </div>
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
                  autoComplete="current-password"
                  disabled={isLoading}
                  className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-3 pl-10 pr-10 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all font-mono disabled:opacity-50"
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

            {/* Remember Me Checkbox */}
            <div className="flex items-center justify-between text-xs pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none text-stone-300">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded border-purple-800 text-purple-600 focus:ring-purple-500 bg-[#110d1c]"
                />
                <span>Remember session</span>
              </label>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-3 py-3 px-4 rounded-xl text-sm font-bold text-white shadow-xl transition-all flex items-center justify-center gap-2 hover:opacity-95 active:scale-[0.99] disabled:opacity-50"
              style={{
                background: 'var(--gradient-badge)',
                border: '1px solid var(--border-strong)',
              }}
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Verifying credentials...</span>
                </>
              ) : (
                <>
                  <span>Sign In to Portal</span>
                </>
              )}
            </button>
          </form>

          {/* Discreet Help / Demo Credentials Modal Trigger */}
          <div className="mt-6 pt-4 border-t border-purple-900/30 flex items-center justify-between text-[11px] text-[#a89bb8]">
            <span className="flex items-center gap-1 text-stone-400">
              <Lock className="w-3 h-3 text-purple-400" />
              Role permissions are automatically enforced
            </span>
            {isDemoLoginEnabled && (
              <button
                type="button"
                onClick={() => setShowDemoModal(true)}
                className="text-purple-300 hover:text-purple-100 flex items-center gap-1 underline underline-offset-2 transition-colors"
              >
                <HelpCircle className="w-3 h-3" />
                <span>Demo Accounts</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Demo Credentials Reference Modal */}
      {isDemoLoginEnabled && showDemoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
          <div
            className="w-full max-w-lg rounded-2xl p-6 shadow-2xl border max-h-[85vh] flex flex-col"
            style={{
              background: 'rgba(21, 16, 32, 0.96)',
              borderColor: 'var(--border-strong)',
            }}
          >
            <div className="flex items-center justify-between pb-3 border-b border-purple-900/40 mb-3">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-purple-400" />
                  <span>Demo Accounts</span>
                </h3>
                <p className="text-[11px] text-[#a89bb8] mt-0.5">
                  Demo mode: click an account to sign in instantly, no password needed.
                </p>
              </div>
              <button
                onClick={() => setShowDemoModal(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-white hover:bg-purple-900/30 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {users.filter((u) => isActiveEmployee(u)).map((u) => {
                const info = getRoleInfo(u.role);
                return (
                  <div
                    key={u.id}
                    onClick={() => handleDemoLogin(u)}
                    className="p-2.5 rounded-xl border border-purple-900/30 bg-[#161122] hover:bg-purple-950/40 hover:border-purple-600/50 cursor-pointer transition-all flex items-center justify-between group"
                  >
                    <div>
                      <div className="text-xs font-bold text-white group-hover:text-purple-300 transition-colors">
                        {u.name}
                      </div>
                      <div className="text-[10px] text-stone-400 font-mono" dir="ltr">
                        {u.email}
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className="px-2 py-0.5 rounded text-[10px] font-semibold block mb-0.5"
                        style={{ background: info.badgeBg, color: info.badgeText }}
                      >
                        {info.portalTitleEn}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 pt-3 border-t border-purple-900/30 flex justify-end">
              <button
                type="button"
                onClick={() => setShowDemoModal(false)}
                className="px-4 py-1.5 rounded-xl text-xs font-bold text-stone-300 hover:text-white bg-purple-950/60 hover:bg-purple-900/50 border border-purple-800/40 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
