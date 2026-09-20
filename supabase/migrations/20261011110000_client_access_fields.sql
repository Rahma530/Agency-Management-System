-- "Client Access" tab (ClientDashboard.tsx): agency-held credentials for the client's own
-- external platforms/ad accounts — portal/platform login, ad account access notes, and payment
-- card details tied to those ad accounts. Distinct from client_portal_users (the CLIENT's own
-- login into THIS app).
--
-- No RLS policy change needed: RLS is row-level, not column-level, and
-- clients_update_am_assignment_rls already covers UPDATE on these new columns for the roles that
-- may write them (executive/head_of_technical/am_team_lead). Visibility of these columns —
-- including that am_agent may VIEW but not edit them — is enforced in the UI via
-- permissions.ts's canAccessClientSensitiveInfo(), the same split already used for Payment
-- Tracking (canSeePaymentTracking vs. canEditPaymentTracking).
alter table public.clients
  add column if not exists access_username text,
  add column if not exists access_password text,
  add column if not exists ad_account_access_details text,
  add column if not exists payment_card_details text;
