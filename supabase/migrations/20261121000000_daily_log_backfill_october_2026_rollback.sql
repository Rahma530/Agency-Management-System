-- Rollback for 20261121000000_daily_log_backfill_october_2026.sql.
-- Deletes only this backfill's own rows — matched by their deterministic 'dlog-bf-' id prefix,
-- which the forward migration never shares with the trigger ('dlog-' + a random uuid) or with any
-- manually-created row (an arbitrary client-generated id). No column/constraint/trigger/policy to
-- drop — the forward migration added none.
begin;

delete from public.daily_logs where id like 'dlog-bf-%';

commit;
