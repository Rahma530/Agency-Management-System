-- Rollback for 20261210000000_media_buying_insights_admin_emergency_write.sql
-- Restores the original insert/update policies (media_buying_team_lead only, among the
-- non-own-client-scoped roles) — executive and head_of_technical lose write access again.
begin;

drop policy if exists "media_buying_insights_write_rls" on public.media_buying_insights;
create policy "media_buying_insights_write_rls" on public.media_buying_insights
for insert to authenticated
with check (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

drop policy if exists "media_buying_insights_update_rls" on public.media_buying_insights;
create policy "media_buying_insights_update_rls" on public.media_buying_insights
for update to authenticated
using (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

commit;
