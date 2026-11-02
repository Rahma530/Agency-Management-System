import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { ClientRecord, ClientStatus, UserRecord } from '../types/database';
import { CLIENT_STATUS_META } from '../lib/clientStatus';
import { ClientKanbanCard } from './ClientKanbanCard';

interface ClientKanbanColumnProps {
  status: ClientStatus;
  clients: ClientRecord[]; // already filtered to this column's status, already ordered
  amAgents: UserRecord[];
  amTeamLeaders: UserRecord[];
  canDrag: boolean;
  onOpenDashboard: (clientId: string) => void;
}

// A useDroppable-backed status column for the Client Portfolio Board — same reasoning as
// KanbanColumn.tsx (the task board's equivalent): useDroppable can't be called a variable
// number of times inside a .map() loop in the parent, so each column needs its own component
// instance. Unlike KanbanColumn, this one is a fixed width (no resize handle) — five columns is
// a simpler, smaller layout than the task board's, and not worth the extra complexity yet.
export const ClientKanbanColumn: React.FC<ClientKanbanColumnProps> = ({
  status,
  clients,
  amAgents,
  amTeamLeaders,
  canDrag,
  onOpenDashboard,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !canDrag });
  const meta = CLIENT_STATUS_META[status];

  return (
    <div
      ref={setNodeRef}
      className="shrink-0 w-64 rounded-[18px] p-3 flex flex-col gap-2 min-h-[420px] transition-colors"
      style={{
        background: isOver ? 'rgba(123, 47, 247, 0.08)' : 'rgba(21, 19, 24, 0.65)',
        border: isOver ? '1px solid var(--purple-light)' : '1px solid var(--border-soft)',
      }}
    >
      <div className="flex items-center justify-between pb-2 border-b border-stone-800">
        <span
          className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
          style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}
        >
          {meta.label}
        </span>
        <span className="text-[11px] font-bold text-stone-500">{clients.length}</span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {clients.map((client) => {
          const assignedAgent =
            amAgents.find((u) => u.id === client.am_agent_id) ||
            amTeamLeaders.find((u) => u.id === client.am_agent_id);
          return (
            <ClientKanbanCard
              key={client.id}
              client={client}
              assignedAgent={assignedAgent}
              canDrag={canDrag}
              onOpenDashboard={onOpenDashboard}
            />
          );
        })}
        {clients.length === 0 && (
          <p className="text-[11px] text-stone-500 text-center py-6">No clients</p>
        )}
      </div>
    </div>
  );
};
