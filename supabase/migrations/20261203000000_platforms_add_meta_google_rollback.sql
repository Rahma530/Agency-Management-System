-- Rollback for 20261203000000_platforms_add_meta_google.sql
-- Safe only if no task_platform_links row (or future mentorship table) references these ids yet —
-- that is the expected state right after applying the forward migration.
begin;

delete from public.platforms
where id in ('meta', 'google')
  and not exists (select 1 from public.task_platform_links where platform_id = public.platforms.id);

commit;
