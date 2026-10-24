-- Verification for 20261130000000_brief_attachments.sql.
--
-- Scope: public.brief_attachments table RLS only (select/insert/delete). The storage.objects
-- policies added by the same migration reuse the EXACT predicate shape already shipped (and left
-- unverified by its own migration, per this schema's existing convention) for client_contracts'
-- storage.objects policies in 20260922100000_client_contracts.sql/20261106000000_storage_lockdown.sql
-- — a separate storage.objects test is intentionally not added here, consistent with that
-- precedent.
--
-- Single DO block, real personas, ends in a raised exception so every fabricated change (test
-- client, briefs, brief_attachments rows) is rolled back regardless of outcome: TEST_OK_ROLLED_BACK
-- on success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
do $$
declare
  v_am_agent_id text; v_am_agent_auth uuid;
  v_seo_tl_id text; v_seo_tl_auth uuid;
  v_seo_agent_id text; v_seo_agent_auth uuid;
  v_designer_id text; v_designer_auth uuid;
  v_unrelated_id text; v_unrelated_auth uuid;
  v_client_id text := 'zz_briefatt_c_' || substr(md5(random()::text), 1, 8);
  v_seo_brief_id text := 'zz_briefatt_b_' || substr(md5(random()::text), 1, 8);
  v_creative_brief_id text := 'zz_briefatt_cb_' || substr(md5(random()::text), 1, 8);
  v_count integer;
begin
  select id, auth_id into v_am_agent_id, v_am_agent_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_seo_tl_id, v_seo_tl_auth from public.users
  where role = 'seo_team_lead' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_seo_agent_id, v_seo_agent_auth from public.users
  where role = 'seo_agent' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_designer_id, v_designer_auth from public.users
  where role = 'graphic_designer' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_unrelated_id, v_unrelated_auth from public.users
  where role = 'social_media_agent' and auth_id is not null and deactivated_at is null limit 1;

  if v_am_agent_id is null or v_seo_tl_id is null or v_seo_agent_id is null
     or v_designer_id is null or v_unrelated_id is null then
    raise exception 'TEST_SETUP_FAILED: missing a required active persona (am_agent/seo_team_lead/seo_agent/graphic_designer/social_media_agent).';
  end if;

  insert into public.clients (id, name, status, am_agent_id)
  values (v_client_id, 'ZZ Brief Attachments Test Client', 'active', v_am_agent_id);

  insert into public.briefs (id, client_id, service_type, fields, submitted_by, version, custom_field_defs)
  values (v_seo_brief_id, v_client_id, 'seo', '{}'::jsonb, v_am_agent_id, 1, '[]'::jsonb);

  insert into public.briefs (id, client_id, service_type, fields, submitted_by, version, custom_field_defs)
  values (v_creative_brief_id, v_client_id, 'creative', '{}'::jsonb, v_designer_id, 1, '[]'::jsonb);

  -- ==========================================================================
  -- Scenario 1: the client's own am_agent can insert an attachment on the (unsubmitted) SEO brief.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' (scenario 1).';
  end if;
  insert into public.brief_attachments (id, brief_id, storage_path, filename, file_size, mime_type, uploaded_by)
  values ('zz_ba_1', v_seo_brief_id, v_seo_brief_id || '/spec.pdf', 'spec.pdf', 1024, 'application/pdf', v_am_agent_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.brief_attachments where id = 'zz_ba_1';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — am_agent insert on own client''s brief must succeed.';
  end if;

  -- ==========================================================================
  -- Scenario 2: an unrelated SEO agent (not assigned to this client) cannot insert on the brief.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.brief_attachments (id, brief_id, storage_path, filename, file_size, mime_type, uploaded_by)
    values ('zz_ba_2', v_seo_brief_id, v_seo_brief_id || '/x.pdf', 'x.pdf', 1024, 'application/pdf', v_seo_agent_id);
    raise exception 'TEST_FAILED: scenario 2 — a plain seo_agent must never be able to insert a brief attachment (agents have no edit right on briefs_update_rls).';
  exception
    when others then
      if sqlerrm like 'TEST_FAILED%' then
        raise;
      end if;
      -- expected: RLS with_check violation (new row violates row-level security policy)
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ==========================================================================
  -- Scenario 3: the SEO team lead cannot SEE the attachment before the brief is submitted
  -- (submitted_at is null) — mirrors briefs_select_rls's own submitted_at gate for team leads.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.brief_attachments where brief_id = v_seo_brief_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — seo_team_lead must not see attachments on an unsubmitted brief, found %.', v_count;
  end if;

  -- ==========================================================================
  -- Scenario 4: once submitted, the SEO team lead CAN see it (read access mirrors briefs_select_rls).
  -- ==========================================================================
  update public.briefs set submitted_at = now() where id = v_seo_brief_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.brief_attachments where brief_id = v_seo_brief_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — seo_team_lead must see the attachment once the brief is submitted, found %.', v_count;
  end if;

  -- ==========================================================================
  -- Scenario 5: an unrelated department (social_media_agent) never sees it, submitted or not.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_unrelated_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.brief_attachments where brief_id = v_seo_brief_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 5 — an unrelated department must never see this brief''s attachments, found %.', v_count;
  end if;

  -- ==========================================================================
  -- Scenario 6: the creative brief's own submitting designer can insert and see their attachment;
  -- delete also works for them (uploader, own submitted creative brief).
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_designer_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.brief_attachments (id, brief_id, storage_path, filename, file_size, mime_type, uploaded_by)
  values ('zz_ba_3', v_creative_brief_id, v_creative_brief_id || '/mock.png', 'mock.png', 2048, 'image/png', v_designer_id);
  select count(*) into v_count from public.brief_attachments where id = 'zz_ba_3';
  if v_count <> 1 then
    reset role; perform set_config('request.jwt.claims', '', true);
    raise exception 'TEST_FAILED: scenario 6 — the submitting designer must be able to insert+see their own creative brief''s attachment.';
  end if;
  delete from public.brief_attachments where id = 'zz_ba_3';
  select count(*) into v_count from public.brief_attachments where id = 'zz_ba_3';
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 6 — the submitting designer must be able to delete their own attachment.';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all brief_attachments scenarios passed; rolling back every fabricated change.';
exception when others then
  if sqlerrm like 'TEST_OK_ROLLED_BACK%' or sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
    raise;
  end if;
  raise;
end $$;
