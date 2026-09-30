import React, { useState } from 'react';
import { ClipboardList, Globe, Target, Share2, Layout, PenTool, Palette } from 'lucide-react';
import { BriefFieldSchemaRow, ServiceType, UserRecord } from '../types/database';
import { canEditBriefFieldSchema } from '../lib/permissions';
import { BriefFieldSchemaEditor, SERVICE_LABELS } from './BriefFieldSchemaEditor';

const SERVICE_ICONS: Record<ServiceType, React.ReactNode> = {
  seo: <Globe className="w-4 h-4" />,
  media_buying: <Target className="w-4 h-4" />,
  social_media: <Share2 className="w-4 h-4" />,
  interface: <Layout className="w-4 h-4" />,
  creation: <PenTool className="w-4 h-4" />,
  branding: <Palette className="w-4 h-4" />,
};

const SERVICE_ORDER: ServiceType[] = ['seo', 'media_buying', 'social_media', 'interface', 'creation', 'branding'];

interface BriefTemplatesModuleProps {
  currentUser: UserRecord;
  briefFieldSchemaRows: BriefFieldSchemaRow[];
  onCreateBriefFieldSchema?: (row: Omit<BriefFieldSchemaRow, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdateBriefFieldSchema?: (id: string, updates: Partial<BriefFieldSchemaRow>) => Promise<void>;
  onDeleteBriefFieldSchema?: (id: string) => Promise<void>;
}

// Standalone, client-independent entry point for managing brief_field_schemas — the questions
// asked on a service's brief form. Previously BriefFieldSchemaEditor was only reachable by first
// opening a specific client's Service Briefs tab (ClientDashboard.tsx / ServiceBriefsRoutingView.tsx),
// purely to obtain a ServiceType value the editor itself never actually depends on (its own props
// are serviceType + rows + CRUD callbacks — no client_id anywhere). With no client data currently
// in the system, that path was unreachable entirely. This module reproduces the same ServiceType
// selection with a plain picker instead of a client.
export const BriefTemplatesModule: React.FC<BriefTemplatesModuleProps> = ({
  currentUser,
  briefFieldSchemaRows,
  onCreateBriefFieldSchema,
  onUpdateBriefFieldSchema,
  onDeleteBriefFieldSchema,
}) => {
  const [selectedService, setSelectedService] = useState<ServiceType>('seo');
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  const canEdit = canEditBriefFieldSchema(currentUser.role, selectedService);

  return (
    <div className="brief-templates-module space-y-6">
      <div className="p-4 rounded-2xl border border-purple-900/30 bg-[#161224]/80">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
          >
            <ClipboardList className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Brief Templates</h2>
            <p className="text-[11px] text-stone-400">
              Manage the questions each service's brief form asks — shared across every client subscribed to that
              service.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {SERVICE_ORDER.map((service) => {
          const count = briefFieldSchemaRows.filter((r) => r.service_type === service).length;
          const isSelected = selectedService === service;
          return (
            <button
              key={service}
              onClick={() => setSelectedService(service)}
              className={`flex items-center gap-2 p-3 rounded-xl border text-left transition-all ${
                isSelected
                  ? 'border-purple-500/60 bg-purple-900/30 text-white'
                  : 'border-purple-900/20 bg-[#161224]/80 text-stone-300 hover:border-purple-700/40 hover:text-white'
              }`}
            >
              <span className={isSelected ? 'text-purple-300' : 'text-stone-500'}>{SERVICE_ICONS[service]}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-bold truncate">{SERVICE_LABELS[service]}</span>
                <span className="block text-[10px] text-stone-500">{count} question{count === 1 ? '' : 's'}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-white">{SERVICE_LABELS[selectedService]}</p>
          <p className="text-[11px] text-stone-400 mt-0.5">
            {canEdit
              ? 'You can add, edit, and remove questions for this service.'
              : 'Your role can view but not edit this service’s questions.'}
          </p>
        </div>
        <button
          onClick={() => setIsEditorOpen(true)}
          className="px-3 py-1.5 rounded-lg text-xs font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all shrink-0"
        >
          {canEdit ? 'Manage Questions' : 'View Questions'}
        </button>
      </div>

      {isEditorOpen && (
        <BriefFieldSchemaEditor
          serviceType={selectedService}
          rows={briefFieldSchemaRows.filter((r) => r.service_type === selectedService)}
          onCreate={canEdit ? onCreateBriefFieldSchema : undefined}
          onUpdate={canEdit ? onUpdateBriefFieldSchema : undefined}
          onDelete={canEdit ? onDeleteBriefFieldSchema : undefined}
          onClose={() => setIsEditorOpen(false)}
        />
      )}
    </div>
  );
};
