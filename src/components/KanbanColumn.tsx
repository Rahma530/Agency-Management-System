import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { TaskRecord, TaskStatus, ClientRecord, UserRecord } from '../types/database';
import { KanbanTaskCard, KanbanColumnMeta } from './KanbanTaskCard';

interface KanbanColumnProps {
  column: KanbanColumnMeta;
  columns: KanbanColumnMeta[];
  tasks: TaskRecord[]; // already filtered to this column's status
  allTasks: TaskRecord[]; // full (unfiltered) list, for subtask-count lookups
  clients: ClientRecord[];
  users: UserRecord[];
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
  isOverdue,
  isDueSoon,
  onOpenDetails,
  onEditTask,
  onMoveStatus,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className={`rounded-[18px] p-3 flex flex-col gap-3 min-h-[500px] transition-all ${
        isOver ? 'ring-2 ring-purple-500/50' : ''
      }`}
      style={{
        background: isOver ? 'rgba(123, 47, 247, 0.08)' : 'rgba(21, 19, 24, 0.65)',
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
            const assignee = users.find((u) => u.id === task.assigned_to);
            const subtasks = allTasks.filter((t) => t.parent_task_id === task.id);
            const subtaskDone = subtasks.filter((t) => t.status === 'completed').length;

            return (
              <KanbanTaskCard
                key={task.id}
                task={task}
                client={client}
                assignee={assignee}
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
