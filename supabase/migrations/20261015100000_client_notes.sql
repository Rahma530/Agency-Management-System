-- Register New Client's optional free-text Notes field. Additive only — no RLS change: like
-- contract_value/due_value/remaining_value, this column is not restricted at the row-level RLS
-- policy (Postgres RLS is row-level, not column-level); visibility of its CONTENT to a narrower
-- role set than "can see the client row at all" is enforced app-side, the same precedent
-- canSeeContractValue()/canSeePaymentTracking() already establish for those financial fields.
begin;

alter table public.clients add column if not exists notes text;

commit;
