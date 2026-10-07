begin;

do $migration$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'assignments'
  ) then
    execute 'alter publication supabase_realtime add table public.assignments';
  end if;
end
$migration$;

commit;
