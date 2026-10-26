-- Enables Supabase Realtime (postgres_changes) on the next batch of tables, extending the
-- real-time rollout started with 20261216000000_tasks_realtime.sql (Task Board pilot) to the
-- rest of the day-to-day screens: Client Dashboard / AM Queue / Service Briefs Routing /
-- Campaign Management (clients), Service Briefs (briefs), Campaign Management (campaigns),
-- Capacity planning (capacity_logs), Daily Operations (daily_logs), My Work Hub (extra_notes),
-- Reporting Engine (reports), AM meeting notes (meetings), and Sales's contract uploads
-- (client_contracts).
--
-- Each app-side subscription (App.tsx's useSupabaseRealtimeSync calls) degrades to its own 9s
-- poll fallback until this is run, so nothing breaks in the meantime — it just isn't instant yet.
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
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$migration$;

commit;
