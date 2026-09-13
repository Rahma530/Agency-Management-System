-- ============================================================================
-- Module 9 (AI Layer), point 4: monthly report draft + approval workflow.
-- ============================================================================
-- reports gains:
--   - status ('draft' | 'final', default 'final') — every existing row and the existing
--     "Generate Report" flow (an already-deliberate, reviewed action) stay 'final' with zero
--     behavior change. Only the new auto-compiled monthly report draft starts life as 'draft'.
--   - approved_by / approved_at — set when a draft is approved (handleApproveReport in App.tsx),
--     mirroring the reviewed_by/created_at attribution pattern used elsewhere (kpi_scores, etc).
--
-- reports_insert_rls (20260910100000) hardcoded `type = 'internal'` — the monthly draft is
-- `type = 'client'` (it's meant to become a client-facing document, unlike the existing
-- internal-only report filing), so that check is widened to admit both types. The actual access
-- boundary is unchanged: comparison_scope_accessible(comparison_id), same as before.
--
-- reports had no update policy or grant at all before this migration — status/approved_by/
-- approved_at need one now (approving a draft is an UPDATE).
-- ============================================================================

begin;

alter table public.reports
  add column if not exists status text not null default 'final',
  add column if not exists approved_by text references public.users (id),
  add column if not exists approved_at timestamptz;

alter table public.reports
  add constraint reports_status_check check (status in ('draft', 'final'));

drop policy if exists "reports_insert_rls" on public.reports;
create policy "reports_insert_rls" on public.reports
for insert
to authenticated
with check (
  generated_by = public.app_user_id()
  and type in ('internal', 'client')
  and comparison_id is not null
  and public.comparison_scope_accessible(comparison_id)
);

grant update on public.reports to authenticated;

create policy "reports_update_rls" on public.reports
for update
to authenticated
using (
  comparison_id is not null and public.comparison_scope_accessible(comparison_id)
)
with check (
  comparison_id is not null and public.comparison_scope_accessible(comparison_id)
  and (approved_by is null or approved_by = public.app_user_id())
);

commit;
