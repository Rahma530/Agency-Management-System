import React, { useState } from 'react';
import { Plug, Info, Save, Lock } from 'lucide-react';
import { ClientRecord, PlatformConnectionRecord, PlatformConnectionStatus, PlatformCategory, UserRecord } from '../types/database';
import { INTEGRATION_PLATFORMS, INTEGRATION_CATEGORY_LABELS } from '../data/integrationPlatforms';

const STATUS_STYLES: Record<PlatformConnectionStatus, { bg: string; text: string; label: string }> = {
  not_connected: { bg: 'rgba(120, 113, 108, 0.15)', text: '#a8a29e', label: 'Not Connected' },
  pending: { bg: 'rgba(245, 226, 154, 0.15)', text: 'var(--roas-mid)', label: 'Pending' },
  connected: { bg: 'rgba(16, 185, 129, 0.15)', text: '#34d399', label: 'Connected' },
};

const STATUS_OPTIONS: PlatformConnectionStatus[] = ['not_connected', 'pending', 'connected'];

interface ClientIntegrationsPanelProps {
  client: ClientRecord;
  connections: PlatformConnectionRecord[];
  users: UserRecord[];
  canManage: boolean;
  onSetStatus: (
    clientId: string,
    platformName: string,
    platformCategory: PlatformCategory,
    status: PlatformConnectionStatus,
    notes: string
  ) => Promise<void>;
}

// Module 6 (External Integrations Hub) scaffolding — see
// supabase/migrations/20260915100000_platform_connections.sql. There is no
// real OAuth flow anywhere in this component: "Connect" always stays
// disabled and labeled "Coming soon". The status control below tracks the
// real human process of chasing client API access, nothing more — it never
// implies a live data connection or pull exists.
export const ClientIntegrationsPanel: React.FC<ClientIntegrationsPanelProps> = ({
  client,
  connections,
  users,
  canManage,
  onSetStatus,
}) => {
  const [drafts, setDrafts] = useState<Record<string, { status: PlatformConnectionStatus; notes: string }>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const clientConnections = connections.filter((c) => c.client_id === client.id);
  const connectionFor = (platformKey: string) => clientConnections.find((c) => c.platform_name === platformKey);

  const getDraft = (platformKey: string) => {
    const existing = connectionFor(platformKey);
    return drafts[platformKey] ?? { status: existing?.status || 'not_connected', notes: existing?.notes || '' };
  };

  const handleSave = async (platformKey: string, category: PlatformCategory) => {
    const draft = getDraft(platformKey);
    setSavingKey(platformKey);
    try {
      await onSetStatus(client.id, platformKey, category, draft.status, draft.notes);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[platformKey];
        return next;
      });
    } finally {
      setSavingKey(null);
    }
  };

  const categories: PlatformCategory[] = ['media_buying', 'analytics', 'social_media'];

  return (
    <div className="space-y-4">
      <div
        className="p-3 rounded-xl text-[11px] flex items-start gap-2"
        style={{ background: 'rgba(123, 47, 247, 0.08)', border: '1px solid var(--border-soft)', color: 'var(--lilac)' }}
      >
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          Scaffolding only — this tracks the real-world status of getting API access from the client. It does not connect to
          any platform, pull any data, or run on any schedule. "Connect" stays disabled until a real integration with actual
          API credentials is built.
        </span>
      </div>

      {categories.map((category) => (
        <div key={category} className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
          <h3 className="text-xs font-bold text-white flex items-center gap-2">
            <Plug className="w-4 h-4 text-purple-400" />
            <span>{INTEGRATION_CATEGORY_LABELS[category]}</span>
          </h3>

          <div className="space-y-2">
            {INTEGRATION_PLATFORMS.filter((p) => p.category === category).map((platform) => {
              const existing = connectionFor(platform.key);
              const draft = getDraft(platform.key);
              const isDirty = draft.status !== (existing?.status || 'not_connected') || draft.notes !== (existing?.notes || '');
              const connectedByUser = existing?.connected_by ? users.find((u) => u.id === existing.connected_by) : undefined;
              const style = STATUS_STYLES[draft.status];

              return (
                <div key={platform.key} className="p-3 rounded-lg border border-purple-900/20 bg-black/20 space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-xs font-semibold text-white">{platform.label}</span>
                    <div className="flex items-center gap-2">
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: style.bg, color: style.text }}
                      >
                        {style.label}
                      </span>
                      <button
                        disabled
                        title="Coming soon — requires API credentials"
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-stone-500 bg-stone-800/40 border border-stone-700/40 cursor-not-allowed"
                      >
                        <Lock className="w-3 h-3" />
                        <span>Connect (Coming soon)</span>
                      </button>
                    </div>
                  </div>

                  {existing?.connected_at && (
                    <p className="text-[10px] text-stone-500">
                      Last updated by {connectedByUser?.name || 'Unknown'} on {existing.connected_at.split('T')[0]}
                    </p>
                  )}

                  {canManage && (
                    <div className="flex items-start gap-2 flex-wrap">
                      <div className="flex gap-1">
                        {STATUS_OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            onClick={() => setDrafts((prev) => ({ ...prev, [platform.key]: { ...draft, status: opt } }))}
                            className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${
                              draft.status === opt
                                ? 'bg-purple-600 text-white'
                                : 'bg-stone-900/60 text-stone-400 hover:text-stone-200'
                            }`}
                          >
                            {STATUS_STYLES[opt].label}
                          </button>
                        ))}
                      </div>
                      <input
                        value={draft.notes}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [platform.key]: { ...draft, notes: e.target.value } }))}
                        placeholder="Note (e.g. waiting on client's IT team)..."
                        className="flex-1 min-w-[180px] px-2.5 py-1 rounded-md text-[11px] bg-black/30 border border-stone-800 text-white outline-none focus:border-purple-400"
                      />
                      <button
                        onClick={() => handleSave(platform.key, category)}
                        disabled={!isDirty || savingKey === platform.key}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all disabled:opacity-40"
                      >
                        <Save className="w-3 h-3" />
                        <span>{savingKey === platform.key ? 'Saving...' : 'Save'}</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
