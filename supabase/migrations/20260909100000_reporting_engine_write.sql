-- ============================================================================
-- Reporting Engine (Module 4.7): first real write path for reports and
-- client_comparisons, plus the comparison_id link between them.
-- ============================================================================
-- Both tables were previously select-only (no generation UI existed). This
-- adds:
--
-- 1. reports.comparison_id — points at the client_comparisons row backing a
--    report's analytical content. A monthly client report is, content-wise,
--    a current-vs-previous-period comparison, so there's no report content
--    that doesn't already belong in client_comparisons. Nullable (reports
--    predating this column, if any, have nothing to backfill it with) and
--    references client_comparisons(id) with the same on-delete behavior as
--    reports.client_id's existing FK (no action — comparisons aren't deleted
--    by this app).
--
-- 2. insert/update grants + RLS for both tables, scoped to the exact same
--    audience their existing select policies already permit
--    (reports_select_rls / client_comparisons_select_rls in
--    20260906120000_rls_policies.sql): Executive, Head of Technical, AM Team
--    Lead, or the client's own AM Agent.
--
--    reports insert also enforces generated_by = caller (you can always see
--    a report you produced yourself, per the select policy's own comment —
--    this is what makes that true) and type = 'internal'. The Client Portal
--    a type: 'client' report would actually be viewed in doesn't exist yet,
--    so generating one is dead functionality for now; the column keeps its
--    full 'internal' | 'client' type for when that changes, this policy just
--    doesn't allow writing the other value yet.
--
--    client_comparisons gets both insert and update (unlike reports, which
--    only gets insert): comparison generation upserts by
--    (client_id, period_current, period_previous) — regenerating an existing
--    period pair overwrites rather than accumulating duplicates, same
--    pattern as kpi_scores' (user_id, period) upsert in
--    20260909090000_kpi_scores_write.sql. reports has no such natural key
--    (each "Generate Report" click is a new, distinct report row), so it
--    only ever gets inserted, never updated.
--
-- 3. unique (client_id, period_current, period_previous) on
--    client_comparisons — the conflict target the upsert above needs.
-- ============================================================================

begin;

alter table public.reports
  add column if not exists comparison_id text references public.client_comparisons (id);

create index if not exists idx_reports_comparison_id on public.reports (comparison_id);

grant insert on public.reports to authenticated;

create policy "reports_insert_rls" on public.reports
for insert
to authenticated
with check (
  generated_by = public.app_user_id()
  and type = 'internal'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
);

grant insert, update on public.client_comparisons to authenticated;

create policy "client_comparisons_insert_rls" on public.client_comparisons
for insert
to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

create policy "client_comparisons_update_rls" on public.client_comparisons
for update
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

alter table public.client_comparisons
  add constraint client_comparisons_client_period_unique unique (client_id, period_current, period_previous);

commit;
