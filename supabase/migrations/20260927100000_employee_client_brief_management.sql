-- ============================================================================
-- 20260927100000_employee_client_brief_management.sql
--
-- Adds, on top of 20260926100000_canonical_schema_v3.sql:
--
-- 1. Employee deactivation (NOT hard delete). users.deactivated_at (nullable
--    timestamptz) marks an employee as permanently shut off from new work
--    while their row (and therefore their name on every historical task,
--    brief, daily log, report, etc.) stays intact. Their auth.users account
--    is separately BANNED (~100 year ban_duration, reversible) by
--    scripts/deactivateAuthUser.ts — the same service-role-only,
--    never-in-the-browser pattern as scripts/provisionAuthUsers.ts. This
--    migration only adds the column + the app-facing update policies; the
--    actual ban is applied out-of-band by that script.
--
--    Edit access (name/email/role/team/capacity_limit) and deactivate access
--    are both scoped to executive/head_of_technical + all 5 team leads
--    (am_team_lead, seo_team_lead, media_buying_team_lead,
--    social_media_team_lead). Column-scoped grants, not a blanket UPDATE —
--    same discipline as the original capacity_limit-only grant.
--
-- 2. Client hard DELETE. clients_delete_rls, scoped to the same 6 roles.
--    No cascade, no reassignment: every one of the 13 tables that reference
--    clients(id) still defaults to ON DELETE NO ACTION (unchanged from v3),
--    so a client with any activity anywhere simply fails to delete with a
--    plain FK-violation error. Only a client with zero rows in every
--    referencing table can actually be removed. This is intentional and
--    final — no exceptions were requested.
--
-- 3. Briefs:
--    a. briefs_update_rls is replaced: the old version's WITH CHECK pinned
--       every edit to `submitted_by = app_user_id()`, meaning only the
--       original submitter could ever successfully save an edit (even
--       though its USING clause already listed several other roles). The
--       new version drops that pin and adds executive/head_of_technical
--       (previously absent from this policy entirely) so every role in
--       the USING clause can genuinely edit an existing brief's answers,
--       not just re-save their own.
--    b. No brief DELETE policy is added — whole-brief deletion was
--       explicitly ruled out. brief_revisions' own append-only logging on
--       every save remains the audit trail.
--    c. briefs.custom_field_defs (jsonb): one-off custom questions added
--       to a SPECIFIC client's brief. Lives on the briefs row itself (not
--       a separate table) because there is already exactly one live
--       briefs row per (client_id, service_type) — confirmed by
--       App.tsx's handleSaveBrief, which looks up an existing brief by
--       that same pair before deciding update-vs-insert. A custom
--       question's scope ("this client's brief for this service") is
--       already exactly this row's identity, so a second table would add
--       an RLS/grant surface for no real benefit. The question's ANSWER
--       needs no new storage at all — it's just another key in the
--       existing `fields` jsonb column, identical to every built-in
--       field. Governed by the same briefs_update_rls as everything else
--       on this row.
--    d. brief_field_schemas (new table): the GLOBAL, per-service-type
--       question list. This used to be a hardcoded TS object
--       (src/data/briefFieldSchemas.ts) shipped in the JS bundle — making
--       it editable app-wide means it has to become the actual database
--       source of truth instead, seeded below from that file's current
--       content. A field added/edited/removed here affects every NEW
--       brief filled out for that service_type going forward; existing
--       submitted briefs keep whatever answers they already have
--       (nothing here touches `briefs.fields`).
--       Write access: executive, head_of_technical, am_team_lead, and
--       am_agent unconditionally (this branch already covers `creative`,
--       since there is no dedicated "creative team lead" role in this
--       app — creative resources are pooled under am_team_lead's
--       oversight elsewhere, e.g. DailyOperationsModule.tsx's teamMembers
--       scoping already folds graphic_designer/video_editor under
--       am_team_lead); plus each department team lead scoped to only
--       their own service_type (seo_team_lead -> 'seo', etc). Read access
--       is open to every authenticated user, since anyone filling out or
--       viewing a brief needs to see the current question list.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Employee deactivation
-- ----------------------------------------------------------------------------
alter table public.users add column deactivated_at timestamptz;

drop policy if exists "users_update_capacity_rls" on public.users;

create policy "users_update_capacity_rls" on public.users
for update to authenticated
using (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
)
with check (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
);

-- New: name/email/role/team, and deactivated_at, both scoped to exec/HoT + all
-- 5 team leads (team leads limited to employees employee_visible() already
-- scopes them to — their own department). Two separate policies for the two
-- column groups purely for readability; the USING/WITH CHECK predicate is
-- identical, so either could equally be one policy with two grants. Kept
-- separate so a future narrowing of one doesn't silently affect the other.
create policy "users_update_profile_rls" on public.users
for update to authenticated
using (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
)
with check (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
);

create policy "users_deactivate_rls" on public.users
for update to authenticated
using (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
)
with check (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
);

grant update (name, email, role, team, capacity_limit) on public.users to authenticated;
grant update (deactivated_at) on public.users to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Client hard delete
-- ----------------------------------------------------------------------------
create policy "clients_delete_rls" on public.clients
for delete to authenticated
using (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
);

grant delete on public.clients to authenticated;

-- ----------------------------------------------------------------------------
-- 3a/3b. Briefs: broadened update, still no delete
-- ----------------------------------------------------------------------------
drop policy if exists "briefs_update_rls" on public.briefs;

create policy "briefs_update_rls" on public.briefs
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

-- ----------------------------------------------------------------------------
-- 3c. Per-client custom brief questions
-- ----------------------------------------------------------------------------
alter table public.briefs add column custom_field_defs jsonb not null default '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- 3d. Global brief field schema
-- ----------------------------------------------------------------------------
create table public.brief_field_schemas (
  id text primary key,
  service_type text not null,
  key text not null,
  label text not null,
  type text not null,
  placeholder text,
  span text,
  rows integer,
  fallback text,
  value_class_name text,
  chip_class_name text,
  required boolean not null default false,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.brief_field_schemas add constraint brief_field_schemas_service_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'creative'));
alter table public.brief_field_schemas add constraint brief_field_schemas_type_check
  check (type in ('text', 'textarea', 'url', 'tag-list'));
alter table public.brief_field_schemas add constraint brief_field_schemas_span_check
  check (span is null or span in ('full', 'half'));
alter table public.brief_field_schemas add constraint brief_field_schemas_unique_key
  unique (service_type, key);

create index idx_brief_field_schemas_service on public.brief_field_schemas (service_type, sort_order);

alter table public.brief_field_schemas enable row level security;

create policy "brief_field_schemas_select_rls" on public.brief_field_schemas
for select to authenticated
using (true);

create policy "brief_field_schemas_write_rls" on public.brief_field_schemas
for all to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

grant select, insert, update, delete on public.brief_field_schemas to authenticated;

-- Seed data — the exact content of src/data/briefFieldSchemas.ts's former BRIEF_FIELD_SCHEMAS
-- object at the time it was removed from the frontend bundle, one row per field, sort_order
-- matching each field's original position in its service's array.
insert into public.brief_field_schemas
  (id, service_type, key, label, type, placeholder, span, rows, fallback, value_class_name, chip_class_name, required, sort_order)
values
  ('bfs-seo-1', 'seo', 'website_url', 'Target Website URL', 'url', 'https://example.com', 'half', null, null, 'text-xs font-bold text-emerald-300', null, true, 0),
  ('bfs-seo-2', 'seo', 'cms_platform', 'CMS Platform', 'text', 'Example: WordPress, Shopify, Next.js, Custom PHP...', 'half', null, null, 'text-xs font-bold text-white', null, false, 1),
  ('bfs-seo-3', 'seo', 'target_keywords', 'Target Keywords', 'textarea', 'Enter keywords separated by commas or new lines...', 'full', null, null, 'text-xs text-stone-200 font-mono whitespace-pre-line', null, true, 2),
  ('bfs-seo-4', 'seo', 'target_locations', 'Geographic Target', 'text', 'Example: Saudi Arabia (Riyadh, Jeddah), UAE...', 'half', null, null, 'text-xs text-white', null, false, 3),
  ('bfs-seo-5', 'seo', 'current_organic_traffic', 'Current Organic Traffic (Estimated)', 'text', 'Example: 5,000 visitors/month', 'half', null, 'N/A', 'text-xs font-bold text-purple-300', null, false, 4),
  ('bfs-seo-6', 'seo', 'competitor_urls', 'Competitor URLs', 'textarea', 'Enter competitor URLs...', 'full', null, null, 'text-xs text-stone-200 whitespace-pre-line', null, false, 5),
  ('bfs-seo-7', 'seo', 'primary_goals', 'Primary Campaign Goals', 'textarea', 'What outcomes were agreed upon with the client?', 'full', null, null, 'text-xs text-stone-200', null, false, 6),

  ('bfs-sm-1', 'social_media', 'social_channels', 'Social Channels', 'tag-list', 'Example: Instagram, TikTok, LinkedIn, X', 'full', null, null, null, 'bg-pink-950/60 text-pink-300 border-pink-800/40', true, 0),
  ('bfs-sm-2', 'social_media', 'brand_tone', 'Brand Voice & Tone', 'text', 'Example: Premium and elegant, friendly and playful, formal and informative...', 'half', null, null, 'text-xs font-bold text-white', null, false, 1),
  ('bfs-sm-3', 'social_media', 'posting_frequency', 'Posting Frequency', 'text', 'Example: 5 posts + 1 reel + daily stories', 'half', null, 'Weekly', 'text-xs font-bold text-purple-300', null, false, 2),
  ('bfs-sm-4', 'social_media', 'assets_drive_link', 'Brand & Content Assets Link', 'url', 'https://drive.google.com/...', 'full', null, null, 'text-xs font-bold text-purple-300', null, false, 3),
  ('bfs-sm-5', 'social_media', 'target_demographics', 'Target Demographics', 'textarea', 'Precise description of the target segment and their interests...', 'full', null, null, 'text-xs text-stone-200', null, false, 4),
  ('bfs-sm-6', 'social_media', 'content_pillars', 'Content Pillars', 'textarea', 'Example: Educational (40%), promotional (30%), interactive & contests (30%)', 'full', null, null, 'text-xs text-stone-200', null, false, 5),

  ('bfs-mb-1', 'media_buying', 'ad_platforms', 'Ad Platforms', 'tag-list', 'Example: Meta Ads, Google Ads, TikTok, Snapchat', 'full', null, null, null, 'bg-sky-950/60 text-sky-300 border-sky-800/40', true, 0),
  ('bfs-mb-2', 'media_buying', 'monthly_ad_budget', 'Monthly Ad Spend Budget', 'text', 'Example: SAR 40,000/month', 'half', null, 'Custom', 'text-sm font-bold text-sky-400 font-mono', null, true, 1),
  ('bfs-mb-3', 'media_buying', 'target_roas', 'Target ROAS', 'text', 'Example: 3.5x or 4.0x', 'half', null, 'N/A', 'text-sm font-bold text-emerald-400 font-mono', null, false, 2),
  ('bfs-mb-4', 'media_buying', 'primary_conversion_goal', 'Primary Conversion Goal', 'text', 'Example: Store sales, WhatsApp messages, qualified leads...', 'full', null, null, 'text-xs font-bold text-stone-200', null, false, 3),
  ('bfs-mb-5', 'media_buying', 'ad_accounts_access_status', 'Pixel & Ad Accounts Access', 'text', 'Example: Business Manager partnership sent, pixel is active on the store', 'full', null, null, 'text-xs text-stone-200', null, false, 4),
  ('bfs-mb-6', 'media_buying', 'target_audiences', 'Audience Details & Demographic Targeting', 'textarea', 'Interests, exclusions, Lookalike audiences needed...', 'full', null, null, 'text-xs text-stone-200', null, false, 5),

  ('bfs-cr-1', 'creative', 'deliverable_types', 'Deliverable Type(s)', 'text', 'e.g. Social static posts, Instagram Reels, brand logo, banner ads', 'half', null, null, 'text-xs font-bold text-white', null, true, 0),
  ('bfs-cr-2', 'creative', 'formats_dimensions', 'Formats & Dimensions', 'text', 'e.g. 1080x1080 (IG square), 1920x1080 (YouTube thumb), 9:16 vertical', 'half', null, null, 'text-xs font-bold text-purple-300', null, false, 1),
  ('bfs-cr-3', 'creative', 'deliverable_volume', 'Deliverable Volume / Frequency', 'text', 'e.g. 8 static posts + 2 reels per month', 'full', null, null, 'text-xs font-bold text-stone-200', null, false, 2),
  ('bfs-cr-4', 'creative', 'brand_guidelines_link', 'Brand Guidelines / Assets Link', 'url', 'https://drive.google.com/... (logo kit, fonts, guideline doc)', 'half', null, null, 'text-xs font-bold text-purple-300', null, false, 3),
  ('bfs-cr-5', 'creative', 'visual_references_link', 'Visual References / Inspiration', 'url', 'https://pinterest.com/... or moodboard link', 'half', null, null, 'text-xs font-bold text-purple-300', null, false, 4),
  ('bfs-cr-6', 'creative', 'key_message_tone', 'Key Message & Tone', 'textarea', 'What should this creative communicate? Target audience, tone, key message...', 'full', null, null, 'text-xs text-stone-200', null, false, 5),
  ('bfs-cr-7', 'creative', 'turnaround_deadline', 'Turnaround / Deadline Expectations', 'text', 'e.g. 3 business days per deliverable', 'full', null, null, 'text-xs font-bold text-stone-200', null, false, 6);

commit;
