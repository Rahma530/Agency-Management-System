-- ============================================================================
-- Client bulk-upload: additive AM insert RLS (am_team_lead / am_agent).
-- ============================================================================
--
-- clients_insert_sales_rls (canonical_schema_v4) stays exactly as-is — only
-- 'sales' can insert a client, and only self-attributed (sales_owner_id =
-- the caller). This adds a SECOND, independent permissive policy rather than
-- editing that one: Postgres OR's multiple permissive policies together for
-- the same command, so a row need only satisfy one of them.
--
-- This new policy lets am_team_lead / am_agent bulk-upload clients they
-- ALREADY manage (BulkClientUploadModal.tsx, AMQueue.tsx) — existing
-- accounts, not new sales-pipeline leads, so sales_owner_id must be null:
--   - am_agent: can only self-attribute am_agent_id (agents manage only
--     their own clients).
--   - am_team_lead: may attribute am_team_lead_id to themselves OR to a
--     peer team lead, provided the target id actually belongs to a user
--     whose role is 'am_team_lead' — a lead may be uploading on behalf of
--     another lead's book of clients.
-- Application code (App.tsx's handleBulkAddClient) sets status = 'active'
-- for this path (vs 'onboarding' for the sales path); that's a business
-- rule enforced client-side, not duplicated here, matching how
-- clients_insert_sales_rls never enforced status either.
-- ============================================================================

begin;

create policy "clients_insert_am_rls" on public.clients
for insert to authenticated
with check (
  sales_owner_id is null
  and (
    (
      public.app_user_role() = 'am_agent'
      and am_agent_id = public.app_user_id()
    )
    or (
      public.app_user_role() = 'am_team_lead'
      and exists (
        select 1 from public.users u
        where u.id = am_team_lead_id and u.role = 'am_team_lead'
      )
    )
  )
);

commit;
