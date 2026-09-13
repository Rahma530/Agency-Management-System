import React, { useEffect, useMemo, useState } from 'react';
import { Building2, LogOut, UserCheck, TrendingUp, FileText, ClipboardList } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import {
  BriefFieldDef,
  BriefFieldSchemaRow,
  ClientRecord,
  BriefRecord,
  ClientComparisonRecord,
  ReportRecord,
  ServiceType,
} from '../../types/database';
import { ComparisonCard, FiledReportsList } from '../reporting/ComparisonDisplay';
import { BriefFieldsReadOnly } from '../BriefFieldsReadOnly';
import { groupBriefFieldSchemas } from '../../data/briefFieldSchemas';

interface ClientPortalViewProps {
  client: ClientRecord;
  onSignOut: () => void;
}

const SERVICE_LABELS: Record<ServiceType, string> = {
  media_buying: 'Media Buying',
  seo: 'SEO',
  social_media: 'Social Media',
  creative: 'Creative',
};

// Purely read-only: reuses ComparisonCard/FiledReportsList from reporting/ComparisonDisplay.tsx
// exactly as staff screens do (their report-generation affordances are already optional props,
// simply omitted here) and BriefFieldsReadOnly for the same read-only brief rendering the
// specialist queues already use — no client-portal-specific display logic needed for either.
export const ClientPortalView: React.FC<ClientPortalViewProps> = ({ client, onSignOut }) => {
  const [amAgentName, setAmAgentName] = useState<string | null>(null);
  const [briefs, setBriefs] = useState<BriefRecord[]>([]);
  const [comparisons, setComparisons] = useState<ClientComparisonRecord[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [briefFieldSchemas, setBriefFieldSchemas] = useState<Record<ServiceType, BriefFieldDef[]>>({
    seo: [],
    social_media: [],
    media_buying: [],
    creative: [],
  });
  const [loading, setLoading] = useState(true);
  const [activeBriefService, setActiveBriefService] = useState<ServiceType | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [amNameRes, briefsRes, comparisonsRes, reportsRes, schemasRes] = await Promise.all([
        supabase.rpc('portal_am_agent_name'),
        supabase.from('briefs').select('*').eq('client_id', client.id),
        supabase.from('client_comparisons').select('*').eq('client_id', client.id).order('created_at', { ascending: false }),
        supabase.from('reports').select('*').eq('client_id', client.id).eq('type', 'client'),
        supabase.from('brief_field_schemas').select('*'),
      ]);

      if (cancelled) return;
      setAmAgentName((amNameRes.data as string) || null);
      setBriefs((briefsRes.data as BriefRecord[]) || []);
      setComparisons((comparisonsRes.data as ClientComparisonRecord[]) || []);
      setReports((reportsRes.data as ReportRecord[]) || []);
      setBriefFieldSchemas(groupBriefFieldSchemas((schemasRes.data as BriefFieldSchemaRow[]) || []));
      setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [client.id]);

  // Module 13 Phase 5: services now lives directly on the client row the portal fetch already
  // returned — no more package lookup needed.
  const services = useMemo(() => client.services || [], [client.services]);

  useEffect(() => {
    if (services.length > 0 && !activeBriefService) setActiveBriefService(services[0]);
  }, [services, activeBriefService]);

  const activeBrief = briefs.find((b) => b.service_type === activeBriefService);

  return (
    <div className="min-h-screen" style={{ background: 'var(--gradient-page)' }} dir="ltr">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center shadow-lg shrink-0"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-medium)' }}
            >
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">{client.name}</h1>
              <p className="text-xs text-stone-400">
                {services.length > 0 ? services.map((s) => SERVICE_LABELS[s] || s).join(' + ') : 'Your Plan'}
                {amAgentName && (
                  <>
                    {' '}
                    • <UserCheck className="w-3 h-3 inline -mt-0.5" /> Account Manager: {amAgentName}
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onSignOut}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-stone-300 hover:text-white bg-stone-900/60 hover:bg-stone-900 border border-stone-800 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-xs text-stone-500">Loading your portal...</div>
        ) : (
          <>
            {/* Comparisons */}
            <div className="space-y-3">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                Performance & Comparisons
              </h2>
              {comparisons.length === 0 ? (
                <div className="p-6 text-center rounded-xl border border-dashed border-stone-800 bg-stone-900/30">
                  <p className="text-xs text-stone-500">No performance reports have been published yet.</p>
                </div>
              ) : (
                comparisons.map((cmp) => <ComparisonCard key={cmp.id} comparison={cmp} />)
              )}
            </div>

            {/* Filed reports */}
            <div className="space-y-3">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-purple-400" />
                Reports
              </h2>
              <FiledReportsList reports={reports} comparisons={comparisons} clients={[client]} users={[]} />
            </div>

            {/* Briefs */}
            {services.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-purple-400" />
                  What We Documented About Your Needs
                </h2>
                <div className="flex items-center gap-2 flex-wrap">
                  {services.map((s) => (
                    <button
                      key={s}
                      onClick={() => setActiveBriefService(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        activeBriefService === s ? 'bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
                      }`}
                    >
                      {SERVICE_LABELS[s] || s}
                    </button>
                  ))}
                </div>
                {activeBriefService && (
                  <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80">
                    {activeBrief ? (
                      <BriefFieldsReadOnly
                        fields={activeBrief.fields}
                        fieldDefs={briefFieldSchemas[activeBriefService] || []}
                        customFieldDefs={activeBrief.custom_field_defs}
                      />
                    ) : (
                      <p className="text-xs text-stone-500 text-center py-4">Nothing documented for this service yet.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
