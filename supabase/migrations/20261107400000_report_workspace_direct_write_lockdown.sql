-- Report Workspace staged-release cleanup. Apply only after migration 073, ai-router, and the
-- v2 frontend are live. Keeping this separate lets the old frontend continue its legacy writes
-- during the short cross-system rollout without retaining that bypass after the release.
begin;

do $$
begin
  if to_regprocedure('public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text)') is null
    or to_regprocedure('public.save_report_version_v2(text,text,text,text)') is null then
    raise exception 'Apply 20261107300000_report_workspace_lifecycle_hardening.sql first.';
  end if;
end $$;

-- Migration 070 explicitly granted these legacy comparison-flow columns. A table-level revoke
-- does not remove column ACLs, so revoke the historical grant explicitly before the blanket
-- defensive pass below.
revoke update (status,approved_by,approved_at,comparison_id,period,client_id,type,updated_at)
  on public.reports from authenticated;

-- RPCs are the only write boundary for the released workspace. Remove both table-level and any
-- current column-level INSERT/UPDATE grants for browser roles on every report-owned table.
-- DELETE has no column form and is covered by the table-level revoke.
do $$
declare v_table text; v_columns text;
begin
  foreach v_table in array array[
    'reports','report_content_versions','report_source_items','report_ai_suggestions',
    'report_audit_events','report_deletion_tombstones'
  ] loop
    execute format('revoke insert, update, delete on table public.%I from public, anon, authenticated',v_table);
    select string_agg(format('%I',a.attname),',' order by a.attnum) into v_columns
    from pg_attribute a
    where a.attrelid=format('public.%I',v_table)::regclass and a.attnum>0 and not a.attisdropped;
    execute format('revoke insert (%s) on table public.%I from public, anon, authenticated',v_columns,v_table);
    execute format('revoke update (%s) on table public.%I from public, anon, authenticated',v_columns,v_table);
  end loop;
end $$;

commit;
