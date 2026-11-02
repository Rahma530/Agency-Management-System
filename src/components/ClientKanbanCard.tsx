import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Building2, UserCheck, Eye } from 'lucide-react';
import { ClientRecord, UserRecord } from '../types/database';
import { getClientServices, SERVICE_LABELS, SERVICE_BADGE_COLORS } from '../lib/clientServices';

interface ClientKanbanCardProps {
  client: ClientRecord;
  assignedAgent?: UserRecord;
  canDrag: boolean;
  onOpenDashboard: (clientId: string) => void;
}

// The Client Portfolio Board's draggable card — mirrors KanbanTaskCard.tsx's split between a
// plain content component and a useDraggable-wrapped shell, for the same reason: dropping a
// client onto another card (reorder) or onto a column (status change) is handled entirely by
// AMQueue.tsx's handleBoardDragEnd, this component only renders and reports its own id.
export const ClientKanbanCard: React.FC<ClientKanbanCardProps> = ({
  client,
  assignedAgent,
  canDrag,
  onOpenDashboard,
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: client.id,
    disabled: !canDrag,
  });
  const services = getClientServices(client);

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      {...(canDrag ? { ...attributes, ...listeners } : {})}
      onClick={() => onOpenDashboard(client.id)}
      className={`rounded-xl p-3 space-y-2 border transition-colors cursor-pointer ${
        canDrag ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
      style={{
        ...style,
        background: 'rgba(21, 19, 24, 0.85)',
        borderColor: 'var(--border-soft)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-bold leading-snug" style={{ color: 'var(--ink)' }}>
          {client.name}
        </span>
        <Eye className="w-3 h-3 shrink-0 text-stone-500" />
      </div>
      {client.industry && (
        <div className="flex items-center gap-1 text-[10px] text-stone-400">
          <Building2 className="w-3 h-3" />
          <span>{client.industry}</span>
        </div>
      )}
      {services.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {services.map((s) => (
            <span
              key={s}
              className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider"
              style={{
                background: SERVICE_BADGE_COLORS[s]?.bg ?? 'var(--pink-bg)',
                color: SERVICE_BADGE_COLORS[s]?.text ?? 'var(--pink)',
              }}
            >
              {SERVICE_LABELS[s]}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 text-[10px] text-stone-500">
        <UserCheck className="w-3 h-3" />
        <span>{assignedAgent?.name || 'Unassigned'}</span>
      </div>
    </div>
  );
};
