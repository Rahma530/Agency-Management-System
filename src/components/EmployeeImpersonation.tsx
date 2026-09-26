import { useState } from 'react';
import { X } from 'lucide-react';
import { getRoleInfo } from '../data/roles';
import { isActiveEmployee } from '../lib/permissions';
import type { UserRecord } from '../types/database';

interface Props {
  employees: UserRecord[];
  onClose: () => void;
  onStart: (employee: UserRecord) => Promise<void>;
}

/**
 * TEMPORARY TRANSITION FEATURE — intended for removal once every employee has adopted their own
 * real, self-set password (distributed via scripts/provisionAuthUsers.ts). Lets an active Head of
 * Technical or AI Engineer log into any other employee's account — no exclusions, including each
 * other, executive, and any team lead — via a one-time Supabase Auth magic link, without ever
 * seeing or resetting that employee's real password. This is a bridge for the window until the
 * team has fully transitioned off shared/admin-known credentials
 * — do not build new permanent features on top of this component; when leadership decides the
 * transition is done, delete this file, EmployeeImpersonation's App.tsx wiring, the
 * employee-impersonation Edge Function, and the impersonation_sessions table together.
 */
export function EmployeeImpersonation({ employees, onClose, onStart }: Props) {
  const [employeeId, setEmployeeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Only gate: a real linked Auth account, not deactivated (isActiveEmployee). No role-based
  // exclusion — head_of_technical/ai_engineer can impersonate any active employee, including each
  // other and executive; the server independently re-checks the same isActiveEmployee-equivalent
  // condition.
  const available = employees
    .filter((employee) => isActiveEmployee(employee))
    .sort((a, b) => a.name.localeCompare(b.name));
  const employee = available.find((item) => item.id === employeeId);

  const start = async () => {
    if (!employee || busy) return;
    setBusy(true);
    setError('');
    try {
      await onStart(employee);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the impersonation session.');
      setBusy(false);
    }
    // No finally-set busy(false) on success: onStart tears down this admin session and this
    // component unmounts along with everything else on a successful start.
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Employee Impersonation">
      <div className="w-full max-w-lg rounded-2xl border border-red-600/50 bg-[#1b1428] p-6 text-white shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Impersonate Employee</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg p-1 text-stone-300 hover:text-white disabled:opacity-50"><X size={18} /></button>
        </div>
        <div className="mt-3 rounded-lg border border-red-600/60 bg-red-950/40 p-3 text-xs text-red-200">
          <p className="font-bold">Temporary transition tool — not a permanent feature.</p>
          <p className="mt-1">
            This exists only for the window until every employee has set and adopted their own real
            password. It logs you into the selected employee's account via a one-time link — their
            password is never shown to you and is never changed by this action. Every use is
            recorded (who, whom, when).
          </p>
        </div>
        <label htmlFor="impersonation-employee" className="mt-5 block text-sm font-medium">Employee to impersonate</label>
        <select id="impersonation-employee" value={employeeId} disabled={busy}
          onChange={(event) => { setEmployeeId(event.target.value); setError(''); }}
          className="mt-2 w-full rounded-lg border border-red-700 bg-[#110d19] p-3 text-sm text-white">
          <option value="">Select an employee</option>
          {available.map((item) => <option key={item.id} value={item.id}>
            {item.name} — {item.email || 'No work email'} — {getRoleInfo(item.role).englishTitle}
          </option>)}
        </select>
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-stone-300 disabled:opacity-50">Cancel</button>
          <button onClick={() => void start()} disabled={busy || !employee}
            className="rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-50">
            {busy ? 'Starting...' : 'Start Impersonation'}
          </button>
        </div>
      </div>
    </div>
  );
}
