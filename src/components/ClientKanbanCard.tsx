import React from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
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
//
// Bugfix (2026-11-02, caught right after PR #268 shipped): this card was useDraggable-only, with
// no useDroppable — so dropping one card onto another could never be detected as "over" that
// specific card (dnd-kit only reports a drop as "over" a registered DROPPABLE; the nearest
// droppable ancestor was always just the column itself). Net effect: AMQueue.tsx's
// handleBoardDragEnd's within-column reorder branch was silently dead code — dragging a card
// onto a sibling in the same column did nothing. Fixed the same way KanbanTaskCard.tsx's
// equivalent bug never shipped in the first place: useDroppable on this same node, gated by
// canDrag exactly like the draggable half.
export const ClientKanbanCard: React.FC<ClientKanbanCardProps> = ({
  client,
  assignedAgent,
  canDrag,
  onOpenDashboard,
}) => {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: client.id,
    disabled: !canDrag,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: client.id, disabled: !canDrag });
  const services = getClientServices(client);

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      {...(canDrag ? { ...attributes, ...listeners } : {})}
      onClick={() => onOpenDashboard(client.id)}
      className={`rounded-xl p-3 space-y-2 border transition-colors cursor-pointer ${
        canDrag ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
      style={{
        ...style,
        background: 'rgba(21, 19, 24, 0.85)',
        borderColor: 'var(--border-soft)',
        outline: isOver ? '2px solid var(--purple-light)' : undefined,
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
