-- Enables Supabase Realtime (postgres_changes) on daily_log_attachments (new table from
-- 20261222100000_daily_log_attachments.sql), same rollout pattern as
-- 20261218000000_screens_realtime_batch3.sql. Until this runs, App.tsx's subscription for this
-- table just degrades to its own 9s poll fallback — nothing breaks in the meantime.
begin;

do $migration$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_log_attachments'
  ) then
    execute 'alter publication supabase_realtime add table public.daily_log_attachments';
  end if;
end
$migration$;

commit;
