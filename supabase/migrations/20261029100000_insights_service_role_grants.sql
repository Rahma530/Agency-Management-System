-- Corrective grant: media_buying_insights (20261027000000_media_buying_insights.sql) and
-- social_insights (20261025000000_social_insights_weekly_manual_entry.sql) were both created
-- without an explicit grant to service_role, so service_role had only the default
-- TRUNCATE/REFERENCES/TRIGGER privileges on them (whatever Postgres grants the owning role by
-- default) — not SELECT/INSERT/UPDATE/DELETE.
begin;

grant select, insert, update, delete on public.media_buying_insights to service_role;
grant select, insert, update, delete on public.social_insights to service_role;

commit;
