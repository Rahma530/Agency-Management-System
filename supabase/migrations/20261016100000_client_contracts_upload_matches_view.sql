-- Contract upload became optional at registration (previously required, uploaded inline by
-- whoever registered the client). It's now primarily added/replaced later from the client
-- dashboard's Signed Contract panel, by whoever is CURRENTLY responsible for the client — not
-- necessarily whoever originally registered it. client_contracts_insert_rls and
-- client_contracts_objects_insert_rls were still hard-restricted to sales_owner_id = caller only
-- (the original "Sales uploads it once at registration" model), which would silently reject an
-- AM Team Lead/Agent/leadership upload even though the app's own canUpload check (mirroring
-- canSeeContractValue/showContractValue) already allows them. Widen both INSERT policies to match
-- client_contracts_select_rls's own role set exactly — upload rights now equal view rights.
-- Delete stays untouched (uploaded_by = caller only, unrelated to who may upload).
begin;

drop policy "client_contracts_insert_rls" on public.client_contracts;

create policy "client_contracts_insert_rls" on public.client_contracts
for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (
      public.app_user_role() = 'sales'
      and exists (
        select 1 from public.clients c
        where c.id = client_id and c.sales_owner_id = public.app_user_id()
      )
    )
  )
);

drop policy "client_contracts_objects_insert_rls" on storage.objects;

create policy "client_contracts_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()
    )
  )
);

commit;
