-- Fix delete_clients() double-counting a subtask in deletion_log.related_counts.tasks.
--
-- Bug: the task-subtree CTE used `union all`, with a base case of "every task whose client_id
-- matches" (not "every task whose id is in a specific requested set", unlike delete_tasks()'s own
-- version of this CTE). Since a subtask's row ALSO carries the client's own client_id (same
-- convention as its parent — every task row, parent or child, has client_id set), it satisfied
-- BOTH the base case (client_id = v_client_id) AND the recursive join (parent_task_id = parent's
-- id already in subtree) — so `union all` kept both copies, inflating the count by one per level
-- of subtask nesting. Reported directly by the owner running the verification script: a 1-parent
-- + 1-child fixture logged related_counts.tasks = 3 instead of 2.
--
-- Scope of the bug: cosmetic/audit-only. v_task_ids (used for the actual DELETE statements below
-- it) tolerated the duplicate harmlessly — `delete ... where id = any(array_with_a_repeat)` just
-- deletes the same already-gone row twice, no error, no double-deletion of anything else. Only
-- the count written to deletion_log.related_counts.tasks (and, by the same mechanism,
-- v_reports_count if a report_content_versions-style self-reference ever existed on reports,
-- which it doesn't today) was wrong. Still worth a precise fix: that count is the audit trail an
-- executive/head_of_technical would read back later to confirm what a force-delete actually did.
--
-- Fix: `union` instead of `union all` on the tasks subtree CTE — de-duplicates ids that match
-- more than one branch, with no other behavior change. reports has no self-referencing
-- parent/child column, so its own id lookup was never exposed to this bug and is left as-is.
begin;

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

    -- Full task subtree for this client, any depth. `union` (not `union all`) de-duplicates: a
    -- subtask's row already satisfies the base "client_id = v_client_id" case on its own, so
    -- without de-duplication it would also be picked up a second time by the recursive join.
    with recursive subtree as (
      select t.id from public.tasks t where t.client_id = v_client_id
      union
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

commit;
