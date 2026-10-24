-- Adds "Meta" and "Google" to public.platforms (20261108000000_task_platforms.sql), whose seed
-- currently only has Instagram, TikTok, Snapchat. Needed so the Media Buyers Mentorship system
-- (client-level TikTok/Meta/Snap/Google flags from the mentorship tracker) can reuse this same
-- lookup table instead of creating a second, parallel platform list.
--
-- Idempotent via the existing unique(name) constraint — on conflict do nothing, safe to re-run.
-- No RLS/grant changes: this table's policies (platforms_select_rls / _write_rls / _update_rls)
-- already cover any row regardless of which rows exist.
begin;

insert into public.platforms (id, name, sort_order, active)
values
  ('meta', 'Meta', 3, true),
  ('google', 'Google', 4, true)
on conflict (name) do nothing;

commit;
