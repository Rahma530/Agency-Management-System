import React from 'react';
import {
  Briefcase,
  Layers,
  Sparkles,
  Users,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { UserRecord, TaskRecord, ClientRecord } from '../types/database';
import { getRoleInfo } from '../data/roles';
import { isCurrentlyActiveClient } from '../lib/clientStatus';

interface RolePortalHeaderProps {
  currentUser: UserRecord;
  tasks: TaskRecord[];
  clients: ClientRecord[];
}

export const RolePortalHeader: React.FC<RolePortalHeaderProps> = ({
  currentUser,
  tasks,
  clients,
}) => {
  const role = currentUser?.role || 'executive';
  const roleInfo = getRoleInfo(role);

  // Compute quick dynamic KPIs based on the employee's role
  const currentUserId = currentUser?.id || '';
  const myTasks = currentUserId ? tasks.filter((t) => t.assigned_to === currentUserId) : [];
  const myActiveTasks = myTasks.filter((t) => t.status !== 'completed');
  const myBlockedTasks = myTasks.filter((t) => t.status === 'blocked');

  const myClients = currentUserId
    ? clients.filter(
        (c) =>
          c.am_agent_id === currentUserId ||
          c.sales_owner_id === currentUserId
      )
    : [];
  const myOnboardingClients = myClients.filter((c) => c.status === 'onboarding');

  return (
    <div
      className="rounded-[22px] p-6 shadow-2xl relative overflow-hidden border backdrop-blur-md"
      style={{
        background: 'var(--gradient-hero)',
        borderColor: 'var(--border-medium)',
      }}
    >
      {/* Background ambient badge */}
      <div className="absolute top-0 left-0 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl pointer-events-none -translate-x-1/2 -translate-y-1/2" />

      <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="space-y-2 max-w-3xl">
          <h2
            className="text-xl sm:text-2xl font-black tracking-tight"
            style={{ color: 'var(--white)' }}
          >
            {roleInfo.portalTitleEn}
          </h2>
        </div>

        {/* Role Portal Quick Status Strip & Action */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {/* Quick Metrics tailored to role */}
          {['sales'].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl border text-left" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-mid)' }}>Sales Clients</div>
                <div className="text-sm font-bold" style={{ color: 'var(--text-hi)' }}>{myClients.length} Clients</div>
              </div>
            </div>
          )}

          {['am_team_lead', 'am_agent'].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl border text-left" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-mid)' }}>Onboarding Clients</div>
                <div className="text-sm font-bold font-mono" style={{ color: 'var(--accent)' }}>
                  {role === 'am_team_lead'
                    ? clients.filter((c) => c.status === 'onboarding').length
                    : myOnboardingClients.length}{' '}
                  Clients
                </div>
              </div>
              <div className="px-3.5 py-2 rounded-xl border text-left" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-mid)' }}>Total Accounts</div>
                <div className="text-sm font-bold" style={{ color: 'var(--text-hi)' }}>
                  {role === 'am_team_lead' ? clients.length : myClients.length} Clients
                </div>
              </div>
            </div>
          )}

          {['executive', 'head_of_technical'].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl border text-left" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-mid)' }}>Active Clients</div>
                <div className="text-sm font-bold font-mono" style={{ color: 'var(--success)' }}>
                  {clients.filter(isCurrentlyActiveClient).length} Clients
                </div>
              </div>
              <div className="px-3.5 py-2 rounded-xl border text-left" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-mid)' }}>Total Agency Tasks</div>
                <div className="text-sm font-bold font-mono" style={{ color: 'var(--text-hi)' }}>
                  {tasks.length} Tasks
                </div>
              </div>
            </div>
          )}

          {[
            'marketing_manager',
            'media_buying_team_lead',
            'media_buying_agent',
            'seo_team_lead',
            'seo_agent',
            'seo_content_agent',
            'seo_backlink_agent',
            'social_media_team_lead',
            'social_media_agent',
            'graphic_designer',
            'video_editor',
          ].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl border text-left" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-mid)' }}>Active Tasks</div>
                <div className="text-sm font-bold font-mono" style={{ color: 'var(--info)' }}>
                  {myActiveTasks.length} Tasks
                </div>
              </div>
              {myBlockedTasks.length > 0 && (
                <div
                  className="px-3.5 py-2 rounded-xl border text-left"
                  style={{
                    background: 'color-mix(in srgb, var(--roas-bad) 15%, transparent)',
                    borderColor: 'color-mix(in srgb, var(--roas-bad) 40%, transparent)',
                  }}
                >
                  <div className="text-[10px]" style={{ color: 'var(--roas-bad)' }}>Blocked Tasks</div>
                  <div className="text-sm font-bold font-mono" style={{ color: 'var(--roas-bad)' }}>
                    {myBlockedTasks.length} Blocked
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
