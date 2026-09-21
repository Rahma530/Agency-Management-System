import React, { useState, useMemo, useEffect } from 'react';
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
  Link2,
} from 'lucide-react';
import {
  TaskRecord,
  UserRecord,
  ClientRecord,
  TaskStatus,
  TaskPriority,
  TaskCommentRecord,
  TaskAttachmentRecord,
} from '../types/database';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { getUserCapacityData, getCapacityIndicator } from '../lib/capacity';
import { isActiveEmployee } from '../lib/permissions';
import { getAllowedEmployeeRolesUnderRLS } from '../lib/supabase';
import { OPERATIONAL_TEAMS, fetchAssignableEmployees } from '../lib/departmentStaffing';
import type { AssignableEmployee } from '../lib/departmentStaffing';
import { TEAM_LEAD_TO_AGENT_ROLE } from '../data/roles';
import { SubtaskList } from './SubtaskList';
import { TaskCommentThread } from './TaskCommentThread';
import { TaskAttachmentList } from './TaskAttachmentList';
import { TaskCalendarView } from './TaskCalendarView';
import { KanbanColumn } from './KanbanColumn';
import { KanbanTaskCardContent } from './KanbanTaskCard';

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
    parent_task_id?: string | null;
  }) => Promise<void>;
  onUpdateTask?: (taskId: string, updates: Partial<TaskRecord>) => Promise<void>;
  // Pre-fills the search box (matches by assignee name) when arriving here via
  // the "Assign via Task Board" link from CapacityManagement's employee cards.
  initialAssigneeFilter?: string;
  taskComments?: TaskCommentRecord[];
  onAddTaskComment?: (taskId: string, body: string, parentCommentId?: string | null) => Promise<void>;
  onEditTaskComment?: (commentId: string, body: string) => Promise<void>;
  onDeleteTaskComment?: (commentId: string) => Promise<void>;
  taskAttachments?: TaskAttachmentRecord[];
  onUploadTaskAttachment?: (taskId: string, file: File) => Promise<void>;
  onDeleteTaskAttachment?: (attachmentId: string) => Promise<void>;
}

export type QuickTaskFilter = 'all' | 'overdue' | 'due_soon' | 'unassigned' | 'my_tasks';
export type TaskViewMode = 'kanban' | 'table' | 'timeline';

export const CrossTeamTaskBoard: React.FC<CrossTeamTaskBoardProps> = ({
  tasks,
  users,
  clients,
  currentUser,
  currentUserId = currentUser?.id || users[0]?.id || '',
  onUpdateTaskStatus,
  onCreateTask,
  onUpdateTask,
  initialAssigneeFilter,
  taskComments = [],
  onAddTaskComment,
  onEditTaskComment,
  onDeleteTaskComment,
  taskAttachments = [],
  onUploadTaskAttachment,
  onDeleteTaskAttachment,
}) => {
  // View mode: Kanban board vs Table view
  const [viewMode, setViewMode] = useState<TaskViewMode>('kanban');

  // Filters
  const [quickFilter, setQuickFilter] = useState<QuickTaskFilter>('all');
  // marketing_manager lands pre-filtered to "Creative" — the only team value task_visible() ever
  // hands them anyway, so arriving at "All Teams" would show the exact same rows with an extra
  // click required to get there.
  const [selectedTeam, setSelectedTeam] = useState<string>(
    currentUser?.role === 'marketing_manager' ? 'Creative' : 'all'
  );
  const [selectedClient, setSelectedClient] = useState<string>('all');
  const [selectedPriority, setSelectedPriority] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  // Employee-name filter: a discrete "view exactly what one person is working on" picker,
  // separate from the free-text search box above. Its option list is role-scoped (see
  // assigneeFilterOptions below) so a viewer can only ever select someone whose tasks
  // task_visible()/isTaskAccessibleUnderRLS already lets them see.
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string>('all');

  // Pre-fill the assignee search when navigated here from a specific
  // employee's "Assign via Task Board" link.
  React.useEffect(() => {
    if (initialAssigneeFilter) {
      setSearchQuery(initialAssigneeFilter);
    }
  }, [initialAssigneeFilter]);
  const [visibilityScope, setVisibilityScope] = useState<'all' | 'my_team' | 'my_tasks'>('all');

  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedTaskDetails, setSelectedTaskDetails] = useState<TaskRecord | null>(null);
  // Module 12 Phase 9: Drive Link draft, synced whenever a different task's details open.
  const [driveLinkDraft, setDriveLinkDraft] = useState('');
  const [isSavingDriveLink, setIsSavingDriveLink] = useState(false);
  useEffect(() => {
    setDriveLinkDraft(selectedTaskDetails?.drive_link || '');
  }, [selectedTaskDetails?.id]);
  const [editingTask, setEditingTask] = useState<TaskRecord | null>(null);
  // Set when the Create Task modal was opened via "+ Add Subtask" — locks
  // the client to the parent's and attaches parent_task_id on submit.
  const [addSubtaskParent, setAddSubtaskParent] = useState<TaskRecord | null>(null);

  // New task form state
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newClientId, setNewClientId] = useState(clients[0]?.id || '');
  useEffect(() => {
    if (!addSubtaskParent && !clients.some((client) => client.id === newClientId)) {
      setNewClientId(clients[0]?.id || '');
    }
  }, [clients, newClientId, addSubtaskParent]);
  const [newTeam, setNewTeam] = useState('SEO');
  const [newAssignedTo, setNewAssignedTo] = useState<string>('');
  // Fetched via assignable_employees() RPC rather than filtering the local `users` prop — that
  // array is scoped by users_select_rls to the CURRENT viewer's own visibility, which for most
  // roles doesn't extend into every other department. See lib/departmentStaffing.ts.
  const [newTeamAssignees, setNewTeamAssignees] = useState<AssignableEmployee[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAssignableEmployees(newTeam).then((rows) => {
      if (cancelled) return;
      setNewTeamAssignees(rows);
      // Department changed out from under the current selection — never leave a stale
      // cross-department pick in place once the new department's real roster is in.
      setNewAssignedTo((current) => (current && !rows.some((u) => u.id === current) ? '' : current));
    });
    return () => {
      cancelled = true;
    };
  }, [newTeam]);
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
  const [editTeamAssignees, setEditTeamAssignees] = useState<AssignableEmployee[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAssignableEmployees(editTeam).then((rows) => {
      if (cancelled) return;
      setEditTeamAssignees(rows);
      setEditAssignedTo((current) => (current && !rows.some((u) => u.id === current) ? '' : current));
    });
    return () => {
      cancelled = true;
    };
  }, [editTeam]);
  const [editDueDate, setEditDueDate] = useState('');
  const [editPriority, setEditPriority] = useState<TaskPriority>('medium');
  const [editStatus, setEditStatus] = useState<TaskStatus>('todo');
  const [editEstimatedHours, setEditEstimatedHours] = useState<number>(0);
  const [editActualHours, setEditActualHours] = useState<number>(0);
  const [isUpdating, setIsUpdating] = useState(false);

  // Operational task assignees: strictly exclude Executive Management, Head of
  // Technical, and Sales — sales has no task-based work (task_visible()/
  // isTaskAccessibleUnderRLS block them from tasks entirely), so they must
  // never appear as a selectable assignee here either.
  //
  // marketing_manager is additionally narrowed to ONLY graphic_designer/video_editor — they can
  // create/assign tasks to the shared Creative pool and nothing else (not a team lead of any
  // department, no broader assignment rights). task_visible()/isTaskAccessibleUnderRLS already
  // enforce the matching read-side scope; this keeps the picker from ever offering an assignee
  // whose task marketing_manager wouldn't be able to see afterward.
  const isOperationalAssignee = (u: UserRecord) => {
    if (!u) return false;
    if (u.role === 'executive' || u.role === 'head_of_technical') return false;
    return true;
  };

  // Marketing Manager may only create/assign tasks to the shared Creative pool
  // (Graphic Designer / Video Editor) — not a manager of that team, just scoped
  // cross-team assignment rights.
  const isAssignableForCurrentUser = (u: UserRecord) => {
    if (!isOperationalAssignee(u)) return false;
    if (currentUser?.role === 'marketing_manager') {
      return u.role === 'graphic_designer' || u.role === 'video_editor';
    }
    return true;
  };

  // graphic_designer/video_editor are shared creative resources pooled across
  // every requesting team, not one department's own board — task_visible()
  // (RLS) already scopes what they're handed down to assigned-to-them-only,
  // so the scope toggle below has nothing left to offer them.
  const isSharedCreativeResource =
    currentUser?.role === 'graphic_designer' || currentUser?.role === 'video_editor';

  // Teams list. marketing_manager gets a single fixed "Creative" filter value instead of the
  // full department list — task_visible() only ever hands them graphic_designer/video_editor's
  // tasks anyway, so every other team's filter would just show zero results. "Creative" is
  // assignee-ROLE-scoped (see filteredTasks below), not the literal task.team column — that
  // column already splits across "Creative & Design"/"Video Production" for these two roles.
  const teams =
    currentUser?.role === 'marketing_manager'
      ? [
          { id: 'all', label: 'All Teams' },
          { id: 'Creative', label: 'Creative' },
        ]
      : [
    { id: 'all', label: 'All Teams' },
    { id: 'SEO', label: 'SEO' },
    { id: 'Social Media', label: 'Social Media' },
    { id: 'Media Buying', label: 'Media Buying' },
    { id: 'Creative & Design', label: 'Creative & Design' },
    { id: 'Video Production', label: 'Video Production' },
    { id: 'Programming', label: 'Programming' },
    { id: 'Account Management', label: 'Account Management' },
  ];

  // Employee-name filter options: a role-scoped list of employees the viewer may pick from to
  // see exactly what one person is working on.
  // - executive/head_of_technical: everyone org-wide, any role (same as getAllowedEmployeeRolesUnderRLS).
  // - Team leads: ONLY their own department's agents (TEAM_LEAD_TO_AGENT_ROLE) — not themselves,
  //   not the shared graphic_designer/video_editor pool, not other teams' leads.
  // - marketing_manager: ONLY graphic_designer/video_editor, matching its existing narrow
  //   Creative-pool scope (see isAssignableForCurrentUser above).
  // - Everyone else gets no dropdown at all — they only ever see their own tasks anyway
  //   (task_visible() scoping), so a picker would offer nothing beyond themselves.
  const assigneeFilterRoles: string[] = useMemo(() => {
    const role = currentUser?.role;
    if (!role) return [];
    if (role === 'executive' || role === 'head_of_technical') {
      return getAllowedEmployeeRolesUnderRLS(role);
    }
    if (role === 'marketing_manager') {
      return ['graphic_designer', 'video_editor'];
    }
    return TEAM_LEAD_TO_AGENT_ROLE[role] || [];
  }, [currentUser?.role]);

  const showAssigneeFilter = assigneeFilterRoles.length > 0;

  const assigneeFilterOptions = useMemo(() => {
    if (!showAssigneeFilter) return [];
    return users
      .filter((u) => assigneeFilterRoles.includes(u.role) && isActiveEmployee(u))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users, assigneeFilterRoles, showAssigneeFilter]);

  // Kanban Columns configuration
  const columns: { id: TaskStatus; label: string; color: string; badgeBg: string }[] = [
    { id: 'todo', label: 'To Do', color: 'var(--grey)', badgeBg: 'rgba(168, 155, 184, 0.2)' },
    { id: 'in_progress', label: 'In Progress', color: 'var(--purple-light)', badgeBg: 'rgba(123, 47, 247, 0.25)' },
    { id: 'in_review', label: 'In Review', color: 'var(--roas-mid)', badgeBg: 'rgba(245, 226, 154, 0.2)' },
    { id: 'completed', label: 'Completed', color: 'var(--roas-good)', badgeBg: 'rgba(169, 245, 193, 0.2)' },
    { id: 'blocked', label: 'Blocked', color: 'var(--roas-bad)', badgeBg: 'rgba(245, 163, 163, 0.2)' },
  ];

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

  // Subtasks (task.parent_task_id set) never appear as their own top-level
  // board/table rows — they're rendered nested inside their parent's Task
  // Details modal instead. Every board/table view and KPI count below
  // derives from this, so filtering here keeps them all in sync.
  const topLevelTasks = useMemo(() => tasks.filter((t) => !t.parent_task_id), [tasks]);

  // 1. Check user visibility based on RLS rules
  const userVisibleTasks = useMemo(() => {
    // Under Supabase RLS, users see tasks they have permission to access.
    // If visibilityScope is toggled by user in UI:
    if (visibilityScope === 'my_tasks') {
      return topLevelTasks.filter((t) => t.assigned_to === currentUserId);
    }
    if (visibilityScope === 'my_team' && currentUser?.team) {
      return topLevelTasks.filter((t) => t.team === currentUser.team || t.assigned_to === currentUserId);
    }
    return topLevelTasks;
  }, [topLevelTasks, visibilityScope, currentUserId, currentUser]);

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

      // Team filter. 'Creative' is a synthetic, assignee-ROLE-scoped value (only ever offered to
      // marketing_manager, see `teams` above) — the literal task.team column splits across
      // "Creative & Design"/"Video Production" for graphic_designer/video_editor, so it can't be
      // matched directly.
      if (selectedTeam === 'Creative') {
        const assignee = users.find((u) => u.id === t.assigned_to);
        if (!assignee || (assignee.role !== 'graphic_designer' && assignee.role !== 'video_editor')) return false;
      } else if (selectedTeam !== 'all' && t.team !== selectedTeam) {
        return false;
      }

      // Client filter
      if (selectedClient !== 'all' && t.client_id !== selectedClient) return false;

      // Priority filter
      if (selectedPriority !== 'all' && t.priority !== selectedPriority) return false;

      // Status filter
      if (selectedStatus !== 'all' && t.status !== selectedStatus) return false;

      // Employee-name filter (role-scoped dropdown, distinct from the free-text search below)
      if (selectedAssigneeId !== 'all' && t.assigned_to !== selectedAssigneeId) return false;

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
    selectedAssigneeId,
    searchQuery,
    clients,
    users,
    currentUserId,
    todayStr,
  ]);

  // Handlers
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newClientId || !newDescription.trim() || !newDueDate) {
      setNotification({
        text: 'Title, client, description, and due date are all required to create a task.',
        type: 'error',
      });
      setTimeout(() => setNotification(null), 3500);
      return;
    }

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
        parent_task_id: addSubtaskParent?.id || null,
      });

      setIsCreateModalOpen(false);
      setAddSubtaskParent(null);
      setNewTitle('');
      setNewDescription('');
      setNewEstimatedHours(8);
      setNewActualHours(0);
      setNotification({
        text: addSubtaskParent ? 'Subtask created successfully.' : 'Task created and assigned successfully.',
        type: 'success',
      });
      setTimeout(() => setNotification(null), 3500);
    } catch (err: any) {
      console.error(err);
      setNotification({
        text: `Failed to create task: ${err?.message || 'Unknown Supabase error.'}`,
        type: 'error',
      });
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

  // Opens the Create Task modal in "subtask" mode: client locked to the
  // parent's, parent_task_id attached on submit. parentTask may itself be a
  // subtask (adding a level-3 sub-subtask) — SubtaskList only ever calls
  // this at levels 1-2, since nesting is capped at 3.
  const openAddSubtaskModal = (parentTask: TaskRecord) => {
    setAddSubtaskParent(parentTask);
    setNewTitle('');
    setNewDescription('');
    setNewClientId(parentTask.client_id);
    setNewTeam(parentTask.team || 'SEO');
    setNewAssignedTo('');
    setNewDueDate(new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0]);
    setNewPriority('medium');
    setNewEstimatedHours(8);
    setNewActualHours(0);
    setIsCreateModalOpen(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !onUpdateTask) return;
    if (!editTitle.trim() || !editDescription.trim() || !editDueDate) {
      setNotification({
        text: 'Title, description, and due date are all required — none can be cleared.',
        type: 'error',
      });
      setTimeout(() => setNotification(null), 3500);
      return;
    }

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
    } catch (err: any) {
      console.error(err);
      setNotification({ text: `Error updating task: ${err?.message || 'Unknown Supabase error.'}`, type: 'error' });
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

  // Module 12 Phase 9
  const handleSaveDriveLink = async () => {
    if (!selectedTaskDetails || !onUpdateTask) return;
    const nextValue = driveLinkDraft.trim() || null;
    setIsSavingDriveLink(true);
    try {
      await onUpdateTask(selectedTaskDetails.id, { drive_link: nextValue });
      setSelectedTaskDetails({ ...selectedTaskDetails, drive_link: nextValue });
    } finally {
      setIsSavingDriveLink(false);
    }
  };

  // Kanban drag-and-drop. A minimum drag distance keeps a plain click still
  // opening Task Details (the existing behavior) instead of every pointer
  // press being swallowed as a drag start.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const [draggingTask, setDraggingTask] = useState<TaskRecord | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id);
    setDraggingTask(task || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggingTask(null);
    if (!over) return;
    const targetStatus = over.id as TaskStatus;
    const task = tasks.find((t) => t.id === active.id);
    if (task && task.status !== targetStatus) {
      handleMoveStatus(task.id, targetStatus);
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
      case 'Programming':
        return { text: '#818cf8', bg: 'rgba(99, 102, 241, 0.15)' };
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
          data-accent="neutral"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">Total Tasks</span>
            <Kanban className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--ink)' }}>{totalTasksCount}</p>
          </div>
        </div>

        {/* 2. Completed */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          data-accent="success"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">Completed</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--stat-success)' }}>{completedTasksCount}</p>
          </div>
        </div>

        {/* 3. In Progress */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          data-accent="neutral"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">In Progress</span>
            <Timer className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--stat-accent)' }}>{inProgressTasksCount}</p>
          </div>
        </div>

        {/* 4. Pending (To Do) */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">Pending</span>
            <Clock className="w-3.5 h-3.5" style={{ color: 'var(--ink-soft)' }} />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--stat-neutral-soft)' }}>{pendingTasksCount}</p>
          </div>
        </div>

        {/* 5. Overdue */}
        <div
          className={`p-3.5 rounded-[16px] flex flex-col justify-between transition-all ${
            overdueTasksCount > 0 ? 'ring-1 ring-red-500/40' : ''
          }`}
          data-accent="rose"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">Overdue</span>
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--stat-rose)' }}>{overdueTasksCount}</p>
          </div>
        </div>

        {/* 6. Unassigned */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          data-accent="warning"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">Unassigned</span>
            <UserX className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--stat-warning)' }}>{unassignedTasksCount}</p>
          </div>
        </div>

        {/* 7. Capacity Utilization */}
        <div
          className="p-3.5 rounded-[16px] flex flex-col justify-between"
          data-accent="neutral"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
        >
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span className="text-[11px] font-semibold">Capacity</span>
            <BarChart3 className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="mt-2">
            <p className="text-xl font-bold stat-number" style={{ color: 'var(--stat-accent)' }}>{capacityUtilization}%</p>
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
              <button
                onClick={() => setViewMode('timeline')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  viewMode === 'timeline'
                    ? 'bg-purple-600/30 text-white border border-purple-500/50'
                    : 'text-stone-400 hover:text-white'
                }`}
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>Calendar</span>
              </button>
            </div>

            {/* Scope Toggle for RLS permissions demonstration — hidden for
                graphic_designer/video_editor, since their tasks are already
                scoped assigned-only upstream (task_visible / RLS), making
                every option here identical to "My Tasks". */}
            {!isSharedCreativeResource && (
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
            )}
          </div>

          {/* Create Task Button */}
          <button
            onClick={() => {
              setAddSubtaskParent(null);
              setIsCreateModalOpen(true);
            }}
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
        <div
          className={`grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 ${
            showAssigneeFilter ? 'md:grid-cols-6' : 'md:grid-cols-5'
          }`}
        >
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

          {/* Employee Filter — role-scoped, see assigneeFilterOptions above */}
          {showAssigneeFilter && (
            <div>
              <label className="text-[11px] font-semibold block mb-1 text-stone-400">Employee:</label>
              <select
                value={selectedAssigneeId}
                onChange={(e) => setSelectedAssigneeId(e.target.value)}
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
              >
                <option value="all" className="bg-stone-900 text-white">All Employees</option>
                {assigneeFilterOptions.map((u) => (
                  <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}

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
        <DndContext sensors={dndSensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 items-start">
            {columns.map((column) => {
              const columnTasks = filteredTasks.filter((t) => t.status === column.id);
              return (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  columns={columns}
                  tasks={columnTasks}
                  allTasks={tasks}
                  clients={clients}
                  users={users}
                  isOverdue={isOverdue}
                  isDueSoon={isDueSoon}
                  onOpenDetails={setSelectedTaskDetails}
                  onEditTask={openEditModal}
                  onMoveStatus={handleMoveStatus}
                />
              );
            })}
          </div>

          <DragOverlay>
            {draggingTask &&
              (() => {
                const subtasks = tasks.filter((t) => t.parent_task_id === draggingTask.id);
                return (
                  <KanbanTaskCardContent
                    task={draggingTask}
                    client={clients.find((c) => c.id === draggingTask.client_id)}
                    assignee={users.find((u) => u.id === draggingTask.assigned_to)}
                    subtaskDone={subtasks.filter((t) => t.status === 'completed').length}
                    subtaskTotal={subtasks.length}
                    overdue={isOverdue(draggingTask)}
                    dueSoon={isDueSoon(draggingTask)}
                    columns={columns}
                    onOpenDetails={() => {}}
                    onEditTask={() => {}}
                    onMoveStatus={() => {}}
                    isOverlay
                  />
                );
              })()}
          </DragOverlay>
        </DndContext>
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
                  <th className="p-3.5 text-center">Created</th>
                  <th className="p-3.5 text-center">Due Date</th>
                  <th className="p-3.5 text-center">Est. Hours</th>
                  <th className="p-3.5 text-center">Act. Hours</th>
                  <th className="p-3.5 text-center">Drive Link</th>
                  <th className="p-3.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {filteredTasks.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-stone-400">
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
                          {(() => {
                            const subtasks = tasks.filter((t) => t.parent_task_id === task.id);
                            if (subtasks.length === 0) return null;
                            const done = subtasks.filter((t) => t.status === 'completed').length;
                            return (
                              <p className="text-[10px] text-purple-300 mt-0.5 flex items-center gap-1">
                                <CheckSquare className="w-3 h-3" />
                                Subtasks: {done}/{subtasks.length}
                              </p>
                            );
                          })()}
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
                        <td className="p-3.5 text-center font-mono text-stone-400">
                          {task.created_at ? task.created_at.split('T')[0] : '—'}
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
                          {task.drive_link ? (
                            <a
                              href={task.drive_link}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-purple-300 hover:text-white"
                              title={task.drive_link}
                            >
                              <Link2 className="w-3.5 h-3.5" />
                            </a>
                          ) : (
                            <span className="text-stone-600">—</span>
                          )}
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

      {/* VIEW 3: TIMELINE / CALENDAR VIEW */}
      {viewMode === 'timeline' && (
        <TaskCalendarView
          tasks={filteredTasks}
          clients={clients}
          users={users}
          onSelectTask={setSelectedTaskDetails}
        />
      )}

      {/* MODAL 1: TASK DETAILS VIEW */}
      {selectedTaskDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-xl rounded-[22px] p-6 space-y-4 shadow-2xl relative max-h-[90vh] overflow-y-auto"
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

              {/* Hours Tracking, Created & Due Date */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-xl bg-stone-900/60 border border-stone-800 text-center">
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
                  <p className="text-[10px] text-stone-400">Created</p>
                  <p className="text-sm font-bold text-stone-300 mt-0.5 font-mono">
                    {selectedTaskDetails.created_at ? selectedTaskDetails.created_at.split('T')[0] : 'Unknown'}
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

              {/* Drive Link (Module 12 Phase 9) — manually-pasted URL, no real Drive API */}
              <div>
                <label className="text-[11px] font-semibold text-stone-400 mb-1.5 flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5" />
                  <span>Drive Link:</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="url"
                    value={driveLinkDraft}
                    onChange={(e) => setDriveLinkDraft(e.target.value)}
                    placeholder="https://drive.google.com/..."
                    className="flex-1 px-3 py-2 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-400"
                  />
                  {onUpdateTask && driveLinkDraft !== (selectedTaskDetails.drive_link || '') && (
                    <button
                      onClick={handleSaveDriveLink}
                      disabled={isSavingDriveLink}
                      className="px-3 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 shrink-0"
                    >
                      {isSavingDriveLink ? 'Saving...' : 'Save'}
                    </button>
                  )}
                  {selectedTaskDetails.drive_link && (
                    <a
                      href={selectedTaskDetails.drive_link}
                      target="_blank"
                      rel="noreferrer"
                      className="p-2 rounded-xl bg-stone-900/80 border border-stone-800 text-purple-300 hover:text-white shrink-0"
                      title="Open in new tab"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </a>
                  )}
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

              {/* Subtask completion nudge — never automatic, just a one-click suggestion */}
              {(() => {
                const directSubtasks = tasks.filter((t) => t.parent_task_id === selectedTaskDetails.id);
                const allSubtasksDone =
                  directSubtasks.length > 0 && directSubtasks.every((t) => t.status === 'completed');
                if (!allSubtasksDone || selectedTaskDetails.status === 'completed') return null;
                return (
                  <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/40 flex items-center justify-between gap-3">
                    <span className="text-xs text-emerald-300 font-semibold">
                      All subtasks are complete — mark this task Completed too?
                    </span>
                    <button
                      onClick={() => handleMoveStatus(selectedTaskDetails.id, 'completed')}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                    >
                      Mark Completed
                    </button>
                  </div>
                );
              })()}

              {/* Subtasks — full mini-tasks, nested up to 3 levels deep */}
              {selectedTaskDetails.parent_task_id == null && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[11px] font-semibold text-stone-400">Subtasks:</label>
                    <button
                      onClick={() => openAddSubtaskModal(selectedTaskDetails)}
                      className="text-[11px] font-bold text-purple-300 hover:text-purple-200 flex items-center gap-1"
                    >
                      <PlusCircle className="w-3.5 h-3.5" />
                      Add Subtask
                    </button>
                  </div>
                  <SubtaskList
                    parentTask={selectedTaskDetails}
                    allTasks={tasks}
                    users={users}
                    level={2}
                    onAddSubtask={openAddSubtaskModal}
                    onEditSubtask={openEditModal}
                  />
                </div>
              )}

              {/* Attachments — private Storage bucket, signed-URL access only */}
              {onUploadTaskAttachment && onDeleteTaskAttachment && (
                <div>
                  <label className="text-[11px] font-semibold text-stone-400 block mb-1.5">
                    Attachments:
                  </label>
                  <TaskAttachmentList
                    taskId={selectedTaskDetails.id}
                    attachments={taskAttachments}
                    users={users}
                    currentUserId={currentUserId}
                    onUpload={onUploadTaskAttachment}
                    onDelete={onDeleteTaskAttachment}
                  />
                </div>
              )}

              {/* Comments — threaded up to 3 levels deep */}
              {onAddTaskComment && onEditTaskComment && onDeleteTaskComment && (
                <div>
                  <label className="text-[11px] font-semibold text-stone-400 block mb-1.5">
                    Comments:
                  </label>
                  <TaskCommentThread
                    taskId={selectedTaskDetails.id}
                    comments={taskComments}
                    users={users}
                    currentUserId={currentUserId}
                    onAddComment={onAddTaskComment}
                    onEditComment={onEditTaskComment}
                    onDeleteComment={onDeleteTaskComment}
                  />
                </div>
              )}
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
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <PlusCircle className="w-5 h-5 text-purple-400" />
                  <span>{addSubtaskParent ? 'Add Subtask' : 'Create New Task'}</span>
                </h3>
                {addSubtaskParent && (
                  <p className="text-[11px] text-stone-400 mt-0.5">
                    Under: <span className="text-purple-300 font-semibold">{addSubtaskParent.title}</span>
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  setIsCreateModalOpen(false);
                  setAddSubtaskParent(null);
                }}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-3.5">
              {/* Client Selection — locked to the parent's client when adding a subtask */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Client:
                </label>
                <select
                  value={newClientId}
                  onChange={(e) => setNewClientId(e.target.value)}
                  disabled={!!addSubtaskParent}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500 disabled:opacity-60"
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
                  required
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
                    {OPERATIONAL_TEAMS.map((t) => (
                      <option key={t} value={t} className="bg-stone-900 text-white">{t}</option>
                    ))}
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
                    {newTeamAssignees
                      .map((u) => {
                        const capacityData = getUserCapacityData({ ...u, auth_id: null }, clients, tasks);
                        return (
                          <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                            {u.name} ({u.team || u.role}) {getCapacityIndicator(capacityData)}
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
                  onClick={() => {
                    setIsCreateModalOpen(false);
                    setAddSubtaskParent(null);
                  }}
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
                  required
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
                    {OPERATIONAL_TEAMS.map((t) => (
                      <option key={t} value={t} className="bg-stone-900 text-white">{t}</option>
                    ))}
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
                    {editTeamAssignees
                      .map((u) => {
                        const capacityData = getUserCapacityData({ ...u, auth_id: null }, clients, tasks);
                        return (
                          <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                            {u.name} ({u.team || u.role}) {getCapacityIndicator(capacityData)}
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
                    required
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
