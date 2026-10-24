-- URGENT FIX: public.clients has a column-level SELECT grant (not a blanket table grant) since
-- 20261030500000_protect_client_access_columns.sql — authenticated can only select the columns
-- explicitly named there. profit_margin_pct (added later, in 20261204000000_mentorship_sales_
-- margin_tiers.sql) was never added to that grant list. #188 then made the frontend's client
-- fetch (NON_SENSITIVE_CLIENT_COLUMNS, src/types/database.ts) explicitly select profit_margin_pct
-- by name — and PostgREST/Postgres reject the WHOLE query with "permission denied for column
-- profit_margin_pct" when any named column isn't granted, not just that one column. Net effect:
-- every client fetch in the app has been failing outright since this shipped, so no clients show
-- up for anyone, in any role. This grants SELECT on just that one column to close the gap.
begin;

grant select (profit_margin_pct) on public.clients to authenticated;

commit;
