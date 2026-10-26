-- Enables Supabase Realtime (postgres_changes) on public.tasks — the pilot table for the owner's
-- "I don't want to have to refresh to see other people's changes" request. Mirrors
-- 20261031200000_assignments_realtime.sql exactly. The app-side subscription (App.tsx's
-- tasks_global channel) degrades to a 9s poll fallback until this is run, so nothing breaks in
-- the meantime — it just isn't instant yet.
begin;

do $migration$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    execute 'alter publication supabase_realtime add table public.tasks';
  end if;
end
$migration$;

commit;
