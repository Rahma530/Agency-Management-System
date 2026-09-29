-- Restore exact authorization parity between head_of_technical and ai_engineer after later
-- migrations introduced two inverse differences:
--   1. tasks_update_rls allowed head_of_technical, but not ai_engineer, to close any visible task;
--   2. mark_brief_viewed granted ai_engineer an RPC that head_of_technical does not have.
-- Preserve Head of Technical behavior: add AI Engineer to the close override and remove the
-- AI-only mark-brief-viewed exception, leaving that RPC scoped to the relevant service team lead.
begin;

drop policy if exists "tasks_update_rls" on public.tasks;
create policy "tasks_update_rls" on public.tasks
for update to authenticated
using (public.task_visible(assigned_to, parent_task_id, client_id))
with check (
  public.task_visible(assigned_to, parent_task_id, client_id)
  and (
    status <> 'closed'
    or created_by = public.app_user_id()
    or assigned_to = public.app_user_id()
    or public.app_user_role() in ('head_of_technical', 'ai_engineer')
  )
);

create or replace function public.mark_brief_viewed(p_brief_id text)
returns public.briefs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_brief public.briefs;
begin
  select * into v_brief from public.briefs where id = p_brief_id;
  if not found then
    raise exception 'Brief not found';
  end if;
  if not (
    (public.app_user_role() = 'seo_team_lead' and v_brief.service_type = 'seo' and public.client_has_service(v_brief.client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and v_brief.service_type = 'media_buying' and public.client_has_service(v_brief.client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and v_brief.service_type = 'social_media' and public.client_has_service(v_brief.client_id, 'social_media'))
  ) then
    raise exception 'You do not have permission to mark this brief as viewed.';
  end if;
  update public.briefs set team_lead_viewed_at = now()
  where id = p_brief_id returning * into v_brief;
  return v_brief;
end;
$$;

commit;
