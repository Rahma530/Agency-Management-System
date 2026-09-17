import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getRoleInfo } from '../data/roles';
import { isDeactivatedEmployee } from '../lib/permissions';
import type { UserRecord } from '../types/database';

export interface TestAccountStatus {
  status: 'ready' | 'pending';
  authId?: string;
  authEmail?: string;
  emailMismatch?: boolean;
  canGenerateTestPassword?: boolean;
  testPasswordBlockReason?: 'protected' | 'configuration';
}

export interface GeneratedTestPassword extends TestAccountStatus {
  temporaryPassword: string;
}

interface Props {
  employees: UserRecord[];
  onClose: () => void;
  onInspect: (employeeId: string) => Promise<TestAccountStatus>;
  onSetup: (employeeId: string, password: string) => Promise<TestAccountStatus>;
  onGenerateTestPassword: (employeeId: string) => Promise<GeneratedTestPassword>;
  onStart: (employee: UserRecord, status: TestAccountStatus) => Promise<void>;
}

/** Temporary account setup and real-login handoff. No sessions or passwords are kept here. */
export function EmployeeTestingMode({ employees, onClose, onInspect, onSetup, onGenerateTestPassword, onStart }: Props) {
  const [employeeId, setEmployeeId] = useState('');
  const [account, setAccount] = useState<TestAccountStatus | null>(null);
  const [password, setPassword] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = employees.filter((employee) => !isDeactivatedEmployee(employee))
    .sort((a, b) => a.name.localeCompare(b.name));
  const employee = available.find((item) => item.id === employeeId);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyWithFallback = (value: string): boolean => {
    const textarea = document.createElement('textarea');
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textarea.value = value;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    try {
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea.remove();
      previousFocus?.focus();
    }
  };

  const copyPassword = async () => {
    if (!generatedPassword) return;
    let success = false;
    if (typeof navigator.clipboard?.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(generatedPassword);
        success = true;
      } catch { /* Try the browser's selection-based copy below. */ }
    }
    if (!success) success = copyWithFallback(generatedPassword);
    if (success) {
      setError('');
      setCopied(true);
    } else {
      setCopied(false);
      setError('Could not copy password. Please copy it manually.');
    }
  };

  const selectEmployee = async (id: string) => {
    setEmployeeId(id);
    setAccount(null);
    setPassword('');
    setGeneratedPassword('');
    setCopied(false);
    setError('');
    if (!id) return;
    setBusy(true);
    try { setAccount(await onInspect(id)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not check account status.'); }
    finally { setBusy(false); }
  };

  const setup = async () => {
    if (!employee || busy) return;
    setBusy(true);
    setError('');
    try { setAccount(await onSetup(employee.id, password)); setPassword(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not set up account.'); }
    finally { setBusy(false); }
  };

  const generate = async () => {
    if (!employee || !account?.authId || !account.canGenerateTestPassword || busy || generatedPassword) return;
    setBusy(true);
    setError('');
    try {
      const result = await onGenerateTestPassword(employee.id);
      const { temporaryPassword, ...status } = result;
      setAccount(status);
      setGeneratedPassword(temporaryPassword);
      setCopied(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not generate a test password.'); }
    finally { setBusy(false); }
  };

  const start = async () => {
    if (!employee || !account?.authId || !account.authEmail || busy) return;
    setBusy(true);
    setError('');
    try { await onStart(employee, account); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not start test login.'); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Employee Testing Account Setup">
      <div className="w-full max-w-lg rounded-2xl border border-purple-600/50 bg-[#1b1428] p-6 text-white shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Employee Testing / Account Setup</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg p-1 text-stone-300 hover:text-white disabled:opacity-50"><X size={18} /></button>
        </div>
        <p className="mt-3 text-sm text-stone-300">
          Start a real employee Auth session. You will sign out of your admin account and enter the employee's email and password on the normal login screen. Returning requires your admin login again.
        </p>
        <label htmlFor="testing-employee" className="mt-5 block text-sm font-medium">Active employee</label>
        <select id="testing-employee" value={employeeId} disabled={busy}
          onChange={(event) => void selectEmployee(event.target.value)}
          className="mt-2 w-full rounded-lg border border-purple-700 bg-[#110d19] p-3 text-sm text-white">
          <option value="">Select an employee</option>
          {available.map((item) => <option key={item.id} value={item.id}>
            {item.name} — {item.email || 'No work email'} — {getRoleInfo(item.role).englishTitle}
          </option>)}
        </select>
        {busy && <p className="mt-3 text-sm text-stone-300">Checking account...</p>}
        {account?.status === 'pending' && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-amber-200">No linked Auth account. Create one with a temporary test password; it will be stored only by Supabase Auth.</p>
            <label htmlFor="test-password" className="block text-sm">Temporary password (12–128 characters)</label>
            <input id="test-password" type="password" autoComplete="new-password" value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-purple-700 bg-[#110d19] p-3 text-sm text-white" />
            <button onClick={setup} disabled={busy || password.length < 12 || password.length > 128}
              className="rounded-lg bg-purple-700 px-4 py-2 text-sm font-bold disabled:opacity-50">Set Up Test Account</button>
          </div>
        )}
        {account?.status === 'ready' && (
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-emerald-300">Auth account linked and ready.</p>
            <p>Auth login email: <strong>{account.authEmail}</strong></p>
            {account.emailMismatch && <p className="text-amber-200">The Auth email differs from the employee profile email. Use the Auth email shown above; no email was changed.</p>}
            {account.testPasswordBlockReason === 'protected' && (
              <p className="text-amber-200">This employee's real password is protected. Use their existing password or normal setup link; a temporary test password cannot be generated here.</p>
            )}
            {account.testPasswordBlockReason === 'configuration' && (
              <p className="text-amber-200">Temporary password generation is unavailable until the protected employee Auth IDs are configured on the server.</p>
            )}
            {account.canGenerateTestPassword && !generatedPassword && (
              <div className="space-y-2 rounded-lg border border-amber-700/60 p-3">
                <p className="text-amber-200">Generating a temporary test password changes this employee's current Supabase Auth password. It is not their permanent password. Selection alone makes no change.</p>
                <button type="button" onClick={generate} disabled={busy}
                  className="rounded-lg bg-purple-700 px-4 py-2 font-bold disabled:opacity-50">Generate Temporary Test Password</button>
              </div>
            )}
            {generatedPassword && (
              <div className="space-y-2 rounded-lg border border-amber-600 p-3">
                <p className="text-amber-200">Temporary test password (shown only here; refreshing or closing clears it):</p>
                <code className="block break-all rounded bg-[#110d19] p-2 text-base text-white">{generatedPassword}</code>
                <button type="button" onClick={() => void copyPassword()} disabled={copied}
                  className="rounded-lg border border-purple-500 px-3 py-1 disabled:opacity-70">{copied ? 'Copied ✓' : 'Copy password'}</button>
              </div>
            )}
            <p className="text-stone-300">Use the temporary password shown above, or the employee's own password/setup link, on the normal login screen. No password is stored by this page.</p>
            <button onClick={start} disabled={busy || !account.authId || !account.authEmail}
              className="rounded-lg bg-amber-300 px-4 py-2 font-bold text-black disabled:opacity-50">Start Employee Test Session</button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-stone-300 disabled:opacity-50">Cancel</button>
        </div>
      </div>
    </div>
  );
}
