import React, { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  UserPlus,
  Upload,
  Download,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  Clock,
  Pencil,
  UserX,
  AlertTriangle,
  X,
  Save,
} from 'lucide-react';
import { ClientRecord, TaskRecord, UserRecord, UserRole } from '../types/database';
import { AGENCY_ROLES, getRoleInfo } from '../data/roles';
import { isPendingEmployee, isActiveEmployee, isDeactivatedEmployee, canManageEmployeesOrClients } from '../lib/permissions';

export interface NewEmployeeInput {
  name: string;
  email: string;
  role: UserRole;
  team: string | null;
  manager_id?: string | null;
  capacity_limit?: number | null;
}

export interface EmployeeUpdateInput {
  name?: string;
  email?: string;
  role?: UserRole;
  team?: string | null;
  capacity_limit?: number | null;
}

interface EmployeeAdminHubProps {
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  tasks: TaskRecord[];
  onAddEmployee: (employee: NewEmployeeInput) => Promise<void>;
  onUpdateEmployee: (userId: string, updates: EmployeeUpdateInput) => Promise<void>;
  onDeactivateEmployee: (userId: string) => Promise<void>;
}

const VALID_ROLES = Object.keys(AGENCY_ROLES) as UserRole[];
const isValidRole = (val: string): val is UserRole => (VALID_ROLES as string[]).includes(val);
const isValidEmail = (val: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);

const CSV_TEMPLATE_HEADERS = ['name', 'email', 'role', 'team', 'manager_id', 'capacity_limit'];
const CSV_TEMPLATE_EXAMPLE = [
  'Fatima Al-Sayed',
  'fatima.seo@agency.com',
  'seo_agent',
  '',
  'usr-seo-lead',
  '6',
];

type RowStatus = 'added' | 'skipped' | 'failed';
interface RowResult {
  row: number;
  name: string;
  email: string;
  status: RowStatus;
  reason?: string;
}

const inputClass =
  'w-full px-3 py-2.5 rounded-xl text-sm bg-[#100c1c] border border-purple-900/50 text-white placeholder-stone-500 outline-none focus:border-purple-400 disabled:opacity-50';
const labelClass = 'block text-xs font-semibold mb-1.5 text-lilac';

export const EmployeeAdminHub: React.FC<EmployeeAdminHubProps> = ({
  currentUser,
  users,
  clients,
  tasks,
  onAddEmployee,
  onUpdateEmployee,
  onDeactivateEmployee,
}) => {
  // Add Employee (single + bulk) stays executive/head_of_technical only — matches
  // users_insert_admin_rls exactly, unchanged by this feature. Manage Employees (edit/deactivate)
  // below is the newly-broadened section: exec/HoT + all 5 team leads.
  const canAddEmployees = currentUser.role === 'executive' || currentUser.role === 'head_of_technical';
  const canManageEmployees = canManageEmployeesOrClients(currentUser.role);

  const [mode, setMode] = useState<'single' | 'bulk'>('single');

  // --- Single form state ---
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('am_agent');
  const [team, setTeam] = useState(getRoleInfo('am_agent').team);
  const [teamTouched, setTeamTouched] = useState(false);
  const [managerId, setManagerId] = useState('');
  const [capacityLimit, setCapacityLimit] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // --- Bulk upload state ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [bulkResults, setBulkResults] = useState<RowResult[] | null>(null);
  const [bulkFileError, setBulkFileError] = useState<string | null>(null);

  // --- Manage Employees (edit/deactivate) state ---
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EmployeeUpdateInput>({});
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [roleChangeWarning, setRoleChangeWarning] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const managerCandidates = useMemo(
    () => users.filter((u) => u.role.includes('team_lead') || u.role === 'executive' || u.role === 'head_of_technical'),
    [users]
  );

  const existingEmailsLower = useMemo(() => new Set(users.map((u) => (u.email || '').toLowerCase())), [users]);

  const resetForm = () => {
    setName('');
    setEmail('');
    setCapacityLimit('');
    setManagerId('');
    setTeamTouched(false);
    setTeam(getRoleInfo(role).team);
  };

  const handleRoleChange = (newRole: UserRole) => {
    setRole(newRole);
    if (!teamTouched) setTeam(getRoleInfo(newRole).team);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName) {
      setFormError('Please enter the employee\'s name.');
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      setFormError('Please enter a valid email address.');
      return;
    }
    if (existingEmailsLower.has(trimmedEmail)) {
      setFormError('An employee with this email already exists.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onAddEmployee({
        name: trimmedName,
        email: trimmedEmail,
        role,
        team: team.trim() || null,
        manager_id: managerId || null,
        capacity_limit: capacityLimit === '' ? null : Number(capacityLimit),
      });
      setFormSuccess(`${trimmedName} added as a pending employee. Run the provisioning script to activate their login.`);
      resetForm();
    } catch (err: any) {
      setFormError(err?.message || 'Unable to add this employee.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const downloadTemplate = () => {
    const csv = [CSV_TEMPLATE_HEADERS.join(','), CSV_TEMPLATE_EXAMPLE.join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee_upload_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Normalizes whatever papaparse/xlsx hands back into plain string-keyed rows, lowercasing
  // headers so "Email"/"email"/"EMAIL" all match.
  const normalizeRows = (rawRows: Record<string, any>[]): Record<string, string>[] =>
    rawRows.map((raw) => {
      const normalized: Record<string, string> = {};
      for (const key of Object.keys(raw)) {
        normalized[key.trim().toLowerCase()] = String(raw[key] ?? '').trim();
      }
      return normalized;
    });

  const parseFile = (file: File): Promise<Record<string, string>[]> => {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    if (isCsv) {
      return new Promise((resolve, reject) => {
        Papa.parse<Record<string, any>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => resolve(normalizeRows(results.data)),
          error: (err) => reject(err),
        });
      });
    }
    return file.arrayBuffer().then((buffer) => {
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(firstSheet, { defval: '' });
      return normalizeRows(rows);
    });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBulkFileError(null);
    setBulkResults(null);
    setIsProcessingFile(true);

    try {
      const rows = await parseFile(file);
      if (rows.length === 0) {
        setBulkFileError('That file has no data rows.');
        return;
      }

      const seenEmailsThisFile = new Set<string>();
      const results: RowResult[] = [];

      // Row-by-row, not batched: one bad/duplicate row is skipped and reported without
      // aborting the rest of the file, and each insert is its own real DB round-trip so a
      // duplicate the client-side check missed still gets caught (and reported) individually.
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2; // +1 for 1-indexing, +1 for the header row
        const raw = rows[i];
        const rowName = (raw.name || '').trim();
        const rowEmail = (raw.email || '').trim().toLowerCase();
        const rowRole = (raw.role || '').trim();
        const rowTeam = (raw.team || '').trim();
        const rowManagerId = (raw.manager_id || '').trim();
        const rowCapacity = (raw.capacity_limit || '').trim();

        if (!rowName) {
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'skipped', reason: 'Missing name' });
          continue;
        }
        if (!isValidEmail(rowEmail)) {
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'skipped', reason: 'Missing or invalid email' });
          continue;
        }
        if (!isValidRole(rowRole)) {
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'skipped', reason: `Invalid role "${rowRole}"` });
          continue;
        }
        if (existingEmailsLower.has(rowEmail) || seenEmailsThisFile.has(rowEmail)) {
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'skipped', reason: 'Duplicate email' });
          continue;
        }
        if (rowCapacity && Number.isNaN(Number(rowCapacity))) {
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'skipped', reason: 'capacity_limit is not a number' });
          continue;
        }

        seenEmailsThisFile.add(rowEmail);
        try {
          await onAddEmployee({
            name: rowName,
            email: rowEmail,
            role: rowRole,
            team: rowTeam || getRoleInfo(rowRole).team,
            manager_id: rowManagerId || null,
            capacity_limit: rowCapacity ? Number(rowCapacity) : null,
          });
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'added' });
        } catch (err: any) {
          results.push({ row: rowNum, name: rowName, email: rowEmail, status: 'failed', reason: err?.message || 'Insert failed' });
        }
      }

      setBulkResults(results);
    } catch (err: any) {
      setBulkFileError(err?.message || 'Unable to parse this file. Confirm it\'s a valid .csv or .xlsx file.');
    } finally {
      setIsProcessingFile(false);
    }
  };

  const pendingEmployees = useMemo(() => users.filter(isPendingEmployee), [users]);
  const deactivatedEmployees = useMemo(() => users.filter(isDeactivatedEmployee), [users]);

  // Team leads see only their own department here (a client-side approximation of what
  // employee_visible() already enforces server-side on every actual read/write) — exec/HoT see
  // everyone. Not a security boundary (RLS is), just keeping the list relevant to who's viewing.
  const manageableEmployees = useMemo(() => {
    const active = users.filter(isActiveEmployee);
    if (currentUser.role === 'executive' || currentUser.role === 'head_of_technical') return active;
    return active.filter((u) => u.team === currentUser.team || u.manager_id === currentUser.id || u.id === currentUser.id);
  }, [users, currentUser]);

  // Live-assignment counts for the role-change warning (point 4) — checked whenever the draft's
  // role differs from the employee's current one, right before actually saving.
  const liveAssignmentCounts = (userId: string) => {
    const activeClients = clients.filter((c) => c.am_agent_id === userId).length;
    const openTasks = tasks.filter((t) => t.assigned_to === userId && t.status !== 'completed').length;
    return { activeClients, openTasks };
  };

  const startEdit = (u: UserRecord) => {
    setEditingId(u.id);
    setEditDraft({ name: u.name, email: u.email, role: u.role, team: u.team, capacity_limit: u.capacity_limit });
    setEditError(null);
    setRoleChangeWarning(null);
  };

  const handleSaveEdit = async (originalRole: UserRole) => {
    if (!editingId) return;
    setEditError(null);

    // Non-blocking warning (point 4): shown once, saved through on a second click.
    if (editDraft.role && editDraft.role !== originalRole && !roleChangeWarning) {
      const { activeClients, openTasks } = liveAssignmentCounts(editingId);
      if (activeClients > 0 || openTasks > 0) {
        setRoleChangeWarning(
          `This employee has ${activeClients} active client assignment${activeClients === 1 ? '' : 's'} and ${openTasks} open task${openTasks === 1 ? '' : 's'} — changing their role won't reassign these. Click Save again to confirm.`
        );
        return;
      }
    }

    setIsSavingEdit(true);
    try {
      await onUpdateEmployee(editingId, editDraft);
      setEditingId(null);
      setRoleChangeWarning(null);
    } catch (err: any) {
      setEditError(err?.message || 'Unable to save changes.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDeactivate = async (userId: string) => {
    setIsDeactivating(true);
    try {
      await onDeactivateEmployee(userId);
      setDeactivatingId(null);
    } finally {
      setIsDeactivating(false);
    }
  };

  return (
    <div className="space-y-6">
      {canAddEmployees && (
      <>
      <div className="p-4 rounded-2xl border border-purple-900/30 bg-[#161224]/80">
        <div className="flex items-center gap-3 mb-1">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
          >
            <UserPlus className="w-4.5 h-4.5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Add Employee</h2>
            <p className="text-[11px] text-stone-400">Executive / Head of Technical only</p>
          </div>
        </div>
        <div
          className="mt-3 p-3 rounded-xl text-[11px] flex items-start gap-2"
          style={{ background: 'rgba(123, 47, 247, 0.08)', border: '1px solid var(--border-soft)', color: 'var(--lilac)' }}
        >
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Adding someone here creates a <strong>pending</strong> employee record — not a working login. Real account
            creation needs a key that never touches the browser, so it happens separately: after adding people, run{' '}
            <code className="px-1 py-0.5 rounded bg-black/40 font-mono">npm run provision-auth-users</code> to create their
            real sign-in and generate their one-time password-setup link.
          </span>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setMode('single')}
          className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${
            mode === 'single' ? 'text-white shadow' : 'text-stone-400 hover:text-stone-200'
          }`}
          style={{ background: mode === 'single' ? 'var(--gradient-badge)' : 'rgba(255,255,255,0.04)' }}
        >
          Single Employee
        </button>
        <button
          onClick={() => setMode('bulk')}
          className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${
            mode === 'bulk' ? 'text-white shadow' : 'text-stone-400 hover:text-stone-200'
          }`}
          style={{ background: mode === 'bulk' ? 'var(--gradient-badge)' : 'rgba(255,255,255,0.04)' }}
        >
          Bulk Upload (CSV / Excel)
        </button>
      </div>

      {mode === 'single' ? (
        <form onSubmit={handleSubmit} className="p-5 rounded-2xl border border-purple-900/30 bg-[#161224]/80 space-y-4">
          {formError && (
            <div className="p-3 rounded-xl text-xs flex items-center gap-2" style={{ background: 'rgba(245,163,163,0.12)', color: 'var(--roas-bad)', border: '1px solid var(--roas-bad)' }}>
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {formError}
            </div>
          )}
          {formSuccess && (
            <div className="p-3 rounded-xl text-xs flex items-center gap-2" style={{ background: 'rgba(169,245,193,0.12)', color: 'var(--roas-good)', border: '1px solid var(--roas-good)' }}>
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              {formSuccess}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Full Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={isSubmitting} className={inputClass} placeholder="e.g. Fatima Al-Sayed" required />
            </div>
            <div>
              <label className={labelClass}>Email *</label>
              <input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} disabled={isSubmitting} className={`${inputClass} font-mono`} placeholder="name@agency.com" required />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Role *</label>
              <select value={role} onChange={(e) => handleRoleChange(e.target.value as UserRole)} disabled={isSubmitting} className={`${inputClass} cursor-pointer`}>
                {VALID_ROLES.map((r) => (
                  <option key={r} value={r} className="bg-stone-900">
                    {getRoleInfo(r).englishTitle}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Team</label>
              <input
                value={team}
                onChange={(e) => {
                  setTeam(e.target.value);
                  setTeamTouched(true);
                }}
                disabled={isSubmitting}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Manager (optional)</label>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={isSubmitting} className={`${inputClass} cursor-pointer`}>
                <option value="" className="bg-stone-900">
                  -- None --
                </option>
                {managerCandidates.map((m) => (
                  <option key={m.id} value={m.id} className="bg-stone-900">
                    {m.name} ({getRoleInfo(m.role).englishTitle})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Capacity Limit (optional)</label>
              <input
                type="number"
                min={0}
                value={capacityLimit}
                onChange={(e) => setCapacityLimit(e.target.value === '' ? '' : Number(e.target.value))}
                disabled={isSubmitting}
                className={inputClass}
                placeholder="e.g. 8"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl text-xs font-bold text-white shadow-lg transition-all disabled:opacity-50 flex items-center gap-2"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              {isSubmitting ? 'Adding...' : 'Add Employee'}
            </button>
          </div>
        </form>
      ) : (
        <div className="p-5 rounded-2xl border border-purple-900/30 bg-[#161224]/80 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-stone-400">
              Columns: <code className="font-mono">{CSV_TEMPLATE_HEADERS.join(', ')}</code> (name, email, and role are
              required; the rest are optional).
            </p>
            <button
              onClick={downloadTemplate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all"
            >
              <Download className="w-3.5 h-3.5" />
              Download CSV Template
            </button>
          </div>

          <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessingFile}
            className="w-full flex flex-col items-center justify-center gap-2 py-8 rounded-xl border-2 border-dashed border-purple-900/50 hover:border-purple-500/60 transition-all disabled:opacity-50"
          >
            {isProcessingFile ? (
              <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
            ) : (
              <FileSpreadsheet className="w-6 h-6 text-purple-400" />
            )}
            <span className="text-xs font-bold text-white">
              {isProcessingFile ? 'Processing...' : 'Click to select a .csv or .xlsx file'}
            </span>
            <span className="text-[11px] text-stone-500 flex items-center gap-1">
              <Upload className="w-3 h-3" /> Rows are inserted one at a time — a bad row is skipped and reported, not fatal.
            </span>
          </button>

          {bulkFileError && (
            <div className="p-3 rounded-xl text-xs flex items-center gap-2" style={{ background: 'rgba(245,163,163,0.12)', color: 'var(--roas-bad)', border: '1px solid var(--roas-bad)' }}>
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {bulkFileError}
            </div>
          )}

          {bulkResults && (
            <div className="space-y-2">
              <div className="flex gap-3 text-[11px]">
                <span className="text-emerald-400 font-bold">{bulkResults.filter((r) => r.status === 'added').length} added</span>
                <span className="text-amber-400 font-bold">{bulkResults.filter((r) => r.status === 'skipped').length} skipped</span>
                <span className="text-red-400 font-bold">{bulkResults.filter((r) => r.status === 'failed').length} failed</span>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-xl border border-purple-900/30 custom-scrollbar">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-[#1a1428]">
                    <tr className="text-left text-stone-400">
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkResults.map((r) => (
                      <tr key={r.row} className="border-t border-purple-900/20">
                        <td className="px-3 py-1.5 text-stone-500 font-mono">{r.row}</td>
                        <td className="px-3 py-1.5 text-white">{r.name || '—'}</td>
                        <td className="px-3 py-1.5 text-stone-300 font-mono">{r.email || '—'}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              r.status === 'added' ? 'text-emerald-400 bg-emerald-500/10' : r.status === 'skipped' ? 'text-amber-400 bg-amber-500/10' : 'text-red-400 bg-red-500/10'
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-stone-400">{r.reason || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {pendingEmployees.length > 0 && (
        <div className="p-4 rounded-2xl border border-amber-700/30 bg-[#161224]/80">
          <h3 className="text-xs font-bold text-white flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-amber-400" />
            Pending Employees ({pendingEmployees.length})
          </h3>
          <div className="space-y-1.5">
            {pendingEmployees.map((u) => (
              <div key={u.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/20 text-xs">
                <div>
                  <span className="text-white font-semibold">{u.name}</span>
                  <span className="text-stone-500 ml-2 font-mono">{u.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-stone-400">{getRoleInfo(u.role).englishTitle}</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-amber-400 bg-amber-500/10">Pending</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-stone-500 mt-3">
            Run <code className="px-1 py-0.5 rounded bg-black/40 font-mono">npm run provision-auth-users</code> to activate
            these accounts.
          </p>
        </div>
      )}
      </>
      )}

      {canManageEmployees && (
        <div className="p-4 rounded-2xl border border-purple-900/30 bg-[#161224]/80">
          <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
            <Pencil className="w-4 h-4 text-purple-400" />
            Manage Employees ({manageableEmployees.length})
          </h2>
          <div className="space-y-1.5">
            {manageableEmployees.map((u) => {
              const isEditing = editingId === u.id;
              return (
                <div key={u.id} className="p-2.5 rounded-lg bg-black/20 text-xs space-y-2">
                  {isEditing ? (
                    <div className="space-y-2">
                      {editError && (
                        <div className="p-2 rounded-lg text-[11px] bg-red-950/30 text-red-300 border border-red-800/40">{editError}</div>
                      )}
                      {roleChangeWarning && (
                        <div className="p-2 rounded-lg text-[11px] bg-amber-950/30 text-amber-300 border border-amber-800/40 flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{roleChangeWarning}</span>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={editDraft.name || ''}
                          onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                          className={inputClass}
                          placeholder="Name"
                        />
                        <input
                          type="email"
                          dir="ltr"
                          value={editDraft.email || ''}
                          onChange={(e) => setEditDraft((d) => ({ ...d, email: e.target.value }))}
                          className={`${inputClass} font-mono`}
                          placeholder="Email"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={editDraft.role || u.role}
                          onChange={(e) => setEditDraft((d) => ({ ...d, role: e.target.value as UserRole }))}
                          className={`${inputClass} cursor-pointer`}
                        >
                          {VALID_ROLES.map((r) => (
                            <option key={r} value={r} className="bg-stone-900">{getRoleInfo(r).englishTitle}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={editDraft.team || ''}
                          onChange={(e) => setEditDraft((d) => ({ ...d, team: e.target.value }))}
                          className={inputClass}
                          placeholder="Team"
                        />
                      </div>
                      <input
                        type="number"
                        min={0}
                        value={editDraft.capacity_limit ?? ''}
                        onChange={(e) => setEditDraft((d) => ({ ...d, capacity_limit: e.target.value === '' ? null : Number(e.target.value) }))}
                        className={inputClass}
                        placeholder="Capacity limit"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => { setEditingId(null); setRoleChangeWarning(null); setEditError(null); }}
                          className="px-2.5 py-1.5 rounded-lg text-[11px] text-stone-400 hover:text-white"
                        >
                          <X className="w-3.5 h-3.5 inline mr-1" />
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSaveEdit(u.role)}
                          disabled={isSavingEdit}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
                        >
                          <Save className="w-3.5 h-3.5" />
                          {roleChangeWarning ? 'Confirm & Save' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : deactivatingId === u.id ? (
                    <div className="space-y-2">
                      <p className="text-[11px] text-amber-300 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        Deactivate {u.name}? Their open tasks become unassigned, they're removed from every
                        active-employee picker, and their login is banned once{' '}
                        <code className="px-1 py-0.5 rounded bg-black/40 font-mono">npm run deactivate-auth-users</code> is
                        run. Historical records keep their name — this is permanent but not a delete.
                      </p>
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setDeactivatingId(null)}
                          className="px-2.5 py-1.5 rounded-lg text-[11px] text-stone-400 hover:text-white"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleDeactivate(u.id)}
                          disabled={isDeactivating}
                          className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-white bg-red-600 hover:bg-red-500 disabled:opacity-50"
                        >
                          {isDeactivating ? 'Deactivating...' : 'Confirm Deactivate'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-white font-semibold">{u.name}</span>
                        <span className="text-stone-500 ml-2 font-mono">{u.email}</span>
                        <span className="text-stone-400 ml-2">{getRoleInfo(u.role).englishTitle}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => startEdit(u)}
                          className="p-1.5 rounded-lg text-purple-300 hover:text-white hover:bg-purple-900/40"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {u.id !== currentUser.id && (
                          <button
                            onClick={() => setDeactivatingId(u.id)}
                            className="p-1.5 rounded-lg text-stone-500 hover:text-red-400 hover:bg-red-950/30"
                            title="Deactivate"
                          >
                            <UserX className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {canManageEmployees && deactivatedEmployees.length > 0 && (
        <div className="p-4 rounded-2xl border border-stone-800 bg-[#161224]/80">
          <h3 className="text-xs font-bold text-stone-400 flex items-center gap-2 mb-3">
            <UserX className="w-4 h-4 text-stone-500" />
            Deactivated Employees ({deactivatedEmployees.length})
          </h3>
          <div className="space-y-1.5">
            {deactivatedEmployees.map((u) => (
              <div key={u.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/20 text-xs opacity-60">
                <div>
                  <span className="text-stone-300 font-semibold">{u.name}</span>
                  <span className="text-stone-500 ml-2 font-mono">{u.email}</span>
                </div>
                <span className="text-stone-500">{getRoleInfo(u.role).englishTitle}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
