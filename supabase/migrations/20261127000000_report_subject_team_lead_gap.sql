-- Fixes a real, pre-existing authorization gap (not introduced by, but only just unmasked by,
-- 20261125000000/20261126000000's overload cleanup — while two ambiguous function overloads
-- existed, EVERY employee-scope report pull failed before ever reaching this check, which hid the
-- bug underneath).
--
-- src/lib/reportAgentEligibility.ts's isEligibleReportSubject() has explicitly documented, for a
-- long time, that a built-in department team lead (am_team_lead/media_buying_team_lead/
-- seo_team_lead/social_media_team_lead) IS a valid report subject — both for themselves (pulling
-- their own employee-scope report) and for a global viewer (executive/head_of_technical) pulling
-- theirs. The server-side gate that actually enforces this, report_role_is_subject(text) (current
-- body in 20261107200000_report_workspace_task_sources.sql), was never updated to match: its list
-- only ever covered individual-contributor agent roles (am_agent/media_buying_agent/seo_agent/
-- store_manager/seo_content_agent/seo_backlink_agent/social_media_agent) plus graphic_designer/
-- video_editor and shared-resource/reports-module custom roles — no team lead role at all. Since
-- report_subject_creatable() checks report_role_is_subject(target role) BEFORE its own self-pull
-- or global-viewer branches, a team lead could not be pulled as a report subject by anyone,
-- including themselves, even though report_role_has_module() (the separate, correct list used for
-- module ACCESS) already includes all four team-lead roles and the frontend already offers them as
-- selectable subjects.
--
-- Fix: add the four built-in team-lead roles to report_role_is_subject()'s list. Everything else
-- in report_subject_creatable()'s existing logic (self-pull, executive/head_of_technical's
-- unconditional access, each team lead's own direct-report mapping) already handles a newly-valid
-- subject role correctly with no further changes needed there.
--
-- A second, separate instance of the exact same gap, confirmed live (the actual 403 the product
-- owner hit): 'ai_engineer' is also missing from this list. 20261124000000_ai_engineer_deprivilege
-- (already merged) explicitly reframed ai_engineer as "an ordinary report SUBJECT like any other
-- reports-enabled agent" (see its own comment, and reportAgentEligibility.ts's matching comment on
-- GLOBAL_REPORT_AGENT_PICKER_ROLES) — the frontend already treats ai_engineer as an eligible
-- subject via isEligibleReportSubject()'s isModuleAllowed(role,'reports') fallback, and
-- report_role_has_module() already lists it. report_role_is_subject() was simply never updated to
-- match when that de-privileging migration shipped, so ai_engineer could not be pulled as a report
-- subject by anyone — including themselves — the same failure mode as the team-lead gap above,
-- just for a different role.
begin;

do $$
begin
  if to_regprocedure('public.report_role_is_subject(text)') is null then
    raise exception 'Apply 20261107200000_report_workspace_task_sources.sql first.';
  end if;
end $$;

create or replace function public.report_role_is_subject(p_role text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_role in (
    'am_agent', 'media_buying_agent', 'seo_agent', 'store_manager',
    'seo_content_agent', 'seo_backlink_agent', 'social_media_agent',
    'graphic_designer', 'video_editor',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead',
    'ai_engineer'
  ) or exists (
    select 1
    from public.custom_roles cr
    join public.departments d on d.id = cr.department_id
    where cr.id = p_role and cr.is_active and d.is_active and d.is_shared_resource
  ) or exists (
    select 1
    from public.custom_roles cr
    join public.custom_role_modules crm on crm.role_id = cr.id
    where cr.id = p_role and cr.is_active and crm.module_id = 'reports'
  );
$$;

commit;
