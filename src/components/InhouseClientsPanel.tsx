import React, { useMemo, useState } from 'react';
import { Building2, Edit2, Users as UsersIcon } from 'lucide-react';
import { AssignmentRecord, ClientRecord, UserRecord } from '../types/database';
import { getClientServices, SERVICE_LABELS } from '../lib/clientServices';
import { getEligibleServiceAssignees, SERVICE_ASSIGNMENT_CONFIG, AssignableServiceType } from '../lib/serviceAssignment';
import { EditClientModal } from './EditClientModal';

// Inhouse module — Client profile + per-service agent assignment (2026-11-04). The Inhouse tab's
// Task Board (CrossTeamTaskBoard, inhouseOnly) already lets the 3 roles create/assign Tasks for
// Kesraa/Fast Growth; this panel is the other half of "treat them as a full Client" — services and
// a standing responsible agent per service (assignments table), the same mechanism every normal
// client already uses (ClientDashboard's own service-assignment cards, ServiceBriefsRoutingView).
//
// Deliberately a small, standalone panel instead of reusing the full ClientDashboard modal: that
// component's Briefs/Reports/Lifecycle tabs are built entirely around a real AM Agent/sales
// relationship (isAMAgentAssigned, hasBriefViewAccess, hasReportsAccess, churn/renewal flows) that
// doesn't apply to an in-house client at all, and widening those role gates just for this screen
// would risk loosening them for normal clients too. Reusing EditClientModal as-is for the services
// editor is safe, though — it's a generic 4-prop component with no role gating of its own.
interface InhouseClientsPanelProps {
  clients: ClientRecord[]; // already filtered to is_inhouse by the caller
  users: UserRecord[];
  assignments: AssignmentRecord[];
  currentUser: UserRecord;
  onAssignServiceAgent: (
    clientId: string,
    serviceType: AssignableServiceType,
    agentId: string,
    reasonNotes?: string
  ) => Promise<void>;
  onUpdateClientDetails: (clientId: string, patch: Record<string, unknown>) => Promise<void>;
}

const ASSIGNABLE_SERVICE_ORDER: AssignableServiceType[] = [
  'seo',
  'media_buying',
  'social_media',
  'interface',
  'graphic_design',
];

export const InhouseClientsPanel: React.FC<InhouseClientsPanelProps> = ({
  clients,
  users,
  assignments,
  currentUser,
  onAssignServiceAgent,
  onUpdateClientDetails,
}) => {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(clients[0]?.id || null);
  const [editingClient, setEditingClient] = useState<ClientRecord | null>(null);
  const [selectedServiceAgentIds, setSelectedServiceAgentIds] = useState<Record<string, string>>({});
  const [assigningServiceType, setAssigningServiceType] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState('');

  const selectedClient = clients.find((c) => c.id === selectedClientId) || clients[0] || null;

  const clientServices = useMemo(
    () => (selectedClient ? getClientServices(selectedClient) : []),
    [selectedClient]
  );

  const assignableServicesForClient = ASSIGNABLE_SERVICE_ORDER.filter((s) => clientServices.includes(s));

  // The 3 roles allowed into the Inhouse module at all (see roles.ts's allowedModules) are exactly
  // who may assign a specialist here too — no separate permission needed, since this whole panel
  // only renders inside the already-gated Inhouse tab.
  const canAssign =
    currentUser.role === 'executive' ||
    currentUser.role === 'head_of_technical' ||
    currentUser.role === 'marketing_manager';

  const handleAssign = async (serviceType: AssignableServiceType) => {
    if (!selectedClient) return;
    const agentId = selectedServiceAgentIds[serviceType];
    if (!agentId) return;

    setAssigningServiceType(serviceType);
    setAssignmentError('');
    try {
      await onAssignServiceAgent(selectedClient.id, serviceType, agentId);
      setSelectedServiceAgentIds((prev) => ({ ...prev, [serviceType]: '' }));
    } catch (err: any) {
      setAssignmentError(err?.message || 'Unable to update this assignment.');
    } finally {
      setAssigningServiceType(null);
    }
  };

  if (clients.length === 0) {
    return (
      <div className="p-8 text-center rounded-xl border border-purple-900/30 bg-[#161224]/60">
        <Building2 className="w-10 h-10 text-purple-400 mx-auto mb-2" />
        <h3 className="text-sm font-bold text-white">No in-house clients yet</h3>
        <p className="text-xs text-stone-400 max-w-md mx-auto mt-1">
          No client is currently flagged as in-house.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Client list */}
      <div className="space-y-2">
        {clients.map((client) => (
          <button
            key={client.id}
            onClick={() => setSelectedClientId(client.id)}
            className={`w-full text-left px-3 py-2.5 rounded-xl text-sm font-bold transition-all border ${
              selectedClient?.id === client.id
                ? 'bg-purple-600 text-white border-purple-500 shadow'
                : 'bg-stone-900/60 text-stone-300 hover:text-white border-stone-800'
            }`}
          >
            {client.name}
          </button>
        ))}
      </div>

      {/* Selected client's services + assignment cards */}
      {selectedClient && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-white">{selectedClient.name}</h3>
              <p className="text-xs text-stone-400">
                {clientServices.length > 0
                  ? clientServices.map((s) => SERVICE_LABELS[s]).join(' · ')
                  : 'No services set yet'}
              </p>
            </div>
            <button
              onClick={() => setEditingClient(selectedClient)}
              className="text-xs px-2.5 py-1.5 rounded-lg text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all inline-flex items-center gap-1.5"
            >
              <Edit2 className="w-3.5 h-3.5" />
              <span>Edit Services</span>
            </button>
          </div>

          {assignmentError && (
            <p className="text-xs text-red-400 px-1">{assignmentError}</p>
          )}

          {assignableServicesForClient.length === 0 ? (
            <div className="p-6 text-center rounded-xl border border-purple-900/30 bg-[#161224]/60">
              <UsersIcon className="w-8 h-8 text-purple-400 mx-auto mb-2" />
              <p className="text-xs text-stone-400">
                Add a service above to assign a responsible agent for it.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {assignableServicesForClient.map((serviceType) => {
                const config = SERVICE_ASSIGNMENT_CONFIG[serviceType];
                const eligibleAssignees = getEligibleServiceAssignees(users, serviceType);
                const currentAssignment = assignments.find(
                  (a) => a.client_id === selectedClient.id && a.service_type === serviceType
                );
                const assignedUser = users.find((u) => u.id === currentAssignment?.agent_id);
                const selectedAgentId = selectedServiceAgentIds[serviceType] || '';
                const isAssigning = assigningServiceType === serviceType;

                return (
                  <div key={serviceType} className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80">
                    <span className="text-xs font-semibold uppercase tracking-wider text-purple-300">
                      {SERVICE_LABELS[serviceType]}
                    </span>
                    <div className="flex items-center gap-3 mt-3">
                      <div className="w-9 h-9 rounded-lg border border-purple-800/50 bg-purple-950/40 flex items-center justify-center font-bold text-sm text-purple-200">
                        {assignedUser?.name?.charAt(0) || '?'}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-white">
                          {assignedUser?.name || 'Unassigned'}
                          {assignedUser?.role === config.teamLeadRole && ' (Team Leader)'}
                        </p>
                        <p className="text-xs text-stone-400">{assignedUser?.email || 'No one assigned yet'}</p>
                      </div>
                    </div>

                    {canAssign && (
                      <div className="mt-3 pt-3 border-t border-stone-800 flex items-center gap-2">
                        <select
                          value={selectedAgentId}
                          onChange={(event) =>
                            setSelectedServiceAgentIds((prev) => ({ ...prev, [serviceType]: event.target.value }))
                          }
                          className="flex-1 min-w-0 px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white focus:outline-none focus:border-purple-400"
                        >
                          <option value="" disabled>Select a specialist...</option>
                          {eligibleAssignees.map((assignee) => (
                            <option key={assignee.id} value={assignee.id}>
                              {assignee.name} ({assignee.email})
                              {assignee.role === config.teamLeadRole ? ' (Team Leader)' : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleAssign(serviceType)}
                          disabled={isAssigning || !selectedAgentId || selectedAgentId === currentAssignment?.agent_id}
                          className="text-xs px-2.5 py-2 rounded bg-purple-600 hover:bg-purple-500 text-white font-bold transition-all disabled:opacity-50"
                        >
                          {isAssigning ? 'Assigning...' : 'Assign'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {editingClient && (
        <EditClientModal
          isOpen
          onClose={() => setEditingClient(null)}
          client={editingClient}
          onSave={async (clientId, patch) => {
            await onUpdateClientDetails(clientId, patch);
            setEditingClient(null);
          }}
        />
      )}
    </div>
  );
};
