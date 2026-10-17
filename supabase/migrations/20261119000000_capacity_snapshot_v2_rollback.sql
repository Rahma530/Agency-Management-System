-- ROLLBACK for 20261119000000_capacity_snapshot_v2.sql.
--
-- create or replace back to the exact live/repo v1 body (supabase/migrations/
-- 20261105000000_task_assignees_rpcs.sql:532-569) — confirmed identical to the live production
-- definition during this audit, so this is a faithful restore, not a guess. Grants/signature are
-- unchanged either way, so only the function body needs restoring.
begin;

create or replace function public.get_capacity_snapshot(p_user_ids text[])
returns table(user_id text, used_capacity integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public.app_user_role() = 'sales' then
    raise exception 'sales may not query capacity data.';
  end if;

  return query
    select
      u.id,
      (case
        when u.role in ('am_agent', 'am_team_lead') then (
          select count(*)::integer
          from public.clients c
          where c.am_agent_id = u.id
            and c.status <> 'closed'
            and c.status <> 'paused'
        )
        else (
          select count(*)::integer
          from public.task_assignees ta
          join public.tasks t on t.id = ta.task_id
          where ta.user_id = u.id
            and t.status not in ('completed', 'closed')
        )
      end)
    from public.users u
    where u.id = any(coalesce(p_user_ids, array[]::text[]));
end;
$$;

commit;
