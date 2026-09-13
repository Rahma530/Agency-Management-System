import React, { useState, useMemo, useEffect } from 'react';
import {
  Calendar,
  Clock,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  PlayCircle,
  CheckSquare,
  Building2,
  Layers,
  User,
  Users,
  Timer,
  ChevronRight,
  ChevronLeft,
  X,
  FileText,
  Filter,
  Search,
  PlusCircle,
  ExternalLink,
  ShieldAlert,
  ArrowRight,
  TrendingUp,
  Tag,
  Briefcase,
  Send,
  HelpCircle,
  MessageSquare,
  ArrowUpRight,
  Check,
  Star,
} from 'lucide-react';
import {
  TaskRecord,
  UserRecord,
  ClientRecord,
  BriefRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  TaskStatus,
  TaskPriority,
  UserRole,
} from '../types/database';
import { getTodayStr, isTaskOverdue, isTaskDueToday, sortTasksByPriorityThenDueDate } from '../lib/employeeWork';
import { isActiveEmployee } from '../lib/permissions';

interface DailyOperationsModuleProps {
  tasks: TaskRecord[];
  users: UserRecord[];
  clients: ClientRecord[];
  briefs: BriefRecord[];
  dailyLogs: DailyLogRecord[];
  extraNotes?: ExtraNoteRecord[];
  currentUser: UserRecord;
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onUpdateTask: (taskId: string, updates: Partial<TaskRecord>) => Promise<void>;
  onCreateDailyLog: (logData: {
    user_id: string;
    date: string;
    summary_text: string;
    linked_task_ids: string[];
    client_id?: string | null;
  }) => Promise<void>;
  onCreateExtraNote?: (noteData: {
    user_id: string;
    date: string;
    note_text: string;
    category: string;
  }) => Promise<void>;
}

export type OperationSubTab = 'daily_view' | 'my_tasks' | 'blockers' | 'daily_activity' | 'manager_view';

export const DailyOperationsModule: React.FC<DailyOperationsModuleProps> = ({
  tasks,
  users,
  clients,
  briefs,
  dailyLogs,
  extraNotes = [],
  currentUser,
  onUpdateTaskStatus,
  onUpdateTask,
  onCreateDailyLog,
  onCreateExtraNote,
}) => {
  // Navigation between sub views
  const [activeSubTab, setActiveSubTab] = useState<OperationSubTab>('daily_view');

  // Selected Employee filter (defaults to currentUser, can be changed by managers/team leads)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>(currentUser.id);

  // Filters for My Tasks
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Modals state
  const [selectedTaskDetails, setSelectedTaskDetails] = useState<TaskRecord | null>(null);
  const [blockerModalTask, setBlockerModalTask] = useState<TaskRecord | null>(null);
  const [blockerReason, setBlockerReason] = useState('');
  const [isLoggingDailyActivity, setIsLoggingDailyActivity] = useState(false);

  // Daily Log Form State
  const [dailySummary, setDailySummary] = useState('');
  const [selectedLinkedTasks, setSelectedLinkedTasks] = useState<string[]>([]);
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0]);
  const [logClientId, setLogClientId] = useState('');
  const [logClientFilter, setLogClientFilter] = useState('all');
  const [isSubmittingLog, setIsSubmittingLog] = useState(false);

  // Extra Effort Log Form State — the genuine "document initiative beyond
  // normal task scope" entry point. Distinct category from the incidental
  // 'blocker' notes the blocker-resolution flow auto-logs below, so the
  // Employee Performance score's initiative indicator only counts
  // voluntarily-documented effort, not routine blocker bookkeeping.
  const [isLoggingExtraEffort, setIsLoggingExtraEffort] = useState(false);
  const [extraEffortText, setExtraEffortText] = useState('');
  const [extraEffortDate, setExtraEffortDate] = useState(new Date().toISOString().split('T')[0]);
  const [isSubmittingExtraEffort, setIsSubmittingExtraEffort] = useState(false);

  // Quick Time Logging Modal / Popover State
  const [timeLoggingTaskId, setTimeLoggingTaskId] = useState<string | null>(null);
  const [additionalHours, setAdditionalHours] = useState<number>(1);

  // Notification toast
  const [notification, setNotification] = useState<{ text: string; type: 'success' | 'info' | 'error' } | null>(null);

  const showNotification = (text: string, type: 'success' | 'info' | 'error' = 'success') => {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 3800);
  };

  // Determine permissions: Is current user a Team Lead or Manager?
  const isManagerOrLead = useMemo(() => {
    const managerRoles: UserRole[] = [
      'executive',
      'head_of_technical',
      'am_team_lead',
      'media_buying_team_lead',
      'seo_team_lead',
      'social_media_team_lead',
    ];
    return managerRoles.includes(currentUser.role);
  }, [currentUser.role]);

  // If currentUser changes, ensure selectedEmployeeId stays aligned if not in manager mode
  const effectiveEmployee = useMemo(() => {
    return users.find((u) => u.id === selectedEmployeeId) || currentUser;
  }, [users, selectedEmployeeId, currentUser]);

  // Today's date string (YYYY-MM-DD)
  const todayStr = useMemo(() => getTodayStr(), []);

  // Helper date functions — shared with MyWorkHub.tsx via lib/employeeWork.ts
  const isOverdue = (task: TaskRecord) => isTaskOverdue(task, todayStr);
  const isDueToday = (task: TaskRecord) => isTaskDueToday(task, todayStr);

  // 1. All tasks assigned to the effective employee
  const employeeTasks = useMemo(() => {
    return tasks.filter((t) => t.assigned_to === effectiveEmployee.id);
  }, [tasks, effectiveEmployee.id]);

  // Sorted employee tasks: Priority (Urgent first), then Due Date (closest first)
  const sortedEmployeeTasks = useMemo(() => sortTasksByPriorityThenDueDate(employeeTasks), [employeeTasks]);

  // Tasks completed on whichever date the Daily Log modal currently has
  // selected (not hardcoded to literal-today, so retroactively logging a
  // past day still gets the right suggestion). Drives both the "Link tasks"
  // checklist highlight/pre-check and the auto-suggested summary draft.
  const tasksCompletedOnLogDate = useMemo(() => {
    return employeeTasks.filter(
      (t) => t.status === 'completed' && t.completed_at?.split('T')[0] === logDate
    );
  }, [employeeTasks, logDate]);

  // Checklist display order for the Daily Log modal: today's (well,
  // logDate's) completions surfaced first, everything else keeps its usual
  // priority/due-date order below. Does not affect sortedEmployeeTasks
  // itself, which several other views (My Tasks, KPI counts) rely on.
  const dailyLogChecklistTasks = useMemo(() => {
    const completedIds = new Set(tasksCompletedOnLogDate.map((t) => t.id));
    return [...sortedEmployeeTasks].sort((a, b) => {
      const aCompleted = completedIds.has(a.id) ? 1 : 0;
      const bCompleted = completedIds.has(b.id) ? 1 : 0;
      return bCompleted - aCompleted;
    });
  }, [sortedEmployeeTasks, tasksCompletedOnLogDate]);

  // Auto-suggestion: pre-check logDate's completions and draft a starting
  // summary sentence — but only while the form is still untouched, so a
  // preserved draft (Cancel/X don't reset this modal's state) is never
  // clobbered.
  useEffect(() => {
    if (!isLoggingDailyActivity) return;
    if (dailySummary.trim() || selectedLinkedTasks.length > 0) return;
    if (tasksCompletedOnLogDate.length === 0) return;

    setSelectedLinkedTasks(tasksCompletedOnLogDate.map((t) => t.id));
    setDailySummary(`Completed: ${tasksCompletedOnLogDate.map((t) => t.title).join(', ')}.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggingDailyActivity, logDate, tasksCompletedOnLogDate]);

  // Filtered employee tasks based on search & filters
  const filteredEmployeeTasks = useMemo(() => {
    return sortedEmployeeTasks.filter((task) => {
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const client = clients.find((c) => c.id === task.client_id);
        const matchTitle = task.title.toLowerCase().includes(q);
        const matchDesc = task.description?.toLowerCase().includes(q) || false;
        const matchClient = client?.name.toLowerCase().includes(q) || false;
        if (!matchTitle && !matchDesc && !matchClient) return false;
      }
      return true;
    });
  }, [sortedEmployeeTasks, statusFilter, priorityFilter, searchQuery, clients]);

  // 2. DAILY WORK VIEW CALCULATIONS (Today's Agenda, Overdue, Priority Focus)
  const overdueTasks = useMemo(() => {
    return sortedEmployeeTasks.filter(isOverdue);
  }, [sortedEmployeeTasks, todayStr]);

  const dueTodayTasks = useMemo(() => {
    return sortedEmployeeTasks.filter(isDueToday);
  }, [sortedEmployeeTasks, todayStr]);

  const priorityFirstTasks = useMemo(() => {
    return sortedEmployeeTasks.filter(
      (t) => (t.priority === 'urgent' || t.priority === 'high') && t.status !== 'completed'
    );
  }, [sortedEmployeeTasks]);

  const inProgressTasks = useMemo(() => {
    return sortedEmployeeTasks.filter((t) => t.status === 'in_progress');
  }, [sortedEmployeeTasks]);

  const blockedEmployeeTasks = useMemo(() => {
    return sortedEmployeeTasks.filter((t) => t.status === 'blocked');
  }, [sortedEmployeeTasks]);

  // Total daily estimated hours & active workload
  const totalActiveEstimatedHours = useMemo(() => {
    const activeTasks = sortedEmployeeTasks.filter((t) => t.status !== 'completed');
    return activeTasks.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
  }, [sortedEmployeeTasks]);

  const totalActualHoursLogged = useMemo(() => {
    return sortedEmployeeTasks.reduce((sum, t) => sum + (t.actual_hours || 0), 0);
  }, [sortedEmployeeTasks]);

  const todayWorkloadHours = useMemo(() => {
    // Tasks due today or currently in progress
    const relevantTasks = sortedEmployeeTasks.filter(
      (t) => t.status === 'in_progress' || isDueToday(t) || isOverdue(t)
    );
    return relevantTasks.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
  }, [sortedEmployeeTasks, todayStr]);

  // Team leads don't carry a tracked capacity buffer the way agents do — a
  // capacity_limit of 0 is a normal, intentional value for these 4 roles
  // (not missing data), so workload math treats them differently from agents.
  const TEAM_LEAD_ROLES: UserRole[] = ['am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'];
  const isTeamLeadRole = (role?: UserRole) => !!role && TEAM_LEAD_ROLES.includes(role);
  const resolveCapacityLimit = (u: UserRecord) =>
    isTeamLeadRole(u.role) ? (u.capacity_limit ?? 0) : (u.capacity_limit || 8);

  // 3. TEAM / MANAGER VIEW CALCULATIONS
  // Team members accessible under current user's RLS scope
  const teamMembers = useMemo(() => {
    let result: UserRecord[];
    if (currentUser.role === 'executive' || currentUser.role === 'head_of_technical') {
      result = users.filter((u) => u.role !== 'client');
    } else if (currentUser.role === 'am_team_lead') {
      result = users.filter(
        (u) =>
          u.team === 'Account Management' ||
          u.manager_id === currentUser.id ||
          u.role === 'graphic_designer' ||
          u.role === 'video_editor' ||
          u.id === currentUser.id
      );
    } else if (
      currentUser.role === 'seo_team_lead' ||
      currentUser.role === 'media_buying_team_lead' ||
      currentUser.role === 'social_media_team_lead'
    ) {
      result = users.filter(
        (u) =>
          (currentUser.team && u.team === currentUser.team) ||
          u.manager_id === currentUser.id ||
          u.role === 'graphic_designer' ||
          u.role === 'video_editor' ||
          u.id === currentUser.id
      );
    } else if (currentUser.role === 'graphic_designer' || currentUser.role === 'video_editor') {
      // Shared creative peers for Graphic Designer & Video Editor
      result = users.filter((u) => u.role === 'graphic_designer' || u.role === 'video_editor' || u.id === currentUser.id);
    } else {
      result = [currentUser];
    }
    // Executive and Head of Technical never receive task assignments, so they
    // never belong in this workload/team-member list — even when the viewer
    // is one of them. Pending and deactivated employees are excluded too —
    // neither can ever be the logged-in currentUser, so this never filters out
    // "yourself".
    return result.filter((u) => u.role !== 'executive' && u.role !== 'head_of_technical' && isActiveEmployee(u));
  }, [users, currentUser]);

  // All blockers across visible tasks for Blockers Hub
  const allVisibleBlockers = useMemo(() => {
    const visibleMemberIds = new Set(teamMembers.map((m) => m.id));
    return tasks.filter((t) => t.status === 'blocked' && (t.assigned_to ? visibleMemberIds.has(t.assigned_to) : true));
  }, [tasks, teamMembers]);

  // Employee workload metrics for manager
  const teamWorkloadSummary = useMemo(() => {
    return teamMembers.map((member) => {
      const memberTasks = tasks.filter((t) => t.assigned_to === member.id);
      const active = memberTasks.filter((t) => t.status !== 'completed');
      const completed = memberTasks.filter((t) => t.status === 'completed');
      const overdue = memberTasks.filter(isOverdue);
      const blocked = memberTasks.filter((t) => t.status === 'blocked');
      const totalEstimated = active.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
      const totalActual = memberTasks.reduce((sum, t) => sum + (t.actual_hours || 0), 0);
      const limit = resolveCapacityLimit(member);
      // Team leads may genuinely have a limit of 0 (no tracked buffer) — not
      // an error, just nothing to compute a rate against.
      const isUntracked = limit === 0;
      const rate = isUntracked ? 0 : Math.round((active.length / limit) * 100);

      return {
        member,
        memberTasks,
        activeCount: active.length,
        completedCount: completed.length,
        overdueCount: overdue.length,
        blockedCount: blocked.length,
        totalEstimated,
        totalActual,
        limit,
        isUntracked,
        rate,
      };
    });
  }, [teamMembers, tasks, todayStr]);

  // Daily Logs filtered for current employee or team
  const relevantDailyLogs = useMemo(() => {
    return dailyLogs.filter((log) => {
      if (selectedEmployeeId !== 'all' && log.user_id !== effectiveEmployee.id) return false;
      if (logClientFilter !== 'all' && log.client_id !== logClientFilter) return false;
      return true;
    });
  }, [dailyLogs, effectiveEmployee.id, selectedEmployeeId, logClientFilter]);

  // Handlers for task status
  const handleAdvanceStatus = async (taskId: string, currentStatus: TaskStatus) => {
    const statusOrder: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'completed'];
    const currentIndex = statusOrder.indexOf(currentStatus);
    if (currentIndex >= 0 && currentIndex < statusOrder.length - 1) {
      const nextStatus = statusOrder[currentIndex + 1];
      try {
        await onUpdateTaskStatus(taskId, nextStatus);
        showNotification(`Task status updated to "${getStatusLabel(nextStatus)}".`);
      } catch (err) {
        showNotification('An error occurred while updating the task status.', 'error');
      }
    }
  };

  const handleQuickStatusChange = async (taskId: string, targetStatus: TaskStatus) => {
    try {
      await onUpdateTaskStatus(taskId, targetStatus);
      showNotification(`Task status changed to "${getStatusLabel(targetStatus)}".`);
    } catch (err) {
      showNotification('Unable to update task status.', 'error');
    }
  };

  // Handler to mark task as Blocked with reason
  const handleConfirmBlocker = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!blockerModalTask) return;

    try {
      const newDesc = blockerReason.trim()
        ? `[Blocker: ${blockerReason.trim()}] ${blockerModalTask.description || ''}`
        : blockerModalTask.description;

      await onUpdateTask(blockerModalTask.id, {
        status: 'blocked',
        description: newDesc,
      });

      // Optionally record in extra_notes table if available
      if (onCreateExtraNote && blockerReason.trim()) {
        await onCreateExtraNote({
          user_id: currentUser.id,
          date: todayStr,
          note_text: `Task blocked: "${blockerModalTask.title}" — ${blockerReason.trim()}`,
          category: 'blocker',
        });
      }

      setBlockerModalTask(null);
      setBlockerReason('');
      showNotification('Blocker documented and task marked as Blocked.', 'info');
    } catch (err) {
      showNotification('Failed to document the blocker.', 'error');
    }
  };

  // Handler to unblock / resolve blocker
  const handleResolveBlocker = async (task: TaskRecord) => {
    try {
      await onUpdateTask(task.id, {
        status: 'in_progress',
      });
      showNotification(`Blocker resolved — work resumed on "${task.title}".`, 'success');
    } catch (err) {
      showNotification('Unable to resolve the blocker.', 'error');
    }
  };

  // Quick time logging handler
  const handleLogActualHours = async (task: TaskRecord) => {
    if (additionalHours <= 0) return;
    try {
      const updatedHours = (task.actual_hours || 0) + Number(additionalHours);
      await onUpdateTask(task.id, {
        actual_hours: updatedHours,
      });
      setTimeLoggingTaskId(null);
      setAdditionalHours(1);
      showNotification(`Logged ${additionalHours} additional hour(s) for the task.`);
    } catch (err) {
      showNotification('An error occurred while logging hours.', 'error');
    }
  };

  // Daily Activity Submission Handler
  const handleSubmitDailyLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dailySummary.trim()) return;

    setIsSubmittingLog(true);
    try {
      await onCreateDailyLog({
        user_id: effectiveEmployee.id,
        date: logDate,
        summary_text: dailySummary.trim(),
        linked_task_ids: selectedLinkedTasks,
        client_id: logClientId || null,
      });

      setDailySummary('');
      setSelectedLinkedTasks([]);
      setLogClientId('');
      setIsLoggingDailyActivity(false);
      showNotification('Daily activity log saved successfully.');
    } catch (err) {
      showNotification('Unable to save the daily activity.', 'error');
    } finally {
      setIsSubmittingLog(false);
    }
  };

  const handleSubmitExtraEffort = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!extraEffortText.trim() || !onCreateExtraNote) return;

    setIsSubmittingExtraEffort(true);
    try {
      await onCreateExtraNote({
        user_id: effectiveEmployee.id,
        date: extraEffortDate,
        note_text: extraEffortText.trim(),
        category: 'initiative',
      });

      setExtraEffortText('');
      setIsLoggingExtraEffort(false);
      showNotification('Extra effort documented successfully.');
    } catch (err) {
      showNotification('Unable to save the extra effort note.', 'error');
    } finally {
      setIsSubmittingExtraEffort(false);
    }
  };

  // Helper Labels & Colors
  const getStatusLabel = (status: TaskStatus) => {
    switch (status) {
      case 'todo': return 'To Do';
      case 'in_progress': return 'In Progress';
      case 'in_review': return 'In Review';
      case 'completed': return 'Completed';
      case 'blocked': return 'Blocked';
      default: return status;
    }
  };

  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case 'completed':
        return { bg: 'rgba(169, 245, 193, 0.15)', text: 'var(--roas-good)', border: 'rgba(169, 245, 193, 0.3)' };
      case 'in_progress':
        return { bg: 'rgba(123, 47, 247, 0.25)', text: 'var(--purple-light)', border: 'rgba(123, 47, 247, 0.4)' };
      case 'in_review':
        return { bg: 'rgba(245, 226, 154, 0.2)', text: 'var(--roas-mid)', border: 'rgba(245, 226, 154, 0.35)' };
      case 'blocked':
        return { bg: 'rgba(245, 163, 163, 0.25)', text: 'var(--roas-bad)', border: 'rgba(245, 163, 163, 0.4)' };
      case 'todo':
      default:
        return { bg: 'rgba(168, 155, 184, 0.15)', text: 'var(--grey)', border: 'rgba(168, 155, 184, 0.3)' };
    }
  };

  const getPriorityBadge = (priority: TaskPriority) => {
    switch (priority) {
      case 'urgent':
        return { label: 'Urgent', bg: 'rgba(245, 163, 163, 0.2)', text: 'var(--roas-bad)', border: 'rgba(245, 163, 163, 0.4)' };
      case 'high':
        return { label: 'High', bg: 'rgba(235, 94, 40, 0.2)', text: '#fb923c', border: 'rgba(235, 94, 40, 0.3)' };
      case 'medium':
        return { label: 'Medium', bg: 'rgba(245, 226, 154, 0.15)', text: 'var(--roas-mid)', border: 'rgba(245, 226, 154, 0.3)' };
      case 'low':
        return { label: 'Low', bg: 'rgba(168, 155, 184, 0.15)', text: 'var(--grey)', border: 'rgba(168, 155, 184, 0.25)' };
    }
  };

  const getTeamColor = (teamName?: string | null) => {
    switch (teamName) {
      case 'SEO':
        return { text: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' };
      case 'Social Media':
        return { text: '#c084fc', bg: 'rgba(192, 132, 252, 0.15)' };
      case 'Media Buying':
        return { text: '#fbbf24', bg: 'rgba(251, 191, 36, 0.15)' };
      case 'Creative & Design':
        return { text: '#f472b6', bg: 'rgba(244, 114, 182, 0.15)' };
      case 'Video Production':
        return { text: '#f87171', bg: 'rgba(248, 113, 113, 0.15)' };
      case 'Account Management':
        return { text: '#a78bfa', bg: 'rgba(167, 139, 250, 0.15)' };
      default:
        return { text: 'var(--grey)', bg: 'rgba(255, 255, 255, 0.05)' };
    }
  };

  return (
    <div className="space-y-6" id="daily-operations-module">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`p-3.5 rounded-xl text-xs flex items-center justify-between gap-3 shadow-lg transition-all ${
            notification.type === 'success'
              ? 'bg-[rgba(169,245,193,0.15)] border border-[var(--roas-good)] text-[var(--roas-good)]'
              : notification.type === 'error'
              ? 'bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]'
              : 'bg-[rgba(123,47,247,0.2)] border border-[var(--purple-light)] text-[var(--lilac)]'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : notification.type === 'error' ? (
              <AlertCircle className="w-4 h-4 shrink-0" />
            ) : (
              <PlayCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="font-semibold">{notification.text}</span>
          </div>
          <button onClick={() => setNotification(null)} className="text-xs opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TOP HEADER & OPERATIONAL EMPLOYEE SELECTOR */}
      <div
        className="p-4 rounded-[18px] flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center font-bold text-white shadow-md shrink-0"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
          >
            <Clock className="w-5 h-5 text-purple-200" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">Daily Operations & Task Execution</h2>
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                style={{
                  background: 'rgba(169, 245, 193, 0.2)',
                  color: 'var(--roas-good)',
                  border: '1px solid rgba(169, 245, 193, 0.3)',
                }}
              >
                Today: {todayStr}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              Organize today's priorities • Track logged hours • Document daily activity and blockers
            </p>
          </div>
        </div>

        {/* Employee Selector for Manager or Self */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-stone-900/80 border border-stone-800 text-xs">
            <User className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-stone-400 text-[11px]">Active Employee:</span>
            {isManagerOrLead ? (
              <select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer"
              >
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id} className="bg-stone-900 text-white">
                    {member.name} ({member.team || member.role})
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-bold text-white">{currentUser.name}</span>
            )}
          </div>

          <button
            onClick={() => setIsLoggingDailyActivity(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-white transition-all shadow-md hover:opacity-90 active:scale-98"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
          >
            <PlusCircle className="w-3.5 h-3.5 text-purple-200" />
            <span>Log Today's Activity</span>
          </button>

          {/* Self-only: extra_notes can only ever be authored as yourself
              (RLS), and "documented initiative" is inherently self-reported
              — a manager viewing someone else's board shouldn't see this. */}
          {onCreateExtraNote && effectiveEmployee.id === currentUser.id && (
            <button
              onClick={() => setIsLoggingExtraEffort(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-amber-200 bg-amber-950/30 hover:bg-amber-900/40 border border-amber-800/40 transition-all"
              title="Document effort beyond normal task scope"
            >
              <Star className="w-3.5 h-3.5 text-amber-300" />
              <span>Log Extra Effort</span>
            </button>
          )}
        </div>
      </div>

      {/* SUB-NAVIGATION TABS */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 border-b border-stone-800">
        <button
          onClick={() => setActiveSubTab('daily_view')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shrink-0 ${
            activeSubTab === 'daily_view'
              ? 'bg-purple-600/30 text-white border border-purple-500/50 shadow-md'
              : 'text-stone-400 hover:text-white border border-transparent'
          }`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>Daily Work View</span>
          {overdueTasks.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-red-950/80 text-red-400 border border-red-500/40 font-mono">
              {overdueTasks.length} overdue
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab('my_tasks')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shrink-0 ${
            activeSubTab === 'my_tasks'
              ? 'bg-purple-600/30 text-white border border-purple-500/50 shadow-md'
              : 'text-stone-400 hover:text-white border border-transparent'
          }`}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span>My Tasks</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-stone-800 text-stone-300 font-mono">
            {employeeTasks.length}
          </span>
        </button>

        <button
          onClick={() => setActiveSubTab('blockers')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shrink-0 ${
            activeSubTab === 'blockers'
              ? 'bg-red-950/60 text-red-300 border border-red-500/50 shadow-md'
              : 'text-stone-400 hover:text-red-400 border border-transparent'
          }`}
        >
          <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
          <span>Blockers Hub</span>
          {allVisibleBlockers.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-red-900 text-red-200 font-bold font-mono">
              {allVisibleBlockers.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab('daily_activity')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shrink-0 ${
            activeSubTab === 'daily_activity'
              ? 'bg-purple-600/30 text-white border border-purple-500/50 shadow-md'
              : 'text-stone-400 hover:text-white border border-transparent'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Daily Logs</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-stone-800 text-stone-300 font-mono">
            {relevantDailyLogs.length}
          </span>
        </button>

        {/* Manager View Tab (Always accessible to managers, or when in preview to inspect supervisor controls) */}
        <button
          onClick={() => setActiveSubTab('manager_view')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shrink-0 ${
            activeSubTab === 'manager_view'
              ? 'bg-purple-600/30 text-white border border-purple-500/50 shadow-md'
              : 'text-stone-400 hover:text-white border border-transparent'
          }`}
        >
          <Users className="w-3.5 h-3.5 text-purple-400" />
          <span>Manager View</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-purple-950 text-purple-300 border border-purple-800 font-mono">
            {teamMembers.length} members
          </span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 1. DAILY WORK VIEW: What to do today, Overdue, Priority First, Workload */}
      {/* ========================================================================= */}
      {activeSubTab === 'daily_view' && (
        <div className="space-y-6">
          {/* Daily Workload KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {/* Total Today's Estimated Workload */}
            <div
              className="p-3.5 rounded-[16px] flex flex-col justify-between"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
            >
              <div className="flex items-center justify-between text-stone-400">
                <span className="text-[11px] font-semibold">Total Hours Today</span>
                <Timer className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="mt-2">
                <p className="text-2xl font-bold text-white">{todayWorkloadHours} <span className="text-xs font-normal text-stone-400">hrs</span></p>
                <p className="text-[10px] text-stone-400 mt-0.5">Against capacity: {resolveCapacityLimit(effectiveEmployee)} tasks</p>
              </div>
            </div>

            {/* In Progress */}
            <div
              className="p-3.5 rounded-[16px] flex flex-col justify-between"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
            >
              <div className="flex items-center justify-between text-stone-400">
                <span className="text-[11px] font-semibold">Currently In Progress</span>
                <PlayCircle className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="mt-2">
                <p className="text-2xl font-bold text-purple-300">{inProgressTasks.length}</p>
                <p className="text-[10px] text-stone-400 mt-0.5">Active tasks on your desk</p>
              </div>
            </div>

            {/* Overdue Alert */}
            <div
              className={`p-3.5 rounded-[16px] flex flex-col justify-between ${
                overdueTasks.length > 0 ? 'ring-1 ring-red-500/50 bg-red-950/20' : ''
              }`}
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
            >
              <div className="flex items-center justify-between text-stone-400">
                <span className="text-[11px] font-semibold">Overdue</span>
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
              </div>
              <div className="mt-2">
                <p className="text-2xl font-bold text-red-400">{overdueTasks.length}</p>
                <p className="text-[10px] text-red-400/80 mt-0.5">Needs immediate attention</p>
              </div>
            </div>

            {/* Priority Focus */}
            <div
              className="p-3.5 rounded-[16px] flex flex-col justify-between"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
            >
              <div className="flex items-center justify-between text-stone-400">
                <span className="text-[11px] font-semibold">Urgent & High Priority</span>
                <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="mt-2">
                <p className="text-2xl font-bold text-amber-400">{priorityFirstTasks.length}</p>
                <p className="text-[10px] text-stone-400 mt-0.5">Urgent & High Priority</p>
              </div>
            </div>

            {/* Blocked Tasks */}
            <div
              className="p-3.5 rounded-[16px] flex flex-col justify-between"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
            >
              <div className="flex items-center justify-between text-stone-400">
                <span className="text-[11px] font-semibold">Blocked</span>
                <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
              </div>
              <div className="mt-2">
                <p className="text-2xl font-bold text-rose-300">{blockedEmployeeTasks.length}</p>
                <p className="text-[10px] text-stone-400 mt-0.5">Awaiting client or management</p>
              </div>
            </div>
          </div>

          {/* Section 1: OVERDUE TASKS (Must be addressed first) */}
          {overdueTasks.length > 0 && (
            <div
              className="p-4 rounded-[18px] border border-red-500/40 space-y-3"
              style={{ background: 'rgba(245, 163, 163, 0.08)' }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-red-400 font-bold text-xs">
                  <AlertTriangle className="w-4 h-4 animate-pulse" />
                  <span>Tasks past their due date — needs immediate attention</span>
                </div>
                <span className="text-[11px] text-red-400/90 font-mono">
                  {overdueTasks.length} overdue tasks
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {overdueTasks.map((task) => {
                  const client = clients.find((c) => c.id === task.client_id);
                  const priority = getPriorityBadge(task.priority);

                  return (
                    <div
                      key={task.id}
                      className="p-3.5 rounded-xl border border-red-500/30 bg-stone-900/80 flex flex-col justify-between gap-3 shadow-md"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span
                            className="px-2 py-0.5 rounded text-[10px] font-bold inline-block mb-1.5"
                            style={{ background: priority.bg, color: priority.text }}
                          >
                            {priority.label}
                          </span>
                          <h4
                            onClick={() => setSelectedTaskDetails(task)}
                            className="text-xs font-bold text-white hover:text-purple-300 cursor-pointer transition-colors"
                          >
                            {task.title}
                          </h4>
                          <p className="text-[11px] text-stone-400 flex items-center gap-1.5 mt-1">
                            <Building2 className="w-3 h-3 text-purple-400" />
                            <span>{client ? client.name : 'Unassigned client'}</span>
                          </p>
                        </div>
                        <span className="text-[10px] font-mono font-bold text-red-400 bg-red-950/60 px-2 py-1 rounded border border-red-500/40 shrink-0">
                          Due: {task.due_date}
                        </span>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-stone-800 text-[11px]">
                        <span className="text-stone-400">Est: {task.estimated_hours || 0}h • Actual: {task.actual_hours || 0}h</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleAdvanceStatus(task.id, task.status)}
                            className="px-2.5 py-1 rounded bg-purple-600/30 text-purple-200 hover:bg-purple-600/50 font-semibold text-[11px] transition-colors"
                          >
                            Advance Status
                          </button>
                          <button
                            onClick={() => setBlockerModalTask(task)}
                            className="px-2.5 py-1 rounded bg-red-950/80 text-red-400 hover:bg-red-900/80 font-semibold text-[11px] transition-colors"
                          >
                            Report Blocker
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 2: WHAT TO DO TODAY & PRIORITY FIRST QUEUE */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Column 1 & 2: Active Daily Queue */}
            <div
              className="lg:col-span-2 p-4 rounded-[18px] space-y-4"
              style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
            >
              <div className="flex items-center justify-between pb-2 border-b border-stone-800">
                <div className="flex items-center gap-2">
                  <PlayCircle className="w-4 h-4 text-purple-400" />
                  <h3 className="text-xs font-bold text-white">What to do today, in priority order</h3>
                </div>
                <span className="text-[11px] text-stone-400">Sorted by priority, then due date</span>
              </div>

              {sortedEmployeeTasks.filter((t) => t.status !== 'completed').length === 0 ? (
                <div className="p-8 text-center text-stone-400 text-xs border border-dashed border-stone-800 rounded-xl">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2 opacity-80" />
                  <p className="font-bold text-white text-sm">All clear! No active tasks pending for you today.</p>
                  <p className="text-stone-400 mt-1">All your tasks are completed or sitting in the general queue.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {sortedEmployeeTasks
                    .filter((t) => t.status !== 'completed')
                    .map((task) => {
                      const client = clients.find((c) => c.id === task.client_id);
                      const priority = getPriorityBadge(task.priority);
                      const statusBadge = getStatusBadge(task.status);
                      const teamColor = getTeamColor(task.team);
                      const overdue = isOverdue(task);

                      return (
                        <div
                          key={task.id}
                          className="p-3.5 rounded-xl border border-stone-800 hover:border-purple-500/40 bg-stone-900/60 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-md"
                        >
                          <div className="space-y-1.5 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-bold"
                                style={{ background: priority.bg, color: priority.text }}
                              >
                                {priority.label}
                              </span>
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-bold"
                                style={{ background: teamColor.bg, color: teamColor.text }}
                              >
                                {task.team || 'General Team'}
                              </span>
                              <span
                                className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{ background: statusBadge.bg, color: statusBadge.text }}
                              >
                                {getStatusLabel(task.status)}
                              </span>
                              {overdue && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950 text-red-400">
                                  Overdue
                                </span>
                              )}
                            </div>

                            <h4
                              onClick={() => setSelectedTaskDetails(task)}
                              className="text-xs font-bold text-white hover:text-purple-300 cursor-pointer transition-colors"
                            >
                              {task.title}
                            </h4>

                            <div className="flex flex-wrap items-center gap-3 text-[11px] text-stone-400">
                              <span className="flex items-center gap-1">
                                <Building2 className="w-3 h-3 text-purple-400" />
                                <span>{client ? client.name : 'Unassigned client'}</span>
                              </span>
                              <span className="flex items-center gap-1 font-mono">
                                <Calendar className="w-3 h-3 text-stone-400" />
                                <span>Due: {task.due_date || 'Not set'}</span>
                              </span>
                              <span className="flex items-center gap-1 font-mono">
                                <Timer className="w-3 h-3 text-purple-300" />
                                <span>Est: {task.estimated_hours || 0}h • Actual: {task.actual_hours || 0}h</span>
                              </span>
                            </div>
                          </div>

                          {/* Quick Workflow Action Buttons */}
                          <div className="flex items-center gap-1.5 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-stone-800">
                            {/* Fast Time Log Button */}
                            <button
                              onClick={() => setTimeLoggingTaskId(task.id)}
                              className="p-1.5 rounded-lg bg-stone-800 text-stone-300 hover:text-white hover:bg-stone-700 transition-colors"
                              title="Log actual hours worked"
                            >
                              <Clock className="w-3.5 h-3.5" />
                            </button>

                            {/* Status Advancement Button */}
                            {task.status !== 'completed' && task.status !== 'blocked' && (
                              <button
                                onClick={() => handleAdvanceStatus(task.id, task.status)}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600/30 text-purple-200 hover:bg-purple-600/50 transition-colors flex items-center gap-1"
                              >
                                <span>Advance Status</span>
                                <ChevronLeft className="w-3.5 h-3.5" />
                              </button>
                            )}

                            {/* If blocked, allow Unblock */}
                            {task.status === 'blocked' ? (
                              <button
                                onClick={() => handleResolveBlocker(task)}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-950/80 text-emerald-300 hover:bg-emerald-900 border border-emerald-500/40 transition-colors"
                              >
                                Resolve Blocker
                              </button>
                            ) : (
                              <button
                                onClick={() => setBlockerModalTask(task)}
                                className="px-2 py-1.5 rounded-lg text-xs font-semibold bg-stone-900 text-red-400 hover:bg-red-950/60 transition-colors"
                                title="Report a blocker"
                              >
                                <ShieldAlert className="w-3.5 h-3.5" />
                              </button>
                            )}

                            <button
                              onClick={() => setSelectedTaskDetails(task)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-stone-800 text-stone-300 hover:text-white transition-colors"
                            >
                              Details
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Column 3: Daily Summary & Quick Stats */}
            <div className="space-y-4">
              {/* Daily Focus Guidance Box */}
              <div
                className="p-4 rounded-[18px] space-y-3"
                style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
              >
                <div className="flex items-center gap-2 text-xs font-bold text-white">
                  <CheckSquare className="w-4 h-4 text-purple-400" />
                  <span>Daily Work Guidance</span>
                </div>
                <div className="space-y-2 text-xs text-stone-300 leading-relaxed">
                  <p className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                    <span>Start with overdue tasks and anything marked <strong>Urgent</strong> to avoid holding up other teams.</span>
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                    <span>Log actual hours when you finish work to keep individual productivity metrics up to date.</span>
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                    <span>If anything blocks a task (e.g. no client response or missing permissions), mark it <strong>Blocked</strong> immediately.</span>
                  </p>
                </div>

                <div className="pt-2 border-t border-stone-800">
                  <button
                    onClick={() => setIsLoggingDailyActivity(true)}
                    className="w-full py-2 rounded-xl text-xs font-bold text-center text-white transition-all shadow-md hover:opacity-90"
                    style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                  >
                    Log Your Daily Summary
                  </button>
                </div>
              </div>

              {/* Time Tracking / Hours Summary Widget */}
              <div
                className="p-4 rounded-[18px] space-y-3"
                style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
              >
                <div className="flex items-center justify-between text-xs font-bold text-white">
                  <div className="flex items-center gap-2">
                    <Timer className="w-4 h-4 text-purple-400" />
                    <span>Logged Hours</span>
                  </div>
                  <span className="text-[11px] text-stone-400 font-mono">
                    {totalActualHoursLogged} / {totalActiveEstimatedHours}h
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-stone-400">
                    <span>Estimated hours completed:</span>
                    <span className="font-bold text-white">
                      {totalActiveEstimatedHours > 0
                        ? Math.round((totalActualHoursLogged / totalActiveEstimatedHours) * 100)
                        : 0}%
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-stone-900 overflow-hidden border border-stone-800">
                    <div
                      className="h-full transition-all rounded-full"
                      style={{
                        width: `${Math.min(
                          100,
                          totalActiveEstimatedHours > 0
                            ? Math.round((totalActualHoursLogged / totalActiveEstimatedHours) * 100)
                            : 0
                        )}%`,
                        background: 'var(--gradient-badge)',
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. MY TASKS VIEW: Comprehensive List Sorted by Priority & Due Date       */}
      {/* ========================================================================= */}
      {activeSubTab === 'my_tasks' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div
            className="p-4 rounded-[18px] grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3"
            style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
          >
            {/* Search */}
            <div>
              <label className="text-[11px] font-semibold text-stone-400 block mb-1">Search your tasks:</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-stone-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by title or client..."
                  className="w-full pr-8 pl-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            {/* Status Filter */}
            <div>
              <label className="text-[11px] font-semibold text-stone-400 block mb-1">Status:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
              >
                <option value="all" className="bg-stone-900 text-white">All Statuses ({sortedEmployeeTasks.length})</option>
                <option value="todo" className="bg-stone-900 text-white">To Do</option>
                <option value="in_progress" className="bg-stone-900 text-white">In Progress</option>
                <option value="in_review" className="bg-stone-900 text-white">In Review</option>
                <option value="completed" className="bg-stone-900 text-white">Completed</option>
                <option value="blocked" className="bg-stone-900 text-white">Blocked</option>
              </select>
            </div>

            {/* Priority Filter */}
            <div>
              <label className="text-[11px] font-semibold text-stone-400 block mb-1">Priority Level:</label>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
              >
                <option value="all" className="bg-stone-900 text-white">All Priorities</option>
                <option value="urgent" className="bg-stone-900 text-white">Urgent</option>
                <option value="high" className="bg-stone-900 text-white">High</option>
                <option value="medium" className="bg-stone-900 text-white">Medium</option>
                <option value="low" className="bg-stone-900 text-white">Low</option>
              </select>
            </div>

            {/* Quick Filter Reset */}
            <div className="flex items-end">
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setPriorityFilter('all');
                  setSearchQuery('');
                }}
                className="w-full py-1.5 rounded-xl text-xs font-semibold bg-stone-900 hover:bg-stone-800 border border-stone-800 text-stone-300 transition-colors"
              >
                Reset Filters
              </button>
            </div>
          </div>

          {/* Tasks Table / Cards */}
          <div
            className="rounded-[18px] overflow-hidden border border-stone-800"
            style={{ background: 'var(--gradient-card)' }}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-stone-900/90 text-stone-300 border-b border-stone-800">
                  <tr>
                    <th className="p-3.5">Task</th>
                    <th className="p-3.5">Client</th>
                    <th className="p-3.5">Team & Service</th>
                    <th className="p-3.5 text-center">Priority</th>
                    <th className="p-3.5 text-center">Due Date</th>
                    <th className="p-3.5 text-center">Est. Hours</th>
                    <th className="p-3.5 text-center">Actual Hours</th>
                    <th className="p-3.5 text-center">Status</th>
                    <th className="p-3.5 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800/60">
                  {filteredEmployeeTasks.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-stone-400">
                        No tasks match the current search criteria for the selected employee.
                      </td>
                    </tr>
                  ) : (
                    filteredEmployeeTasks.map((task) => {
                      const client = clients.find((c) => c.id === task.client_id);
                      const priority = getPriorityBadge(task.priority);
                      const statusBadge = getStatusBadge(task.status);
                      const teamColor = getTeamColor(task.team);
                      const overdue = isOverdue(task);

                      return (
                        <tr
                          key={task.id}
                          className="hover:bg-stone-900/40 transition-colors cursor-pointer"
                          onClick={() => setSelectedTaskDetails(task)}
                        >
                          <td className="p-3.5">
                            <p className="font-bold text-white hover:text-purple-300 transition-colors">
                              {task.title}
                            </p>
                            {task.description && (
                              <p className="text-[11px] text-stone-400 line-clamp-1 max-w-xs">
                                {task.description}
                              </p>
                            )}
                          </td>

                          <td className="p-3.5 font-medium text-stone-300">
                            {client ? client.name : '—'}
                          </td>

                          <td className="p-3.5">
                            <span
                              className="px-2 py-0.5 rounded text-[10px] font-bold"
                              style={{ background: teamColor.bg, color: teamColor.text }}
                            >
                              {task.team || 'General Team'}
                            </span>
                          </td>

                          <td className="p-3.5 text-center">
                            <span
                              className="px-2 py-0.5 rounded-full text-[10px] font-semibold inline-block"
                              style={{ background: priority.bg, color: priority.text }}
                            >
                              {priority.label}
                            </span>
                          </td>

                          <td className="p-3.5 text-center font-mono">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                overdue
                                  ? 'bg-red-950/80 text-red-400 border border-red-500/40 font-bold'
                                  : 'text-stone-300'
                              }`}
                            >
                              {task.due_date || '—'}
                            </span>
                          </td>

                          <td className="p-3.5 text-center font-mono text-stone-300">
                            {task.estimated_hours || 0}h
                          </td>

                          <td className="p-3.5 text-center font-mono text-stone-300">
                            {task.actual_hours || 0}h
                          </td>

                          <td className="p-3.5 text-center">
                            <span
                              className="px-2.5 py-1 rounded-full text-[10px] font-bold inline-block"
                              style={{
                                background: statusBadge.bg,
                                color: statusBadge.text,
                                border: `1px solid ${statusBadge.border}`,
                              }}
                            >
                              {getStatusLabel(task.status)}
                            </span>
                          </td>

                          <td className="p-3.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-center gap-1.5">
                              {/* Quick status dropdown */}
                              <select
                                value={task.status}
                                onChange={(e) => handleQuickStatusChange(task.id, e.target.value as TaskStatus)}
                                className="px-2 py-1 rounded bg-stone-900 border border-stone-800 text-[11px] text-white focus:outline-none"
                              >
                                <option value="todo" className="bg-stone-900 text-white">To Do</option>
                                <option value="in_progress" className="bg-stone-900 text-white">In Progress</option>
                                <option value="in_review" className="bg-stone-900 text-white">In Review</option>
                                <option value="completed" className="bg-stone-900 text-white">Completed</option>
                                <option value="blocked" className="bg-stone-900 text-white">Blocked</option>
                              </select>

                              {/* Quick Time Log Button */}
                              <button
                                onClick={() => setTimeLoggingTaskId(task.id)}
                                className="p-1 rounded bg-stone-800 text-stone-300 hover:text-white"
                                title="Log hours"
                              >
                                <Clock className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. BLOCKERS HUB: Record, Display & Resolve Blockers                      */}
      {/* ========================================================================= */}
      {activeSubTab === 'blockers' && (
        <div className="space-y-4">
          <div
            className="p-4 rounded-[18px] flex items-center justify-between"
            style={{ background: 'rgba(245, 163, 163, 0.08)', border: '1px solid rgba(245, 163, 163, 0.3)' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-950/80 border border-red-500/40 flex items-center justify-center text-red-400">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Blockers Hub</h3>
                <p className="text-xs text-stone-400 mt-0.5">
                  Track tasks stalled by external or technical obstacles, and work with management to resolve them
                </p>
              </div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-red-950 text-red-400 border border-red-500/40 font-mono">
              {allVisibleBlockers.length} blocked tasks
            </span>
          </div>

          {allVisibleBlockers.length === 0 ? (
            <div
              className="p-10 text-center rounded-[18px] border border-stone-800"
              style={{ background: 'var(--gradient-card)' }}
            >
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-2 opacity-90" />
              <h4 className="text-sm font-bold text-white">No blocked tasks right now!</h4>
              <p className="text-xs text-stone-400 mt-1">
                Everything is running smoothly with no pending blockers.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allVisibleBlockers.map((task) => {
                const client = clients.find((c) => c.id === task.client_id);
                const assignee = users.find((u) => u.id === task.assigned_to);
                const priority = getPriorityBadge(task.priority);

                return (
                  <div
                    key={task.id}
                    className="p-4 rounded-[16px] border border-red-500/40 bg-stone-900/90 flex flex-col justify-between gap-3 shadow-lg relative overflow-hidden"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="px-2 py-0.5 rounded text-[10px] font-bold"
                          style={{ background: priority.bg, color: priority.text }}
                        >
                          {priority.label}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-950 text-red-400 border border-red-500/40">
                          Blocked
                        </span>
                      </div>

                      <h4
                        onClick={() => setSelectedTaskDetails(task)}
                        className="text-xs font-bold text-white hover:text-purple-300 cursor-pointer transition-colors leading-snug"
                      >
                        {task.title}
                      </h4>

                      <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/30 text-[11px] text-red-300 leading-relaxed">
                        <p className="font-semibold text-red-200 mb-0.5">Recorded blocker reason:</p>
                        <p className="line-clamp-3">{task.description || 'No blocker details recorded.'}</p>
                      </div>

                      <div className="space-y-1 text-[11px] text-stone-400 pt-1">
                        <p className="flex items-center gap-1.5">
                          <Building2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                          <span className="truncate">{client ? client.name : '—'}</span>
                        </p>
                        <p className="flex items-center gap-1.5">
                          <User className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                          <span>Assignee: {assignee ? assignee.name : 'Unassigned'}</span>
                        </p>
                        <p className="flex items-center gap-1.5 font-mono">
                          <Calendar className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                          <span>Due: {task.due_date || 'Not set'}</span>
                        </p>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-stone-800 flex items-center justify-between gap-2">
                      <button
                        onClick={() => setSelectedTaskDetails(task)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-stone-800 hover:bg-stone-700 text-stone-300 transition-colors"
                      >
                        View Details
                      </button>

                      <button
                        onClick={() => handleResolveBlocker(task)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50 border border-emerald-500/40 transition-colors flex items-center gap-1.5"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Resolve & Resume</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. DAILY ACTIVITY & LOGS VIEW (Connected to daily_logs database table)    */}
      {/* ========================================================================= */}
      {activeSubTab === 'daily_activity' && (
        <div className="space-y-4">
          <div
            className="p-4 rounded-[18px] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
          >
            <div>
              <h3 className="text-xs font-bold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-purple-400" />
                <span>Daily Logs & Standup</span>
              </h3>
              <p className="text-xs text-stone-400 mt-0.5">
                Document daily work accomplished, completed tasks, and coordination notes between employees and team leads
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <select
                value={logClientFilter}
                onChange={(e) => setLogClientFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
              >
                <option value="all" className="bg-stone-900 text-white">All Clients</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id} className="bg-stone-900 text-white">
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setIsLoggingDailyActivity(true)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-white transition-all shadow-md hover:opacity-90 shrink-0"
                style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
              >
                <PlusCircle className="w-3.5 h-3.5 text-purple-200" />
                <span>Add New Daily Report</span>
              </button>
            </div>
          </div>

          {/* Logs Feed */}
          {relevantDailyLogs.length === 0 ? (
            <div
              className="p-10 text-center rounded-[18px] border border-stone-800"
              style={{ background: 'var(--gradient-card)' }}
            >
              <FileText className="w-8 h-8 text-stone-600 mx-auto mb-2" />
              <h4 className="text-xs font-bold text-white">No previous daily activity reports recorded for the selected employee.</h4>
              <p className="text-xs text-stone-400 mt-1">Click the button above to log a summary of today's work.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {relevantDailyLogs.map((log) => {
                const logUser = users.find((u) => u.id === log.user_id);
                const linkedTasksList = tasks.filter((t) => log.linked_task_ids?.includes(t.id));
                const logClient = log.client_id ? clients.find((c) => c.id === log.client_id) : null;

                return (
                  <div
                    key={log.id}
                    className="p-4 rounded-[16px] border border-stone-800 hover:border-purple-500/40 bg-stone-900/60 transition-all space-y-3 shadow-md"
                  >
                    <div className="flex items-center justify-between pb-2 border-b border-stone-800 text-xs">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-[10px]"
                          style={{ background: 'var(--gradient-badge)', color: 'white' }}
                        >
                          {logUser?.name.charAt(0) || 'U'}
                        </div>
                        <span className="font-bold text-white">{logUser?.name || 'Employee'}</span>
                        <span className="text-stone-400 text-[11px]">({logUser?.team || logUser?.role})</span>
                        {logClient && (
                          <span className="text-[10px] font-bold text-purple-300 bg-purple-950/50 px-2 py-0.5 rounded-full border border-purple-800/60">
                            {logClient.name}
                          </span>
                        )}
                      </div>

                      <span className="text-[11px] font-mono text-purple-300 bg-purple-950/60 px-2.5 py-0.5 rounded-full border border-purple-800">
                        Date: {log.date}
                      </span>
                    </div>

                    <p className="text-xs text-stone-200 leading-relaxed whitespace-pre-wrap">
                      {log.summary_text}
                    </p>

                    {linkedTasksList.length > 0 && (
                      <div className="pt-2 border-t border-stone-800/80">
                        <p className="text-[11px] text-stone-400 font-semibold mb-1.5 flex items-center gap-1.5">
                          <CheckSquare className="w-3.5 h-3.5 text-purple-400" />
                          <span>Tasks linked to this report:</span>
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {linkedTasksList.map((lt) => (
                            <button
                              key={lt.id}
                              onClick={() => setSelectedTaskDetails(lt)}
                              className="px-2.5 py-1 rounded-lg text-[11px] bg-stone-800 hover:bg-purple-900/50 text-stone-200 transition-colors flex items-center gap-1 border border-stone-700"
                            >
                              <span>{lt.title}</span>
                              <ExternalLink className="w-2.5 h-2.5 text-purple-300" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. MANAGER / TEAM LEAD VIEW                                               */}
      {/* ========================================================================= */}
      {activeSubTab === 'manager_view' && (
        <div className="space-y-5">
          <div
            className="p-4 rounded-[18px] flex items-center justify-between"
            style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
          >
            <div>
              <h3 className="text-xs font-bold text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-purple-400" />
                <span>Team Lead / Manager Overview</span>
              </h3>
              <p className="text-xs text-stone-400 mt-0.5">
                Monitor employee performance, workload distribution, overdue tasks, and clear operational blockers
              </p>
            </div>
            <span className="text-xs text-stone-400 bg-stone-900 px-3 py-1 rounded-xl border border-stone-800">
              Current Role: <strong className="text-purple-300">{currentUser.role}</strong>
            </span>
          </div>

          {/* Team Workload Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {teamWorkloadSummary.map((item) => {
              const isOver = !item.isUntracked && item.rate >= 100;
              const isNear = !item.isUntracked && item.rate >= 75 && item.rate < 100;

              return (
                <div
                  key={item.member.id}
                  className="p-4 rounded-[18px] border border-stone-800 hover:border-purple-500/50 transition-all bg-stone-900/70 flex flex-col justify-between gap-3.5 shadow-md"
                >
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs"
                          style={{ background: 'var(--gradient-badge)', color: 'white' }}
                        >
                          {item.member.name.charAt(0)}
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-white">{item.member.name}</h4>
                          <p className="text-[11px] text-stone-400">{item.member.team || item.member.role}</p>
                        </div>
                      </div>

                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                          item.isUntracked
                            ? 'bg-stone-800 text-stone-400 border border-stone-700'
                            : isOver
                            ? 'bg-red-950 text-red-400 border border-red-500/40'
                            : isNear
                            ? 'bg-amber-950 text-amber-400 border border-amber-500/40'
                            : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                        }`}
                      >
                        {item.isUntracked ? 'N/A' : `${item.rate}% load`}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-stone-400">
                        <span>Active tasks: {item.activeCount} / {item.limit}</span>
                        <span>Allocated hours: {item.totalEstimated}h</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-stone-950 overflow-hidden border border-stone-800">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: item.isUntracked ? '0%' : `${Math.min(100, item.rate)}%`,
                            background: isOver
                              ? 'var(--roas-bad)'
                              : isNear
                              ? 'var(--roas-mid)'
                              : 'var(--roas-good)',
                          }}
                        />
                      </div>
                    </div>

                    {/* Metric Badges Grid */}
                    <div className="grid grid-cols-3 gap-2 text-center text-xs pt-1">
                      <div className="p-2 rounded-xl bg-stone-900 border border-stone-800">
                        <p className="text-[10px] text-stone-400">Completed</p>
                        <p className="text-sm font-bold text-emerald-400 mt-0.5">{item.completedCount}</p>
                      </div>

                      <div className={`p-2 rounded-xl border ${item.overdueCount > 0 ? 'bg-red-950/40 border-red-500/40' : 'bg-stone-900 border-stone-800'}`}>
                        <p className="text-[10px] text-stone-400">Overdue</p>
                        <p className={`text-sm font-bold mt-0.5 ${item.overdueCount > 0 ? 'text-red-400' : 'text-stone-300'}`}>
                          {item.overdueCount}
                        </p>
                      </div>

                      <div className={`p-2 rounded-xl border ${item.blockedCount > 0 ? 'bg-amber-950/40 border-amber-500/40' : 'bg-stone-900 border-stone-800'}`}>
                        <p className="text-[10px] text-stone-400">Blocked</p>
                        <p className={`text-sm font-bold mt-0.5 ${item.blockedCount > 0 ? 'text-amber-400' : 'text-stone-300'}`}>
                          {item.blockedCount}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Manager Actions */}
                  <div className="pt-2 border-t border-stone-800 flex items-center justify-between gap-2">
                    <button
                      onClick={() => {
                        setSelectedEmployeeId(item.member.id);
                        setActiveSubTab('my_tasks');
                      }}
                      className="w-full py-1.5 rounded-lg text-xs font-semibold bg-stone-800 hover:bg-stone-700 text-purple-300 transition-colors flex items-center justify-center gap-1"
                    >
                      <span>View Employee Tasks</span>
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 1: TASK DETAILS (Client, Service, Linked Brief, Notes, Dates)       */}
      {/* ========================================================================= */}
      {selectedTaskDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm overflow-y-auto">
          <div
            className="w-full max-w-2xl rounded-[20px] p-6 space-y-5 border shadow-2xl my-8 relative"
            style={{
              background: 'var(--surface-dark)',
              borderColor: 'var(--border-strong)',
            }}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between pb-3 border-b border-stone-800">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      background: getPriorityBadge(selectedTaskDetails.priority).bg,
                      color: getPriorityBadge(selectedTaskDetails.priority).text,
                    }}
                  >
                    {getPriorityBadge(selectedTaskDetails.priority).label}
                  </span>
                  <span
                    className="px-2.5 py-0.5 rounded-full text-[10px] font-bold"
                    style={{
                      background: getStatusBadge(selectedTaskDetails.status).bg,
                      color: getStatusBadge(selectedTaskDetails.status).text,
                    }}
                  >
                    {getStatusLabel(selectedTaskDetails.status)}
                  </span>
                </div>
                <h3 className="text-base font-bold text-white mt-1">{selectedTaskDetails.title}</h3>
              </div>

              <button
                onClick={() => setSelectedTaskDetails(null)}
                className="p-1 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              {/* Task Description */}
              {selectedTaskDetails.description && (
                <div className="p-3.5 rounded-xl bg-stone-900/80 border border-stone-800 text-xs text-stone-300 leading-relaxed">
                  <span className="font-bold text-stone-400 block mb-1">Task description and required deliverables:</span>
                  <p className="whitespace-pre-wrap">{selectedTaskDetails.description}</p>
                </div>
              )}

              {/* Client & Service Info */}
              {(() => {
                const client = clients.find((c) => c.id === selectedTaskDetails.client_id);
                const assignee = users.find((u) => u.id === selectedTaskDetails.assigned_to);

                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800 text-xs space-y-1">
                      <span className="text-stone-400 text-[11px] block">Linked Client:</span>
                      <p className="font-bold text-white text-sm flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-purple-400" />
                        <span>{client ? client.name : 'Not set'}</span>
                      </p>
                      <p className="text-[11px] text-stone-400">Industry: {client?.industry || '—'}</p>
                    </div>

                    <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800 text-xs space-y-1">
                      <span className="text-stone-400 text-[11px] block">Assigned Employee:</span>
                      <p className="font-bold text-white text-sm flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-purple-400" />
                        <span>{assignee ? assignee.name : 'Unassigned'}</span>
                      </p>
                      <p className="text-[11px] text-stone-400">Team: {selectedTaskDetails.team || '—'}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Dates & Hours Tracker */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="p-2.5 rounded-xl bg-stone-900/60 border border-stone-800">
                  <span className="text-[10px] text-stone-400 block">Due Date</span>
                  <span className="font-bold text-white font-mono">{selectedTaskDetails.due_date || '—'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-stone-900/60 border border-stone-800">
                  <span className="text-[10px] text-stone-400 block">Est. Hours</span>
                  <span className="font-bold text-purple-300 font-mono">{selectedTaskDetails.estimated_hours || 0}h</span>
                </div>

                <div className="p-2.5 rounded-xl bg-stone-900/60 border border-stone-800">
                  <span className="text-[10px] text-stone-400 block">Actual Hours</span>
                  <span className="font-bold text-emerald-400 font-mono">{selectedTaskDetails.actual_hours || 0}h</span>
                </div>

                <div className="p-2.5 rounded-xl bg-stone-900/60 border border-stone-800">
                  <span className="text-[10px] text-stone-400 block">Created On</span>
                  <span className="font-bold text-stone-300 font-mono text-[10px]">
                    {selectedTaskDetails.created_at ? selectedTaskDetails.created_at.split('T')[0] : '—'}
                  </span>
                </div>
              </div>

              {/* Linked Brief Information (From database briefs table) */}
              {(() => {
                const linkedBrief = briefs.find((b) => b.client_id === selectedTaskDetails.client_id);

                return (
                  <div className="p-3.5 rounded-xl bg-stone-900/80 border border-stone-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-purple-400" />
                        <span>Linked Brief</span>
                      </span>
                      {linkedBrief && (
                        <span className="text-[10px] text-stone-400 font-mono">
                          Version {linkedBrief.version} • {linkedBrief.service_type}
                        </span>
                      )}
                    </div>

                    {linkedBrief ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px]">
                        {Object.entries(linkedBrief.fields).map(([key, val]) => (
                          <div key={key} className="p-2 rounded bg-stone-950/60 border border-stone-800/80">
                            <span className="text-stone-400 block font-mono text-[10px]">{key}:</span>
                            <span className="text-stone-200 font-medium whitespace-pre-wrap line-clamp-3">
                              {Array.isArray(val) ? val.join(', ') : String(val)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-stone-500 py-1">
                        No detailed brief recorded for this client yet.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Status Update & Blocker Actions */}
              <div className="p-3.5 rounded-xl bg-stone-900/80 border border-stone-800 space-y-2">
                <span className="text-xs font-bold text-white block">Update task stage:</span>
                <div className="flex flex-wrap gap-2">
                  {(['todo', 'in_progress', 'in_review', 'completed'] as TaskStatus[]).map((st) => (
                    <button
                      key={st}
                      onClick={async () => {
                        await onUpdateTaskStatus(selectedTaskDetails.id, st);
                        setSelectedTaskDetails({ ...selectedTaskDetails, status: st });
                        showNotification(`Status changed to "${getStatusLabel(st)}".`);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        selectedTaskDetails.status === st
                          ? 'bg-purple-600 text-white shadow-md'
                          : 'bg-stone-800 text-stone-400 hover:text-white'
                      }`}
                    >
                      {getStatusLabel(st)}
                    </button>
                  ))}

                  <button
                    onClick={() => {
                      setBlockerModalTask(selectedTaskDetails);
                      setSelectedTaskDetails(null);
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-950/80 text-red-400 hover:bg-red-900 transition-colors border border-red-500/40 mr-auto"
                  >
                    Mark Task as Blocked
                  </button>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="pt-3 border-t border-stone-800 flex justify-end">
              <button
                onClick={() => setSelectedTaskDetails(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-stone-800 hover:bg-stone-700 text-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: REPORT / RECORD A BLOCKER                                        */}
      {/* ========================================================================= */}
      {blockerModalTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-lg rounded-[20px] p-6 space-y-4 border shadow-2xl relative"
            style={{ background: 'var(--surface-dark)', borderColor: 'rgba(245, 163, 163, 0.4)' }}
          >
            <div className="flex items-start justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2 text-red-400">
                <ShieldAlert className="w-5 h-5" />
                <h3 className="text-sm font-bold text-white">Report Blocker</h3>
              </div>
              <button
                onClick={() => setBlockerModalTask(null)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmBlocker} className="space-y-4">
              <div className="p-3 rounded-xl bg-stone-900 border border-stone-800 text-xs">
                <p className="text-stone-400 text-[11px]">Task to document as blocked:</p>
                <p className="font-bold text-white text-sm mt-0.5">{blockerModalTask.title}</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1.5">
                  Blocker reason in detail (what's preventing progress?):
                </label>
                <textarea
                  rows={4}
                  required
                  value={blockerReason}
                  onChange={(e) => setBlockerReason(e.target.value)}
                  placeholder="Example: Waiting on client to provide ad account access / missing content..."
                  className="w-full p-3 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-red-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
                <button
                  type="button"
                  onClick={() => setBlockerModalTask(null)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-stone-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-700 text-white shadow-lg transition-all"
                >
                  Confirm — Mark as Blocked
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 3: LOG DAILY ACTIVITY (Saved to daily_logs table)                    */}
      {/* ========================================================================= */}
      {isLoggingDailyActivity && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-xl rounded-[20px] p-6 space-y-4 border shadow-2xl relative"
            style={{ background: 'var(--surface-dark)', borderColor: 'var(--border-strong)' }}
          >
            <div className="flex items-start justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-purple-400" />
                <h3 className="text-sm font-bold text-white">Daily Activity Log</h3>
              </div>
              <button
                onClick={() => setIsLoggingDailyActivity(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitDailyLog} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-stone-400 block mb-1">Employee:</label>
                  <input
                    type="text"
                    disabled
                    value={effectiveEmployee.name}
                    className="w-full p-2.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-stone-300"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-stone-400 block mb-1">Report Date:</label>
                  <input
                    type="date"
                    required
                    value={logDate}
                    onChange={(e) => setLogDate(e.target.value)}
                    className="w-full p-2.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-stone-400 block mb-1">Client (optional):</label>
                <select
                  value={logClientId}
                  onChange={(e) => setLogClientId(e.target.value)}
                  className="w-full p-2.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="" className="bg-stone-900 text-stone-400">-- Not specific to one client --</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id} className="bg-stone-900 text-white">
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1.5">
                  Summary of today's work and next steps:
                </label>
                <textarea
                  rows={4}
                  required
                  value={dailySummary}
                  onChange={(e) => setDailySummary(e.target.value)}
                  placeholder="Write a summary of the tasks you worked on today, deliverables, and challenges..."
                  className="w-full p-3 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              {/* Linked Tasks Checkboxes */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1.5">
                  Link tasks you worked on:
                </label>
                <div className="max-h-36 overflow-y-auto p-2.5 rounded-xl bg-stone-900/90 border border-stone-800 space-y-1.5">
                  {dailyLogChecklistTasks.length === 0 ? (
                    <p className="text-xs text-stone-500">No tasks assigned to this employee.</p>
                  ) : (
                    dailyLogChecklistTasks.map((t) => {
                      const isChecked = selectedLinkedTasks.includes(t.id);
                      const completedOnLogDate = t.completed_at?.split('T')[0] === logDate;

                      return (
                        <label
                          key={t.id}
                          className={`flex items-center gap-2 p-1.5 rounded hover:bg-stone-800 cursor-pointer text-xs text-stone-300 ${
                            completedOnLogDate ? 'bg-emerald-950/30 border border-emerald-800/40' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedLinkedTasks([...selectedLinkedTasks, t.id]);
                              } else {
                                setSelectedLinkedTasks(selectedLinkedTasks.filter((id) => id !== t.id));
                              }
                            }}
                            className="rounded border-stone-700 text-purple-600 focus:ring-0"
                          />
                          <span className="font-semibold text-white">{t.title}</span>
                          <span className="text-[10px] text-stone-500 mr-auto">({getStatusLabel(t.status)})</span>
                          {completedOnLogDate && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded-full font-bold uppercase bg-emerald-900/60 text-emerald-300 shrink-0">
                              Completed this day
                            </span>
                          )}
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
                <button
                  type="button"
                  onClick={() => setIsLoggingDailyActivity(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-stone-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingLog}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white transition-all shadow-lg hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                >
                  {isSubmittingLog ? 'Saving...' : 'Save Daily Report'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Extra Effort Log Modal — the genuine "document initiative" entry
          point, distinct from the incidental 'blocker' auto-log below. */}
      {isLoggingExtraEffort && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-lg rounded-[20px] p-6 space-y-4 border shadow-2xl relative"
            style={{ background: 'var(--surface-dark)', borderColor: 'var(--border-strong)' }}
          >
            <div className="flex items-start justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2">
                <Star className="w-5 h-5 text-amber-300" />
                <h3 className="text-sm font-bold text-white">Log Extra Effort</h3>
              </div>
              <button
                onClick={() => setIsLoggingExtraEffort(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[11px] text-stone-400">
              Document work beyond your normal task scope — mentoring a teammate, improving a process,
              taking on something outside your usual role. Counted separately from regular task performance.
            </p>

            <form onSubmit={handleSubmitExtraEffort} className="space-y-4">
              <div>
                <label className="text-[11px] font-semibold text-stone-400 block mb-1">Date:</label>
                <input
                  type="date"
                  required
                  value={extraEffortDate}
                  onChange={(e) => setExtraEffortDate(e.target.value)}
                  className="w-full p-2.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1.5">What did you do?</label>
                <textarea
                  rows={4}
                  required
                  value={extraEffortText}
                  onChange={(e) => setExtraEffortText(e.target.value)}
                  placeholder="Describe the extra effort or initiative..."
                  className="w-full p-3 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-amber-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
                <button
                  type="button"
                  onClick={() => setIsLoggingExtraEffort(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-stone-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingExtraEffort}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white transition-all shadow-lg hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', border: '1px solid rgba(245, 158, 11, 0.4)' }}
                >
                  {isSubmittingExtraEffort ? 'Saving...' : 'Save Note'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 4: QUICK TIME LOGGING                                               */}
      {/* ========================================================================= */}
      {timeLoggingTaskId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-sm rounded-[20px] p-5 space-y-4 border shadow-2xl relative"
            style={{ background: 'var(--surface-dark)', borderColor: 'var(--border-strong)' }}
          >
            {(() => {
              const targetTask = tasks.find((t) => t.id === timeLoggingTaskId);
              if (!targetTask) return null;

              return (
                <>
                  <div className="flex items-start justify-between pb-2 border-b border-stone-800">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-purple-400" />
                      <h4 className="text-xs font-bold text-white">Log Actual Hours Worked</h4>
                    </div>
                    <button
                      onClick={() => setTimeLoggingTaskId(null)}
                      className="p-1 rounded text-stone-400 hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-bold text-white line-clamp-1">{targetTask.title}</p>
                    <p className="text-[11px] text-stone-400">
                      Currently logged hours: <strong className="text-purple-300 font-mono">{targetTask.actual_hours || 0}h</strong>
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-stone-300 block mb-1">
                      Additional hours completed:
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="24"
                      value={additionalHours}
                      onChange={(e) => setAdditionalHours(parseFloat(e.target.value) || 0)}
                      className="w-full p-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
                    <button
                      type="button"
                      onClick={() => setTimeLoggingTaskId(null)}
                      className="px-3 py-1.5 rounded-lg text-xs text-stone-400 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLogActualHours(targetTask)}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold text-white shadow-md hover:opacity-90"
                      style={{ background: 'var(--gradient-badge)' }}
                    >
                      Add Hours
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};
