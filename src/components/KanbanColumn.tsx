import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { TaskRecord, TaskStatus, ClientRecord, UserRecord, TaskAssigneeRecord, PlatformRecord, TaskPlatformLinkRecord } from '../types/database';
import { KanbanTaskCard, KanbanColumnMeta } from './KanbanTaskCard';
import { isTaskDone, resolveOrderedTaskAssigneeIds } from '../lib/taskLifecycle';

const DEFAULT_COLUMN_WIDTH = 340;
const MIN_COLUMN_WIDTH = 260;
const MAX_COLUMN_WIDTH = 640;
const COLUMN_WIDTH_STORAGE_PREFIX = 'ams-kanban-column-width:';

interface KanbanColumnProps {
  column: KanbanColumnMeta;
  columns: KanbanColumnMeta[];
  tasks: TaskRecord[]; // already filtered to this column's status
  allTasks: TaskRecord[]; // full (unfiltered) list, for subtask-count lookups
  clients: ClientRecord[];
  users: UserRecord[];
  taskAssignees: TaskAssigneeRecord[];
  platforms: PlatformRecord[];
  taskPlatformLinks: TaskPlatformLinkRecord[];
  isOverdue: (task: TaskRecord) => boolean;
  isDueSoon: (task: TaskRecord) => boolean;
  onOpenDetails: (task: TaskRecord) => void;
  onEditTask: (task: TaskRecord) => void;
  onMoveStatus: (taskId: string, status: TaskStatus) => void;
}

// A useDroppable-backed column. Extracted into its own component (rather
// than called inline inside CrossTeamTaskBoard's columns.map()) because
// hooks can't be called a variable number of times inside a loop within a
// single component's render — each column needs its own useDroppable call,
// which means its own component instance.
export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  column,
  columns,
  tasks,
  allTasks,
  clients,
  users,
  taskAssignees,
  platforms,
  taskPlatformLinks,
  isOverdue,
  isDueSoon,
  onOpenDetails,
  onEditTask,
  onMoveStatus,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const [columnWidth, setColumnWidth] = React.useState(() => {
    try {
      const storedWidth = window.localStorage.getItem(`${COLUMN_WIDTH_STORAGE_PREFIX}${column.id}`);
      const parsedWidth = storedWidth ? Number(storedWidth) : DEFAULT_COLUMN_WIDTH;
      return Number.isFinite(parsedWidth)
        ? Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, parsedWidth))
        : DEFAULT_COLUMN_WIDTH;
    } catch {
      return DEFAULT_COLUMN_WIDTH;
    }
  });

  const setColumnNodeRef = React.useCallback((node: HTMLDivElement | null) => {
    columnRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);

  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidth;
    const isRtl = columnRef.current ? window.getComputedStyle(columnRef.current).direction === 'rtl' : false;
    let finalWidth = startWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) * (isRtl ? -1 : 1);
      finalWidth = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, startWidth + delta));
      setColumnWidth(finalWidth);
    };
    const finishResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      try {
        window.localStorage.setItem(`${COLUMN_WIDTH_STORAGE_PREFIX}${column.id}`, String(Math.round(finalWidth)));
      } catch {
        // Storage may be blocked or unavailable; the in-memory width still remains usable.
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  };

  return (
    <div
      ref={setColumnNodeRef}
      className={`relative shrink-0 rounded-[18px] p-3 flex flex-col gap-3 min-h-[500px] transition-colors ${
        isOver ? 'ring-2 ring-purple-500/50' : ''
      }`}
      style={{
        width: columnWidth,
        minWidth: MIN_COLUMN_WIDTH,
        maxWidth: MAX_COLUMN_WIDTH,
        background: isOver ? 'rgba(123, 47, 247, 0.08)' : 'rgba(21, 19, 24, 0.65)',
        border: '1px solid var(--border-soft)',
      }}
    >
      <button
        type="button"
        aria-label={`Resize ${column.label} column`}
        title="Drag to resize column"
        onPointerDown={handleResizeStart}
        onClick={(event) => event.stopPropagation()}
        className="absolute inset-y-3 z-20 w-2 cursor-col-resize touch-none rounded-full bg-purple-400/20 opacity-70 transition-opacity hover:bg-purple-400/60 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-purple-400"
        style={{ insetInlineEnd: '-5px' }}
      />
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
          {tasks.length}
        </span>
      </div>

      {/* Column Task Cards */}
      <div className="space-y-3 flex-1 overflow-y-auto max-h-[750px] pr-0.5">
        {tasks.length === 0 ? (
          <div className="p-6 text-center text-stone-500 text-xs border border-dashed border-stone-800/80 rounded-xl">
            No tasks in this stage
          </div>
        ) : (
          tasks.map((task) => {
            const client = clients.find((c) => c.id === task.client_id);
            const assigneeNames = resolveOrderedTaskAssigneeIds(task.id, taskAssignees, task.assigned_to)
              .map((id) => users.find((u) => u.id === id)?.name || 'Unknown employee');
            const platformNames = taskPlatformLinks
              .filter((link) => link.task_id === task.id)
              .map((link) => platforms.find((p) => p.id === link.platform_id)?.name)
              .filter((name): name is string => !!name);
            const subtasks = allTasks.filter((t) => t.parent_task_id === task.id);
            const subtaskDone = subtasks.filter((t) => isTaskDone(t.status)).length;

            return (
              <KanbanTaskCard
                key={task.id}
                task={task}
                client={client}
                assigneeNames={assigneeNames}
                platformNames={platformNames}
                subtaskDone={subtaskDone}
                subtaskTotal={subtasks.length}
                overdue={isOverdue(task)}
                dueSoon={isDueSoon(task)}
                columns={columns}
                onOpenDetails={onOpenDetails}
                onEditTask={onEditTask}
                onMoveStatus={onMoveStatus}
              />
            );
          })
        )}
      </div>
    </div>
  );
};
