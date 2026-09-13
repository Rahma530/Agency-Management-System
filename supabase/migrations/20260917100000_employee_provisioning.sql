-- ============================================================================
-- Employee provisioning (Add Employee admin feature): users insert policy
-- and an email-uniqueness constraint.
-- ============================================================================
--
-- public.users has never had an INSERT policy or grant — every employee to
-- date arrived via scripts/provisionAuthUsers.ts using the service-role key,
-- which bypasses RLS/GRANT entirely. The new "Add Employee" admin screen
-- (single form + bulk CSV/XLSX upload) runs from the ordinary browser
-- session instead, so it needs a real, narrow INSERT path.
--
-- Same invite-then-claim shape as Module 8's client portal: this INSERT
-- creates a "pending" employee row with auth_id left null — never a working
-- login by itself. A real Supabase Auth account only gets linked later,
-- out-of-band, by re-running scripts/provisionAuthUsers.ts with the
-- service-role key (now generalized in a follow-up commit to sweep every
-- auth_id IS NULL row in the live table, not just the original seed list).
--
-- `with check (auth_id is null)` is the load-bearing part: it makes it
-- structurally impossible for a browser session to insert a row claiming an
-- auth_id at all, real or fabricated, regardless of what the client sends.
-- Only the service-role script (which bypasses RLS) ever sets a real one.
--
-- Scoped to executive/head_of_technical only, mirroring every other
-- organization-wide admin action in this schema (capacity_logs insert,
-- users_update_capacity_rls, etc. all include these two plus the relevant
-- team leads; employee provisioning is deliberately narrower than that —
-- adding headcount is a leadership action, not a team-lead one).
-- ============================================================================

begin;

alter table public.users add constraint users_email_unique unique (email);

create policy "users_insert_admin_rls" on public.users
for insert
to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  and auth_id is null
);

grant insert on public.users to authenticated;

commit;
