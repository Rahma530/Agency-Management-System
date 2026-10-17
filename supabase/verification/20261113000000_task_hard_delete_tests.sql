-- Verification for 20261113000000_task_hard_delete.sql — delete_tasks() and deletion_log.
--
-- Single DO block, baseline-relative (real pre-existing rows are never assumed to be zero),
-- distinct real personas (explicit `<> other_id` exclusions), ends in a raised exception so
-- every fabricated row is rolled back regardless of outcome: TEST_OK_ROLLED_BACK on success, a
-- descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
do $$
declare
  v_admin_id text;
  v_admin_auth uuid;
  v_nonadmin_id text;
  v_nonadmin_auth uuid;
  v_tl_id text;
  v_tl_auth uuid;
  v_client_id text;

  v_parent_task_id text;
  v_child_task_id text;
  v_grandchild_task_id text;
  v_other_task_id text;
  v_comment_id text;
  v_attachment_id text;

  v_log_count_before integer;
  v_log_count_after integer;
  v_task_count integer;
  v_comment_count integer;
  v_attachment_count integer;
  v_log_row record;
  v_many_ids text[];
  v_i integer;
begin
  -- Distinct real personas: an active executive/head_of_technical/ai_engineer (allowed), an
  -- active am_agent (rejected — ordinary employee), and an active *_team_lead (rejected — the
  -- owner's explicit requirement that team leads, despite managing everything else about their
  -- own department's employees/capacity, are NOT in delete_tasks()'s allowed-role list).
  select id, auth_id into v_admin_id, v_admin_auth from public.users
  where role in ('executive', 'head_of_technical', 'ai_engineer') and auth_id is not null and deactivated_at is null
  limit 1;
  if v_admin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive/head_of_technical/ai_engineer persona found.';
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

  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: no client found to attach fixture tasks to.';
  end if;

  v_log_count_before := (select count(*) from public.deletion_log);

  -- Fixture: parent -> child -> grandchild (depth 2 via parent_task_id), one comment and one
  -- attachment metadata row hanging off the subtree, and an unrelated control task that must
  -- survive every scenario below untouched.
  v_parent_task_id := 'zz_del_parent_' || substr(md5(random()::text), 1, 8);
  v_child_task_id := 'zz_del_child_' || substr(md5(random()::text), 1, 8);
  v_grandchild_task_id := 'zz_del_grandchild_' || substr(md5(random()::text), 1, 8);
  v_other_task_id := 'zz_del_other_' || substr(md5(random()::text), 1, 8);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values
    (v_parent_task_id, v_client_id, 'ZZ delete parent', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low'),
    (v_other_task_id, v_client_id, 'ZZ delete control (must survive)', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low');

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, parent_task_id)
  values (v_child_task_id, v_client_id, 'ZZ delete child', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low', v_parent_task_id);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, parent_task_id)
  values (v_grandchild_task_id, v_client_id, 'ZZ delete grandchild', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low', v_child_task_id);

  v_comment_id := 'zz_del_comment_' || substr(md5(random()::text), 1, 8);
  insert into public.task_comments (id, task_id, author_id, body)
  values (v_comment_id, v_parent_task_id, v_admin_id, 'test comment');

  v_attachment_id := 'zz_del_att_' || substr(md5(random()::text), 1, 8);
  insert into public.task_attachments (id, task_id, storage_path, filename, file_size, mime_type, uploaded_by)
  values (v_attachment_id, v_child_task_id, 'zz/fake/path.png', 'fake.png', 10, 'image/png', v_admin_id);

  -- Confirms task_assignees' own pre-existing ON DELETE CASCADE still holds through this path.
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_parent_task_id, v_nonadmin_id, v_admin_id);

  -- ======================================================================
  -- Scenario 1: am_agent (ordinary employee) is rejected — nothing deleted, nothing logged.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_tasks(array[v_parent_task_id]);
    raise exception 'TEST_FAILED: scenario 1 — am_agent must be rejected by delete_tasks.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 2: a *_team_lead is rejected too — not in the allowed role list, despite managing
  -- everything else about their own department.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_tasks(array[v_parent_task_id]);
    raise exception 'TEST_FAILED: scenario 2 — a team lead must be rejected by delete_tasks.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_task_count from public.tasks
  where id in (v_parent_task_id, v_child_task_id, v_grandchild_task_id);
  if v_task_count <> 3 then
    raise exception 'TEST_FAILED: the two rejected calls above must not have deleted anything — found % of 3 fixture tasks.', v_task_count;
  end if;

  -- ======================================================================
  -- Scenario 3: the admin persona deletes the parent. Must cascade to the child, the
  -- grandchild, the comment, and the attachment metadata row; task_assignees must cascade on
  -- its own pre-existing FK; the unrelated control task must survive untouched.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth)::text, true);
  set local role authenticated;
  perform public.delete_tasks(array[v_parent_task_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_task_count from public.tasks
  where id in (v_parent_task_id, v_child_task_id, v_grandchild_task_id);
  if v_task_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — parent/child/grandchild must all be gone, % remain.', v_task_count;
  end if;

  select count(*) into v_comment_count from public.task_comments where id = v_comment_id;
  if v_comment_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — the comment on the deleted subtree must be gone.';
  end if;

  select count(*) into v_attachment_count from public.task_attachments where id = v_attachment_id;
  if v_attachment_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — the attachment metadata row on the deleted subtree must be gone.';
  end if;

  if exists (select 1 from public.task_assignees where task_id = v_parent_task_id) then
    raise exception 'TEST_FAILED: scenario 3 — task_assignees must have cascaded on its own pre-existing FK.';
  end if;

  select count(*) into v_task_count from public.tasks where id = v_other_task_id;
  if v_task_count <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — the unrelated control task must survive, found %.', v_task_count;
  end if;

  -- ======================================================================
  -- Scenario 4: exactly one new deletion_log row, for the requested parent id only (not for the
  -- child/grandchild it pulled in), with the right entity fields, snapshot, and related_counts
  -- (2 subtasks, 1 comment, 1 attachment).
  -- ======================================================================
  select count(*) into v_log_count_after from public.deletion_log;
  if v_log_count_after - v_log_count_before <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — expected exactly 1 new deletion_log row, got %.', v_log_count_after - v_log_count_before;
  end if;

  select * into v_log_row from public.deletion_log where entity_type = 'task' and entity_id = v_parent_task_id;
  if v_log_row.entity_id is null then
    raise exception 'TEST_FAILED: scenario 4 — no deletion_log row found for the deleted parent task.';
  end if;
  if v_log_row.entity_name <> 'ZZ delete parent' then
    raise exception 'TEST_FAILED: scenario 4 — entity_name mismatch: %.', v_log_row.entity_name;
  end if;
  if v_log_row.deleted_by <> v_admin_id then
    raise exception 'TEST_FAILED: scenario 4 — deleted_by mismatch: %.', v_log_row.deleted_by;
  end if;
  if (v_log_row.snapshot ->> 'id') <> v_parent_task_id then
    raise exception 'TEST_FAILED: scenario 4 — snapshot.id mismatch: %.', v_log_row.snapshot ->> 'id';
  end if;
  if (v_log_row.related_counts ->> 'subtasks')::int <> 2 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.subtasks expected 2, got %.', v_log_row.related_counts ->> 'subtasks';
  end if;
  if (v_log_row.related_counts ->> 'comments')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.comments expected 1, got %.', v_log_row.related_counts ->> 'comments';
  end if;
  if (v_log_row.related_counts ->> 'attachments')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — related_counts.attachments expected 1, got %.', v_log_row.related_counts ->> 'attachments';
  end if;

  -- ======================================================================
  -- Scenario 5: the 200-id cap. 201 ids (mostly nonexistent — only the cap is under test) must
  -- be rejected before any lookup/logging happens.
  -- ======================================================================
  v_many_ids := array[]::text[];
  for v_i in 1..201 loop
    v_many_ids := v_many_ids || ('zz_nonexistent_' || v_i::text);
  end loop;

  v_log_count_before := (select count(*) from public.deletion_log);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_tasks(v_many_ids);
    raise exception 'TEST_FAILED: scenario 5 — 201 ids must be rejected (the cap is 200).';
  exception when others then
    if sqlerrm not like '%200%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  v_log_count_after := (select count(*) from public.deletion_log);
  if v_log_count_after <> v_log_count_before then
    raise exception 'TEST_FAILED: scenario 5 — the rejected over-cap call must not write any deletion_log row.';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all task hard-delete scenarios passed; rolling back every fabricated row.';
end $$;
