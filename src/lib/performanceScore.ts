import {
  UserRecord,
  ClientRecord,
  TaskRecord,
  ExtraNoteRecord,
  KpiScoreMetrics,
  KpiScoreRecord,
  PerformancePeriodType,
} from '../types/database';
import { getUserCapacityData } from './capacity';

// ----------------------------------------------------------------------------
// Period boundaries
// ----------------------------------------------------------------------------

export interface PeriodRange {
  period: string; // "2026-09" (monthly) or "2026-Q3" (quarterly)
  periodType: PerformancePeriodType;
  start: string; // inclusive, YYYY-MM-DD
  end: string; // inclusive, YYYY-MM-DD
}

// Builds the period string/date range for whichever month or quarter the
// given reference date (default: today) falls in. periodType is chosen by
// whoever is generating the score, not a fixed global default.
export function resolvePeriodRange(periodType: PerformancePeriodType, referenceDate: Date = new Date()): PeriodRange {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth(); // 0-indexed

  if (periodType === 'monthly') {
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0);
    return {
      period: `${year}-${String(month + 1).padStart(2, '0')}`,
      periodType,
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
    };
  }

  const quarter = Math.floor(month / 3) + 1; // 1-4
  const start = new Date(year, (quarter - 1) * 3, 1);
  const end = new Date(year, quarter * 3, 0);
  return {
    period: `${year}-Q${quarter}`,
    periodType,
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

const inRange = (dateStr: string, start: string, end: string) => dateStr >= start && dateStr <= end;

// ----------------------------------------------------------------------------
// Indicator 1: on-time task completion rate
// ----------------------------------------------------------------------------
// Scoped to tasks actually completed within the period — a still-open
// overdue task isn't "completed late," it's just not done yet (overdue
// tracking already exists elsewhere in the app as a separate, live metric).
// Subtasks count the same as top-level tasks: they're real assigned work
// with their own due_date/completed_at, consistent with how capacity/
// workload already treats them everywhere else in this app.
export function computeOnTimeCompletionRate(
  tasks: TaskRecord[],
  userId: string,
  range: PeriodRange
): number | null {
  const completedInPeriod = tasks.filter(
    (t) =>
      t.assigned_to === userId &&
      t.status === 'completed' &&
      t.completed_at &&
      inRange(t.completed_at.split('T')[0], range.start, range.end)
  );

  if (completedInPeriod.length === 0) return null;

  const onTime = completedInPeriod.filter((t) => t.completed_at!.split('T')[0] <= t.due_date).length;
  return Math.round((onTime / completedInPeriod.length) * 100);
}

// ----------------------------------------------------------------------------
// Indicator 2: clients managed vs. capacity
// ----------------------------------------------------------------------------
// Live snapshot (current utilization), not period-averaged — capacity_logs
// isn't consistently populated enough across employees to trust as a period
// aggregate. min(utilization%, 100): reaching capacity is full marks, going
// over isn't penalized (carrying extra load is arguably a strength, not a
// problem, in a promotion/raise context). null for untracked (team leads
// with capacity_limit 0 — no real target to score against).
export function computeCapacityUtilizationScore(
  user: UserRecord,
  clients: ClientRecord[],
  tasks: TaskRecord[]
): number | null {
  const data = getUserCapacityData(user, clients, tasks);
  if (data.isUntracked) return null;
  return Math.min(data.utilizationRate, 100);
}

// ----------------------------------------------------------------------------
// Indicator 3: documented initiative (extra notes)
// ----------------------------------------------------------------------------
// A volume proxy, not a quality judgment — nothing in this app can assess
// the content of free text. 'blocker' notes are excluded: those are an
// incidental side effect of resolving a blocked task, not voluntarily
// documented extra effort. min(count x 25, 100): 4+ genuine notes in the
// period is full marks.
export function computeInitiativeScore(
  extraNotes: ExtraNoteRecord[],
  userId: string,
  range: PeriodRange
): number {
  const count = extraNotes.filter(
    (n) => n.user_id === userId && n.category !== 'blocker' && inRange(n.date, range.start, range.end)
  ).length;
  return Math.min(count * 25, 100);
}

// ----------------------------------------------------------------------------
// Overall score
// ----------------------------------------------------------------------------
// client_satisfaction and task_execution_quality have no data source yet
// (see the audit this phase closed part of) — the weighted average is
// computed only over whichever of the three real indicators aren't null,
// with weights renormalized across just those. Default relative weights
// before renormalization: completion 40%, capacity 35%, initiative 25%.
const BASE_WEIGHTS = {
  on_time_completion_rate: 40,
  capacity_utilization_score: 35,
  initiative_score: 25,
} as const;

export function computeOverallScore(
  onTimeCompletionRate: number | null,
  capacityUtilizationScore: number | null,
  initiativeScore: number | null
): { overallScore: number; weights: Record<keyof typeof BASE_WEIGHTS, number> } {
  const values: Record<keyof typeof BASE_WEIGHTS, number | null> = {
    on_time_completion_rate: onTimeCompletionRate,
    capacity_utilization_score: capacityUtilizationScore,
    initiative_score: initiativeScore,
  };

  const availableKeys = (Object.keys(BASE_WEIGHTS) as (keyof typeof BASE_WEIGHTS)[]).filter(
    (k) => values[k] !== null
  );
  const baseWeightTotal = availableKeys.reduce((sum, k) => sum + BASE_WEIGHTS[k], 0);

  const weights = {} as Record<keyof typeof BASE_WEIGHTS, number>;
  (Object.keys(BASE_WEIGHTS) as (keyof typeof BASE_WEIGHTS)[]).forEach((k) => {
    weights[k] = 0;
  });

  if (availableKeys.length === 0 || baseWeightTotal === 0) {
    return { overallScore: 0, weights };
  }

  let overallScore = 0;
  availableKeys.forEach((k) => {
    const renormalizedWeight = BASE_WEIGHTS[k] / baseWeightTotal;
    weights[k] = Math.round(renormalizedWeight * 100);
    overallScore += (values[k] as number) * renormalizedWeight;
  });

  return { overallScore: Math.round(overallScore), weights };
}

// ----------------------------------------------------------------------------
// Full generation, tying the above together into what gets stored
// ----------------------------------------------------------------------------
export function generateKpiScoreMetrics(
  user: UserRecord,
  range: PeriodRange,
  tasks: TaskRecord[],
  clients: ClientRecord[],
  extraNotes: ExtraNoteRecord[]
): { metrics: KpiScoreMetrics; overallScore: number } {
  const onTimeCompletionRate = computeOnTimeCompletionRate(tasks, user.id, range);
  const capacityUtilizationScore = computeCapacityUtilizationScore(user, clients, tasks);
  const initiativeScore = computeInitiativeScore(extraNotes, user.id, range);

  const { overallScore, weights } = computeOverallScore(
    onTimeCompletionRate,
    capacityUtilizationScore,
    initiativeScore
  );

  const metrics: KpiScoreMetrics = {
    period_type: range.periodType,
    period_start: range.start,
    period_end: range.end,
    on_time_completion_rate: onTimeCompletionRate,
    capacity_utilization_score: capacityUtilizationScore,
    initiative_score: initiativeScore,
    client_satisfaction: null,
    task_execution_quality: null,
    weights,
  };

  return { metrics, overallScore };
}

// ----------------------------------------------------------------------------
// Classification suggestion (Module 10: guided promotion/raise/development-plan
// suggestion). Explicitly advisory — this only ever produces a *suggestion* attached
// to a generated score for a Team Lead/Head of Technical to review; nothing in this
// app acts on it automatically. See EmployeePerformancePage.tsx's Growth &
// Classification panel, which is the only place this gets surfaced, always framed
// as "suggested — requires review."
// ----------------------------------------------------------------------------

// suggested_status stays a loose string type at the schema level (room for future values without
// a migration), so this only covers the 4 values suggestClassification() actually produces —
// anything else falls back to a neutral label/color rather than guessing. Exported so any screen
// showing a suggested_status (EmployeePerformancePage.tsx, TeamLeadDashboard.tsx's employee
// roster) renders the identical label/color instead of re-deriving its own.
export const STATUS_META: Record<string, { label: string; color: string }> = {
  promotion: { label: 'Promotion-Worthy', color: 'var(--roas-good)' },
  raise: { label: 'Raise-Worthy', color: '#38bdf8' },
  development_plan: { label: 'Needs Development Plan', color: 'var(--roas-bad)' },
  stable: { label: 'Stable Performance', color: 'var(--lilac)' },
};

const CLASSIFIABLE_INDICATOR_KEYS = [
  'on_time_completion_rate',
  'capacity_utilization_score',
  'initiative_score',
] as const;

type ClassifiableIndicatorKey = (typeof CLASSIFIABLE_INDICATOR_KEYS)[number];

const INDICATOR_LABELS: Record<ClassifiableIndicatorKey, string> = {
  on_time_completion_rate: 'On-Time Completion Rate',
  capacity_utilization_score: 'Capacity Utilization',
  initiative_score: 'Initiative',
};

export type TrendSignal =
  | 'improving_streak' // 2+ consecutive periods each higher than the last
  | 'declining_streak' // 2+ consecutive periods each lower than the last
  | 'improving' // single-period increase, not (yet) a streak
  | 'declining' // single-period decrease, not (yet) a streak
  | 'stable'
  | 'insufficient_data'; // fewer than 2 generated periods

export interface ClassificationDiagnostic {
  indicatorKey: ClassifiableIndicatorKey;
  label: string;
  currentValue: number;
  previousValue: number | null;
  // 'low_value': this indicator is below 60 in absolute terms.
  // 'declining': not necessarily low yet, but dropped 10+ points since the previous period —
  // the thing actually explaining a decline-triggered suggestion even when the score itself
  // hasn't crossed into "low" territory.
  reason: 'low_value' | 'declining';
}

export interface ClassificationSuggestion {
  suggestedStatus: 'promotion' | 'raise' | 'development_plan' | 'stable';
  trend: TrendSignal;
  rationale: string;
  // Ranked lowest-value-first. Populated whenever a weak or declining indicator exists —
  // in practice always non-empty for 'development_plan' (the low-score trigger can't fire
  // without at least one indicator under 60), and occasionally for 'stable' when one
  // indicator is quietly weak despite an adequate overall score.
  diagnostics: ClassificationDiagnostic[];
}

const isStrictlyIncreasing = (values: number[]): boolean => {
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) return false;
  }
  return true;
};

const isStrictlyDecreasing = (values: number[]): boolean => {
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1]) return false;
  }
  return true;
};

function computeDiagnostics(
  latest: KpiScoreRecord,
  previous: KpiScoreRecord | null
): ClassificationDiagnostic[] {
  const diagnostics: ClassificationDiagnostic[] = [];

  CLASSIFIABLE_INDICATOR_KEYS.forEach((key) => {
    const currentValue = latest.metrics?.[key];
    if (currentValue === null || currentValue === undefined) return; // untracked for this employee
    const previousValue = previous?.metrics?.[key] ?? null;

    if (currentValue < 60) {
      diagnostics.push({ indicatorKey: key, label: INDICATOR_LABELS[key], currentValue, previousValue, reason: 'low_value' });
      return;
    }
    if (previousValue !== null && currentValue - previousValue <= -10) {
      diagnostics.push({ indicatorKey: key, label: INDICATOR_LABELS[key], currentValue, previousValue, reason: 'declining' });
    }
  });

  return diagnostics.sort((a, b) => a.currentValue - b.currentValue);
}

// scoreHistory must be sorted ascending by period (oldest first), ending with the period being
// classified — i.e. only periods up to and including "now" from that period's point of view, so
// a later backfilled-earlier generation doesn't get judged against periods that hadn't happened
// yet. Callers: App.tsx's handleGenerateKpiScore (to set the stored suggested_status column) and
// EmployeePerformancePage.tsx (to recompute the same suggestion live for display, off whatever
// history is already in scope — never persisted separately, so it can't drift from the data).
export function suggestClassification(scoreHistory: KpiScoreRecord[]): ClassificationSuggestion {
  const latest = scoreHistory[scoreHistory.length - 1];
  const previous = scoreHistory.length >= 2 ? scoreHistory[scoreHistory.length - 2] : null;
  const overallScore = latest.overall_score;

  const last3Scores = scoreHistory.slice(-3).map((s) => s.overall_score);
  const improvingStreak = last3Scores.length === 3 && isStrictlyIncreasing(last3Scores);
  const decliningStreak = last3Scores.length === 3 && isStrictlyDecreasing(last3Scores);

  const singleStepDelta = previous ? overallScore - previous.overall_score : null;
  const sharpDrop = singleStepDelta !== null && singleStepDelta <= -10;

  let trend: TrendSignal;
  if (improvingStreak) trend = 'improving_streak';
  else if (decliningStreak) trend = 'declining_streak';
  else if (singleStepDelta === null) trend = 'insufficient_data';
  else if (singleStepDelta >= 5) trend = 'improving';
  else if (singleStepDelta <= -5) trend = 'declining';
  else trend = 'stable';

  let suggestedStatus: ClassificationSuggestion['suggestedStatus'];
  let rationale: string;

  if (overallScore >= 85 && improvingStreak) {
    suggestedStatus = 'promotion';
    rationale = `Overall score of ${overallScore} with an improving trend across the last 3 periods (${last3Scores.join(' → ')}).`;
  } else if (overallScore < 60 || decliningStreak || sharpDrop) {
    suggestedStatus = 'development_plan';
    if (overallScore < 60) {
      rationale = `Overall score of ${overallScore} is below the sustainable-performance threshold.`;
    } else if (decliningStreak) {
      rationale = `Score has declined for 2 consecutive periods (${last3Scores.join(' → ')}).`;
    } else {
      rationale = `Score dropped ${Math.abs(singleStepDelta!)} points from the previous period (${previous!.overall_score} → ${overallScore}).`;
    }
  } else if (overallScore >= 80 && (singleStepDelta === null || singleStepDelta >= 0)) {
    suggestedStatus = 'raise';
    rationale = previous
      ? `Sustained high performance: score of ${overallScore}, holding steady or improving from ${previous.overall_score}.`
      : `Strong score of ${overallScore} in its first generated period.`;
  } else {
    suggestedStatus = 'stable';
    rationale = `Overall score of ${overallScore} — adequate performance with no strong signal in either direction.`;
  }

  return {
    suggestedStatus,
    trend,
    rationale,
    diagnostics: computeDiagnostics(latest, previous),
  };
}
