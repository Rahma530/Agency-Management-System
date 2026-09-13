import React, { useState, useMemo } from 'react';
import {
  Kanban,
  Table as TableIcon,
  PlusCircle,
  Filter,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  AlertTriangle,
  Calendar,
  Building2,
  User,
  UserCheck,
  UserX,
  ChevronRight,
  ChevronLeft,
  X,
  Sparkles,
  Layers,
  ArrowRightLeft,
  MoveRight,
  MoveLeft,
  Edit2,
  Eye,
  Timer,
  CheckSquare,
  BarChart3,
  Shield,
  Send,
  Flag,
} from 'lucide-react';
import {
  TaskRecord,
  UserRecord,
  ClientRecord,
  TaskStatus,
  TaskPriority,
  UserRole,
} from '../types/database';

interface CrossTeamTaskBoardProps {
  tasks: TaskRecord[];
  users: UserRecord[];
  clients: ClientRecord[];
  currentUser?: UserRecord;
  currentUserId?: string;
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onCreateTask: (taskData: {
    client_id: string;
    title: string;
    description: string;
    assigned_to?: string | null;
    team: string;
    status: TaskStatus;
    due_date: string;
    priority: TaskPriority;
    estimated_hours?: number | null;
    actual_hours?: number | null;
  }) => Promise<void>;
  onUpdateTask?: (taskId: string, updates: Partial<TaskRecord>) => Promise<void>;
}

export type QuickTaskFilter = 'all' | 'overdue' | 'due_soon' | 'unassigned' | 'my_tasks';
export type TaskViewMode = 'kanban' | 'table';

export const CrossTeamTaskBoard: React.FC<CrossTeamTaskBoardProps> = ({
  tasks,
  users,
  clients,
  currentUser,
  currentUserId = currentUser?.id || users[0]?.id || '',
  onUpdateTaskStatus,
  onCreateTask,
  onUpdateTask,
}) => {
  // View mode: Kanban board vs Table view
  const [viewMode, setViewMode] = useState<TaskViewMode>('kanban');

  // Filters
  const [quickFilter, setQuickFilter] = useState<QuickTaskFilter>('all');
  const [selectedTeam, setSelectedTeam] = useState<string>('all');
  const [selectedClient, setSelectedClient] = useState<string>('all');
  const [selectedPriority, setSelectedPriority] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [visibilityScope, setVisibilityScope] = useState<'all' | 'my_team' | 'my_tasks'>('all');

  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedTaskDetails, setSelectedTaskDetails] = useState<TaskRecord | null>(null);
  const [editingTask, setEditingTask] = useState<TaskRecord | null>(null);

  // New task form state
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newClientId, setNewClientId] = useState(clients[0]?.id || '');
  const [newTeam, setNewTeam] = useState('SEO');
  const [newAssignedTo, setNewAssignedTo] = useState<string>('');
  const [newDueDate, setNewDueDate] = useState(
    new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0]
  );
  const [newPriority, setNewPriority] = useState<TaskPriority>('medium');
  const [newEstimatedHours, setNewEstimatedHours] = useState<number>(8);
  const [newActualHours, setNewActualHours] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notification, setNotification] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Edit task form state
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editClientId, setEditClientId] = useState('');
  const [editTeam, setEditTeam] = useState('');
  const [editAssignedTo, setEditAssignedTo] = useState<string>('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editPriority, setEditPriority] = useState<TaskPriority>('medium');
  const [editStatus, setEditStatus] = useState<TaskStatus>('todo');
  const [editEstimatedHours, setEditEstimatedHours] = useState<number>(0);
  const [editActualHours, setEditActualHours] = useState<number>(0);
  const [isUpdating, setIsUpdating] = useState(false);

  // Operational task assignees: strictly exclude Executive Management and Head of Technical
  const isOperationalAssignee = (u: UserRecord) => {
    if (!u) return false;
    if (u.role === 'executive' || u.role === 'head_of_technical') return false;
    return true;
  };

  // Teams list
  const teams = [
    { id: 'all', label: 'All Teams' },
    { id: 'SEO', label: 'SEO' },
    { id: 'Social Media', label: 'Social Media' },
    { id: 'Media Buying', label: 'Media Buying' },
    { id: 'Creative & Design', label: 'Creative & Design' },
    { id: 'Video Production', label: 'Video Production' },
    { id: 'Account Management', label: 'Account Management' },
  ];

  // Kanban Columns configuration
  const columns: { id: TaskStatus; label: string; color: string; badgeBg: string }[] = [
    { id: 'todo', label: 'To Do', color: 'var(--grey)', badgeBg: 'rgba(168, 155, 184, 0.2)' },
    { id: 'in_progress', label: 'In Progress', color: 'var(--purple-light)', badgeBg: 'rgba(123, 47, 247, 0.25)' },
    { id: 'in_review', label: 'In Review', color: 'var(--roas-mid)', badgeBg: 'rgba(245, 226, 154, 0.2)' },
    { id: 'completed', label: 'Completed', color: 'var(--roas-good)', badgeBg: 'rgba(169, 245, 193, 0.2)' },
    { id: 'blocked', label: 'Blocked', color: 'var(--roas-bad)', badgeBg: 'rgba(245, 163, 163, 0.2)' },
  ];

  // User helper to check current employee's workload
  const getUserWorkload = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (!user) return null;
    const activeTasksCount = tasks.filter((t) => t.assigned_to === userId && t.status !== 'completed').length;
    const limit = user.capacity_limit || 8;
    const rate = Math.round((activeTasksCount / limit) * 100);
    return {
      user,
      activeTasksCount,
      limit,
      rate,
      isOver: rate >= 100,
      isNear: rate >= 75 && rate < 100,
    };
  };

  // Helper date functions
  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);
  
  const isOverdue = (task: TaskRecord) => {
    if (!task.due_date) return false;
    if (task.status === 'completed') return false;
    return task.due_date < todayStr;
  };

  const isDueSoon = (task: TaskRecord) => {
    if (!task.due_date) return false;
    if (task.status === 'completed') return false;
    const dueDate = new Date(task.due_date).getTime();
    const now = new Date(todayStr).getTime();
    const diffDays = (dueDate - now) / (1000 * 3600 * 24);
    return diffDays >= 0 && diffDays <= 3;
  };

  // 1. Check user visibility based on RLS rules
  const userVisibleTasks = useMemo(() => {
    // Under Supabase RLS, users see tasks they have permission to access.
    // If visibilityScope is toggled by user in UI:
    if (visibilityScope === 'my_tasks') {
      return tasks.filter((t) => t.assigned_to === currentUserId);
    }
    if (visibilityScope === 'my_team' && currentUser?.team) {
      return tasks.filter((t) => t.team === currentUser.team || t.assigned_to === currentUserId);
    }
    return tasks;
  }, [tasks, visibilityScope, currentUserId, currentUser]);

  // 2. DASHBOARD KPI METRICS (Exact 7 requested indicators):
  // - Total Tasks
  // - Completed
  // - In Progress
  // - Pending (To Do)
  // - Overdue
  // - Unassigned
  // - Capacity utilization
  const totalTasksCount = userVisibleTasks.length;
  const completedTasksCount = userVisibleTasks.filter((t) => t.status === 'completed').length;
  const inProgressTasksCount = userVisibleTasks.filter((t) => t.status === 'in_progress').length;
  const pendingTasksCount = userVisibleTasks.filter((t) => t.status === 'todo').length;
  const overdueTasksCount = userVisibleTasks.filter(isOverdue).length;
  const unassignedTasksCount = userVisibleTasks.filter((t) => !t.assigned_to).length;

  // Capacity utilization based on active operational users
  const capacityUtilization = useMemo(() => {
    const operational = users.filter((u) => u.capacity_limit && u.capacity_limit > 0);
    const totalLimits = operational.reduce((acc, u) => acc + (u.capacity_limit || 8), 0);
    const activeTasksAssigned = tasks.filter((t) => t.status !== 'completed' && t.assigned_to).length;
    return totalLimits > 0 ? Math.round((activeTasksAssigned / totalLimits) * 100) : 0;
  }, [users, tasks]);

  // 3. Filtered Tasks for Kanban / Table display
  const filteredTasks = useMemo(() => {
    return userVisibleTasks.filter((t) => {
      // Quick filter
      if (quickFilter === 'overdue' && !isOverdue(t)) return false;
      if (quickFilter === 'due_soon' && !isDueSoon(t)) return false;
      if (quickFilter === 'unassigned' && t.assigned_to) return false;
      if (quickFilter === 'my_tasks' && t.assigned_to !== currentUserId) return false;

      // Team filter
      if (selectedTeam !== 'all' && t.team !== selectedTeam) return false;

      // Client filter
      if (selectedClient !== 'all' && t.client_id !== selectedClient) return false;

      // Priority filter
      if (selectedPriority !== 'all' && t.priority !== selectedPriority) return false;

      // Status filter
      if (selectedStatus !== 'all' && t.status !== selectedStatus) return false;

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const client = clients.find((c) => c.id === t.client_id);
        const assignee = users.find((u) => u.id === t.assigned_to);
        const matchTitle = t.title.toLowerCase().includes(query);
        const matchDesc = t.description ? t.description.toLowerCase().includes(query) : false;
        const matchClient = client ? client.name.toLowerCase().includes(query) : false;
        const matchAssignee = assignee ? assignee.name.toLowerCase().includes(query) : false;
        if (!matchTitle && !matchDesc && !matchClient && !matchAssignee) {
          return false;
        }
      }

      return true;
    });
  }, [
    userVisibleTasks,
    quickFilter,
    selectedTeam,
    selectedClient,
    selectedPriority,
    selectedStatus,
    searchQuery,
    clients,
    users,
    currentUserId,
    todayStr,
  ]);

  // Handlers
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newClientId) return;

    setIsSubmitting(true);
    try {
      await onCreateTask({
        client_id: newClientId,
        title: newTitle.trim(),
        description: newDescription.trim(),
        assigned_to: newAssignedTo ? newAssignedTo : null,
        team: newTeam,
        status: 'todo',
        due_date: newDueDate,
        priority: newPriority,
        estimated_hours: newEstimatedHours,
        actual_hours: newActualHours,
      });

      setIsCreateModalOpen(false);
      setNewTitle('');
      setNewDescription('');
      setNewEstimatedHours(8);
      setNewActualHours(0);
      setNotification({ text: 'Task created and assigned successfully.', type: 'success' });
      setTimeout(() => setNotification(null), 3500);
    } catch (err: any) {
      console.error(err);
      setNotification({ text: 'Failed to create task under available permissions.', type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (task: TaskRecord) => {
    setEditingTask(task);
    setEditTitle(task.title);
    setEditDescription(task.description || '');
    setEditClientId(task.client_id);
    setEditTeam(task.team || 'SEO');
    setEditAssignedTo(task.assigned_to || '');
    setEditDueDate(task.due_date || '');
    setEditPriority(task.priority);
    setEditStatus(task.status);
    setEditEstimatedHours(task.estimated_hours || 0);
    setEditActualHours(task.actual_hours || 0);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !onUpdateTask) return;

    setIsUpdating(true);
    try {
      await onUpdateTask(editingTask.id, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        client_id: editClientId,
        team: editTeam,
        assigned_to: editAssignedTo ? editAssignedTo : null,
        due_date: editDueDate,
        priority: editPriority,
        status: editStatus,
        estimated_hours: editEstimatedHours,
        actual_hours: editActualHours,
      });

      // Update selected details if open
      if (selectedTaskDetails && selectedTaskDetails.id === editingTask.id) {
        setSelectedTaskDetails({
          ...selectedTaskDetails,
          title: editTitle.trim(),
          description: editDescription.trim(),
          client_id: editClientId,
          team: editTeam,
          assigned_to: editAssignedTo ? editAssignedTo : null,
          due_date: editDueDate,
          priority: editPriority,
          status: editStatus,
          estimated_hours: editEstimatedHours,
          actual_hours: editActualHours,
        });
      }

      setEditingTask(null);
      setNotification({ text: 'Task details updated successfully.', type: 'success' });
      setTimeout(() => setNotification(null), 3500);
    } catch (err) {
      console.error(err);
      setNotification({ text: 'Error updating task.', type: 'error' });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleMoveStatus = async (taskId: string, targetStatus: TaskStatus) => {
    try {
      await onUpdateTaskStatus(taskId, targetStatus);
      if (selectedTaskDetails && selectedTaskDetails.id === taskId) {
        setSelectedTaskDetails({ ...selectedTaskDetails, status: targetStatus });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Priority helper
  const getPriorityBadge = (priority: TaskPriority) => {
    switch (priority) {
      case 'urgent':
        return { label: 'Urgent', bg: 'rgba(245, 163, 163, 0.25)', text: 'var(--roas-bad)', border: 'rgba(245, 163, 163, 0.4)' };
      case 'high':
        return { label: 'High', bg: 'rgba(235, 94, 40, 0.2)', text: '#fb923c', border: 'rgba(235, 94, 40, 0.3)' };
      case 'medium':
        return { label: 'Medium', bg: 'rgba(245, 226, 154, 0.2)', text: 'var(--roas-mid)', border: 'rgba(245, 226, 154, 0.3)' };
      case 'low':
        return { label: 'Low', bg: 'rgba(168, 155, 184, 0.2)', text: 'var(--grey)', border: 'rgba(168, 155, 184, 0.3)' };
      default:
        return { label: priority, bg: 'rgba(255, 255, 255, 0.1)', text: 'var(--white)', border: 'transparent' };
    }
  };

  // Team badge helper
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
    <div className="space-y-6">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`p-3.5 rounded-xl text-xs flex items-center justify-between gap-3 shadow-lg transition-all ${
            notification.type === 'success'
              ? 'bg-[rgba(169,245,193,0.15)] border border-[var(--roas-good)] text-[var(--roas-good)]'
              : 'bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="font-semibold">{notification.text}</span>
          </div>
          <button onClick={() => setNotification(null)} className="text-xs opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* DASHBOARD SUMMARY KPI CARDS (The 7 requested metrics) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        {/* 1. Total Tasks */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">Total Tasks</span>
            <Kanban className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-white">{totalTasksCount}</p>
            <p className="text-[10px] text-stone-400 mt-0.5">In accessible scope</p>
          </div>
        </div>

        {/* 2. Completed */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">Completed</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-emerald-400">{completedTasksCount}</p>
            <p className="text-[10px] text-stone-400 mt-0.5">Finished and approved</p>
          </div>
        </div>

        {/* 3. In Progress */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">In Progress</span>
            <Timer className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-purple-300">{inProgressTasksCount}</p>
            <p className="text-[10px] text-stone-400 mt-0.5">Currently active</p>
          </div>
        </div>

        {/* 4. Pending (To Do) */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">Pending</span>
            <Clock className="w-3.5 h-3.5 text-stone-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-stone-300">{pendingTasksCount}</p>
            <p className="text-[10px] text-stone-400 mt-0.5">Awaiting start</p>
          </div>
        </div>

        {/* 5. Overdue */}
        <div
          className={`p-3.5 rounded-[16px] flex flex-col justify-between transition-all ${
            overdueTasksCount > 0 ? 'ring-1 ring-red-500/40' : ''
          }`}
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">Overdue</span>
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-red-400">{overdueTasksCount}</p>
            <p className="text-[10px] text-red-400/80 mt-0.5">Past deadline</p>
          </div>
        </div>

        {/* 6. Unassigned */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">Unassigned</span>
            <UserX className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-amber-400">{unassignedTasksCount}</p>
            <p className="text-[10px] text-stone-400 mt-0.5">Requires assignee</p>
          </div>
        </div>

        {/* 7. Capacity Utilization */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between text-stone-400">
            <span className="text-[11px] font-semibold">Capacity</span>
            <BarChart3 className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold text-purple-300">{capacityUtilization}%</p>
            <p className="text-[10px] text-stone-400 mt-0.5">Operational load</p>
          </div>
        </div>
      </div>

      {/* CONTROL & FILTER BAR */}
      <div
        className="p-4 rounded-[18px] space-y-4"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* View Mode (Kanban vs Table) and Visibility Scope */}
          <div className="flex flex-wrap items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-stone-900/80 border border-stone-800">
              <button
                onClick={() => setViewMode('kanban')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  viewMode === 'kanban'
                    ? 'bg-purple-600/30 text-white border border-purple-500/50'
                    : 'text-stone-400 hover:text-white'
                }`}
              >
                <Kanban className="w-3.5 h-3.5" />
                <span>Kanban Board</span>
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  viewMode === 'table'
                    ? 'bg-purple-600/30 text-white border border-purple-500/50'
                    : 'text-stone-400 hover:text-white'
                }`}
              >
                <TableIcon className="w-3.5 h-3.5" />
                <span>Task List</span>
              </button>
            </div>

            {/* Scope Toggle for RLS permissions demonstration */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-stone-900/80 border border-stone-800 text-xs">
              <span className="text-[11px] text-stone-400 px-1.5">Scope:</span>
              <button
                onClick={() => setVisibilityScope('all')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  visibilityScope === 'all'
                    ? 'bg-stone-800 text-white'
                    : 'text-stone-400 hover:text-white'
                }`}
              >
                All Available
              </button>
              <button
                onClick={() => setVisibilityScope('my_team')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  visibilityScope === 'my_team'
                    ? 'bg-stone-800 text-white'
                    : 'text-stone-400 hover:text-white'
                }`}
              >
                My Team
              </button>
              <button
                onClick={() => setVisibilityScope('my_tasks')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  visibilityScope === 'my_tasks'
                    ? 'bg-stone-800 text-white'
                    : 'text-stone-400 hover:text-white'
                }`}
              >
                My Tasks
              </button>
            </div>
          </div>

          {/* Create Task Button */}
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white transition-all shadow-md hover:opacity-90 active:scale-98 shrink-0"
            style={{
              background: 'var(--gradient-badge)',
              border: '1px solid var(--border-strong)',
            }}
          >
            <PlusCircle className="w-4 h-4 text-purple-200" />
            <span>New Task</span>
          </button>
        </div>

        {/* Quick Filter Pills Row */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-stone-800/60">
          <span className="text-xs text-stone-400 ml-2 font-semibold">Quick Filter:</span>
          
          <button
            onClick={() => setQuickFilter('all')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
              quickFilter === 'all'
                ? 'bg-purple-600/30 text-white border border-purple-500/40'
                : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            All ({userVisibleTasks.length})
          </button>

          <button
            onClick={() => setQuickFilter('overdue')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
              quickFilter === 'overdue'
                ? 'bg-red-950/60 text-red-400 border border-red-500/50'
                : 'bg-stone-900/60 text-stone-400 hover:text-red-400 border border-stone-800'
            }`}
          >
            <AlertTriangle className="w-3 h-3 text-red-400" />
            <span>Overdue ({overdueTasksCount})</span>
          </button>

          <button
            onClick={() => setQuickFilter('due_soon')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
              quickFilter === 'due_soon'
                ? 'bg-amber-950/60 text-amber-400 border border-amber-500/50'
                : 'bg-stone-900/60 text-stone-400 hover:text-amber-400 border border-stone-800'
            }`}
          >
            <Clock className="w-3 h-3 text-amber-400" />
            <span>Due Soon</span>
          </button>

          <button
            onClick={() => setQuickFilter('unassigned')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
              quickFilter === 'unassigned'
                ? 'bg-yellow-950/60 text-yellow-400 border border-yellow-500/50'
                : 'bg-stone-900/60 text-stone-400 hover:text-yellow-400 border border-stone-800'
            }`}
          >
            <UserX className="w-3 h-3 text-yellow-400" />
            <span>Unassigned ({unassignedTasksCount})</span>
          </button>

          <button
            onClick={() => setQuickFilter('my_tasks')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
              quickFilter === 'my_tasks'
                ? 'bg-purple-950/60 text-purple-300 border border-purple-500/50'
                : 'bg-stone-900/60 text-stone-400 hover:text-purple-300 border border-stone-800'
            }`}
          >
            <UserCheck className="w-3 h-3 text-purple-400" />
            <span>Assigned to Me</span>
          </button>
        </div>

        {/* Detailed Dropdowns Filter Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 pt-2">
          {/* Team Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Team:</label>
            <select
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id} className="bg-stone-900 text-white">
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Client Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Client:</label>
            <select
              value={selectedClient}
              onChange={(e) => setSelectedClient(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="all" className="bg-stone-900 text-white">All Clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id} className="bg-stone-900 text-white">
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Priority Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Priority:</label>
            <select
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="all" className="bg-stone-900 text-white">All Priorities</option>
              <option value="urgent" className="bg-stone-900 text-white">Urgent</option>
              <option value="high" className="bg-stone-900 text-white">High</option>
              <option value="medium" className="bg-stone-900 text-white">Medium</option>
              <option value="low" className="bg-stone-900 text-white">Low</option>
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Status:</label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="all" className="bg-stone-900 text-white">All Statuses</option>
              <option value="todo" className="bg-stone-900 text-white">To Do</option>
              <option value="in_progress" className="bg-stone-900 text-white">In Progress</option>
              <option value="in_review" className="bg-stone-900 text-white">In Review</option>
              <option value="completed" className="bg-stone-900 text-white">Completed</option>
              <option value="blocked" className="bg-stone-900 text-white">Blocked</option>
            </select>
          </div>

          {/* Search Input */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Search:</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-stone-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks, clients, team members..."
                className="w-full pr-8 pl-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* VIEW 1: KANBAN BOARD */}
      {viewMode === 'kanban' && (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 items-start">
          {columns.map((column) => {
            const columnTasks = filteredTasks.filter((t) => t.status === column.id);

            return (
              <div
                key={column.id}
                className="rounded-[18px] p-3 flex flex-col gap-3 min-h-[500px]"
                style={{
                  background: 'rgba(21, 19, 24, 0.65)',
                  border: '1px solid var(--border-soft)',
                }}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between pb-2 border-b border-stone-800">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: column.color }} />
                    <h4 className="text-xs font-bold text-white">{column.label}</h4>
                  </div>
                  <span
                    className="px-2 py-0.5 rounded-full text-[11px] font-bold"
                    style={{ background: column.badgeBg, color: column.color }}
                  >
                    {columnTasks.length}
                  </span>
                </div>

                {/* Column Task Cards */}
                <div className="space-y-3 flex-1 overflow-y-auto max-h-[750px] pr-0.5">
                  {columnTasks.length === 0 ? (
                    <div className="p-6 text-center text-stone-500 text-xs border border-dashed border-stone-800/80 rounded-xl">
                      No tasks in this stage
                    </div>
                  ) : (
                    columnTasks.map((task) => {
                      const client = clients.find((c) => c.id === task.client_id);
                      const assignee = users.find((u) => u.id === task.assigned_to);
                      const priority = getPriorityBadge(task.priority);
                      const teamColor = getTeamColor(task.team);
                      const overdue = isOverdue(task);
                      const dueSoon = isDueSoon(task);

                      return (
                        <div
                          key={task.id}
                          className="p-3.5 rounded-xl cursor-pointer hover:border-purple-500/50 transition-all group relative space-y-2.5 shadow-md"
                          style={{
                            background: 'var(--gradient-card)',
                            border: `1px solid ${overdue ? 'rgba(245, 163, 163, 0.4)' : 'var(--border-medium)'}`,
                          }}
                          onClick={() => setSelectedTaskDetails(task)}
                        >
                          {/* Top Badges: Team & Priority */}
                          <div className="flex items-center justify-between gap-1">
                            <span
                              className="px-2 py-0.5 rounded-md text-[10px] font-bold"
                              style={{ background: teamColor.bg, color: teamColor.text }}
                            >
                              {task.team || 'General'}
                            </span>

                            <div className="flex items-center gap-1.5">
                              {overdue && (
                                <span
                                  className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950/80 text-red-400 border border-red-500/40 animate-pulse flex items-center gap-1"
                                  title="Task is overdue"
                                >
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  <span>Overdue</span>
                                </span>
                              )}
                              {!overdue && dueSoon && (
                                <span
                                  className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-500/40"
                                  title="Due soon"
                                >
                                  Due Soon
                                </span>
                              )}
                              <span
                                className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{
                                  background: priority.bg,
                                  color: priority.text,
                                  border: `1px solid ${priority.border}`,
                                }}
                              >
                                {priority.label}
                              </span>
                            </div>
                          </div>

                          {/* Task Title */}
                          <h5 className="text-xs font-bold text-white line-clamp-2 leading-snug group-hover:text-purple-300 transition-colors">
                            {task.title}
                          </h5>

                          {/* Associated Client */}
                          <div className="flex items-center gap-1.5 text-[11px] text-stone-400">
                            <Building2 className="w-3 h-3 text-purple-400 shrink-0" />
                            <span className="truncate">{client ? client.name : 'Unassigned Client'}</span>
                          </div>

                          {/* Hours Info: Estimated vs Actual */}
                          {(task.estimated_hours || task.actual_hours !== undefined) && (
                            <div className="flex items-center justify-between text-[10px] text-stone-400 bg-stone-900/60 px-2 py-1 rounded-md border border-stone-800">
                              <span className="flex items-center gap-1">
                                <Timer className="w-3 h-3 text-purple-300" />
                                <span>Est: {task.estimated_hours || 0}h</span>
                              </span>
                              <span>Act: {task.actual_hours || 0}h</span>
                            </div>
                          )}

                          {/* Assignee & Due Date Footer */}
                          <div className="flex items-center justify-between pt-1 border-t border-stone-800/80 text-[11px]">
                            {/* Assignee Badge */}
                            {assignee ? (
                              <div className="flex items-center gap-1.5" title={assignee.name}>
                                <div
                                  className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[9px]"
                                  style={{ background: 'var(--gradient-badge)', color: 'white' }}
                                >
                                  {assignee.name.charAt(0)}
                                </div>
                                <span className="text-stone-300 text-[11px] truncate max-w-[80px]">
                                  {assignee.name.split(' ')[0]}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[10px] text-amber-400 flex items-center gap-1 font-semibold">
                                <UserX className="w-3 h-3" />
                                <span>Unassigned</span>
                              </span>
                            )}

                            {/* Due Date */}
                            {task.due_date && (
                              <div
                                className={`flex items-center gap-1 text-[10px] font-mono ${
                                  overdue ? 'text-red-400 font-bold' : 'text-stone-400'
                                }`}
                              >
                                <Calendar className="w-3 h-3" />
                                <span>{task.due_date}</span>
                              </div>
                            )}
                          </div>

                          {/* Quick Advance Status Arrow Buttons */}
                          <div
                            className="pt-1.5 flex items-center justify-between border-t border-stone-800/50"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="text-[10px] text-stone-500">Stage:</span>
                            <div className="flex items-center gap-1">
                              {column.id !== 'todo' && (
                                <button
                                  onClick={() => {
                                    const prevIdx = columns.findIndex((c) => c.id === column.id) - 1;
                                    if (prevIdx >= 0) handleMoveStatus(task.id, columns[prevIdx].id);
                                  }}
                                  className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white transition-colors"
                                  title="Previous Stage"
                                >
                                  <ChevronLeft className="w-3 h-3" />
                                </button>
                              )}
                              {column.id !== 'completed' && (
                                <button
                                  onClick={() => {
                                    const nextIdx = columns.findIndex((c) => c.id === column.id) + 1;
                                    if (nextIdx < columns.length) handleMoveStatus(task.id, columns[nextIdx].id);
                                  }}
                                  className="p-1 rounded bg-stone-900 text-purple-300 hover:text-white hover:bg-purple-900/60 transition-colors"
                                  title="Next Stage"
                                >
                                  <ChevronRight className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                onClick={() => openEditModal(task)}
                                className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white ml-1"
                                title="Edit Task"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* VIEW 2: TABLE / LIST VIEW */}
      {viewMode === 'table' && (
        <div
          className="rounded-[18px] overflow-hidden border border-stone-800"
          style={{ background: 'var(--gradient-card)' }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-900/90 text-stone-300 border-b border-stone-800">
                <tr>
                  <th className="p-3.5">Task</th>
                  <th className="p-3.5">Client</th>
                  <th className="p-3.5">Assignee</th>
                  <th className="p-3.5">Team</th>
                  <th className="p-3.5 text-center">Priority</th>
                  <th className="p-3.5 text-center">Status</th>
                  <th className="p-3.5 text-center">Due Date</th>
                  <th className="p-3.5 text-center">Est. Hours</th>
                  <th className="p-3.5 text-center">Act. Hours</th>
                  <th className="p-3.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {filteredTasks.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-stone-400">
                      No tasks matching current filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredTasks.map((task) => {
                    const client = clients.find((c) => c.id === task.client_id);
                    const assignee = users.find((u) => u.id === task.assigned_to);
                    const priority = getPriorityBadge(task.priority);
                    const teamColor = getTeamColor(task.team);
                    const colInfo = columns.find((c) => c.id === task.status);
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
                          {assignee ? (
                            <div className="flex items-center gap-1.5">
                              <div
                                className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[9px]"
                                style={{ background: 'var(--gradient-badge)', color: 'white' }}
                              >
                                {assignee.name.charAt(0)}
                              </div>
                              <span className="text-stone-200">{assignee.name}</span>
                            </div>
                          ) : (
                            <span className="text-amber-400 text-[11px] font-semibold flex items-center gap-1">
                              <UserX className="w-3 h-3" />
                              <span>Unassigned</span>
                            </span>
                          )}
                        </td>
                        <td className="p-3.5">
                          <span
                            className="px-2 py-0.5 rounded text-[10px] font-bold"
                            style={{ background: teamColor.bg, color: teamColor.text }}
                          >
                            {task.team || 'General'}
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
                        <td className="p-3.5 text-center">
                          <span
                            className="px-2.5 py-0.5 rounded-full text-[10px] font-bold inline-block"
                            style={{ background: colInfo?.badgeBg, color: colInfo?.color }}
                          >
                            {colInfo?.label.split(' ')[0]}
                          </span>
                        </td>
                        <td className="p-3.5 text-center font-mono">
                          <span className={overdue ? 'text-red-400 font-bold' : 'text-stone-300'}>
                            {task.due_date || '—'}
                          </span>
                          {overdue && (
                            <span className="block text-[9px] text-red-400 font-sans font-bold">
                              Overdue!
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-center font-bold text-purple-300">
                          {task.estimated_hours ? `${task.estimated_hours}h` : '—'}
                        </td>
                        <td className="p-3.5 text-center font-bold text-emerald-400">
                          {task.actual_hours !== undefined && task.actual_hours !== null
                            ? `${task.actual_hours}h`
                            : '—'}
                        </td>
                        <td className="p-3.5 text-center" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => setSelectedTaskDetails(task)}
                              className="p-1.5 rounded-lg bg-stone-800 text-stone-300 hover:text-white"
                              title="View Details"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => openEditModal(task)}
                              className="p-1.5 rounded-lg bg-stone-800 text-stone-300 hover:text-purple-300"
                              title="Edit Task"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
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
      )}

      {/* MODAL 1: TASK DETAILS VIEW */}
      {selectedTaskDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-xl rounded-[22px] p-6 space-y-4 shadow-2xl relative"
            style={{
              background: 'var(--gradient-hero)',
              border: '1px solid var(--border-medium)',
            }}
          >
            <div className="flex items-start justify-between border-b border-stone-800 pb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      background: getTeamColor(selectedTaskDetails.team).bg,
                      color: getTeamColor(selectedTaskDetails.team).text,
                    }}
                  >
                    {selectedTaskDetails.team || 'General'}
                  </span>
                  <span
                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{
                      background: getPriorityBadge(selectedTaskDetails.priority).bg,
                      color: getPriorityBadge(selectedTaskDetails.priority).text,
                    }}
                  >
                    {getPriorityBadge(selectedTaskDetails.priority).label}
                  </span>
                  {isOverdue(selectedTaskDetails) && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-950 text-red-400 border border-red-500/40">
                      Overdue
                    </span>
                  )}
                </div>
                <h3 className="text-base font-bold text-white">{selectedTaskDetails.title}</h3>
              </div>
              <button
                onClick={() => setSelectedTaskDetails(null)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Task Details Content */}
            <div className="space-y-4">
              {/* Description */}
              <div>
                <label className="text-[11px] font-semibold text-stone-400 block mb-1">Description & Deliverables:</label>
                <div className="p-3 rounded-xl bg-stone-900/80 border border-stone-800 text-xs text-stone-200 leading-relaxed">
                  {selectedTaskDetails.description || 'No detailed description provided.'}
                </div>
              </div>

              {/* Client & Assignee */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
                  <label className="text-[10px] text-stone-400 block mb-1">Client:</label>
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-purple-400" />
                    <span className="text-xs font-bold text-white">
                      {clients.find((c) => c.id === selectedTaskDetails.client_id)?.name || 'Unassigned'}
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
                  <label className="text-[10px] text-stone-400 block mb-1">Assignee:</label>
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-purple-400" />
                    <span className="text-xs font-bold text-white">
                      {users.find((u) => u.id === selectedTaskDetails.assigned_to)?.name || (
                        <span className="text-amber-400 font-semibold">Unassigned</span>
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/* Hours Tracking & Due Date */}
              <div className="grid grid-cols-3 gap-3 p-3 rounded-xl bg-stone-900/60 border border-stone-800 text-center">
                <div>
                  <p className="text-[10px] text-stone-400">Estimated Hours</p>
                  <p className="text-sm font-bold text-purple-300 mt-0.5">
                    {selectedTaskDetails.estimated_hours || 0} hrs
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-stone-400">Actual Hours</p>
                  <p className="text-sm font-bold text-emerald-400 mt-0.5">
                    {selectedTaskDetails.actual_hours || 0} hrs
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-stone-400">Due Date</p>
                  <p
                    className={`text-sm font-bold mt-0.5 font-mono ${
                      isOverdue(selectedTaskDetails) ? 'text-red-400' : 'text-stone-300'
                    }`}
                  >
                    {selectedTaskDetails.due_date || 'None'}
                  </p>
                </div>
              </div>

              {/* Move Status directly from details */}
              <div>
                <label className="text-[11px] font-semibold text-stone-400 block mb-1.5">
                  Update Status:
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {columns.map((col) => (
                    <button
                      key={col.id}
                      onClick={() => handleMoveStatus(selectedTaskDetails.id, col.id)}
                      className={`px-2 py-1.5 rounded-lg text-[11px] font-bold transition-all text-center ${
                        selectedTaskDetails.status === col.id
                          ? 'ring-1 ring-purple-400 shadow-md text-white'
                          : 'bg-stone-900/80 text-stone-400 hover:text-white border border-stone-800'
                      }`}
                      style={{
                        background:
                          selectedTaskDetails.status === col.id ? col.badgeBg : undefined,
                        color: selectedTaskDetails.status === col.id ? col.color : undefined,
                      }}
                    >
                      {col.label.split(' ')[0]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="pt-3 border-t border-stone-800 flex items-center justify-between">
              <button
                onClick={() => {
                  const taskToEdit = selectedTaskDetails;
                  setSelectedTaskDetails(null);
                  openEditModal(taskToEdit);
                }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-stone-200 bg-stone-800 hover:bg-stone-700 flex items-center gap-1.5"
              >
                <Edit2 className="w-3.5 h-3.5" />
                <span>Edit Task</span>
              </button>

              <button
                onClick={() => setSelectedTaskDetails(null)}
                className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: CREATE NEW TASK */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-lg rounded-[22px] p-6 space-y-4 shadow-2xl relative"
            style={{
              background: 'var(--gradient-hero)',
              border: '1px solid var(--border-medium)',
            }}
          >
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-purple-400" />
                <span>Create New Task</span>
              </h3>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-3.5">
              {/* Client Selection */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Client:
                </label>
                <select
                  value={newClientId}
                  onChange={(e) => setNewClientId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  required
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id} className="bg-stone-900 text-white">
                      {c.name} ({c.industry || 'Client'})
                    </option>
                  ))}
                </select>
              </div>

              {/* Task Title */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Task Title:
                </label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g., SEO Technical Audit or Campaign Launch"
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  required
                />
              </div>

              {/* Task Description */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Description & Deliverables:
                </label>
                <textarea
                  rows={3}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Provide technical specifications and deliverables..."
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500 resize-none"
                />
              </div>

              {/* Team and Assignee with Live Capacity Check */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Team:
                  </label>
                  <select
                    value={newTeam}
                    onChange={(e) => setNewTeam(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="SEO" className="bg-stone-900 text-white">SEO</option>
                    <option value="Social Media" className="bg-stone-900 text-white">Social Media</option>
                    <option value="Media Buying" className="bg-stone-900 text-white">Media Buying</option>
                    <option value="Creative & Design" className="bg-stone-900 text-white">Creative & Design</option>
                    <option value="Video Production" className="bg-stone-900 text-white">Video Production</option>
                    <option value="Account Management" className="bg-stone-900 text-white">Account Management</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Assignee (Operational Only):
                  </label>
                  <select
                    value={newAssignedTo}
                    onChange={(e) => setNewAssignedTo(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="" className="bg-stone-900 text-amber-400">
                      -- Unassigned --
                    </option>
                    {users
                      .filter(isOperationalAssignee)
                      .map((u) => {
                        const workload = getUserWorkload(u.id);
                        const statusNote = workload
                          ? workload.isOver
                            ? '🔴 Full'
                            : workload.isNear
                            ? '🟡 High'
                            : '🟢 Available'
                          : '';
                        return (
                          <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                            {u.name} ({u.team || u.role}) {statusNote}
                          </option>
                        );
                      })}
                  </select>
                </div>
              </div>

              {/* Priority & Due Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Priority:
                  </label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="urgent" className="bg-stone-900 text-red-400">Urgent</option>
                    <option value="high" className="bg-stone-900 text-orange-400">High</option>
                    <option value="medium" className="bg-stone-900 text-yellow-400">Medium</option>
                    <option value="low" className="bg-stone-900 text-stone-400">Low</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Due Date:
                  </label>
                  <input
                    type="date"
                    value={newDueDate}
                    onChange={(e) => setNewDueDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                    required
                  />
                </div>
              </div>

              {/* Estimated & Actual Hours */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Estimated Hours:
                  </label>
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={newEstimatedHours}
                    onChange={(e) => setNewEstimatedHours(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Actual Hours (if any):
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={newActualHours}
                    onChange={(e) => setNewActualHours(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              {/* Submit Buttons */}
              <div className="pt-3 border-t border-stone-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-lg transition-all"
                  style={{ background: 'var(--gradient-badge)' }}
                >
                  {isSubmitting ? 'Creating...' : 'Create Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: EDIT EXISTING TASK */}
      {editingTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-lg rounded-[22px] p-6 space-y-4 shadow-2xl relative"
            style={{
              background: 'var(--gradient-hero)',
              border: '1px solid var(--border-medium)',
            }}
          >
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Edit2 className="w-5 h-5 text-purple-400" />
                <span>Edit Task</span>
              </h3>
              <button
                onClick={() => setEditingTask(null)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="space-y-3.5">
              {/* Task Title */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Task Title:
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  required
                />
              </div>

              {/* Task Description */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Description & Deliverables:
                </label>
                <textarea
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500 resize-none"
                />
              </div>

              {/* Client and Team */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Client:
                  </label>
                  <select
                    value={editClientId}
                    onChange={(e) => setEditClientId(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    {clients.map((c) => (
                      <option key={c.id} value={c.id} className="bg-stone-900 text-white">
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Team:
                  </label>
                  <select
                    value={editTeam}
                    onChange={(e) => setEditTeam(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="SEO" className="bg-stone-900 text-white">SEO</option>
                    <option value="Social Media" className="bg-stone-900 text-white">Social Media</option>
                    <option value="Media Buying" className="bg-stone-900 text-white">Media Buying</option>
                    <option value="Creative & Design" className="bg-stone-900 text-white">Creative & Design</option>
                    <option value="Video Production" className="bg-stone-900 text-white">Video Production</option>
                    <option value="Account Management" className="bg-stone-900 text-white">Account Management</option>
                  </select>
                </div>
              </div>

              {/* Assignee & Status */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Assignee (Operational Only):
                  </label>
                  <select
                    value={editAssignedTo}
                    onChange={(e) => setEditAssignedTo(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="" className="bg-stone-900 text-amber-400">
                      -- Unassigned --
                    </option>
                    {users
                      .filter(isOperationalAssignee)
                      .map((u) => {
                        const workload = getUserWorkload(u.id);
                        return (
                          <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                            {u.name} ({u.team || u.role}) {workload?.isOver ? '🔴 Full' : '🟢 Available'}
                          </option>
                        );
                      })}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Stage:
                  </label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as TaskStatus)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="todo" className="bg-stone-900 text-white">To Do</option>
                    <option value="in_progress" className="bg-stone-900 text-white">In Progress</option>
                    <option value="in_review" className="bg-stone-900 text-white">In Review</option>
                    <option value="completed" className="bg-stone-900 text-white">Completed</option>
                    <option value="blocked" className="bg-stone-900 text-white">Blocked</option>
                  </select>
                </div>
              </div>

              {/* Priority & Due Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Priority:
                  </label>
                  <select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value as TaskPriority)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="urgent" className="bg-stone-900 text-red-400">Urgent</option>
                    <option value="high" className="bg-stone-900 text-orange-400">High</option>
                    <option value="medium" className="bg-stone-900 text-yellow-400">Medium</option>
                    <option value="low" className="bg-stone-900 text-stone-400">Low</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Due Date:
                  </label>
                  <input
                    type="date"
                    value={editDueDate}
                    onChange={(e) => setEditDueDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              {/* Hours: Estimated vs Actual */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Estimated Hours:
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={editEstimatedHours}
                    onChange={(e) => setEditEstimatedHours(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Actual Hours:
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={editActualHours}
                    onChange={(e) => setEditActualHours(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              {/* Submit Buttons */}
              <div className="pt-3 border-t border-stone-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTask(null)}
                  className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdating}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-lg transition-all"
                  style={{ background: 'var(--gradient-badge)' }}
                >
                  {isUpdating ? 'Saving...' : 'Update Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
