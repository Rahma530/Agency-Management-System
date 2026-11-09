-- Adds the new `head_of_sales` role (owner's explicit request, 2026-11-09): a narrow, read-mostly
-- oversight role that sees EVERY client in the agency (not owner-scoped like `sales`), limited to
-- a status/renewal/contract overview. Scope decided over several follow-up questions in-session:
--   - All 5 ClientStatus values visible (onboarding/active/paused/renewal/closed), not just 3.
--   - All client details EXCEPT anything to do with employee work, Tasks, and Daily Operations.
--   - Service Briefs tab stays open but content-restricted exactly like `sales` today (this
--     migration adds no brief-content grant at all — ClientDashboard.tsx's hasBriefViewAccess
--     allow-list in the frontend is simply never given this role).
--   - No Tasks/Capacity/Daily Operations/Reports/Campaigns/Employees module access anywhere else
--     in the app (frontend-only: data/roles.ts's AGENCY_ROLES.head_of_sales.allowedModules is
--     just ['client_overview'] — nothing here needs to enforce that at the RLS layer, since this
--     role was never granted a module's nav item or screen to reach those tables through in the
--     first place).
--
-- Two backend pieces needed, both purely additive (no existing role's access changes):
--
-- 1. users_role_valid_guard() (20261101500000_users_role_validation_trigger.sql) — the hardcoded
--    built-in-role allow-list a user's role is validated against on insert/update. Without this,
--    no user's role could ever actually be set to 'head_of_sales' at all.
--
-- 2. clients_select_rls (latest body: 20261230000000_clients_select_marketing_manager_inhouse.sql)
--    — CREATE OR REPLACE'd verbatim except for one new `when 'head_of_sales' then true` branch, so
--    this role can see every client row (every status), exactly like executive/head_of_technical/
--    am_team_lead/media_buying_team_lead/seo_team_lead/social_media_team_lead already do — without
--    this, head_of_sales would fall into the generic `else` branch (visible only via a personal
--    task_assignees row), which would show it effectively zero clients.
--
-- No column-level change: head_of_sales receives the same non-sensitive column set
-- (NON_SENSITIVE_CLIENT_COLUMNS, src/types/database.ts) every other row-visible role already
-- receives — contract_value is shown to it client-side via permissions.ts's canSeeContractValue
-- (frontend-only change, no DB grant needed); due_value/remaining_value/profit_margin_pct are
-- fetched like for every other role but simply never rendered for this role in the UI (same
-- existing client-side-only convention every other non-AM role's dashboard view already relies
-- on). The separate Client Access columns (portal/platform logins, ad-account credentials,
-- payment card details) stay fully carved out via get_client_access()/update_client_access() —
-- untouched by this migration, and this role is not added to canAccessClientSensitiveInfo.

begin;

-- ----------------------------------------------------------------------------
-- 1. users_role_valid_guard() — add 'head_of_sales' to the 19 built-in roles it already accepts.
-- ----------------------------------------------------------------------------
create or replace function public.users_role_valid_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op = 'UPDATE' and new.role is not distinct from old.role then
    return new;
  end if;

  if new.role = any (array[
    'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
    'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
    'seo_content_agent', 'seo_backlink_agent', 'store_manager', 'programming_agent',
    'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
    'ai_engineer', 'marketing_manager', 'head_of_sales'
  ]) then
    return new;
  end if;

  if exists (select 1 from public.custom_roles cr where cr.id = new.role and cr.is_active) then
    return new;
  end if;

  raise exception 'Role "%" is not a valid role.', new.role;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. clients_select_rls — add the explicit head_of_sales branch (every client, every status).
--    Every other branch below is copied verbatim from the live policy
--    (20261230000000_clients_select_marketing_manager_inhouse.sql) — no other role's access
--    changes.
-- ----------------------------------------------------------------------------
drop policy if exists "clients_select_rls" on public.clients;
create policy "clients_select_rls"
on public.clients
for select
to authenticated
using (
  case public.app_user_role()
    when 'sales' then sales_owner_id = public.app_user_id()
    when 'executive' then true
    when 'head_of_technical' then true
    when 'am_team_lead' then true
    when 'am_agent' then am_agent_id = public.app_user_id()
    when 'media_buying_team_lead' then true
    when 'media_buying_agent' then public.agent_assigned(id, 'media_buying')
    when 'seo_team_lead' then true
    when 'social_media_team_lead' then true
    when 'head_of_sales' then true
    when 'seo_agent' then (
      public.agent_assigned(id, 'seo')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    when 'social_media_agent' then (
      public.agent_assigned(id, 'social_media')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    when 'marketing_manager' then (
      is_inhouse
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    else exists (
      select 1
      from public.tasks t
      where t.client_id = clients.id
        and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
    )
  end
);

commit;
