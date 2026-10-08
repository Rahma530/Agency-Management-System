import React, { useMemo } from 'react';
import {
  UserRecord,
  ClientRecord,
  CampaignRecord,
  TaskRecord,
  SocialInsightRecord,
  SeoInsightRecord,
  AssignmentRecord,
  BriefRecord,
} from '../types/database';
import { AppModuleId } from '../data/roles';
import { ExecutiveDashboard } from './dashboards/ExecutiveDashboard';
import { HeadOfTechnicalDashboard } from './dashboards/HeadOfTechnicalDashboard';
import { TeamLeadDashboard } from './dashboards/TeamLeadDashboard';
import { ClientKpiOverview } from './dashboards/ClientKpiOverview';
import { resolveClientsForSubject } from '../lib/reportingEngine';

// Role router for Module 5's dashboards. Executive, Head of Technical, AI Engineer, AM Team Lead,
// and AM Agent receive the shared client KPI overview over their resolver-scoped client set;
// existing department comparison and team-lead operational content remains role-specific.
interface DashboardHubProps {
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  socialInsights: SocialInsightRecord[];
  seoInsights: SeoInsightRecord[];
  assignments: AssignmentRecord[];
  briefs: BriefRecord[];
  onNavigateToModule?: (module: AppModuleId, prefillAssigneeName?: string) => void;
}

export const DashboardHub: React.FC<DashboardHubProps> = ({
  currentUser,
  users,
  clients,
  campaigns,
  tasks,
  socialInsights,
  seoInsights,
  assignments,
  briefs,
  onNavigateToModule,
}) => {
  const scopedClients = useMemo(
    () => resolveClientsForSubject(currentUser, clients, assignments),
    [currentUser, clients, assignments]
  );

  if (currentUser.role === 'executive') {
    return (
      <ExecutiveDashboard
        clients={scopedClients}
        campaigns={campaigns}
        tasks={tasks}
        socialInsights={socialInsights}
        seoInsights={seoInsights}
        users={users}
      />
    );
  }

  if (currentUser.role === 'head_of_technical' || currentUser.role === 'ai_engineer') {
    return (
      <HeadOfTechnicalDashboard
        clients={scopedClients}
        campaigns={campaigns}
        tasks={tasks}
        socialInsights={socialInsights}
        seoInsights={seoInsights}
        users={users}
      />
    );
  }

  if (currentUser.role === 'am_team_lead') {
    return (
      <TeamLeadDashboard
        currentUser={currentUser}
        users={users}
        clients={clients}
        scopedClients={scopedClients}
        assignments={assignments}
        tasks={tasks}
        briefs={briefs}
        onNavigateToModule={onNavigateToModule}
      />
    );
  }

  if (currentUser.role === 'am_agent') {
    return <ClientKpiOverview clients={scopedClients} />;
  }

  if (
    currentUser.role === 'media_buying_team_lead' ||
    currentUser.role === 'seo_team_lead' ||
    currentUser.role === 'social_media_team_lead'
  ) {
    return (
      <TeamLeadDashboard
        currentUser={currentUser}
        users={users}
        clients={clients}
        assignments={assignments}
        tasks={tasks}
        briefs={briefs}
        onNavigateToModule={onNavigateToModule}
      />
    );
  }

  return (
    <div className="p-8 text-center rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}>
      <p className="text-xs text-stone-400">No dashboard is configured for your role.</p>
    </div>
  );
};
