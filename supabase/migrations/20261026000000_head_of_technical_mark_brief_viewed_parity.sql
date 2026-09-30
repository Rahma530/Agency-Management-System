-- mark_brief_viewed() currently grants ai_engineer an unconditional bypass (skips the
-- service/client-scoped team-lead check entirely) that head_of_technical does not have — the two
-- roles are meant to carry equivalent access everywhere in this app (see
-- 20261018000000_align_ai_engineer_with_head_of_technical.sql), so this is a gap, not a deliberate
-- distinction. Standing principle for this pair of roles: when they diverge on any permission, the
-- fix is always to grant the wider access to whichever one is missing it, never to narrow the
-- other one down. Adds head_of_technical to the same standalone bypass ai_engineer already has,
-- rather than folding it into the team-lead-scoped branch below it.
begin;

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
    public.app_user_role() in ('ai_engineer', 'head_of_technical')
    or (public.app_user_role() = 'seo_team_lead' and v_brief.service_type = 'seo' and public.client_has_service(v_brief.client_id, 'seo'))
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
