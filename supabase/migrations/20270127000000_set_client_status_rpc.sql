-- set_client_status(): the 4 simple lifecycle transitions (Onboarding->Active, Active->Renewal,
-- Active->Paused, Paused->Active) through one SECURITY DEFINER RPC, same pattern as the existing
-- close_client / reopen_client / confirm_client_renewal RPCs.
--
-- Why: these 4 transitions were the only lifecycle moves still done as a plain
-- `update public.clients set status = ...` from the browser. That UPDATE is gated by
-- clients_update_am_assignment_rls, which only admits executive / head_of_technical /
-- am_team_lead (+ sales on its own clients) — NOT am_agent. But the UI (AMQueue quick-status
-- menu + drag-and-drop board, and the Client Dashboard lifecycle buttons) offers these
-- transitions to the am_agent assigned to the client, exactly like close/reopen/confirm-renewal
-- (whose RPCs DO admit am_agent). Result: for an am_agent, RLS silently filtered the UPDATE to
-- 0 rows, `.single()` failed, the error was swallowed client-side, and the status never changed.
--
-- This RPC also validates the transition against the row's CURRENT status in the DB (row locked
-- FOR UPDATE), so a stale browser tab can't push an invalid move, and resolves the caller's
-- identity once (no repeated app_user_role()/app_user_id() lookups).
-- No change to clients_update_am_assignment_rls itself (it still guards every other column).
begin;

create or replace function public.set_client_status(p_client_id text, p_new_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_id   text := public.app_user_id();
  v_caller_role text := public.app_user_role();
  v_current     text;
  v_am_agent_id text;
begin
  if auth.uid() is null or v_caller_id is null or v_caller_role is null then
    raise exception 'You must be signed in as a KMS employee to change a client status.';
  end if;

  if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent') then
    raise exception 'You do not have permission to change this client status.';
  end if;

  select c.status, c.am_agent_id
    into v_current, v_am_agent_id
  from public.clients c
  where c.id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if v_caller_role = 'am_agent' and v_am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to change this client status.';
  end if;

  if v_current = p_new_status then
    return; -- idempotent: already there (e.g. double click / second tab)
  end if;

  if not (
       (v_current = 'onboarding' and p_new_status = 'active')
    or (v_current = 'active'     and p_new_status in ('renewal', 'paused'))
    or (v_current = 'paused'     and p_new_status = 'active')
  ) then
    raise exception 'Status change from % to % is not allowed here (closing, reopening and confirming a renewal have their own forms).', v_current, p_new_status;
  end if;

  update public.clients
     set status = p_new_status
   where id = p_client_id;
end;
$$;

revoke all on function public.set_client_status(text, text) from public;
revoke all on function public.set_client_status(text, text) from anon;
grant execute on function public.set_client_status(text, text) to authenticated;

commit;
