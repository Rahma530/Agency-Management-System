import React, { useMemo } from 'react';
import { Building2, Users, Gauge, FileText, AlertTriangle, ExternalLink } from 'lucide-react';
import {
  UserRecord,
  UserRole,
  ClientRecord,
  AssignmentRecord,
  TaskRecord,
  BriefRecord,
  KpiScoreRecord,
  ServiceType,
} from '../../types/database';
import { AppModuleId } from '../../data/roles';
import { resolveClientsForSubject } from '../../lib/reportingEngine';
import { getUserCapacityData } from '../../lib/capacity';
import { STATUS_META } from '../../lib/performanceScore';
import { isActiveEmployee } from '../../lib/permissions';
import { isPausedClient } from '../../lib/clientStatus';

interface DeptConfig {
  team: string;
  agentRole: UserRole;
  service: ServiceType | null; // null = spans every service (Account Management)
  label: string;
  clientsModule: AppModuleId;
}

const TEAM_LEAD_DEPT_CONFIG: Partial<Record<UserRole, DeptConfig>> = {
  am_team_lead: { team: 'Account Management', agentRole: 'am_agent', service: null, label: 'Account Management', clientsModule: 'onboarding' },
  media_buying_team_lead: { team: 'Media Buying', agentRole: 'media_buying_agent', service: 'media_buying', label: 'Media Buying', clientsModule: 'service_briefs' },
  seo_team_lead: { team: 'SEO', agentRole: 'seo_agent', service: 'seo', label: 'SEO', clientsModule: 'service_briefs' },
  social_media_team_lead: { team: 'Social Media', agentRole: 'social_media_agent', service: 'social_media', label: 'Social Media', clientsModule: 'service_briefs' },
};

const isRenewalApproaching = (client: ClientRecord): boolean => {
  if (client.status !== 'active' || !client.renewal_date) return false;
  const daysUntil = (new Date(client.renewal_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysUntil <= 30 && daysUntil >= -365;
};

const SectionCard: React.FC<{
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  onOpen?: () => void;
  openLabel?: string;
  children: React.ReactNode;
}> = ({ title, icon: Icon, onOpen, openLabel = 'Open Full View', children }) => (
  <div className="p-4 rounded-2xl border space-y-3" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-purple-400" />
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      {onOpen && (
        <button onClick={onOpen} className="flex items-center gap-1 text-[11px] font-bold text-purple-300 hover:text-white transition-colors">
          {openLabel}
          <ExternalLink className="w-3 h-3" />
        </button>
      )}
    </div>
    {children}
  </div>
);

export const TeamLeadDashboard: React.FC<{
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  assignments: AssignmentRecord[];
  tasks: TaskRecord[];
  briefs: BriefRecord[];
  kpiScores: KpiScoreRecord[];
  onNavigateToModule?: (module: AppModuleId, prefillAssigneeName?: string) => void;
}> = ({ currentUser, users, clients, assignments, tasks, briefs, kpiScores, onNavigateToModule }) => {
  const config = TEAM_LEAD_DEPT_CONFIG[currentUser.role];

  const deptClients = useMemo(
    () => (config ? resolveClientsForSubject(currentUser, clients, assignments) : []),
    [config, currentUser, clients, assignments]
  );

  const statusCounts = useMemo(() => {
    const counts: Record<ClientRecord['status'], number> = { onboarding: 0, active: 0, paused: 0, renewal: 0, closed: 0 };
    deptClients.forEach((c) => {
      counts[c.status] = (counts[c.status] || 0) + 1;
    });
    return counts;
  }, [deptClients]);

  const clientHasBrief = (client: ClientRecord, service: ServiceType): boolean =>
    briefs.some((b) => b.client_id === client.id && b.service_type === service && b.version > 0);

  const isMissingBrief = (client: ClientRecord): boolean => {
    if (config?.service) return !clientHasBrief(client, config.service);
    // Account Management spans every service a client subscribes to — missing if any of them
    // has no documented brief yet.
    const services = client.services || [];
    return services.some((s) => !clientHasBrief(client, s));
  };

  // Decision (Module 13): paused clients are intentionally excluded from "needs attention" —
  // missing-brief and renewal alerts shouldn't fire for a client that's deliberately on hold.
  const needsAttention = useMemo(
    () =>
      deptClients
        .filter((c) => c.status !== 'closed' && !isPausedClient(c) && (isRenewalApproaching(c) || isMissingBrief(c)))
        .slice(0, 6),
    [deptClients, briefs, config]
  );

  const pendingBriefsCount = useMemo(
    () => deptClients.filter((c) => c.status !== 'closed' && !isPausedClient(c) && isMissingBrief(c)).length,
    [deptClients, briefs, config]
  );

  const deptAgents = useMemo(
    () => (config ? users.filter((u) => u.role === config.agentRole && isActiveEmployee(u)) : []),
    [users, config]
  );

  const latestScoreFor = (userId: string): KpiScoreRecord | null => {
    const own = kpiScores
      .filter((k) => k.user_id === userId)
      .sort((a, b) => (a.metrics?.period_start || '').localeCompare(b.metrics?.period_start || ''));
    return own[own.length - 1] || null;
  };

  const avgCapacityUtilization = useMemo(() => {
    const rates = deptAgents.map((u) => getUserCapacityData(u, clients, tasks)).filter((d) => !d.isUntracked).map((d) => d.utilizationRate);
    return rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
  }, [deptAgents, clients, tasks]);

  if (!config) {
    return (
      <div className="p-8 text-center rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}>
        <p className="text-xs text-stone-400">No dashboard configured for this role.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800">
          <span className="text-[11px] font-semibold text-stone-400 block mb-1">Active Clients</span>
          <p className="text-2xl font-bold text-white">{statusCounts.active + statusCounts.renewal}</p>
          <p className="text-[10px] text-stone-500 mt-1">{statusCounts.onboarding} onboarding</p>
        </div>
        <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800">
          <span className="text-[11px] font-semibold text-stone-400 block mb-1">Pending Briefs</span>
          <p className="text-2xl font-bold" style={{ color: pendingBriefsCount > 0 ? 'var(--roas-mid)' : 'var(--roas-good)' }}>
            {pendingBriefsCount}
          </p>
          <p className="text-[10px] text-stone-500 mt-1">Clients missing a documented brief</p>
        </div>
        <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800">
          <span className="text-[11px] font-semibold text-stone-400 block mb-1">Team Capacity</span>
          <p className="text-2xl font-bold text-white">{avgCapacityUtilization !== null ? `${avgCapacityUtilization}%` : 'N/A'}</p>
          <p className="text-[10px] text-stone-500 mt-1">Avg. utilization, {deptAgents.length} agents</p>
        </div>
        <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800">
          <span className="text-[11px] font-semibold text-stone-400 block mb-1">Needs Attention</span>
          <p className="text-2xl font-bold" style={{ color: needsAttention.length > 0 ? 'var(--roas-bad)' : 'var(--roas-good)' }}>
            {needsAttention.length}
          </p>
          <p className="text-[10px] text-stone-500 mt-1">Renewal approaching or brief missing</p>
        </div>
      </div>

      <SectionCard
        title={`${config.label} Clients`}
        icon={Building2}
        onOpen={() => onNavigateToModule?.(config.clientsModule)}
        openLabel="Open Full Client List"
      >
        {needsAttention.length === 0 ? (
          <p className="text-xs text-stone-500 py-3 text-center">Nothing needs attention right now.</p>
        ) : (
          <div className="space-y-1.5">
            {needsAttention.map((c) => (
              <div key={c.id} className="flex items-center justify-between p-2 rounded-lg bg-stone-900/60 border border-stone-800 text-xs">
                <span className="font-semibold text-white">{c.name}</span>
                <span className="text-[10px] text-amber-300 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {isRenewalApproaching(c) ? 'Renewal approaching' : 'Missing brief'}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Employee Performance"
        icon={Users}
        onOpen={() => onNavigateToModule?.('capacity')}
        openLabel="Open Capacity & Performance"
      >
        {deptAgents.length === 0 ? (
          <p className="text-xs text-stone-500 py-3 text-center">No agents in this department yet.</p>
        ) : (
          <div className="space-y-1.5">
            {deptAgents.map((u) => {
              const score = latestScoreFor(u.id);
              const meta = score?.suggested_status ? STATUS_META[score.suggested_status] : null;
              return (
                <div key={u.id} className="flex items-center justify-between p-2 rounded-lg bg-stone-900/60 border border-stone-800 text-xs">
                  <span className="font-semibold text-white">{u.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-stone-300">{score ? `${score.overall_score}/100` : 'No score yet'}</span>
                    {meta && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ color: meta.color, background: 'rgba(0,0,0,0.25)' }}>
                        {meta.label}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Capacity"
        icon={Gauge}
        onOpen={() => onNavigateToModule?.('capacity')}
        openLabel="Open Capacity Management"
      >
        <p className="text-xs text-stone-400">
          {avgCapacityUtilization !== null
            ? `Department averaging ${avgCapacityUtilization}% utilization across ${deptAgents.length} agents.`
            : 'No tracked capacity data for this department yet.'}
        </p>
      </SectionCard>

      <SectionCard
        title="Service Briefs"
        icon={FileText}
        onOpen={() => onNavigateToModule?.('service_briefs')}
        openLabel="Open Service Briefs"
      >
        <p className="text-xs text-stone-400">
          {pendingBriefsCount > 0
            ? `${pendingBriefsCount} client${pendingBriefsCount === 1 ? '' : 's'} still missing a documented brief.`
            : 'All clients have a documented brief.'}
        </p>
      </SectionCard>
    </div>
  );
};
