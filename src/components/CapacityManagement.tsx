import React, { useState, useMemo } from 'react';
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
} from 'lucide-react';
import {
  UserRecord,
  ClientRecord,
  TaskRecord,
  CapacityLogRecord,
  UserRole,
} from '../types/database';
import { getRoleInfo } from '../data/roles';
import { ImportDataModal } from './ImportDataModal';

interface CapacityManagementProps {
  users: UserRecord[];
  clients: ClientRecord[];
  tasks: TaskRecord[];
  capacityLogs: CapacityLogRecord[];
  currentUser?: UserRecord;
  onUpdateUserCapacity: (userId: string, newLimit: number) => Promise<void>;
  onLogCapacity?: (agentId: string, date: string, count: number) => Promise<void>;
}

export type CapacityStatus = 'all' | 'available' | 'near_capacity' | 'over_capacity';
export type ViewMode = 'cards' | 'matrix' | 'logs';

export const CapacityManagement: React.FC<CapacityManagementProps> = ({
  users,
  clients,
  tasks,
  capacityLogs,
  currentUser,
  onUpdateUserCapacity,
  onLogCapacity,
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
  const [logAgentId, setLogAgentId] = useState(users[0]?.id || '');
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
    'sales',
    'am_team_lead',
    'am_agent',
    'media_buying_team_lead',
    'media_buying_agent',
    'seo_team_lead',
    'seo_agent',
    'social_media_team_lead',
    'social_media_agent',
    'graphic_designer',
    'video_editor',
  ];

  const operationalUsers = useMemo(() => {
    // Under Supabase RLS, `users` is scoped by the backend data access layer.
    // For Team Leaders, the Detailed Team Matrix & Employee Cards reflect:
    // Team Leader -> Team Agents + Graphic Designers + Video Editors
    const role = currentUser?.role;
    if (role === 'am_team_lead') {
      return users.filter(
        (u) => u.role === 'am_agent' || u.role === 'graphic_designer' || u.role === 'video_editor'
      );
    }
    if (role === 'media_buying_team_lead') {
      return users.filter(
        (u) => u.role === 'media_buying_agent' || u.role === 'graphic_designer' || u.role === 'video_editor'
      );
    }
    if (role === 'seo_team_lead') {
      return users.filter(
        (u) => u.role === 'seo_agent' || u.role === 'graphic_designer' || u.role === 'video_editor'
      );
    }
    if (role === 'social_media_team_lead') {
      return users.filter(
        (u) => u.role === 'social_media_agent' || u.role === 'graphic_designer' || u.role === 'video_editor'
      );
    }
    return users.filter(
      (u) => operationalRoles.includes(u.role) || (u.capacity_limit && u.capacity_limit > 0)
    );
  }, [users, currentUser]);

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
      { id: 'all', label: 'جميع الأقسام والفرق المتاحة' },
    ];
    if (availableTeams.has('Executive')) list.push({ id: 'Executive', label: 'الإدارة التنفيذية العليا' });
    if (availableTeams.has('Technical')) list.push({ id: 'Technical', label: 'القسم الفني والعمليات' });
    if (availableTeams.has('Sales')) list.push({ id: 'Sales', label: 'فريق المبيعات' });
    if (availableTeams.has('Account Management')) list.push({ id: 'Account Management', label: 'إدارة الحسابات (AM)' });
    if (availableTeams.has('Media Buying')) list.push({ id: 'Media Buying', label: 'الميديا باينج (Media Buying)' });
    if (availableTeams.has('SEO')) list.push({ id: 'SEO', label: 'تحسين محركات البحث (SEO)' });
    if (availableTeams.has('Social Media')) list.push({ id: 'Social Media', label: 'السوشيال ميديا (Social)' });
    if (availableTeams.has('Creative & Design')) list.push({ id: 'Creative & Design', label: 'التصميم (مورد مشترك)' });
    if (availableTeams.has('Video Production')) list.push({ id: 'Video Production', label: 'المونتاج وإنتاج الفيديو (مورد مشترك)' });
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
      { id: 'sales', label: 'Sales Team (Sales)' },
      { id: 'am_team_lead', label: 'AM Team Leader' },
      { id: 'am_agent', label: 'AM Agent' },
      { id: 'media_buying_team_lead', label: 'Media Buying Team Leader' },
      { id: 'media_buying_agent', label: 'Media Buying Agent' },
      { id: 'seo_team_lead', label: 'SEO Team Leader' },
      { id: 'seo_agent', label: 'SEO Agent' },
      { id: 'social_media_team_lead', label: 'Social Media Team Leader' },
      { id: 'social_media_agent', label: 'Social Media Agent' },
      { id: 'graphic_designer', label: 'Graphic Designer (مورد مشترك)' },
      { id: 'video_editor', label: 'Video Editor (مورد مشترك)' },
    ];
    return [
      { id: 'all', label: `جميع الأدوار المتاحة (${operationalUsers.length} موظف)` },
      ...allDefs.filter((d) => availableRoles.has(d.id)),
    ];
  }, [operationalUsers, availableRoles]);

  // Helper to calculate workload and status for each user
  const getUserCapacityData = (user: UserRecord) => {
    // 1. Assigned active clients (mainly for AM agents)
    const assignedClients = clients.filter(
      (c) => c.am_agent_id === user.id && c.status !== 'churned'
    );

    // 2. Active tasks assigned
    const activeTasks = tasks.filter(
      (t) => t.assigned_to === user.id && t.status !== 'completed'
    );

    // 3. Workload calculation
    const isAm = user.role === 'am_agent' || user.role === 'am_team_lead';
    const usedCapacity = isAm ? assignedClients.length : activeTasks.length;
    const capacityLimit = user.capacity_limit || 8;
    const remainingCapacity = Math.max(0, capacityLimit - usedCapacity);
    const utilizationRate = capacityLimit > 0 ? Math.round((usedCapacity / capacityLimit) * 100) : 0;

    // Status classification according to required criteria:
    // Available: < 75%
    // Near Capacity: 75% - 99%
    // Over Capacity: >= 100%
    let status: 'available' | 'near_capacity' | 'over_capacity' = 'available';
    if (utilizationRate >= 100) {
      status = 'over_capacity';
    } else if (utilizationRate >= 75) {
      status = 'near_capacity';
    }

    // Historical capacity log for this user if date selected
    const userLogs = capacityLogs.filter((log) => log.agent_id === user.id);
    const dateSpecificLog = selectedDate
      ? userLogs.find((l) => l.date === selectedDate)
      : undefined;

    return {
      user,
      assignedClients,
      activeTasks,
      usedCapacity,
      capacityLimit,
      remainingCapacity,
      utilizationRate,
      status,
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

  // Handlers
  const handleStartEdit = (user: UserRecord) => {
    if (!canModifyCapacity) {
      setStatusMessage({
        text: 'صلاحيات RLS: تعديل القدرة الاستيعابية مقتصر على الإدارة التنفيذية ورؤساء الفرق.',
        type: 'error',
      });
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }
    setEditingUserId(user.id);
    setTempLimit(user.capacity_limit || 8);
  };

  const handleSaveLimit = async (userId: string) => {
    if (tempLimit < 1) return;
    setIsSaving(true);
    try {
      await onUpdateUserCapacity(userId, tempLimit);
      setEditingUserId(null);
      setStatusMessage({ text: 'تم تحديث الحد الأقصى للسعة بنجاح في قاعدة البيانات.', type: 'success' });
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err: any) {
      console.error(err);
      setStatusMessage({ text: 'حدث خطأ أثناء حفظ السعة.', type: 'error' });
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
      setStatusMessage({ text: 'تم تسجيل ومتابعة قراءة السعة بنجاح.', type: 'success' });
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err) {
      console.error(err);
      setStatusMessage({ text: 'فشل تسجيل قراءة السعة.', type: 'error' });
    } finally {
      setIsLoggingSubmitting(false);
    }
  };

  const getRoleBadge = (role: UserRole) => {
    const info = getRoleInfo(role);
    return {
      label: info.arabicTitle,
      bg: info.badgeBg,
      text: info.badgeText,
    };
  };


  return (
    <div className="space-y-6">
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
              معدل الإشغال الإجمالي
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
              {totalUsedSum} مستخدم من أصل {totalCapacitySum} كحد أقصى
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
              متاح (Available)
            </p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--roas-good)' }}>
              {availableCount} <span className="text-xs font-normal text-stone-400">موظفين</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--roas-good)' }}>
              إشغال أقل من 75%
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
              يقترب من السعة (Near)
            </p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--roas-mid)' }}>
              {nearCapacityCount} <span className="text-xs font-normal text-stone-400">موظفين</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--roas-mid)' }}>
              إشغال بين 75% و 99%
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
              تجاوز السعة (Over)
            </p>
            <p
              className="text-2xl font-bold mt-1"
              style={{ color: overCapacityCount > 0 ? 'var(--roas-bad)' : 'var(--white)' }}
            >
              {overCapacityCount} <span className="text-xs font-normal text-stone-400">موظفين</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--roas-bad)' }}>
              إشغال 100% وأكثر (ضغط)
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
              السعة الاحتياطية (Buffer)
            </p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--purple-light)' }}>
              {totalBuffer} <span className="text-xs font-normal text-stone-400">وحدة شاغرة</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--lilac)' }}>
              جاهزة لاستيعاب أعمال فوراً
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
              <span>بطاقات الموظفين</span>
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
              <span>مصفوفة الفرق التفصيلية</span>
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
              <span>سجلات السعة (Logs)</span>
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
                <span>تسجيل متابعة سعة (Capacity Log)</span>
              </button>
            ) : (
              <div
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] text-stone-400 border border-stone-800 bg-stone-900/40"
                title="سياسات RLS تقيد تعديل السعة للمديرين فقط"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-stone-500" />
                <span>وضع المشاهدة (صلاحية مستخدم)</span>
              </div>
            )}
          </div>
        </div>

        {/* Filter Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 pt-2 border-t border-stone-800/60">
          {/* Department Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              القسم / الفريق:
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
              الدور الوظيفي:
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
              حالة السعة (Status):
            </label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value as CapacityStatus)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="all" className="bg-stone-900 text-white">جميع الحالات</option>
              <option value="available" className="bg-stone-900 text-white">متاح (Available - أقل من 75%)</option>
              <option value="near_capacity" className="bg-stone-900 text-white">يقترب من السعة (75% - 99%)</option>
              <option value="over_capacity" className="bg-stone-900 text-white">تجاوز السعة (Over - 100%+)</option>
            </select>
          </div>

          {/* Date Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              تاريخ السجل (Date):
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
                  title="مسح التاريخ"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Search Employee Name / Team */}
          <div>
            <label className="text-[11px] font-semibold block mb-1" style={{ color: 'var(--grey)' }}>
              بحث سريع:
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-stone-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث باسم الموظف أو الفريق..."
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
              عرض {filteredUserData.length} موظفاً وفق معايير التصفية المختارة
            </span>
            <span className="text-[11px] text-stone-500">
              * يتم احتساب السعة بناءً على العملاء النشطين (لإدارة الحسابات) والمهام النشطة (للفرق الفنية).
            </span>
          </div>

          {filteredUserData.length === 0 ? (
            <div
              className="p-8 text-center rounded-[20px]"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' }}
            >
              <Users className="w-10 h-10 mx-auto text-stone-600 mb-2" />
              <p className="text-sm font-semibold text-white">لم يتم العثور على موظفين</p>
              <p className="text-xs text-stone-400 mt-1">
                جرب تعديل خيارات الفلترة أو مسح حقول البحث.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredUserData.map((item) => {
                const roleBadge = getRoleBadge(item.user.role);
                const isEditing = editingUserId === item.user.id;

                let statusBadgeText = 'متاح (Available)';
                let statusBadgeBg = 'rgba(169, 245, 193, 0.15)';
                let statusBadgeColor = 'var(--roas-good)';
                let statusBadgeBorder = 'rgba(169, 245, 193, 0.3)';

                if (item.status === 'over_capacity') {
                  statusBadgeText = 'تجاوز السعة (Over Capacity)';
                  statusBadgeBg = 'rgba(245, 163, 163, 0.15)';
                  statusBadgeColor = 'var(--roas-bad)';
                  statusBadgeBorder = 'rgba(245, 163, 163, 0.3)';
                } else if (item.status === 'near_capacity') {
                  statusBadgeText = 'يقترب من السعة (Near)';
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
                              color: 'var(--white)',
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
                          <p className="text-[10px] text-stone-400">المستخدمة</p>
                          <p className="text-sm font-bold text-white mt-0.5">
                            {item.usedCapacity}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-stone-400">المتبقية (Buffer)</p>
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
                          <p className="text-[10px] text-stone-400">الحد الأقصى</p>
                          <div className="flex items-center justify-center gap-1 mt-0.5">
                            <span className="text-sm font-bold text-purple-300">
                              {item.capacityLimit}
                            </span>
                            {canModifyCapacity && !isEditing && (
                              <button
                                onClick={() => handleStartEdit(item.user)}
                                className="text-stone-500 hover:text-purple-300 p-0.5 transition-colors"
                                title="تعديل الحد الأقصى للسعة (RLS Authorized)"
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
                            <span className="font-semibold">تعديل الحد الأقصى للسعة:</span>
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
                              min="1"
                              max="30"
                              value={tempLimit}
                              onChange={(e) => setTempLimit(parseInt(e.target.value) || 1)}
                              className="w-20 px-2 py-1 rounded-lg text-xs bg-stone-900 border border-purple-400/50 text-white font-bold text-center focus:outline-none"
                            />
                            <button
                              onClick={() => handleSaveLimit(item.user.id)}
                              disabled={isSaving}
                              className="flex-1 py-1 px-3 rounded-lg text-xs font-bold text-white flex items-center justify-center gap-1.5 transition-all"
                              style={{ background: 'var(--gradient-badge)' }}
                            >
                              <Save className="w-3 h-3" />
                              <span>{isSaving ? 'جارٍ الحفظ...' : 'تأكيد السعة'}</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Visual Progress Bar */}
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <span className="text-stone-400 text-[11px]">معدل الإشغال الحالي:</span>
                          <span
                            className="font-bold text-xs"
                            style={{ color: statusBadgeColor }}
                          >
                            {item.utilizationRate}%
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-stone-800 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(100, item.utilizationRate)}%`,
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
                                <span>العملاء المسندون ({item.assignedClients.length}):</span>
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
                                لا يوجد عملاء مسندون حالياً (متاح تماماً)
                              </p>
                            )}
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
                              <span className="flex items-center gap-1">
                                <CheckSquare className="w-3 h-3 text-purple-400" />
                                <span>المهام النشطة الموكلة ({item.activeTasks.length}):</span>
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
                                    + {item.activeTasks.length - 2} مهام أخرى قيد التنفيذ
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-[10px] text-stone-500 italic">
                                لا توجد مهام نشطة حالياً (متاح للعمل)
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
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
                  <th className="p-3.5">الموظف</th>
                  <th className="p-3.5">القسم / الفريق</th>
                  <th className="p-3.5">الدور الوظيفي</th>
                  <th className="p-3.5 text-center">الحد الأقصى (Limit)</th>
                  <th className="p-3.5 text-center">السعة المستخدمة</th>
                  <th className="p-3.5 text-center">السعة الشاغرة (Buffer)</th>
                  <th className="p-3.5 text-center">معدل الإشغال</th>
                  <th className="p-3.5 text-center">الحالة (Status)</th>
                  <th className="p-3.5 text-center">إجراءات RLS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {filteredUserData.map((item) => {
                  const roleBadge = getRoleBadge(item.user.role);

                  let statusBadgeText = 'متاح (Available)';
                  let statusBadgeBg = 'rgba(169, 245, 193, 0.15)';
                  let statusBadgeColor = 'var(--roas-good)';

                  if (item.status === 'over_capacity') {
                    statusBadgeText = 'تجاوز السعة (Over)';
                    statusBadgeBg = 'rgba(245, 163, 163, 0.15)';
                    statusBadgeColor = 'var(--roas-bad)';
                  } else if (item.status === 'near_capacity') {
                    statusBadgeText = 'يقترب من السعة (Near)';
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
                            <p className="text-[10px] text-stone-400">{item.user.email || 'نشط'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3.5 text-stone-300 font-medium">
                        {item.user.team || 'غير محدد'}
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
                      <td className="p-3.5 text-center font-bold" style={{ color: statusBadgeColor }}>
                        {item.utilizationRate}%
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
                            تعديل السعة
                          </button>
                        ) : (
                          <span className="text-[10px] text-stone-500">للقادة فقط</span>
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
                <span>سجلات السعة والتوثيق اليومي (capacity_logs)</span>
              </h4>
              <p className="text-xs text-stone-400 mt-0.5">
                قائمة القراءات التاريخية المسجلة في قاعدة بيانات Supabase لكل موظف.
              </p>
            </div>
            {canModifyCapacity && (
              <div className="flex items-center gap-2">
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
                  <th className="p-3.5">معرف السجل</th>
                  <th className="p-3.5">الموظف</th>
                  <th className="p-3.5">التاريخ المسجل</th>
                  <th className="p-3.5 text-center">العملاء/الأعباء النشطة</th>
                  <th className="p-3.5 text-center">الحالة المقدرة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {capacityLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-stone-400">
                      لا توجد سجلات سعة مدخلة حالياً.
                    </td>
                  </tr>
                ) : (
                  capacityLogs.map((log) => {
                    const agent = users.find((u) => u.id === log.agent_id);
                    const limit = agent?.capacity_limit || 8;
                    const rate = Math.round((log.active_clients_count / limit) * 100);

                    return (
                      <tr key={log.id} className="hover:bg-stone-900/40 transition-colors">
                        <td className="p-3.5 font-mono text-purple-300">{log.id}</td>
                        <td className="p-3.5 font-bold text-white">
                          {agent?.name || log.agent_id}
                        </td>
                        <td className="p-3.5 text-stone-300">{log.date}</td>
                        <td className="p-3.5 text-center font-bold text-white">
                          {log.active_clients_count} من {limit}
                        </td>
                        <td className="p-3.5 text-center">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                              rate >= 100
                                ? 'bg-red-950/60 text-red-400 border border-red-500/30'
                                : rate >= 75
                                ? 'bg-amber-950/60 text-amber-400 border border-amber-500/30'
                                : 'bg-emerald-950/60 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            {rate}% إشغال
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
                <span>تسجيل قراءة سعة جديدة (Capacity Log)</span>
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
                  الموظف / المسؤول:
                </label>
                <select
                  value={logAgentId}
                  onChange={(e) => setLogAgentId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  required
                >
                  {operationalUsers.map((u) => (
                    <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                      {u.name} ({u.team || u.role}) - الحد الأقصى: {u.capacity_limit || 8}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    تاريخ التسجيل:
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
                    الأعباء / العملاء النشطين:
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

              <div className="pt-3 border-t border-stone-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsLogModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isLoggingSubmitting}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-lg transition-all"
                  style={{ background: 'var(--gradient-badge)' }}
                >
                  {isLoggingSubmitting ? 'جارٍ الحفظ...' : 'حفظ السجل في Supabase'}
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
