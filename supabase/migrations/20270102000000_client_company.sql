-- Adds public.clients.company: which of the agency's own sibling companies (Kesra, Fast Growth,
-- Top Rate — more may be added later) a client belongs to. Owner decision, 2026-11-07: this is
-- purely organizational/display grouping, never an access boundary — every employee who can see a
-- client today keeps seeing it regardless of which company it's tagged with; no RLS change.
--
-- Nullable, with NO backfill: real clients ARE already split across the three companies today, but
-- which company owns which client is only known to the owner, not inferable from any existing
-- column (there is no prior "which sister company" signal anywhere in this schema) — a guessed
-- backfill would silently mis-tag real clients. Existing clients stay unset until tagged by hand via
-- EditClientModal.tsx; the Client Portfolio's new company filter (AMQueue.tsx) includes an explicit
-- "Unassigned" bucket so that work can be tracked to completion instead of just getting lost.
--
-- Plain text + a check constraint (not a Postgres enum type) — same convention as sector
-- (20261010100000_client_sector.sql): adding a 4th company later is a one-line constraint change
-- here plus a one-line addition to CLIENT_COMPANY_OPTIONS (src/lib/clientCompany.ts), no ALTER TYPE.
begin;

alter table public.clients add column company text;

alter table public.clients add constraint clients_company_known_check
  check (company is null or company in ('kesra', 'fast_growth', 'top_rate'));

-- public.clients has a column-level SELECT grant, not a blanket one, since
-- 20261030500000_protect_client_access_columns.sql — every column NON_SENSITIVE_CLIENT_COLUMNS
-- (src/types/database.ts) names must be explicitly granted here too, or PostgREST rejects the whole
-- query outright (not just this one column) — see 20261209000000_grant_profit_margin_pct_select.sql,
-- where exactly this mistake once broke every client fetch in the app for everyone.
grant select (company) on public.clients to authenticated;

commit;
