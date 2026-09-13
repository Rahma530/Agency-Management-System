-- ============================================================================
-- Employee Performance audit (point 8): close the peer-visibility leak on
-- personal/HR-sensitive tables.
-- ============================================================================
--
-- extra_notes and daily_logs previously reused employee_visible_by_id() —
-- the general org-directory visibility function — for their SELECT
-- policies. That function is correctly broad for its actual purposes (the
-- employee directory, and letting a team see who's who), but it also grants
-- same-role peer visibility (e.g. any am_agent could see any other
-- am_agent's entry) and a agent-to-their-own-lead reciprocal branch. Applied
-- to personal daily logs and "extra effort" notes, that peer branch is a
-- real leak: one am_agent could read another am_agent's daily log or extra
-- notes, which has nothing to do with why employee_visible_by_id() grants
-- that access for the directory case.
--
-- public.direct_report_visible(target_id) is a new, narrower function for
-- exactly this class of table: visible to the row's own author, the
-- author's actual direct team lead (resolved the same way
-- employee_visible() resolves team-lead-to-agent pairs elsewhere), and
-- Executive/Head of Technical. No peer branch, no reciprocal agent-sees-lead
-- branch, and no "shared creative resource" branch (graphic_designer/
-- video_editor have no dedicated team-lead role in this system, so for them
-- this correctly reduces to self + HoT + Executive only — nobody else has a
-- standing claim to their personal logs). Team leads and sales similarly
-- have no "their own team lead" role in this system, so the function
-- reduces to self + HoT + Executive for them too — intentional, not a gap.
--
-- Applied to:
--   - extra_notes_select_rls   (was employee_visible_by_id)
--   - daily_logs_select_rls    (was employee_visible_by_id — confirmed no UI
--     feature depends on the peer-visibility case: the only path to view
--     someone else's daily logs, DailyOperationsModule.tsx's employee
--     switcher, is already gated to manager/lead roles client-side, so this
--     closes an API-level gap, not a working feature)
--   - performance_reviews_select_rls (was self OR reviewed_by OR exec/HoT —
--     reviewed_by kept as an ADDITIONAL exception alongside the new
--     function, not replaced, so a review's author never loses access to
--     what they wrote even in an edge case outside the normal reporting
--     chain)
--   - kpi_scores_select_rls    (same change as performance_reviews)
--
-- No insert/update policies change — all four were and remain self-authored
-- only (or, for performance_reviews/kpi_scores, still have no insert policy
-- at all, since no authoring UI exists yet).
-- ============================================================================

begin;

create or replace function public.direct_report_visible(target_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or exists (
      select 1 from public.users u
      where u.id = target_id
        and (
          (public.app_user_role() = 'am_team_lead' and u.role = 'am_agent')
          or (public.app_user_role() = 'media_buying_team_lead' and u.role = 'media_buying_agent')
          or (public.app_user_role() = 'seo_team_lead' and u.role = 'seo_agent')
          or (public.app_user_role() = 'social_media_team_lead' and u.role = 'social_media_agent')
        )
    );
$$;

-- ----------------------------------------------------------------------------
-- extra_notes
-- ----------------------------------------------------------------------------
drop policy if exists "extra_notes_select_rls" on public.extra_notes;
create policy "extra_notes_select_rls" on public.extra_notes
for select
to authenticated
using (public.direct_report_visible(user_id));

-- ----------------------------------------------------------------------------
-- daily_logs
-- ----------------------------------------------------------------------------
drop policy if exists "daily_logs_select_rls" on public.daily_logs;
create policy "daily_logs_select_rls" on public.daily_logs
for select
to authenticated
using (public.direct_report_visible(user_id));

-- ----------------------------------------------------------------------------
-- performance_reviews
-- ----------------------------------------------------------------------------
drop policy if exists "performance_reviews_select_rls" on public.performance_reviews;
create policy "performance_reviews_select_rls" on public.performance_reviews
for select
to authenticated
using (
  public.direct_report_visible(user_id)
  or reviewed_by = public.app_user_id()
);

-- ----------------------------------------------------------------------------
-- kpi_scores
-- ----------------------------------------------------------------------------
drop policy if exists "kpi_scores_select_rls" on public.kpi_scores;
create policy "kpi_scores_select_rls" on public.kpi_scores
for select
to authenticated
using (
  public.direct_report_visible(user_id)
  or reviewed_by = public.app_user_id()
);

commit;
