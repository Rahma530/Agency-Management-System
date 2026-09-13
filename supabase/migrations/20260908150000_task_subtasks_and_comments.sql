-- ============================================================================
-- Task Board Phase 2/3 (merged): full mini-task subtasks + threaded comments.
-- ============================================================================
--
-- 1. tasks.parent_task_id — NEW self-referencing column. A subtask is an
--    ordinary row in public.tasks (same title/description/assignee/due_date/
--    priority/status/hours fields as any task), just with parent_task_id
--    pointing at its parent. Nesting is capped at 3 levels (task -> subtask
--    -> sub-subtask) by the enforce_nesting_depth trigger below — a 4th
--    level is rejected outright, not just hidden in the UI.
--
-- 2. public.task_visible() — signature change (2nd arg added). A subtask is
--    now visible via EITHER the existing own-assignee rules applied to its
--    own assigned_to, OR by the viewer being able to see its parent task
--    (recursively, up to the 3-level cap). Without this OR, a subtask could
--    be visible to its own assignee while its parent (different assignee,
--    different team) stays invisible to them, or a team lead who can see a
--    parent couldn't see subtasks assigned outside their own team. This is
--    genuine (bounded) recursion — safe specifically because
--    enforce_nesting_depth guarantees the chain is never longer than 3.
--    Mirrors the same recursive change made to isTaskAccessibleUnderRLS() in
--    src/lib/supabase.ts.
--
-- 3. public.task_comments — NEW table. Threaded (parent_comment_id, capped
--    at 3 levels by the same enforce_nesting_depth trigger, reused against
--    this table's own self-reference). Visibility is NOT recursive through
--    the comment's own parent chain — every comment on a task is visible to
--    everyone who can see that task, full stop, regardless of reply depth.
--    RLS policies join to public.tasks by task_id (not a denormalized
--    assigned_to copy) precisely because a task's assigned_to changes after
--    creation (reassignment) — a denormalized copy would silently go stale
--    and misauthorize. Author can edit their own comment (edited_at set)
--    and "delete" it (soft: deleted_at set, folded into the same UPDATE
--    policy) — never a real DELETE, so a comment with replies never
--    orphans them; the UI renders a deleted comment as a placeholder while
--    keeping its replies attached.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. tasks.parent_task_id
-- ----------------------------------------------------------------------------
alter table public.tasks
  add column if not exists parent_task_id text references public.tasks(id);

create index if not exists idx_tasks_parent_task_id on public.tasks (parent_task_id);

-- ----------------------------------------------------------------------------
-- Shared depth-cap enforcement — walks the self-reference chain of whichever
-- table/column it's attached to (tasks.parent_task_id or
-- task_comments.parent_comment_id) and rejects a write that would create a
-- 4th level. TG_ARGV[0] names the parent-reference column to walk.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_nesting_depth()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  parent_col text := TG_ARGV[0];
  depth int := 1;
  current_parent text;
  hops int := 0;
begin
  execute format('select ($1).%I', parent_col) using NEW into current_parent;

  while current_parent is not null loop
    depth := depth + 1;
    hops := hops + 1;
    if hops > 10 then
      raise exception 'Nesting chain too long or cyclic in %', TG_TABLE_NAME;
    end if;

    execute format('select %I from %I.%I where id = $1', parent_col, TG_TABLE_SCHEMA, TG_TABLE_NAME)
      using current_parent into current_parent;
  end loop;

  if depth > 3 then
    raise exception 'Nesting may only go 3 levels deep in %', TG_TABLE_NAME;
  end if;

  return NEW;
end;
$$;

drop trigger if exists tasks_enforce_nesting_depth on public.tasks;
create trigger tasks_enforce_nesting_depth
before insert or update of parent_task_id on public.tasks
for each row
execute function public.enforce_nesting_depth('parent_task_id');

-- ----------------------------------------------------------------------------
-- 2. task_visible() — recursive parent-visibility branch
-- ----------------------------------------------------------------------------
create or replace function public.task_visible(p_assigned_to text, p_parent_task_id text default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.app_user_role() <> 'sales'
    and (
      public.app_user_role() in (
        'executive', 'head_of_technical',
        'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
      )
      or (
        public.app_user_role() in ('graphic_designer', 'video_editor')
        and p_assigned_to = public.app_user_id()
      )
      or (
        public.app_user_role() not in ('graphic_designer', 'video_editor')
        and (
          p_assigned_to = public.app_user_id()
          or exists (
            select 1 from public.users u
            where u.id = p_assigned_to and u.team = public.app_user_team()
          )
        )
      )
      or (
        p_parent_task_id is not null
        and exists (
          select 1 from public.tasks pt
          where pt.id = p_parent_task_id
            and public.task_visible(pt.assigned_to, pt.parent_task_id)
        )
      )
    );
$$;

-- tasks_select_rls / tasks_update_rls / tasks_insert_rls — pass parent_task_id
-- through to task_visible(), and require the parent to be visible when
-- creating a subtask.
drop policy if exists "tasks_select_rls" on public.tasks;
create policy "tasks_select_rls" on public.tasks
for select
to authenticated
using (public.task_visible(assigned_to, parent_task_id));

drop policy if exists "tasks_insert_rls" on public.tasks;
create policy "tasks_insert_rls" on public.tasks
for insert
to authenticated
with check (
  public.app_user_role() <> 'sales'
  and created_by = public.app_user_id()
  and (
    parent_task_id is null
    or exists (
      select 1 from public.tasks pt
      where pt.id = parent_task_id
        and public.task_visible(pt.assigned_to, pt.parent_task_id)
    )
  )
);

drop policy if exists "tasks_update_rls" on public.tasks;
create policy "tasks_update_rls" on public.tasks
for update
to authenticated
using (public.task_visible(assigned_to, parent_task_id))
with check (public.task_visible(assigned_to, parent_task_id));

-- ----------------------------------------------------------------------------
-- 3. task_comments
-- ----------------------------------------------------------------------------
create table if not exists public.task_comments (
  id text primary key,
  task_id text not null references public.tasks(id),
  parent_comment_id text references public.task_comments(id),
  author_id text not null,
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

grant select, insert, update on public.task_comments to authenticated;

alter table public.task_comments enable row level security;

drop trigger if exists task_comments_enforce_nesting_depth on public.task_comments;
create trigger task_comments_enforce_nesting_depth
before insert or update of parent_comment_id on public.task_comments
for each row
execute function public.enforce_nesting_depth('parent_comment_id');

-- Visible to whoever can see the parent task — not recursive through the
-- comment's own reply chain, every comment/reply on a visible task is
-- visible, full stop.
create policy "task_comments_select_rls" on public.task_comments
for select
to authenticated
using (
  exists (
    select 1 from public.tasks t
    where t.id = task_comments.task_id
      and public.task_visible(t.assigned_to, t.parent_task_id)
  )
);

create policy "task_comments_insert_rls" on public.task_comments
for insert
to authenticated
with check (
  author_id = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and public.task_visible(t.assigned_to, t.parent_task_id)
  )
);

-- Author-only. Covers both real edits (edited_at set) and soft-deletes
-- (deleted_at set) — there is no DELETE policy, deletion is always this
-- UPDATE path so a comment's replies never orphan.
create policy "task_comments_update_rls" on public.task_comments
for update
to authenticated
using (author_id = public.app_user_id())
with check (author_id = public.app_user_id());

-- ----------------------------------------------------------------------------
-- Recommended indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_task_comments_task_id on public.task_comments (task_id);
create index if not exists idx_task_comments_parent_comment_id on public.task_comments (parent_comment_id);

commit;
