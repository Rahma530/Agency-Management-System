-- ============================================================================
-- chat_directory(): minimal org-wide employee directory for MiniChat.
-- ============================================================================
--
-- Real-world testing surfaced that MiniChat's colleague list was silently
-- narrowed to whatever employee_visible() (users_select_rls) allows the
-- viewer to see — correct for every other consumer of `users` (Capacity
-- Management, Employee Admin, Reports, etc.), but wrong for chat: the agreed
-- design is that any employee can message any employee, with no role/team
-- scoping at all.
--
-- Rather than loosening users_select_rls itself (which would leak full
-- employee rows — including HR-sensitive columns like capacity_limit,
-- deactivated_at — to everyone), this adds a narrow security definer
-- function that returns ONLY id/name/role for every user. security definer
-- makes it run as the function owner, which bypasses users_select_rls
-- internally — the same mechanism employee_visible()/app_user_id() already
-- rely on — but the function's own column list is the actual boundary: it
-- can never expose anything beyond those 3 columns, however it's called.
-- ============================================================================

begin;

create or replace function public.chat_directory()
returns table(id text, name text, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.name, u.role from public.users u;
$$;

grant execute on function public.chat_directory() to authenticated;

commit;
