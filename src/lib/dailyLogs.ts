import { DailyLogRecord } from '../types/database';

// Mirrors daily_logs_update_own_rls/daily_logs_delete_own_rls exactly (20261101200000_daily_logs_edit_own.sql)
// so the UI never offers an Edit/Delete action the database would reject: the author, within 7
// days of the row's own created_at (never the log's `date`, which the author can freely backdate
// or future-date).
const EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const canEditOwnDailyLog = (log: DailyLogRecord, currentUserId: string): boolean => {
  if (log.user_id !== currentUserId || !log.created_at) return false;
  return Date.now() - new Date(log.created_at).getTime() < EDIT_WINDOW_MS;
};
