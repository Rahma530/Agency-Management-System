-- Rollback for 20261215200000_extra_notes_edit_own.sql — removes the update/delete grants and
-- policies, restoring extra_notes to select/insert-only.
begin;

drop policy if exists extra_notes_update_own_rls on public.extra_notes;
drop policy if exists extra_notes_delete_own_rls on public.extra_notes;

revoke update, delete on public.extra_notes from authenticated;

commit;
