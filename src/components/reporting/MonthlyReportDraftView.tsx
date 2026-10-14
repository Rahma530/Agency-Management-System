import React, { useState } from 'react';
import { X, FileText, BarChart3, AlertTriangle } from 'lucide-react';
import { BriefFieldDef, ClientRecord, ReportRecord, ClientComparisonRecord, BriefRecord, TaskRecord, ServiceType } from '../../types/database';
import { ServiceMetricsCard } from './ComparisonDisplay';

// Module 9, point 4: a monthly report draft is an auto-compiled document — the client's period
// summary persisted on client_comparisons. Historical legacy rows never stored task/brief
// snapshots, so this view deliberately does not rebuild those sections from mutable live data.
// Requires an explicit Approve action only when a safe saved version exists.
//
// viewerServiceFilter: this view is reachable from "Filed Reports" by any hasComparisonAccess
// viewer, including a department agent/team lead scoped to one service (Stage C) — previously this
// component ignored that scoping entirely and always rendered every service's metrics AND every
// service's brief snapshot, unlike ComparisonCard/ServiceMetricsCard elsewhere, which Stage C
// already narrows. Same convention as ComparisonCard: undefined = viewer sees every service
// (AM/leadership); an array narrows both the metrics cards and which briefs are shown.
export const MonthlyReportDraftView: React.FC<{
  client: ClientRecord;
  report: ReportRecord;
  comparison: ClientComparisonRecord | null;
  briefs: BriefRecord[];
  tasks: TaskRecord[];
  briefFieldSchemas: Record<ServiceType, BriefFieldDef[]>;
  canApprove: boolean;
  onApprove: () => Promise<void>;
  onClose: () => void;
  viewerServiceFilter?: ServiceType[];
}> = ({ client, report, comparison, canApprove, onApprove, onClose, viewerServiceFilter }) => {
  const [isApproving, setIsApproving] = useState(false);
  const isDraft = report.status === 'draft';
  const hasSavedVersion = !!report.current_version_id;


  const handleApprove = async () => {
    setIsApproving(true);
    try {
      await onApprove();
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-[24px] p-6 space-y-6 shadow-2xl relative"
        style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-start justify-between border-b border-stone-800 pb-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-medium)' }}
            >
              <FileText className="w-5 h-5 text-purple-300" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Monthly Report Draft — {client.name}
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                    isDraft ? 'text-amber-200 bg-amber-900/50' : 'text-emerald-200 bg-emerald-900/50'
                  }`}
                >
                  {report.status}
                </span>
              </h2>
              <p className="text-xs text-stone-400 mt-0.5">
                Period: {report.period} • Auto-compiled from performance data, briefs, and task delivery
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-stone-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Performance */}
        {comparison && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              <span>Performance This Period</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {(!viewerServiceFilter || viewerServiceFilter.includes('media_buying')) && (
                <ServiceMetricsCard
                  serviceKey="media_buying"
                  title="Media Buying"
                  current={comparison.metrics_current.media_buying}
                  flat
                />
              )}
              {(!viewerServiceFilter || viewerServiceFilter.includes('social_media')) && (
                <ServiceMetricsCard
                  serviceKey="social_media"
                  title="Social Media"
                  current={comparison.metrics_current.social_media}
                  flat
                />
              )}
              {(!viewerServiceFilter || viewerServiceFilter.includes('seo')) && (
                <ServiceMetricsCard serviceKey="seo" title="SEO (Delivery)" current={comparison.metrics_current.seo} flat />
              )}
            </div>
          </div>
        )}

        <div className="p-3 rounded-xl border border-amber-800/40 bg-amber-950/20 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-100">Legacy report: the saved comparison above is preserved. Live Tasks and Briefs are intentionally not re-derived because this report predates immutable source snapshots.</p>
        </div>

        {isDraft && hasSavedVersion && (
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
            {canApprove ? (
              <button
                onClick={handleApprove}
                disabled={isApproving}
                className="filled-purple-action px-4 py-2 rounded-xl text-xs font-bold text-white shadow-md hover:opacity-90 disabled:opacity-50 transition-all"
                style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
              >
                {isApproving ? 'Approving...' : 'Approve & Mark Final'}
              </button>
            ) : (
              <p className="text-[11px] text-stone-500">Only the account's AM team/leadership can approve this draft.</p>
            )}
          </div>
        )}
        {isDraft && !hasSavedVersion && <p className="text-[11px] text-amber-200 text-right">This legacy draft cannot be approved because it has no immutable saved content version.</p>}
      </div>
    </div>
  );
};
