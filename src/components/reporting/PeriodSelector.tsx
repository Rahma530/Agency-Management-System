import React from 'react';
import { BarChart3 } from 'lucide-react';
import { ComparisonGranularity, DateRange, resolveComparisonPeriods } from '../../lib/reportingEngine';

export const GRANULARITY_OPTIONS: { value: ComparisonGranularity | 'custom'; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom Range' },
];

// Granularity/custom-date-range controls plus the "Generate Comparison" action itself — shared
// between ClientDashboard's per-client tab and the role-agnostic ReportsHub, which otherwise
// differ only in what a "scope" means (one client vs. a pooled set) and how they wire the action.
export const PeriodSelector: React.FC<{
  title?: string;
  granularity: ComparisonGranularity | 'custom';
  onGranularityChange: (g: ComparisonGranularity | 'custom') => void;
  customCurrentRange: DateRange;
  onCustomCurrentRangeChange: (r: DateRange) => void;
  // Only needed when singlePeriod is false (the default) — a period-summary report has no prior
  // period to pick.
  customPreviousRange?: DateRange;
  onCustomPreviousRangeChange?: (r: DateRange) => void;
  canGenerate: boolean;
  isGenerating: boolean;
  onGenerate: () => void;
  disabledReason?: string;
  generateLabel?: string;
  // When true, only one period is collected (no "Previous Period" side) — for a single-period
  // snapshot report rather than a current-vs-previous comparison.
  singlePeriod?: boolean;
}> = ({
  title,
  granularity,
  onGranularityChange,
  customCurrentRange,
  onCustomCurrentRangeChange,
  customPreviousRange,
  onCustomPreviousRangeChange,
  canGenerate,
  isGenerating,
  onGenerate,
  disabledReason = "Generation isn't available from this screen.",
  generateLabel,
  singlePeriod = false,
}) => {
  const previewPeriods = granularity !== 'custom' ? resolveComparisonPeriods(granularity) : null;
  const resolvedTitle = title ?? (singlePeriod ? 'Generate Period Report' : 'Generate Period Comparison');
  const resolvedGenerateLabel = generateLabel ?? (singlePeriod ? 'Generate Period Report' : 'Generate Comparison');

  return (
    <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
      <h3 className="text-sm font-bold text-white flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-purple-400" />
        <span>{resolvedTitle}</span>
      </h3>

      <div className="flex items-center gap-2 flex-wrap">
        {GRANULARITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onGranularityChange(opt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              granularity === opt.value
                ? 'bg-purple-600 text-white shadow'
                : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {granularity === 'custom' ? (
        <div className={singlePeriod ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 sm:grid-cols-2 gap-3'}>
          <div className="p-3 rounded-lg border border-purple-900/20 bg-purple-950/10 space-y-1.5">
            <span className="text-[11px] font-semibold text-purple-300 uppercase">
              {singlePeriod ? 'Period' : 'Current Period'}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customCurrentRange.start}
                onChange={(e) => onCustomCurrentRangeChange({ ...customCurrentRange, start: e.target.value })}
                className="w-full px-2 py-1.5 rounded-lg text-xs bg-[#100c1c] border border-purple-900/40 text-white focus:outline-none"
              />
              <span className="text-stone-500 text-xs">to</span>
              <input
                type="date"
                value={customCurrentRange.end}
                onChange={(e) => onCustomCurrentRangeChange({ ...customCurrentRange, end: e.target.value })}
                className="w-full px-2 py-1.5 rounded-lg text-xs bg-[#100c1c] border border-purple-900/40 text-white focus:outline-none"
              />
            </div>
          </div>
          {!singlePeriod && customPreviousRange && onCustomPreviousRangeChange && (
            <div className="p-3 rounded-lg border border-purple-900/20 bg-purple-950/10 space-y-1.5">
              <span className="text-[11px] font-semibold text-purple-300 uppercase">Previous Period</span>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={customPreviousRange.start}
                  onChange={(e) => onCustomPreviousRangeChange({ ...customPreviousRange, start: e.target.value })}
                  className="w-full px-2 py-1.5 rounded-lg text-xs bg-[#100c1c] border border-purple-900/40 text-white focus:outline-none"
                />
                <span className="text-stone-500 text-xs">to</span>
                <input
                  type="date"
                  value={customPreviousRange.end}
                  onChange={(e) => onCustomPreviousRangeChange({ ...customPreviousRange, end: e.target.value })}
                  className="w-full px-2 py-1.5 rounded-lg text-xs bg-[#100c1c] border border-purple-900/40 text-white focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>
      ) : previewPeriods ? (
        <p className="text-[11px] text-stone-400">
          {singlePeriod ? (
            <>
              Will summarize <strong className="text-white">{previewPeriods.current.label}</strong>.
            </>
          ) : (
            <>
              Will compare <strong className="text-white">{previewPeriods.current.label}</strong> against{' '}
              <strong className="text-white">{previewPeriods.previous.label}</strong>.
            </>
          )}
        </p>
      ) : null}

      <div className="flex items-center justify-between pt-1">
        {canGenerate ? (
          <button
            onClick={onGenerate}
            disabled={isGenerating}
            className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 transition-all"
          >
            {isGenerating ? 'Generating...' : resolvedGenerateLabel}
          </button>
        ) : (
          <span className="text-[11px] text-stone-500">{disabledReason}</span>
        )}
      </div>
    </div>
  );
};
