-- "Client Access" — collected during the Brief phase (ClientDashboard.tsx's Service Briefs tab,
-- alongside the per-service brief questions): general email, store platform login, social media
-- login, ad account login + setup type, and payment card details. One shared record per client
-- (not one per service — none of this varies by service), and every field is independently
-- optional; leaving any/all of it blank must never block saving a brief or any downstream
-- workflow. Distinct from client_portal_users (the CLIENT's own login into THIS app's portal).
--
-- No RLS policy change needed for executive/head_of_technical/am_team_lead: RLS is row-level, not
-- column-level, and clients_update_am_assignment_rls already covers UPDATE on these new columns
-- for those three roles. AM Agent's write path goes through the separate update_client_access()
-- RPC (see the following migration) rather than this policy.
alter table public.clients
  add column if not exists general_email text,
  add column if not exists general_email_password text,
  add column if not exists store_platform_username text,
  add column if not exists store_platform_password text,
  add column if not exists social_media_username text,
  add column if not exists social_media_password text,
  add column if not exists ad_account_username text,
  add column if not exists ad_account_password text,
  add column if not exists ad_account_setup_type text check (ad_account_setup_type in ('existing', 'new')),
  add column if not exists payment_card_details text;
