-- AM Renewal page rework (2026-11-19, owner's follow-up to PR #327).
--
-- The whole point of this page is "which clients did THIS AM bring in and renew themselves" —
-- distinct from clients Sales originally registered. sales_owner_id being null is NOT a reliable
-- signal for that: it's also null when Executive/Head of Technical registers a client on an AM's
-- behalf (handleRegisterClient in App.tsx), so a client registered by management and merely
-- assigned to an AM would be indistinguishable from one the AM genuinely added themselves.
--
-- am_renewal_registered_by is the explicit, unambiguous marker instead: set ONLY when a client is
-- created through this page's own "New Client" event (not the general registration flow
-- elsewhere in the app, even for the same am_agent role) — see handleRegisterClient's
-- am_renewal_registered_by param. A client can still show in ordinary Client Onboarding either
-- way; this column only controls what appears on the AM Renewal page itself.

begin;

alter table public.clients add column am_renewal_registered_by text references public.users (id);

-- Same column-level SELECT allowlist pattern as renewal_value (20270113000000) — missing this
-- grant is exactly what broke client loading last time (20270112000000's design_drive_link
-- incident), so it's included in the same migration as the column this time.
grant select (am_renewal_registered_by) on public.clients to authenticated;

commit;
