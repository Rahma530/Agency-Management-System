begin;

revoke update, delete on public.daily_logs from authenticated;
grant update (date, summary_text, linked_task_ids, client_id) on public.daily_logs to authenticated;
grant delete on public.daily_logs to authenticated;

drop policy if exists daily_logs_update_own_rls on public.daily_logs;
create policy daily_logs_update_own_rls on public.daily_logs for update to authenticated
using (user_id = public.app_user_id() and created_at > now() - interval '7 days')
with check (user_id = public.app_user_id());

drop policy if exists daily_logs_delete_own_rls on public.daily_logs;
create policy daily_logs_delete_own_rls on public.daily_logs for delete to authenticated
using (user_id = public.app_user_id() and created_at > now() - interval '7 days');

commit;
