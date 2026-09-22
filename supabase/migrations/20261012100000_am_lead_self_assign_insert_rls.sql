-- Allow an AM Team Leader to self-assign as the "Account Manager" (am_agent_id) on a client
-- they're registering, not just delegate to an AM Agent. clients_update_am_assignment_rls
-- (rls_policies.sql) already permits this on reassignment of an EXISTING client — it only checks
-- the caller's own role, not the target id's role. clients_insert_leadership_rls
-- (client_registration_leadership_rls.sql), which governs both the single-client registration
-- modal and the leadership branch of the bulk-upload modal, was stricter: it hard-required
-- am_agent_id to reference a user whose role is literally 'am_agent'. This widens that one check
-- to accept either 'am_agent' or 'am_team_lead', so registration-time self-assignment doesn't hit
-- an RLS violation that the update path never had.
--
-- am_team_lead_id keeps its existing role = 'am_team_lead' check unchanged — this is only about
-- who can fill the am_agent_id ("Account Manager") slot.
--
-- clients_insert_am_rls (client_registration_leadership_rls.sql) is untouched: its only branch is
-- am_agent self-attribution (am_agent_id = app_user_id() while app_user_role() = 'am_agent'), with
-- no am_team_lead branch and no check against someone else's role, so there's nothing to widen
-- there.
begin;

drop policy "clients_insert_leadership_rls" on public.clients;

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
      where u.id = am_agent_id and u.role in ('am_agent', 'am_team_lead')
        and u.auth_id is not null and u.deactivated_at is null
    )
  )
);

commit;
