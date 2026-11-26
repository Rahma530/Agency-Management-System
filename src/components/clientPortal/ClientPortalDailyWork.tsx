import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronUp, MessageSquare, Sparkles, Star, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';

// One row per (daily_log, resolved department) — see portal_get_daily_work() in
// 20270129000000_client_portal_daily_work.sql for exactly how department_id/department_label are
// resolved (linked task's team, falling back to the logging employee's own team, both mapped
// through the same admin-managed departments/department_member_teams tables the rest of the app
// uses — never a hardcoded list here).
interface PortalDailyWorkRow {
  log_id: string;
  work_date: string;
  summary_text: string;
  department_id: string | null;
  department_label: string | null;
  task_id: string | null;
  task_title: string | null;
  rating: number | null;
  rating_comment: string | null;
}

export interface DailyWorkFocusRange {
  from: string;
  to: string;
  label: string;
}

interface ClientPortalDailyWorkProps {
  focusRange: DailyWorkFocusRange | null;
  onClearFocusRange: () => void;
}

const OTHER_DEPARTMENT_LABEL = 'Other Work';
const RECENT_DATES_EXPANDED = 5;

function draftKey(date: string, departmentKey: string): string {
  return `${date}__${departmentKey}`;
}

const StarRating: React.FC<{ value: number; onChange: (value: number) => void; disabled?: boolean }> = ({
  value,
  onChange,
  disabled,
}) => (
  <div className="flex items-center gap-0.5">
    {[1, 2, 3, 4, 5].map((n) => (
      <button
        key={n}
        type="button"
        disabled={disabled}
        onClick={() => onChange(n)}
        className="p-0.5 disabled:cursor-not-allowed"
        aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
      >
        <Star
          className={`w-4 h-4 transition-colors ${
            n <= value ? 'text-amber-400 fill-amber-400' : 'text-stone-700'
          }`}
        />
      </button>
    ))}
  </div>
);

// Section inside the client portal showing the client's own work, grouped by day and then by
// department — reuses public.daily_logs (the same source Reports are built from) rather than a
// separate feed, so there is exactly one place staff log "what we did" and the client always sees
// the same underlying record. Each department/day group carries its own star rating + optional
// comment, submitted via portal_submit_work_rating() (upsert, one rating per department per day).
export const ClientPortalDailyWork: React.FC<ClientPortalDailyWorkProps> = ({ focusRange, onClearFocusRange }) => {
  const [rows, setRows] = useState<PortalDailyWorkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, { rating: number; comment: string }>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.rpc('portal_get_daily_work', {
      p_from: focusRange?.from ?? null,
      p_to: focusRange?.to ?? null,
    });
    setRows((data as PortalDailyWorkRow[]) || []);
    setLoading(false);
  }, [focusRange]);

  useEffect(() => {
    load();
  }, [load]);

  const groupedByDate = useMemo(() => {
    const byDate = new Map<string, Map<string, { label: string; departmentId: string | null; items: PortalDailyWorkRow[] }>>();
    for (const row of rows) {
      if (!byDate.has(row.work_date)) byDate.set(row.work_date, new Map());
      const deptKey = row.department_id || '__other__';
      const deptLabel = row.department_label || OTHER_DEPARTMENT_LABEL;
      const deptMap = byDate.get(row.work_date)!;
      if (!deptMap.has(deptKey)) deptMap.set(deptKey, { label: deptLabel, departmentId: row.department_id, items: [] });
      deptMap.get(deptKey)!.items.push(row);
    }
    return [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, deptMap]) => ({
        date,
        departments: [...deptMap.entries()]
          .sort((a, b) => a[1].label.localeCompare(b[1].label))
          .map(([deptKey, info]) => ({ deptKey, ...info })),
      }));
  }, [rows]);

  useEffect(() => {
    if (focusRange) {
      setExpandedDates(new Set(groupedByDate.map((g) => g.date)));
    } else {
      setExpandedDates(new Set(groupedByDate.slice(0, RECENT_DATES_EXPANDED).map((g) => g.date)));
    }
    // Only re-run when the set of dates actually changes shape, not on every rating edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedByDate.length, focusRange]);

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const submitRating = async (date: string, departmentId: string, deptKey: string) => {
    const key = draftKey(date, deptKey);
    const draft = drafts[key];
    if (!draft || !draft.rating) return;
    setSavingKey(key);
    const { error } = await supabase.rpc('portal_submit_work_rating', {
      p_department_id: departmentId,
      p_work_date: date,
      p_rating: draft.rating,
      p_comment: draft.comment.trim() || null,
    });
    setSavingKey(null);
    if (!error) {
      setRows((prev) =>
        prev.map((r) =>
          r.work_date === date && r.department_id === departmentId
            ? { ...r, rating: draft.rating, rating_comment: draft.comment.trim() || null }
            : r
        )
      );
      setSavedKey(key);
      setTimeout(() => setSavedKey((current) => (current === key ? null : current)), 2500);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-xs text-stone-500">Loading your daily work...</div>;
  }

  if (groupedByDate.length === 0) {
    return (
      <div className="p-6 text-center rounded-xl border border-dashed border-stone-800 bg-stone-900/30">
        <p className="text-xs text-stone-500">
          {focusRange ? 'No logged work found for this report\'s period yet.' : 'No work has been logged for you yet — check back soon.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {focusRange && (
        <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-purple-950/40 border border-purple-900/40">
          <p className="text-[11px] text-purple-200">
            Showing work logged during <span className="font-bold">{focusRange.label}</span>
          </p>
          <button
            type="button"
            onClick={onClearFocusRange}
            className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-white shrink-0"
          >
            <X className="w-3 h-3" /> Show everything
          </button>
        </div>
      )}

      {groupedByDate.map(({ date, departments }) => {
        const expanded = expandedDates.has(date);
        return (
          <div key={date} className="rounded-xl border border-stone-800 bg-stone-900/40 overflow-hidden">
            <button
              type="button"
              onClick={() => toggleDate(date)}
              className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-stone-900/70 transition-colors"
            >
              <span className="flex items-center gap-2 text-xs font-bold text-white">
                <CalendarDays className="w-3.5 h-3.5 text-purple-400" />
                {new Date(date).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
              <span className="flex items-center gap-2 text-[10px] text-stone-500">
                {departments.length} {departments.length === 1 ? 'department' : 'departments'}
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </span>
            </button>

            {expanded && (
              <div className="divide-y divide-stone-800/80">
                {departments.map(({ deptKey, label, departmentId, items }) => {
                  const key = draftKey(date, deptKey);
                  const existingRating = items[0]?.rating ?? 0;
                  const existingComment = items[0]?.rating_comment ?? '';
                  const draft = drafts[key] ?? { rating: existingRating, comment: existingComment };
                  const canRate = !!departmentId;
                  const hasSavedRating = existingRating > 0;

                  return (
                    <div key={deptKey} className="px-4 py-3 space-y-2.5">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <h4 className="text-xs font-bold text-white">{label}</h4>
                      </div>

                      <ul className="space-y-1.5 pl-5">
                        {items.map((item) => (
                          <li key={item.log_id} className="text-[11px] text-stone-300 list-disc">
                            {item.summary_text}
                            {item.task_title && <span className="text-stone-500"> — {item.task_title}</span>}
                          </li>
                        ))}
                      </ul>

                      {canRate && (
                        <div className="flex flex-wrap items-center gap-3 pl-5 pt-1">
                          <StarRating
                            value={draft.rating}
                            onChange={(value) => setDrafts((prev) => ({ ...prev, [key]: { ...draft, rating: value } }))}
                          />
                          <div className="flex items-center gap-1.5 flex-1 min-w-[180px]">
                            <MessageSquare className="w-3 h-3 text-stone-600 shrink-0" />
                            <input
                              type="text"
                              value={draft.comment}
                              onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: { ...draft, comment: e.target.value } }))}
                              placeholder="Add a comment (optional)"
                              className="flex-1 bg-transparent border-b border-stone-800 text-[11px] text-stone-200 focus:outline-none focus:border-purple-500 py-0.5"
                            />
                          </div>
                          <button
                            type="button"
                            disabled={!draft.rating || savingKey === key}
                            onClick={() => submitRating(date, departmentId!, deptKey)}
                            className="px-2.5 py-1 rounded-lg text-[10px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                          >
                            {savingKey === key ? 'Saving...' : savedKey === key ? 'Saved ✓' : hasSavedRating ? 'Update Rating' : 'Rate This'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
