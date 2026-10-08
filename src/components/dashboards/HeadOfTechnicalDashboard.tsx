import React from 'react';
import { ClientRecord, CampaignRecord, TaskRecord, SocialInsightRecord, SeoInsightRecord, UserRecord } from '../../types/database';
import { DepartmentComparisonPanel } from './DepartmentComparisonPanel';
import { ClientKpiOverview } from './ClientKpiOverview';

// Head of Technical and AI Engineer share the same organization-wide client KPI scope while
// retaining the technical department comparison below it.
export const HeadOfTechnicalDashboard: React.FC<{
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
      services={['media_buying', 'seo', 'social_media']}
    />
  </div>
);
