-- ============================================================================
-- Employee Performance: first real write path for kpi_scores.
-- ============================================================================
-- kpi_scores was previously select-only (no authoring UI existed). This adds:
--
-- 1. insert/update grants + RLS, reusing direct_report_visible() from the
--    personal-data-visibility narrowing migration: only the employee's
--    actual direct team lead, Head of Technical, or Executive may generate
--    a score for them, and must attribute it to themselves (reviewed_by =
--    caller). Update is included alongside insert because generation
--    upserts by (user_id, period) — regenerating an existing period
--    overwrites rather than accumulating duplicate rows.
--
-- 2. unique (user_id, period) — the conflict target the upsert needs. No
--    duplicate scores per employee per period.
-- ============================================================================

begin;

grant insert, update on public.kpi_scores to authenticated;

create policy "kpi_scores_insert_rls" on public.kpi_scores
for insert
to authenticated
with check (
  reviewed_by = public.app_user_id()
  and public.direct_report_visible(user_id)
);

create policy "kpi_scores_update_rls" on public.kpi_scores
for update
to authenticated
using (
  reviewed_by = public.app_user_id()
  and public.direct_report_visible(user_id)
)
with check (
  reviewed_by = public.app_user_id()
  and public.direct_report_visible(user_id)
);

alter table public.kpi_scores
  add constraint kpi_scores_user_period_unique unique (user_id, period);

commit;
