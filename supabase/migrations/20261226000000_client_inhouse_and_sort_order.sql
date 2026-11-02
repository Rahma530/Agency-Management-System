-- Foundation for two new features Rahma asked for (2026-11-02):
-- 1. An "Inhouse" module (Creative/Programming/Video work done for the agency's own brands,
--    Kesraa and Fast Growth, rather than for a paying client) — gated to Executive/Head of
--    Technical/Marketing Manager. Those two brands already exist as rows in public.clients
--    (added through the normal client-registration flow, not seeded here); this migration adds
--    the flag that marks them as "inhouse" clients so the frontend can exclude them from the
--    normal Sales/AM client lists and offer them only as the "which company" picker inside the
--    Inhouse module. Flagging the two existing rows is a separate, manual step (see bottom of
--    this file) — intentionally not done here, since this migration doesn't know their client
--    ids and guessing by name is exactly the kind of silent-mismatch risk this schema's own
--    history (see 20261114000000_merge_clients.sql) warns about.
-- 2. Manual client ordering (drag & drop) + a ClickUp-style status board, on top of yesterday's
--    automatic status-based sort (compareByClientStatus, client-side only, no column needed).
--    sort_order is nullable: null means "no manual position yet, fall back to the automatic
--    status sort"; once Rahma drags a client, the frontend assigns it an integer and from then on
--    manual order wins for that client.
--
-- IMPORTANT — column-level SELECT grant: public.clients has had a column-level (not blanket)
-- SELECT grant since 20261030500000_protect_client_access_columns.sql. Forgetting to grant a new
-- column here doesn't fail safe in practice — PostgREST rejects the WHOLE select('col1, col2,
-- newcol') query with "permission denied for column newcol" the moment the frontend starts
-- naming it, breaking every client fetch for every role (this exact outage happened for
-- profit_margin_pct, fixed in 20261209000000_grant_profit_margin_pct_select.sql). Both new
-- columns are granted below in the same migration as the ALTER, so that can't happen here.
--
-- insert/update on public.clients are still table-level grants (20260907090000_table_grants.sql,
-- untouched by the column-level-SELECT migration), so no insert/update grant change is needed for
-- either column.

begin;

alter table public.clients
  add column is_inhouse boolean not null default false;

alter table public.clients
  add column sort_order integer;

grant select (is_inhouse, sort_order) on public.clients to authenticated;

commit;

-- Manual follow-up (run separately, after reviewing the output — NOT part of this migration):
--
--   select id, name, is_inhouse from public.clients where name ilike '%kesraa%' or name ilike '%fast growth%';
--
--   -- once you've confirmed the two correct ids from the result above:
--   update public.clients set is_inhouse = true where id in ('<kesraa_client_id>', '<fast_growth_client_id>');
