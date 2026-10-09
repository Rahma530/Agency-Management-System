begin;

grant select (renewal_history_count)
on table public.clients
to authenticated;

commit;
