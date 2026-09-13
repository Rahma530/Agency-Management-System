import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  Building2,
  Calendar,
  UserX,
  AlertTriangle,
  Timer,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Edit2,
} from 'lucide-react';
import { TaskRecord, TaskStatus, TaskPriority, ClientRecord, UserRecord } from '../types/database';

export interface KanbanColumnMeta {
  id: TaskStatus;
  label: string;
  color: string;
  badgeBg: string;
}

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

export interface KanbanTaskCardContentProps {
  task: TaskRecord;
  client?: ClientRecord;
  assignee?: UserRecord;
  subtaskDone: number;
  subtaskTotal: number;
  overdue: boolean;
  dueSoon: boolean;
  columns: KanbanColumnMeta[];
  onOpenDetails: (task: TaskRecord) => void;
  onEditTask: (task: TaskRecord) => void;
  onMoveStatus: (taskId: string, status: TaskStatus) => void;
  // True only for the floating copy rendered inside DragOverlay — same
  // visuals, but not interactive (no click-to-open, no stage buttons) since
  // it isn't really mounted where the card normally lives.
  isOverlay?: boolean;
}

// Pure presentational card body — used both for the real (draggable) card
// inside a column and for the DragOverlay's floating copy while dragging.
// Kept separate from KanbanTaskCard below so the overlay copy never calls
// useDraggable itself (it isn't a second draggable participant, just a
// dnd-kit-positioned visual).
export const KanbanTaskCardContent: React.FC<KanbanTaskCardContentProps> = ({
  task,
  client,
  assignee,
  subtaskDone,
  subtaskTotal,
  overdue,
  dueSoon,
  columns,
  onOpenDetails,
  onEditTask,
  onMoveStatus,
  isOverlay = false,
}) => {
  const priority = getPriorityBadge(task.priority);
  const teamColor = getTeamColor(task.team);

  return (
    <div
      className={`p-3.5 rounded-xl transition-all group relative space-y-2.5 shadow-md ${
        isOverlay ? 'rotate-2 shadow-2xl cursor-grabbing' : 'cursor-grab active:cursor-grabbing hover:border-purple-500/50'
      }`}
      style={{
        background: 'var(--gradient-card)',
        border: `1px solid ${overdue ? 'rgba(245, 163, 163, 0.4)' : 'var(--border-medium)'}`,
      }}
      onClick={() => !isOverlay && onOpenDetails(task)}
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

      {/* Subtask progress */}
      {subtaskTotal > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-stone-400">
          <CheckSquare className="w-3 h-3 text-purple-300" />
          <span>
            Subtasks: {subtaskDone}/{subtaskTotal}
          </span>
        </div>
      )}

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

      {/* Quick Advance Status Arrow Buttons — kept alongside drag-and-drop as
          the click-only fallback (touch/keyboard/anyone who'd rather not
          drag) */}
      {!isOverlay && (
        <div
          className="pt-1.5 flex items-center justify-between border-t border-stone-800/50"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-[10px] text-stone-500">Stage:</span>
          <div className="flex items-center gap-1">
            {task.status !== 'todo' && (
              <button
                onClick={() => {
                  const prevIdx = columns.findIndex((c) => c.id === task.status) - 1;
                  if (prevIdx >= 0) onMoveStatus(task.id, columns[prevIdx].id);
                }}
                className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white transition-colors"
                title="Previous Stage"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
            )}
            {task.status !== 'completed' && (
              <button
                onClick={() => {
                  const nextIdx = columns.findIndex((c) => c.id === task.status) + 1;
                  if (nextIdx < columns.length) onMoveStatus(task.id, columns[nextIdx].id);
                }}
                className="p-1 rounded bg-stone-900 text-purple-300 hover:text-white hover:bg-purple-900/60 transition-colors"
                title="Next Stage"
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={() => onEditTask(task)}
              className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white ml-1"
              title="Edit Task"
            >
              <Edit2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// The real, draggable card rendered inside a KanbanColumn. Wraps
// KanbanTaskCardContent with useDraggable — a minimum-drag-distance
// PointerSensor (configured where DndContext is set up) is what keeps a
// plain click still opening Task Details instead of every click being
// swallowed as a drag start.
export const KanbanTaskCard: React.FC<KanbanTaskCardContentProps> = (props) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: props.task.id,
    data: { task: props.task },
  });

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <KanbanTaskCardContent {...props} />
    </div>
  );
};
