import React, { useMemo, useState } from 'react';
import {
  X,
  Gauge,
  TrendingUp,
  Building2,
  CheckSquare,
  Star,
  Sparkles,
  Calendar,
  RefreshCw,
  Info,
  ShieldAlert,
  Award,
  TrendingDown,
  Minus,
} from 'lucide-react';
import {
  UserRecord,
  ClientRecord,
  TaskRecord,
  CapacityLogRecord,
  KpiScoreRecord,
  ExtraNoteRecord,
  PerformancePeriodType,
} from '../types/database';
import { getRoleInfo } from '../data/roles';
import { getUserCapacityData } from '../lib/capacity';
import {
  computeOnTimeCompletionRate,
  resolvePeriodRange,
  PeriodRange,
  suggestClassification,
  ClassificationSuggestion,
  STATUS_META,
} from '../lib/performanceScore';

interface EmployeePerformancePageProps {
  employee: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  tasks: TaskRecord[];
  capacityLogs: CapacityLogRecord[];
  kpiScores: KpiScoreRecord[];
  extraNotes?: ExtraNoteRecord[];
  onGenerateKpiScore: (userId: string, periodType: PerformancePeriodType, referenceDate: Date) => Promise<void>;
  onClose: () => void;
  // False for a self-view: kpi_scores_insert_rls only permits the employee's
  // direct lead/HoT/Executive to write a score, never the employee themselves
  // — so MyWorkHub's "My Performance" self-service modal hides the generation
  // controls entirely rather than showing a button that would fail RLS.
  canGenerate?: boolean;
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

const scoreColor = (score: number) => {
  if (score >= 80) return 'var(--roas-good)';
  if (score >= 60) return 'var(--roas-mid)';
  return 'var(--roas-bad)';
};

const TREND_META: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  improving_streak: { label: 'Improving across the last 3 periods', Icon: TrendingUp },
  declining_streak: { label: 'Declining across the last 3 periods', Icon: TrendingDown },
  improving: { label: 'Improved from the previous period', Icon: TrendingUp },
  declining: { label: 'Declined from the previous period', Icon: TrendingDown },
  stable: { label: 'Holding steady', Icon: Minus },
  insufficient_data: { label: 'Not enough history yet for a trend', Icon: Minus },
};

export const EmployeePerformancePage: React.FC<EmployeePerformancePageProps> = ({
  employee,
  users,
  clients,
  tasks,
  capacityLogs,
  kpiScores,
  extraNotes = [],
  onGenerateKpiScore,
  onClose,
  canGenerate = true,
}) => {
  const roleInfo = getRoleInfo(employee.role);
  const isAm = employee.role === 'am_agent' || employee.role === 'am_team_lead';

  const [periodType, setPeriodType] = useState<PerformancePeriodType>('monthly');
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1); // 1-12
  const [selectedQuarter, setSelectedQuarter] = useState(Math.floor(now.getMonth() / 3) + 1); // 1-4
  const [isGenerating, setIsGenerating] = useState(false);

  const capacityData = useMemo(() => getUserCapacityData(employee, clients, tasks), [employee, clients, tasks]);

  // "Current snapshot" completion rate — all-time, not tied to a generated
  // period, so it stays live and useful even before anyone generates a
  // formal score.
  const allTimeRange: PeriodRange = useMemo(
    () => ({ period: 'all-time', periodType: 'monthly', start: '1970-01-01', end: '9999-12-31' }),
    []
  );
  const allTimeCompletionRate = computeOnTimeCompletionRate(tasks, employee.id, allTimeRange);

  const employeeTasks = useMemo(() => tasks.filter((t) => t.assigned_to === employee.id), [tasks, employee.id]);
  const tasksByStatus = useMemo(() => {
    const counts: Record<string, number> = { todo: 0, in_progress: 0, in_review: 0, completed: 0, blocked: 0 };
    employeeTasks.forEach((t) => {
      counts[t.status] = (counts[t.status] || 0) + 1;
    });
    return counts;
  }, [employeeTasks]);

  const employeeKpiScores = useMemo(
    () =>
      kpiScores
        .filter((k) => k.user_id === employee.id)
        .sort((a, b) => (a.metrics?.period_start || '').localeCompare(b.metrics?.period_start || '')),
    [kpiScores, employee.id]
  );
  const latestScore = employeeKpiScores[employeeKpiScores.length - 1] || null;

  // Advisory classification suggestion — recomputed live from the same history shown above,
  // never persisted separately (the stored suggested_status on `latestScore` was set from this
  // exact function at generation time; recomputing here just keeps the displayed rationale/
  // diagnostics in sync with whatever's actually in view, with zero risk of drifting from it).
  const classification: ClassificationSuggestion | null = useMemo(
    () => (employeeKpiScores.length > 0 ? suggestClassification(employeeKpiScores) : null),
    [employeeKpiScores]
  );

  // Raw count (not the derived 0-100 initiative_score) of documented extra-effort notes within
  // the latest score's period — same category exclusion as computeInitiativeScore, so this
  // number is the literal thing behind that indicator, not a separate reading of it.
  const extraNotesInPeriod = useMemo(() => {
    if (!latestScore?.metrics?.period_start || !latestScore?.metrics?.period_end) return null;
    const { period_start, period_end } = latestScore.metrics;
    return extraNotes.filter(
      (n) => n.user_id === employee.id && n.category !== 'blocker' && n.date >= period_start && n.date <= period_end
    ).length;
  }, [extraNotes, employee.id, latestScore]);

  const capacityHistory = useMemo(
    () =>
      capacityLogs
        .filter((l) => l.agent_id === employee.id)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((l) => ({ dateLabel: l.date.slice(5), value: l.active_clients_count })),
    [capacityLogs, employee.id]
  );

  const scoreHistory = useMemo(
    () =>
      employeeKpiScores.map((k) => ({
        dateLabel: k.metrics?.period_start ? k.metrics.period_start.slice(0, 7) : k.period,
        value: k.overall_score,
      })),
    [employeeKpiScores]
  );

  const referenceDate = useMemo(() => {
    if (periodType === 'monthly') return new Date(selectedYear, selectedMonth - 1, 1);
    return new Date(selectedYear, (selectedQuarter - 1) * 3, 1);
  }, [periodType, selectedYear, selectedMonth, selectedQuarter]);

  const previewRange = useMemo(() => resolvePeriodRange(periodType, referenceDate), [periodType, referenceDate]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      await onGenerateKpiScore(employee.id, periodType, referenceDate);
    } finally {
      setIsGenerating(false);
    }
  };

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

        {/* KPI SCORE PANEL */}
        <div className="p-4 rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Gauge className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white">Performance Score</h3>
          </div>

          {/* Generation controls — self-view can't write kpi_scores (see canGenerate above) */}
          {canGenerate && (
          <div className="flex flex-wrap items-end gap-2.5 p-3 rounded-xl bg-stone-900/60 border border-stone-800 mb-4">
            <div>
              <label className="text-[10px] font-semibold text-stone-400 block mb-1">Period Type</label>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-stone-900 border border-stone-800">
                {(['monthly', 'quarterly'] as PerformancePeriodType[]).map((pt) => (
                  <button
                    key={pt}
                    onClick={() => setPeriodType(pt)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-bold capitalize transition-all ${
                      periodType === pt ? 'bg-purple-600/40 text-white' : 'text-stone-400 hover:text-white'
                    }`}
                  >
                    {pt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-semibold text-stone-400 block mb-1">Year</label>
              <input
                type="number"
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value, 10) || now.getFullYear())}
                className="w-20 px-2 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
              />
            </div>

            {periodType === 'monthly' ? (
              <div>
                <label className="text-[10px] font-semibold text-stone-400 block mb-1">Month</label>
                <select
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(parseInt(e.target.value, 10))}
                  className="px-2 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'long' })}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className="text-[10px] font-semibold text-stone-400 block mb-1">Quarter</label>
                <select
                  value={selectedQuarter}
                  onChange={(e) => setSelectedQuarter(parseInt(e.target.value, 10))}
                  className="px-2 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                >
                  {[1, 2, 3, 4].map((q) => (
                    <option key={q} value={q}>
                      Q{q}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <span className="text-[11px] text-stone-500 pb-1.5">
              {previewRange.start} → {previewRange.end}
            </span>

            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="ml-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-white shadow-md hover:opacity-90 disabled:opacity-50 transition-all"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>{isGenerating ? 'Generating...' : 'Generate Score'}</span>
            </button>
          </div>
          )}

          {latestScore ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-stone-400">
                  Latest: <strong className="text-white">{latestScore.period}</strong>
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold" style={{ color: scoreColor(latestScore.overall_score) }}>
                    {latestScore.overall_score}
                  </span>
                  <span className="text-xs text-stone-400">/ 100</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                <IndicatorTile
                  label="On-Time Completion"
                  value={latestScore.metrics?.on_time_completion_rate}
                  suffix="%"
                />
                <IndicatorTile
                  label="Capacity Utilization"
                  value={latestScore.metrics?.capacity_utilization_score}
                  suffix="%"
                />
                <IndicatorTile label="Initiative" value={latestScore.metrics?.initiative_score} suffix="%" />
                <IndicatorTile label="Client Satisfaction" value={null} placeholder />
                <IndicatorTile label="Execution Quality" value={null} placeholder />
              </div>
            </div>
          ) : (
            <div className="p-4 text-center rounded-xl bg-stone-900/40 border border-dashed border-stone-800">
              <p className="text-xs text-stone-400">
                No score generated yet for this employee. Pick a period above and generate one.
              </p>
            </div>
          )}

          {employeeKpiScores.length > 0 && (
            <div className="mt-4">
              <label className="text-[10px] font-semibold text-stone-400 block mb-1.5">Score history</label>
              <div className="flex flex-wrap gap-1.5">
                {employeeKpiScores.map((k) => (
                  <span
                    key={k.id}
                    className="text-[10px] px-2 py-1 rounded-lg bg-stone-900/80 border border-stone-800 text-stone-300"
                  >
                    {k.period}: <strong style={{ color: scoreColor(k.overall_score) }}>{k.overall_score}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* CURRENT SNAPSHOT */}
        <div className="p-4 rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white">Current Snapshot</h3>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
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
            <StatTile
              label="All-Time On-Time Rate"
              value={allTimeCompletionRate === null ? 'N/A' : `${allTimeCompletionRate}%`}
              icon={TrendingUp}
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

        {/* TREND OVER TIME */}
        <div className="p-4 rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2 mb-1">
            <Calendar className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white">Capacity Trend</h3>
          </div>
          <p className="text-[10px] text-stone-500 mb-2">Logged active client/task count over time</p>
          <TrendLineChart points={capacityHistory} color="var(--purple-light)" emptyLabel="No capacity history logged yet." />

          {scoreHistory.length > 1 && (
            <div className="mt-5">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">Overall Score Trend</h3>
              </div>
              <TrendLineChart
                points={scoreHistory}
                color="var(--roas-good)"
                emptyLabel="Generate scores for more than one period to see a trend."
              />
            </div>
          )}
        </div>

        {/* GROWTH & CLASSIFICATION — advisory suggestion, never a verdict */}
        {classification && latestScore && (
          <div
            className="p-4 rounded-2xl border-2 space-y-4"
            style={{ background: 'var(--gradient-card)', borderColor: 'rgba(245, 226, 154, 0.35)' }}
          >
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4" style={{ color: 'var(--roas-mid)' }} />
                <h3 className="text-sm font-bold text-white">Growth & Classification Summary</h3>
              </div>
              <span
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border"
                style={{ background: 'rgba(245, 226, 154, 0.15)', color: 'var(--roas-mid)', borderColor: 'rgba(245, 226, 154, 0.4)' }}
              >
                <ShieldAlert className="w-3 h-3" />
                Suggested — Requires Review
              </span>
            </div>

            <p className="text-[10px] text-stone-400 -mt-2">
              A guided suggestion for the Team Lead or Head of Technical reviewing this profile to weigh — not an
              automatic decision. Any promotion, raise, or development plan still requires human review and
              sign-off.
            </p>

            <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-stone-900/60 border border-stone-800">
              <span
                className="text-xs font-bold px-3 py-1.5 rounded-lg border"
                style={{
                  color: (STATUS_META[latestScore.suggested_status || ''] || STATUS_META.stable).color,
                  borderColor: (STATUS_META[latestScore.suggested_status || ''] || STATUS_META.stable).color,
                  background: 'rgba(0,0,0,0.2)',
                }}
              >
                {(STATUS_META[latestScore.suggested_status || ''] || {
                  label: latestScore.suggested_status || 'Stable Performance',
                }).label}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-stone-300">
                {React.createElement((TREND_META[classification.trend] || TREND_META.stable).Icon, { className: 'w-3.5 h-3.5' })}
                {(TREND_META[classification.trend] || TREND_META.stable).label}
              </span>
            </div>

            <p className="text-xs text-stone-200 leading-relaxed">{classification.rationale}</p>

            {classification.diagnostics.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-stone-400 block">
                  Diagnostic breakdown — where this is coming from
                </label>
                {classification.diagnostics.map((d) => (
                  <div
                    key={d.indicatorKey}
                    className="flex items-center justify-between p-2 rounded-lg bg-red-950/20 border border-red-900/30 text-xs"
                  >
                    <span className="text-stone-200">
                      <strong>{d.label}</strong>
                      {d.reason === 'low_value' ? ' is a primary driver' : ' declined sharply'}
                    </span>
                    <span className="font-mono text-red-300">
                      {d.currentValue}%{d.previousValue !== null ? ` (from ${d.previousValue}%)` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div>
              <label className="text-[10px] font-semibold text-stone-400 block mb-1.5">
                Compiled growth summary — {latestScore.period}
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatTile label="Overall Score" value={`${latestScore.overall_score}/100`} icon={Gauge} />
                <StatTile
                  label="Extra Notes Logged"
                  value={extraNotesInPeriod === null ? 'N/A' : extraNotesInPeriod}
                  icon={Sparkles}
                />
                <StatTile
                  label="Workload"
                  value={capacityData.isUntracked ? 'N/A' : `${capacityData.utilizationRate}%`}
                  icon={Gauge}
                />
                <StatTile label="Completed Tasks" value={tasksByStatus.completed} icon={CheckSquare} />
              </div>
            </div>
          </div>
        )}

        <div className="flex items-start gap-2 p-3 rounded-xl bg-purple-950/20 border border-purple-900/30">
          <Info className="w-3.5 h-3.5 text-purple-400 shrink-0 mt-0.5" />
          <p className="text-[10px] text-stone-400">
            Client Satisfaction and Task Execution Quality are not yet collected anywhere in this system — the
            overall score above is computed only from On-Time Completion, Capacity Utilization, and Initiative,
            with weights rebalanced across those three.
          </p>
        </div>
      </div>
    </div>
  );
};

const IndicatorTile: React.FC<{ label: string; value?: number | null; suffix?: string; placeholder?: boolean }> = ({
  label,
  value,
  suffix = '',
  placeholder = false,
}) => (
  <div
    className={`p-2.5 rounded-xl border text-center ${placeholder ? 'border-dashed opacity-60' : ''}`}
    style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
  >
    <p className="text-[9px] text-stone-400 leading-tight mb-1">{label}</p>
    {value === null || value === undefined ? (
      <p className="text-xs font-bold text-stone-500">Not yet collected</p>
    ) : (
      <p className="text-sm font-bold text-white">
        {value}
        {suffix}
      </p>
    )}
  </div>
);

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
