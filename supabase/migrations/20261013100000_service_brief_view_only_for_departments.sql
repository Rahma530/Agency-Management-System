-- Service Brief content (the actual filled-in answers — Target Website URL, Target Keywords,
-- CMS Platform, etc.) becomes view-only for the SEO/Media Buying/Social Media department team
-- leads and agents who were previously able to edit their own department's brief
-- (briefs_update_rls/briefs_write_rls's "final brief-editing decision" branches, mirrored by
-- lib/permissions.ts's canEditServiceBrief before this change). Editing stays with
-- executive/head_of_technical/am_team_lead/am_agent (own assigned client) only — the same four
-- roles canEditServiceBrief now enforces at the app level. graphic_designer/video_editor's
-- 'creative' service_type branch is untouched — out of scope for this change.
begin;

drop policy "briefs_update_rls" on public.briefs;

create policy "briefs_update_rls" on public.briefs
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

drop policy "briefs_write_rls" on public.briefs;

create policy "briefs_write_rls" on public.briefs
for insert to authenticated
with check (
  submitted_by = public.app_user_id()
  and (
    (public.app_user_role() = 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

-- briefs_mark_viewed_rls granted seo_team_lead/media_buying_team_lead/social_media_team_lead a
-- direct UPDATE on their own department's briefs, intended only to clear team_lead_viewed_at when
-- they open a brief. RLS is row-level, not column-level — that policy's WITH CHECK never actually
-- restricted which columns changed, so as long as it existed, those three roles could still write
-- `fields` directly (e.g. via the API, bypassing the UI) even after the policy narrowing above.
-- Replaced with a SECURITY DEFINER RPC scoped to touch only team_lead_viewed_at, mirroring
-- update_client_access()'s pattern (client_access_am_agent_write.sql) for the same reason: grant
-- exactly the one column these roles need, nothing else.
drop policy "briefs_mark_viewed_rls" on public.briefs;

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

  update public.briefs
  set team_lead_viewed_at = now()
  where id = p_brief_id
  returning * into v_brief;

  return v_brief;
end;
$$;

grant execute on function public.mark_brief_viewed(text) to authenticated;

commit;
