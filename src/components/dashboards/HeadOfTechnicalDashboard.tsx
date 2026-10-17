import React from 'react';
import { ClientRecord, CampaignRecord, TaskRecord, TaskAssigneeRecord, AssignmentRecord, SocialInsightRecord, SeoInsightRecord, UserRecord } from '../../types/database';
import { DepartmentComparisonPanel } from './DepartmentComparisonPanel';
import { ClientKpiOverview } from './ClientKpiOverview';

// Head of Technical and AI Engineer share the same organization-wide client KPI scope while
// retaining the technical department comparison below it.
export const HeadOfTechnicalDashboard: React.FC<{
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  // Needed by DepartmentComparisonPanel's own getUserCapacityData calls — see src/lib/capacity.ts.
  taskAssignees: TaskAssigneeRecord[];
  assignments: AssignmentRecord[];
  socialInsights: SocialInsightRecord[];
  seoInsights: SeoInsightRecord[];
  users: UserRecord[];
}> = ({ clients, campaigns, tasks, taskAssignees, assignments, socialInsights, seoInsights, users }) => (
  <div className="space-y-6">
    <ClientKpiOverview clients={clients} />

    <DepartmentComparisonPanel
      clients={clients}
      campaigns={campaigns}
      tasks={tasks}
      taskAssignees={taskAssignees}
      assignments={assignments}
      socialInsights={socialInsights}
      seoInsights={seoInsights}
      users={users}
      services={['media_buying', 'seo', 'social_media']}
    />
  </div>
);
