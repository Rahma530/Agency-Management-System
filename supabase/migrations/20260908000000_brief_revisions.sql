-- ============================================================================
-- Brief Management Phase 3: revision history, "seen" tracking, and an RLS
-- write-policy fix for briefs.
-- ============================================================================
--
-- 0. FIX: briefs_write_rls / briefs_update_rls previously only granted the
--    owning service team (SEO/Media Buying/Social Media leads & agents, plus
--    Creative) insert/update rights on public.briefs — am_agent/am_team_lead
--    were excluded, with a comment claiming "AM never submits/edits a brief,
--    only the owning service team does". That has since been superseded: the
--    app's Brief Management spec explicitly has the AM Agent fill out the
--    brief from the client meeting (am_team_lead as department oversight/
--    fallback) — see src/components/ClientDashboard.tsx's canEditBrief. This
--    migration brings the two policies in line with that, purely additively
--    (nothing granted to the service teams before is removed).
--
-- 1. brief_revisions — NEW table (doesn't exist in the live database yet).
--    Append-only audit log: one full field snapshot per brief save (including
--    the very first, version 1), written by src/App.tsx's handleSaveBrief
--    alongside every briefs insert/update. No UPDATE or DELETE policy is
--    defined below — an audit log should be immutable once written.
--
-- 2. briefs.team_lead_viewed_at — new column. Cleared to null on every save
--    (including re-saves, not just creation — a materially edited brief
--    should re-flag as unread), set when the relevant service Team Lead
--    (seo/media_buying/social_media — no team-lead role exists yet for
--    'creative', so it's simply never set for those rows) views the brief.
--    Unlike clients.am_team_lead_viewed_at (scoped to one specific assigned
--    individual via am_team_lead_id), this is shared per-role: there's no
--    "assigned service team lead" concept per client in this schema.
--    A new briefs_mark_viewed_rls policy lets that Team Lead update just this
--    column without satisfying briefs_update_rls's submitted_by = caller
--    check, which is about content authorship, not read acknowledgement —
--    it grants no new row visibility/authority, only a second path to reach
--    rows that policy already lets them fully edit.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. briefs_write_rls / briefs_update_rls — add am_team_lead (any client) and
--    am_agent (only clients where they are the assigned AM), for any
--    service_type, alongside the existing service-team grants.
-- ----------------------------------------------------------------------------
drop policy if exists "briefs_write_rls" on public.briefs;
create policy "briefs_write_rls" on public.briefs
for insert
to authenticated
with check (
  submitted_by = public.app_user_id()
  and (
    (public.app_user_role() = 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

drop policy if exists "briefs_update_rls" on public.briefs;
create policy "briefs_update_rls" on public.briefs
for update
to authenticated
using (
  (public.app_user_role() = 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
)
with check (
  submitted_by = public.app_user_id()
);

-- ----------------------------------------------------------------------------
-- 2. briefs.team_lead_viewed_at + the narrow "mark viewed" policy.
-- ----------------------------------------------------------------------------
alter table public.briefs add column if not exists team_lead_viewed_at timestamptz;

create policy "briefs_mark_viewed_rls" on public.briefs
for update
to authenticated
using (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
)
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

-- ----------------------------------------------------------------------------
-- 1. brief_revisions
-- ----------------------------------------------------------------------------
create table if not exists public.brief_revisions (
  id text primary key,
  brief_id text not null,
  client_id text not null,
  service_type text not null,
  version integer not null,
  fields jsonb not null default '{}'::jsonb,
  edited_by text not null,
  edited_at timestamptz not null default now()
);

-- No delete, no update — see header. Mirrors the "select, insert, update on
-- briefs" grant pattern from 20260907090000_table_grants.sql, minus update.
grant select, insert on public.brief_revisions to authenticated;

alter table public.brief_revisions enable row level security;

-- Mirrors briefs_select_rls exactly, reading this table's own denormalized
-- client_id/service_type columns instead of joining through briefs.
create policy "brief_revisions_select_rls" on public.brief_revisions
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and edited_by = public.app_user_id())
);

-- Mirrors the (now-fixed) briefs_write_rls / briefs_update_rls conditions:
-- whoever may author or edit a brief for this client+service may also write
-- its revision snapshot.
create policy "brief_revisions_insert_rls" on public.brief_revisions
for insert
to authenticated
with check (
  edited_by = public.app_user_id()
  and (
    (public.app_user_role() = 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

-- ----------------------------------------------------------------------------
-- Recommended indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_brief_revisions_brief_id on public.brief_revisions (brief_id);
create index if not exists idx_brief_revisions_client_service on public.brief_revisions (client_id, service_type);

commit;
