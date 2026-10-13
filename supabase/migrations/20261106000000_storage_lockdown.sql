-- ============================================================================
-- Storage lockdown: drop the 4 live, untracked "blanket" storage.objects policies and fix the
-- client-contracts sales-owner name-shadowing bug that they were masking.
--
-- 1. The live database currently carries 4 policies on storage.objects, for role `authenticated`,
--    with `qual`/`with_check` = `true`, applying to EVERY bucket (no `bucket_id` filter at all):
--      "Allow authenticated users to select files"
--      "Allow authenticated users to insert files"
--      "Allow authenticated users to update files"
--      "Allow authenticated users to delete files"
--    These are not in any migration in this repo — most likely created from Supabase Studio's
--    default bucket-policy templates when one of the buckets was first created through the UI.
--    Because Postgres RLS policies are OR'd together, each of these 4 unconditionally-true
--    policies grants its operation on every object in every bucket to any authenticated user,
--    regardless of what any bucket-specific policy below says — the bucket-specific policy is
--    never actually the deciding one while these exist.
--
--    Audited every bucket's own select/insert/delete policies against what src/ actually does
--    (uploads, signed-url reads, deletes) before dropping these: task-attachments,
--    meeting-recordings, and chat-attachments already have complete, correct bucket-specific
--    coverage for every operation the app performs on them, so dropping the blanket policies
--    changes nothing for those three (see comment above the `drop policy` statements below and
--    the test file for the exact scenarios checked). Only client-contracts had a real gap, fixed
--    in section 2/3 below.
--
-- 2. client_contracts_objects_select_rls's sales-owner branch has been broken since it was first
--    written (every one of 20260922_client_contracts.sql, the v2/v3/v4 canonical-schema
--    rebuilds, 20261016_client_contracts_upload_matches_view.sql, and
--    20261018_align_ai_engineer_with_head_of_technical.sql carries the same bug verbatim — this
--    is a bug in the migration text itself, not drift applied by hand against the live database):
--
--      exists (select 1 from public.clients c where c.id = (storage.foldername(name))[1] and ...)
--
--    `name` inside that subquery is unqualified, and `public.clients` has its own `name` column
--    (the client's business name, a plain text field with no '/'-delimited structure) — per
--    ordinary SQL scoping rules, an unqualified column reference resolves to the innermost query
--    that has a matching column, so `name` here binds to `clients.name`, NOT the outer
--    `storage.objects.name` (the uploaded object's own path) the policy author intended.
--    `storage.foldername('some client business name')` can never produce a real client id, so
--    this branch can never match — a `sales` user has never actually been able to upload/view a
--    contract for their own client via this branch. It was invisible until now purely because
--    the blanket policies covered for it.
--
--    Fixed by qualifying every reference as `storage.objects.name` explicitly (the same pattern
--    client_contracts_objects_delete_rls already uses correctly).
--
-- 3. client_contracts_objects_insert_rls on the live database currently has ONLY the (broken)
--    sales-owner branch as its `with_check` — the exec/head_of_technical/am_team_lead/am_agent
--    branches that 20261016/20261018 intended to add to it never took effect live. Recreated here
--    with the exact same predicate as the fixed select policy (upload rights = view rights, which
--    was always the intent of those two migrations).
--
-- 4. Delete-ordering check for the new owner-based-delete pattern task_attachments uses
--    (task_attachments_objects_delete_own_rls, added because delete_task_attachment() deletes the
--    task_attachments metadata row BEFORE the client's Storage remove() call, so the old
--    metadata-keyed delete policy can no longer match by the time remove() runs): client-contracts
--    does NOT have that problem. handleDeleteClientContract (src/App.tsx) calls
--    `supabase.storage.from('client-contracts').remove(...)` FIRST and only deletes the
--    `client_contracts` metadata row afterward, on success — the metadata row backing
--    client_contracts_objects_delete_rls's `exists` check still exists at the moment the storage
--    delete is evaluated. No additive owner-based delete policy is needed or added here; the
--    existing client_contracts_objects_delete_rls is left untouched.
--
-- 5. task-attachments, chat-attachments (public bucket, intentionally open to any authenticated
--    user by design), and meeting-recordings policies are untouched by this migration.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Drop the 4 live blanket policies (bucket-independent, qual/with_check = true).
-- ----------------------------------------------------------------------------
drop policy if exists "Allow authenticated users to select files" on storage.objects;
drop policy if exists "Allow authenticated users to insert files" on storage.objects;
drop policy if exists "Allow authenticated users to update files" on storage.objects;
drop policy if exists "Allow authenticated users to delete files" on storage.objects;

-- ----------------------------------------------------------------------------
-- 2. client_contracts_objects_select_rls — same role/branch set as the live policy, with every
--    `name` reference qualified as storage.objects.name so the sales-owner branch's `exists`
--    subquery can no longer be shadowed by clients.name.
-- ----------------------------------------------------------------------------
drop policy if exists "client_contracts_objects_select_rls" on storage.objects;
create policy "client_contracts_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(storage.objects.name))[1]
        and c.sales_owner_id = public.app_user_id()
    )
  )
);

-- ----------------------------------------------------------------------------
-- 3. client_contracts_objects_insert_rls — recreated with the SAME predicate as the select
--    policy above (upload rights = view rights, the intent 20261016/20261018 already stated),
--    same storage.objects.name qualification fix applied.
-- ----------------------------------------------------------------------------
drop policy if exists "client_contracts_objects_insert_rls" on storage.objects;
create policy "client_contracts_objects_insert_rls" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(storage.objects.name))[1]
        and c.sales_owner_id = public.app_user_id()
    )
  )
);

commit;
