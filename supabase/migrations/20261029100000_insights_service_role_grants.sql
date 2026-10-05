-- Corrective grant: media_buying_insights (20261027000000_media_buying_insights.sql) and
-- social_insights (20261025000000_social_insights_weekly_manual_entry.sql) were both created
-- without an explicit grant to service_role, so service_role had only the default
-- TRUNCATE/REFERENCES/TRIGGER privileges on them (whatever Postgres grants the owning role by
-- default) — not SELECT/INSERT/UPDATE/DELETE.
--
-- media_buying_insights' own create-table migration (20261027000000_media_buying_insights.sql)
-- only ever landed on a separate, unmerged branch (claude/media-buying-periodic-entry) — it was
-- never part of this migration history on main. The live database already had both this grant and
-- the table itself applied manually from that branch, ahead of this migration being written, so
-- the grant below is wrapped in a guard that is a no-op wherever the table doesn't exist yet (a
-- fresh database built from this migration history in order, before
-- 20261030600000_document_media_buying_insights.sql creates the table) and applies cleanly,
-- idempotently, wherever it already does (the live database, and any database replayed from this
-- history in full). A bare `grant ... on public.media_buying_insights ...` would otherwise fail
-- outright with "relation does not exist" on the former.
begin;

do $$
begin
  if to_regclass('public.media_buying_insights') is not null then
    grant select, insert, update, delete on public.media_buying_insights to service_role;
  end if;
end $$;

grant select, insert, update, delete on public.social_insights to service_role;

commit;
