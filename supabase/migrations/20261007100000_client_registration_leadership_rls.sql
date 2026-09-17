-- Preserve the existing AM Agent INSERT branch while moving AM Team Leader
-- registration to the management policy, where both assignments are optional.
begin;

drop policy "clients_insert_am_rls" on public.clients;

create policy "clients_insert_am_rls" on public.clients
for insert to authenticated
with check (
  sales_owner_id is null
  and public.app_user_role() = 'am_agent'
  and am_agent_id = public.app_user_id()
);

create policy "clients_insert_leadership_rls" on public.clients
for insert to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  and public.app_user_id() is not null
  and sales_owner_id is null
  and (
    am_team_lead_id is null or exists (
      select 1 from public.users u
      where u.id = am_team_lead_id and u.role = 'am_team_lead'
        and u.auth_id is not null and u.deactivated_at is null
    )
  )
  and (
    am_agent_id is null or exists (
      select 1 from public.users u
      where u.id = am_agent_id and u.role = 'am_agent'
        and u.auth_id is not null and u.deactivated_at is null
    )
  )
);

commit;
