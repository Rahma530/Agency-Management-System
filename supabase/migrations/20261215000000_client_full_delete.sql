-- Client full (cascading) hard delete — executive/head_of_technical only.
--
-- Background: clients_delete_rls (canonical_schema_v4, widened for team leads in
-- align_ai_engineer_with_head_of_technical, narrowed back off ai_engineer in
-- ai_engineer_deprivilege) already lets a real DELETE succeed for a client with ZERO rows in any
-- of its 18 referencing tables (every one of them defaults to ON DELETE NO ACTION/RESTRICT, so
-- Postgres itself already blocks it otherwise — see clientDeletion.ts's getClientActivitySummary,
-- which pre-checks exactly this so the UI can show what's blocking before the user even tries).
-- Per the agency owner, directly requested: a client that DOES have activity (tasks, reports,
-- briefs, daily logs, …) should still be fully, permanently deletable when that is genuinely
-- wanted — the same "force delete everything" capability delete_tasks() (20261113000000) already
-- gives for tasks. This migration adds the client-scoped equivalent, delete_clients().
--
-- Deliberately a NARROWER role gate than clients_delete_rls's existing safe-delete policy
-- (executive/head_of_technical only — no team leads, no ai_engineer): that policy only ever lets
-- a delete through when there is nothing left to lose, so a wider role set was low-risk. This
-- function can erase a client's entire history — every task, report, brief, daily log, contract,
-- insight row, and more — in one call, which is a materially different risk and gets the same bar
-- as delete_tasks()'s own hard-delete capability's most-trusted tier.
--
-- FK audit — every table with a client_id (or, for tasks/briefs/reports, a column chaining back to
-- one) column referencing public.clients(id), as of this migration, and what must happen to each
-- before the client row itself can go (none of these is ON DELETE CASCADE from clients, so every
-- one needs its own explicit DELETE first, in dependency order):
--   tasks                     -> own subtree (parent_task_id, any depth) + task_comments/
--                                task_attachments/task_assignee_log (RESTRICT/no-FK child rows —
--                                same ordering delete_tasks() already uses; task_assignees/
--                                task_platform_links are ON DELETE CASCADE off tasks, so deleting
--                                the task rows handles those two on their own)
--   briefs                    -> brief_attachments is ON DELETE CASCADE off briefs (20261130000000),
--                                so deleting briefs handles it; no explicit DELETE needed here
--   reports                   -> report_ai_suggestions, report_audit_events, report_source_items
--                                (all ON DELETE RESTRICT off reports — must go first), then
--                                report_content_versions (also RESTRICT off reports, and the
--                                target of reports.current_version_id, itself DEFERRABLE INITIALLY
--                                DEFERRED — safe to delete both report_content_versions and its
--                                parent reports row inside the same statement-pair/transaction, the
--                                exact same "both sides gone by COMMIT" reasoning delete_tasks()
--                                already relies on for tasks.parent_task_id)
--   assignments, client_contracts, client_portal_users, meetings, social_insights,
--   analytics_insights, platform_connections, client_comparisons, daily_logs, seo_insights,
--   media_buying_insights, client_lifecycle_periods, client_renewal_events,
--   client_access_attachments
--                             -> all leaf tables (nothing else references any of them) — one
--                                DELETE ... where client_id = X each, no further ordering needed
--
-- Storage: client_contracts.storage_path, client_access_attachments.storage_path,
-- task_attachments.storage_path, brief_attachments.storage_path, and meetings.recording_url all
-- point at real uploaded Storage objects. Exactly like delete_tasks() before it, this function
-- deletes only the metadata rows — Storage deletion needs the Storage API, not raw SQL on
-- storage.objects, so a client's uploaded files are left behind as orphaned objects after a full
-- delete. A pre-existing gap (every metadata-only delete path in this schema already has it), not
-- something this migration closes.
begin;

-- deletion_log.entity_type already allows 'client' (added in 20261113000000 specifically so this
-- day could reuse the same audit trail without its own migration) — no DDL needed here, just a new
-- writer.

create or replace function public.delete_clients(p_client_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_actor_id text := public.app_user_id();
  v_client_id text;
  v_client public.clients;
  v_task_ids text[];
  v_report_ids text[];
  v_tasks_count integer;
  v_reports_count integer;
  v_briefs_count integer;
  v_daily_logs_count integer;
  v_deleted_count integer;
  v_all_client_ids text[] := array[]::text[];
begin
  if v_actor_role not in ('executive', 'head_of_technical') then
    raise exception 'Only executive or head_of_technical may permanently delete a client and its data.';
  end if;

  if p_client_ids is null or array_length(p_client_ids, 1) is null then
    raise exception 'p_client_ids must not be empty.';
  end if;

  if array_length(p_client_ids, 1) > 25 then
    raise exception 'Cannot delete more than 25 clients in a single call (got %).', array_length(p_client_ids, 1);
  end if;

  foreach v_client_id in array p_client_ids loop
    select * into v_client from public.clients where id = v_client_id;
    if v_client.id is null then
      continue; -- already gone (or never existed) — nothing left to do for this id
    end if;

    -- Full task subtree for this client, any depth, same recursive shape delete_tasks() uses.
    with recursive subtree as (
      select t.id from public.tasks t where t.client_id = v_client_id
      union all
      select c.id from public.tasks c join subtree s on c.parent_task_id = s.id
    )
    select array_agg(id) into v_task_ids from subtree;

    select array_agg(id) into v_report_ids from public.reports where client_id = v_client_id;

    select count(*) into v_tasks_count from unnest(coalesce(v_task_ids, array[]::text[])) x;
    select count(*) into v_reports_count from unnest(coalesce(v_report_ids, array[]::text[])) x;
    select count(*) into v_briefs_count from public.briefs where client_id = v_client_id;
    select count(*) into v_daily_logs_count from public.daily_logs where client_id = v_client_id;

    insert into public.deletion_log (entity_type, entity_id, entity_name, deleted_by, snapshot, related_counts)
    values (
      'client',
      v_client.id,
      v_client.name,
      v_actor_id,
      to_jsonb(v_client),
      jsonb_build_object(
        'tasks', v_tasks_count,
        'reports', v_reports_count,
        'briefs', v_briefs_count,
        'daily_logs', v_daily_logs_count
      )
    );

    -- ---- Tasks and their own RESTRICT/no-FK children (same order as delete_tasks()) ----
    if v_task_ids is not null then
      delete from public.task_comments where task_id = any(v_task_ids);
      delete from public.task_attachments where task_id = any(v_task_ids);
      delete from public.task_assignee_log where task_id = any(v_task_ids);
      delete from public.tasks where id = any(v_task_ids);
    end if;

    -- ---- Reports and their own RESTRICT children ----
    if v_report_ids is not null then
      delete from public.report_ai_suggestions where report_id = any(v_report_ids);
      delete from public.report_audit_events where report_id = any(v_report_ids);
      delete from public.report_source_items where report_id = any(v_report_ids);
      delete from public.report_content_versions where report_id = any(v_report_ids);
      delete from public.reports where id = any(v_report_ids);
    end if;
    -- report_source_items can also carry client_id directly (20261107000000) — belt-and-braces
    -- in case any row ever points at this client without a report_id this function already
    -- caught above (should not happen in practice, but costs nothing to cover).
    delete from public.report_source_items where client_id = v_client_id;

    -- ---- briefs (brief_attachments cascades automatically) ----
    delete from public.briefs where client_id = v_client_id;

    -- ---- every remaining leaf table referencing this client ----
    delete from public.assignments where client_id = v_client_id;
    delete from public.client_contracts where client_id = v_client_id;
    delete from public.client_portal_users where client_id = v_client_id;
    delete from public.meetings where client_id = v_client_id;
    delete from public.social_insights where client_id = v_client_id;
    delete from public.analytics_insights where client_id = v_client_id;
    delete from public.platform_connections where client_id = v_client_id;
    delete from public.client_comparisons where client_id = v_client_id;
    delete from public.daily_logs where client_id = v_client_id;
    delete from public.seo_insights where client_id = v_client_id;
    delete from public.media_buying_insights where client_id = v_client_id;
    delete from public.client_lifecycle_periods where client_id = v_client_id;
    delete from public.client_renewal_events where client_id = v_client_id;
    delete from public.client_access_attachments where client_id = v_client_id;

    v_all_client_ids := v_all_client_ids || v_client_id;
  end loop;

  if array_length(v_all_client_ids, 1) is null then
    return jsonb_build_object(
      'requested_count', array_length(p_client_ids, 1),
      'deleted_client_ids', '[]'::jsonb,
      'total_deleted_count', 0
    );
  end if;

  delete from public.clients where id = any(v_all_client_ids);
  get diagnostics v_deleted_count = row_count;

  return jsonb_build_object(
    'requested_count', array_length(p_client_ids, 1),
    'deleted_client_ids', to_jsonb(v_all_client_ids),
    'total_deleted_count', v_deleted_count
  );
end;
$$;

revoke all on function public.delete_clients(text[]) from public, anon;
grant execute on function public.delete_clients(text[]) to authenticated, service_role;

commit;
