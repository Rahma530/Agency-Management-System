-- Rollback for 20261216000000_tasks_realtime.sql — removes public.tasks from the
-- supabase_realtime publication. The app's tasks_global channel will fall back to its 9s poll
-- automatically; nothing else needs to change.
begin;

do $migration$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    execute 'alter publication supabase_realtime drop table public.tasks';
  end if;
end
$migration$;

commit;
