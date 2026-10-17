import React from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import { ActivityRecord, TaskAssigneeLogRecord, TaskEventRecord, UserRecord } from '../types/database';

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
  // "Older history": admin-only (executive/head_of_technical), merging the two pre-task_events
  // sources (public.activities + public.task_assignee_log) for this one task. false means this
  // whole section renders nothing at all, regardless of what the other legacy* props hold — the
  // caller (CrossTeamTaskBoard.tsx) also never fetches them for anyone else in the first place.
  canSeeLegacyHistory: boolean;
  legacyActivities: ActivityRecord[];
  legacyAssigneeLog: TaskAssigneeLogRecord[];
  isLoadingLegacyHistory: boolean;
  legacyHistoryError: string | null;
  onRetryLegacyHistory: () => void;
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
  canSeeLegacyHistory,
  legacyActivities,
  legacyAssigneeLog,
  isLoadingLegacyHistory,
  legacyHistoryError,
  onRetryLegacyHistory,
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

  // Main (task_events-backed) section content — independent of the "Older history" section
  // below: a failure or empty state here must never hide the legacy section, and vice versa,
  // since the two are fetched separately and can resolve at different times.
  let mainContent: React.ReactNode;
  if (isLoading) {
    mainContent = (
      <div className="p-8 text-center text-stone-400 text-xs">جارٍ تحميل السجل...</div>
    );
  } else if (error) {
    mainContent = (
      <div className="p-6 text-center space-y-3">
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
  } else if (events.length === 0) {
    mainContent = (
      <div className="p-8 text-center text-stone-500 text-xs">لا يوجد سجل بعد</div>
    );
  } else {
    mainContent = (
      <div className="space-y-2">
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
  }

  return (
    <div dir="rtl">
      {mainContent}
      {canSeeLegacyHistory && (
        <LegacyHistorySection
          legacyActivities={legacyActivities}
          legacyAssigneeLog={legacyAssigneeLog}
          isLoading={isLoadingLegacyHistory}
          error={legacyHistoryError}
          onRetry={onRetryLegacyHistory}
          resolveActorName={resolveActorName}
          resolveAssigneeName={resolveAssigneeName}
        />
      )}
    </div>
  );
};

// public.activities (target_type='task') action_type -> fixed English phrase, exactly as given —
// these are literal strings the data itself never recorded in any richer form (e.g. 'update' had
// no diff captured at all; see 20261002100000_realtime_notifications_activities_chat.sql / this
// app's own logActivity() calls), so there's nothing to translate or interpolate beyond
// status_change's own pre-existing details text, shown as-is.
const describeLegacyActivity = (activity: ActivityRecord): string => {
  switch (activity.action_type) {
    case 'create':
      return 'Task created';
    case 'status_change':
      return activity.details || 'Status updated';
    case 'update':
      return 'Task details updated (details were not recorded)';
    case 'complete':
      return 'Task completed';
    default:
      return activity.action_type;
  }
};

interface LegacyHistoryItem {
  key: string;
  actorId: string | null;
  description: string;
  createdAt: string;
}

interface LegacyHistorySectionProps {
  legacyActivities: ActivityRecord[];
  legacyAssigneeLog: TaskAssigneeLogRecord[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  resolveActorName: (id: string | null) => string;
  resolveAssigneeName: (id: string | null) => string;
}

// Merges the two legacy sources (already pre-filtered by the caller to rows older than
// task_events' own earliest-ever row — see fetchEarliestTaskEventCutoff() in taskOperations.ts —
// so nothing here ever duplicates a row task_events already covers) into one shared
// newest-first timeline. Same line shape, Arabic phrasing, and RTL as the main section above;
// only the three/four fixed English phrases from public.activities stay in English, exactly as
// specified, the same mixed-language pattern this app's LiveActivityFeed.tsx already uses for an
// activity's own raw target_name.
const LegacyHistorySection: React.FC<LegacyHistorySectionProps> = ({
  legacyActivities,
  legacyAssigneeLog,
  isLoading,
  error,
  onRetry,
  resolveActorName,
  resolveAssigneeName,
}) => {
  const items: LegacyHistoryItem[] = [
    ...legacyActivities.map((activity) => ({
      key: `activity-${activity.id}`,
      actorId: activity.user_id,
      description: describeLegacyActivity(activity),
      createdAt: activity.created_at,
    })),
    ...legacyAssigneeLog.map((log) => ({
      key: `assignee-log-${log.id}`,
      actorId: log.actor_id ?? null,
      description:
        log.action === 'added'
          ? `أسند المهمة إلى ${resolveAssigneeName(log.user_id)}`
          : `أزال ${resolveAssigneeName(log.user_id)} من الإسناد`,
      createdAt: log.created_at,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return (
    <div className="mt-4 pt-4 border-t border-stone-800">
      <p className="text-[10px] font-bold uppercase tracking-wide text-stone-500 mb-2">
        Older history — Limited detail – recorded before history tracking
      </p>
      {isLoading ? (
        <div className="p-4 text-center text-stone-400 text-xs">جارٍ تحميل السجل القديم...</div>
      ) : error ? (
        <div className="p-4 text-center space-y-2">
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
      ) : items.length === 0 ? (
        <div className="p-4 text-center text-stone-500 text-xs">لا يوجد سجل قديم</div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.key}
              className="flex gap-2.5 p-2.5 rounded-xl bg-stone-900/40 border border-stone-800/60"
            >
              <div className="shrink-0 mt-0.5">
                <div className="w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                  <Clock className="w-3.5 h-3.5 text-stone-500" />
                </div>
              </div>
              <div className="flex-1 min-w-0 text-xs text-stone-400">
                <span className="font-bold text-stone-300">{resolveActorName(item.actorId)}</span>
                {' '}
                <span>{item.description}</span>
                <div className="text-[10px] text-stone-600 mt-1">
                  {CAIRO_DATETIME_FORMATTER.format(new Date(item.createdAt))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
