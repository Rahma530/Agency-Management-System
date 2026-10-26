-- Rollback for 20261215100000_client_full_delete_fix_duplicate_subtree.sql — restores
-- delete_clients() to its prior definition (20261215000000_client_full_delete.sql's original
-- `union all` subtree CTE). Only use this to deliberately go back to the known-buggy
-- (duplicate-counting) version; there is no reason to run this other than reverting the fix.
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
      continue;
    end if;

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

    if v_task_ids is not null then
      delete from public.task_comments where task_id = any(v_task_ids);
      delete from public.task_attachments where task_id = any(v_task_ids);
      delete from public.task_assignee_log where task_id = any(v_task_ids);
      delete from public.tasks where id = any(v_task_ids);
    end if;

    if v_report_ids is not null then
      delete from public.report_ai_suggestions where report_id = any(v_report_ids);
      delete from public.report_audit_events where report_id = any(v_report_ids);
      delete from public.report_source_items where report_id = any(v_report_ids);
      delete from public.report_content_versions where report_id = any(v_report_ids);
      delete from public.reports where id = any(v_report_ids);
    end if;
    delete from public.report_source_items where client_id = v_client_id;

    delete from public.briefs where client_id = v_client_id;

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
