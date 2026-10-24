-- Run this AFTER applying 20261205000000_mentorship_oversight.sql, BEFORE merging.
-- Baseline-relative: picks real, existing employees (no hardcoded ids/counts), tests the two RPCs
-- end to end, then rolls itself back so nothing from this test run is kept.
begin;

do $$
declare
  v_overseer text;
  v_buyer text;
  v_oversight_before int;
begin
  select id into v_overseer from public.users
    where role in ('executive', 'head_of_technical', 'media_buying_team_lead') limit 1;
  select id into v_buyer from public.users where role = 'media_buying_agent' limit 1;

  if v_overseer is null or v_buyer is null then
    raise exception 'Need at least one Executive/HOT/Media Buying Team Leader AND one media_buying_agent in users to test against — none found.';
  end if;

  select count(*) into v_oversight_before from public.mentorship_oversight;

  -- add should succeed and be idempotent
  perform public.add_mentorship_oversight(v_overseer, v_buyer);
  perform public.add_mentorship_oversight(v_overseer, v_buyer);

  if not exists (
    select 1 from public.mentorship_oversight
    where overseer_id = v_overseer and media_buyer_id = v_buyer
  ) then
    raise exception 'add_mentorship_oversight did not create the expected row';
  end if;

  if (select count(*) from public.mentorship_oversight) <> v_oversight_before + 1 then
    raise exception 'add_mentorship_oversight was not idempotent (row count grew more than once)';
  end if;

  -- remove should clean it back up
  perform public.remove_mentorship_oversight(v_overseer, v_buyer);

  if exists (
    select 1 from public.mentorship_oversight
    where overseer_id = v_overseer and media_buyer_id = v_buyer
  ) then
    raise exception 'remove_mentorship_oversight did not delete the row';
  end if;

  if (select count(*) from public.mentorship_oversight) <> v_oversight_before then
    raise exception 'mentorship_oversight row count did not return to baseline after remove';
  end if;

  raise notice 'All mentorship_oversight checks passed.';
end $$;

rollback;

do $$ begin raise notice 'TEST_OK_ROLLED_BACK'; end $$;
