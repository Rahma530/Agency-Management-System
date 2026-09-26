-- Task Board: "Closed" lifecycle stage + "Done Link" field.
--
-- done_link is a NEW, dedicated column — deliberately not a reuse of the existing drive_link
-- column, which has different, always-visible-regardless-of-status semantics used by existing
-- tasks as a general reference link. done_link is specifically the assignee's link to their
-- finished work, submitted once a task reaches 'completed', for the creator/assignee/
-- head_of_technical to review before manually closing the task (see canCloseTask() in
-- src/lib/taskLifecycle.ts — enforced today at the UI layer only, not by RLS; see that file's
-- comment and this session's own decision on that tradeoff).
--
-- 'closed' is a new tasks.status value: a manual confirmation step after 'completed', not a
-- distinct kind of done — see isTaskDone() in src/lib/taskLifecycle.ts, which treats the two as
-- functionally identical for every downstream calculation.
begin;

alter table public.tasks add column done_link text;

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('todo', 'in_progress', 'in_review', 'completed', 'blocked', 'closed'));

commit;
