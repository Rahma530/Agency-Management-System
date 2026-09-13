-- ============================================================================
-- Reporting Engine: add a second, independent report shape — a single-period
-- "snapshot" (no prior-period comparison) — alongside the existing
-- current-vs-previous comparison rows.
-- ============================================================================
--
-- client_comparisons gains:
--   - row_kind ('comparison' | 'period_summary'), not null, defaulting (and
--     backfilling every existing row to) 'comparison' — the only shape that
--     existed before this migration. Set explicitly by the app at generation
--     time (src/lib/reportingEngine.ts's generateClientComparison() and the
--     new generatePeriodSummary() each set their own literal value), not
--     inferred from period_previous — an explicit discriminant that can't
--     drift out of sync with a row's actual shape.
--   - a check constraint restricting it to those two values, since it
--     directly determines which of the uniqueness rules below applies to a
--     given row — a stray third value would silently escape both.
--
-- period_previous becomes nullable: a period_summary row has no prior
-- period at all. metrics_previous and delta need no schema change — every
-- field on ClientComparisonMetrics/ClientComparisonDelta is already
-- optional, so a period_summary row simply stores {} for both, which was
-- already a valid value under the existing column types.
--
-- UNIQUENESS
-- ----------
-- The two existing constraints from prior migrations —
-- client_comparisons_client_period_unique (plain, on client_id/
-- period_current/period_previous) and client_comparisons_agent_period_unique
-- (partial, on agent_id/period_current/period_previous where agent_id is not
-- null) — both include period_previous in their key. A period_summary row
-- always has period_previous = NULL, and Postgres treats every NULL as
-- distinct from every other NULL under both plain and partial unique
-- constraints, so regenerating the same client/agent + period_current as a
-- period_summary would insert a duplicate under either existing constraint
-- rather than upsert-overwrite. Neither existing constraint needs to
-- change to fix this (they still correctly dedupe 'comparison' rows, which
-- always have period_previous set) — two new partial indexes below cover
-- the period_summary case specifically.
--
-- Per the confirmed spec: a client (or agent) can hold BOTH a 'comparison'
-- row and a 'period_summary' row for the same period_current without
-- conflict — they're different report types describing the same period.
-- This falls out naturally rather than needing explicit handling: the new
-- indexes below are predicated on row_kind = 'period_summary', so they never
-- see a 'comparison' row for that same client/period at all (it lives under
-- the pre-existing, disjoint constraint instead).
--
-- RLS: no changes. report_scope_accessible()/comparison_scope_accessible()
-- (20260910100000) are keyed purely on client_id/agent_id and have no
-- awareness of period fields or row_kind, so both report shapes are already
-- covered by the existing policies with zero modification.
-- ============================================================================

begin;

alter table public.client_comparisons
  add column if not exists row_kind text not null default 'comparison';

alter table public.client_comparisons
  add constraint client_comparisons_row_kind_check
  check (row_kind in ('comparison', 'period_summary'));

alter table public.client_comparisons alter column period_previous drop not null;

create unique index if not exists client_comparisons_client_period_summary_unique
  on public.client_comparisons (client_id, period_current)
  where row_kind = 'period_summary';

create unique index if not exists client_comparisons_agent_period_summary_unique
  on public.client_comparisons (agent_id, period_current)
  where row_kind = 'period_summary';

commit;
