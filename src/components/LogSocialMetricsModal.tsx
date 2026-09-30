import React, { useState } from 'react';
import { X, Share2 } from 'lucide-react';

type SocialPlatform = 'facebook' | 'instagram' | 'tiktok' | 'x' | 'linkedin';

const PLATFORM_OPTIONS: { value: SocialPlatform; label: string }[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'x', label: 'X (Twitter)' },
  { value: 'linkedin', label: 'LinkedIn' },
];

// Monday-anchored — this app has no pre-existing "week" convention anywhere else, so this
// function defines it for the first time, purely for this form's own default value.
function currentWeekMonday(): string {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  return monday.toISOString().split('T')[0];
}

interface LogSocialMetricsModalProps {
  clientName: string;
  onClose: () => void;
  onSubmit: (
    platform: SocialPlatform,
    weekStartDate: string,
    metrics: { reach: number | null; engagement_rate: number | null; follower_growth: number | null }
  ) => Promise<void>;
}

// Weekly manual-entry form for social_insights (reach / engagement_rate / follower_growth) — the
// write path this table never had (see 20261025000000_social_insights_weekly_manual_entry.sql).
// Mirrors CapacityManagement.tsx's "Log New Capacity Reading" modal shape, but always upserts
// (onConflict: client_id, platform, week_start_date) rather than plain-inserting, since an agent
// editing an already-entered week's numbers should overwrite them, not create a duplicate row.
export const LogSocialMetricsModal: React.FC<LogSocialMetricsModalProps> = ({ clientName, onClose, onSubmit }) => {
  const [platform, setPlatform] = useState<SocialPlatform>('instagram');
  const [weekStartDate, setWeekStartDate] = useState(currentWeekMonday());
  const [reach, setReach] = useState('');
  const [engagementRate, setEngagementRate] = useState('');
  const [followerGrowth, setFollowerGrowth] = useState('');
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
      await onSubmit(platform, weekStartDate, {
        reach: toNumberOrNull(reach),
        engagement_rate: toNumberOrNull(engagementRate),
        follower_growth: toNumberOrNull(followerGrowth),
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
              <Share2 className="w-4 h-4 text-pink-400" />
              Log This Week's Social Metrics
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-stone-300 mb-1.5">Platform</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as SocialPlatform)}
                disabled={isSubmitting}
                className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-purple-400 disabled:opacity-50"
              >
                {PLATFORM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-stone-900 text-white">
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
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
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Reach</label>
            <input
              type="number"
              min="0"
              value={reach}
              onChange={(e) => setReach(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 42000"
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Engagement Rate (%)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={engagementRate}
              onChange={(e) => setEngagementRate(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 3.4"
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-300 mb-1.5">Follower Growth</label>
            <input
              type="number"
              step="1"
              value={followerGrowth}
              onChange={(e) => setFollowerGrowth(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 150 (or -20)"
              className="w-full bg-[#110d1c] border border-purple-900/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:border-purple-400 disabled:opacity-50"
            />
            <p className="text-[10px] text-stone-500 mt-1.5">Net new followers this week — negative values are allowed.</p>
          </div>

          <p className="text-[10px] text-stone-500">
            Submitting again for the same platform and week overwrites that week's numbers rather than creating a duplicate entry.
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
