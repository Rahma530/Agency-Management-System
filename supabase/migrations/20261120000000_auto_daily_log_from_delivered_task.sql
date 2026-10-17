-- Auto-create a daily_logs row when a task is delivered (status transitions into
-- in_review/completed from anything else), for every current assignee — so a delivered task is
-- "evidence" for reportDraftSources.ts/report_source_manifest_v2 even when nobody manually links
-- it to a daily log.
--
-- Live-DB check performed before writing this (per explicit instruction, not assumed from the
-- repo): public.daily_logs today carries ONLY these 4 RLS policies and ZERO triggers —
--   daily_logs_select_rls: direct_report_visible(user_id) OR (client_id is not null AND
--     (app_user_role() in (executive, head_of_technical, ai_engineer, am_team_lead) OR
--      (app_user_role()='am_agent' AND client_am_agent_is_caller(client_id))))
--   daily_logs_insert_self_rls: INSERT with_check(user_id = app_user_id())
--   daily_logs_update_own_rls: UPDATE using(user_id = app_user_id() AND created_at > now() - 7d)
--     with_check(user_id = app_user_id())
--   daily_logs_delete_own_rls: DELETE using(user_id = app_user_id() AND created_at > now() - 7d)
-- No new policy is added here: the trigger is SECURITY DEFINER and bypasses RLS on its own INSERT
-- (same posture as every other SECURITY DEFINER trigger/RPC in this schema), and an
-- auto-inserted row is owned by (user_id = the assignee) exactly like a manual row, so it is
-- immediately visible/editable/deletable by that assignee under the EXISTING policies above with
-- no change to any of them — direct_report_visible()/am_agent scoping for everyone else also
-- applies unchanged, since it's the same daily_logs row shape.
begin;

alter table public.daily_logs
  add column if not exists task_id text null references public.tasks (id),
  add column if not exists source text not null default 'manual';

alter table public.daily_logs
  drop constraint if exists daily_logs_source_check;
alter table public.daily_logs
  add constraint daily_logs_source_check check (source in ('manual', 'auto_task'));

-- One auto row per (task, assignee, day): lets a revision re-delivered on a LATER day create a
-- new row (different `date`), while a same-day re-fire (e.g. a redundant status write) or the
-- trigger running twice for the same delivery is a no-op via ON CONFLICT DO NOTHING below. Only
-- auto_task rows are ever inserted with a non-null task_id by this trigger, but the index itself
-- is keyed on task_id being non-null, not on source, so it also guards a manual row that happens
-- to carry the same task_id/user_id/date (the "never show a task twice" dedupe asked for in step
-- 3 reads this same (task_id, user_id, date) shape, independent of source).
create unique index if not exists idx_daily_logs_task_user_date
  on public.daily_logs (task_id, user_id, date)
  where task_id is not null;

-- Trigger function. AFTER UPDATE (not BEFORE, unlike track_delivery_and_revisions in
-- 20261112000000_in_review_not_workload.sql) because it performs a real INSERT into a different
-- table and must see the final, committed NEW row — a BEFORE trigger's NEW is still subject to
-- later BEFORE triggers/column restores on tasks (e.g. track_delivery_and_revisions itself) and
-- firing order between two BEFORE triggers on the same table is not guaranteed by Postgres.
--
-- Condition: new.status in ('in_review','completed') and old.status not in ('in_review',
-- 'completed') — the SAME delivered-status set track_delivery_and_revisions() uses for its own
-- delivered_at stamp, but deliberately WITHOUT that function's one-time "old.delivered_at is
-- null" gate: delivered_at is set once, ever, but this trigger must fire again on every later
-- re-delivery after a revision (a new old.status transition back into the delivered set), so a
-- revision reviewed on a different calendar day creates its own new daily_logs row. Reading
-- old.status (not old.delivered_at) also means in_review -> completed never re-fires: old.status
-- ('in_review') is already in the delivered set, so the "old.status not in (...)" half is false.
--
-- Wrapped in its own BEGIN/EXCEPTION so a failure in the INSERT (duplicate id collision, an
-- unexpected constraint, anything) can never fail the triggering UPDATE itself — only a WARNING
-- is raised. SECURITY DEFINER + search_path pinned, matching every other SECURITY DEFINER
-- trigger/RPC in this schema.
create or replace function public.auto_daily_log_from_delivered_task()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignee_ids text[];
  v_today date;
  v_summary text;
begin
  if new.status in ('in_review', 'completed') and old.status not in ('in_review', 'completed') then
    begin
      select array_agg(distinct ta.user_id) into v_assignee_ids
      from public.task_assignees ta
      where ta.task_id = new.id;

      if v_assignee_ids is null then
        if new.assigned_to is not null then
          v_assignee_ids := array[new.assigned_to];
        else
          v_assignee_ids := array[]::text[];
        end if;
      end if;

      v_today := (now() at time zone 'Africa/Cairo')::date;
      v_summary := new.title || E'\n' || new.description;

      insert into public.daily_logs (id, user_id, date, summary_text, linked_task_ids, client_id, task_id, source)
      select
        'dlog-' || replace(gen_random_uuid()::text, '-', ''),
        assignee_id,
        v_today,
        v_summary,
        array[new.id],
        new.client_id,
        new.id,
        'auto_task'
      from unnest(v_assignee_ids) as assignee_id
      on conflict (task_id, user_id, date) where task_id is not null do nothing;
    exception when others then
      raise warning 'auto_daily_log_from_delivered_task: skipped auto daily_logs insert for task % (%).', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.auto_daily_log_from_delivered_task() from public, anon, authenticated;

drop trigger if exists tasks_auto_daily_log_from_delivered_trigger on public.tasks;
create trigger tasks_auto_daily_log_from_delivered_trigger
after update of status on public.tasks
for each row
execute function public.auto_daily_log_from_delivered_task();

commit;
