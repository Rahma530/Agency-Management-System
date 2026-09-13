import React from 'react';
import { ClientRecord, CampaignRecord, TaskRecord, SocialInsightRecord, UserRecord } from '../../types/database';
import { DepartmentComparisonPanel } from './DepartmentComparisonPanel';

// Head of Technical owns the 3 technical delivery teams (SEO, Media Buying, Social Media), not
// the org's financials — so unlike ExecutiveDashboard, this is purely the department comparison,
// with no revenue/client-count/churn tiles above it.
export const HeadOfTechnicalDashboard: React.FC<{
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  socialInsights: SocialInsightRecord[];
  users: UserRecord[];
}> = ({ clients, campaigns, tasks, socialInsights, users }) => (
  <div className="space-y-6">
    <DepartmentComparisonPanel
      clients={clients}
      campaigns={campaigns}
      tasks={tasks}
      socialInsights={socialInsights}
      users={users}
      services={['media_buying', 'seo', 'social_media']}
    />
  </div>
);
