import React, { useMemo, useState } from 'react';
import { Building2, Search, Clock, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { BriefFieldDef, ClientRecord, BriefRecord, BriefRevisionRecord, UserRecord, ServiceType } from '../types/database';
import { BriefFieldsReadOnly } from './BriefFieldsReadOnly';
import { BriefEditHistory } from './BriefEditHistory';

interface BriefRepositoryViewProps {
  clients: ClientRecord[];
  briefs: BriefRecord[];
  briefRevisions: BriefRevisionRecord[];
  users: UserRecord[];
  briefFieldSchemas: Record<ServiceType, BriefFieldDef[]>;
  onOpenFullDashboard: (clientId: string) => void;
}

const SERVICE_LABELS: Record<ServiceType, string> = {
  seo: 'SEO',
  social_media: 'Social Media',
  media_buying: 'Media Buying',
  creative: 'Creative',
};

const timeAgo = (iso: string): string => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

/**
 * Genuine read-only aggregated Brief Repository for AM Team Lead / AM Agent: every brief, across
 * every service and every (authorized) client, browsable on one filterable page — grouped by
 * client, each service collapsed to one summary row that expands inline via BriefFieldsReadOnly.
 * No save button, no edit form; "Open Full Dashboard" is the escape hatch to ClientDashboard for
 * when the full client context (assignment, lifecycle, etc.) is actually needed.
 */
export const BriefRepositoryView: React.FC<BriefRepositoryViewProps> = ({
  clients,
  briefs,
  briefRevisions,
  users,
  briefFieldSchemas,
  onOpenFullDashboard,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [serviceFilter, setServiceFilter] = useState<'all' | ServiceType>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'submitted' | 'missing'>('all');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleRow = (key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submittedBy = (userId: string) => users.find((u) => u.id === userId)?.name || userId;

  const rows = useMemo(() => {
    return clients
      .filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (c.industry || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
      .map((client) => {
        const services = client.services || [];
        const serviceRows = services
          .filter((s) => serviceFilter === 'all' || s === serviceFilter)
          .map((s) => {
            const brief = briefs.find((b) => b.client_id === client.id && b.service_type === s);
            return { service: s, brief };
          })
          .filter((row) => {
            if (statusFilter === 'submitted') return !!row.brief;
            if (statusFilter === 'missing') return !row.brief;
            return true;
          });
        return { client, serviceRows };
      })
      .filter((entry) => entry.serviceRows.length > 0);
  }, [clients, briefs, searchQuery, serviceFilter, statusFilter]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search clients or industry..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-400"
          />
        </div>
        <div className="flex items-center gap-1 bg-stone-900/60 p-1 rounded-xl border border-stone-800 text-[11px]">
          {(['all', 'seo', 'social_media', 'media_buying', 'creative'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setServiceFilter(s)}
              className={`px-2.5 py-1 rounded font-medium transition-all whitespace-nowrap ${
                serviceFilter === s ? 'bg-purple-600 text-white shadow' : 'text-stone-400 hover:text-white'
              }`}
            >
              {s === 'all' ? 'All Services' : SERVICE_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-stone-900/60 p-1 rounded-xl border border-stone-800 text-[11px]">
          {(['all', 'submitted', 'missing'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded font-medium transition-all capitalize ${
                statusFilter === s ? 'bg-purple-600 text-white shadow' : 'text-stone-400 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped-by-client list */}
      {rows.length === 0 ? (
        <div className="p-8 text-center rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}>
          <p className="text-xs text-stone-400">No briefs match the current filters.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(({ client, serviceRows }) => (
            <div
              key={client.id}
              className="rounded-2xl border overflow-hidden"
              style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}
            >
              <div className="p-4 border-b border-purple-900/30 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-purple-900/30 border border-purple-700/30 flex items-center justify-center font-bold text-purple-300 shrink-0">
                    {client.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">{client.name}</h3>
                    <span className="text-[11px] text-stone-400">{client.industry || 'General Business'}</span>
                  </div>
                </div>
                <button
                  onClick={() => onOpenFullDashboard(client.id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all inline-flex items-center gap-1.5 shrink-0"
                >
                  <span>Open Full Dashboard</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-purple-900/20">
                {serviceRows.map(({ service, brief }) => {
                  const rowKey = `${client.id}:${service}`;
                  const isExpanded = expandedRows.has(rowKey);
                  if (!brief) {
                    return (
                      <div key={rowKey} className="px-4 py-3 flex items-center gap-2 text-xs">
                        <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="font-bold text-white">{SERVICE_LABELS[service]}</span>
                        <span className="text-stone-500">— Pending submission</span>
                      </div>
                    );
                  }
                  return (
                    <div key={rowKey}>
                      <button
                        onClick={() => toggleRow(rowKey)}
                        className="w-full px-4 py-3 flex items-center justify-between text-xs hover:bg-purple-950/20 transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-stone-400" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-stone-400" />
                          )}
                          <span className="font-bold text-white">{SERVICE_LABELS[service]} Brief</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-950/60 text-purple-300 border border-purple-800/40">
                            v{brief.version}
                          </span>
                        </span>
                        <span className="text-stone-400">
                          {submittedBy(brief.submitted_by)} · {timeAgo(brief.updated_at || brief.created_at || new Date().toISOString())}
                        </span>
                      </button>
                      {isExpanded && (
                        <div className="p-4 bg-black/20 space-y-3">
                          <BriefFieldsReadOnly
                            fields={brief.fields}
                            fieldDefs={briefFieldSchemas[service] || []}
                            customFieldDefs={brief.custom_field_defs}
                          />
                          <BriefEditHistory
                            revisions={briefRevisions.filter((r) => r.brief_id === brief.id)}
                            fieldDefs={briefFieldSchemas[service] || []}
                            customFieldDefs={brief.custom_field_defs}
                            users={users}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
