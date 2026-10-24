-- Rollback for 20261206000000_get_mentorship_snapshot.sql
-- Do NOT run this as part of normal testing — only if the owner decides to undo step 4.
begin;
drop function if exists public.get_mentorship_snapshot(date);
commit;
