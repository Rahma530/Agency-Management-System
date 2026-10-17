-- get_capacity_snapshot(p_user_ids) v2 — fixes three confirmed bugs in the live/repo definition
-- (identical in both; re-confirmed against the live definition during this audit, no drift):
--   1. The non-AM branch counted ALL non-done tasks (status not in ('completed','closed')),
--      which wrongly includes in_review as workload — in_review is delivered, waiting on the
--      client, not open work (see isTaskWorkloadOpen(), src/lib/employeeWork.ts, and
--      20261112000000_in_review_not_workload.sql, the SQL-side precedent for this exact rule).
--   2. The non-AM branch counted TASKS, not DISTINCT CLIENTS, and only via task_assignees —
--      missing public.assignments entirely, which is how a service-level agent (seo_agent,
--      media_buying_agent, social_media_agent, etc.) is actually linked to a client for their
--      service, independently of whether they currently have an open task on it (precedent:
--      20261107300000_report_workspace_lifecycle_hardening.sql:78 joins assignments the same way).
--   3. No branch at all for the 3 creative roles (graphic_designer, video_editor, ui_designer —
--      see note below), who should be measured by today's delivered task count against
--      daily_task_target, not by a client or task count.
--
-- Confirmed facts (not assumed):
--   - public.assignments columns: id, client_id, service_type, team_lead_id, agent_id,
--     assigned_at, reason_notes, viewed_at (20260928100000_canonical_schema_v4.sql:333-345,
--     unchanged since). NO status column and NO expiry/end-date column — there is nothing on
--     this table itself to filter by for "active"; the only active/inactive signal available is
--     the joined client's own clients.status (excluded here: 'closed', 'paused', same as the v1
--     AM branch already did).
--   - The real, live role value for this app's UI/UX design employees is 'ui_designer', NOT
--     'ui_ux_designer' — confirmed by the user against production data. 'ui_ux_designer' is the
--     value baked into this repo's own UserRole TS union and used in ~15 other TS/SQL files
--     (capacity.ts's DAILY_WORK_CREATIVE_ROLES among them) — every one of those is a pre-existing,
--     separate bug (those branches can never match a real row) that is explicitly OUT OF SCOPE
--     for this migration: only this file's own role literal uses the corrected 'ui_designer'.
--   - tasks.status check constraint (20261023000000_task_done_link_and_closed_status.sql, latest
--     definition): ('todo','in_progress','in_review','completed','blocked','closed').
--   - task_assignees membership resolution mirrors resolveTaskAssigneeIds()
--     (src/lib/taskLifecycle.ts): if a task has ANY task_assignees row, only those rows count —
--     the legacy tasks.assigned_to column is consulted ONLY when a task has zero task_assignees
--     rows at all. Reproduced here via the two EXISTS/NOT EXISTS checks in both branches below,
--     rather than a plain OR, so a task that HAS been migrated to task_assignees never also
--     double-matches via its (possibly stale) legacy assigned_to value.
--   - "Today" for the creative branch's delivered-count is Africa/Cairo's calendar day, the same
--     authority get_server_today()/countDeliveredToday() (src/lib/employeeWork.ts) already use —
--     not UTC, not the caller's session timezone.
--
-- The 4 team-lead roles (am_team_lead, media_buying_team_lead, seo_team_lead,
-- social_media_team_lead) get NO separate branch here: per the owner's explicit decision, they
-- are measured by the exact same distinct-active-clients formula as every other non-creative
-- role (the "else" branch below) — only the UI layer treats their number as informational and
-- ignores users.capacity_limit for them (unchanged scope, not part of this RPC).
--
-- Signature, STABLE/SECURITY DEFINER/search_path, and the sales exception are byte-identical to
-- the live/repo v1 definition — only the body's CASE changes.
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
        when u.role in ('graphic_designer', 'video_editor', 'ui_designer') then (
          select count(*)::integer
          from public.tasks t
          where t.delivered_at is not null
            and (t.delivered_at at time zone 'Africa/Cairo')::date = (now() at time zone 'Africa/Cairo')::date
            and (
              exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = u.id)
              or (
                not exists (select 1 from public.task_assignees ta where ta.task_id = t.id)
                and t.assigned_to = u.id
              )
            )
        )
        else (
          select count(distinct c.id)::integer
          from public.clients c
          where c.status not in ('closed', 'paused')
            and (
              c.am_agent_id = u.id
              or exists (
                select 1 from public.assignments a
                where a.client_id = c.id and a.agent_id = u.id
              )
              or exists (
                select 1 from public.tasks t
                where t.client_id = c.id
                  and t.status in ('todo', 'in_progress', 'blocked')
                  and (
                    exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = u.id)
                    or (
                      not exists (select 1 from public.task_assignees ta where ta.task_id = t.id)
                      and t.assigned_to = u.id
                    )
                  )
              )
            )
        )
      end)
    from public.users u
    where u.id = any(coalesce(p_user_ids, array[]::text[]));
end;
$$;

revoke all on function public.get_capacity_snapshot(text[]) from public, anon;
grant execute on function public.get_capacity_snapshot(text[]) to authenticated, service_role;

commit;
