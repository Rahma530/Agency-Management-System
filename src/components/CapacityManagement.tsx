import React, { useState, useMemo, useEffect } from 'react';
import {
  Users,
  Gauge,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Edit2,
  Save,
  X,
  Building2,
  CheckSquare,
  ShieldAlert,
  ShieldCheck,
  Search,
  Filter,
  Layers,
  Calendar,
  Clock,
  UserCheck,
  UserX,
  PlusCircle,
  Table as TableIcon,
  LayoutGrid,
  History,
  Briefcase,
  AlertCircle,
  ArrowUpRight,
} from 'lucide-react';
import {
  UserRecord,
  ClientRecord,
  TaskRecord,
  CapacityLogRecord,
  ExtraNoteRecord,
  UserRole,
} from '../types/database';
import { getRoleInfo, AppModuleId } from '../data/roles';
import { isActiveEmployee, canManageClientsFromCapacity, canManageEmployeesFromCapacity } from '../lib/permissions';
import { isTeamLeadRole, resolveCapacityLimit, getUserCapacityData as getSharedUserCapacityData } from '../lib/capacity';
import { getEmployeesByDepartment } from '../lib/departmentStaffing';
import { ImportDataModal } from './ImportDataModal';

interface CapacityManagementProps {
  users: UserRecord[];
  clients: ClientRecord[];
  tasks: TaskRecord[];
  capacityLogs: CapacityLogRecord[];
  currentUser?: UserRecord;
  onUpdateUserCapacity: (userId: string, newLimit: number) => Promise<void>;
  onLogCapacity?: (agentId: string, date: string, count: number) => Promise<void>;
  onNavigateToModule?: (module: AppModuleId, prefillAssigneeName?: string) => void;
  extraNotes?: ExtraNoteRecord[];
}

export type CapacityStatus = 'all' | 'available' | 'near_capacity' | 'over_capacity';
export type ViewMode = 'cards' | 'matrix' | 'logs';

// Reverse link (point 4): always points to the Tasks module, prefilled with
// this employee's name — the one place their assigned work is visible
// regardless of role, without guessing at a per-role destination.
const getAssignmentLink = (
  user: UserRecord
): { moduleId: AppModuleId; prefill?: string; label: string } | null => {
  return { moduleId: 'tasks', prefill: user.name, label: `View ${user.name}'s assigned tasks` };
};

export const CapacityManagement: React.FC<CapacityManagementProps> = ({
  users,
  clients,
  tasks,
  capacityLogs,
  currentUser,
  onUpdateUserCapacity,
  onLogCapacity,
  onNavigateToModule,
  extraNotes = [],
}) => {
  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('cards');

  // Filters
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const [selectedRole, setSelectedRole] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<CapacityStatus>('all');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');

  // Editing capacity limit state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [tempLimit, setTempLimit] = useState<number>(8);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // New Capacity Log modal state
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  // No longer defaults to the unscoped users[0] — synced to logCapacityEmployees by the effect
  // below whenever the modal opens.
  const [logAgentId, setLogAgentId] = useState('');
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0]);
  const [logCount, setLogCount] = useState<number>(4);
  const [isLoggingSubmitting, setIsLoggingSubmitting] = useState(false);

  // Import Modals State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importType, setImportType] = useState<'users' | 'clients'>('users');

  // RLS Permissions check:
  // Only executives, head of technical, and team leads have rights to modify employee capacity limits
  const canModifyCapacity = useMemo(() => {
    if (!currentUser) return true;
    const allowedRoles: UserRole[] = [
      'executive',
      'head_of_technical',
      'am_team_lead',
      'media_buying_team_lead',
      'seo_team_lead',
      'social_media_team_lead',
    ];
    if (!currentUser?.role) return false;
    return allowedRoles.includes(currentUser.role);
  }, [currentUser]);

  // Operational roles to monitor
  const operationalRoles: UserRole[] = [
    'executive',
    'head_of_technical',
    'marketing_manager',
    'sales',
    'am_team_lead',
    'am_agent',
    'media_buying_team_lead',
    'media_buying_agent',
    'seo_team_lead',
    'seo_agent',
    'seo_content_agent',
    'seo_backlink_agent',
    'social_media_team_lead',
    'social_media_agent',
    'graphic_designer',
    'video_editor',
  ];

  const operationalUsers = useMemo(() => {
    // Under Supabase RLS, `users` is scoped by the backend data access layer.
    // For Team Leaders, the Detailed Team Matrix & Employee Cards reflect:
    // Team Leader -> Team Agents ONLY — no other department, and no Creative & Design pool either
    // (that pool's capacity is already visible inline everywhere it matters — e.g. the Task Board's
    // assignee dropdown — so it doesn't need a standing presence on this dashboard too). That prior
    // cross-linking (OTHER_TEAM_LEAD_ROLES) was removed entirely; it wasn't load-bearing for
    // anything else in this file.
    const role = currentUser?.role;
    let result: UserRecord[];
    if (role === 'am_team_lead') {
      result = users.filter((u) => u.role === 'am_agent');
    } else if (role === 'media_buying_team_lead') {
      result = users.filter((u) => u.role === 'media_buying_agent');
    } else if (role === 'seo_team_lead') {
      result = users.filter(
        (u) =>
          u.role === 'seo_agent' ||
          u.role === 'seo_content_agent' ||
          u.role === 'seo_backlink_agent' ||
          // programming_agent has no dedicated team lead of its own — exclusively managed by
          // seo_team_lead.
          u.role === 'programming_agent'
      );
    } else if (role === 'social_media_team_lead') {
      result = users.filter((u) => u.role === 'social_media_agent');
    } else if (role === 'marketing_manager') {
      // NOT a team lead — narrow, read-only view of ONLY the shared creative pool (no other
      // team lead cross-visibility the way the branches above get). canModifyCapacity's
      // allowedRoles list below intentionally excludes marketing_manager, so this view never
      // gets an edit affordance regardless.
      result = users.filter((u) => u.role === 'graphic_designer' || u.role === 'video_editor');
    } else {
      result = users.filter(
        (u) => operationalRoles.includes(u.role) || (u.capacity_limit && u.capacity_limit > 0)
      );
    }
    // Executive and Head of Technical never receive task assignments, so they
    // never belong in a capacity/workload employee list — even when the
    // viewer is one of them. Pending employees (no Auth account yet, added via
    // the Add Employee admin screen) are excluded too — they can't be assigned
    // capacity or workload until scripts/provisionAuthUsers.ts activates them.
    return result.filter((u) => u.role !== 'executive' && u.role !== 'head_of_technical' && isActiveEmployee(u));
  }, [users, currentUser]);

  // "Log New Capacity Reading" gets its OWN, narrower employee list — deliberately separate from
  // operationalUsers above. That broader list's cross-team visibility (shared Creative pool, other
  // team leads) is intentional and correct for VIEWING capacity on this screen, but logging a new
  // reading is a write action that should stay inside the target employee's own management chain:
  // a team lead sees only their own department (reusing the same getEmployeesByDepartment()
  // department-scoped picker used elsewhere — New Task, campaign assignment), while
  // executive/head_of_technical still see every active employee company-wide.
  const logCapacityEmployees = useMemo(() => {
    if (currentUser?.role === 'executive' || currentUser?.role === 'head_of_technical') {
      return users.filter((u) => u.role !== 'executive' && u.role !== 'head_of_technical' && isActiveEmployee(u));
    }
    return getEmployeesByDepartment(users, currentUser?.team);
  }, [users, currentUser]);

  // logAgentId used to default to the unscoped users[0] at mount, which often wasn't even a
  // member of logCapacityEmployees (e.g. a team lead's default could be an employee in a
  // different department entirely) — the dropdown would then silently show no real selection.
  // Two separate buttons open this modal, so a single onClick fix would be easy to miss updating
  // on the other one; resetting here instead covers both, and self-heals if the underlying list
  // ever changes while the modal happens to be open.
  useEffect(() => {
    if (!isLogModalOpen) return;
    if (!logCapacityEmployees.some((u) => u.id === logAgentId)) {
      setLogAgentId(logCapacityEmployees[0]?.id || '');
    }
  }, [isLogModalOpen, logCapacityEmployees]);

  // Dynamically derived departments list reflecting only visible employees under RLS
  const availableTeams = useMemo(() => {
    const teams = new Set<string>();
    operationalUsers.forEach((u) => {
      if (u.team) teams.add(u.team);
    });
    return teams;
  }, [operationalUsers]);

  const departments = useMemo(() => {
    const list: { id: string; label: string }[] = [
      { id: 'all', label: 'All Available Departments & Teams' },
    ];
    if (availableTeams.has('Executive')) list.push({ id: 'Executive', label: 'Executive Management' });
    if (availableTeams.has('Technical')) list.push({ id: 'Technical', label: 'Technical & Operations' });
    if (availableTeams.has('Sales')) list.push({ id: 'Sales', label: 'Sales Team' });
    // Only ever populated by a marketing_manager's own record surfacing under the generic
    // capacity branch above (e.g. for an executive/head_of_technical viewer) — graphic_designer/
    // video_editor (the roles marketing_manager actually oversees) sit in "Creative & Design"/
    // "Video Production" below, not here.
    if (availableTeams.has('Marketing')) list.push({ id: 'Marketing', label: 'Marketing' });
    if (availableTeams.has('Account Management')) list.push({ id: 'Account Management', label: 'Account Management (AM)' });
    if (availableTeams.has('Media Buying')) list.push({ id: 'Media Buying', label: 'Media Buying' });
    if (availableTeams.has('SEO')) list.push({ id: 'SEO', label: 'Search Engine Optimization (SEO)' });
    if (availableTeams.has('Social Media')) list.push({ id: 'Social Media', label: 'Social Media' });
    if (availableTeams.has('Creative & Design')) list.push({ id: 'Creative & Design', label: 'Design (shared resource)' });
    if (availableTeams.has('Video Production')) list.push({ id: 'Video Production', label: 'Video Editing & Production (shared resource)' });
    return list;
  }, [availableTeams]);

  // Dynamically derived roles list reflecting only visible employees under RLS
  const availableRoles = useMemo(() => {
    const roles = new Set<UserRole>();
    operationalUsers.forEach((u) => roles.add(u.role));
    return roles;
  }, [operationalUsers]);

  const rolesList = useMemo(() => {
    const allDefs: { id: UserRole; label: string }[] = [
      { id: 'executive', label: 'Executive Management (C-level)' },
      { id: 'head_of_technical', label: 'Head of Technical' },
      { id: 'marketing_manager', label: 'Marketing Manager' },
      { id: 'sales', label: 'Sales Team (Sales)' },
      { id: 'am_team_lead', label: 'AM Team Leader' },
      { id: 'am_agent', label: 'AM Agent' },
      { id: 'media_buying_team_lead', label: 'Media Buying Team Leader' },
      { id: 'media_buying_agent', label: 'Media Buying Agent' },
      { id: 'seo_team_lead', label: 'SEO Team Leader' },
      { id: 'seo_agent', label: 'SEO Agent' },
      { id: 'seo_content_agent', label: 'SEO Content Specialist' },
      { id: 'seo_backlink_agent', label: 'SEO Backlink Specialist' },
      { id: 'social_media_team_lead', label: 'Social Media Team Leader' },
      { id: 'social_media_agent', label: 'Social Media Agent' },
      { id: 'graphic_designer', label: 'Graphic Designer (shared resource)' },
      { id: 'video_editor', label: 'Video Editor (shared resource)' },
    ];
    return [
      { id: 'all', label: `All Available Roles (${operationalUsers.length} employees)` },
      ...allDefs.filter((d) => availableRoles.has(d.id)),
    ];
  }, [operationalUsers, availableRoles]);

  // Helper to calculate workload and status for each user — delegates to the
  // shared definition (src/lib/capacity.ts) that CrossTeamTaskBoard, AMQueue
  // and ServiceBriefsRoutingView also use, adding this screen's own
  // date-scoped capacity log lookup on top.
  const getUserCapacityData = (user: UserRecord) => {
    const base = getSharedUserCapacityData(user, clients, tasks);

    // Historical capacity log for this user if date selected
    const userLogs = capacityLogs.filter((log) => log.agent_id === user.id);
    const dateSpecificLog = selectedDate
      ? userLogs.find((l) => l.date === selectedDate)
      : undefined;

    return {
      ...base,
      userLogs,
      dateSpecificLog,
    };
  };

  // Filtered list of users
  const filteredUserData = useMemo(() => {
    return operationalUsers
      .map(getUserCapacityData)
      .filter((item) => {
        // Department filter
        const matchDept =
          selectedDepartment === 'all' ||
          (selectedDepartment === 'Creative & Design'
            ? item.user.team === 'Creative & Design' || item.user.team === 'Video Production'
            : item.user.team === selectedDepartment);

        // Role filter
        const matchRole = selectedRole === 'all' || item.user.role === selectedRole;

        // Status filter
        const matchStatus = selectedStatus === 'all' || item.status === selectedStatus;

        // Search query filter (employee name or team)
        const matchSearch =
          !searchQuery.trim() ||
          item.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (item.user.team && item.user.team.toLowerCase().includes(searchQuery.toLowerCase()));

        // Date filter check: if a date is selected, check if user has logs on that date or is active
        const matchDate = !selectedDate || item.userLogs.some((l) => l.date === selectedDate);

        return matchDept && matchRole && matchStatus && matchSearch && matchDate;
      });
  }, [operationalUsers, selectedDepartment, selectedRole, selectedStatus, searchQuery, selectedDate, clients, tasks, capacityLogs]);

  // Overall Statistics for KPIs
  const allUserData = useMemo(() => operationalUsers.map(getUserCapacityData), [operationalUsers, clients, tasks, capacityLogs]);

  const totalCapacitySum = allUserData.reduce((acc, curr) => acc + curr.capacityLimit, 0);
  const totalUsedSum = allUserData.reduce((acc, curr) => acc + curr.usedCapacity, 0);
  const overallUtilization = totalCapacitySum > 0 ? Math.round((totalUsedSum / totalCapacitySum) * 100) : 0;
  const availableCount = allUserData.filter((u) => u.status === 'available').length;
  const nearCapacityCount = allUserData.filter((u) => u.status === 'near_capacity').length;
  const overCapacityCount = allUserData.filter((u) => u.status === 'over_capacity').length;
  const totalBuffer = Math.max(0, totalCapacitySum - totalUsedSum);

  // Log Capacity modal: non-blocking over-capacity warning. Logging a reading for an
  // already-over-capacity employee (or a reading that would itself push them over their
  // capacityLimit) is still allowed to proceed — this only surfaces a visible alert, it never
  // gates handleLogCapacitySubmit below. isUntracked (capacityLimit === 0, normal for team
  // leads) has no over-capacity concept, so it's excluded from the "new reading" check.
  const selectedLogEmployeeData = allUserData.find((d) => d.user.id === logAgentId);
  const willExceedCapacityWithNewReading =
    !!selectedLogEmployeeData &&
    !selectedLogEmployeeData.isUntracked &&
    logCount > selectedLogEmployeeData.capacityLimit;
  const showLogCapacityOverCapacityWarning =
    selectedLogEmployeeData?.status === 'over_capacity' || willExceedCapacityWithNewReading;

  // Handlers
  const handleStartEdit = (user: UserRecord) => {
    if (!canModifyCapacity) {
      setStatusMessage({
        text: 'RLS permissions: capacity limit changes are restricted to executive management and team leads.',
        type: 'error',
      });
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }
    setEditingUserId(user.id);
    setTempLimit(resolveCapacityLimit(user));
  };

  const handleSaveLimit = async (userId: string) => {
    const targetUser = users.find((u) => u.id === userId);
    const minLimit = isTeamLeadRole(targetUser?.role) ? 0 : 1;
    if (tempLimit < minLimit) return;
    setIsSaving(true);
    try {
      await onUpdateUserCapacity(userId, tempLimit);
      setEditingUserId(null);
      setStatusMessage({ text: 'Capacity limit updated successfully in the database.', type: 'success' });
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err: any) {
      console.error(err);
      setStatusMessage({ text: 'An error occurred while saving the capacity limit.', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogCapacitySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onLogCapacity || !logAgentId || logCount < 0) return;
    setIsLoggingSubmitting(true);
    try {
      await onLogCapacity(logAgentId, logDate, logCount);
      setIsLogModalOpen(false);
      setStatusMessage({ text: 'Capacity reading logged successfully.', type: 'success' });
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err) {
      console.error(err);
      setStatusMessage({ text: 'Failed to log the capacity reading.', type: 'error' });
    } finally {
      setIsLoggingSubmitting(false);
    }
  };

  const getRoleBadge = (role: UserRole) => {
    const info = getRoleInfo(role);
    return {
      label: info.englishTitle,
      bg: info.badgeBg,
      text: info.badgeText,
    };
  };


  return (
    <div className="capacity-management space-y-6">
      {/* RLS / Operational Alert Message */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-xl text-xs flex items-center justify-between gap-3 shadow-lg transition-all ${
            statusMessage.type === 'success'
              ? 'bg-[rgba(169,245,193,0.15)] border border-[var(--roas-good)] text-[var(--roas-good)]'
              : 'bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="font-semibold">{statusMessage.text}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-xs opacity-70 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Top Section: Dashboard KPIs for Executive and Team Leads */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Total Utilization */}
        <div
          className="p-4 rounded-[18px] flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--grey)' }}>
              Overall Utilization Rate
            </p>
            <p
              className="text-2xl font-bold mt-1"
              style={{
                color:
                  overallUtilization >= 95
                    ? 'var(--roas-bad)'
                    : overallUtilization >= 75
                    ? 'var(--roas-mid)'
                    : 'var(--white)',
              }}
            >
              {overallUtilization}%
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--lilac)' }}>
              {totalUsedSum} used out of {totalCapacitySum} max capacity
            </p>
          </div>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(123, 47, 247, 0.2)',
              color: 'var(--purple-light)',
              border: '1px solid var(--border-soft)',
            }}
          >
            <Gauge className="w-5 h-5" />
          </div>
        </div>

        {/* Available Employees (< 75%) */}
        <div
          className="p-4 rounded-[18px] flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--grey)' }}>
              Available
            </p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--roas-good)' }}>
              {availableCount} <span className="text-xs font-normal text-stone-400">employees</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--roas-good)' }}>
              &lt;75%
            </p>
          </div>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(169, 245, 193, 0.15)',
              color: 'var(--roas-good)',
              border: '1px solid rgba(169, 245, 193, 0.3)',
            }}
          >
            <UserCheck className="w-5 h-5" />
          </div>
        </div>

        {/* Near Capacity (75% - 99%) */}
        <div
          className="p-4 rounded-[18px] flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--grey)' }}>
              Near Capacity
            </p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--roas-mid)' }}>
              {nearCapacityCount} <span className="text-xs font-normal text-stone-400">employees</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--roas-mid)' }}>
              75-99%
            </p>
          </div>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(245, 226, 154, 0.15)',
              color: 'var(--roas-mid)',
              border: '1px solid rgba(245, 226, 154, 0.3)',
            }}
          >
            <Clock className="w-5 h-5" />
          </div>
        </div>

        {/* Over Capacity (>= 100%) */}
        <div
          className="p-4 rounded-[18px] flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--grey)' }}>
              Over Capacity
            </p>
            <p
              className="text-2xl font-bold mt-1"
              style={{ color: overCapacityCount > 0 ? 'var(--roas-bad)' : 'var(--white)' }}
            >
              {overCapacityCount} <span className="text-xs font-normal text-stone-400">employees</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--roas-bad)' }}>
              100%+
            </p>
          </div>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(245, 163, 163, 0.15)',
              color: 'var(--roas-bad)',
              border: '1px solid rgba(245, 163, 163, 0.3)',
            }}
          >
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>

        {/* Capacity Buffer */}
        <div
          className="p-4 rounded-[18px] flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--grey)' }}>
              Capacity Buffer
            </p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--purple-light)' }}>
              {totalBuffer} <span className="text-xs font-normal text-stone-400">open slots</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--lilac)' }}>
              Ready to take on work immediately
            </p>
          </div>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(123, 47, 247, 0.15)',
              color: 'var(--purple-light)',
              border: '1px solid var(--border-soft)',
            }}
          >
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Control Bar: Filters, Date, Search, View Mode, and Log Capacity Action */}
      <div
        className="p-4 rounded-[18px] space-y-4"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* View Mode Toggle */}
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-stone-900/60 border border-stone-800">
            <button
              onClick={() => setViewMode('cards')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                viewMode === 'cards'
                  ? 'bg-purple-600/30 text-white border border-purple-500/50'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Employee Cards</span>
            </button>
            <button
              onClick={() => setViewMode('matrix')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                viewMode === 'matrix'
                  ? 'bg-purple-600/30 text-white border border-purple-500/50'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" />
              <span>Detailed Team Matrix</span>
            </button>
            <button
              onClick={() => setViewMode('logs')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                viewMode === 'logs'
                  ? 'bg-purple-600/30 text-white border border-purple-500/50'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Capacity Logs</span>
            </button>
          </div>

          {/* Log Capacity Action Button */}
          <div className="flex items-center gap-3">
            {canModifyCapacity ? (
              <button
                onClick={() => setIsLogModalOpen(true)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold text-white transition-all shadow-md hover:opacity-90 active:scale-98"
                style={{
                  background: 'var(--gradient-badge)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                <PlusCircle className="w-3.5 h-3.5 text-purple-300" />
                <span>Log Capacity Reading</span>
              </button>
            ) : (
              <div
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] text-stone-400 border border-stone-800 bg-stone-900/40"
                title="RLS policies restrict capacity changes to managers only"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-stone-500" />
                <span>View Mode (Standard User)</span>
              </div>
            )}
          </div>
        </div>

        {/* Filter Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 pt-2 border-t border-stone-800/60">
          {/* Department Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              Department / Team:
            </label>
            <select
              value={selectedDepartment}
              onChange={(e) => setSelectedDepartment(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id} className="bg-stone-900 text-white">
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          {/* Role Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              Role:
            </label>
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              {rolesList.map((r) => (
                <option key={r.id} value={r.id} className="bg-stone-900 text-white">
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Capacity Status Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              Capacity Status:
            </label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value as CapacityStatus)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="all" className="bg-stone-900 text-white">All Statuses</option>
              <option value="available" className="bg-stone-900 text-white">Available (under 75%)</option>
              <option value="near_capacity" className="bg-stone-900 text-white">Near Capacity (75% - 99%)</option>
              <option value="over_capacity" className="bg-stone-900 text-white">Over Capacity (100%+)</option>
            </select>
          </div>

          {/* Date Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              Log Date:
            </label>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
              />
              {selectedDate && (
                <button
                  onClick={() => setSelectedDate('')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-white"
                  title="Clear date"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Search Employee Name / Team */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              Quick Search:
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-stone-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by employee name or team..."
                className="w-full pr-8 pl-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* VIEW 1: Employee Cards View */}
      {viewMode === 'cards' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-stone-400 px-1">
            <span>
              Showing {filteredUserData.length} employees matching the selected filters
            </span>
            <span className="text-[11px] text-stone-500">
              * Capacity is calculated from active clients (for Account Management) and active tasks (for technical teams).
            </span>
          </div>

          {filteredUserData.length === 0 ? (
            <div
              className="p-8 text-center rounded-[20px]"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' }}
            >
              <Users className="w-10 h-10 mx-auto text-stone-600 mb-2" />
              <p className="text-sm font-semibold text-white">No employees found</p>
              <p className="text-xs text-stone-400 mt-1">
                Try adjusting the filter options or clearing the search fields.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredUserData.map((item) => {
                const roleBadge = getRoleBadge(item.user.role);
                const isEditing = editingUserId === item.user.id;

                let statusBadgeText = 'Available';
                let statusBadgeBg = 'rgba(169, 245, 193, 0.15)';
                let statusBadgeColor = 'var(--roas-good)';
                let statusBadgeBorder = 'rgba(169, 245, 193, 0.3)';

                if (item.status === 'over_capacity') {
                  statusBadgeText = 'Over Capacity';
                  statusBadgeBg = 'rgba(245, 163, 163, 0.15)';
                  statusBadgeColor = 'var(--roas-bad)';
                  statusBadgeBorder = 'rgba(245, 163, 163, 0.3)';
                } else if (item.status === 'near_capacity') {
                  statusBadgeText = 'Near Capacity';
                  statusBadgeBg = 'rgba(245, 226, 154, 0.15)';
                  statusBadgeColor = 'var(--roas-mid)';
                  statusBadgeBorder = 'rgba(245, 226, 154, 0.3)';
                }

                return (
                  <div
                    key={item.user.id}
                    className="p-4 rounded-[18px] transition-all relative overflow-hidden flex flex-col justify-between"
                    style={{
                      background: 'var(--gradient-card)',
                      border: `1px solid ${
                        item.status === 'over_capacity'
                          ? 'rgba(245, 163, 163, 0.4)'
                          : 'var(--border-medium)'
                      }`,
                    }}
                  >
                    {/* Top User Info */}
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
                            style={{
                              background: 'var(--gradient-badge)',
                              color: 'var(--on-accent)',
                              border: '1px solid var(--border-medium)',
                            }}
                          >
                            {item.user.name.charAt(0)}
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-white">{item.user.name}</h4>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span
                                className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{ background: roleBadge.bg, color: roleBadge.text }}
                              >
                                {roleBadge.label}
                              </span>
                              {item.user.team && (
                                <span className="text-[10px] text-stone-400">
                                  • {item.user.team}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Status Badge */}
                        <span
                          className="px-2.5 py-1 rounded-full text-[10px] font-bold shrink-0"
                          style={{
                            background: statusBadgeBg,
                            color: statusBadgeColor,
                            border: `1px solid ${statusBadgeBorder}`,
                          }}
                        >
                          {statusBadgeText}
                        </span>
                      </div>

                      {/* Capacity Metrics: Used vs Remaining vs Limit */}
                      <div className="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-stone-900/60 border border-stone-800/80 text-center">
                        <div>
                          <p className="text-[10px] text-stone-400">Used</p>
                          <p className="text-sm font-bold text-white mt-0.5">
                            {item.usedCapacity}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-stone-400">Remaining (Buffer)</p>
                          <p
                            className="text-sm font-bold mt-0.5"
                            style={{
                              color: item.remainingCapacity > 0 ? 'var(--roas-good)' : 'var(--roas-bad)',
                            }}
                          >
                            {item.remainingCapacity}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-stone-400">Limit</p>
                          <div className="flex items-center justify-center gap-1 mt-0.5">
                            <span className="text-sm font-bold text-purple-300">
                              {item.capacityLimit}
                            </span>
                            {canModifyCapacity && !isEditing && (
                              <button
                                onClick={() => handleStartEdit(item.user)}
                                className="text-stone-500 hover:text-purple-300 p-0.5 transition-colors"
                                title="Edit capacity limit (RLS Authorized)"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Edit Capacity Inline Form */}
                      {isEditing && (
                        <div className="p-2.5 rounded-xl bg-purple-950/40 border border-purple-500/40 space-y-2">
                          <div className="flex items-center justify-between text-xs text-purple-200">
                            <span className="font-semibold">Edit capacity limit:</span>
                            <button
                              onClick={() => setEditingUserId(null)}
                              className="text-stone-400 hover:text-white"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={isTeamLeadRole(item.user.role) ? 0 : 1}
                              max="30"
                              value={tempLimit}
                              onChange={(e) => {
                                const parsed = parseInt(e.target.value, 10);
                                setTempLimit(Number.isNaN(parsed) ? 0 : parsed);
                              }}
                              className="w-20 px-2 py-1 rounded-lg text-xs bg-stone-900 border border-purple-400/50 text-white font-bold text-center focus:outline-none"
                            />
                            <button
                              onClick={() => handleSaveLimit(item.user.id)}
                              disabled={isSaving}
                              className="flex-1 py-1 px-3 rounded-lg text-xs font-bold text-white flex items-center justify-center gap-1.5 transition-all"
                              style={{ background: 'var(--gradient-badge)' }}
                            >
                              <Save className="w-3 h-3" />
                              <span>{isSaving ? 'Saving...' : 'Confirm Capacity'}</span>
                            </button>
                          </div>
                          {isTeamLeadRole(item.user.role) && (
                            <p className="text-[10px] text-stone-400">
                              0 is valid for team leads — they don't need a tracked capacity buffer.
                            </p>
                          )}
                        </div>
                      )}

                      {/* Visual Progress Bar */}
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <span className="text-stone-400 text-[11px]">Current utilization rate:</span>
                          <span
                            className={`font-bold text-xs ${item.isUntracked ? 'text-stone-400' : ''}`}
                            style={item.isUntracked ? undefined : { color: statusBadgeColor }}
                          >
                            {item.isUntracked ? 'N/A' : `${item.utilizationRate}%`}
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-stone-800 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: item.isUntracked ? '0%' : `${Math.min(100, item.utilizationRate)}%`,
                              background:
                                item.status === 'over_capacity'
                                  ? 'var(--roas-bad)'
                                  : item.status === 'near_capacity'
                                  ? 'var(--roas-mid)'
                                  : 'var(--roas-good)',
                            }}
                          />
                        </div>
                      </div>

                      {/* Active Assignments Overview */}
                      <div className="space-y-1.5 pt-1">
                        {item.user.role === 'am_agent' || item.user.role === 'am_team_lead' ? (
                          <div>
                            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
                              <span className="flex items-center gap-1">
                                <Building2 className="w-3 h-3 text-purple-400" />
                                <span>Assigned Clients ({item.assignedClients.length}):</span>
                              </span>
                            </div>
                            {item.assignedClients.length > 0 ? (
                              <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto pr-0.5">
                                {item.assignedClients.map((client) => (
                                  <span
                                    key={client.id}
                                    className="px-2 py-0.5 rounded-md text-[10px] bg-stone-900/90 text-stone-300 border border-stone-800"
                                  >
                                    {client.name}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[10px] text-stone-500 italic">
                                No clients currently assigned (fully available)
                              </p>
                            )}
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
                              <span className="flex items-center gap-1">
                                <CheckSquare className="w-3 h-3 text-purple-400" />
                                <span>Active Assigned Tasks ({item.activeTasks.length}):</span>
                              </span>
                            </div>
                            {item.activeTasks.length > 0 ? (
                              <div className="space-y-1 max-h-16 overflow-y-auto pr-0.5">
                                {item.activeTasks.slice(0, 2).map((task) => (
                                  <div
                                    key={task.id}
                                    className="text-[10px] p-1 rounded bg-stone-900/80 text-stone-300 truncate border border-stone-800/80"
                                    title={task.title}
                                  >
                                    • {task.title}
                                  </div>
                                ))}
                                {item.activeTasks.length > 2 && (
                                  <p className="text-[10px] text-purple-400">
                                    + {item.activeTasks.length - 2} more tasks in progress
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-[10px] text-stone-500 italic">
                                No active tasks right now (available for work)
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Reverse link (point 4): jump to where this employee is assigned work */}
                    {(() => {
                      const assignLink = getAssignmentLink(item.user);
                      if (!assignLink) return null;
                      return (
                        <button
                          onClick={() => onNavigateToModule?.(assignLink.moduleId, assignLink.prefill)}
                          className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold text-purple-200 bg-purple-900/30 hover:bg-purple-800/50 hover:text-white border border-purple-700/40 transition-all"
                        >
                          <span>{assignLink.label}</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                      );
                    })()}

                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* VIEW 2: Detailed Matrix Table */}
      {viewMode === 'matrix' && (
        <div
          className="rounded-[18px] overflow-hidden border border-stone-800"
          style={{ background: 'var(--gradient-card)' }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-stone-900/90 text-stone-300 border-b border-stone-800">
                <tr>
                  <th className="p-3.5">Employee</th>
                  <th className="p-3.5">Department / Team</th>
                  <th className="p-3.5">Role</th>
                  <th className="p-3.5 text-center">Limit</th>
                  <th className="p-3.5 text-center">Used Capacity</th>
                  <th className="p-3.5 text-center">Open Capacity (Buffer)</th>
                  <th className="p-3.5 text-center">Utilization Rate</th>
                  <th className="p-3.5 text-center">Status</th>
                  <th className="p-3.5 text-center">RLS Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {filteredUserData.map((item) => {
                  const roleBadge = getRoleBadge(item.user.role);

                  let statusBadgeText = 'Available';
                  let statusBadgeBg = 'rgba(169, 245, 193, 0.15)';
                  let statusBadgeColor = 'var(--roas-good)';

                  if (item.status === 'over_capacity') {
                    statusBadgeText = 'Over Capacity';
                    statusBadgeBg = 'rgba(245, 163, 163, 0.15)';
                    statusBadgeColor = 'var(--roas-bad)';
                  } else if (item.status === 'near_capacity') {
                    statusBadgeText = 'Near Capacity';
                    statusBadgeBg = 'rgba(245, 226, 154, 0.15)';
                    statusBadgeColor = 'var(--roas-mid)';
                  }

                  return (
                    <tr key={item.user.id} className="hover:bg-stone-900/40 transition-colors">
                      <td className="p-3.5">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs"
                            style={{ background: 'var(--gradient-badge)', color: 'white' }}
                          >
                            {item.user.name.charAt(0)}
                          </div>
                          <div>
                            <p className="font-bold text-white">{item.user.name}</p>
                            <p className="text-[10px] text-stone-400">{item.user.email || 'Active'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3.5 text-stone-300 font-medium">
                        {item.user.team || 'Not set'}
                      </td>
                      <td className="p-3.5">
                        <span
                          className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ background: roleBadge.bg, color: roleBadge.text }}
                        >
                          {roleBadge.label}
                        </span>
                      </td>
                      <td className="p-3.5 text-center font-bold text-purple-300">
                        {item.capacityLimit}
                      </td>
                      <td className="p-3.5 text-center font-bold text-white">
                        {item.usedCapacity}
                      </td>
                      <td
                        className="p-3.5 text-center font-bold"
                        style={{ color: item.remainingCapacity > 0 ? 'var(--roas-good)' : 'var(--roas-bad)' }}
                      >
                        {item.remainingCapacity}
                      </td>
                      <td
                        className={`p-3.5 text-center font-bold ${item.isUntracked ? 'text-stone-400' : ''}`}
                        style={item.isUntracked ? undefined : { color: statusBadgeColor }}
                      >
                        {item.isUntracked ? 'N/A' : `${item.utilizationRate}%`}
                      </td>
                      <td className="p-3.5 text-center">
                        <span
                          className="px-2.5 py-1 rounded-full text-[10px] font-bold inline-block"
                          style={{ background: statusBadgeBg, color: statusBadgeColor }}
                        >
                          {statusBadgeText}
                        </span>
                      </td>
                      <td className="p-3.5 text-center">
                        {canModifyCapacity ? (
                          <button
                            onClick={() => handleStartEdit(item.user)}
                            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-stone-800 text-stone-200 hover:text-white hover:bg-purple-900/40 transition-colors"
                          >
                            Edit Capacity
                          </button>
                        ) : (
                          <span className="text-[10px] text-stone-500">Leads only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 3: Historical Capacity Logs */}
      {viewMode === 'logs' && (
        <div className="space-y-4">
          <div className="p-4 rounded-[18px] bg-stone-900/60 border border-stone-800 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <History className="w-4 h-4 text-purple-400" />
                <span>Capacity Logs & Daily Records (capacity_logs)</span>
              </h4>
              <p className="text-xs text-stone-400 mt-0.5">
                List of historical readings recorded in the Supabase database for each employee.
              </p>
            </div>
            {canModifyCapacity && (
              <div className="flex items-center gap-2">
                {canManageClientsFromCapacity(currentUser?.role) && (
                  <button
                    onClick={() => {
                      setImportType('clients');
                      setIsImportModalOpen(true);
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:-translate-y-0.5 active:translate-y-0 text-white"
                    style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                  >
                    <Building2 className="w-4 h-4" />
                    <span>إدارة العملاء</span>
                  </button>
                )}
                {canManageEmployeesFromCapacity(currentUser?.role) && (
                  <button
                    onClick={() => {
                      setImportType('users');
                      setIsImportModalOpen(true);
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:-translate-y-0.5 active:translate-y-0 text-white"
                    style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                  >
                    <Users className="w-4 h-4" />
                    <span>إدارة الموظفين</span>
                  </button>
                )}
                <button
                  onClick={() => setIsLogModalOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:-translate-y-0.5 active:translate-y-0"
                  style={{ background: 'var(--gradient-badge)', color: 'var(--white)', border: '1px solid var(--border-strong)' }}
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>Log Capacity</span>
                </button>
              </div>
            )}
          </div>

          <div
            className="rounded-[18px] overflow-hidden border border-stone-800"
            style={{ background: 'var(--gradient-card)' }}
          >
            <table className="w-full text-right text-xs">
              <thead className="bg-stone-900/90 text-stone-300 border-b border-stone-800">
                <tr>
                  <th className="p-3.5">Log ID</th>
                  <th className="p-3.5">Employee</th>
                  <th className="p-3.5">Recorded Date</th>
                  <th className="p-3.5 text-center">Active Clients/Workload</th>
                  <th className="p-3.5 text-center">Estimated Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {capacityLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-stone-400">
                      No capacity logs recorded yet.
                    </td>
                  </tr>
                ) : (
                  capacityLogs.map((log) => {
                    const agent = users.find((u) => u.id === log.agent_id);
                    const limit = agent ? resolveCapacityLimit(agent) : 8;
                    const isUntracked = limit === 0;
                    const rate = isUntracked ? 0 : Math.round((log.active_clients_count / limit) * 100);

                    return (
                      <tr key={log.id} className="hover:bg-stone-900/40 transition-colors">
                        <td className="p-3.5 font-mono text-purple-300">{log.id}</td>
                        <td className="p-3.5 font-bold text-white">
                          {agent?.name || log.agent_id}
                        </td>
                        <td className="p-3.5 text-stone-300">{log.date}</td>
                        <td className="p-3.5 text-center font-bold text-white">
                          {log.active_clients_count} of {limit}
                        </td>
                        <td className="p-3.5 text-center">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                              isUntracked
                                ? 'bg-stone-800/60 text-stone-400 border border-stone-700'
                                : rate >= 100
                                ? 'bg-red-950/60 text-red-400 border border-red-500/30'
                                : rate >= 75
                                ? 'bg-amber-950/60 text-amber-400 border border-amber-500/30'
                                : 'bg-emerald-950/60 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            {isUntracked ? 'N/A' : `${rate}% utilized`}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: Log New Capacity Entry */}
      {isLogModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-md rounded-[22px] p-6 space-y-4 shadow-2xl relative"
            style={{
              background: 'var(--gradient-hero)',
              border: '1px solid var(--border-medium)',
            }}
          >
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Gauge className="w-5 h-5 text-purple-400" />
                <span>Log New Capacity Reading</span>
              </h3>
              <button
                onClick={() => setIsLogModalOpen(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleLogCapacitySubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Employee / Responsible Party:
                </label>
                <select
                  value={logAgentId}
                  onChange={(e) => setLogAgentId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  required
                >
                  {logCapacityEmployees.map((u) => (
                    <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                      {u.name} ({u.team || u.role}) - Limit: {resolveCapacityLimit(u)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Log Date:
                  </label>
                  <input
                    type="date"
                    value={logDate}
                    onChange={(e) => setLogDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Active Workload / Clients:
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    value={logCount}
                    onChange={(e) => setLogCount(parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                    required
                  />
                </div>
              </div>

              {showLogCapacityOverCapacityWarning && selectedLogEmployeeData && (
                <div
                  className="p-3 rounded-xl text-xs flex items-start gap-2 bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)]"
                  style={{ color: 'var(--roas-bad)' }}
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {selectedLogEmployeeData.status === 'over_capacity'
                      ? `${selectedLogEmployeeData.user.name} is already over capacity.`
                      : `This reading (${logCount}) would put ${selectedLogEmployeeData.user.name} over their capacity limit (${selectedLogEmployeeData.capacityLimit}).`}{' '}
                    You can still log this reading — it will not be blocked.
                  </span>
                </div>
              )}

              <div className="pt-3 border-t border-stone-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsLogModalOpen(false)}
                  className="secondary-action px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoggingSubmitting}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-lg transition-all"
                  style={{ background: 'var(--gradient-badge)' }}
                >
                  {isLoggingSubmitting ? 'Saving...' : 'Save Log to Supabase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Modal for Users / Clients */}
      <ImportDataModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        type={importType}
        onImport={(data, method) => {
          // This will be handled by passing the function up to App.tsx eventually
          // For now, we simulate a success message since we are in a read-only prop mode here
          console.log(`Importing ${importType} via ${method}:`, data);
          setStatusMessage({ text: 'تم استيراد البيانات بنجاح (Simulation)', type: 'success' });
          setTimeout(() => setStatusMessage(null), 3000);
        }}
      />
    </div>
  );
};
