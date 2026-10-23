-- Make the report archive reason optional without changing the archive_report_v2 RPC signature,
-- authorization, row lock, optimistic-concurrency check, or audit event.
-- Repository migration only: applying it to a database is a separate authorized release action.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare v_nullable text;
begin
  if to_regclass('public.reports') is null
    or to_regclass('public.report_audit_events') is null
    or to_regprocedure('public.archive_report_v2(text,text,boolean,text)') is null
    or to_regprocedure('public.report_row_editable(text)') is null then
    raise exception 'Archive-reason migration prerequisites are missing.';
  end if;

  select is_nullable into v_nullable
  from information_schema.columns
  where table_schema = 'public' and table_name = 'reports' and column_name = 'archive_reason';
  if v_nullable is distinct from 'YES' then
    raise exception 'reports.archive_reason must exist and remain nullable.';
  end if;
end $$;

create or replace function public.archive_report_v2(
  p_report_id text,
  p_reason text,
  p_restore boolean,
  p_expected_version_id text
) returns public.reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public.reports%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.report_row_editable(p_report_id) then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;

  select * into v_report from public.reports where id = p_report_id for update;
  if not found then raise exception 'Report missing.'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then
    raise exception 'Report changed; refresh before changing archive state.' using errcode = '40001';
  end if;

  if p_restore then
    if v_report.archived_at is null then
      raise exception 'Report is not archived.' using errcode = '55000';
    end if;
    update public.reports
    set archived_at = null, archived_by = null, archive_reason = null, updated_at = now()
    where id = p_report_id
    returning * into v_report;
    insert into public.report_audit_events(report_id, actor_id, action)
    values (p_report_id, public.app_user_id(), 'restored');
  else
    if v_report.archived_at is not null then
      raise exception 'Report is already archived.' using errcode = '55000';
    end if;
    update public.reports
    set archived_at = now(), archived_by = public.app_user_id(), archive_reason = v_reason, updated_at = now()
    where id = p_report_id
    returning * into v_report;
    insert into public.report_audit_events(report_id, actor_id, action, metadata)
    values (
      p_report_id,
      public.app_user_id(),
      'archived',
      jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'expected_version_id', p_expected_version_id))
    );
  end if;
  return v_report;
end $$;

revoke all on function public.archive_report_v2(text,text,boolean,text) from public, anon;
grant execute on function public.archive_report_v2(text,text,boolean,text) to authenticated;

commit;
