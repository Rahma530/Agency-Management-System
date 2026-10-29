-- Raise the TABLE-LEVEL check constraints that cap content_text/suggested_text at 12,000
-- characters to 60,000, matching 20261224000000_report_content_text_limit.sql's own RPC-level
-- bump (create_report_draft_v2/save_report_version_v2's own `char_length(p_content_text)>60000`
-- checks). That migration missed these: the FUNCTIONS now accept up to 60,000 characters and
-- never raise "Invalid report content." below that, but the underlying report_content_versions/
-- report_ai_suggestions TABLES still had their own separate 12,000-character CHECK CONSTRAINT
-- (20261107100000_report_workspace_release_hardening.sql) that the insert then hit regardless —
-- "new row for relation \"report_content_versions\" violates check constraint
-- \"report_content_versions_length_check\"". Both checks must move together; this migration is
-- the other half of that same fix.
--
-- reports.creator_note's own 4,000-char cap (reports_creator_note_length_check, same source
-- migration) is untouched — it was never the complaint, and the function-level checks that guard
-- it weren't changed either.
--
-- Also bumps create_report_ai_suggestion's own matching function-level check (>12000 -> >60000,
-- same source migration: 20261107300000_report_workspace_lifecycle_hardening.sql) so "AI Summary"
-- on a report large enough to hit this doesn't fail the same way the manual save just did —
-- function body is otherwise byte-identical to that migration's version.
--
-- Idempotent: drop constraint if exists / add constraint, create or replace function. No
-- rollback file — reverting means re-applying 20261107100000_report_workspace_release_hardening.
-- sql's two constraints (char_length(...) between 1 and 12000) and
-- 20261107300000_report_workspace_lifecycle_hardening.sql's create_report_ai_suggestion body.

begin;

alter table public.report_content_versions drop constraint if exists report_content_versions_length_check;
alter table public.report_content_versions add constraint report_content_versions_length_check
  check (char_length(content_text) between 1 and 60000);

alter table public.report_ai_suggestions drop constraint if exists report_ai_suggestions_length_check;
alter table public.report_ai_suggestions add constraint report_ai_suggestions_length_check
  check (char_length(suggested_text) between 1 and 60000);

create or replace function public.create_report_ai_suggestion(p_report_id text,p_base_version_id text,p_source_hash text,p_suggested_text text)
returns public.report_ai_suggestions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_r public.reports%rowtype; v_b public.report_content_versions%rowtype; v_s public.report_ai_suggestions%rowtype; v_allowed text;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_suggested_text,'')),'') is null or char_length(p_suggested_text)>60000 then raise exception 'Invalid suggestion.' using errcode='22023'; end if;
  select * into v_r from public.reports where id=p_report_id for update;
  if not found or v_r.archived_at is not null or v_r.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  if v_r.current_version_id is distinct from p_base_version_id or v_r.source_hash is distinct from p_source_hash then raise exception 'Report changed.' using errcode='40001'; end if;
  select * into v_b from public.report_content_versions where id=p_base_version_id and report_id=p_report_id;
  if not found then raise exception 'Base version unavailable.' using errcode='40001'; end if;
  select concat_ws(E'\n',v_b.content_text,v_r.creator_note,string_agg(source_date::text||' '||case when source_kind='task'
    then concat_ws(' ',snapshot->>'title',snapshot->>'task_type',snapshot->>'task_type_other',snapshot->>'team',snapshot->>'status',snapshot->>'work_kind',snapshot->>'evidence_dates')
    else coalesce(snapshot->>'summary_text',snapshot->>'note_text','') end,E'\n' order by source_date,source_kind,source_id))
    into v_allowed from public.report_source_items where report_id=p_report_id;
  if exists(select token from unnest(public.report_numeric_tokens(p_suggested_text)) token except select token from unnest(public.report_numeric_tokens(v_allowed)) token)
    then raise exception 'AI suggestion contains an unsupported number.' using errcode='22023'; end if;
  insert into public.report_ai_suggestions(report_id,base_version_id,source_hash,suggested_text,requested_by)
    values(p_report_id,p_base_version_id,p_source_hash,p_suggested_text,public.app_user_id()) returning * into v_s;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'ai_requested',jsonb_build_object('suggestion_id',v_s.id));
  return v_s;
end $$;

commit;
