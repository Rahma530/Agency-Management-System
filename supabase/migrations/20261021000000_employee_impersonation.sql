-- TEMPORARY TRANSITION FEATURE — see supabase/functions/employee-impersonation/index.ts and
-- src/components/EmployeeImpersonation.tsx for the full context. This table exists only to
-- support that bridge tool (log into a rank-and-file employee's account via a magic link,
-- without ever seeing or resetting their real password) for the window until every employee has
-- adopted their real, self-set password. It should be dropped alongside that feature once
-- leadership confirms it's no longer needed — not grown into a permanent audit system.
--
-- Every row is written by the employee-impersonation Edge Function using the service-role key,
-- which has already verified the caller is an active head_of_technical/ai_engineer before
-- inserting — a plain authenticated client can never create a row (no insert policy/grant below),
-- so this log cannot be spoofed or backdated by the client.
begin;

create table public.impersonation_sessions (
  id text primary key,
  admin_user_id text not null references public.users (id),
  admin_auth_id uuid not null references auth.users (id),
  employee_id text not null references public.users (id),
  employee_auth_id uuid not null references auth.users (id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text
);

alter table public.impersonation_sessions add constraint impersonation_sessions_ended_reason_check
  check (ended_reason is null or ended_reason in ('manual_exit', 'admin_override'));
-- ended_at and ended_reason are always set together: a session is either still open (both null)
-- or closed (both set) — never half-closed.
alter table public.impersonation_sessions add constraint impersonation_sessions_ended_pair_check
  check ((ended_at is null) = (ended_reason is null));

create index idx_impersonation_sessions_admin on public.impersonation_sessions (admin_user_id);
create index idx_impersonation_sessions_employee on public.impersonation_sessions (employee_id);

alter table public.impersonation_sessions enable row level security;

-- Read access is intentionally narrow: only the admin who ran a given impersonation can see it
-- in the app today. Neither the impersonated employee nor any other role (including executive)
-- has a read path yet — flagged separately as a possible gap, not assumed here.
create policy "impersonation_sessions_select_rls" on public.impersonation_sessions
for select to authenticated
using (admin_auth_id = auth.uid());

-- Closing a session is the one client-writable transition, and only while it's still open.
-- Session duration is manual-only (no auto-expiry), so the natural moment to close it is while
-- still authenticated AS the employee, right before signing out at "Exit Impersonation" — at that
-- instant auth.uid() is the employee's auth_id, not the admin's (this app has exactly one active
-- Auth session at a time, so the admin's own identity isn't available again until they sign back
-- in afterward). The admin_auth_id branch exists as a self-healing fallback: if a tab is closed
-- mid-session and a row is left open, the admin's own next login closes it (see
-- handleLoginSuccess in App.tsx), rather than leaving it open forever with no automatic expiry.
create policy "impersonation_sessions_close_rls" on public.impersonation_sessions
for update to authenticated
using (
  ended_at is null
  and (admin_auth_id = auth.uid() or employee_auth_id = auth.uid())
)
with check (
  admin_auth_id = auth.uid() or employee_auth_id = auth.uid()
);

grant select on public.impersonation_sessions to authenticated;
-- Column-level grant, not a blanket UPDATE grant: even combined with the policy above, an
-- authenticated client can only ever change ended_at/ended_reason on a row it's allowed to close
-- — never admin_user_id, employee_id, or started_at after the fact.
grant update (ended_at, ended_reason) on public.impersonation_sessions to authenticated;

commit;
