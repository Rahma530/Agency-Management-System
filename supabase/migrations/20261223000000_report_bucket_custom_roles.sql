-- report_bucket_for_user: resolve an admin-created CUSTOM role (public.custom_roles,
-- 20261101400000_custom_roles_departments_foundation.sql) via its own department, instead of
-- always falling into 'other'.
--
-- Bug: 20261127000000_report_service_bucket_filter.sql's report_bucket_for_user only recognized a
-- fixed list of BUILT-IN role strings (via daily_log_author_service) plus graphic_designer/
-- video_editor. Any admin-created custom role — SEO/Social Media/Media Buying/Creative & Design
-- included — fell straight through to 'other', which had two visible effects on a client-scope
-- report: (1) that author's work-log lines were mislabeled under "Other updates" in the exported
-- text instead of their real department's section, and (2) narrowing the picker to a specific
-- service bucket (e.g. "SEO" alone, without "Other updates") silently DROPPED that author's
-- entries from the pull entirely, since the server never considered them a match for 'seo'.
--
-- Fix: when the role isn't one of the built-in strings already handled, look up
-- custom_roles.department_id for it and map that department to the same bucket its real
-- ServiceType equivalent uses — seo/media_buying/social_media map 1:1, creative_design (this
-- app's other shared-resource pool, same as graphic_designer/video_editor) maps to 'creative'.
-- programming/account_management/ai_engineering stay unmapped (-> 'other') on purpose: a custom
-- role there has no single client-facing service to attribute a work log to, exactly like their
-- built-in counterparts (am_agent, ai_engineer) today. Mirrors
-- src/lib/workLogServiceClassification.ts's classifyWorkLogService, which this migration's own
-- PR also updated for the client-side section-labeling half of this same bug, and
-- reportingEngine.ts's existing getDepartmentMappedServiceType (same department ids, same
-- reasoning for what's left unmapped).
--
-- Idempotent: create or replace. No rollback file — reverting means re-applying
-- 20261127000000_report_service_bucket_filter.sql's own report_bucket_for_user body.

begin;

create or replace function public.report_bucket_for_user(p_user_id text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when (select u.role from public.users u where u.id = p_user_id) in ('graphic_designer','video_editor')
      then 'creative'
    when public.daily_log_author_service(p_user_id) is not null
      then public.daily_log_author_service(p_user_id)
    else coalesce(
      (
        select case cr.department_id
          when 'seo' then 'seo'
          when 'media_buying' then 'media_buying'
          when 'social_media' then 'social_media'
          when 'creative_design' then 'creative'
          else null
        end
        from public.users u
        join public.custom_roles cr on cr.id = u.role
        where u.id = p_user_id
      ),
      'other'
    )
  end;
$$;

commit;
