-- Replaces the heartbeat's direct `update public.users set last_seen_at = ...` with a narrow RPC.
--
-- Confirmed root cause (prior audit): the only UPDATE policies on public.users
-- (users_update_capacity_rls/users_update_profile_rls/users_deactivate_rls) all require the
-- caller's role to be in the 7-role set (executive/head_of_technical/ai_engineer/the 4 team
-- leads), even for a caller updating their OWN row. A regular agent-level role (am_agent,
-- seo_agent, media_buying_agent, social_media_agent, programming_agent, seo_content_agent,
-- seo_backlink_agent, graphic_designer, video_editor, sales, marketing_manager) has no matching
-- UPDATE policy at all, so their own heartbeat write silently affects 0 rows — RLS doesn't error,
-- it just excludes the row — and the heartbeat code never inspected the response to notice.
-- touch_last_seen() is SECURITY DEFINER specifically to bypass that gap: Postgres RLS does not
-- apply to a table's owner by default (this schema never ran `FORCE ROW LEVEL SECURITY`), so a
-- SECURITY DEFINER function owned by that same role writes successfully regardless of the
-- caller's row-level UPDATE rights — the same pattern already used throughout this schema
-- (app_user_id()/app_user_role()/employee_visible(), etc.) to avoid RLS recursion/gaps.
--
-- Confirmed compatible with users_update_guard_trigger (20261030000000_users_update_guard_trigger.sql):
-- that BEFORE UPDATE trigger still fires here (SECURITY DEFINER changes execution privilege, not
-- whether table-level triggers run), but every one of its rules is a no-op for this specific
-- UPDATE: id/auth_id/password are untouched (rule 1 passes), the row being updated IS the caller's
-- own (old.id = app_user_id()), but role/team/manager_id are untouched too (rule 2's self-restriction
-- has nothing to block), and rules 3/4 only trigger on a role/team/manager_id change, none of which
-- this statement makes. The trigger and this RPC were audited together on purpose; this comment
-- records that check rather than leaving it to be rediscovered.
--
-- No parameters: the function can only ever update the CALLING user's own row (id = app_user_id()),
-- by construction — there is no column a caller could pass to target anyone else's row.
begin;

-- Documents the live column (confirmed type: timestamp with time zone, nullable) in version
-- control for the first time — it was never captured in any prior migration (confirmed via a full
-- grep of every create/alter table statement in supabase/migrations/). `if not exists` makes this
-- a no-op against the live database, which already has it; this is purely so a fresh/future
-- database created from this migration history ends up with the same column.
alter table public.users add column if not exists last_seen_at timestamptz;

create or replace function public.touch_last_seen()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.users set last_seen_at = now()
  where id = public.app_user_id();
$$;

revoke execute on function public.touch_last_seen() from public;
revoke execute on function public.touch_last_seen() from anon;
grant execute on function public.touch_last_seen() to authenticated;
grant execute on function public.touch_last_seen() to service_role;

commit;
