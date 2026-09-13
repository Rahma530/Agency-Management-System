-- ============================================================================
-- Fix users_role_check: replace AI Studio's stale 9-value role list with the
-- app's actual 14-value UserRole union.
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- --------------------------
-- Confirmed directly against the live database (found in a saved SQL Editor
-- query, never previously run through this repo's own migrations folder):
-- public.users has an active CHECK constraint, users_role_check, restricting
-- the role column to only:
--   'executive', 'head_of_technical', 'sales', 'am_team_leader', 'am_agent',
--   'team_lead', 'agent', 'graphic_designer', 'video_editor'
--
-- Same origin as the uuid id columns fixed in 20260905000000_fix_id_column_
-- types.sql: leftover from Google AI Studio's original "Connect to
-- Supabase" schema-generation step, run directly against the project,
-- independent of and prior to anything tracked in this repo.
--
-- Cross-checked directly against src/types/database.ts (the source of
-- truth for the app's UserRole union, not retyped from memory) -- the
-- live constraint does not match it:
--   - 'am_team_leader' (constraint) vs. 'am_team_lead' (app) -- different
--     strings entirely, not just a naming preference.
--   - generic 'team_lead' / 'agent' (constraint) vs. the app's five
--     specific per-department pairs: media_buying_team_lead /
--     media_buying_agent, seo_team_lead / seo_agent, social_media_team_lead
--     / social_media_agent -- plus am_team_lead / am_agent, which the
--     constraint also gets wrong (see above).
--   - 'ai_engineer' (app) is entirely absent from the constraint.
--   - 'sales', 'executive', 'head_of_technical', 'graphic_designer',
--     'video_editor' are the only five values the constraint already gets
--     right.
--
-- Left as-is, this silently rejects every insert/update of a user with any
-- of the roles the constraint gets wrong or omits -- e.g. seo_agent,
-- media_buying_team_lead, ai_engineer -- regardless of anything the app or
-- this repo's own RLS migrations do; Postgres enforces CHECK constraints
-- independently of and before RLS is ever evaluated.
--
-- Timestamped to run before 20260905000000_fix_id_column_types.sql per
-- request. Not a hard dependency -- that migration never alters or
-- references the role column -- but this is the more fundamental
-- correctness fix of the two, so it belongs first chronologically.
-- ============================================================================

begin;

alter table public.users drop constraint if exists users_role_check;

alter table public.users add constraint users_role_check check (
  role in (
    'executive',
    'head_of_technical',
    'sales',
    'am_team_lead',
    'am_agent',
    'media_buying_team_lead',
    'media_buying_agent',
    'seo_team_lead',
    'seo_agent',
    'social_media_team_lead',
    'social_media_agent',
    'graphic_designer',
    'video_editor',
    'ai_engineer'
  )
);

commit;
