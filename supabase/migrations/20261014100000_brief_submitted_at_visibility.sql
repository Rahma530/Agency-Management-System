-- Brief visibility gated by explicit AM submission.
--
-- Until now, `briefs` had no draft/submitted concept: the AM's very first "Save as New
-- Version" click already persisted the row, and briefs_select_rls granted every department
-- team lead/agent read access to it purely by service/assignment, with no timing gate at all —
-- a half-filled brief was fully visible the moment it existed. `submitted_at` (mirroring the
-- existing team_lead_viewed_at column's nullable-timestamp shape) is the new explicit signal:
-- null = still an AM-only draft, non-null = the AM deliberately published it via the app's new
-- Submit/Publish action. AM/leadership's own read access is unaffected — they author the draft,
-- so there's nothing to gate for them; only the department team-lead/agent branches below gain
-- the new "and submitted_at is not null" condition, layered on top of their existing
-- service/assignment scoping exactly as before (see the earlier session's
-- service_brief_view_only_for_departments.sql for that scoping's own history). This is a timing
-- gate only, not a narrowing of which briefs a role can see — a department role still sees every
-- active service's brief for a client it's authorized on, once each is submitted.
begin;

alter table public.briefs add column if not exists submitted_at timestamptz;

-- One-time backfill: every brief row that already existed before this migration was already
-- effectively "public" under the old model (any department role with service/assignment access
-- could already see it in full, draft or not) — some of those clients' agents are actively
-- executing against that content today. Without this backfill, the new "and submitted_at is not
-- null" condition below would instantly and silently revoke read access to every already-shared
-- brief. Only brand-new saves going forward start life as a real (invisible) draft.
update public.briefs set submitted_at = coalesce(updated_at, created_at) where submitted_at is null;

drop policy "briefs_select_rls" on public.briefs;

create policy "briefs_select_rls" on public.briefs
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and submitted_at is not null)
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and submitted_at is not null)
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id) and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

commit;
