import React from 'react';
import {
  Shield,
  Briefcase,
  Layers,
  Sparkles,
  Users,
  CheckCircle2,
  Clock,
  PlusCircle,
} from 'lucide-react';
import { UserRecord, TaskRecord, ClientRecord } from '../types/database';
import { getRoleInfo } from '../data/roles';

interface RolePortalHeaderProps {
  currentUser: UserRecord;
  tasks: TaskRecord[];
  clients: ClientRecord[];
  onOpenRegisterModal?: () => void;
}

export const RolePortalHeader: React.FC<RolePortalHeaderProps> = ({
  currentUser,
  tasks,
  clients,
  onOpenRegisterModal,
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
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className="text-[11px] px-3 py-1 font-bold rounded-full border shadow-sm flex items-center gap-1.5"
              style={{
                background: roleInfo.badgeBg,
                color: roleInfo.badgeText,
                borderColor: 'var(--border-soft)',
              }}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>{roleInfo.portalTitleEn}</span>
            </span>

            <span className="text-xs text-stone-400">
              • {roleInfo.department} ({currentUser?.team || 'Operations'})
            </span>
          </div>

          <h2
            className="text-xl sm:text-2xl font-black tracking-tight"
            style={{ color: 'var(--white)' }}
          >
            {roleInfo.portalTitleEn}
          </h2>

          <p className="text-xs leading-relaxed text-[#c7b8db]">
            {roleInfo.description}
          </p>
        </div>

        {/* Role Portal Quick Status Strip & Action */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {/* Quick Metrics tailored to role */}
          {['sales'].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-800/40 text-left">
                <div className="text-[10px] text-stone-400">Sales Clients</div>
                <div className="text-sm font-bold text-white">{myClients.length} Clients</div>
              </div>
              {onOpenRegisterModal && (
                <button
                  onClick={onOpenRegisterModal}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold text-white shadow-lg transition-all hover:opacity-90 active:scale-98"
                  style={{
                    background: 'var(--gradient-badge)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>Register Client</span>
                </button>
              )}
            </div>
          )}

          {['am_team_lead', 'am_agent'].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-800/40 text-left">
                <div className="text-[10px] text-stone-400">Onboarding Clients</div>
                <div className="text-sm font-bold text-purple-300 font-mono">
                  {role === 'am_team_lead'
                    ? clients.filter((c) => c.status === 'onboarding').length
                    : myOnboardingClients.length}{' '}
                  Clients
                </div>
              </div>
              <div className="px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-800/40 text-left">
                <div className="text-[10px] text-stone-400">Total Accounts</div>
                <div className="text-sm font-bold text-white">
                  {role === 'am_team_lead' ? clients.length : myClients.length} Clients
                </div>
              </div>
            </div>
          )}

          {['executive', 'head_of_technical'].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-800/40 text-left">
                <div className="text-[10px] text-stone-400">Active Clients</div>
                <div className="text-sm font-bold text-emerald-400 font-mono">
                  {clients.filter((c) => c.status === 'active').length} Clients
                </div>
              </div>
              <div className="px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-800/40 text-left">
                <div className="text-[10px] text-stone-400">Total Agency Tasks</div>
                <div className="text-sm font-bold text-white font-mono">
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
            'social_media_team_lead',
            'social_media_agent',
            'graphic_designer',
            'video_editor',
          ].includes(role) && (
            <div className="flex items-center gap-2">
              <div className="px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-800/40 text-left">
                <div className="text-[10px] text-stone-400">Active Tasks</div>
                <div className="text-sm font-bold text-sky-300 font-mono">
                  {myActiveTasks.length} Tasks
                </div>
              </div>
              {myBlockedTasks.length > 0 && (
                <div className="px-3.5 py-2 rounded-xl bg-red-950/50 border border-red-800/50 text-left">
                  <div className="text-[10px] text-red-300">Blocked Tasks</div>
                  <div className="text-sm font-bold text-red-400 font-mono">
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
