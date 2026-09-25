-- Three ownership-only restrictions that currently apply even to leadership (no role escape at
-- all, for anyone, including executive): kpi_scores_update_rls only let the original reviewer
-- correct a score they entered themselves; task_attachments_delete_rls (and its storage mirror)
-- only let the uploader delete their own attachment, the same "uploader only" shape
-- client_contracts_delete_rls used to have before it was widened earlier this session;
-- task_comments_update_rls only let the author edit their own comment. Per the "head_of_technical
-- must have complete, unrestricted access — overriding restrictions that currently apply even to
-- other leadership roles" rule, add an unconditional executive/head_of_technical/ai_engineer
-- bypass to each, on top of the existing ownership condition, which stays unchanged for everyone
-- else.
begin;

drop policy if exists "kpi_scores_update_rls" on public.kpi_scores;
create policy "kpi_scores_update_rls" on public.kpi_scores
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or (reviewed_by = public.app_user_id() and public.direct_report_visible(user_id))
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or (reviewed_by = public.app_user_id() and public.direct_report_visible(user_id))
);

drop policy if exists "task_attachments_delete_rls" on public.task_attachments;
create policy "task_attachments_delete_rls" on public.task_attachments
for delete to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or uploaded_by = public.app_user_id()
);

drop policy if exists "task_attachments_objects_delete_rls" on storage.objects;
create policy "task_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'task-attachments'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
    or exists (
      select 1 from public.task_attachments a
      where a.storage_path = storage.objects.name
        and a.uploaded_by = public.app_user_id()
    )
  )
);

drop policy if exists "task_comments_update_rls" on public.task_comments;
create policy "task_comments_update_rls" on public.task_comments
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or author_id = public.app_user_id()
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or author_id = public.app_user_id()
);

commit;
