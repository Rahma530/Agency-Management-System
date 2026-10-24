-- Owner-requested: "عايزة افتح تسجيل البيانات لل 4 أدوار مش بس ال media buyer تحسبا لأي ظرف
-- اضطراري" — all 4 roles that can see the Mentorship Tracker (Executive, Head of Technical,
-- Media Buying Team Lead, Media Buyer) should be able to log monthly data as an emergency
-- fallback, not just the assigned media buyer.
--
-- Audit of 20261030600000_document_media_buying_insights.sql's write policy found this already
-- half-true: media_buying_team_lead can already insert/update ANY client's rows (no client
-- restriction in its branch of the policy) — only executive and head_of_technical were missing
-- from the insert/update policies entirely, despite both already having unrestricted SELECT on
-- this table. This migration adds them to the insert/update policies, scoped to ANY client (same
-- as media_buying_team_lead already has), matching the emergency-fallback intent — not scoped to
-- "their own oversight list" (mentorship_oversight), since the whole point is covering a client
-- even when nobody with an existing relationship to it is available.
--
-- media_buying_agent and am_agent keep their existing own-client-only scoping — unchanged.
begin;

drop policy if exists "media_buying_insights_write_rls" on public.media_buying_insights;
create policy "media_buying_insights_write_rls" on public.media_buying_insights
for insert to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead')
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

drop policy if exists "media_buying_insights_update_rls" on public.media_buying_insights;
create policy "media_buying_insights_update_rls" on public.media_buying_insights
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead')
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'media_buying_team_lead')
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

commit;
