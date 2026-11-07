-- Rollback for 20270101000000_graphic_design_baseline_backfill.sql — removes the
-- 'graphic_design' entry that migration added to other_services, for every client that has it.
--
-- Note: this does NOT distinguish "this migration added it" from "it was already there before
-- this migration ran" — a client who explicitly had 'graphic_design' in other_services before the
-- backfill (e.g. one registered after the Register/Edit Client toggle removal, which already
-- writes it out via splitClientServices()) will also lose it here. That's an accepted limitation
-- of this rollback, not a bug: the whole point of the forward migration was "every client has it,
-- unconditionally," so a rollback that tried to be selective would need to have recorded which
-- rows it touched at the time, which this simple backfill deliberately didn't do.
--
-- The frontend-side change (getClientServices() always including graphic_design on the read
-- side) is a separate, non-database change — rolling back this migration alone does NOT undo
-- that. Both would need reverting together to fully restore the pre-2026-11-07 behavior.
begin;

update public.clients
set other_services = array_remove(other_services, 'graphic_design')
where 'graphic_design' = any(coalesce(other_services, '{}'));

commit;
