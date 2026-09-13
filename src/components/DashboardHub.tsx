import React from 'react';
import {
  UserRecord,
  ClientRecord,
  CampaignRecord,
  TaskRecord,
  SocialInsightRecord,
  AssignmentRecord,
  BriefRecord,
  KpiScoreRecord,
} from '../types/database';
import { AppModuleId } from '../data/roles';
import { ExecutiveDashboard } from './dashboards/ExecutiveDashboard';
import { HeadOfTechnicalDashboard } from './dashboards/HeadOfTechnicalDashboard';
import { TeamLeadDashboard } from './dashboards/TeamLeadDashboard';

// Role router for Module 5's leadership dashboards. Executive and Head of Technical share the
// same DepartmentComparisonPanel (Executive just has org-wide financial tiles above it); the 4
// team lead roles get a single-department consolidated view instead — different enough in shape
// that forcing them into one component would mean branching everywhere inside it, so they're
// separate content components, routed from here the same way ReportsHub-style hubs already work
// elsewhere in this app.
interface DashboardHubProps {
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  socialInsights: SocialInsightRecord[];
  assignments: AssignmentRecord[];
  briefs: BriefRecord[];
  kpiScores: KpiScoreRecord[];
  onNavigateToModule?: (module: AppModuleId, prefillAssigneeName?: string) => void;
}

export const DashboardHub: React.FC<DashboardHubProps> = ({
  currentUser,
  users,
  clients,
  campaigns,
  tasks,
  socialInsights,
  assignments,
  briefs,
  kpiScores,
  onNavigateToModule,
}) => {
  if (currentUser.role === 'executive') {
    return (
      <ExecutiveDashboard
        clients={clients}
        campaigns={campaigns}
        tasks={tasks}
        socialInsights={socialInsights}
        users={users}
      />
    );
  }

  if (currentUser.role === 'head_of_technical') {
    return (
      <HeadOfTechnicalDashboard
        clients={clients}
        campaigns={campaigns}
        tasks={tasks}
        socialInsights={socialInsights}
        users={users}
      />
    );
  }

  if (
    currentUser.role === 'am_team_lead' ||
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
        kpiScores={kpiScores}
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
