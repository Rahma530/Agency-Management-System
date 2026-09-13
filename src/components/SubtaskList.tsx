import React from 'react';
import { PlusCircle, Edit2, Calendar } from 'lucide-react';
import { TaskRecord, TaskStatus, TaskPriority, UserRecord } from '../types/database';

interface SubtaskListProps {
  parentTask: TaskRecord;
  allTasks: TaskRecord[];
  users: UserRecord[];
  // The nesting level of the rows THIS list renders: 2 for direct children of
  // the top-level task open in the modal, 3 for grandchildren. Nesting is
  // capped at 3 (task -> subtask -> sub-subtask) by a DB trigger — "+ Add
  // Subtask" is hidden once level reaches 3, and no further recursion happens
  // past it, since a 4th level would be rejected outright.
  level: 2 | 3;
  onAddSubtask: (parentTask: TaskRecord) => void;
  onEditSubtask: (task: TaskRecord) => void;
}

const statusBadge = (status: TaskStatus) => {
  switch (status) {
    case 'completed':
      return { label: 'Completed', bg: 'rgba(169, 245, 193, 0.2)', text: 'var(--roas-good)' };
    case 'in_progress':
      return { label: 'In Progress', bg: 'rgba(123, 47, 247, 0.25)', text: 'var(--purple-light)' };
    case 'in_review':
      return { label: 'In Review', bg: 'rgba(245, 226, 154, 0.2)', text: 'var(--roas-mid)' };
    case 'blocked':
      return { label: 'Blocked', bg: 'rgba(245, 163, 163, 0.2)', text: 'var(--roas-bad)' };
    default:
      return { label: 'To Do', bg: 'rgba(168, 155, 184, 0.2)', text: 'var(--grey)' };
  }
};

const priorityBadge = (priority: TaskPriority) => {
  switch (priority) {
    case 'urgent':
      return { label: 'Urgent', text: 'var(--roas-bad)' };
    case 'high':
      return { label: 'High', text: '#fb923c' };
    case 'low':
      return { label: 'Low', text: 'var(--grey)' };
    default:
      return { label: 'Medium', text: 'var(--roas-mid)' };
  }
};

export const SubtaskList: React.FC<SubtaskListProps> = ({
  parentTask,
  allTasks,
  users,
  level,
  onAddSubtask,
  onEditSubtask,
}) => {
  const children = allTasks.filter((t) => t.parent_task_id === parentTask.id);

  if (children.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1.5" style={{ paddingLeft: (level - 2) * 18 }}>
      {children.map((child) => {
        const assignee = users.find((u) => u.id === child.assigned_to);
        const status = statusBadge(child.status);
        const priority = priorityBadge(child.priority);
        const canNestFurther = level < 3;

        return (
          <div key={child.id} className="space-y-1.5">
            <div
              className="flex items-center justify-between gap-2 p-2 rounded-lg border"
              style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0"
                  style={{ background: status.bg, color: status.text }}
                >
                  {status.label}
                </span>
                <span className="text-xs font-semibold text-white truncate">{child.title}</span>
                <span className="text-[10px] font-semibold shrink-0" style={{ color: priority.text }}>
                  {priority.label}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0 text-[10px] text-stone-400">
                {assignee ? (
                  <div className="flex items-center gap-1" title={assignee.name}>
                    <div
                      className="w-4 h-4 rounded-full flex items-center justify-center font-bold text-[8px]"
                      style={{ background: 'var(--gradient-badge)', color: 'white' }}
                    >
                      {assignee.name.charAt(0)}
                    </div>
                  </div>
                ) : (
                  <span className="text-amber-400">Unassigned</span>
                )}
                {child.due_date && (
                  <span className="flex items-center gap-0.5 font-mono">
                    <Calendar className="w-3 h-3" />
                    {child.due_date}
                  </span>
                )}
                <button
                  onClick={() => onEditSubtask(child)}
                  className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white"
                  title="Edit"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
                {canNestFurther && (
                  <button
                    onClick={() => onAddSubtask(child)}
                    className="p-1 rounded bg-stone-900 text-stone-400 hover:text-purple-300"
                    title="Add subtask"
                  >
                    <PlusCircle className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {canNestFurther && (
              <SubtaskList
                parentTask={child}
                allTasks={allTasks}
                users={users}
                level={(level + 1) as 2 | 3}
                onAddSubtask={onAddSubtask}
                onEditSubtask={onEditSubtask}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
