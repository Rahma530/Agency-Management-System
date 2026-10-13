-- ============================================================================
-- FUNCTION TESTS for 20261106000000_storage_lockdown.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. Every scenario below fabricates only a
-- throwaway client/task/storage.objects row; every PERSONA is a REAL existing active employee
-- (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing, rather than silently
-- skipping a check), kept mutually exclusive by explicit id exclusions. The fabricated client is
-- used instead of a real one specifically so no real client's existing assignments/am_team_lead
-- relationships can accidentally grant the "unrelated agent" persona a door this test isn't
-- trying to exercise. The final `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit
-- transaction wrapping this whole DO block, rolling back every single write performed above it —
-- nothing persists either way, pass or fail.
--
-- "Expect this call to fail" scenarios wrap the call in its own nested BEGIN/EXCEPTION block (a
-- real exception creates an implicit savepoint in plpgsql, so a caught failure doesn't abort the
-- rest of the test).
-- ============================================================================
do $$
declare
  v_sales_a_id text; v_sales_a_auth uuid;
  v_sales_b_id text; v_sales_b_auth uuid;
  v_am_agent_id text; v_am_agent_auth uuid;
  v_unrelated_id text; v_unrelated_auth uuid;

  v_client_id text;
  v_task_id text;
  v_contract_path text;
  v_task_attachment_path text;
  v_meeting_path text;
  v_chat_path text;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: select real personas defensively.
  -- ======================================================================
  select id, auth_id into v_sales_a_id, v_sales_a_auth
    from public.users where role = 'sales' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_sales_a_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active sales user with auth_id.';
  end if;

  select id, auth_id into v_sales_b_id, v_sales_b_auth
    from public.users where role = 'sales' and auth_id is not null and deactivated_at is null
      and id <> v_sales_a_id
    order by id limit 1;
  -- A second active sales user isn't guaranteed on every environment. Fall back to any other
  -- active employee ineligible under client_contracts_objects_select_rls (not this client's
  -- sales_owner/am_agent, not exec/head_of_technical/ai_engineer/am_team_lead) so the "another
  -- sales cannot see it" check still runs — with a clear notice that the same-role (sales-vs-
  -- sales, the specific case this persona was meant to isolate) scenario wasn't proven this run.
  if v_sales_b_id is null then
    raise notice 'NOTE: only 1 active sales user with auth_id found — falling back to a generic ineligible employee for the "another sales cannot see it" check; the same-role case is not isolated this run.';
    select id, auth_id into v_sales_b_id, v_sales_b_auth
      from public.users
      where auth_id is not null and deactivated_at is null
        and role not in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'sales', 'am_agent')
      order by id limit 1;
  end if;
  if v_sales_b_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second active, ineligible employee (any role) with auth_id, distinct from the sales owner.';
  end if;

  select id, auth_id into v_am_agent_id, v_am_agent_auth
    from public.users where role = 'am_agent' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_am_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active am_agent with auth_id.';
  end if;

  -- Creative roles (graphic_designer/video_editor) have no door onto a client other than an
  -- explicit task assignment — the same persona type the task_assignees_rpcs test file uses for
  -- "no other doors onto clients" negative checks.
  select id, auth_id into v_unrelated_id, v_unrelated_auth
    from public.users where role in ('graphic_designer', 'video_editor') and auth_id is not null and deactivated_at is null
      and id not in (v_sales_a_id, v_sales_b_id, v_am_agent_id)
    order by id limit 1;
  if v_unrelated_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer or video_editor with auth_id.';
  end if;

  -- ======================================================================
  -- Fabricate a throwaway client (sales_owner = v_sales_a, am_agent = v_am_agent) and a
  -- throwaway task on it (created_by/assigned_to = v_am_agent), plus one throwaway
  -- storage.objects row per bucket under test.
  -- ======================================================================
  v_client_id := 'zz_lockdown_client_' || substr(md5(random()::text), 1, 8);
  insert into public.clients (id, name, services, status, sales_owner_id, am_agent_id)
  values (v_client_id, 'ZZ Storage Lockdown Test Client', array['seo'], 'active', v_sales_a_id, v_am_agent_id);

  v_task_id := 'zz_lockdown_task_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ storage lockdown task', 'storage lockdown test', v_am_agent_id, v_am_agent_id, 'Technical', 'todo', current_date, 'low');

  v_contract_path := v_client_id || '/zz_lockdown_contract.txt';
  v_task_attachment_path := v_task_id || '/zz_lockdown_attachment.txt';
  v_meeting_path := v_client_id || '/zz_lockdown_meeting.txt';
  v_chat_path := v_unrelated_id || '/zz_lockdown_chat.txt';

  -- ======================================================================
  -- Scenario: the sales owner can INSERT and then SELECT a client-contracts object under their
  -- own client's folder.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_a_auth)::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name) values ('client-contracts', v_contract_path);
  exception when others then
    raise exception 'TEST_FAILED: sales owner can insert+select a contract object under own client folder — INSERT was denied (%).', sqlerrm;
  end;
  if not exists (select 1 from storage.objects where bucket_id = 'client-contracts' and name = v_contract_path) then
    raise exception 'TEST_FAILED: sales owner can insert+select a contract object under own client folder — SELECT after INSERT returned nothing.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario: another sales user (not this client's owner) must NOT be able to see it.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_b_auth)::text, true);
  set local role authenticated;
  if exists (select 1 from storage.objects where bucket_id = 'client-contracts' and name = v_contract_path) then
    raise exception 'TEST_FAILED: another sales cannot see a contract under a client they do not own.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario: the client's own am_agent can see it.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth)::text, true);
  set local role authenticated;
  if not exists (select 1 from storage.objects where bucket_id = 'client-contracts' and name = v_contract_path) then
    raise exception 'TEST_FAILED: client''s am_agent can see the contract under their own client.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario: an unrelated agent (no relation to this client or task at all) can't select ANY
  -- object under it, in any of the 3 restricted buckets. Fabricate the task-attachments and
  -- meeting-recordings objects first (as the unprivileged test runner context, not impersonated).
  -- ======================================================================
  insert into storage.objects (bucket_id, name) values ('task-attachments', v_task_attachment_path);
  insert into storage.objects (bucket_id, name) values ('meeting-recordings', v_meeting_path);

  perform set_config('request.jwt.claims', json_build_object('sub', v_unrelated_auth)::text, true);
  set local role authenticated;
  if exists (select 1 from storage.objects where bucket_id = 'task-attachments' and name = v_task_attachment_path) then
    raise exception 'TEST_FAILED: an unrelated agent must NOT be able to select a task-attachments object under a task they have no relation to.';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'client-contracts' and name = v_contract_path) then
    raise exception 'TEST_FAILED: an unrelated agent must NOT be able to select a client-contracts object under a client they have no relation to.';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'meeting-recordings' and name = v_meeting_path) then
    raise exception 'TEST_FAILED: an unrelated agent must NOT be able to select a meeting-recordings object under a client they have no relation to.';
  end if;

  -- ======================================================================
  -- Scenario: chat-attachments (public bucket, intentionally open) is still insertable and
  -- selectable by any authenticated user — unaffected by dropping the blanket policies, since
  -- its own select/insert policies were never conditional on anything but bucket_id. Still
  -- impersonating v_unrelated from the scenario above; any authenticated user will do.
  -- ======================================================================
  begin
    insert into storage.objects (bucket_id, name) values ('chat-attachments', v_chat_path);
  exception when others then
    raise exception 'TEST_FAILED: chat-attachments must still be insertable by any authenticated user — INSERT was denied (%).', sqlerrm;
  end;
  if not exists (select 1 from storage.objects where bucket_id = 'chat-attachments' and name = v_chat_path) then
    raise exception 'TEST_FAILED: chat-attachments must still be selectable by any authenticated user.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario: no blanket "Allow authenticated users to {select,insert,update,delete} files"
  -- policy remains on storage.objects.
  -- ======================================================================
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'Allow authenticated users to %files'
  ) then
    raise exception 'TEST_FAILED: a blanket "Allow authenticated users to ... files" storage policy still exists after the migration.';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all storage lockdown scenarios passed; rolling back every fabricated row.';
end $$;
