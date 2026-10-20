-- Rollback for 20261123000000_daily_logs_department_team_lead_visibility.sql.
--
-- Restores public.daily_logs_select_rls to the exact definition from
-- 20261028100000_daily_logs_report_scope_visibility.sql: removes the three new department-scoped
-- branches (media_buying_team_lead/seo_team_lead/social_media_team_lead), leaving
-- direct_report_visible(user_id) and the unconditional executive/head_of_technical/ai_engineer/
-- am_team_lead/am_agent branch exactly as they were before.
begin;

drop policy if exists "daily_logs_select_rls" on public.daily_logs;
create policy "daily_logs_select_rls" on public.daily_logs
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or (client_id is not null and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  ))
);

commit;
