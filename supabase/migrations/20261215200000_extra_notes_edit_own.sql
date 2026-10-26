-- Let an employee edit or delete their own Extra Effort note (extra_notes). Previously there was
-- only select/insert — once saved, an extra_notes row could never be corrected or removed, unlike
-- daily_logs which already got this exact same treatment in 20261101200000_daily_logs_edit_own.sql.
-- Mirrors that migration's shape precisely: self-only, and only within a 7-day window of
-- creation, so stale initiative write-ups can't be silently rewritten or erased long after the
-- fact. date/note_text/category are the only columns an employee may change — user_id and
-- created_at stay immutable.
begin;

revoke update, delete on public.extra_notes from authenticated;
grant update (date, note_text, category) on public.extra_notes to authenticated;
grant delete on public.extra_notes to authenticated;

drop policy if exists extra_notes_update_own_rls on public.extra_notes;
create policy extra_notes_update_own_rls on public.extra_notes for update to authenticated
using (user_id = public.app_user_id() and created_at > now() - interval '7 days')
with check (user_id = public.app_user_id());

drop policy if exists extra_notes_delete_own_rls on public.extra_notes;
create policy extra_notes_delete_own_rls on public.extra_notes for delete to authenticated
using (user_id = public.app_user_id() and created_at > now() - interval '7 days');

commit;
