import React, { useState } from 'react';
import { X, FileText, CheckCircle2, ClipboardList, BarChart3 } from 'lucide-react';
import { BriefFieldDef, ClientRecord, ReportRecord, ClientComparisonRecord, BriefRecord, TaskRecord, ServiceType } from '../../types/database';
import { computeClientTaskCompletionStats, monthLabelToRange } from '../../lib/reportingEngine';
import { ServiceMetricsCard } from './ComparisonDisplay';
import { BriefFieldsReadOnly } from '../BriefFieldsReadOnly';

const SERVICE_LABELS: Record<ServiceType, string> = {
  media_buying: 'Media Buying',
  seo: 'SEO',
  social_media: 'Social Media',
  creative: 'Creative',
};

// Module 9, point 4: a monthly report draft is an auto-compiled document — the client's period
// summary (already computed by generatePeriodSummary at generation time, re-derived here for
// display exactly like every other comparison) plus a brief snapshot and task-delivery stats,
// none of which is stored as rendered text — consistent with how this app already treats
// comparison narratives as re-derived-at-render-time, not persisted content. Requires an explicit
// Approve action (report.status: 'draft' -> 'final') before it's treated as final.
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
}> = ({ client, report, comparison, briefs, tasks, briefFieldSchemas, canApprove, onApprove, onClose }) => {
  const [isApproving, setIsApproving] = useState(false);
  const isDraft = report.status === 'draft';

  const range = monthLabelToRange(report.period);
  const taskStats = range ? computeClientTaskCompletionStats(tasks, client.id, range) : null;

  const clientBriefs = briefs.filter((b) => b.client_id === client.id);

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
              <ServiceMetricsCard
                serviceKey="media_buying"
                title="Media Buying"
                current={comparison.metrics_current.media_buying}
                flat
              />
              <ServiceMetricsCard
                serviceKey="social_media"
                title="Social Media"
                current={comparison.metrics_current.social_media}
                flat
              />
              <ServiceMetricsCard serviceKey="seo" title="SEO (Delivery)" current={comparison.metrics_current.seo} flat />
            </div>
          </div>
        )}

        {/* Task delivery */}
        {taskStats && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Task Delivery</span>
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg border border-purple-900/20 bg-purple-950/10 text-center">
                <p className="text-lg font-bold text-white">{taskStats.totalTasks}</p>
                <p className="text-[11px] text-stone-400">Total Tasks</p>
              </div>
              <div className="p-3 rounded-lg border border-purple-900/20 bg-purple-950/10 text-center">
                <p className="text-lg font-bold text-emerald-400">{taskStats.completedTasks}</p>
                <p className="text-[11px] text-stone-400">Completed This Period</p>
              </div>
              <div className="p-3 rounded-lg border border-purple-900/20 bg-purple-950/10 text-center">
                <p className="text-lg font-bold text-purple-300">
                  {taskStats.onTimeRate === null ? 'N/A' : `${taskStats.onTimeRate}%`}
                </p>
                <p className="text-[11px] text-stone-400">On-Time Rate</p>
              </div>
            </div>
          </div>
        )}

        {/* Brief snapshot */}
        {clientBriefs.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-purple-400" />
              <span>Service Briefs Snapshot</span>
            </h3>
            {clientBriefs.map((brief) => (
              <div key={brief.id} className="p-3 rounded-xl border border-purple-900/20 bg-purple-950/10 space-y-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wide">
                  {SERVICE_LABELS[brief.service_type] || brief.service_type}
                </h4>
                <BriefFieldsReadOnly
                  fields={brief.fields}
                  fieldDefs={briefFieldSchemas[brief.service_type] || []}
                  customFieldDefs={brief.custom_field_defs}
                />
              </div>
            ))}
          </div>
        )}

        {isDraft && (
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
            {canApprove ? (
              <button
                onClick={handleApprove}
                disabled={isApproving}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white shadow-md hover:opacity-90 disabled:opacity-50 transition-all"
                style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
              >
                {isApproving ? 'Approving...' : 'Approve & Mark Final'}
              </button>
            ) : (
              <p className="text-[11px] text-stone-500">Only the account's AM team/leadership can approve this draft.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
