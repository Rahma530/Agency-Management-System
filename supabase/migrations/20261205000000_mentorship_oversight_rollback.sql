-- Rollback for 20261205000000_mentorship_oversight.sql
-- Do NOT run this as part of normal testing — only if the owner decides to undo step 3.
begin;

drop function if exists public.remove_mentorship_oversight(text, text);
drop function if exists public.add_mentorship_oversight(text, text);
drop table if exists public.mentorship_oversight;

commit;
