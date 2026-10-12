-- ============================================================================
-- ROLLBACK for 20261106000000_storage_lockdown.sql.
--
-- WARNING: running this RE-OPENS THE SECURITY HOLE the migration closed. It recreates the 4
-- live blanket "Allow authenticated users to {select,insert,update,delete} files" policies
-- (bucket-independent, qual/with_check = true for role authenticated — any authenticated user
-- can select/insert/update/delete ANY object in ANY bucket), and restores
-- client_contracts_objects_select_rls/_insert_rls to their previous LIVE, name-shadowed form,
-- where the sales-owner branch's `exists` subquery can never match (unqualified `name` resolves
-- to clients.name, not storage.objects.name) and the insert policy has only that broken branch.
-- Use only to intentionally revert; not needed for normal operation.
-- ============================================================================
begin;

-- Restore the previous LIVE client_contracts_objects_insert_rls — ONLY the broken sales-owner
-- branch, exactly as it existed on the live database before the migration.
drop policy if exists "client_contracts_objects_insert_rls" on storage.objects;
create policy "client_contracts_objects_insert_rls" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'client-contracts'
  and exists (
    select 1 from public.clients c
    where c.id = (storage.foldername(name))[1]
      and c.sales_owner_id = public.app_user_id()
  )
);

-- Restore the previous LIVE client_contracts_objects_select_rls — same name-shadowing bug.
drop policy if exists "client_contracts_objects_select_rls" on storage.objects;
create policy "client_contracts_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(name))[1]
        and c.sales_owner_id = public.app_user_id()
    )
  )
);

-- Recreate the 4 live blanket policies, bucket-independent, qual/with_check = true.
create policy "Allow authenticated users to select files" on storage.objects
for select to authenticated using (true);

create policy "Allow authenticated users to insert files" on storage.objects
for insert to authenticated with check (true);

create policy "Allow authenticated users to update files" on storage.objects
for update to authenticated using (true) with check (true);

create policy "Allow authenticated users to delete files" on storage.objects
for delete to authenticated using (true);

commit;
