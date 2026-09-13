import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X, AlertTriangle } from 'lucide-react';
import { TaskRecord, TaskPriority, ClientRecord, UserRecord } from '../types/database';

interface TaskCalendarViewProps {
  tasks: TaskRecord[];
  clients: ClientRecord[];
  users: UserRecord[];
  onSelectTask: (task: TaskRecord) => void;
}

const priorityStyle = (priority: TaskPriority) => {
  switch (priority) {
    case 'urgent':
      return { bg: 'rgba(245, 163, 163, 0.25)', text: 'var(--roas-bad)', border: 'rgba(245, 163, 163, 0.4)' };
    case 'high':
      return { bg: 'rgba(235, 94, 40, 0.2)', text: '#fb923c', border: 'rgba(235, 94, 40, 0.3)' };
    case 'low':
      return { bg: 'rgba(168, 155, 184, 0.2)', text: 'var(--grey)', border: 'rgba(168, 155, 184, 0.3)' };
    default:
      return { bg: 'rgba(245, 226, 154, 0.2)', text: 'var(--roas-mid)', border: 'rgba(245, 226, 154, 0.3)' };
  }
};

const toDateStr = (d: Date) => d.toISOString().split('T')[0];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_VISIBLE_PER_DAY = 3;

export const TaskCalendarView: React.FC<TaskCalendarViewProps> = ({ tasks, clients, users, onSelectTask }) => {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const todayStr = useMemo(() => toDateStr(new Date()), []);

  // Fixed 6-week (42-cell) grid — includes leading/trailing days from
  // adjacent months so the grid height never jumps between months.
  const gridDates = useMemo(() => {
    const firstOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - firstOfMonth.getDay());

    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }, [currentMonth]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, TaskRecord[]>();
    for (const task of tasks) {
      const list = map.get(task.due_date) || [];
      list.push(task);
      map.set(task.due_date, list);
    }
    return map;
  }, [tasks]);

  const goToPrevMonth = () =>
    setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const goToNextMonth = () =>
    setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  const goToToday = () => {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
  };

  const expandedDayTasks = expandedDay ? tasksByDate.get(expandedDay) || [] : [];

  return (
    <div
      className="rounded-[18px] overflow-hidden border border-stone-800"
      style={{ background: 'var(--gradient-card)' }}
    >
      {/* Month navigation */}
      <div className="flex items-center justify-between p-4 border-b border-stone-800">
        <h3 className="text-sm font-bold text-white">
          {currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={goToToday}
            className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-stone-300 bg-stone-900/80 border border-stone-800 hover:text-white"
          >
            Today
          </button>
          <button
            onClick={goToPrevMonth}
            className="p-1.5 rounded-lg bg-stone-900/80 border border-stone-800 text-stone-300 hover:text-white"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={goToNextMonth}
            className="p-1.5 rounded-lg bg-stone-900/80 border border-stone-800 text-stone-300 hover:text-white"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-stone-800 bg-stone-900/60">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="p-2 text-center text-[10px] font-bold text-stone-400 uppercase">
            {label}
          </div>
        ))}
      </div>

      {/* Month grid */}
      <div className="grid grid-cols-7">
        {gridDates.map((date) => {
          const dateStr = toDateStr(date);
          const isCurrentMonth = date.getMonth() === currentMonth.getMonth();
          const isToday = dateStr === todayStr;
          const dayTasks = tasksByDate.get(dateStr) || [];
          const visibleTasks = dayTasks.slice(0, MAX_VISIBLE_PER_DAY);
          const overflowCount = dayTasks.length - visibleTasks.length;

          return (
            <div
              key={dateStr}
              className="min-h-[92px] p-1.5 border-b border-r border-stone-800/60 space-y-1"
              style={{ background: isCurrentMonth ? 'transparent' : 'rgba(0, 0, 0, 0.2)' }}
            >
              <button
                onClick={() => dayTasks.length > 0 && setExpandedDay(dateStr)}
                className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md ${
                  isToday
                    ? 'bg-purple-600 text-white'
                    : isCurrentMonth
                    ? 'text-stone-300 hover:text-white'
                    : 'text-stone-600'
                }`}
              >
                {date.getDate()}
              </button>

              <div className="space-y-1">
                {visibleTasks.map((task) => {
                  const priority = priorityStyle(task.priority);
                  const overdue = task.due_date < todayStr && task.status !== 'completed';
                  return (
                    <button
                      key={task.id}
                      onClick={() => onSelectTask(task)}
                      className="w-full text-left px-1.5 py-0.5 rounded text-[10px] font-semibold truncate flex items-center gap-1"
                      style={{ background: priority.bg, color: priority.text, border: `1px solid ${priority.border}` }}
                      title={task.title}
                    >
                      {overdue && <AlertTriangle className="w-2.5 h-2.5 shrink-0 text-red-400" />}
                      <span className="truncate">{task.title}</span>
                    </button>
                  );
                })}
                {overflowCount > 0 && (
                  <button
                    onClick={() => setExpandedDay(dateStr)}
                    className="w-full text-left px-1.5 py-0.5 rounded text-[10px] font-bold text-purple-300 hover:text-purple-200"
                  >
                    +{overflowCount} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Day-detail view */}
      {expandedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div
            className="w-full max-w-md rounded-[22px] p-5 space-y-3 shadow-2xl relative max-h-[80vh] overflow-y-auto"
            style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
          >
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <h4 className="text-sm font-bold text-white">
                Tasks due{' '}
                {new Date(expandedDay + 'T00:00:00').toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </h4>
              <button
                onClick={() => setExpandedDay(null)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              {expandedDayTasks.map((task) => {
                const client = clients.find((c) => c.id === task.client_id);
                const assignee = users.find((u) => u.id === task.assigned_to);
                const priority = priorityStyle(task.priority);
                return (
                  <button
                    key={task.id}
                    onClick={() => {
                      setExpandedDay(null);
                      onSelectTask(task);
                    }}
                    className="w-full text-left p-2.5 rounded-xl border hover:border-purple-500/50 transition-all"
                    style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-white truncate">{task.title}</span>
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0"
                        style={{ background: priority.bg, color: priority.text }}
                      >
                        {task.priority}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-stone-400">
                      <span className="truncate">{client ? client.name : 'Unassigned Client'}</span>
                      <span>•</span>
                      <span className="truncate">{assignee ? assignee.name : 'Unassigned'}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
