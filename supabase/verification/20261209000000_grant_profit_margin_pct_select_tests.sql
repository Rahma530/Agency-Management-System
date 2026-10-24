-- Run this AFTER applying 20261209000000_grant_profit_margin_pct_select.sql.
-- Confirms authenticated can now select profit_margin_pct from public.clients without error,
-- using a real existing client and a real executive persona. Read-only; nothing to roll back
-- (no rows written), but wrapped in begin/rollback anyway for consistency.
begin;

do $$
declare
  v_client_id text;
  v_exec_auth_id text;
  v_margin numeric;
begin
  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'Need at least one client to test against — none found.';
  end if;

  select auth_id into v_exec_auth_id from public.users where role = 'executive' limit 1;
  if v_exec_auth_id is null then
    raise exception 'Need at least one executive in users to test against — none found.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth_id)::text, true);
  set local role authenticated;

  -- This is the exact failure mode being fixed: selecting profit_margin_pct by name used to
  -- raise "permission denied for column profit_margin_pct" here.
  select profit_margin_pct into v_margin from public.clients where id = v_client_id;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  raise notice 'profit_margin_pct selected successfully (value: %). Grant is working.', v_margin;
end $$;

rollback;

do $$ begin raise notice 'TEST_OK_ROLLED_BACK'; end $$;
