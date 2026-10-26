-- Verification for 20261215000000_client_full_delete.sql — delete_clients() and deletion_log.
--
-- Single DO block, baseline-relative (real pre-existing rows are never assumed to be zero),
-- distinct real personas (explicit `<> other_id` exclusions), ends in a raised exception so
-- every fabricated row is rolled back regardless of outcome: TEST_OK_ROLLED_BACK on success, a
-- descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Notably tests that an am_team_lead (who IS allowed to call the existing safe, "nothing left to
-- lose" clients_delete_rls policy) is still REJECTED by this new, deliberately narrower
-- delete_clients() — executive/head_of_technical only, same trust tier as delete_tasks().
do $$
declare
  v_admin_id text;
  v_admin_auth uuid;
  v_nonadmin_id text;
  v_nonadmin_auth uuid;
  v_tl_id text;
  v_tl_auth uuid;

  v_client_id text;
  v_other_client_id text;

  v_parent_task_id text;
  v_child_task_id text;
  v_other_task_id text;
  v_comment_id text;
  v_attachment_id text;

  v_report_id text;
  v_version_id text;
  v_source_item_id text;
  v_suggestion_id text;
  v_audit_event_id text;

  v_brief_id text;
  v_daily_log_id text;
  v_assignment_id text;
  v_contract_id text;

  v_other_task_control_id text;

  v_log_count_before integer;
  v_log_count_after integer;
  v_count integer;
  v_log_row record;
  v_many_ids text[];
  v_i integer;
begin
  -- Distinct real personas: an active executive/head_of_technical (allowed), an active am_agent
  -- (rejected — ordinary employee), and an active *_team_lead (rejected — despite being allowed
  -- to call the existing safe clients_delete_rls policy, this force-delete RPC is deliberately
  -- narrower).
  select id, auth_id into v_admin_id, v_admin_auth from public.users
  where role in ('executive', 'head_of_technical') and auth_id is not null and deactivated_at is null
  limit 1;
  if v_admin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive/head_of_technical persona found.';
  end if;

  select id, auth_id into v_nonadmin_id, v_nonadmin_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null and id <> v_admin_id
  limit 1;
  if v_nonadmin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found.';
  end if;

  select id, auth_id into v_tl_id, v_tl_auth from public.users
  where role like '%\_team\_lead' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_nonadmin_id
  limit 1;
  if v_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active *_team_lead persona found.';
  end if;

  v_log_count_before := (select count(*) from public.deletion_log);

  -- ----------------------------------------------------------------------------------------
  -- Fixture: one client with a full spread of activity across every table delete_clients()
  -- must clear (task subtree + comment + attachment, a report with its full versions/source
  -- items/ai suggestion/audit event chain, a brief, a daily log, an assignment, a contract),
  -- plus one unrelated control client (with its own task) that must survive every scenario
  -- below untouched.
  -- ----------------------------------------------------------------------------------------
  v_client_id := 'zz_del_client_' || substr(md5(random()::text), 1, 8);
  v_other_client_id := 'zz_del_other_client_' || substr(md5(random()::text), 1, 8);

  insert into public.clients (id, name, services, status)
  values
    (v_client_id, 'ZZ Delete Target Client', array['seo', 'media_buying'], 'active'),
    (v_other_client_id, 'ZZ Delete Control Client (must survive)', array['seo'], 'active');

  v_parent_task_id := 'zz_del_ctask_parent_' || substr(md5(random()::text), 1, 8);
  v_child_task_id := 'zz_del_ctask_child_' || substr(md5(random()::text), 1, 8);
  v_other_task_control_id := 'zz_del_ctask_control_' || substr(md5(random()::text), 1, 8);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_parent_task_id, v_client_id, 'ZZ client-delete parent task', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low');

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, parent_task_id)
  values (v_child_task_id, v_client_id, 'ZZ client-delete child task', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low', v_parent_task_id);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_other_task_control_id, v_other_client_id, 'ZZ control client task (must survive)', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low');

  v_comment_id := 'zz_del_ccomment_' || substr(md5(random()::text), 1, 8);
  insert into public.task_comments (id, task_id, author_id, body)
  values (v_comment_id, v_parent_task_id, v_admin_id, 'test comment');

  v_attachment_id := 'zz_del_catt_' || substr(md5(random()::text), 1, 8);
  insert into public.task_attachments (id, task_id, storage_path, filename, file_size, mime_type, uploaded_by)
  values (v_attachment_id, v_child_task_id, 'zz/fake/path.png', 'fake.png', 10, 'image/png', v_admin_id);

  v_report_id := 'zz_del_report_' || substr(md5(random()::text), 1, 8);
  insert into public.reports (id, client_id, type, period, generated_by, status, scope_type, creator_note)
  values (v_report_id, v_client_id, 'client', '2026-10-01_2026-10-07', v_admin_id, 'draft', 'client', '');

  v_version_id := 'zz_del_rver_' || substr(md5(random()::text), 1, 8);
  insert into public.report_content_versions (id, report_id, version_no, content_text, source_hash, origin, created_by)
  values (v_version_id, v_report_id, 1, 'test content', 'zzhash1', 'manual', v_admin_id);

  update public.reports set current_version_id = v_version_id where id = v_report_id;

  v_source_item_id := 'zz_del_rsrc_' || substr(md5(random()::text), 1, 8);
  insert into public.report_source_items (id, report_id, source_kind, source_id, source_date, user_id, client_id, snapshot)
  values (v_source_item_id, v_report_id, 'extra_note', 'zz_src_1', current_date, v_admin_id, v_client_id, '{}'::jsonb);

  v_suggestion_id := 'zz_del_rais_' || substr(md5(random()::text), 1, 8);
  insert into public.report_ai_suggestions (id, report_id, base_version_id, source_hash, suggested_text, requested_by)
  values (v_suggestion_id, v_report_id, v_version_id, 'zzhash1', 'test suggestion', v_admin_id);

  v_audit_event_id := 'zz_del_raud_' || substr(md5(random()::text), 1, 8);
  insert into public.report_audit_events (id, report_id, actor_id, action)
  values (v_audit_event_id, v_report_id, v_admin_id, 'created');

  v_brief_id := 'zz_del_brief_' || substr(md5(random()::text), 1, 8);
  insert into public.briefs (id, client_id, service_type, submitted_by, version)
  values (v_brief_id, v_client_id, 'seo', v_admin_id, 1);

  v_daily_log_id := 'zz_del_dlog_' || substr(md5(random()::text), 1, 8);
  insert into public.daily_logs (id, user_id, date, summary_text, client_id)
  values (v_daily_log_id, v_admin_id, current_date, 'test log', v_client_id);

  v_assignment_id := 'zz_del_assign_' || substr(md5(random()::text), 1, 8);
  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id)
  values (v_assignment_id, v_client_id, 'seo', v_tl_id, v_nonadmin_id);

  v_contract_id := 'zz_del_contract_' || substr(md5(random()::text), 1, 8);
  insert into public.client_contracts (id, client_id, storage_path, filename, file_size, mime_type, uploaded_by)
  values (v_contract_id, v_client_id, 'zz/fake/contract.pdf', 'contract.pdf', 100, 'application/pdf', v_admin_id);

  -- ======================================================================
  -- Scenario 1: am_agent (ordinary employee) is rejected — nothing deleted, nothing logged.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_clients(array[v_client_id]);
    raise exception 'TEST_FAILED: scenario 1 — am_agent must be rejected by delete_clients.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 2: a *_team_lead is rejected too, despite being allowed to call the existing
  -- safe-delete clients_delete_rls policy — delete_clients() is a deliberately narrower,
  -- "force delete everything" capability reserved for executive/head_of_technical only.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_clients(array[v_client_id]);
    raise exception 'TEST_FAILED: scenario 2 — a team lead must be rejected by delete_clients.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.clients where id = v_client_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: the two rejected calls above must not have deleted the target client.';
  end if;

  -- ======================================================================
  -- Scenario 3: the admin persona deletes the target client. Must cascade through every
  -- table above; the unrelated control client (and its task) must survive untouched.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth)::text, true);
  set local role authenticated;
  perform public.delete_clients(array[v_client_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.clients where id = v_client_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — target client must be gone.';
  end if;

  select count(*) into v_count from public.tasks where id in (v_parent_task_id, v_child_task_id);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — target client''s task subtree must be gone, % remain.', v_count;
  end if;

  if exists (select 1 from public.task_comments where id = v_comment_id) then
    raise exception 'TEST_FAILED: scenario 3 — the comment on the deleted task subtree must be gone.';
  end if;

  if exists (select 1 from public.task_attachments where id = v_attachment_id) then
    raise exception 'TEST_FAILED: scenario 3 — the attachment metadata row on the deleted task subtree must be gone.';
  end if;

  if exists (select 1 from public.reports where id = v_report_id) then
    raise exception 'TEST_FAILED: scenario 3 — the report must be gone.';
  end if;
  if exists (select 1 from public.report_content_versions where id = v_version_id) then
    raise exception 'TEST_FAILED: scenario 3 — the report content version must be gone.';
  end if;
  if exists (select 1 from public.report_source_items where id = v_source_item_id) then
    raise exception 'TEST_FAILED: scenario 3 — the report source item must be gone.';
  end if;
  if exists (select 1 from public.report_ai_suggestions where id = v_suggestion_id) then
    raise exception 'TEST_FAILED: scenario 3 — the report AI suggestion must be gone.';
  end if;
  if exists (select 1 from public.report_audit_events where id = v_audit_event_id) then
    raise exception 'TEST_FAILED: scenario 3 — the report audit event must be gone.';
  end if;

  if exists (select 1 from public.briefs where id = v_brief_id) then
    raise exception 'TEST_FAILED: scenario 3 — the brief must be gone.';
  end if;
  if exists (select 1 from public.daily_logs where id = v_daily_log_id) then
    raise exception 'TEST_FAILED: scenario 3 — the daily log must be gone.';
  end if;
  if exists (select 1 from public.assignments where id = v_assignment_id) then
    raise exception 'TEST_FAILED: scenario 3 — the assignment must be gone.';
  end if;
  if exists (select 1 from public.client_contracts where id = v_contract_id) then
    raise exception 'TEST_FAILED: scenario 3 — the client contract must be gone.';
  end if;

  select count(*) into v_count from public.clients where id = v_other_client_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — the unrelated control client must survive.';
  end if;
  select count(*) into v_count from public.tasks where id = v_other_task_control_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — the control client''s own task must survive, scoping must be client_id-exact.';
  end if;

  -- ======================================================================
  -- Scenario 4: exactly one new deletion_log row, for the deleted client, with the right
  -- entity fields, snapshot, and related_counts (1 task [+1 subtask], 1 report, 1 brief,
  -- 1 daily log).
  -- ======================================================================
  select count(*) into v_log_count_after from public.deletion_log;
  if v_log_count_after - v_log_count_before <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — expected exactly 1 new deletion_log row, got %.', v_log_count_after - v_log_count_before;
  end if;

  select * into v_log_row from public.deletion_log where entity_type = 'client' and entity_id = v_client_id;
  if v_log_row.entity_id is null then
    raise exception 'TEST_FAILED: scenario 4 — no deletion_log row found for the deleted client.';
  end if;
  if v_log_row.entity_name <> 'ZZ Delete Target Client' then
    raise exception 'TEST_FAILED: scenario 4 — entity_name mismatch: %.', v_log_row.entity_name;
  end if;
  if v_log_row.deleted_by <> v_admin_id then
    raise exception 'TEST_FAILED: scenario 4 — deleted_by mismatch: %.', v_log_row.deleted_by;
  end if;
  if (v_log_row.snapshot ->> 'id') <> v_client_id then
    raise exception 'TEST_FAILED: scenario 4 — snapshot.id mismatch: %.', v_log_row.snapshot ->> 'id';
  end if;
  if (v_log_row.related_counts ->> 'tasks')::int <> 2 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.tasks expected 2 (parent + child), got %.', v_log_row.related_counts ->> 'tasks';
  end if;
  if (v_log_row.related_counts ->> 'reports')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.reports expected 1, got %.', v_log_row.related_counts ->> 'reports';
  end if;
  if (v_log_row.related_counts ->> 'briefs')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.briefs expected 1, got %.', v_log_row.related_counts ->> 'briefs';
  end if;
  if (v_log_row.related_counts ->> 'daily_logs')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.daily_logs expected 1, got %.', v_log_row.related_counts ->> 'daily_logs';
  end if;

  -- ======================================================================
  -- Scenario 5: the 25-id cap. 26 ids (mostly nonexistent — only the cap is under test) must
  -- be rejected before any lookup/logging happens.
  -- ======================================================================
  v_many_ids := array[]::text[];
  for v_i in 1..26 loop
    v_many_ids := v_many_ids || ('zz_nonexistent_' || v_i::text);
  end loop;

  v_log_count_before := (select count(*) from public.deletion_log);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_clients(v_many_ids);
    raise exception 'TEST_FAILED: scenario 5 — 26 ids must be rejected (the cap is 25).';
  exception when others then
    if sqlerrm not like '%25%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  v_log_count_after := (select count(*) from public.deletion_log);
  if v_log_count_after <> v_log_count_before then
    raise exception 'TEST_FAILED: scenario 5 — the rejected over-cap call must not write any deletion_log row.';
  end if;

  -- Final cleanup of the control client fixture (the target client/task subtree was already
  -- removed by delete_clients() itself in scenario 3).
  delete from public.tasks where id = v_other_task_control_id;
  delete from public.clients where id = v_other_client_id;

  raise exception 'TEST_OK_ROLLED_BACK: all client full-delete scenarios passed; rolling back every fabricated row.';
end $$;
