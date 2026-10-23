-- HISTORICAL SERVICE BRIEF VISIBILITY RESTORATION TEMPLATE — DO NOT RUN UNEDITED.
-- STATIC REVIEW ONLY; NOT EXECUTED BY CODEX.
--
-- Populate approved_brief_publications with exact Production brief IDs, an explicitly approved
-- publication timestamp, and a non-empty business evidence reference. Never infer approval from
-- row count, created_at, updated_at, version, field completeness, or revision existence.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temporary table approved_brief_publications (
  brief_id text primary key,
  expected_service_type text not null check (
    expected_service_type in ('seo', 'social_media', 'media_buying', 'interface')
  ),
  approved_publication_at timestamptz not null,
  evidence_reference text not null check (btrim(evidence_reference) <> '')
) on commit drop;

-- BUSINESS OWNER: replace this empty SELECT with explicit, approved VALUES, for example:
-- insert into approved_brief_publications
--   (brief_id, expected_service_type, approved_publication_at, evidence_reference)
-- values
--   ('EXACT_APPROVED_BRIEF_ID', 'seo', 'APPROVED_TIMESTAMPTZ', 'TICKET/APPROVAL REFERENCE');

do $$
declare
  v_approved_count bigint;
begin
  if to_regclass('public.briefs') is null then
    raise exception 'Restoration preflight failed: public.briefs is missing.';
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'briefs'
      and c.column_name = 'submitted_at'
      and c.udt_name = 'timestamptz'
      and c.is_nullable = 'YES'
      and c.column_default is null
  ) then
    raise exception 'Restoration preflight failed: submitted_at is not nullable timestamptz with no default.';
  end if;

  if exists (
    select 1
    from (values ('id'), ('client_id'), ('service_type')) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'briefs'
        and c.column_name = required.column_name
    )
  ) then
    raise exception 'Restoration preflight failed: public.briefs is missing an expected identity, client, or service column.';
  end if;

  select count(*) into v_approved_count from approved_brief_publications;
  if v_approved_count = 0 then
    raise exception 'TEMPLATE STOP: add exact business-approved brief IDs and evidence before running this restoration.';
  end if;

  if exists (
    select 1
    from approved_brief_publications a
    where a.approved_publication_at > clock_timestamp()
  ) then
    raise exception 'Restoration preflight failed: a historical publication timestamp is in the future.';
  end if;

  if exists (
    select 1
    from approved_brief_publications a
    left join public.briefs b on b.id = a.brief_id
    where b.id is null
  ) then
    raise exception 'Restoration preflight failed: at least one approved brief ID does not exist.';
  end if;

  if exists (
    select 1
    from approved_brief_publications a
    join public.briefs b on b.id = a.brief_id
    where b.service_type is distinct from a.expected_service_type
  ) then
    raise exception 'Restoration preflight failed: at least one brief has a different service_type than the business-approved value; no rows were changed.';
  end if;

  if exists (
    select 1
    from approved_brief_publications a
    join public.briefs b on b.id = a.brief_id
    where b.submitted_at is not null
  ) then
    raise exception 'Restoration preflight failed: at least one approved brief is already classified; no rows were changed.';
  end if;
end
$$;

do $$
declare
  v_expected_count bigint;
  v_updated_count bigint;
begin
  select count(*) into v_expected_count from approved_brief_publications;

  update public.briefs b
  set submitted_at = a.approved_publication_at
  from approved_brief_publications a
  where b.id = a.brief_id
    and b.submitted_at is null;

  get diagnostics v_updated_count = row_count;

  if v_updated_count <> v_expected_count then
    raise exception 'Restoration failed: expected % rows but updated %; transaction rolled back.', v_expected_count, v_updated_count;
  end if;
end
$$;

select
  b.id,
  b.client_id,
  b.service_type,
  a.expected_service_type,
  b.submitted_at,
  a.evidence_reference
from public.briefs b
join approved_brief_publications a on a.brief_id = b.id
order by b.id;

commit;


