import React, { useState } from 'react';
import { X, Search } from 'lucide-react';

// Monday-anchored — same convention as LogSocialMetricsModal.tsx/LogMediaBuyingMetricsModal.tsx's
// currentWeekMonday().
function currentWeekMonday(): string {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  return monday.toISOString().split('T')[0];
}

interface LogSeoMetricsModalProps {
  clientName: string;
  onClose: () => void;
  onSubmit: (
    weekStartDate: string,
    metrics: { organic_traffic: number | null; keywords_top10_count: number | null; backlinks_acquired: number | null }
  ) => Promise<void>;
}

// Weekly manual-entry form for seo_insights (organic_traffic / keywords_top10_count /
// backlinks_acquired) — the write path this table exists for (see
// 20261028000000_seo_insights.sql). Additive alongside the existing task-derived delivery proxy
// (completed_tasks/on_time_rate): this is what gives SEO a real performance signal, not just a
// delivery one. No platform selector, unlike LogSocialMetricsModal.tsx/
// LogMediaBuyingMetricsModal.tsx — SEO isn't multi-platform the way paid media/social are, so one
// row per client+week is enough. Mirrors both of those exactly otherwise: always upserts
// (onConflict: client_id, week_start_date) rather than plain-inserting, since re-entering an
// already-logged week should overwrite it, not create a duplicate row.
export const LogSeoMetricsModal: React.FC<LogSeoMetricsModalProps> = ({ clientName, onClose, onSubmit }) => {
  const [weekStartDate, setWeekStartDate] = useState(currentWeekMonday());
  const [organicTraffic, setOrganicTraffic] = useState('');
  const [keywordsTop10Count, setKeywordsTop10Count] = useState('');
  const [backlinksAcquired, setBacklinksAcquired] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const toNumberOrNull = (val: string): number | null => {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!weekStartDate) {
      setErrorMessage('Please choose the week this reading is for.');
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onSubmit(weekStartDate, {
        organic_traffic: toNumberOrNull(organicTraffic),
        keywords_top10_count: toNumberOrNull(keywordsTop10Count),
        backlinks_acquired: toNumberOrNull(backlinksAcquired),
      });
      onClose();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Unable to save this week\'s metrics. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div
        className="w-full max-w-md rounded-2xl p-6 shadow-2xl border"
        style={{ background: 'rgba(21, 16, 32, 0.96)', borderColor: 'var(--border-strong)' }}
      >
        <div className="flex items-center justify-between pb-3 border-b border-purple-900/40 mb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Search className="w-4 h-4 text-emerald-400" />
              Log This Week's SEO Metrics
            </h3>
            <p className="text-[11px] text-stone-400 mt-0.5">For {clientName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-stone-400 hover:text-white hover:bg-purple-900/30 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMessage && (
          <div
            className="mb-4 p-3 rounded-xl text-xs"
            style={{ background: 'rgba(245, 163, 163, 0.12)', color: 'var(--roas-bad)', border: '1px solid var(--roas-bad)' }}
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Week Starting (Mon)</label>
            <input
              type="date"
              value={weekStartDate}
              onChange={(e) => setWeekStartDate(e.target.value)}
              disabled={isSubmitting}
              required
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Organic Traffic</label>
            <input
              type="number"
              min="0"
              step="1"
              value={organicTraffic}
              onChange={(e) => setOrganicTraffic(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 4200"
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Keywords in Top 10</label>
            <input
              type="number"
              min="0"
              step="1"
              value={keywordsTop10Count}
              onChange={(e) => setKeywordsTop10Count(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 18"
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Backlinks Acquired</label>
            <input
              type="number"
              min="0"
              step="1"
              value={backlinksAcquired}
              onChange={(e) => setBacklinksAcquired(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 5"
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
          </div>

          <p className="text-[10px] text-stone-500">
            Leave any field blank if not known yet. Submitting again for the same week overwrites that week's numbers rather than creating a duplicate entry.
          </p>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs text-stone-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-lg transition-all disabled:opacity-50"
              style={{ background: 'var(--gradient-badge)' }}
            >
              {isSubmitting ? 'Saving...' : 'Save This Week\'s Metrics'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
