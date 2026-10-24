-- Media Buyers Mentorship Tracker — step 3: who oversees which media buyer.
--
-- Owner-confirmed: Executive, Head of Technical, and Media Buying Team Leader may each decide,
-- at any time, which media buyer(s) they personally track. Many-to-many (one media buyer can be
-- tracked by more than one of the three; one of the three can track more than one media buyer).
-- No fixed list of media buyers is stored anywhere: "media buyer" means "a user whose current
-- role is media_buying_agent" at the moment a row is written, so a newly hired media buyer is
-- automatically eligible with no schema change.
--
-- ai_engineer is deliberately EXCLUDED from the admin gate below, per
-- 20261124000000_ai_engineer_deprivilege.sql (owner's explicit instruction: ai_engineer lost all
-- admin-equivalent grants across this schema, impersonation excepted). Only executive,
-- head_of_technical and media_buying_team_lead may assign/remove oversight.
begin;

create table public.mentorship_oversight (
  overseer_id text not null references public.users (id),
  media_buyer_id text not null references public.users (id),
  assigned_by text references public.users (id),
  assigned_at timestamptz not null default now(),
  primary key (overseer_id, media_buyer_id)
);

create index idx_mentorship_oversight_media_buyer on public.mentorship_oversight (media_buyer_id);

alter table public.mentorship_oversight enable row level security;

-- Read: the three admin/TL roles see the full map (they need it to coordinate who tracks whom);
-- a media buyer can see who is currently tracking them.
create policy "mentorship_oversight_select_rls" on public.mentorship_oversight
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead')
  or media_buyer_id = public.app_user_id()
);

-- No insert/update/delete policy — every write goes through the two RPCs below (SECURITY
-- DEFINER), same posture as public.task_platform_links / public.task_assignees.
grant select on public.mentorship_oversight to authenticated;
grant all on public.mentorship_oversight to service_role;

-- ----------------------------------------------------------------------------
-- add_mentorship_oversight(p_overseer_id, p_media_buyer_id)
-- ----------------------------------------------------------------------------
create or replace function public.add_mentorship_oversight(p_overseer_id text, p_media_buyer_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.app_user_role() not in ('executive', 'head_of_technical', 'media_buying_team_lead') then
    raise exception 'You do not have permission to assign mentorship oversight.';
  end if;

  if not exists (
    select 1 from public.users
    where id = p_overseer_id and role in ('executive', 'head_of_technical', 'media_buying_team_lead')
  ) then
    raise exception 'Overseer must currently hold an Executive, Head of Technical, or Media Buying Team Leader role.';
  end if;

  if not exists (select 1 from public.users where id = p_media_buyer_id and role = 'media_buying_agent') then
    raise exception 'Target must currently hold the Media Buyer role.';
  end if;

  insert into public.mentorship_oversight (overseer_id, media_buyer_id, assigned_by)
  values (p_overseer_id, p_media_buyer_id, public.app_user_id())
  on conflict (overseer_id, media_buyer_id) do nothing;
end;
$$;

revoke all on function public.add_mentorship_oversight(text, text) from public, anon;
grant execute on function public.add_mentorship_oversight(text, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- remove_mentorship_oversight(p_overseer_id, p_media_buyer_id)
-- ----------------------------------------------------------------------------
create or replace function public.remove_mentorship_oversight(p_overseer_id text, p_media_buyer_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.app_user_role() not in ('executive', 'head_of_technical', 'media_buying_team_lead') then
    raise exception 'You do not have permission to modify mentorship oversight.';
  end if;

  delete from public.mentorship_oversight
  where overseer_id = p_overseer_id and media_buyer_id = p_media_buyer_id;
end;
$$;

revoke all on function public.remove_mentorship_oversight(text, text) from public, anon;
grant execute on function public.remove_mentorship_oversight(text, text) to authenticated, service_role;

commit;
