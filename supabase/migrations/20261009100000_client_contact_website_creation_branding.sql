-- Three purely additive changes to the client registration model:
-- 1. clients.client_contact_name: the individual point-of-contact's name, distinct from
--    clients.name (the company/business name). No existing column is renamed or repurposed.
-- 2. clients.website_or_social_link: free-text, no format enforcement (a URL or a social
--    handle/link are both valid) — same convention as clients.phone_number.
-- 3. Two new services, 'creation' (store/website setup from scratch) and 'branding' (brand
--    identity work), joining the existing seo/social_media/media_buying/interface set. Neither
--    has a dedicated department/team lead — same "no dedicated department" shape as 'interface'
--    (see 20261008100000_client_services_model.sql), so no new role, RLS policy, or
--    reportingEngine wiring is needed, only the CHECK constraints and brief question sets below.
-- No existing row uses 'creation' or 'branding' yet, so unlike the creative -> social_media
-- migration, this needs no UPDATE/backfill — the constraints are strictly widened, not remapped.

alter table public.clients add column client_contact_name text;
alter table public.clients add column website_or_social_link text;

alter table public.clients drop constraint clients_services_check;
alter table public.briefs drop constraint briefs_service_type_check;
alter table public.brief_revisions drop constraint brief_revisions_service_type_check;
alter table public.assignments drop constraint assignments_service_type_check;
alter table public.brief_field_schemas drop constraint brief_field_schemas_service_check;

alter table public.clients add constraint clients_services_check
  check (services <@ array['seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding']);
alter table public.briefs add constraint briefs_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding'));
alter table public.brief_revisions add constraint brief_revisions_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding'));
alter table public.assignments add constraint assignments_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding'));
alter table public.brief_field_schemas add constraint brief_field_schemas_service_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding'));

-- Creation briefs: is there already a domain/host to build on, what should the site look/feel
-- like, and what will actually be listed on it.
insert into public.brief_field_schemas
  (id, service_type, key, label, type, placeholder, span, required, sort_order)
values
  ('bfs-creation-1', 'creation', 'domain_hosting_status', 'Domain & Hosting Status', 'textarea', 'Do they already have a domain and hosting, or do we need to set these up from scratch?', 'full', true, 0),
  ('bfs-creation-2', 'creation', 'products_services', 'Products / Services Offered', 'textarea', 'What products or services will be listed or sold on the site?', 'full', true, 1),
  ('bfs-creation-3', 'creation', 'reference_sites', 'Reference Sites', 'textarea', 'Links to stores/websites they like the look and feel of.', 'full', false, 2)
on conflict (service_type, key) do nothing;

-- Branding briefs: visual direction, who it's for, and any existing references to anchor to.
insert into public.brief_field_schemas
  (id, service_type, key, label, type, placeholder, span, required, sort_order)
values
  ('bfs-branding-1', 'branding', 'colors_logo_direction', 'Preferred Colors & Logo Direction', 'textarea', 'Preferred colors, logo style, and any visual direction to follow.', 'full', true, 0),
  ('bfs-branding-2', 'branding', 'target_audience', 'Target Audience', 'textarea', 'Who is the target audience for this brand?', 'full', true, 1),
  ('bfs-branding-3', 'branding', 'brand_references', 'Brand References / Inspiration', 'url', 'Link to brands, mood boards, or inspiration you like.', 'full', false, 2)
on conflict (service_type, key) do nothing;
