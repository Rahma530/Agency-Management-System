-- Revokes privileges this audit confirmed anon/authenticated/future-objects held but nothing in
-- this app's own code relies on — closing default-grant exposure that every GRANT migration in
-- this repo (20260907090000_table_grants.sql, 20261003100000_chat_directory_rpc.sql,
-- 20261011130000_assignable_employees_rpc.sql, etc.) only ever ADDED to, never cleaned up.
--
-- Items 1-2 below were already applied manually in the Supabase SQL Editor on 2026-10-05, ahead
-- of this migration landing — included here anyway so the live database's actual state is fully
-- captured in version control (the same reasoning as every other "document the live state"
-- migration in this history), and so a fresh/future database built from this migration history
-- ends up with the same privileges without needing that manual step repeated.
--
-- 1 & 2. chat_directory()/assignable_employees(text): both were created with an explicit
-- `grant execute ... to authenticated` and nothing else — but Postgres grants EXECUTE on every
-- newly created function to PUBLIC by default, and neither original migration revoked that
-- default. PUBLIC includes anon, so anon could call either RPC directly all along, despite never
-- being named in any grant. Confirmed via audit that no later migration re-grants either function
-- to anon: chat_directory() is defined exactly once (20261003100000_chat_directory_rpc.sql) and
-- never redefined; assignable_employees(text) is redefined once, by
-- 20261018000000_align_ai_engineer_with_head_of_technical.sql (a body-only change, widening its
-- role exclusion to include ai_engineer) — CREATE OR REPLACE FUNCTION does not reset a function's
-- existing GRANTs, and that redefinition contains no GRANT statement of its own, so it carries
-- forward exactly the privileges already in place rather than resurfacing a PUBLIC/anon grant.
--
-- 3. users: RLS already scopes every policy `to authenticated` only (confirmed, no policy is
-- scoped to anon), so anon could never see or change a row regardless — this just removes the
-- same implicit default-grant exposure at the table-privilege layer, for the one table audited
-- most heavily in this engagement.
--
-- 4. Every other table in public: removes the TRUNCATE/REFERENCES/TRIGGER(/MAINTAIN, guarded
-- below) privileges anon/authenticated have held since table creation purely as Postgres/Supabase
-- defaults — confirmed via audit that this app never issues a TRUNCATE, never creates a trigger or
-- a foreign key constraint at runtime (foreign keys are declared once, in migrations, by the table
-- owner, which is the only time REFERENCES is actually checked). service_role is deliberately
-- left untouched on EXISTING tables here, per instruction — this block only ever names anon and
-- authenticated.
--
-- 5. Default privileges for role postgres: without this, every NEW table/function created by a
-- future migration (run as postgres, the owner every migration in this repo runs as) would
-- silently reacquire the exact same unused grants this migration just removed — this closes that
-- recurrence at its source instead of requiring every future migration to remember to revoke it
-- again by hand. Scoped explicitly `for role postgres` — supabase_admin's own default privileges
-- are never referenced here and so are left completely untouched, as instructed.
--
-- MAINTAIN (added in PostgreSQL 17) is version-guarded in both the item 4 and item 5 blocks: a
-- bare `revoke ... maintain ...` statement fails to PARSE at all on an older server (it's a syntax
-- error, not a runtime check), so each guarded block uses dynamic SQL (`execute format(...)`)
-- inside a DO block, choosing at runtime whether to include MAINTAIN in the statement string
-- before that string is ever parsed — never failing outright on a pre-17 server.
begin;

-- 1. chat_directory()
revoke execute on function public.chat_directory() from public, anon;
grant execute on function public.chat_directory() to authenticated, service_role;

-- 2. assignable_employees(text)
revoke execute on function public.assignable_employees(text) from public, anon;
grant execute on function public.assignable_employees(text) to authenticated, service_role;

-- 3. users — explicit table-level revoke from anon (RLS already blocks anon entirely; this
-- removes the same exposure one layer earlier, at the GRANT check Postgres evaluates first).
revoke select, insert, update, delete on public.users from anon;

-- 4. Every table in public: strip the unused TRUNCATE/REFERENCES/TRIGGER(/MAINTAIN) default
-- grants from anon and authenticated. service_role is deliberately not named here.
do $$
declare
  r record;
  supports_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    if supports_maintain then
      execute format(
        'revoke truncate, references, trigger, maintain on table public.%I from anon, authenticated',
        r.tablename
      );
    else
      execute format(
        'revoke truncate, references, trigger on table public.%I from anon, authenticated',
        r.tablename
      );
    end if;
  end loop;
end $$;

-- 5a. Default privileges on FUTURE tables created by postgres in public: prevents the same
-- TRUNCATE/REFERENCES/TRIGGER(/MAINTAIN) grants from reappearing on every new table a future
-- migration creates. service_role IS named here (future tables only — item 4 above, existing
-- tables, deliberately never names it).
do $$
declare
  supports_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  if supports_maintain then
    execute 'alter default privileges for role postgres in schema public '
      || 'revoke truncate, references, trigger, maintain on tables from anon, authenticated, service_role';
  else
    execute 'alter default privileges for role postgres in schema public '
      || 'revoke truncate, references, trigger on tables from anon, authenticated, service_role';
  end if;
end $$;

-- 5b. Default privileges on FUTURE functions created by postgres in public: Postgres's own
-- default is EXECUTE granted to PUBLIC on function creation (the exact default-grant gap items 1-2
-- above had to clean up after the fact) — this stops a future migration's new function from ever
-- being auto-exposed to anon again, without having to remember an explicit revoke every time.
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;

commit;
