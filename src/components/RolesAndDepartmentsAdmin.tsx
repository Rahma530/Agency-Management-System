import React, { useState } from 'react';
import { X, Plus, Building2, ShieldCheck, AlertCircle, Trash2 } from 'lucide-react';
import { UserRecord } from '../types/database';
import { AppModuleId } from '../data/roles';
import { CapabilityKey, GRANTABLE_CAPABILITY_CATALOG } from '../lib/capabilities';
import {
  getAllDepartments,
  getAllCustomRoles,
  getDepartmentMemberTeamsForDepartment,
  getDepartmentById,
} from '../data/customRoles';
import {
  SEEDED_DEPARTMENT_IDS,
  createDepartment,
  checkCanDeactivateDepartment,
  deactivateDepartment,
  createCustomRole,
  countActiveEmployeesHoldingRole,
  deactivateCustomRole,
  normalizeAllowedModules,
  PermissionOverrideState,
} from '../lib/rolesAndDepartmentsAdmin';

// The 11 AppModuleId values, in the same order custom_role_modules_module_id_check lists them
// (20261101400000_custom_roles_departments_foundation.sql) — no exported "all AppModuleId values"
// list exists elsewhere in the app, so this is the one place that needs to stay in sync with that
// CHECK constraint if a 12th module is ever added.
const ALL_MODULE_IDS: { id: AppModuleId; label: string }[] = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'service_briefs', label: 'Service Briefs' },
  { id: 'capacity', label: 'Capacity' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'daily_operations', label: 'Daily Operations' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'reports', label: 'Reports' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'my_work', label: 'My Work' },
  { id: 'employees', label: 'Employees' },
  { id: 'brief_templates', label: 'Brief Templates' },
];

interface RolesAndDepartmentsAdminProps {
  currentUserId: string;
  users: UserRecord[];
  initialView?: 'departments' | 'roles';
  onClose: () => void;
  // Refetches departments/custom_roles/etc. and re-registers the in-memory cache
  // (App.tsx's loadCustomRolesAndDepartments) — called after every successful save so the rest
  // of the app (and this modal's own list, via the re-render it causes) reflects the change
  // without a page reload.
  onDataChanged: () => Promise<void>;
  onRoleCreated?: (roleId: string) => void;
  onDepartmentCreated?: (primaryTeamValue: string) => void;
}

const inputClass =
  'w-full px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 outline-none focus:border-purple-400 disabled:opacity-50';
const labelClass = 'block text-[11px] font-semibold mb-1 text-lilac';

/**
 * Admin screen (executive/head_of_technical only — the caller, EmployeeAdminHub.tsx, enforces
 * this with a hardcoded literal check before ever rendering this component; the underlying
 * departments_insert_rls/update_rls, custom_roles_insert_rls/update_rls, etc. are the real,
 * server-side enforcement, same two-layer pattern as every other admin screen in this app).
 *
 * Two tabs: Departments and Custom Roles. Each has a list (including inactive rows, so they can
 * still be reviewed) and an inline "+ New..." create form, same interaction shape as
 * TaskTypeManager.tsx. Deactivating is the only user-facing lifecycle action from this screen —
 * matching every other admin-managed table in this app, a referenced row must stay valid for
 * whatever already points at it, so there is no delete BUTTON. (lib/rolesAndDepartmentsAdmin.ts's
 * create functions do issue real deletes under the hood, but only to roll back a create that
 * failed partway through — never as a user-reachable action, and never on a row that ever made
 * it to is_active=true.)
 */
export const RolesAndDepartmentsAdmin: React.FC<RolesAndDepartmentsAdminProps> = ({
  currentUserId,
  users,
  initialView = 'departments',
  onClose,
  onDataChanged,
  onRoleCreated,
  onDepartmentCreated,
}) => {
  const [view, setView] = useState<'departments' | 'roles'>(initialView);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl p-5 space-y-4"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white">Manage Roles &amp; Departments</h3>
            <p className="text-[11px] text-stone-400 mt-0.5">
              Create admin-managed custom roles and departments. Retiring one sets it inactive
              instead of removing it, so anything already referencing it stays valid.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-white/5">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-2 p-1 rounded-xl" style={{ background: 'rgba(0,0,0,0.25)' }}>
          <button
            onClick={() => setView('departments')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              view === 'departments' ? 'filled-purple-action text-white shadow' : 'text-stone-400 hover:text-stone-200'
            }`}
            style={{ background: view === 'departments' ? 'var(--gradient-badge)' : 'rgba(255,255,255,0.04)' }}
          >
            <Building2 className="w-3.5 h-3.5" />
            Departments
          </button>
          <button
            onClick={() => setView('roles')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              view === 'roles' ? 'filled-purple-action text-white shadow' : 'text-stone-400 hover:text-stone-200'
            }`}
            style={{ background: view === 'roles' ? 'var(--gradient-badge)' : 'rgba(255,255,255,0.04)' }}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            Custom Roles
          </button>
        </div>

        {view === 'departments' ? (
          <DepartmentsTab users={users} onDataChanged={onDataChanged} onDepartmentCreated={onDepartmentCreated} />
        ) : (
          <RolesTab currentUserId={currentUserId} users={users} onDataChanged={onDataChanged} onRoleCreated={onRoleCreated} />
        )}
      </div>
    </div>
  );
};

// --- Departments tab --------------------------------------------------------------------------

const DepartmentsTab: React.FC<{
  users: UserRecord[];
  onDataChanged: () => Promise<void>;
  onDepartmentCreated?: (primaryTeamValue: string) => void;
}> = ({ users, onDataChanged, onDepartmentCreated }) => {
  const departments = getAllDepartments();

  const [isAddingNew, setIsAddingNew] = useState(false);
  const [label, setLabel] = useState('');
  const [isSharedResource, setIsSharedResource] = useState(false);
  const [teamValues, setTeamValues] = useState<string[]>(['']);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  const resetForm = () => {
    setLabel('');
    setIsSharedResource(false);
    setTeamValues(['']);
    setErrorMsg('');
  };

  const handleCreate = async () => {
    const trimmedLabel = label.trim();
    const trimmedTeamValues: string[] = teamValues.map((t) => t.trim()).filter((t) => t.length > 0);
    const cleanTeamValues: string[] = [...new Set<string>(trimmedTeamValues)];
    if (!trimmedLabel) {
      setErrorMsg('Please enter a department name.');
      return;
    }
    if (cleanTeamValues.length === 0) {
      setErrorMsg('Please enter at least one team value.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      const result = await createDepartment({ label: trimmedLabel, teamValues: cleanTeamValues, isSharedResource });
      if (!result.success || !result.data) {
        setErrorMsg(result.error || 'Unable to create this department.');
        return;
      }
      await onDataChanged();
      onDepartmentCreated?.(cleanTeamValues[0]);
      resetForm();
      setIsAddingNew(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to create this department.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeactivate = async (departmentId: string) => {
    setErrorMsg('');
    setIsSaving(true);
    try {
      const result = await deactivateDepartment(departmentId, users);
      if (!result.success) {
        setErrorMsg(result.error || 'Unable to deactivate this department.');
        return;
      }
      await onDataChanged();
      setDeactivatingId(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to deactivate this department.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {errorMsg && (
        <div className="p-2.5 rounded-lg text-xs bg-red-950/30 text-red-300 border border-red-800/40 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {errorMsg}
        </div>
      )}

      <div className="space-y-2">
        {departments.map((dept) => {
          const isSeeded = SEEDED_DEPARTMENT_IDS.has(dept.id);
          const guard = checkCanDeactivateDepartment(dept.id, users);
          const teams = getDepartmentMemberTeamsForDepartment(dept.id);
          return (
            <div
              key={dept.id}
              className="p-3 rounded-xl border"
              style={{ background: 'rgba(10, 10, 13, 0.5)', borderColor: 'var(--border-soft)', opacity: dept.is_active ? 1 : 0.55 }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">
                    {dept.label}
                    {dept.is_shared_resource && <span className="ml-1.5 text-[10px] text-amber-400">(shared resource)</span>}
                    {!dept.is_active && <span className="ml-1.5 text-[10px] text-stone-500">Inactive</span>}
                  </p>
                  <p className="text-[11px] text-stone-500 font-mono">{dept.id}</p>
                  <p className="text-[11px] text-stone-400 mt-0.5">
                    Teams: {teams.map((t) => t.team_value).join(', ') || '—'}
                  </p>
                  <p className="text-[11px] text-stone-500 mt-0.5">
                    {guard.activeCustomRoleCount} active role(s) · {guard.activeEmployeeCount} active employee(s)
                  </p>
                </div>
                <div className="shrink-0">
                  {!dept.is_active ? null : deactivatingId === dept.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setDeactivatingId(null)}
                        className="px-2 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleDeactivate(dept.id)}
                        disabled={isSaving}
                        className="px-2 py-1 rounded-lg text-[11px] font-bold text-white bg-red-700 hover:bg-red-600 disabled:opacity-50"
                      >
                        Confirm Deactivate
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeactivatingId(dept.id)}
                      disabled={isSeeded || !guard.allowed}
                      title={!guard.allowed ? guard.reason : undefined}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <Trash2 className="w-3 h-3" />
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {isAddingNew ? (
        <div className="p-3 rounded-xl border border-dashed border-purple-700/40 space-y-2">
          <div>
            <label className={labelClass}>Department Name *</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Customer Support"
              className={inputClass}
              disabled={isSaving}
            />
          </div>
          <div>
            <label className={labelClass}>Team Value(s) *</label>
            <p className="text-[10px] text-stone-500 mb-1">
              The value(s) staffed employees will have as their Team — the first one is this
              department's primary team.
            </p>
            {teamValues.map((value, index) => (
              <div key={index} className="flex items-center gap-1.5 mb-1.5">
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setTeamValues((prev) => prev.map((v, i) => (i === index ? e.target.value : v)))}
                  placeholder="e.g. Customer Support"
                  className={inputClass}
                  disabled={isSaving}
                />
                {teamValues.length > 1 && (
                  <button
                    onClick={() => setTeamValues((prev) => prev.filter((_, i) => i !== index))}
                    disabled={isSaving}
                    className="p-1.5 rounded-lg text-stone-500 hover:text-white hover:bg-white/5 disabled:opacity-50"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => setTeamValues((prev) => [...prev, ''])}
              disabled={isSaving}
              className="text-[11px] text-purple-300 hover:text-white disabled:opacity-50"
            >
              + Add another team value
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-stone-300">
            <input type="checkbox" checked={isSharedResource} onChange={(e) => setIsSharedResource(e.target.checked)} disabled={isSaving} />
            Shared resource (visible to every non-sales employee, like Creative &amp; Design)
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setIsAddingNew(false);
                resetForm();
              }}
              disabled={isSaving}
              className="px-2.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={isSaving}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
            >
              <Plus className="w-3 h-3" />
              Add Department
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAddingNew(true)}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-purple-300 hover:text-white bg-purple-900/20 hover:bg-purple-800/40 border border-purple-700/30 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Department
        </button>
      )}
    </div>
  );
};

// --- Custom Roles tab --------------------------------------------------------------------------

const RolesTab: React.FC<{
  currentUserId: string;
  users: UserRecord[];
  onDataChanged: () => Promise<void>;
  onRoleCreated?: (roleId: string) => void;
}> = ({ currentUserId, users, onDataChanged, onRoleCreated }) => {
  const roles = getAllCustomRoles();
  const activeDepartments = getAllDepartments().filter((d) => d.is_active);

  const [isAddingNew, setIsAddingNew] = useState(false);
  const [englishTitle, setEnglishTitle] = useState('');
  const [arabicTitle, setArabicTitle] = useState('');
  const [departmentId, setDepartmentId] = useState(activeDepartments[0]?.id || '');
  const [defaultModule, setDefaultModule] = useState<AppModuleId>('my_work');
  const [allowedModules, setAllowedModules] = useState<AppModuleId[]>(['my_work']);
  const [permissionOverrides, setPermissionOverrides] = useState<Partial<Record<CapabilityKey, PermissionOverrideState>>>({});
  const [isActive, setIsActive] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [deactivateEmployeeCount, setDeactivateEmployeeCount] = useState(0);

  const resetForm = () => {
    setEnglishTitle('');
    setArabicTitle('');
    setDepartmentId(activeDepartments[0]?.id || '');
    setDefaultModule('my_work');
    setAllowedModules(['my_work']);
    setPermissionOverrides({});
    setIsActive(true);
    setErrorMsg('');
  };

  const toggleModule = (moduleId: AppModuleId) => {
    setAllowedModules((prev) => (prev.includes(moduleId) ? prev.filter((m) => m !== moduleId) : [...prev, moduleId]));
  };

  const handleCreate = async () => {
    const trimmedTitle = englishTitle.trim();
    if (!trimmedTitle) {
      setErrorMsg('Please enter an English title.');
      return;
    }
    if (!departmentId) {
      setErrorMsg('Please choose a department.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      const result = await createCustomRole({
        englishTitle: trimmedTitle,
        arabicTitle: arabicTitle.trim() || null,
        departmentId,
        defaultModule,
        allowedModules,
        permissionOverrides,
        isActive,
        createdBy: currentUserId,
      });
      if (!result.success || !result.data) {
        setErrorMsg(result.error || 'Unable to create this role.');
        return;
      }
      await onDataChanged();
      onRoleCreated?.(result.data.id);
      resetForm();
      setIsAddingNew(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to create this role.');
    } finally {
      setIsSaving(false);
    }
  };

  const startDeactivate = (roleId: string) => {
    setDeactivateEmployeeCount(countActiveEmployeesHoldingRole(roleId, users));
    setDeactivatingId(roleId);
    setErrorMsg('');
  };

  const handleDeactivate = async (roleId: string) => {
    setErrorMsg('');
    setIsSaving(true);
    try {
      const result = await deactivateCustomRole(roleId);
      if (!result.success) {
        setErrorMsg(result.error || 'Unable to deactivate this role.');
        return;
      }
      await onDataChanged();
      setDeactivatingId(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to deactivate this role.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {errorMsg && (
        <div className="p-2.5 rounded-lg text-xs bg-red-950/30 text-red-300 border border-red-800/40 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {errorMsg}
        </div>
      )}

      <div className="space-y-2">
        {roles.map((role) => {
          const department = role.department_id ? getDepartmentById(role.department_id) : null;
          return (
            <div
              key={role.id}
              className="p-3 rounded-xl border"
              style={{ background: 'rgba(10, 10, 13, 0.5)', borderColor: 'var(--border-soft)', opacity: role.is_active ? 1 : 0.55 }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">
                    {role.english_title}
                    {!role.is_active && <span className="ml-1.5 text-[10px] text-stone-500">Inactive</span>}
                  </p>
                  <p className="text-[11px] text-stone-500 font-mono">{role.id}</p>
                  <p className="text-[11px] text-stone-400 mt-0.5">Department: {department?.label || '—'}</p>
                </div>
                <div className="shrink-0">
                  {!role.is_active ? null : deactivatingId === role.id ? (
                    <div className="flex items-center gap-1.5">
                      {deactivateEmployeeCount > 0 && (
                        <span className="text-[11px] text-amber-400">
                          {deactivateEmployeeCount} employee(s) will lose access until reassigned
                        </span>
                      )}
                      <button
                        onClick={() => setDeactivatingId(null)}
                        className="px-2 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleDeactivate(role.id)}
                        disabled={isSaving}
                        className="px-2 py-1 rounded-lg text-[11px] font-bold text-white bg-red-700 hover:bg-red-600 disabled:opacity-50"
                      >
                        Confirm Deactivate
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => startDeactivate(role.id)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white hover:bg-white/5"
                    >
                      <Trash2 className="w-3 h-3" />
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {isAddingNew ? (
        <div className="p-3 rounded-xl border border-dashed border-purple-700/40 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>English Title *</label>
              <input
                type="text"
                value={englishTitle}
                onChange={(e) => setEnglishTitle(e.target.value)}
                placeholder="e.g. UI Designer"
                className={inputClass}
                disabled={isSaving}
              />
            </div>
            <div>
              <label className={labelClass}>Arabic Title (optional)</label>
              <input
                type="text"
                dir="auto"
                value={arabicTitle}
                onChange={(e) => setArabicTitle(e.target.value)}
                className={inputClass}
                disabled={isSaving}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Department *</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={`${inputClass} cursor-pointer`} disabled={isSaving}>
              {activeDepartments.map((d) => (
                <option key={d.id} value={d.id} className="bg-stone-900">
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Default Module</label>
            <select
              value={defaultModule}
              onChange={(e) => {
                const newDefault = e.target.value as AppModuleId;
                setDefaultModule(newDefault);
                // Keeps the Allowed Modules checkboxes honest about what will actually be saved
                // — createCustomRole() enforces this same rule regardless (default_module is
                // always one of allowedModules), this just avoids a surprising mismatch between
                // what's shown checked here and what gets written.
                setAllowedModules((prev) => normalizeAllowedModules(prev, newDefault));
              }}
              className={`${inputClass} cursor-pointer`}
              disabled={isSaving}
            >
              {ALL_MODULE_IDS.map((m) => (
                <option key={m.id} value={m.id} className="bg-stone-900">
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Allowed Modules</label>
            <div className="grid grid-cols-3 gap-1.5">
              {ALL_MODULE_IDS.map((m) => (
                <label key={m.id} className="flex items-center gap-1 text-[11px] text-stone-300">
                  <input type="checkbox" checked={allowedModules.includes(m.id)} onChange={() => toggleModule(m.id)} disabled={isSaving} />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className={labelClass}>Permissions</label>
            <div className="space-y-1.5">
              {GRANTABLE_CAPABILITY_CATALOG.map((cap) => (
                <div key={cap.key} className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-stone-300">
                    {cap.label}
                    {!cap.enforced && <span className="ml-1.5 text-[10px] text-stone-500">(not yet enforced)</span>}
                  </span>
                  <select
                    value={permissionOverrides[cap.key] || 'inherit'}
                    onChange={(e) =>
                      setPermissionOverrides((prev) => ({ ...prev, [cap.key]: e.target.value as PermissionOverrideState }))
                    }
                    className="px-2 py-1 rounded-lg text-[11px] bg-stone-900 border border-stone-800 text-white cursor-pointer"
                    disabled={isSaving}
                  >
                    <option value="inherit">Inherit (department default)</option>
                    <option value="grant">Force Grant</option>
                    <option value="revoke">Force Revoke</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-stone-300">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={isSaving} />
            Active (uncheck to create this role already deactivated)
          </label>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setIsAddingNew(false);
                resetForm();
              }}
              disabled={isSaving}
              className="px-2.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={isSaving}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
            >
              <Plus className="w-3 h-3" />
              Add Role
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAddingNew(true)}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-purple-300 hover:text-white bg-purple-900/20 hover:bg-purple-800/40 border border-purple-700/30 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Custom Role
        </button>
      )}
    </div>
  );
};
