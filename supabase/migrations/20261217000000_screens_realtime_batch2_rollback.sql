-- Rollback for 20261217000000_screens_realtime_batch2.sql — removes this batch's tables from
-- the supabase_realtime publication. Each matching App.tsx subscription falls back to its 9s
-- poll automatically; nothing else needs to change.
begin;

do $migration$
declare
  t text;
begin
  foreach t in array array[
    'clients',
    'briefs',
    'campaigns',
    'capacity_logs',
    'daily_logs',
    'extra_notes',
    'reports',
    'meetings',
    'client_contracts'
  ]
  loop
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end
$migration$;

commit;
