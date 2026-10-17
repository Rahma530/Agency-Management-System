import React from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import { TaskEventRecord, UserRecord } from '../types/database';

export interface TaskHistoryTabProps {
  events: TaskEventRecord[];
  users: UserRecord[];
  // Resolve a tracked tasks.status/priority raw value to the exact label already shown elsewhere
  // in the board (CrossTeamTaskBoard's own `columns`/getPriorityBadge()) — so "from X to Y" reads
  // identically to every other status/priority badge in the app, not a second, drifting mapping.
  getStatusLabel: (status: string) => string;
  getPriorityLabel: (priority: string) => string;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}

// Date+time only, Africa/Cairo — task_events.created_at is a timestamptz (unlike tasks.due_date,
// a plain date with no time-of-day to convert), so this is the one place in this tab a timezone
// actually applies. ar-EG purely for this tab's own Arabic phrasing; it does not affect any raw
// value (status/priority labels, team/title text, user names) embedded in a history line.
const CAIRO_DATETIME_FORMATTER = new Intl.DateTimeFormat('ar-EG', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// Read-only, Arabic + RTL — matching this app's existing convention for activity/notification-style
// panels (LiveActivityFeed.tsx, NotificationBell.tsx: Arabic chrome in a self-contained dir="rtl"
// block, regardless of the hosting page's own language), not a real i18n system (this app has
// none — see those two files). Raw values (status/priority labels, team/title text, user names)
// are shown exactly as the rest of the app already displays them — English labels, English/Latin
// names — the same mixed-language pattern LiveActivityFeed itself already uses for target_name.
export const TaskHistoryTab: React.FC<TaskHistoryTabProps> = ({
  events,
  users,
  getStatusLabel,
  getPriorityLabel,
  isLoading,
  error,
  onRetry,
}) => {
  // Distinct fallback words on purpose, per spec: a null/unresolvable ACTOR reads "System" (no one
  // performed this — or whoever did is gone from the in-memory roster); a null/unresolvable
  // ASSIGNEE named in old_value/new_value reads "Unknown", matching this app's existing convention
  // for an unresolved user id elsewhere (e.g. CrossTeamTaskBoard's own assignee chips).
  const resolveActorName = (id: string | null): string =>
    (id && users.find((u) => u.id === id)?.name) || 'System';
  const resolveAssigneeName = (id: string | null): string =>
    (id && users.find((u) => u.id === id)?.name) || 'Unknown';

  const describeEvent = (event: TaskEventRecord): string => {
    switch (event.event_type) {
      case 'created':
        return 'أنشأ المهمة';
      case 'status_changed':
        return `غيّر الحالة من ${getStatusLabel(event.old_value || '')} إلى ${getStatusLabel(event.new_value || '')}`;
      case 'priority_changed':
        return `غيّر الأولوية من ${getPriorityLabel(event.old_value || '')} إلى ${getPriorityLabel(event.new_value || '')}`;
      // due_date is a plain date (no time-of-day), stored and shown elsewhere in this app as a
      // raw 'YYYY-MM-DD' string with no reformatting (see CrossTeamTaskBoard's own Table view) —
      // kept identical here rather than running it through Date parsing, which would risk a
      // timezone-dependent off-by-one-day shift for a value that was never a timestamp.
      case 'due_date_changed':
        return `غيّر تاريخ الاستحقاق من ${event.old_value || '—'} إلى ${event.new_value || '—'}`;
      case 'title_changed':
        return `غيّر العنوان من "${event.old_value || '—'}" إلى "${event.new_value || '—'}"`;
      case 'team_changed':
        return `غيّر الفريق من ${event.old_value || '—'} إلى ${event.new_value || '—'}`;
      case 'assignee_added':
        return `أسند المهمة إلى ${resolveAssigneeName(event.new_value)}`;
      case 'assignee_removed':
        return `أزال ${resolveAssigneeName(event.old_value)} من الإسناد`;
      default:
        return event.event_type;
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 text-center text-stone-400 text-xs" dir="rtl">
        جارٍ تحميل السجل...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center space-y-3" dir="rtl">
        <p className="text-xs text-red-400">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-stone-800 text-stone-200 hover:bg-stone-700"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="p-8 text-center text-stone-500 text-xs" dir="rtl">
        لا يوجد سجل بعد
      </div>
    );
  }

  return (
    <div className="space-y-2" dir="rtl">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex gap-2.5 p-2.5 rounded-xl bg-stone-900/60 border border-stone-800"
        >
          <div className="shrink-0 mt-0.5">
            <div className="w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
              <Clock className="w-3.5 h-3.5 text-stone-400" />
            </div>
          </div>
          <div className="flex-1 min-w-0 text-xs text-stone-300">
            <span className="font-bold text-white">{resolveActorName(event.actor_id)}</span>
            {' '}
            <span>{describeEvent(event)}</span>
            <div className="text-[10px] text-stone-500 mt-1">
              {CAIRO_DATETIME_FORMATTER.format(new Date(event.created_at))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
