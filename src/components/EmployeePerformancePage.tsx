import React, { useMemo, useState } from 'react';
import { X, Gauge, TrendingUp, Building2, CheckSquare, Sparkles, Calendar } from 'lucide-react';
import { UserRecord, ClientRecord, TaskRecord, CapacityLogRecord } from '../types/database';
import { getRoleInfo } from '../data/roles';
import { getUserCapacityData } from '../lib/capacity';

interface EmployeePerformancePageProps {
  employee: UserRecord;
  clients: ClientRecord[];
  tasks: TaskRecord[];
  capacityLogs: CapacityLogRecord[];
  onClose: () => void;
}

// ----------------------------------------------------------------------------
// Small inline-SVG line chart. Single series (this page never needs more than
// one line per chart), so no legend — the section title names it. 2px line,
// rounded caps, muted gridlines, a hover crosshair + tooltip via pointer
// tracking. Kept local to this file since nothing else uses it yet.
// ----------------------------------------------------------------------------
interface LineChartPoint {
  dateLabel: string;
  value: number;
}

const TrendLineChart: React.FC<{ points: LineChartPoint[]; color: string; emptyLabel: string; valueSuffix?: string }> = ({
  points,
  color,
  emptyLabel,
  valueSuffix = '',
}) => {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 560;
  const height = 160;
  const padding = { top: 12, right: 16, bottom: 24, left: 32 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (points.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-xs text-stone-500 italic border border-dashed border-stone-800 rounded-xl">
        {emptyLabel}
      </div>
    );
  }

  const maxValue = Math.max(...points.map((p) => p.value), 1);
  const minValue = 0;
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0;

  const toX = (i: number) => padding.left + i * xStep;
  const toY = (v: number) =>
    padding.top + plotHeight - ((v - minValue) / (maxValue - minValue || 1)) * plotHeight;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i)} ${toY(p.value)}`).join(' ');
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const idx = points.length > 1 ? Math.round((relX - padding.left) / xStep) : 0;
    setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-40"
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      {/* Recessive gridlines */}
      {[0, 0.5, 1].map((t) => (
        <line
          key={t}
          x1={padding.left}
          x2={width - padding.right}
          y1={padding.top + plotHeight * t}
          y2={padding.top + plotHeight * t}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={1}
        />
      ))}

      <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {points.map((p, i) => (
        <circle
          key={i}
          cx={toX(i)}
          cy={toY(p.value)}
          r={hoverIndex === i ? 4 : 2.5}
          fill={color}
          stroke="var(--surface-dark, #15131a)"
          strokeWidth={1.5}
        />
      ))}

      {hoverIndex !== null && (
        <line
          x1={toX(hoverIndex)}
          x2={toX(hoverIndex)}
          y1={padding.top}
          y2={padding.top + plotHeight}
          stroke="rgba(255,255,255,0.2)"
          strokeWidth={1}
        />
      )}

      {/* First/last x labels only — selective labeling, not one per point */}
      <text x={padding.left} y={height - 6} fontSize={9} fill="var(--grey, #a89bb8)">
        {points[0].dateLabel}
      </text>
      <text x={width - padding.right} y={height - 6} fontSize={9} fill="var(--grey, #a89bb8)" textAnchor="end">
        {points[points.length - 1].dateLabel}
      </text>

      {hovered && (
        <g transform={`translate(${Math.min(toX(hoverIndex!), width - 90)}, ${Math.max(toY(hovered.value) - 34, padding.top)})`}>
          <rect x={0} y={0} width={80} height={28} rx={6} fill="#0d0b12" stroke="rgba(255,255,255,0.15)" />
          <text x={6} y={12} fontSize={9} fill="var(--grey, #a89bb8)">
            {hovered.dateLabel}
          </text>
          <text x={6} y={23} fontSize={10} fontWeight="bold" fill="white">
            {hovered.value}
            {valueSuffix}
          </text>
        </g>
      )}
    </svg>
  );
};

export const EmployeePerformancePage: React.FC<EmployeePerformancePageProps> = ({
  employee,
  clients,
  tasks,
  capacityLogs,
  onClose,
}) => {
  const roleInfo = getRoleInfo(employee.role);
  const isAm = employee.role === 'am_agent' || employee.role === 'am_team_lead';

  const capacityData = useMemo(() => getUserCapacityData(employee, clients, tasks), [employee, clients, tasks]);

  const employeeTasks = useMemo(() => tasks.filter((t) => t.assigned_to === employee.id), [tasks, employee.id]);
  const tasksByStatus = useMemo(() => {
    const counts: Record<string, number> = { todo: 0, in_progress: 0, in_review: 0, completed: 0, blocked: 0 };
    employeeTasks.forEach((t) => {
      counts[t.status] = (counts[t.status] || 0) + 1;
    });
    return counts;
  }, [employeeTasks]);

  const capacityHistory = useMemo(
    () =>
      capacityLogs
        .filter((l) => l.agent_id === employee.id)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((l) => ({ dateLabel: l.date.slice(5), value: l.active_clients_count })),
    [capacityLogs, employee.id]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-[24px] p-6 space-y-6 shadow-2xl relative"
        style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-stone-800 pb-4">
          <div className="flex items-center gap-3.5">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 font-bold text-lg"
              style={{ background: 'var(--gradient-badge)', color: 'white' }}
            >
              {employee.name.charAt(0)}
            </div>
            <div>
              <h2 className="text-base font-bold text-white">{employee.name}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold border"
                  style={{ background: roleInfo.badgeBg, color: roleInfo.badgeText, borderColor: 'var(--border-soft)' }}
                >
                  {roleInfo.englishTitle}
                </span>
                <span className="text-[11px] text-stone-400">{employee.team}</span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-stone-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* CURRENT SNAPSHOT */}
        <div className="p-4 rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white">Current Snapshot</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <StatTile
              label={isAm ? 'Assigned Clients' : 'Active Tasks'}
              value={capacityData.usedCapacity}
              icon={isAm ? Building2 : CheckSquare}
            />
            <StatTile
              label="Capacity"
              value={capacityData.isUntracked ? 'N/A' : `${capacityData.utilizationRate}%`}
              icon={Gauge}
            />
            <StatTile label="Completed Tasks" value={tasksByStatus.completed} icon={CheckSquare} />
          </div>

          {isAm ? (
            <div>
              <label className="text-[10px] font-semibold text-stone-400 block mb-1.5">Current Clients</label>
              {capacityData.assignedClients.length === 0 ? (
                <p className="text-xs text-stone-500 italic">No clients currently assigned.</p>
              ) : (
                <div className="space-y-1">
                  {capacityData.assignedClients.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between p-2 rounded-lg bg-stone-900/60 border border-stone-800 text-xs"
                    >
                      <span className="font-semibold text-white">{c.name}</span>
                      <span className="text-[10px] text-stone-400 capitalize">{c.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="text-[10px] font-semibold text-stone-400 block mb-1.5">Task Status Breakdown</label>
              <div className="grid grid-cols-5 gap-1.5 text-center">
                {Object.entries(tasksByStatus).map(([status, count]) => (
                  <div key={status} className="p-2 rounded-lg bg-stone-900/60 border border-stone-800">
                    <p className="text-sm font-bold text-white">{count}</p>
                    <p className="text-[9px] text-stone-400 capitalize">{status.replace('_', ' ')}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* CAPACITY TREND */}
        <div className="p-4 rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2 mb-1">
            <Calendar className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white">Capacity Trend</h3>
          </div>
          <TrendLineChart points={capacityHistory} color="var(--purple-light)" emptyLabel="No capacity history logged yet." />
        </div>
      </div>
    </div>
  );
};

const StatTile: React.FC<{ label: string; value: string | number; icon: React.ComponentType<{ className?: string }> }> = ({
  label,
  value,
  icon: Icon,
}) => (
  <div className="p-3 rounded-xl bg-stone-900/60 border border-stone-800">
    <div className="flex items-center justify-between text-stone-400 mb-1">
      <span className="text-[10px] font-semibold">{label}</span>
      <Icon className="w-3 h-3" />
    </div>
    <p className="text-base font-bold text-white">{value}</p>
  </div>
);
