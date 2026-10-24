-- Fixes a real bug in get_client_access_attachments() (20261201000000_client_access_attachments.sql),
-- found and fixed live during rollout, now mirrored back into the migration history.
--
-- The function's own RETURNS TABLE(...) declares an output column named `id`. PL/pgSQL
-- automatically creates an implicit variable for every RETURNS TABLE column, scoped to the whole
-- function body — so the unqualified `id` in `select * into v_client from public.clients where id
-- = p_client_id` was ambiguous between that implicit output variable and public.clients.id, and
-- Postgres refused the call outright ("column reference \"id\" is ambiguous").
--
-- Fix: qualify the clients row alias explicitly (`c.id = p_client_id`), the same way
-- get_client_access()/update_client_access() already do for the identically-shaped
-- `select * into v_client from public.clients where id = p_client_id` line in
-- 20261030500000_protect_client_access_columns.sql — those two are NOT affected by this bug only
-- because neither of them declares a RETURNS TABLE column named `id` (get_client_access returns a
-- fixed set of named columns, none called `id`; update_client_access returns void), so they never
-- got an implicit `id` variable to collide with.
--
-- No rollback file: reverting this would only restore the broken, already-fixed-live version, which
-- is never a useful state to roll back to. A fresh database applying migrations from scratch gets
-- the corrected function directly from this file (CREATE OR REPLACE is idempotent regardless of
-- ordering relative to 20261201000000's own definition).
begin;

create or replace function public.get_client_access_attachments(p_client_id text)
returns table (
  id text,
  storage_path text,
  filename text,
  file_size bigint,
  mime_type text,
  label text,
  uploaded_by text,
  uploaded_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
begin
  select * into v_client from public.clients c where c.id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to view this client''s access attachments.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, public.app_user_id());

  return query
    select caa.id, caa.storage_path, caa.filename, caa.file_size, caa.mime_type, caa.label,
           caa.uploaded_by, caa.uploaded_at
    from public.client_access_attachments caa
    where caa.client_id = p_client_id
    order by caa.uploaded_at desc;
end;
$$;

commit;
