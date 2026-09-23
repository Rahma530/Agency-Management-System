-- Contract file delete rights widened to match view/upload rights exactly (showContractValue's
-- unified scope), no longer "uploader only". Confirmed client_contracts_delete_rls and
-- client_contracts_objects_delete_rls both still had the original uploaded_by = caller-only
-- condition (the same restriction the insert policies had before the previous migration widened
-- those) — this closes the same gap on the delete side: any currently-responsible person
-- (executive/head_of_technical/am_team_lead, the specific responsible am_agent, or sales for
-- their own client) can now delete a contract regardless of who originally uploaded it.
begin;

drop policy "client_contracts_delete_rls" on public.client_contracts;

create policy "client_contracts_delete_rls" on public.client_contracts
for delete to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (
    public.app_user_role() = 'sales'
    and exists (
      select 1 from public.clients c
      where c.id = client_contracts.client_id and c.sales_owner_id = public.app_user_id()
    )
  )
);

drop policy "client_contracts_objects_delete_rls" on storage.objects;

create policy "client_contracts_objects_delete_rls" on storage.objects
for delete to authenticated
using (
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
