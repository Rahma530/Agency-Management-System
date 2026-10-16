-- ROLLBACK for 20261110000000_user_schedule_load.sql.
--
-- Purely additive migration (two new functions + their grants, nothing else touched) — rollback
-- is simply dropping them. Safe to run even if neither was ever created (IF EXISTS). Nothing
-- else in the schema references either function, so these drops cannot fail on a dependent
-- object.
begin;

drop function if exists public.get_user_schedule_load(text, date, date, timestamptz);
drop function if exists public.get_server_today(timestamptz);

commit;
