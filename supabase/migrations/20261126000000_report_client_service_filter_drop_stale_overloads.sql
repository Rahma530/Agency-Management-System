-- Hotfix for 20261125000000_report_client_service_filter.sql.
--
-- `create or replace function` only replaces an EXISTING function when its argument TYPE LIST is
-- identical. Adding a trailing `p_service_filter text default null` parameter changed the argument
-- type list (e.g. preview_report_sources_v2 went from 7 types to 8), so that migration did not
-- replace the original functions at all — it created a SECOND, separate overload alongside each
-- original one. Confirmed live in production:
--   preview_report_sources_v2  -> both a 7-arg and an 8-arg version now exist
--   report_source_manifest_v2  -> both a 7-arg and an 8-arg version now exist
--   create_report_draft_v2     -> both a 12-arg and a 13-arg version now exist
--
-- Any caller that still invokes one of these by NAMED parameters without p_service_filter (the
-- App.tsx comparison-filing flow, by design — it was deliberately left unchanged in the previous
-- migration) now matches BOTH overloads at once: the old one exactly, and the new one via its
-- p_service_filter default. Postgres cannot pick between two equally-valid candidates and raises
-- "function ... is not unique" (42725) / PostgREST surfaces this as "Could not choose the best
-- candidate function" (PGRST203) — breaking that call path entirely, not just the new filter
-- feature.
--
-- Fix: drop the three stale, pre-filter overloads now that the new ones are confirmed live and
-- every current frontend call site already uses them. The legacy, positional-call wrapper
-- create_report_draft(...) (8 args, unaffected by this migration) calls report_source_manifest_v2/
-- create_report_draft_v2 positionally with exactly the old arg count; once the old overloads are
-- gone, those positional calls resolve cleanly to the remaining (8-arg/13-arg) function using its
-- p_service_filter default — no change needed there.
begin;

do $$
begin
  if to_regprocedure('public.preview_report_sources_v2(text,text,text,text,text[],date,date,text)') is null
    or to_regprocedure('public.report_source_manifest_v2(text,text,text,text,text[],date,date,text)') is null
    or to_regprocedure('public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text,text)') is null then
    raise exception 'Apply 20261125000000_report_client_service_filter.sql first — the new (p_service_filter) overloads must exist before the old ones are dropped.';
  end if;
end $$;

drop function if exists public.preview_report_sources_v2(text,text,text,text,text[],date,date);
drop function if exists public.report_source_manifest_v2(text,text,text,text,text[],date,date);
drop function if exists public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text);

commit;
