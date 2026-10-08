import React from 'react';
import { ClientRecord, CampaignRecord, TaskRecord, SocialInsightRecord, SeoInsightRecord, UserRecord } from '../../types/database';
import { DepartmentComparisonPanel } from './DepartmentComparisonPanel';
import { ClientKpiOverview } from './ClientKpiOverview';

export const ExecutiveDashboard: React.FC<{
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  socialInsights: SocialInsightRecord[];
  seoInsights: SeoInsightRecord[];
  users: UserRecord[];
}> = ({ clients, campaigns, tasks, socialInsights, seoInsights, users }) => (
  <div className="space-y-6">
    <ClientKpiOverview clients={clients} />

    <DepartmentComparisonPanel
      clients={clients}
      campaigns={campaigns}
      tasks={tasks}
      socialInsights={socialInsights}
      seoInsights={seoInsights}
      users={users}
    />
  </div>
);
