import React, { useState, useMemo, useEffect, useRef } from 'react';
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
  PlayCircle,
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
  Settings,
  Trash2,
} from 'lucide-react';
import {
  TaskRecord,
  TaskTypeRecord,
  UserRecord,
  ClientRecord,
  TaskStatus,
  TaskPriority,
  TaskCommentRecord,
  TaskAttachmentRecord,
  TaskAssigneeRecord,
  PlatformRecord,
  TaskPlatformLinkRecord,
  TaskEventRecord,
  ActivityRecord,
  TaskAssigneeLogRecord,
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
import { CAPACITY_UNKNOWN_INDICATOR, resolveCapacityLimit } from '../lib/capacity';
import { isActiveEmployee, canHardDeleteTasks } from '../lib/permissions';
import {
  computeTaskDeletionPreview,
  fetchTaskEvents,
  fetchLegacyTaskActivities,
  fetchLegacyTaskAssigneeLog,
} from '../lib/taskOperations';
import { TaskDeleteConfirmModal } from './TaskDeleteConfirmModal';
import {
  isTaskDone,
  canCloseTask,
  canSubmitTaskForClosing,
  canShowDoneLink,
  canEditTaskAssignees,
  resolveTaskAssigneeIds,
  resolveOrderedTaskAssigneeIds,
} from '../lib/taskLifecycle';
import { getTodayStr, isTaskOverdueForAssignee } from '../lib/employeeWork';
import { getAllowedEmployeeRolesUnderRLS } from '../lib/supabase';
import { getOperationalTeams, fetchAssignableEmployees } from '../lib/departmentStaffing';
import {
  MAX_BULK_TASKS,
  runBulkTaskAction,
  summarizeBulkOutcomes,
  checkBulkStatusChange,
  checkBulkAssigneeEdit,
  checkBulkDuplicate,
  resolveBulkAssigneeIds,
  BulkAssigneeMode,
  BulkActionSummary,
} from '../lib/bulkTaskActions';
import type { AssignableEmployee } from '../lib/departmentStaffing';
import { getCreativeTeams, isCreativeAssignee, pickMostLoadedAssignee, resolveDailyTaskTarget, suggestDueDateAndHours } from '../lib/designerScheduling';
import { MAX_TASKS_PER_DAY, SUGGESTION_LOOKAHEAD_DAYS } from '../config/designerScheduling';
import { addReportDays } from '../lib/reportPeriods';
import { SubtaskList } from './SubtaskList';
import { TaskCommentThread } from './TaskCommentThread';
import { TaskAttachmentList } from './TaskAttachmentList';
import { TaskHistoryTab } from './TaskHistoryTab';
import { TaskAttachmentPicker } from './TaskAttachmentPicker';
import { SearchableMultiSelect } from './SearchableMultiSelect';
import type { CreateTaskFormInput, StagedTaskAttachment, UserScheduleLoad } from '../lib/taskOperations';
import {
  TaskCreateRecoveryRecord,
  clearTaskCreateRecovery,
  createTaskRecovery,
  matchRecoveryAttachments,
  readTaskCreateRecovery,
  saveTaskCreateRecovery,
} from '../lib/taskCreateRecovery';
import { TaskCalendarView } from './TaskCalendarView';
import { KanbanColumn } from './KanbanColumn';
import { KanbanTaskCardContent } from './KanbanTaskCard';
import { TaskTypeManager } from './TaskTypeManager';
import { TaskTypeInlineManager } from './TaskTypeInlineManager';
import { PlatformManager } from './PlatformManager';

interface CrossTeamTaskBoardProps {
  tasks: TaskRecord[];
  taskAssignees: TaskAssigneeRecord[];
  users: UserRecord[];
  // Merged users + task_directory() entries — see App.tsx's fetchTaskDirectory. Used only where a
  // task's assigned_to id is resolved to a display name, so cross-team assignees always show a
  // real name instead of silently falling back to "Unassigned". Every other use of `users` below
  // (filters, capacity, rosters) deliberately stays on the raw `users` prop.
  taskDirectoryUsers: UserRecord[];
  clients: ClientRecord[];
  currentUser?: UserRecord;
  currentUserId?: string;
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onCreateTask: (taskData: CreateTaskFormInput) => Promise<void>;
  onUpdateTask?: (
    taskId: string,
    updates: Partial<TaskRecord>,
    assigneeIds?: string[],
    attachments?: StagedTaskAttachment[],
    platformIds?: string[]
  ) => Promise<void>;
  // Admin-managed Task Type reference list (task_types table) — includes inactive rows so an
  // existing task's type can still be resolved/shown after it's deactivated. The admin screen
  // (TaskTypeManager) that creates/renames/reorders/deactivates these is gated to
  // executive/head_of_technical below, matching task_types_write_rls/task_types_update_rls.
  // Required (not optional) deliberately: this project has no @types/react installed, so a JSX
  // element with a missing prop produces zero tsc errors — an omission here would only surface at
  // runtime. scripts/checkTaskTypeManagerProps.ts enforces this at every render site instead.
  taskTypes: TaskTypeRecord[];
  onCreateTaskType: (row: Omit<TaskTypeRecord, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdateTaskType: (id: string, updates: Partial<TaskTypeRecord>) => Promise<void>;
  // Admin-managed Platform reference list (platforms table) + its task links (task_platform_links
  // table) — same "includes inactive rows" posture as taskTypes above. The admin screen
  // (PlatformManager) is gated to executive/head_of_technical below, matching
  // platforms_write_rls/platforms_update_rls. Also required (not optional) and enforced at the
  // one render site by scripts/checkTaskTypeManagerProps.ts, for the same reason as taskTypes.
  platforms: PlatformRecord[];
  taskPlatformLinks: TaskPlatformLinkRecord[];
  onCreatePlatform: (row: Omit<PlatformRecord, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdatePlatform: (id: string, updates: Partial<PlatformRecord>) => Promise<void>;
  // Pre-fills the search box (matches by assignee name) when arriving here via
  // the "Assign via Task Board" link from CapacityManagement's employee cards.
  initialAssigneeFilter?: string;
  // Opens this task's Details modal on arrival — set when a notification's link_url is
  // 'task:<id>' (see App.tsx's handleNotificationClick) so clicking a task notification jumps
  // straight to that task instead of just landing on the Tasks module. A fresh id (even the same
  // one re-clicked) re-opens the modal; see this prop's own effect below for why a changed `tasks`
  // array must never do that on its own.
  initialOpenTaskId?: string | null;
  taskComments?: TaskCommentRecord[];
  onAddTaskComment?: (taskId: string, body: string, parentCommentId?: string | null) => Promise<void>;
  onEditTaskComment?: (commentId: string, body: string) => Promise<void>;
  onDeleteTaskComment?: (commentId: string) => Promise<void>;
  taskAttachments?: TaskAttachmentRecord[];
  onUploadTaskAttachment?: (taskId: string, file: File) => Promise<void>;
  onDeleteTaskAttachment?: (attachmentId: string) => Promise<void>;
  onGetCapacitySnapshot: (userIds: string[]) => Promise<Record<string, number>>;
  // Backs the designer-scheduling due-date/estimated-hours suggestion (see
  // src/lib/designerScheduling.ts and get_user_schedule_load() in
  // supabase/migrations/20261111000000_user_schedule_load_carry_over.sql). Optional: when
  // absent, the suggestion simply never appears — same "degrade, don't crash" posture as
  // onMarkTaskViewed.
  onGetUserScheduleLoad?: (userId: string, fromDate: string, toDate: string) => Promise<UserScheduleLoad>;
  // The one authoritative "today" for that same suggestion — Africa/Cairo's current date (see
  // get_server_today() in supabase/migrations/20261110000000_user_schedule_load.sql). Every
  // designer-scheduling call site below calls this rather than deriving "today" from the
  // browser's own clock/timezone; if it's absent or its call fails, the suggestion simply does
  // not appear (never falls back to a client-guessed date).
  onGetServerToday?: () => Promise<string>;
  onMarkTaskViewed?: (taskId: string) => Promise<void>;
  // Task hard delete (delete_tasks() RPC) — executive/head_of_technical only, gated
  // locally below via canHardDeleteTasks(currentUser.role) (lib/permissions.ts), same pattern as
  // canManageTaskTypes/canManagePlatforms above. Optional: absent entirely (e.g. no currentUser),
  // the delete controls simply never render.
  onHardDeleteTasks?: (taskIds: string[]) => Promise<void>;
  // Duplicate (bulk-action toolbar, Table view). Single-task shaped, same as onUpdateTaskStatus
  // above — the bulk toolbar calls this once per selected task via runBulkTaskAction(). Optional
  // for the same reason onHardDeleteTasks is: absent entirely, the Duplicate control doesn't render.
  onDuplicateTask?: (taskId: string, includeSubtasks: boolean) => Promise<void>;
}

export type QuickTaskFilter = 'all' | 'overdue' | 'due_soon' | 'unassigned' | 'my_tasks';
export type TaskViewMode = 'kanban' | 'table' | 'timeline';

export const CrossTeamTaskBoard: React.FC<CrossTeamTaskBoardProps> = ({
  tasks,
  taskAssignees = [],
  users,
  taskDirectoryUsers,
  clients,
  currentUser,
  currentUserId = currentUser?.id || users[0]?.id || '',
  onUpdateTaskStatus,
  onCreateTask,
  onUpdateTask,
  taskTypes,
  onCreateTaskType,
  onUpdateTaskType,
  platforms,
  taskPlatformLinks,
  onCreatePlatform,
  onUpdatePlatform,
  initialAssigneeFilter,
  initialOpenTaskId,
  taskComments = [],
  onAddTaskComment,
  onEditTaskComment,
  onDeleteTaskComment,
  taskAttachments = [],
  onUploadTaskAttachment,
  onDeleteTaskAttachment,
  onGetCapacitySnapshot,
  onGetUserScheduleLoad,
  onGetServerToday,
  onMarkTaskViewed,
  onHardDeleteTasks,
  onDuplicateTask,
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
  // separate from the free-text search box above. Its option list depends on the Team filter
  // (see employeeFilterOptions below) — a real department selected there fetches that
  // department's roster via fetchAssignableEmployees(), same RPC the New/Edit Task modals use.
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string>('all');
  // Platform filter — matches ANY selected platform (an empty selection means "no filter").
  const [selectedPlatformIds, setSelectedPlatformIds] = useState<string[]>([]);
  // Date sort — applied after all the filters above, never changes which tasks show, only their
  // order. Sorts by created_at (falling back to due_date for any older row inserted before that
  // column existed/was backfilled, so nothing silently sorts as if it were from the Unix epoch).
  // Defaults to newest-first per the agency owner's request: the previous unsorted order (raw
  // fetch/array order) happened to read oldest-first, which read as "today's new tasks are buried".
  const [taskSortOrder, setTaskSortOrder] = useState<'newest' | 'oldest'>('newest');
  // "Completed On" date filter — a free-text calendar-day picker, separate from the Quick Filter
  // pills above. Empty string means no filter. Matches tasks.completed_at (set once, the first
  // time a task's status becomes 'completed' — see its own column comment above) against the
  // browser-local calendar day, same convention as getTodayStr()/isOverdue, not a UTC-day compare
  // (completed_at is a timestamptz and would otherwise drift by the server's UTC offset).
  const [completedOnDate, setCompletedOnDate] = useState<string>('');
  // "Due On" date filter — shows every task due that calendar day regardless of status (To Do,
  // In Progress, Completed, whatever), unlike Completed On above which only matches completed_at.
  // due_date is a plain `date` column (not timestamptz — see schema), already "YYYY-MM-DD", so
  // this is a direct string compare with no local-timezone conversion needed.
  const [dueOnDate, setDueOnDate] = useState<string>('');
  // Populated whenever selectedTeam is a real department (not 'all', not marketing_manager's
  // synthetic 'Creative' value) — mirrors newTeamAssignees/editTeamAssignees's effect below
  // exactly, fetched via the RPC rather than filtering the local `users` prop since that array is
  // scoped by users_select_rls to the viewer's own visibility, not the selected department's.
  const [teamFilterEmployees, setTeamFilterEmployees] = useState<AssignableEmployee[]>([]);
  useEffect(() => {
    if (selectedTeam === 'all' || selectedTeam === 'Creative') {
      setTeamFilterEmployees([]);
      return;
    }
    let cancelled = false;
    fetchAssignableEmployees(selectedTeam).then((rows) => {
      if (!cancelled) setTeamFilterEmployees(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedTeam]);

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
  const [isTaskTypeManagerOpen, setIsTaskTypeManagerOpen] = useState(false);
  const canManageTaskTypes = currentUser?.role === 'executive' || currentUser?.role === 'head_of_technical';
  const [isPlatformManagerOpen, setIsPlatformManagerOpen] = useState(false);
  const canManagePlatforms = currentUser?.role === 'executive' || currentUser?.role === 'head_of_technical';
  const isUiUxDesigner = currentUser?.role === 'ui_ux_designer';
  const canDeleteTasks = !!onHardDeleteTasks && !!currentUser && canHardDeleteTasks(currentUser.role);
  // Who even SEES the Table view's checkbox column / bulk-action toolbar at all — isUiUxDesigner
  // is read-only everywhere else in this component (Edit Task/Add Subtask are hidden for it too),
  // so bulk actions are hidden the same way. This is only the "show the toolbar" gate; each
  // action re-checks its own real permission per task when it actually runs (bulkTaskActions.ts),
  // same as the single-task controls those checks already mirror.
  const canUseBulkActions = !isUiUxDesigner;

  // Table view multi-select (checkbox column) + the one confirm modal shared by both the bulk
  // "Delete Selected" button here and the single-task delete button in the Details modal below —
  // deleteModalTaskIds is null when the modal is closed.
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [deleteModalTaskIds, setDeleteModalTaskIds] = useState<string[] | null>(null);
  const [isDeletingTasks, setIsDeletingTasks] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Bulk-action toolbar (ClickUp-style), Table view only. bulkPanel picks which action's own
  // small input panel is open below the toolbar; each panel's "Apply" sets bulkConfirm instead of
  // running immediately — the confirm dialog (count + action description) is mandatory per spec
  // before ANY bulk action executes. Delete is deliberately NOT routed through this state at all
  // — it reuses the pre-existing deleteModalTaskIds confirm flow unchanged ("كما هو").
  type BulkPanel = 'status' | 'priority' | 'dueDate' | 'assignees' | 'move' | 'duplicate';
  const [bulkPanel, setBulkPanel] = useState<BulkPanel | null>(null);
  const [bulkStatusDraft, setBulkStatusDraft] = useState<TaskStatus>('todo');
  const [bulkPriorityDraft, setBulkPriorityDraft] = useState<TaskPriority>('medium');
  const [bulkDueDateDraft, setBulkDueDateDraft] = useState('');
  const [bulkAssigneeMode, setBulkAssigneeMode] = useState<BulkAssigneeMode>('add');
  const [bulkAssigneeIds, setBulkAssigneeIds] = useState<string[]>([]);
  const [bulkMoveClientId, setBulkMoveClientId] = useState('');
  const [bulkMoveTeam, setBulkMoveTeam] = useState('');
  const [bulkDuplicateIncludeSubtasks, setBulkDuplicateIncludeSubtasks] = useState(false);
  const [isBulkRunning, setIsBulkRunning] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<{ description: string; run: () => Promise<void> } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{ actionLabel: string; summary: BulkActionSummary } | null>(null);
  const [bulkSelectionError, setBulkSelectionError] = useState<string | null>(null);

  const clearBulkSelection = () => {
    setSelectedTaskIds(new Set());
    setBulkPanel(null);
    setBulkSelectionError(null);
  };

  // Esc clears the selection from anywhere on the board, Table or Kanban alike — only while
  // there's actually something selected, so it never steals Esc from an open modal/dropdown
  // (those already have their own Esc handling, and this component has no way to tell a modal
  // elsewhere on the page just intercepted the same keydown first).
  useEffect(() => {
    if (selectedTaskIds.size === 0) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearBulkSelection();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskIds.size]);

  // Shared by both Table and Kanban views — selectedTaskIds itself already is (one piece of
  // state for the whole board); these two just give Kanban's column-header/per-card checkboxes
  // the same toggle semantics the Table view's own checkboxes already use inline.
  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };
  const toggleColumnSelection = (taskIds: string[], select: boolean) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      taskIds.forEach((id) => (select ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  // Shared by every bulk action except Delete. Never all-or-nothing (runBulkTaskAction attempts
  // every task regardless of an earlier one's skip/failure); the 100-task cap is enforced here,
  // once, rather than duplicated in each panel's own "Apply" handler.
  const runBulk = async (
    actionLabel: string,
    options: Parameters<typeof runBulkTaskAction>[1]
  ) => {
    const ids = [...selectedTaskIds];
    if (ids.length === 0) return;
    if (ids.length > MAX_BULK_TASKS) {
      setBulkSelectionError(`You can act on at most ${MAX_BULK_TASKS} tasks at once (${ids.length} selected).`);
      return;
    }
    setIsBulkRunning(true);
    try {
      const outcomes = await runBulkTaskAction(ids, options);
      setBulkSummary({ actionLabel, summary: summarizeBulkOutcomes(outcomes) });
      clearBulkSelection();
    } finally {
      setIsBulkRunning(false);
    }
  };

  const handleConfirmDeleteTasks = async () => {
    if (!deleteModalTaskIds || !onHardDeleteTasks) return;
    setIsDeletingTasks(true);
    setDeleteError(null);
    try {
      await onHardDeleteTasks(deleteModalTaskIds);
      setSelectedTaskIds((prev) => {
        const next = new Set(prev);
        deleteModalTaskIds.forEach((id) => next.delete(id));
        return next;
      });
      if (selectedTaskDetails && deleteModalTaskIds.includes(selectedTaskDetails.id)) {
        setSelectedTaskDetails(null);
      }
      setDeleteModalTaskIds(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unable to delete the selected task(s).');
    } finally {
      setIsDeletingTasks(false);
    }
  };
  const [selectedTaskDetails, setSelectedTaskDetails] = useState<TaskRecord | null>(null);
  useEffect(() => {
    if (selectedTaskDetails?.id && onMarkTaskViewed) {
      void onMarkTaskViewed(selectedTaskDetails.id);
    }
    // Mark once when a different task is opened; callback identity must not retrigger the write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetails?.id]);

  // initialOpenTaskId's own effect — reads tasks via a ref mirror (updated every render, below)
  // rather than depending on `tasks` directly, so an unrelated task-list update elsewhere never
  // re-fires this and silently reopens a modal the person already closed. Mirrors the exact
  // reference-churn-safe pattern used for ReportDraftWorkspace.tsx's report-switch effect.
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    if (!initialOpenTaskId) return;
    const target = tasksRef.current.find((t) => t.id === initialOpenTaskId);
    if (target) setSelectedTaskDetails(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpenTaskId]);
  // Done Link draft, synced whenever a different task's details open — the one general-purpose
  // task link field (owner decision; Drive Link has been removed, see canShowDoneLink()).
  const [doneLinkDraft, setDoneLinkDraft] = useState('');
  const [isSavingDoneLink, setIsSavingDoneLink] = useState(false);
  useEffect(() => {
    setDoneLinkDraft(selectedTaskDetails?.done_link || '');
  }, [selectedTaskDetails?.id]);
  // Details / History tab (public.task_events). Reset to 'details' and drop any previously
  // fetched rows whenever a different task's details open, so switching tasks never shows a
  // stale task's history under the new one for an instant.
  const [activeDetailsTab, setActiveDetailsTab] = useState<'details' | 'history'>('details');
  const [taskEvents, setTaskEvents] = useState<TaskEventRecord[]>([]);
  const [isLoadingTaskEvents, setIsLoadingTaskEvents] = useState(false);
  const [taskEventsError, setTaskEventsError] = useState<string | null>(null);
  const [taskEventsReloadToken, setTaskEventsReloadToken] = useState(0);
  useEffect(() => {
    setActiveDetailsTab('details');
    setTaskEvents([]);
    setTaskEventsError(null);
  }, [selectedTaskDetails?.id]);
  // Lazy: fetched only once the History tab is actually opened for this task, never when Task
  // Details itself opens — a task whose details are never switched to History never calls this.
  useEffect(() => {
    if (activeDetailsTab !== 'history' || !selectedTaskDetails) return;
    let cancelled = false;
    setIsLoadingTaskEvents(true);
    setTaskEventsError(null);
    fetchTaskEvents(selectedTaskDetails.id)
      .then((rows) => {
        if (!cancelled) setTaskEvents(rows);
      })
      .catch((err) => {
        if (!cancelled) setTaskEventsError(err instanceof Error ? err.message : 'Unable to load task history.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTaskEvents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDetailsTab, selectedTaskDetails?.id, taskEventsReloadToken]);
  // "Older history" (TaskHistoryTab.tsx) — legacy activities/task_assignee_log rows from before
  // task_events existed. Visible to anyone who can open this Task Details modal at all: both
  // legacy sources' own RLS now key off task_visible_v2() the same way tasks/task_events do
  // (activities_select_task_participants, 20261117000000_activities_task_participants_select.sql),
  // not an admin-only check here — the RLS on each table is what actually scopes this per viewer.
  const [legacyActivities, setLegacyActivities] = useState<ActivityRecord[]>([]);
  const [legacyAssigneeLog, setLegacyAssigneeLog] = useState<TaskAssigneeLogRecord[]>([]);
  const [isLoadingLegacyHistory, setIsLoadingLegacyHistory] = useState(false);
  const [legacyHistoryError, setLegacyHistoryError] = useState<string | null>(null);
  const [legacyHistoryReloadToken, setLegacyHistoryReloadToken] = useState(0);
  useEffect(() => {
    setLegacyActivities([]);
    setLegacyAssigneeLog([]);
    setLegacyHistoryError(null);
  }, [selectedTaskDetails?.id]);
  useEffect(() => {
    if (activeDetailsTab !== 'history' || !selectedTaskDetails) return;
    let cancelled = false;
    setIsLoadingLegacyHistory(true);
    setLegacyHistoryError(null);
    Promise.all([
      fetchLegacyTaskActivities(selectedTaskDetails.id),
      fetchLegacyTaskAssigneeLog(selectedTaskDetails.id),
    ])
      .then(([activities, assigneeLog]) => {
        if (cancelled) return;
        setLegacyActivities(activities);
        setLegacyAssigneeLog(assigneeLog);
      })
      .catch((err) => {
        if (!cancelled) setLegacyHistoryError(err instanceof Error ? err.message : 'Unable to load older history.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingLegacyHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDetailsTab, selectedTaskDetails?.id, legacyHistoryReloadToken]);
  // Details-modal "Assignees" section (re-assign chain, section B): the org-wide roster for "Add
  // assignee" — deliberately NOT fetchAssignableEmployees(task.team) like the Create/Edit forms,
  // since this control must offer someone from ANY department (e.g. an AM adding a graphic
  // designer to a social_media task). assignable_employees() only accepts one department at a
  // time, so this merges one call per operational team; fetched lazily, once, the first time any
  // Details modal with edit rights actually opens the add-picker — not on every board render.
  const [orgWideAssignableEmployees, setOrgWideAssignableEmployees] = useState<AssignableEmployee[] | null>(null);
  const [isLoadingOrgWideEmployees, setIsLoadingOrgWideEmployees] = useState(false);
  const loadOrgWideAssignableEmployees = () => {
    if (orgWideAssignableEmployees || isLoadingOrgWideEmployees) return;
    setIsLoadingOrgWideEmployees(true);
    Promise.all(getOperationalTeams().map((team) => fetchAssignableEmployees(team)))
      .then((rosters) => {
        const byId = new Map<string, AssignableEmployee>();
        rosters.flat()
          .filter((employee) => employee.role !== 'executive' && employee.role !== 'head_of_technical')
          .forEach((employee) => byId.set(employee.id, employee));
        setOrgWideAssignableEmployees([...byId.values()]);
      })
      .finally(() => setIsLoadingOrgWideEmployees(false));
  };
  const [isAddAssigneeOpen, setIsAddAssigneeOpen] = useState(false);
  const [assigneeActionError, setAssigneeActionError] = useState<string | null>(null);
  const [isSavingAssignees, setIsSavingAssignees] = useState(false);
  useEffect(() => {
    setIsAddAssigneeOpen(false);
    setAssigneeActionError(null);
  }, [selectedTaskDetails?.id]);
  const [addAssigneeCapacitySnapshot, setAddAssigneeCapacitySnapshot] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!isAddAssigneeOpen || !orgWideAssignableEmployees) return;
    let cancelled = false;
    onGetCapacitySnapshot(orgWideAssignableEmployees.map((employee) => employee.id))
      .then((snapshot) => {
        if (!cancelled) setAddAssigneeCapacitySnapshot(snapshot);
      })
      .catch(() => {
        if (!cancelled) setAddAssigneeCapacitySnapshot({});
      });
    return () => {
      cancelled = true;
    };
  }, [isAddAssigneeOpen, orgWideAssignableEmployees, onGetCapacitySnapshot]);
  // Designer-scheduling suggestion for a creative assignee added via the Details-modal "Add
  // assignee" control — SHOWN only, same "never auto-shift an existing due date" rule as the Edit
  // form's own suggestion. Reset whenever a different task's details open, so a stale suggestion
  // from the previous task never lingers.
  const [addAssigneeSuggestion, setAddAssigneeSuggestion] = useState<{
    dueDate: string;
    estimatedHours: number;
    warning: boolean;
    userName: string;
    carriedOverCount: number;
  } | null>(null);
  const [isApplyingAddAssigneeSuggestion, setIsApplyingAddAssigneeSuggestion] = useState(false);
  useEffect(() => {
    setAddAssigneeSuggestion(null);
  }, [selectedTaskDetails?.id]);
  const [editingTask, setEditingTask] = useState<TaskRecord | null>(null);
  // Set when the Create Task modal was opened via "+ Add Subtask" — locks
  // the client to the parent's and attaches parent_task_id on submit.
  const [addSubtaskParent, setAddSubtaskParent] = useState<TaskRecord | null>(null);

  // New task form state
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newClientIds, setNewClientIds] = useState<string[]>(clients[0]?.id ? [clients[0].id] : []);
  useEffect(() => {
    if (!addSubtaskParent) {
      setNewClientIds((current) => {
        const valid = current.filter((id) => clients.some((client) => client.id === id));
        return valid.length > 0 ? valid : (clients[0]?.id ? [clients[0].id] : []);
      });
    }
  }, [clients, addSubtaskParent]);
  const [newTeam, setNewTeam] = useState('SEO');
  const [newAssigneeIds, setNewAssigneeIds] = useState<string[]>([]);
  const [newPlatformIds, setNewPlatformIds] = useState<string[]>([]);
  const [newAttachments, setNewAttachments] = useState<StagedTaskAttachment[]>([]);
  const [newBatchId, setNewBatchId] = useState(() => crypto.randomUUID());
  const [pendingRecovery, setPendingRecovery] = useState<TaskCreateRecoveryRecord | null>(null);
  const [activeRecovery, setActiveRecovery] = useState<TaskCreateRecoveryRecord | null>(null);
  useEffect(() => {
    setIsCreateModalOpen(false);
    setActiveRecovery(null);
    setNewAttachments([]);
    setPendingRecovery(currentUserId ? readTaskCreateRecovery(currentUserId) : null);
  }, [currentUserId]);
  // Fetched via assignable_employees() RPC rather than filtering the local `users` prop — that
  // array is scoped by users_select_rls to the CURRENT viewer's own visibility, which for most
  // roles doesn't extend into every other department. See lib/departmentStaffing.ts.
  const [newTeamAssignees, setNewTeamAssignees] = useState<AssignableEmployee[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAssignableEmployees(newTeam).then((rows) => {
      if (cancelled) return;
      setNewTeamAssignees(rows);
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
  // Task Type (optional) — newTaskType holds a task_types.id, or '' for "no type selected".
  // newTaskTypeOther only applies when the selected row's is_other flag is set.
  const [newTaskType, setNewTaskType] = useState<string>('');
  const [newTaskTypeOther, setNewTaskTypeOther] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notification, setNotification] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  // Create-modal failure banner — rendered inline at the top of the modal itself, since the
  // page-level `notification` toast above renders in normal page flow and is visually covered by
  // the modal's full-viewport overlay while it's open.
  const [createError, setCreateError] = useState<string | null>(null);
  // Also rendered just above the Submit/Cancel buttons at the bottom of the (tall, scrollable)
  // form — the top banner alone can be scrolled out of view by the time a failed submit happens,
  // since the submit button that triggers it is at the bottom.
  const createErrorBottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (createError) createErrorBottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [createError]);

  // Edit task form state
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editClientId, setEditClientId] = useState('');
  const [editTeam, setEditTeam] = useState('');
  const [editAssigneeIds, setEditAssigneeIds] = useState<string[]>([]);
  const [editPlatformIds, setEditPlatformIds] = useState<string[]>([]);
  const [editAttachments, setEditAttachments] = useState<StagedTaskAttachment[]>([]);
  const [editTeamAssignees, setEditTeamAssignees] = useState<AssignableEmployee[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAssignableEmployees(editTeam).then((rows) => {
      if (cancelled) return;
      setEditTeamAssignees(rows);
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
  const [editTaskType, setEditTaskType] = useState<string>('');
  const [editTaskTypeOther, setEditTaskTypeOther] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  // Edit-modal failure banner — same reasoning as createError above.
  const [editError, setEditError] = useState<string | null>(null);
  const editErrorBottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editError) editErrorBottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editError]);

  const [capacitySnapshot, setCapacitySnapshot] = useState<Record<string, number>>({});
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [isCapacityLoading, setIsCapacityLoading] = useState(false);
  const capacityCandidateIds = useMemo(() => {
    if (isCreateModalOpen) return [...new Set([...newTeamAssignees.map((user) => user.id), ...newAssigneeIds])].sort();
    if (editingTask) return [...new Set([...editTeamAssignees.map((user) => user.id), ...editAssigneeIds])].sort();
    return [];
  }, [isCreateModalOpen, editingTask?.id, newTeamAssignees, newAssigneeIds, editTeamAssignees, editAssigneeIds]);
  const capacityCandidateKey = capacityCandidateIds.join('|');

  useEffect(() => {
    let cancelled = false;
    if (!capacityCandidateKey) {
      setCapacitySnapshot({});
      setCapacityError(null);
      return;
    }
    setIsCapacityLoading(true);
    setCapacityError(null);
    onGetCapacitySnapshot(capacityCandidateIds)
      .then((snapshot) => {
        if (!cancelled) setCapacitySnapshot(snapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setCapacitySnapshot({});
          setCapacityError(error instanceof Error ? error.message : 'Capacity data is unavailable.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsCapacityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [capacityCandidateKey, onGetCapacitySnapshot]);

  // The real, live role value for this app's UI/UX design employees is 'ui_designer' — NOT the
  // 'ui_ux_designer' literal baked into this repo's own UserRole type and used elsewhere (e.g.
  // capacity.ts's DAILY_WORK_CREATIVE_ROLES) — confirmed against production during the capacity
  // model audit. Typed as a plain string[] (not UserRole[]) so comparing against it doesn't
  // require 'ui_designer' to exist in that union — scoped to this one function, per this PR's
  // explicit single-file scope; every other 'ui_ux_designer' occurrence is left untouched.
  const PICKER_CREATIVE_ROLES: string[] = ['graphic_designer', 'video_editor', 'ui_designer'];

  // get_capacity_snapshot (20261119000000_capacity_snapshot_v2.sql) now measures the 3 creative
  // roles by today's delivered-task count against daily_task_target, not by the open-task/client
  // count the else branch (and resolveCapacityLimit's own default) still uses — so `used` here
  // means something different for them, and needs its own target + label.
  //
  // AssignableEmployee (lib/departmentStaffing.ts) has no daily_task_target field at all —
  // assignable_employees() never selects it — so resolveDailyTaskTarget's own "explicit
  // daily_task_target wins" branch can never apply here; it always falls through to its
  // team-based MAX_TASKS_PER_DAY default (or null off-Creative-team). A custom per-employee
  // target set via CapacityManagement.tsx is correctly reflected everywhere that screen and
  // DailyOperationsModule read it — just not in this specific picker's badge, a known, narrow
  // limitation of fixing only this one function (this PR's explicit scope), not a new bug.
  const capacityIndicator = (employee: AssignableEmployee) => {
    const used = capacitySnapshot[employee.id];
    if (used === undefined) return CAPACITY_UNKNOWN_INDICATOR;
    if (PICKER_CREATIVE_ROLES.includes(employee.role)) {
      const target = resolveDailyTaskTarget(employee as UserRecord);
      if (target === null) return `Delivered today: ${used}`;
      if (used >= target) return `🔴 Delivered today: ${used}/${target}`;
      if (used / target >= 0.75) return `🟡 Delivered today: ${used}/${target}`;
      return `🟢 Delivered today: ${used}/${target}`;
    }
    const limit = resolveCapacityLimit(employee as UserRecord);
    if (limit === 0) return CAPACITY_UNKNOWN_INDICATOR;
    if (used >= limit) return `🔴 ${used}/${limit}`;
    if (used / limit >= 0.75) return `🟡 ${used}/${limit}`;
    return `🟢 ${used}/${limit}`;
  };

  // Task Type options visible on the create form: active types scoped to either the selected
  // Team or the selected assignee's role — role is read from newTeamAssignees (the
  // assignable_employees() roster), never from the `users` prop, since that's scoped to the
  // current viewer's own RLS-limited visibility and may not include the chosen assignee at all.
  const newAssigneeOptions = useMemo(() => {
    const options = new Map<string, AssignableEmployee | UserRecord>(
      newTeamAssignees.map((user) => [user.id, user])
    );
    newAssigneeIds.forEach((id) => {
      const existing = taskDirectoryUsers.find((user) => user.id === id);
      if (existing && !options.has(id)) options.set(id, existing);
    });
    return [...options.values()].filter(
      (user) => user.role !== 'executive' && user.role !== 'head_of_technical'
    );
  }, [newTeamAssignees, newAssigneeIds, taskDirectoryUsers]);
  const newAssigneeRoles = newAssigneeOptions
    .filter((u) => newAssigneeIds.includes(u.id))
    .map((u) => u.role);
  const newAssigneeRole = newAssigneeRoles[0];

  // Designer-scheduling suggestion (create form only — a brand-new task has no existing due
  // date to "shift," so prefilling here is safe; the Edit form and Add-assignee flow below show
  // the same suggestion but never auto-write it, since those ARE an existing task's due date).
  // Re-suggests (and re-prefills) every time the set of selected CREATIVE assignees changes;
  // still freely editable afterward like any other form field.
  const [newSchedulingSuggestion, setNewSchedulingSuggestion] = useState<{
    dueDate: string;
    estimatedHours: number;
    warning: boolean;
    basedOnUserId: string;
    consideredCount: number;
    carriedOverCount: number;
  } | null>(null);
  const [isNewSchedulingLoading, setIsNewSchedulingLoading] = useState(false);
  const [newSchedulingError, setNewSchedulingError] = useState<string | null>(null);
  const newCreativeAssigneeIds = useMemo(() => {
    const creativeTeams = getCreativeTeams();
    return newAssigneeOptions.filter((u) => newAssigneeIds.includes(u.id) && isCreativeAssignee(u, creativeTeams)).map((u) => u.id);
  }, [newAssigneeOptions, newAssigneeIds]);
  const newCreativeAssigneeKey = newCreativeAssigneeIds.join('|');
  // Multi-client create: createTaskCopies (lib/taskOperations.ts) creates one task per selected
  // client, all sharing this same suggested due date — so a batch of N can push a day over the
  // cap even though any single task wouldn't. Locked to 1 in subtask mode (always a single
  // client, per addSubtaskParent's own client lock).
  const newCopiesCount = addSubtaskParent ? 1 : Math.max(1, newClientIds.length);
  useEffect(() => {
    let cancelled = false;
    if (!onGetUserScheduleLoad || !onGetServerToday || newCreativeAssigneeIds.length === 0 || activeRecovery) {
      setNewSchedulingSuggestion(null);
      setNewSchedulingError(null);
      return;
    }
    setIsNewSchedulingLoading(true);
    setNewSchedulingError(null);
    // "Today" comes from the server (Africa/Cairo), never guessed from the browser's own
    // clock/timezone — see onGetServerToday's own comment on the props interface above.
    onGetServerToday()
      .then((todayStr) => {
        if (cancelled) return;
        const toDate = addReportDays(todayStr, SUGGESTION_LOOKAHEAD_DAYS);
        return Promise.all(newCreativeAssigneeIds.map((id) => onGetUserScheduleLoad(id, todayStr, toDate)))
          .then((loads) => {
            if (cancelled) return;
            const loadByDateByUserId: Record<string, Record<string, number>> = {};
            const carriedOverCountByUserId: Record<string, number> = {};
            newCreativeAssigneeIds.forEach((id, index) => {
              loadByDateByUserId[id] = loads[index].loadByDate;
              carriedOverCountByUserId[id] = loads[index].carriedOverCount;
            });
            const mostLoadedId = pickMostLoadedAssignee(loadByDateByUserId, todayStr);
            if (!mostLoadedId) return;
            const suggestion = suggestDueDateAndHours({
              anchorDate: todayStr,
              loadByDate: loadByDateByUserId[mostLoadedId],
              taskCount: newCopiesCount,
              carriedOverCount: carriedOverCountByUserId[mostLoadedId],
            });
            setNewSchedulingSuggestion({
              dueDate: suggestion.dueDate,
              estimatedHours: suggestion.estimatedHours,
              warning: suggestion.warning,
              basedOnUserId: mostLoadedId,
              consideredCount: newCreativeAssigneeIds.length,
              carriedOverCount: carriedOverCountByUserId[mostLoadedId],
            });
            setNewDueDate(suggestion.dueDate);
            setNewEstimatedHours(suggestion.estimatedHours);
          });
      })
      .catch((error) => {
        if (!cancelled) setNewSchedulingError(error instanceof Error ? error.message : 'Unable to load schedule data.');
      })
      .finally(() => {
        if (!cancelled) setIsNewSchedulingLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newCreativeAssigneeKey, onGetUserScheduleLoad, onGetServerToday, activeRecovery, newCopiesCount]);

  const newTaskTypeOptions = useMemo(
    () =>
      taskTypes.filter(
        (t) =>
          t.is_active &&
          ((t.scope_type === 'team' && t.scope_value === newTeam) ||
            (t.scope_type === 'role' && newAssigneeRoles.includes(t.scope_value as UserRecord['role'])))
      ),
    [taskTypes, newTeam, newAssigneeRoles.join('|')]
  );
  const newSelectedTaskType = newTaskTypeOptions.find((t) => t.id === newTaskType);

  // Same as above for the edit form, with one addition: the task's CURRENT task_type is always
  // included even if it's since been deactivated or no longer matches the (possibly since-changed)
  // team/assignee — otherwise the select would have no option for it and silently drop it.
  const editAssigneeOptions = useMemo(() => {
    const options = new Map<string, AssignableEmployee | UserRecord>(
      editTeamAssignees.map((user) => [user.id, user])
    );
    editAssigneeIds.forEach((id) => {
      const existing = taskDirectoryUsers.find((user) => user.id === id);
      if (existing && !options.has(id)) options.set(id, existing);
    });
    return [...options.values()].filter(
      (user) => user.role !== 'executive' && user.role !== 'head_of_technical'
    );
  }, [editTeamAssignees, editAssigneeIds, taskDirectoryUsers]);
  const editAssigneeRoles = editAssigneeOptions
    .filter((u) => editAssigneeIds.includes(u.id))
    .map((u) => u.role);
  const editAssigneeRole = editAssigneeRoles[0];

  // Designer-scheduling suggestion for the Edit form — SHOWN only, never auto-written: this is
  // an EXISTING task's due date/estimated hours, and "never auto-shift existing due dates" (owner
  // decision) applies here. The AM/editor must explicitly click "Use suggestion" to copy it into
  // the (still freely editable) fields below.
  const [editSchedulingSuggestion, setEditSchedulingSuggestion] = useState<{
    dueDate: string;
    estimatedHours: number;
    warning: boolean;
    basedOnUserId: string;
    consideredCount: number;
    carriedOverCount: number;
  } | null>(null);
  const [isEditSchedulingLoading, setIsEditSchedulingLoading] = useState(false);
  const [editSchedulingError, setEditSchedulingError] = useState<string | null>(null);
  const editCreativeAssigneeIds = useMemo(() => {
    const creativeTeams = getCreativeTeams();
    return editAssigneeOptions.filter((u) => editAssigneeIds.includes(u.id) && isCreativeAssignee(u, creativeTeams)).map((u) => u.id);
  }, [editAssigneeOptions, editAssigneeIds]);
  const editCreativeAssigneeKey = editCreativeAssigneeIds.join('|');
  useEffect(() => {
    let cancelled = false;
    if (!onGetUserScheduleLoad || !onGetServerToday || editCreativeAssigneeIds.length === 0 || !editingTask) {
      setEditSchedulingSuggestion(null);
      setEditSchedulingError(null);
      return;
    }
    setIsEditSchedulingLoading(true);
    setEditSchedulingError(null);
    // "Today" comes from the server (Africa/Cairo), never guessed from the browser's own
    // clock/timezone — see onGetServerToday's own comment on the props interface above.
    onGetServerToday()
      .then((todayStr) => {
        if (cancelled) return;
        const toDate = addReportDays(todayStr, SUGGESTION_LOOKAHEAD_DAYS);
        return Promise.all(editCreativeAssigneeIds.map((id) => onGetUserScheduleLoad(id, todayStr, toDate)))
          .then((loads) => {
            if (cancelled) return;
            const loadByDateByUserId: Record<string, Record<string, number>> = {};
            const carriedOverCountByUserId: Record<string, number> = {};
            editCreativeAssigneeIds.forEach((id, index) => {
              loadByDateByUserId[id] = loads[index].loadByDate;
              carriedOverCountByUserId[id] = loads[index].carriedOverCount;
            });
            const mostLoadedId = pickMostLoadedAssignee(loadByDateByUserId, todayStr);
            if (!mostLoadedId) return;
            const suggestion = suggestDueDateAndHours({
              anchorDate: todayStr,
              loadByDate: loadByDateByUserId[mostLoadedId],
              carriedOverCount: carriedOverCountByUserId[mostLoadedId],
            });
            setEditSchedulingSuggestion({
              dueDate: suggestion.dueDate,
              estimatedHours: suggestion.estimatedHours,
              warning: suggestion.warning,
              basedOnUserId: mostLoadedId,
              consideredCount: editCreativeAssigneeIds.length,
              carriedOverCount: carriedOverCountByUserId[mostLoadedId],
            });
          });
      })
      .catch((error) => {
        if (!cancelled) setEditSchedulingError(error instanceof Error ? error.message : 'Unable to load schedule data.');
      })
      .finally(() => {
        if (!cancelled) setIsEditSchedulingLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editCreativeAssigneeKey, onGetUserScheduleLoad, onGetServerToday, editingTask?.id]);

  const editTaskTypeOptions = useMemo(() => {
    const active = taskTypes.filter(
      (t) =>
        t.is_active &&
        ((t.scope_type === 'team' && t.scope_value === editTeam) ||
          (t.scope_type === 'role' && editAssigneeRoles.includes(t.scope_value as UserRecord['role'])))
    );
    if (editTaskType && !active.some((t) => t.id === editTaskType)) {
      const current = taskTypes.find((t) => t.id === editTaskType);
      if (current) return [...active, current];
    }
    return active;
  }, [taskTypes, editTeam, editAssigneeRoles.join('|'), editTaskType]);
  const editSelectedTaskType = editTaskTypeOptions.find((t) => t.id === editTaskType);

  // Operational task assignees: strictly exclude Executive Management and Head of Technical —
  // neither receives personally-assigned task work (both see every task org-wide instead, via
  // task_visible()/isTaskAccessibleUnderRLS's unconditional leadership branch, so there's nothing
  // for them to be "assigned" into). AI Engineer is deliberately NOT excluded here — unlike
  // head_of_technical it does hands-on, personally-assigned work (data/roles.ts's own comment on
  // the ai_engineer entry, and its `my_work` module access), and tasks_insert_rls's assignee guard
  // (20261101100000_task_cross_team_visibility.sql) never blocks assigning a task to ai_engineer —
  // only to executive/head_of_technical. Excluding it here was a pre-existing mismatch with both.
  // Sales has no task-based work either, but is excluded upstream (the employee list this
  // function is ever called against doesn't include sales to begin with), not here.
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
  //
  // Everyone else's list is derived from getOperationalTeams() (departmentStaffing.ts, backed by
  // the custom-roles cache once loaded — PR 5) rather than a second hardcoded copy — this used to
  // duplicate that list by hand, which is exactly how it silently drifted out of sync (AI
  // Engineering was added to the shared list but missed here until that fix). "All Teams" is
  // prepended explicitly since the operational-teams list is real-departments-only, deliberately
  // without a catch-all value baked in. Recomputed every render (plain const, not memoized) so it
  // always reflects the cache's current state rather than freezing in whatever was true the first
  // time this component rendered.
  const teams =
    currentUser?.role === 'marketing_manager'
      ? [
          { id: 'all', label: 'All Teams' },
          { id: 'Creative', label: 'Creative' },
        ]
      : [
          { id: 'all', label: 'All Teams' },
          ...getOperationalTeams().map((t) => ({ id: t, label: t })),
        ];

  // Team options for the Create/Edit Task forms' own Team select — distinct from `teams` above
  // (the board's filter dropdown) and from getOperationalTeams() itself, which EmployeeAdminHub.tsx
  // and TaskTypeManager.tsx also depend on and must not be changed. 'Marketing' is offered to
  // everyone; 'Technical' only to executive. 'Executive' and 'Sales' are never offered — neither
  // does task-based work. Deliberately NOT a useMemo: getOperationalTeams() can change value (once
  // the cache finishes loading) independently of currentUser?.role, and a useMemo keyed only on the
  // latter would freeze a stale list until something else happened to change that one dependency.
  const taskFormTeams = [
    ...getOperationalTeams(),
    ...(currentUser?.role === 'executive' ? ['Marketing', 'Technical'] : ['Marketing']),
  ];

  // Employee-name filter options when the Team filter is at "All Teams" (or, for
  // marketing_manager, its synthetic "Creative" value — not a real OPERATIONAL_TEAMS entry, so
  // fetchAssignableEmployees has nothing to fetch for it). Only two roles get a real fallback list
  // here rather than the disabled "Select a team first" state (see employeeFilterDisabled below):
  // - executive/head_of_technical: everyone org-wide, any role (same as
  //   getAllowedEmployeeRolesUnderRLS) — their existing capability to browse any employee without
  //   picking a team first, preserved so it doesn't regress.
  // - marketing_manager: ONLY graphic_designer/video_editor, matching its existing narrow
  //   Creative-pool scope (see isAssignableForCurrentUser above) — used whenever selectedTeam is
  //   'Creative', which for this role is functionally "no real department selected" too.
  // Every other role (team leads included) gets no fallback list — they must pick a real
  // department first, at which point teamFilterEmployees (below) takes over.
  const noTeamSelectedFallbackRoles: string[] = useMemo(() => {
    const role = currentUser?.role;
    if (!role) return [];
    if (role === 'executive' || role === 'head_of_technical') {
      return getAllowedEmployeeRolesUnderRLS(role);
    }
    if (role === 'marketing_manager') {
      return ['graphic_designer', 'video_editor'];
    }
    return [];
  }, [currentUser?.role]);

  const noTeamSelectedFallbackOptions = useMemo(() => {
    if (noTeamSelectedFallbackRoles.length === 0) return [];
    return users
      .filter((u) => isOperationalAssignee(u) && noTeamSelectedFallbackRoles.includes(u.role) && isActiveEmployee(u))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users, noTeamSelectedFallbackRoles]);

  // "All Teams" is disabled for everyone except executive/head_of_technical — every other role
  // must pick a real department before the Employee filter offers anything (marketing_manager's
  // 'Creative' counts as "picked", so it's excluded from this check too).
  const employeeFilterDisabled =
    selectedTeam === 'all' && currentUser?.role !== 'executive' && currentUser?.role !== 'head_of_technical';

  // The Employee filter's actual rendered option list: a real department's fetched roster, or the
  // no-team-selected fallback for 'all'/'Creative'. UserRecord and AssignableEmployee both carry
  // id/name, which is all the <option> rendering below needs.
  const employeeFilterOptions: { id: string; name: string }[] = useMemo(() => {
    if (selectedTeam !== 'all' && selectedTeam !== 'Creative') {
      return teamFilterEmployees.filter(
        (employee) => employee.role !== 'executive' && employee.role !== 'head_of_technical'
      );
    }
    return noTeamSelectedFallbackOptions;
  }, [selectedTeam, teamFilterEmployees, noTeamSelectedFallbackOptions]);

  // Team changed out from under the current selection (or the filter just became disabled) —
  // never leave a stale pick in place, mirroring newAssignedTo/editAssignedTo's reset effect.
  useEffect(() => {
    if (selectedAssigneeId === 'all') return;
    if (employeeFilterDisabled || !employeeFilterOptions.some((u) => u.id === selectedAssigneeId)) {
      setSelectedAssigneeId('all');
    }
  }, [employeeFilterDisabled, employeeFilterOptions]);

  // Kanban Columns configuration. color already referenced a theme-aware token per status
  // (--grey/--purple-light/--roas-mid/--roas-good/--lilac/--roas-bad all have light-mode
  // overrides) — only badgeBg was a raw dark-mode-only rgba with no light counterpart.
  const columns: { id: TaskStatus; label: string; color: string; badgeBg: string }[] = [
    { id: 'todo', label: 'To Do', color: 'var(--grey)', badgeBg: 'var(--status-todo-tint)' },
    { id: 'in_progress', label: 'In Progress', color: 'var(--purple-light)', badgeBg: 'var(--status-progress-tint)' },
    { id: 'in_review', label: 'In Review', color: 'var(--roas-mid)', badgeBg: 'var(--status-review-tint)' },
    { id: 'completed', label: 'Completed', color: 'var(--roas-good)', badgeBg: 'var(--status-completed-tint)' },
    { id: 'closed', label: 'Closed', color: 'var(--lilac)', badgeBg: 'var(--status-closed-tint)' },
    { id: 'blocked', label: 'Blocked', color: 'var(--roas-bad)', badgeBg: 'var(--status-blocked-tint)' },
  ];

  // Helper date functions
  const todayStr = useMemo(() => getTodayStr(), []);
  
  // in_review is delivered, waiting on the client — never Overdue; neither is a revision
  // (revision_count > 0) even past its unmoved due_date (owner decision — see
  // isTaskOverdueForAssignee's own comment in lib/employeeWork.ts). Was a local reimplementation
  // of the same today/past-due check employeeWork.ts's own isTaskOverdue already did — now
  // delegates there instead of carrying a second copy of the rule.
  const isOverdue = (task: TaskRecord) => isTaskOverdueForAssignee(task, todayStr);

  // Browser-local calendar day of a timestamptz value, same formula as getTodayStr() — used to
  // compare tasks.completed_at (a timestamptz) against the plain YYYY-MM-DD the Completed On date
  // input gives us, without a UTC-offset mismatch.
  const toLocalDateStr = (iso: string): string => {
    const d = new Date(iso);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const isDueSoon = (task: TaskRecord) => {
    if (!task.due_date) return false;
    if (isTaskDone(task.status)) return false;
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
  const taskAssigneeIdsByTask = useMemo(
    () => new Map(tasks.map((task) => [
      task.id,
      resolveOrderedTaskAssigneeIds(task.id, taskAssignees, task.assigned_to),
    ])),
    [tasks, taskAssignees]
  );

  // task_platform_links membership per task, newest-link-first (mirrors taskAssigneeIdsByTask's
  // own shape so chip/filter code can read both the same way). Platforms carry no ordering
  // significance beyond display, so insertion order (created_at) is good enough — no "latest"
  // semantics to resolve, unlike assignees.
  const taskPlatformIdsByTask = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const link of taskPlatformLinks) {
      const existing = map.get(link.task_id);
      if (existing) existing.push(link.platform_id);
      else map.set(link.task_id, [link.platform_id]);
    }
    return map;
  }, [taskPlatformLinks]);

  // Active platforms, sorted for display — the option list every picker (create/edit forms,
  // filter) offers. Inactive platforms are deliberately excluded here (same as a retired task
  // type is excluded from newTaskTypeOptions) but stay resolvable for a task that already has one
  // via platformsById below.
  const activePlatformOptions = useMemo(
    () => platforms.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order),
    [platforms]
  );
  const platformsById = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  // Edit form's own option list: active platforms, plus any platform the task is currently
  // tagged with even if it's since been deactivated — same "never silently drop it" rule
  // editTaskTypeOptions applies to a task's current (possibly retired) task_type.
  const editPlatformOptions = useMemo(() => {
    const extra = editPlatformIds
      .filter((id) => !activePlatformOptions.some((p) => p.id === id))
      .map((id) => platformsById.get(id))
      .filter((p): p is PlatformRecord => !!p);
    return [...activePlatformOptions, ...extra];
  }, [activePlatformOptions, platformsById, editPlatformIds]);

  // 1. Check user visibility based on RLS rules. `tasks` (and so `topLevelTasks`) is already
  // exactly what tasks_select_rls/task_visible_v2 returned for this viewer — 'all' below shows
  // that set as-is, on purpose. 'my_tasks'/'my_team' are convenience NARROWINGS of that same set,
  // not a separate access decision, so they must never show MORE than 'all' and must never drop
  // a row 'all' already includes for a reason other than the toggle's own stated meaning.
  //
  // Audit finding (visibility audit, frontend): both previously read only the legacy single
  // `assigned_to` column — a co-assignee added via set_task_assignees after the first one is
  // invisible to both toggles even though 'all' (and the real RLS) already shows them the task.
  // Fixed via resolveTaskAssigneeIds (task_assignees membership, falling back to legacy
  // assigned_to only for a task with no task_assignees rows at all).
  const userVisibleTasks = useMemo(() => {
    if (visibilityScope === 'my_tasks') {
      return topLevelTasks.filter((t) =>
        t.created_by === currentUserId || (taskAssigneeIdsByTask.get(t.id) || []).includes(currentUserId)
      );
    }
    if (visibilityScope === 'my_team' && currentUser?.team) {
      return topLevelTasks.filter((t) => {
        if (t.team === currentUser.team) return true;
        const creatorTeam = taskDirectoryUsers.find((u) => u.id === t.created_by)?.team;
        if (creatorTeam === currentUser.team) return true;
        return (taskAssigneeIdsByTask.get(t.id) || [])
          .some((id) => taskDirectoryUsers.find((u) => u.id === id)?.team === currentUser.team);
      });
    }
    return topLevelTasks;
  }, [topLevelTasks, visibilityScope, currentUserId, currentUser, taskAssigneeIdsByTask, taskDirectoryUsers]);

  // 2. DASHBOARD KPI METRICS (Exact 7 requested indicators):
  // - Total Tasks
  // - Completed
  // - In Progress
  // - Pending (To Do)
  // - Overdue
  // - Unassigned
  // - Capacity utilization
  const totalTasksCount = userVisibleTasks.length;
  const completedTasksCount = userVisibleTasks.filter((t) => isTaskDone(t.status)).length;
  const inProgressTasksCount = userVisibleTasks.filter((t) => t.status === 'in_progress').length;
  const pendingTasksCount = userVisibleTasks.filter((t) => t.status === 'todo').length;
  const overdueTasksCount = userVisibleTasks.filter(isOverdue).length;
  const unassignedTasksCount = userVisibleTasks.filter((t) => (taskAssigneeIdsByTask.get(t.id) || []).length === 0).length;

  // Capacity utilization based on active operational users
  const capacityUtilization = useMemo(() => {
    const operational = users.filter((u) => u.capacity_limit && u.capacity_limit > 0);
    const totalLimits = operational.reduce((acc, u) => acc + (u.capacity_limit || 8), 0);
    const operationalIds = new Set(operational.map((user) => user.id));
    const activeAssignmentCount = tasks.reduce((count, task) => {
      if (isTaskDone(task.status)) return count;
      return count + (taskAssigneeIdsByTask.get(task.id) || []).filter((id) => operationalIds.has(id)).length;
    }, 0);
    return totalLimits > 0 ? Math.round((activeAssignmentCount / totalLimits) * 100) : 0;
  }, [users, tasks, taskAssigneeIdsByTask]);

  // 3. Filtered Tasks for Kanban / Table display
  const filteredTasks = useMemo(() => {
    return userVisibleTasks.filter((t) => {
      const assigneeIds = taskAssigneeIdsByTask.get(t.id) || [];
      const assignees = assigneeIds
        .map((id) => taskDirectoryUsers.find((user) => user.id === id))
        .filter((user): user is UserRecord => !!user);

      // Quick filter
      if (quickFilter === 'overdue' && !isOverdue(t)) return false;
      if (quickFilter === 'due_soon' && !isDueSoon(t)) return false;
      if (quickFilter === 'unassigned' && assigneeIds.length > 0) return false;
      if (quickFilter === 'my_tasks' && t.created_by !== currentUserId && !assigneeIds.includes(currentUserId)) return false;

      // Completed On date filter — only tasks actually completed (completed_at set) on that exact
      // local calendar day. A task never completed (completed_at null) never matches, regardless
      // of its current status.
      if (completedOnDate && (!t.completed_at || toLocalDateStr(t.completed_at) !== completedOnDate)) return false;

      // Due On date filter — every task due that day, any status included.
      if (dueOnDate && t.due_date !== dueOnDate) return false;

      // Team filter. 'Creative' is a synthetic, assignee-ROLE-scoped value (only ever offered to
      // marketing_manager, see `teams` above) — the literal task.team column splits across
      // "Creative & Design"/"Video Production" for graphic_designer/video_editor, so it can't be
      // matched directly.
      if (selectedTeam === 'Creative') {
        if (!assignees.some((assignee) => assignee.role === 'graphic_designer' || assignee.role === 'video_editor')) return false;
      } else if (
        selectedTeam !== 'all' &&
        t.team !== selectedTeam &&
        !assignees.some((assignee) => assignee.team === selectedTeam)
      ) {
        return false;
      }

      // Client filter
      if (selectedClient !== 'all' && t.client_id !== selectedClient) return false;

      // Priority filter
      if (selectedPriority !== 'all' && t.priority !== selectedPriority) return false;

      // Status filter
      if (selectedStatus !== 'all' && t.status !== selectedStatus) return false;

      // Employee-name filter (role-scoped dropdown, distinct from the free-text search below)
      if (selectedAssigneeId !== 'all' && !assigneeIds.includes(selectedAssigneeId)) return false;

      // Platform filter — matches ANY selected platform (an empty selection means "no filter").
      if (selectedPlatformIds.length > 0) {
        const platformIds = taskPlatformIdsByTask.get(t.id) || [];
        if (!selectedPlatformIds.some((id) => platformIds.includes(id))) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const client = clients.find((c) => c.id === t.client_id);
        const matchTitle = t.title.toLowerCase().includes(query);
        const matchDesc = t.description ? t.description.toLowerCase().includes(query) : false;
        const matchClient = client ? client.name.toLowerCase().includes(query) : false;
        const matchAssignee = assignees.some((assignee) => assignee.name.toLowerCase().includes(query));
        if (!matchTitle && !matchDesc && !matchClient && !matchAssignee) {
          return false;
        }
      }

      return true;
    });
  }, [
    userVisibleTasks,
    quickFilter,
    completedOnDate,
    dueOnDate,
    selectedTeam,
    selectedClient,
    selectedPriority,
    selectedStatus,
    selectedAssigneeId,
    selectedPlatformIds,
    searchQuery,
    clients,
    taskDirectoryUsers,
    taskAssigneeIdsByTask,
    taskPlatformIdsByTask,
    currentUserId,
    todayStr,
  ]);

  // Date-sorted view of filteredTasks — a separate pass so the filter predicate above stays pure
  // "which tasks" logic and this stays pure "what order". [...array] before sort() because Array
  // .sort() mutates in place, and filteredTasks is a useMemo result other code may still read.
  const sortedTasks = useMemo(() => {
    const withDate = (t: TaskRecord) => {
      const value = t.created_at || t.due_date;
      const time = value ? new Date(value).getTime() : NaN;
      return Number.isNaN(time) ? 0 : time;
    };
    return [...filteredTasks].sort((a, b) =>
      taskSortOrder === 'newest' ? withDate(b) - withDate(a) : withDate(a) - withDate(b)
    );
  }, [filteredTasks, taskSortOrder]);

  // Handlers
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    if (!newTitle.trim() || newClientIds.length === 0 || !newDescription.trim() || !newDueDate) {
      setCreateError('Title, at least one client, description, and due date are required to create a task.');
      return;
    }

    setIsSubmitting(true);
    try {
      const currentInput: CreateTaskFormInput = {
        clientIds: addSubtaskParent ? [addSubtaskParent.client_id] : newClientIds,
        assigneeIds: newAssigneeIds,
        title: newTitle.trim(),
        description: newDescription.trim(),
        team: newTeam,
        dueDate: newDueDate,
        priority: newPriority,
        estimatedHours: newEstimatedHours,
        parentTaskId: addSubtaskParent?.id || null,
        batchId: newBatchId,
        taskType: newSelectedTaskType ? newTaskType : null,
        taskTypeOther: newSelectedTaskType?.is_other ? newTaskTypeOther.trim() || null : null,
        attachments: newAttachments,
        platformIds: newPlatformIds,
      };

      let submission = currentInput;
      if (activeRecovery) {
        const expectedAttachments = activeRecovery.attachments.filter((attachment) => attachment.status !== 'confirmed');
        const filesToMatch = newAttachments.filter((entry) => !activeRecovery.attachments.some(
          (descriptor) => descriptor.id === entry.id && descriptor.status === 'confirmed'
        ));
        const attachmentMatch = await matchRecoveryAttachments(filesToMatch, expectedAttachments);
        if (attachmentMatch.missing.length > 0 || attachmentMatch.unexpected.length > 0) {
          const missing = attachmentMatch.missing.map((attachment) => attachment.name).join(', ');
          const unexpected = attachmentMatch.unexpected.join(', ');
          throw new Error([
            missing ? `Re-select the original attachment files: ${missing}.` : '',
            unexpected ? `These files do not match the recovery record: ${unexpected}.` : '',
          ].filter(Boolean).join(' '));
        }
        submission = { ...activeRecovery.input, batchId: activeRecovery.batchId, attachments: attachmentMatch.matched };
      } else {
        const existingRecovery = readTaskCreateRecovery(currentUserId);
        if (existingRecovery) {
          setPendingRecovery(existingRecovery);
          setIsCreateModalOpen(false);
          throw new Error('An incomplete Create batch already exists. Resume or explicitly discard it before starting another task.');
        }
        const recovery = await createTaskRecovery(currentUserId, currentInput);
        saveTaskCreateRecovery(recovery);
        setActiveRecovery(recovery);
        submission = {
          ...recovery.input,
          batchId: recovery.batchId,
          attachments: currentInput.attachments.map((attachment) => ({
            ...attachment,
            sha256: recovery.attachments.find((descriptor) => descriptor.id === attachment.id)?.sha256,
          })),
        };
      }

      await onCreateTask(submission);

      setIsCreateModalOpen(false);
      setActiveRecovery(null);
      setPendingRecovery(null);
      setAddSubtaskParent(null);
      setNewTitle('');
      setNewDescription('');
      setNewEstimatedHours(8);
      setNewAssigneeIds([]);
      setNewPlatformIds([]);
      setNewAttachments([]);
      setNewBatchId(crypto.randomUUID());
      setNewTaskType('');
      setNewTaskTypeOther('');
      setNotification({
        text: addSubtaskParent
          ? 'Subtask created successfully.'
          : `${newClientIds.length} task ${newClientIds.length === 1 ? 'copy was' : 'copies were'} created successfully.`,
        type: 'success',
      });
      setTimeout(() => setNotification(null), 3500);
    } catch (err: any) {
      console.error(err);
      const recovery = currentUserId ? readTaskCreateRecovery(currentUserId) : null;
      setActiveRecovery(recovery);
      setCreateError(`Failed to create task: ${err?.message || 'Unknown Supabase error.'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resumeRecovery = (recovery: TaskCreateRecoveryRecord) => {
    setCreateError(null);
    setPendingRecovery(null);
    setActiveRecovery(recovery);
    setNewBatchId(recovery.batchId);
    setNewClientIds(recovery.input.clientIds);
    setNewAssigneeIds(recovery.input.assigneeIds);
    setNewPlatformIds(recovery.input.platformIds || []);
    setNewTitle(recovery.input.title);
    setNewDescription(recovery.input.description);
    setNewTeam(recovery.input.team);
    setNewDueDate(recovery.input.dueDate);
    setNewPriority(recovery.input.priority);
    setNewEstimatedHours(recovery.input.estimatedHours ?? 0);
    setNewTaskType(recovery.input.taskType || '');
    setNewTaskTypeOther(recovery.input.taskTypeOther || '');
    setAddSubtaskParent(recovery.input.parentTaskId
      ? tasks.find((task) => task.id === recovery.input.parentTaskId) || null
      : null);
    setNewAttachments((current) => current.filter((attachment) =>
      recovery.attachments.some((descriptor) => descriptor.id === attachment.id && descriptor.status !== 'confirmed')
    ));
    setIsCreateModalOpen(true);
  };

  const discardRecovery = () => {
    if (!pendingRecovery && !activeRecovery) return;
    const recovery = pendingRecovery || activeRecovery;
    if (!recovery || !window.confirm('Discard this recovery record? Any task copies already saved in Supabase will remain and will not be deleted.')) return;
    clearTaskCreateRecovery(currentUserId, recovery.batchId);
    setPendingRecovery(null);
    setActiveRecovery(null);
    setIsCreateModalOpen(false);
    setNewAttachments([]);
    setNewBatchId(crypto.randomUUID());
  };

  // Details-modal "Add assignee"/remove (re-assign chain, section B). Both go through
  // onUpdateTask(taskId, {}, fullNewAssigneeList) — an empty `updates` object means
  // handleUpdateTask (App.tsx) skips the tasks-row update entirely and only calls
  // set_task_assignees, keeping this fully separate from ordinary task-field edits. The RPC
  // itself re-derives add/remove from the full list it's given and refuses to drop the creator;
  // this only needs to pass the right full list and surface whatever error comes back.
  const handleAddAssignee = async (userId: string) => {
    if (!selectedTaskDetails || !onUpdateTask) return;
    setAssigneeActionError(null);
    setAddAssigneeSuggestion(null);
    setIsSavingAssignees(true);
    try {
      const currentIds = resolveTaskAssigneeIds(selectedTaskDetails.id, taskAssignees, selectedTaskDetails.assigned_to);
      await onUpdateTask(selectedTaskDetails.id, {}, [...currentIds, userId]);

      // Designer-scheduling suggestion — SHOWN only; this task already has a due date, so it is
      // never auto-written (owner decision: never auto-shift an existing due date). "Today"
      // comes from the server (Africa/Cairo), never guessed from the browser's own
      // clock/timezone — see onGetServerToday's own comment on the props interface above.
      const addedUser = orgWideAssignableEmployees?.find((employee) => employee.id === userId);
      if (addedUser && onGetUserScheduleLoad && onGetServerToday && isCreativeAssignee(addedUser)) {
        try {
          const todayStr = await onGetServerToday();
          const toDate = addReportDays(todayStr, SUGGESTION_LOOKAHEAD_DAYS);
          const { loadByDate, carriedOverCount } = await onGetUserScheduleLoad(userId, todayStr, toDate);
          const suggestion = suggestDueDateAndHours({ anchorDate: todayStr, loadByDate, carriedOverCount });
          setAddAssigneeSuggestion({
            dueDate: suggestion.dueDate,
            estimatedHours: suggestion.estimatedHours,
            warning: suggestion.warning,
            userName: addedUser.name,
            carriedOverCount,
          });
        } catch {
          // Suggestion is informational only — a failed lookup here must never block or report
          // an error for the assignee add itself, which already succeeded above.
        }
      }
    } catch (err) {
      setAssigneeActionError(err instanceof Error ? err.message : 'Unable to add this assignee.');
    } finally {
      setIsSavingAssignees(false);
    }
  };

  const handleApplyAddAssigneeSuggestion = async () => {
    if (!selectedTaskDetails || !onUpdateTask || !addAssigneeSuggestion) return;
    setIsApplyingAddAssigneeSuggestion(true);
    try {
      await onUpdateTask(selectedTaskDetails.id, {
        due_date: addAssigneeSuggestion.dueDate,
        estimated_hours: addAssigneeSuggestion.estimatedHours,
      });
      setAddAssigneeSuggestion(null);
    } catch (err) {
      setAssigneeActionError(err instanceof Error ? err.message : 'Unable to apply the suggested date and hours.');
    } finally {
      setIsApplyingAddAssigneeSuggestion(false);
    }
  };

  const handleRemoveAssignee = async (userId: string) => {
    if (!selectedTaskDetails || !onUpdateTask) return;
    setAssigneeActionError(null);
    setIsSavingAssignees(true);
    try {
      const currentIds = resolveTaskAssigneeIds(selectedTaskDetails.id, taskAssignees, selectedTaskDetails.assigned_to);
      await onUpdateTask(selectedTaskDetails.id, {}, currentIds.filter((id) => id !== userId));
    } catch (err) {
      setAssigneeActionError(err instanceof Error ? err.message : 'Unable to remove this assignee.');
    } finally {
      setIsSavingAssignees(false);
    }
  };

  const openEditModal = (task: TaskRecord) => {
    setEditError(null);
    setEditingTask(task);
    setEditTitle(task.title);
    setEditDescription(task.description || '');
    setEditClientId(task.client_id);
    setEditTeam(task.team || 'SEO');
    const currentAssigneeIds = taskAssignees
      .filter((row) => row.task_id === task.id)
      .map((row) => row.user_id);
    setEditAssigneeIds(currentAssigneeIds.length > 0 ? currentAssigneeIds : (task.assigned_to ? [task.assigned_to] : []));
    setEditPlatformIds(taskPlatformLinks.filter((row) => row.task_id === task.id).map((row) => row.platform_id));
    setEditAttachments([]);
    setEditDueDate(task.due_date || '');
    setEditPriority(task.priority);
    setEditStatus(task.status);
    setEditEstimatedHours(task.estimated_hours || 0);
    setEditActualHours(task.actual_hours || 0);
    setEditTaskType(task.task_type || '');
    setEditTaskTypeOther(task.task_type_other || '');
  };

  // Opens the Create Task modal in "subtask" mode: client locked to the
  // parent's, parent_task_id attached on submit. parentTask may itself be a
  // subtask (adding a level-3 sub-subtask) — SubtaskList only ever calls
  // this at levels 1-2, since nesting is capped at 3.
  const openAddSubtaskModal = (parentTask: TaskRecord) => {
    const recovery = readTaskCreateRecovery(currentUserId);
    if (recovery) {
      setPendingRecovery(recovery);
      return;
    }
    setCreateError(null);
    setAddSubtaskParent(parentTask);
    setNewTitle('');
    setNewDescription('');
    setNewClientIds([parentTask.client_id]);
    setNewTeam(parentTask.team || 'SEO');
    setNewAssigneeIds([]);
    setNewPlatformIds([]);
    setNewAttachments([]);
    setNewBatchId(crypto.randomUUID());
    setNewDueDate(new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0]);
    setNewPriority('medium');
    setNewEstimatedHours(8);
    setNewTaskType('');
    setNewTaskTypeOther('');
    setIsCreateModalOpen(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !onUpdateTask) return;
    setEditError(null);
    if (!editTitle.trim() || !editDescription.trim() || !editDueDate) {
      setEditError('Title, description, and due date are all required — none can be cleared.');
      return;
    }

    setIsUpdating(true);
    const finalTaskType = editSelectedTaskType ? editTaskType : null;
    const finalTaskTypeOther = editSelectedTaskType?.is_other ? editTaskTypeOther.trim() || null : null;
    try {
      await onUpdateTask(editingTask.id, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        client_id: editClientId,
        team: editTeam,
        due_date: editDueDate,
        priority: editPriority,
        status: editStatus,
        estimated_hours: editEstimatedHours,
        actual_hours: editActualHours,
        task_type: finalTaskType,
        task_type_other: finalTaskTypeOther,
      }, editAssigneeIds, editAttachments, editPlatformIds);

      // Update selected details if open
      if (selectedTaskDetails && selectedTaskDetails.id === editingTask.id) {
        setSelectedTaskDetails({
          ...selectedTaskDetails,
          title: editTitle.trim(),
          description: editDescription.trim(),
          client_id: editClientId,
          team: editTeam,
          assigned_to: editAssigneeIds[0] || null,
          due_date: editDueDate,
          priority: editPriority,
          status: editStatus,
          estimated_hours: editEstimatedHours,
          actual_hours: editActualHours,
          task_type: finalTaskType,
          task_type_other: finalTaskTypeOther,
        });
      }

      setEditingTask(null);
      setEditAttachments([]);
      setNotification({ text: 'Task details updated successfully.', type: 'success' });
      setTimeout(() => setNotification(null), 3500);
    } catch (err: any) {
      console.error(err);
      setEditError(`Error updating task: ${err?.message || 'Unknown Supabase error.'}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleMoveStatus = async (taskId: string, targetStatus: TaskStatus) => {
    // 'closed' is the one transition every other status change here is deliberately NOT gated
    // for: the task must have reached 'completed' first, and the mover must be the task's
    // creator, any current assignee, or an admin role (canCloseTask/canSubmitTaskForClosing in
    // lib/taskLifecycle.ts) — matched server-side by tasks_update_rls. A Done Link is optional and
    // never required to close a task. Every other target status is unrestricted, same as before.
    if (targetStatus === 'closed') {
      const task = tasks.find((t) => t.id === taskId);
      const denyReason = !task
        ? 'Task not found.'
        : !currentUser || !canCloseTask(task, currentUser, taskAssignees)
        ? 'Only the task\'s creator, any current assignee, or Executive/Head of Technical/AI Engineer can close it.'
        : !canSubmitTaskForClosing(task)
        ? 'This task must reach Completed before it can be closed.'
        : null;
      if (denyReason) {
        setNotification({ text: denyReason, type: 'error' });
        setTimeout(() => setNotification(null), 3500);
        return;
      }
    }
    try {
      await onUpdateTaskStatus(taskId, targetStatus);
      if (selectedTaskDetails && selectedTaskDetails.id === taskId) {
        setSelectedTaskDetails({ ...selectedTaskDetails, status: targetStatus });
      }
    } catch (err) {
      console.error(err);
      // onUpdateTaskStatus now throws (and makes no local-state change) on a real write
      // failure, instead of silently reporting success — surface that here so a failed drag/
      // Stage-arrow/Details-modal move doesn't look like it worked when it didn't.
      setNotification({ text: 'Unable to update task status. Please try again.', type: 'error' });
      setTimeout(() => setNotification(null), 3500);
    }
  };

  const handleSaveDoneLink = async () => {
    if (!selectedTaskDetails || !onUpdateTask) return;
    const nextValue = doneLinkDraft.trim() || null;
    setIsSavingDoneLink(true);
    try {
      await onUpdateTask(selectedTaskDetails.id, { done_link: nextValue });
      setSelectedTaskDetails({ ...selectedTaskDetails, done_link: nextValue });
    } finally {
      setIsSavingDoneLink(false);
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
        return { label: 'Urgent', bg: 'var(--priority-urgent-tint)', text: 'var(--roas-bad)', border: 'var(--priority-urgent-border)' };
      case 'high':
        return { label: 'High', bg: 'var(--priority-high-tint)', text: 'var(--priority-high-ink)', border: 'var(--priority-high-border)' };
      case 'medium':
        return { label: 'Medium', bg: 'var(--priority-medium-tint)', text: 'var(--roas-mid)', border: 'var(--priority-medium-border)' };
      case 'low':
        return { label: 'Low', bg: 'var(--priority-low-tint)', text: 'var(--grey)', border: 'var(--priority-low-border)' };
      default:
        return { label: priority, bg: 'var(--priority-default-tint)', text: 'var(--white)', border: 'transparent' };
    }
  };

  // Team badge helper
  const getTeamColor = (teamName?: string | null) => {
    switch (teamName) {
      case 'SEO':
        return { text: 'var(--team-seo-ink)', bg: 'var(--team-seo-tint)' };
      case 'Social Media':
        return { text: 'var(--team-social-media-ink)', bg: 'var(--team-social-media-tint)' };
      case 'Media Buying':
        return { text: 'var(--team-media-buying-ink)', bg: 'var(--team-media-buying-tint)' };
      case 'Creative & Design':
        return { text: 'var(--team-creative-ink)', bg: 'var(--team-creative-tint)' };
      case 'Video Production':
        return { text: 'var(--team-video-ink)', bg: 'var(--team-video-tint)' };
      case 'Programming':
        return { text: 'var(--team-programming-ink)', bg: 'var(--team-programming-tint)' };
      case 'Account Management':
        return { text: 'var(--team-am-ink)', bg: 'var(--team-am-tint)' };
      default:
        return { text: 'var(--grey)', bg: 'var(--team-default-tint)' };
    }
  };

  return (
    <div className="space-y-6">
      {pendingRecovery && !isCreateModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-amber-500/40 bg-stone-950 p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
              <div>
                <h3 className="font-bold text-white">Incomplete task batch found</h3>
                <p className="mt-1 text-xs text-stone-300">
                  {pendingRecovery.confirmedClientIds.length} of {pendingRecovery.input.clientIds.length} client copies are confirmed complete.
                  Resume with the original locked inputs, or explicitly discard this recovery record.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={discardRecovery} className="rounded-lg px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-950/40">
                Discard recovery
              </button>
              <button type="button" onClick={() => resumeRecovery(pendingRecovery)} className="rounded-lg bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-500">
                Resume batch
              </button>
            </div>
          </div>
        </div>
      )}
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

          {/* Task Types admin entry point — executive/head_of_technical only, matching
              task_types_write_rls/task_types_update_rls server-side. */}
          {canManageTaskTypes && (
            <button
              onClick={() => setIsTaskTypeManagerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-stone-300 hover:text-white bg-white/5 hover:bg-white/10 border border-stone-800 transition-all shrink-0"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Task Types</span>
            </button>
          )}

          {/* Platforms admin entry point — executive/head_of_technical only, matching
              platforms_write_rls/platforms_update_rls server-side. */}
          {canManagePlatforms && (
            <button
              onClick={() => setIsPlatformManagerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-stone-300 hover:text-white bg-white/5 hover:bg-white/10 border border-stone-800 transition-all shrink-0"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Platforms</span>
            </button>
          )}

          {/* Create Task Button */}
          {!isUiUxDesigner && <button
            onClick={() => {
              const recovery = readTaskCreateRecovery(currentUserId);
              if (recovery) {
                setPendingRecovery(recovery);
                return;
              }
              setCreateError(null);
              setActiveRecovery(null);
              setAddSubtaskParent(null);
              setNewBatchId(crypto.randomUUID());
              setNewAttachments([]);
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
          </button>}
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
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-10 gap-3 pt-2">
          {/* Date Sort — order only, never changes which tasks are included (that's quick
              filter/the dropdowns below). Defaults to Newest First. */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Sort by Date:</label>
            <select
              value={taskSortOrder}
              onChange={(e) => setTaskSortOrder(e.target.value as 'newest' | 'oldest')}
              className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="newest" className="bg-stone-900 text-white">Newest First</option>
              <option value="oldest" className="bg-stone-900 text-white">Oldest First</option>
            </select>
          </div>

          {/* Completed On date filter — shows only tasks actually completed on that exact day.
              Empty = no filter (the default). */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Completed On:</label>
            <div className="relative">
              <input
                type="date"
                value={completedOnDate}
                onChange={(e) => setCompletedOnDate(e.target.value)}
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500 [color-scheme:dark]"
              />
              {completedOnDate && (
                <button
                  type="button"
                  onClick={() => setCompletedOnDate('')}
                  aria-label="Clear completed-on date filter"
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Due On date filter — every task due that day, any status (To Do, In Progress,
              Completed, …). Empty = no filter (the default). */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Due On:</label>
            <div className="relative">
              <input
                type="date"
                value={dueOnDate}
                onChange={(e) => setDueOnDate(e.target.value)}
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500 [color-scheme:dark]"
              />
              {dueOnDate && (
                <button
                  type="button"
                  onClick={() => setDueOnDate('')}
                  aria-label="Clear due-on date filter"
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

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

          {/* Employee Filter — depends on the Team filter above (see employeeFilterOptions) */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Employee:</label>
            {employeeFilterDisabled ? (
              <select
                disabled
                value="all"
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/40 border border-stone-800 text-stone-500 cursor-not-allowed"
              >
                <option value="all">Select a team first</option>
              </select>
            ) : (
              <select
                value={selectedAssigneeId}
                onChange={(e) => setSelectedAssigneeId(e.target.value)}
                className="w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
              >
                <option value="all" className="bg-stone-900 text-white">All Employees</option>
                {employeeFilterOptions.map((u) => (
                  <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                    {u.name}
                  </option>
                ))}
              </select>
            )}
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

          {/* Platform Filter — matches ANY selected platform */}
          <div>
            <label className="text-[11px] font-semibold block mb-1 text-stone-400">Platform:</label>
            <SearchableMultiSelect
              options={activePlatformOptions.map((p) => ({ id: p.id, label: p.name }))}
              selectedIds={selectedPlatformIds}
              onChange={setSelectedPlatformIds}
              placeholder="All platforms"
              searchPlaceholder="Search platforms…"
              emptyMessage="No platforms available."
            />
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
        <DndContext sensors={dndSensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex items-start gap-4 overflow-x-auto px-1 pb-4 pt-1 overscroll-x-contain">
            {columns.map((column) => {
              const columnTasks = sortedTasks.filter((t) => t.status === column.id);
              return (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  columns={columns}
                  tasks={columnTasks}
                  allTasks={tasks}
                  clients={clients}
                  users={taskDirectoryUsers}
                  taskAssignees={taskAssignees}
                  platforms={platforms}
                  taskPlatformLinks={taskPlatformLinks}
                  isOverdue={isOverdue}
                  isDueSoon={isDueSoon}
                  onOpenDetails={setSelectedTaskDetails}
                  onEditTask={openEditModal}
                  onMoveStatus={handleMoveStatus}
                  canUseBulkActions={canUseBulkActions}
                  selectedTaskIds={selectedTaskIds}
                  onToggleTaskSelection={toggleTaskSelection}
                  onToggleColumnSelection={toggleColumnSelection}
                />
              );
            })}
          </div>

          <DragOverlay>
            {draggingTask &&
              (() => {
                const subtasks = tasks.filter((t) => t.parent_task_id === draggingTask.id);
                const assigneeNames = (taskAssigneeIdsByTask.get(draggingTask.id) || [])
                  .map((id) => taskDirectoryUsers.find((user) => user.id === id)?.name || 'Unknown employee');
                const creatorName = taskDirectoryUsers.find((user) => user.id === draggingTask.created_by)?.name || 'Unknown';
                const platformNames = (taskPlatformIdsByTask.get(draggingTask.id) || [])
                  .map((id) => platformsById.get(id)?.name)
                  .filter((name): name is string => !!name);
                return (
                  <KanbanTaskCardContent
                    task={draggingTask}
                    client={clients.find((c) => c.id === draggingTask.client_id)}
                    assigneeNames={assigneeNames}
                    platformNames={platformNames}
                    creatorName={creatorName}
                    subtaskDone={subtasks.filter((t) => isTaskDone(t.status)).length}
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
                  {canUseBulkActions && (
                    <th className="p-3.5 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all tasks"
                        checked={sortedTasks.length > 0 && sortedTasks.every((t) => selectedTaskIds.has(t.id))}
                        onChange={(e) => {
                          setSelectedTaskIds(e.target.checked ? new Set(sortedTasks.map((t) => t.id)) : new Set());
                        }}
                      />
                    </th>
                  )}
                  <th className="p-3.5">Task</th>
                  <th className="p-3.5">Client</th>
                  <th className="p-3.5">Assignee</th>
                  <th className="p-3.5">Team</th>
                  <th className="p-3.5">Platforms</th>
                  <th className="p-3.5 text-center">Priority</th>
                  <th className="p-3.5 text-center">Status</th>
                  <th className="p-3.5 text-center">Created</th>
                  <th className="p-3.5 text-center">Due Date</th>
                  <th className="p-3.5 text-center">Est. Hours</th>
                  <th className="p-3.5 text-center">Act. Hours</th>
                  <th className="p-3.5 text-center">Done Link</th>
                  <th className="p-3.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {sortedTasks.length === 0 ? (
                  <tr>
                    <td colSpan={canUseBulkActions ? 14 : 13} className="p-8 text-center text-stone-400">
                      No tasks matching current filter criteria.
                    </td>
                  </tr>
                ) : (
                  sortedTasks.map((task) => {
                    const client = clients.find((c) => c.id === task.client_id);
                    const assigneeNames = (taskAssigneeIdsByTask.get(task.id) || [])
                      .map((id) => taskDirectoryUsers.find((user) => user.id === id)?.name || 'Unknown employee');
                    const primaryAssigneeName = assigneeNames[0];
                    const platformNames = (taskPlatformIdsByTask.get(task.id) || [])
                      .map((id) => platformsById.get(id)?.name)
                      .filter((name): name is string => !!name);
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
                        {canUseBulkActions && (
                          <td className="p-3.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${task.title}`}
                              checked={selectedTaskIds.has(task.id)}
                              onChange={(e) => {
                                setSelectedTaskIds((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(task.id);
                                  else next.delete(task.id);
                                  return next;
                                });
                              }}
                            />
                          </td>
                        )}
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
                            const done = subtasks.filter((t) => isTaskDone(t.status)).length;
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
                          {primaryAssigneeName ? (
                            <div className="flex items-center gap-1.5" title={assigneeNames.join(', ')}>
                              <div
                                className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[9px]"
                                style={{ background: 'var(--gradient-badge)', color: 'white' }}
                              >
                                {primaryAssigneeName.charAt(0)}
                              </div>
                              <span className="text-stone-200">{primaryAssigneeName}</span>
                              {assigneeNames.length > 1 && (
                                <span className="rounded-full bg-purple-900/50 px-1.5 py-0.5 text-[9px] font-bold text-purple-200">
                                  +{assigneeNames.length - 1}
                                </span>
                              )}
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
                        <td className="p-3.5">
                          {platformNames.length > 0 ? (
                            <div className="flex flex-wrap gap-1 max-w-[160px]">
                              {platformNames.map((name) => (
                                <span
                                  key={name}
                                  className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-sky-950/50 text-sky-300 border border-sky-800/50"
                                >
                                  {name}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-stone-500">—</span>
                          )}
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
                          {/* Revision: real workload the client sent back — never shown as
                              Overdue (owner decision), shown here instead so a management board
                              can tell a first pass from a revision at a glance. */}
                          {(task.revision_count ?? 0) > 0 && (
                            <span className="block text-[9px] text-amber-400 font-sans font-bold mt-0.5">
                              Revision #{task.revision_count}
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-center font-mono text-stone-400">
                          {task.created_at ? task.created_at.split('T')[0] : '—'}
                          <span className="block text-[9px] text-stone-500 font-sans">
                            {taskDirectoryUsers.find((user) => user.id === task.created_by)?.name || 'Unknown'}
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
                          {task.done_link ? (
                            <a
                              href={task.done_link}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-purple-300 hover:text-white"
                              title={task.done_link}
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
                            {!isUiUxDesigner && <button
                              onClick={() => openEditModal(task)}
                              className="p-1.5 rounded-lg bg-stone-800 text-stone-300 hover:text-purple-300"
                              title="Edit Task"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>}
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
          tasks={sortedTasks}
          clients={clients}
          users={taskDirectoryUsers}
          onSelectTask={setSelectedTaskDetails}
        />
      )}

      {/* Reserves space at the bottom of the board's own content while the floating bulk
          toolbar below is visible, so it never covers the last Table row / Kanban card. A
          fixed estimate of the toolbar's typical max height (count row + one open panel),
          not a measured value — exact pixel alignment isn't required here. */}
      {canUseBulkActions && selectedTaskIds.size > 0 && <div className="h-40" />}

      {canUseBulkActions && selectedTaskIds.size > 0 && (() => {
        const toolbarBtnClass = (active: boolean) =>
          `flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
            active ? 'bg-purple-600 text-white' : 'bg-stone-800 text-stone-200 hover:bg-stone-700'
          }`;
        const togglePanel = (panel: BulkPanel) => {
          setBulkSelectionError(null);
          setBulkPanel((prev) => (prev === panel ? null : panel));
          if (panel === 'assignees') loadOrgWideAssignableEmployees();
        };

        return (
          <div
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[min(94vw,680px)] rounded-2xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200 max-h-[70vh] overflow-y-auto"
            style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
          >
            <div className="p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-purple-300">{selectedTaskIds.size} task(s) selected</span>
                <button onClick={clearBulkSelection} className="text-[11px] text-stone-400 hover:text-white underline">
                  Clear selection
                </button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button onClick={() => togglePanel('status')} className={toolbarBtnClass(bulkPanel === 'status')}>
                  <PlayCircle className="w-3.5 h-3.5" /> Status
                </button>
                <button onClick={() => togglePanel('priority')} className={toolbarBtnClass(bulkPanel === 'priority')}>
                  <Flag className="w-3.5 h-3.5" /> Priority
                </button>
                <button onClick={() => togglePanel('dueDate')} className={toolbarBtnClass(bulkPanel === 'dueDate')}>
                  <Calendar className="w-3.5 h-3.5" /> Due date
                </button>
                <button onClick={() => togglePanel('assignees')} className={toolbarBtnClass(bulkPanel === 'assignees')}>
                  <UserCheck className="w-3.5 h-3.5" /> Assignees
                </button>
                <button onClick={() => togglePanel('move')} className={toolbarBtnClass(bulkPanel === 'move')}>
                  <ArrowRightLeft className="w-3.5 h-3.5" /> Move
                </button>
                {onDuplicateTask && (
                  <button onClick={() => togglePanel('duplicate')} className={toolbarBtnClass(bulkPanel === 'duplicate')}>
                    <Layers className="w-3.5 h-3.5" /> Duplicate
                  </button>
                )}
                {canDeleteTasks && (
                  <button
                    onClick={() => setDeleteModalTaskIds([...selectedTaskIds])}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-red-600 text-white hover:bg-red-500"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete ({selectedTaskIds.size})
                  </button>
                )}
              </div>
            </div>

            {bulkSelectionError && (
              <div className="px-3 pb-2 text-[11px] text-red-400">{bulkSelectionError}</div>
            )}

            {bulkPanel === 'status' && (
              <div className="p-3 border-t border-stone-800 flex flex-wrap items-center gap-2">
                <select
                  value={bulkStatusDraft}
                  onChange={(e) => setBulkStatusDraft(e.target.value as TaskStatus)}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>{col.label}</option>
                  ))}
                </select>
                <button
                  disabled={isBulkRunning}
                  onClick={() => {
                    const label = columns.find((c) => c.id === bulkStatusDraft)?.label || bulkStatusDraft;
                    setBulkConfirm({
                      description: `Change status to "${label}" for ${selectedTaskIds.size} task(s)?`,
                      run: () =>
                        runBulk('Change status', {
                          canPerform: (taskId) => {
                            const task = tasks.find((t) => t.id === taskId);
                            if (!task || !currentUser) return { allowed: false, reason: 'Task not found.' };
                            return checkBulkStatusChange(task, bulkStatusDraft, currentUser, taskAssignees);
                          },
                          perform: async (taskId) => {
                            await onUpdateTaskStatus(taskId, bulkStatusDraft);
                            setSelectedTaskDetails((prev) =>
                              prev && prev.id === taskId ? { ...prev, status: bulkStatusDraft } : prev
                            );
                          },
                        }),
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}

            {bulkPanel === 'priority' && (
              <div className="p-3 border-t border-stone-800 flex flex-wrap items-center gap-2">
                <select
                  value={bulkPriorityDraft}
                  onChange={(e) => setBulkPriorityDraft(e.target.value as TaskPriority)}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                >
                  {(['low', 'medium', 'high', 'urgent'] as TaskPriority[]).map((p) => (
                    <option key={p} value={p}>{getPriorityBadge(p).label}</option>
                  ))}
                </select>
                <button
                  disabled={isBulkRunning || !onUpdateTask}
                  onClick={() => {
                    const label = getPriorityBadge(bulkPriorityDraft).label;
                    setBulkConfirm({
                      description: `Change priority to "${label}" for ${selectedTaskIds.size} task(s)?`,
                      run: () =>
                        runBulk('Change priority', {
                          canPerform: () => ({ allowed: true }),
                          perform: (taskId) => onUpdateTask!(taskId, { priority: bulkPriorityDraft }),
                        }),
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}

            {bulkPanel === 'dueDate' && (
              <div className="p-3 border-t border-stone-800 flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={bulkDueDateDraft}
                  onChange={(e) => setBulkDueDateDraft(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                />
                <button
                  disabled={isBulkRunning || !onUpdateTask || !bulkDueDateDraft}
                  onClick={() => {
                    setBulkConfirm({
                      description: `Change due date to ${bulkDueDateDraft} for ${selectedTaskIds.size} task(s)? No other date is moved automatically.`,
                      run: () =>
                        runBulk('Change due date', {
                          canPerform: () => ({ allowed: true }),
                          perform: (taskId) => onUpdateTask!(taskId, { due_date: bulkDueDateDraft }),
                        }),
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}

            {bulkPanel === 'assignees' && (
              <div className="p-3 border-t border-stone-800 space-y-2">
                <div className="flex items-center gap-1.5">
                  {(['add', 'replace', 'remove'] as BulkAssigneeMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setBulkAssigneeMode(mode)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold capitalize ${
                        bulkAssigneeMode === mode ? 'bg-purple-600 text-white' : 'bg-stone-800 text-stone-300 hover:text-white'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <SearchableMultiSelect
                  options={(orgWideAssignableEmployees || []).map((employee) => ({
                    id: employee.id,
                    label: employee.name,
                    sublabel: employee.team || employee.role,
                  }))}
                  selectedIds={bulkAssigneeIds}
                  onChange={setBulkAssigneeIds}
                  placeholder={isLoadingOrgWideEmployees ? 'Loading employees…' : 'Pick people…'}
                  searchPlaceholder="Search by name, any department…"
                  emptyMessage={isLoadingOrgWideEmployees ? 'Loading employees…' : 'No one available.'}
                />
                <button
                  disabled={isBulkRunning || !onUpdateTask || bulkAssigneeIds.length === 0}
                  onClick={() => {
                    setBulkConfirm({
                      description: `${bulkAssigneeMode === 'add' ? 'Add' : bulkAssigneeMode === 'remove' ? 'Remove' : 'Replace'} ${bulkAssigneeIds.length} assignee(s) on ${selectedTaskIds.size} task(s)?`,
                      run: () =>
                        runBulk('Update assignees', {
                          canPerform: (taskId) => {
                            const task = tasks.find((t) => t.id === taskId);
                            if (!task || !currentUser) return { allowed: false, reason: 'Task not found.' };
                            return checkBulkAssigneeEdit(task, currentUser, taskAssignees, users, clients);
                          },
                          perform: async (taskId) => {
                            const task = tasks.find((t) => t.id === taskId);
                            if (!task) throw new Error('Task not found.');
                            const currentIds = resolveTaskAssigneeIds(taskId, taskAssignees, task.assigned_to);
                            const nextIds = resolveBulkAssigneeIds(bulkAssigneeMode, currentIds, bulkAssigneeIds);
                            await onUpdateTask!(taskId, {}, nextIds);
                          },
                        }),
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}

            {bulkPanel === 'move' && (
              <div className="p-3 border-t border-stone-800 flex flex-wrap items-center gap-2">
                <select
                  value={bulkMoveClientId}
                  onChange={(e) => setBulkMoveClientId(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                >
                  <option value="">Client: no change</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
                <select
                  value={bulkMoveTeam}
                  onChange={(e) => setBulkMoveTeam(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                >
                  <option value="">Team: no change</option>
                  {getOperationalTeams().map((team) => (
                    <option key={team} value={team}>{team}</option>
                  ))}
                </select>
                <button
                  disabled={isBulkRunning || !onUpdateTask || (!bulkMoveClientId && !bulkMoveTeam)}
                  onClick={() => {
                    const parts = [
                      bulkMoveClientId ? `client to "${clients.find((c) => c.id === bulkMoveClientId)?.name}"` : null,
                      bulkMoveTeam ? `team to "${bulkMoveTeam}"` : null,
                    ].filter(Boolean);
                    setBulkConfirm({
                      description: `Move ${parts.join(' and ')} for ${selectedTaskIds.size} task(s)?`,
                      run: () =>
                        runBulk('Move', {
                          canPerform: () => ({ allowed: true }),
                          perform: (taskId) => {
                            const updates: Partial<TaskRecord> = {};
                            if (bulkMoveClientId) updates.client_id = bulkMoveClientId;
                            if (bulkMoveTeam) updates.team = bulkMoveTeam;
                            return onUpdateTask!(taskId, updates);
                          },
                        }),
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}

            {bulkPanel === 'duplicate' && onDuplicateTask && (
              <div className="p-3 border-t border-stone-800 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-stone-300">
                  <input
                    type="checkbox"
                    checked={bulkDuplicateIncludeSubtasks}
                    onChange={(e) => setBulkDuplicateIncludeSubtasks(e.target.checked)}
                  />
                  Include subtasks
                </label>
                <button
                  disabled={isBulkRunning}
                  onClick={() => {
                    setBulkConfirm({
                      description: `Duplicate ${selectedTaskIds.size} task(s)${bulkDuplicateIncludeSubtasks ? ', including their subtasks' : ''}? Comments, attachments, and the Done Link are never copied; status starts at To Do.`,
                      run: () =>
                        runBulk('Duplicate', {
                          canPerform: () =>
                            currentUser ? checkBulkDuplicate(currentUser) : { allowed: false, reason: 'Not signed in.' },
                          perform: (taskId) => onDuplicateTask(taskId, bulkDuplicateIncludeSubtasks),
                        }),
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        );
      })()}

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
              <div className="flex items-center gap-1">
                {canDeleteTasks && (
                  <button
                    onClick={() => setDeleteModalTaskIds([selectedTaskDetails.id])}
                    className="p-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-950/40"
                    title="Delete Task"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => setSelectedTaskDetails(null)}
                  className="p-1 rounded-lg text-stone-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Details / History tab switcher */}
            <div className="flex items-center gap-1 border-b border-stone-800">
              <button
                type="button"
                onClick={() => setActiveDetailsTab('details')}
                className={`px-3 py-2 text-xs font-bold border-b-2 transition-colors ${
                  activeDetailsTab === 'details'
                    ? 'border-purple-400 text-white'
                    : 'border-transparent text-stone-400 hover:text-white'
                }`}
              >
                Details
              </button>
              <button
                type="button"
                onClick={() => setActiveDetailsTab('history')}
                className={`px-3 py-2 text-xs font-bold border-b-2 transition-colors ${
                  activeDetailsTab === 'history'
                    ? 'border-purple-400 text-white'
                    : 'border-transparent text-stone-400 hover:text-white'
                }`}
              >
                History
              </button>
            </div>

            {activeDetailsTab === 'history' ? (
              <TaskHistoryTab
                events={taskEvents}
                users={taskDirectoryUsers}
                getStatusLabel={(status) => columns.find((c) => c.id === status)?.label || status}
                getPriorityLabel={(priority) => getPriorityBadge(priority as TaskPriority).label}
                isLoading={isLoadingTaskEvents}
                error={taskEventsError}
                onRetry={() => setTaskEventsReloadToken((t) => t + 1)}
                legacyActivities={legacyActivities}
                legacyAssigneeLog={legacyAssigneeLog}
                isLoadingLegacyHistory={isLoadingLegacyHistory}
                legacyHistoryError={legacyHistoryError}
                onRetryLegacyHistory={() => setLegacyHistoryReloadToken((t) => t + 1)}
              />
            ) : (
            <div className="space-y-4">
              {/* Description */}
              <div>
                <label className="text-[11px] font-semibold text-stone-400 block mb-1">Description & Deliverables:</label>
                <div className="p-3 rounded-xl bg-stone-900/80 border border-stone-800 text-xs text-stone-200 leading-relaxed">
                  {selectedTaskDetails.description || 'No detailed description provided.'}
                </div>
              </div>

              {/* Client */}
              <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
                <label className="text-[10px] text-stone-400 block mb-1">Client:</label>
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-purple-400" />
                  <span className="text-xs font-bold text-white">
                    {clients.find((c) => c.id === selectedTaskDetails.client_id)?.name || 'Unassigned'}
                  </span>
                </div>
              </div>

              {/* Creator — tasks.created_by, resolved from the already-loaded user directory (no
                  per-task fetch). A created_by that doesn't match anyone in it falls back to
                  'Unknown' rather than guessing. */}
              <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
                <label className="text-[10px] text-stone-400 block mb-1">Created by:</label>
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-purple-400" />
                  <span className="text-xs font-bold text-white">
                    {taskDirectoryUsers.find((user) => user.id === selectedTaskDetails.created_by)?.name || 'Unknown'}
                  </span>
                  <span className="text-[10px] text-stone-500">
                    · {selectedTaskDetails.created_at ? selectedTaskDetails.created_at.split('T')[0] : '—'}
                  </span>
                </div>
              </div>

              {/* Assignees (re-assign chain, section B): the creator's chip is never removable
                  (the RPC enforces this too; this just avoids showing a control that would only
                  ever fail). Only a viewer canEditTaskAssignees() mirrors as eligible gets the
                  remove "x"/Add control — everyone else sees the exact same chips read-only. */}
              <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
                <label className="text-[10px] text-stone-400 block mb-1">Assignees:</label>
                {(() => {
                  const resolvedIds = resolveTaskAssigneeIds(selectedTaskDetails.id, taskAssignees, selectedTaskDetails.assigned_to);
                  const canEdit = !!currentUser && !!onUpdateTask &&
                    canEditTaskAssignees(selectedTaskDetails, currentUser, taskAssignees, users, clients);
                  const addAssigneeOptions = (orgWideAssignableEmployees || [])
                    .filter((employee) => !resolvedIds.includes(employee.id))
                    .map((employee) => {
                      const used = addAssigneeCapacitySnapshot[employee.id];
                      const limit = resolveCapacityLimit(employee as UserRecord);
                      const badge = used === undefined || limit === 0 ? CAPACITY_UNKNOWN_INDICATOR : `${used}/${limit}`;
                      return { id: employee.id, label: employee.name, sublabel: employee.team || employee.role, badge };
                    });
                  return (
                    <>
                      <div className="flex items-start gap-2">
                        <User className="w-4 h-4 mt-0.5 text-purple-400 shrink-0" />
                        <div className="flex flex-wrap gap-1">
                          {resolvedIds.length === 0 && <span className="text-xs font-semibold text-amber-400">Unassigned</span>}
                          {resolvedIds.map((id) => {
                            const isCreatorChip = id === selectedTaskDetails.created_by;
                            const removable = canEdit && !isCreatorChip;
                            // The actual task_assignees row for this (task, user) pair — not just
                            // the id resolveTaskAssigneeIds() returns — so added_by/created_at can
                            // be shown. Missing for the legacy assigned_to fallback case (a task
                            // predating task_assignees with no row at all): shown as '—', never
                            // guessed from anything else.
                            const assigneeRow = taskAssignees.find(
                              (ta) => ta.task_id === selectedTaskDetails.id && ta.user_id === id
                            );
                            const addedById = assigneeRow?.added_by ?? null;
                            const addedByName = addedById
                              ? taskDirectoryUsers.find((user) => user.id === addedById)?.name || 'Unknown'
                              : '—';
                            const assignedAtDate = assigneeRow?.created_at ? assigneeRow.created_at.split('T')[0] : '—';
                            return (
                              <span key={id} className="flex flex-col gap-0.5">
                                <span className="flex items-center gap-1 rounded-full bg-purple-900/40 px-2 py-0.5 text-[10px] font-semibold text-purple-200">
                                  {taskDirectoryUsers.find((user) => user.id === id)?.name || 'Unknown employee'}
                                  {isCreatorChip && <span className="text-purple-400">(creator)</span>}
                                  {removable && (
                                    <button
                                      type="button"
                                      disabled={isSavingAssignees}
                                      onClick={() => handleRemoveAssignee(id)}
                                      className="rounded-full p-0.5 hover:bg-white/10 disabled:opacity-50"
                                      title="Remove assignee"
                                    >
                                      <X className="h-2.5 w-2.5" />
                                    </button>
                                  )}
                                </span>
                                <span className="text-[9px] text-stone-500 px-2">
                                  Assigned by {addedByName} · {assignedAtDate}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      {canEdit && (
                        <div className="mt-2">
                          {isAddAssigneeOpen ? (
                            <SearchableMultiSelect
                              options={addAssigneeOptions}
                              selectedIds={[]}
                              onChange={(ids) => ids[0] && handleAddAssignee(ids[0])}
                              disabled={isSavingAssignees}
                              placeholder={isLoadingOrgWideEmployees ? 'Loading employees…' : 'Pick someone to add…'}
                              searchPlaceholder="Search by name, any department…"
                              emptyMessage={isLoadingOrgWideEmployees ? 'Loading employees…' : 'No one else available to add.'}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                loadOrgWideAssignableEmployees();
                                setIsAddAssigneeOpen(true);
                              }}
                              className="flex items-center gap-1 rounded-lg border border-purple-700/40 bg-purple-900/20 px-2 py-1 text-[11px] font-semibold text-purple-300 hover:bg-purple-800/40 hover:text-white"
                            >
                              <PlusCircle className="h-3 w-3" /> Add assignee
                            </button>
                          )}
                          {assigneeActionError && (
                            <p className="mt-1 text-[10px] font-semibold text-red-400">{assigneeActionError}</p>
                          )}
                          {/* Designer-scheduling suggestion for the just-added creative assignee —
                              SHOWN only; this task's existing due date is left as-is unless
                              explicitly applied (never auto-shift an existing due date). */}
                          {addAssigneeSuggestion && (
                            <div className={`mt-2 p-2 rounded-lg text-[10px] border flex items-center justify-between gap-2 flex-wrap ${
                              addAssigneeSuggestion.warning
                                ? 'bg-amber-950/20 border-amber-700/40 text-amber-200'
                                : 'bg-stone-900/60 border-stone-800 text-stone-400'
                            }`}>
                              <span>
                                Suggested for {addAssigneeSuggestion.userName}: {addAssigneeSuggestion.dueDate}, {addAssigneeSuggestion.estimatedHours.toFixed(2)}h.
                                {' '}This task's due date is unchanged unless applied.
                                {addAssigneeSuggestion.warning && ` That day is already at or near the ${MAX_TASKS_PER_DAY}/day limit.`}
                                {addAssigneeSuggestion.carriedOverCount > 0 &&
                                  ` ${addAssigneeSuggestion.carriedOverCount} overdue open task${addAssigneeSuggestion.carriedOverCount === 1 ? '' : 's'} carried over.`}
                              </span>
                              <button
                                type="button"
                                onClick={handleApplyAddAssigneeSuggestion}
                                disabled={isApplyingAddAssigneeSuggestion}
                                className="shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
                              >
                                {isApplyingAddAssigneeSuggestion ? 'Applying…' : 'Apply'}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Platforms — read-only display; edited only via the Edit Task form. */}
              {(() => {
                const platformNames = (taskPlatformIdsByTask.get(selectedTaskDetails.id) || [])
                  .map((id) => platformsById.get(id)?.name)
                  .filter((name): name is string => !!name);
                if (platformNames.length === 0) return null;
                return (
                  <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
                    <label className="text-[10px] text-stone-400 block mb-1">Platforms:</label>
                    <div className="flex flex-wrap gap-1.5">
                      {platformNames.map((name) => (
                        <span
                          key={name}
                          className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-950/50 text-sky-300 border border-sky-800/50"
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}

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

              {/* Done Link — the one general-purpose task link field (owner decision: Drive Link
                  has been removed everywhere). Optional on every task; shown from 'in_progress'
                  onward OR whenever a value is already set regardless of status (e.g. a
                  backfilled task that's since moved back to 'todo'/'blocked' — see
                  canShowDoneLink()); never required to close a task (canSubmitTaskForClosing()). */}
              {canShowDoneLink(selectedTaskDetails) && (
                <div>
                  <label className="text-[11px] font-semibold text-stone-400 mb-1.5 flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5" />
                    <span>Done Link:</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={doneLinkDraft}
                      onChange={(e) => setDoneLinkDraft(e.target.value)}
                      placeholder="Link to the finished work (Drive, Figma, ...)"
                      disabled={selectedTaskDetails.status === 'closed'}
                      className="flex-1 px-3 py-2 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-60"
                    />
                    {onUpdateTask && selectedTaskDetails.status !== 'closed' && doneLinkDraft !== (selectedTaskDetails.done_link || '') && (
                      <button
                        onClick={handleSaveDoneLink}
                        disabled={isSavingDoneLink}
                        className="px-3 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 shrink-0"
                      >
                        {isSavingDoneLink ? 'Saving...' : 'Save'}
                      </button>
                    )}
                    {selectedTaskDetails.done_link && (
                      <a
                        href={selectedTaskDetails.done_link}
                        target="_blank"
                        rel="noreferrer"
                        className="p-2 rounded-xl bg-stone-900/80 border border-stone-800 text-purple-300 hover:text-white shrink-0"
                        title="Open in new tab"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                  {selectedTaskDetails.status === 'completed' && currentUser && canCloseTask(selectedTaskDetails, currentUser, taskAssignees) && (
                    <button
                      onClick={() => handleMoveStatus(selectedTaskDetails.id, 'closed')}
                      disabled={!canSubmitTaskForClosing(selectedTaskDetails)}
                      title={!canSubmitTaskForClosing(selectedTaskDetails) ? 'This task must reach Completed before it can be closed.' : undefined}
                      className="mt-2 px-3 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Close Task
                    </button>
                  )}
                </div>
              )}

              {/* Move Status directly from details */}
              <div>
                <label className="text-[11px] font-semibold text-stone-400 block mb-1.5">
                  Update Status:
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
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
                      {col.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Subtask completion nudge — never automatic, just a one-click suggestion */}
              {(() => {
                const directSubtasks = tasks.filter((t) => t.parent_task_id === selectedTaskDetails.id);
                const allSubtasksDone =
                  directSubtasks.length > 0 && directSubtasks.every((t) => isTaskDone(t.status));
                if (!allSubtasksDone || isTaskDone(selectedTaskDetails.status)) return null;
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
                    {!isUiUxDesigner && <button
                      onClick={() => openAddSubtaskModal(selectedTaskDetails)}
                      className="text-[11px] font-bold text-purple-300 hover:text-purple-200 flex items-center gap-1"
                    >
                      <PlusCircle className="w-3.5 h-3.5" />
                      Add Subtask
                    </button>}
                  </div>
                  <SubtaskList
                    parentTask={selectedTaskDetails}
                    allTasks={tasks}
                    users={taskDirectoryUsers}
                    level={2}
                    onAddSubtask={openAddSubtaskModal}
                    onEditSubtask={openEditModal}
                    readOnly={isUiUxDesigner}
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
                    users={taskDirectoryUsers}
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
                    users={taskDirectoryUsers}
                    currentUserId={currentUserId}
                    onAddComment={onAddTaskComment}
                    onEditComment={onEditTaskComment}
                    onDeleteComment={onDeleteTaskComment}
                  />
                </div>
              )}
            </div>
            )}

            {/* Modal Actions */}
            <div className="pt-3 border-t border-stone-800 flex items-center justify-between">
              {!isUiUxDesigner && <button
                onClick={() => {
                  const taskToEdit = selectedTaskDetails;
                  setSelectedTaskDetails(null);
                  openEditModal(taskToEdit);
                }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-stone-200 bg-stone-800 hover:bg-stone-700 flex items-center gap-1.5"
              >
                <Edit2 className="w-3.5 h-3.5" />
                <span>Edit Task</span>
              </button>}

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
            className="relative max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-[22px] p-6 shadow-2xl"
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
                  if (activeRecovery) {
                    setPendingRecovery(readTaskCreateRecovery(currentUserId));
                    setActiveRecovery(null);
                  } else {
                    setNewBatchId(crypto.randomUUID());
                    setNewAttachments([]);
                  }
                }}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {createError && (
              <div className="p-3 rounded-xl text-xs flex items-center justify-between gap-3 bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="font-semibold">{createError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setCreateError(null)}
                  className="text-xs opacity-70 hover:opacity-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {activeRecovery && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-200">
                Recovery mode: task details, clients, and assignees are locked to the original batch. Attachments marked incomplete must be re-selected with identical contents.
              </div>
            )}

            <form onSubmit={handleCreateSubmit} className="space-y-3.5">
              {/* Client Selection — locked to the parent's client when adding a subtask */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  {addSubtaskParent ? 'Client:' : 'Clients:'}
                </label>
                {addSubtaskParent ? (
                  <div className="w-full rounded-xl border border-stone-800 bg-stone-900 px-3 py-2 text-xs text-white opacity-70">
                    {clients.find((client) => client.id === addSubtaskParent.client_id)?.name || addSubtaskParent.client_id}
                  </div>
                ) : (
                  <SearchableMultiSelect
                    options={clients.map((client) => ({ id: client.id, label: client.name, sublabel: client.industry || 'Client' }))}
                    selectedIds={newClientIds}
                    onChange={setNewClientIds}
                    disabled={!!activeRecovery}
                    placeholder="Select clients…"
                    searchPlaceholder="Search clients…"
                    emptyMessage="No clients available."
                  />
                )}
              </div>

              {/* Task Title */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Task Title:
                </label>
                <input
                  type="text"
                  disabled={!!activeRecovery}
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
                  disabled={!!activeRecovery}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Provide technical specifications and deliverables..."
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500 resize-none"
                  required
                />
              </div>

              {/* Team and Assignee with Live Capacity Check */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Team:
                  </label>
                  <select
                    disabled={!!activeRecovery}
                    value={newTeam}
                    onChange={(e) => setNewTeam(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  >
                    {taskFormTeams.map((t) => (
                      <option key={t} value={t} className="bg-stone-900 text-white">{t}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Assignees (Operational Only):
                  </label>
                  <SearchableMultiSelect
                    options={newAssigneeOptions.map((user) => ({
                      id: user.id,
                      label: user.name,
                      sublabel: user.team || user.role,
                      badge: capacityIndicator(user),
                    }))}
                    selectedIds={newAssigneeIds}
                    onChange={setNewAssigneeIds}
                    disabled={!!activeRecovery}
                    placeholder="Select assignees…"
                    searchPlaceholder="Search by name…"
                    emptyMessage="No assignable employees."
                  />
                  {(isCapacityLoading || capacityError) && (
                    <p className={`mt-1 text-[10px] ${capacityError ? 'text-amber-400' : 'text-stone-500'}`}>
                      {capacityError || 'Loading verified capacity…'}
                    </p>
                  )}
                </div>
              </div>

              {/* Platforms (optional) — always shown, same posture as Task Type below */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Platforms (optional):
                </label>
                <SearchableMultiSelect
                  options={activePlatformOptions.map((p) => ({ id: p.id, label: p.name }))}
                  selectedIds={newPlatformIds}
                  onChange={setNewPlatformIds}
                  disabled={!!activeRecovery}
                  placeholder="Select platforms…"
                  searchPlaceholder="Search platforms…"
                  emptyMessage="No platforms available."
                />
              </div>

              {/* Task Type (optional) — always shown, same as every other role; never required.
                  Managers (executive/head_of_technical) additionally get the Add type/Edit types
                  controls below, so they can add the first type for a new team/role right from
                  here. */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Task Type (optional):
                </label>
                {canManageTaskTypes && !activeRecovery && (
                  <div className="mb-1.5">
                    <TaskTypeInlineManager
                      taskTypes={taskTypes}
                      scopeTeam={newTeam}
                      scopeRole={newAssigneeRole}
                      onSelectType={setNewTaskType}
                      onCreateTaskType={onCreateTaskType}
                      onUpdateTaskType={onUpdateTaskType}
                    />
                  </div>
                )}
                <select
                  disabled={!!activeRecovery}
                  value={newTaskType}
                  onChange={(e) => setNewTaskType(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="" className="bg-stone-900 text-stone-400">-- No Task Type --</option>
                  {newTaskTypeOptions.map((t) => (
                    <option key={t.id} value={t.id} className="bg-stone-900 text-white">{t.label}</option>
                  ))}
                </select>
                {newSelectedTaskType?.is_other && (
                  <input
                    type="text"
                    disabled={!!activeRecovery}
                    dir="auto"
                    value={newTaskTypeOther}
                    onChange={(e) => setNewTaskTypeOther(e.target.value)}
                    placeholder="Describe the task type..."
                    className="w-full mt-2 px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                )}
              </div>

              {/* Designer-scheduling suggestion — prefills Due Date/Estimated Hours below
                  whenever a creative assignee is selected; both fields stay freely editable
                  afterward. */}
              {(isNewSchedulingLoading || newSchedulingError || newSchedulingSuggestion) && (
                <div className={`p-2.5 rounded-xl text-[11px] border ${
                  newSchedulingSuggestion?.warning
                    ? 'bg-amber-950/20 border-amber-700/40 text-amber-200'
                    : 'bg-stone-900/60 border-stone-800 text-stone-400'
                }`}>
                  {isNewSchedulingLoading && 'Checking schedule…'}
                  {newSchedulingError && `Schedule suggestion unavailable: ${newSchedulingError}`}
                  {!isNewSchedulingLoading && !newSchedulingError && newSchedulingSuggestion && (
                    <>
                      Suggested Due Date and Estimated Hours set below, based on{' '}
                      {newAssigneeOptions.find((u) => u.id === newSchedulingSuggestion.basedOnUserId)?.name || 'the assignee'}
                      {newSchedulingSuggestion.consideredCount > 1
                        ? ` (the most loaded of ${newSchedulingSuggestion.consideredCount} creative assignees)`
                        : ''}
                      's schedule — editable below.
                      {newCopiesCount > 1 ? ` Creating ${newCopiesCount} copies (one per client), all on this date.` : ''}
                      {newSchedulingSuggestion.warning && ` This day is already at or near the ${MAX_TASKS_PER_DAY}/day limit${newCopiesCount > 1 ? ' once these copies are added' : ''}.`}
                      {newSchedulingSuggestion.carriedOverCount > 0 &&
                        ` ${newSchedulingSuggestion.carriedOverCount} overdue open task${newSchedulingSuggestion.carriedOverCount === 1 ? '' : 's'} carried over.`}
                    </>
                  )}
                </div>
              )}

              {/* Priority & Due Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Priority:
                  </label>
                  <select
                    disabled={!!activeRecovery}
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
                    disabled={!!activeRecovery}
                    value={newDueDate}
                    onChange={(e) => setNewDueDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">Estimated Hours:</label>
                <input
                  type="number"
                  disabled={!!activeRecovery}
                  min="0.5"
                  step="0.01"
                  value={newEstimatedHours}
                  onChange={(e) => setNewEstimatedHours(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-stone-300">Attachments:</label>
                {activeRecovery?.attachments.some((attachment) => attachment.status !== 'confirmed') && (
                  <div className="mb-2 space-y-1 rounded-lg border border-amber-700/40 bg-amber-950/20 p-2">
                    {activeRecovery.attachments.filter((attachment) => attachment.status !== 'confirmed').map((attachment) => (
                      <p key={attachment.id} className="text-[10px] text-amber-200">
                        Re-select exactly: {attachment.name} ({attachment.status === 'manual_review' ? 'manual review required if metadata is still not visible' : 'safe metadata retry pending'})
                      </p>
                    ))}
                  </div>
                )}
                <TaskAttachmentPicker files={newAttachments} onChange={setNewAttachments} disabled={isSubmitting} />
              </div>

              {createError && (
                <div
                  ref={createErrorBottomRef}
                  className="p-3 rounded-xl text-xs flex items-center justify-between gap-3 bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]"
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span className="font-semibold">{createError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreateError(null)}
                    className="text-xs opacity-70 hover:opacity-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Submit Buttons */}
              <div className="pt-3 border-t border-stone-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateModalOpen(false);
                    setAddSubtaskParent(null);
                    if (activeRecovery) {
                      setPendingRecovery(readTaskCreateRecovery(currentUserId));
                      setActiveRecovery(null);
                    } else {
                      setNewBatchId(crypto.randomUUID());
                      setNewAttachments([]);
                    }
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
            className="relative max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-[22px] p-6 shadow-2xl"
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
                onClick={() => {
                  setEditingTask(null);
                  setEditAttachments([]);
                }}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {editError && (
              <div className="p-3 rounded-xl text-xs flex items-center justify-between gap-3 bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="font-semibold">{editError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setEditError(null)}
                  className="text-xs opacity-70 hover:opacity-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

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
                    {taskFormTeams.map((t) => (
                      <option key={t} value={t} className="bg-stone-900 text-white">{t}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Assignees & Status */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-semibold text-stone-300 block mb-1">
                    Assignees (Operational Only):
                  </label>
                  <SearchableMultiSelect
                    options={editAssigneeOptions.map((user) => ({
                      id: user.id,
                      label: user.name,
                      sublabel: user.team || user.role,
                      badge: capacityIndicator(user),
                    }))}
                    selectedIds={editAssigneeIds}
                    onChange={setEditAssigneeIds}
                    placeholder="Select assignees…"
                    searchPlaceholder="Search by name…"
                    emptyMessage="No assignable employees."
                  />
                  {(isCapacityLoading || capacityError) && (
                    <p className={`mt-1 text-[10px] ${capacityError ? 'text-amber-400' : 'text-stone-500'}`}>
                      {capacityError || 'Loading verified capacity…'}
                    </p>
                  )}
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

              {/* Platforms (optional) — same "never silently drop an inactive one" rule as
                  editTaskTypeOptions below, via editPlatformOptions. */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Platforms (optional):
                </label>
                <SearchableMultiSelect
                  options={editPlatformOptions.map((p) => ({
                    id: p.id,
                    label: `${p.name}${!p.active ? ' (inactive)' : ''}`,
                  }))}
                  selectedIds={editPlatformIds}
                  onChange={setEditPlatformIds}
                  placeholder="Select platforms…"
                  searchPlaceholder="Search platforms…"
                  emptyMessage="No platforms available."
                />
              </div>

              {/* Task Type (optional) — always shown, same as every other role; includes the
                  task's current type even if it's since been deactivated, so editing never
                  silently drops it. Managers additionally get the Add type/Edit types controls
                  below. */}
              <div>
                <label className="text-xs font-semibold text-stone-300 block mb-1">
                  Task Type (optional):
                </label>
                {canManageTaskTypes && (
                  <div className="mb-1.5">
                    <TaskTypeInlineManager
                      taskTypes={taskTypes}
                      scopeTeam={editTeam}
                      scopeRole={editAssigneeRole}
                      onSelectType={setEditTaskType}
                      onCreateTaskType={onCreateTaskType}
                      onUpdateTaskType={onUpdateTaskType}
                    />
                  </div>
                )}
                <select
                  value={editTaskType}
                  onChange={(e) => setEditTaskType(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="" className="bg-stone-900 text-stone-400">-- No Task Type --</option>
                  {editTaskTypeOptions.map((t) => (
                    <option key={t.id} value={t.id} className="bg-stone-900 text-white">
                      {t.label}{!t.is_active ? ' (inactive)' : ''}
                    </option>
                  ))}
                </select>
                {editSelectedTaskType?.is_other && (
                  <input
                    type="text"
                    dir="auto"
                    value={editTaskTypeOther}
                    onChange={(e) => setEditTaskTypeOther(e.target.value)}
                    placeholder="Describe the task type..."
                    className="w-full mt-2 px-3 py-2 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                  />
                )}
              </div>

              {/* Designer-scheduling suggestion — SHOWN only; this task's due date already
                  exists, so it is never auto-shifted (owner decision). Click "Use suggestion" to
                  copy it into the still-editable fields below. */}
              {(isEditSchedulingLoading || editSchedulingError || editSchedulingSuggestion) && (
                <div className={`p-2.5 rounded-xl text-[11px] border flex items-center justify-between gap-2 flex-wrap ${
                  editSchedulingSuggestion?.warning
                    ? 'bg-amber-950/20 border-amber-700/40 text-amber-200'
                    : 'bg-stone-900/60 border-stone-800 text-stone-400'
                }`}>
                  <span>
                    {isEditSchedulingLoading && 'Checking schedule…'}
                    {editSchedulingError && `Schedule suggestion unavailable: ${editSchedulingError}`}
                    {!isEditSchedulingLoading && !editSchedulingError && editSchedulingSuggestion && (
                      <>
                        Suggested: {editSchedulingSuggestion.dueDate}, {editSchedulingSuggestion.estimatedHours.toFixed(2)}h — based on{' '}
                        {editAssigneeOptions.find((u) => u.id === editSchedulingSuggestion.basedOnUserId)?.name || 'the assignee'}
                        {editSchedulingSuggestion.consideredCount > 1
                          ? ` (the most loaded of ${editSchedulingSuggestion.consideredCount} creative assignees)`
                          : ''}
                        's schedule. This task's existing due date is left as-is unless you apply it.
                        {editSchedulingSuggestion.warning && ` That day is already at or near the ${MAX_TASKS_PER_DAY}/day limit.`}
                        {editSchedulingSuggestion.carriedOverCount > 0 &&
                          ` ${editSchedulingSuggestion.carriedOverCount} overdue open task${editSchedulingSuggestion.carriedOverCount === 1 ? '' : 's'} carried over.`}
                      </>
                    )}
                  </span>
                  {editSchedulingSuggestion && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditDueDate(editSchedulingSuggestion.dueDate);
                        setEditEstimatedHours(editSchedulingSuggestion.estimatedHours);
                      }}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500"
                    >
                      Use suggestion
                    </button>
                  )}
                </div>
              )}

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
                    step="0.01"
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

              <div>
                <label className="mb-1 block text-xs font-semibold text-stone-300">Add attachments:</label>
                <TaskAttachmentPicker files={editAttachments} onChange={setEditAttachments} disabled={isUpdating} />
              </div>

              {editError && (
                <div
                  ref={editErrorBottomRef}
                  className="p-3 rounded-xl text-xs flex items-center justify-between gap-3 bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]"
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span className="font-semibold">{editError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditError(null)}
                    className="text-xs opacity-70 hover:opacity-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Submit Buttons */}
              <div className="pt-3 border-t border-stone-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingTask(null);
                    setEditAttachments([]);
                  }}
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

      {isTaskTypeManagerOpen && canManageTaskTypes && (
        <TaskTypeManager
          taskTypes={taskTypes}
          onCreate={onCreateTaskType}
          onUpdate={onUpdateTaskType}
          onClose={() => setIsTaskTypeManagerOpen(false)}
        />
      )}

      {isPlatformManagerOpen && canManagePlatforms && (
        <PlatformManager
          platforms={platforms}
          onCreate={onCreatePlatform}
          onUpdate={onUpdatePlatform}
          onClose={() => setIsPlatformManagerOpen(false)}
        />
      )}

      {deleteModalTaskIds && (() => {
        const preview = computeTaskDeletionPreview(deleteModalTaskIds, tasks, taskComments, taskAttachments);
        const taskNames = deleteModalTaskIds.map((id) => tasks.find((t) => t.id === id)?.title || id);
        return (
          <TaskDeleteConfirmModal
            taskNames={taskNames}
            subtaskCount={preview.subtaskCount}
            commentCount={preview.commentCount}
            attachmentCount={preview.attachmentCount}
            isDeleting={isDeletingTasks}
            error={deleteError}
            onConfirm={handleConfirmDeleteTasks}
            onClose={() => {
              setDeleteModalTaskIds(null);
              setDeleteError(null);
            }}
          />
        );
      })()}

      {/* Bulk action confirm — mandatory count-based confirmation before ANY bulk action (except
          Delete, which keeps its own pre-existing confirm modal above) actually runs. */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-md rounded-[22px] p-6 space-y-4 shadow-2xl"
            style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
          >
            <h3 className="text-sm font-bold text-white">Confirm bulk action</h3>
            <p className="text-xs text-stone-300">{bulkConfirm.description}</p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setBulkConfirm(null)}
                disabled={isBulkRunning}
                className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const { run } = bulkConfirm;
                  setBulkConfirm(null);
                  await run();
                }}
                disabled={isBulkRunning}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
              >
                {isBulkRunning ? 'Applying…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk action result — "Succeeded N / Skipped M (no permission) / Failed K", each skipped
          or failed task named with its own reason. Never all-or-nothing, so this is the only
          place that outcome is visible. */}
      {bulkSummary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-lg rounded-[22px] p-6 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto"
            style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
          >
            <h3 className="text-sm font-bold text-white">{bulkSummary.actionLabel} — result</h3>
            <div className="flex items-center gap-3 text-xs">
              <span className="font-bold text-emerald-400">Succeeded {bulkSummary.summary.succeeded.length}</span>
              <span className="font-bold text-amber-400">Skipped {bulkSummary.summary.skipped.length}</span>
              <span className="font-bold text-red-400">Failed {bulkSummary.summary.failed.length}</span>
            </div>
            {bulkSummary.summary.skipped.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-semibold text-amber-400">Skipped (no permission):</p>
                {bulkSummary.summary.skipped.map((item) => (
                  <p key={item.taskId} className="text-[11px] text-stone-400">
                    {tasks.find((t) => t.id === item.taskId)?.title || item.taskId}: {item.reason}
                  </p>
                ))}
              </div>
            )}
            {bulkSummary.summary.failed.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-semibold text-red-400">Failed:</p>
                {bulkSummary.summary.failed.map((item) => (
                  <p key={item.taskId} className="text-[11px] text-stone-400">
                    {tasks.find((t) => t.id === item.taskId)?.title || item.taskId}: {item.reason}
                  </p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-end pt-2">
              <button
                onClick={() => setBulkSummary(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-stone-700 hover:bg-stone-600"
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
