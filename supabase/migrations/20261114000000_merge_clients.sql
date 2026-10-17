-- merge_clients(p_keep_id, p_duplicate_id) — executive/head_of_technical/ai_engineer only.
--
-- Additive only. Reuses the deletion_log table from 20261113000000_task_hard_delete.sql
-- (entity_type already allows 'client' — anticipated by that migration's own header comment)
-- rather than creating a second audit table.
--
-- No hardcoded table list. Every foreign key -> public.clients is discovered at runtime from
-- pg_constraint (contype = 'f', confrelid = 'public.clients'::regclass) and re-pointed from
-- p_duplicate_id to p_keep_id. A multi-column foreign key is rejected with a clear exception —
-- this function only knows how to repoint a single column's value.
--
-- Table identifiers are never built from a plain concatenated string: every dynamic table
-- reference below passes `v_rec.conrelid::regclass` (the oid from pg_constraint, cast to
-- regclass BEFORE it reaches format()) through plain %s. regclass's own output function then
-- prints the already-resolved, correctly quoted/schema-qualified table name as text — valid
-- directly in a FROM/UPDATE/DELETE target position. (A literal `::regclass` cast written inside
-- the format() template instead — `%s::regclass` — is wrong: %s would substitute the oid's own
-- bare numeral, e.g. `update 17541::regclass set ...`, which is a syntax error — a cast
-- expression is not a valid table reference there. The cast must happen on the value before
-- format() sees it, not in the template.) Column names (never attacker-controlled; read from
-- pg_attribute, the catalog) still go through %I as defense in depth. Values go through %L
-- (format's own literal-escaping specifier).
--
-- Conflict handling: a bulk `update ... set <col> = keep where <col> = duplicate` is tried first
-- per table. If it hits unique_violation (a real unique constraint elsewhere — e.g.
-- platform_connections' unique (client_id, platform_name) — the keep and duplicate client both
-- already have a row that would collide once repointed), the function falls back to row-by-row:
-- each duplicate-side row is moved individually, and the one row that still conflicts alone is
-- deleted instead (counted in related_counts), rather than letting one bad row block every other
-- row in that table from moving.
--
-- assignments is the one deliberate exception to the generic pass above: it has NO unique
-- constraint on (client_id, service_type) at all (confirmed — only a plain, non-unique index),
-- so the unique_violation fallback above would never even fire for it, yet two rows with the same
-- service_type for one client is still a real duplicate the business doesn't want. Handled as its
-- own pre-pass before the generic loop (and excluded from that loop by relation oid): any
-- duplicate-side row whose service_type the keep client already has is deleted outright; every
-- other duplicate-side row is moved normally.
--
-- The duplicate client's own row is snapshotted into deletion_log BEFORE any mutation (so a
-- restore stays possible even though nothing here implements one), then deleted last, once every
-- referencing table has been repointed or cleaned.
begin;

create or replace function public.merge_clients(p_keep_id text, p_duplicate_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_actor_id text := public.app_user_id();
  v_duplicate public.clients;
  v_log_id uuid;
  v_related_counts jsonb := '{}'::jsonb;
  v_assignments_deleted integer := 0;
  v_assignments_moved integer := 0;
  v_rec record;
  v_colname text;
  v_pk_key smallint[];
  v_pk_col text;
  v_table_name text;
  v_moved integer;
  v_deleted integer;
  v_row_id text;
begin
  if v_actor_role not in ('executive', 'head_of_technical', 'ai_engineer') then
    raise exception 'Only executive, head_of_technical, or ai_engineer may merge clients.';
  end if;

  if p_keep_id is null or p_duplicate_id is null then
    raise exception 'p_keep_id and p_duplicate_id are both required.';
  end if;
  if p_keep_id = p_duplicate_id then
    raise exception 'p_keep_id and p_duplicate_id must be different clients.';
  end if;

  select * into v_duplicate from public.clients where id = p_duplicate_id;
  if v_duplicate.id is null then
    raise exception 'Duplicate client % not found.', p_duplicate_id;
  end if;
  if not exists (select 1 from public.clients where id = p_keep_id) then
    raise exception 'Keep client % not found.', p_keep_id;
  end if;

  -- Snapshot BEFORE any mutation — the row that is about to disappear. related_counts is filled
  -- in and the row updated once, after everything below has run.
  insert into public.deletion_log (entity_type, entity_id, entity_name, deleted_by, snapshot, related_counts)
  values ('client', v_duplicate.id, v_duplicate.name, v_actor_id, to_jsonb(v_duplicate), '{}'::jsonb)
  returning id into v_log_id;

  -- assignments special-case (see header comment) — run before the generic loop, which
  -- explicitly skips this table.
  delete from public.assignments
  where client_id = p_duplicate_id
    and service_type in (select service_type from public.assignments where client_id = p_keep_id);
  get diagnostics v_assignments_deleted = row_count;

  update public.assignments set client_id = p_keep_id where client_id = p_duplicate_id;
  get diagnostics v_assignments_moved = row_count;

  v_related_counts := v_related_counts || jsonb_build_object(
    'assignments', jsonb_build_object('moved', v_assignments_moved, 'deleted_duplicates', v_assignments_deleted)
  );

  -- Generic pass: every other FK -> public.clients, discovered at runtime.
  for v_rec in
    select con.conrelid, con.conkey
    from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'public.clients'::regclass
      and con.conrelid <> 'public.assignments'::regclass
  loop
    if array_length(v_rec.conkey, 1) > 1 then
      raise exception 'merge_clients does not support multi-column foreign keys (table %).', v_rec.conrelid::regclass;
    end if;

    select a.attname into v_colname
    from pg_attribute a
    where a.attrelid = v_rec.conrelid and a.attnum = v_rec.conkey[1];

    v_table_name := v_rec.conrelid::regclass::text;
    v_moved := 0;
    v_deleted := 0;

    begin
      execute format('update %s set %I = %L where %I = %L', v_rec.conrelid::regclass, v_colname, p_keep_id, v_colname, p_duplicate_id);
      get diagnostics v_moved = row_count;
    exception when unique_violation then
      -- Row-by-row fallback. This table's own single-column primary key is discovered the same
      -- runtime way (no hardcoded 'id' assumption) — a composite primary key is rejected for the
      -- same reason as a composite foreign key above: there is then no single value to key the
      -- per-row UPDATE/DELETE on.
      select con2.conkey into v_pk_key
      from pg_constraint con2
      where con2.contype = 'p' and con2.conrelid = v_rec.conrelid;

      if v_pk_key is null or array_length(v_pk_key, 1) > 1 then
        raise exception 'merge_clients needs a single-column primary key to resolve conflicts on table % (found none, or a composite key).', v_table_name;
      end if;

      select a.attname into v_pk_col
      from pg_attribute a
      where a.attrelid = v_rec.conrelid and a.attnum = v_pk_key[1];

      for v_row_id in execute format('select %I::text from %s where %I = %L', v_pk_col, v_rec.conrelid::regclass, v_colname, p_duplicate_id)
      loop
        begin
          execute format('update %s set %I = %L where %I = %L', v_rec.conrelid::regclass, v_colname, p_keep_id, v_pk_col, v_row_id);
          v_moved := v_moved + 1;
        exception when unique_violation then
          execute format('delete from %s where %I = %L', v_rec.conrelid::regclass, v_pk_col, v_row_id);
          v_deleted := v_deleted + 1;
        end;
      end loop;
    end;

    v_related_counts := v_related_counts || jsonb_build_object(
      v_table_name, jsonb_build_object('moved', v_moved, 'deleted_duplicates', v_deleted)
    );
  end loop;

  update public.deletion_log set related_counts = v_related_counts where id = v_log_id;

  -- Every referencing row has now either moved to p_keep_id or been deleted as an
  -- unresolvable duplicate — nothing points at p_duplicate_id any more.
  delete from public.clients where id = p_duplicate_id;

  return jsonb_build_object('keep_id', p_keep_id, 'duplicate_id', p_duplicate_id, 'related_counts', v_related_counts);
end;
$$;

revoke all on function public.merge_clients(text, text) from public, anon;
grant execute on function public.merge_clients(text, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- merge_clients_preview(p_keep_id, p_duplicate_id) — read-only dry run for the UI, called before
-- merge_clients() actually runs. Same role gate, same runtime FK discovery, same assignments
-- special-case as merge_clients() above — but STABLE and never mutates.
--
-- For assignments, the count is exact (mirrors merge_clients()'s own pre-pass precisely): moved
-- is the duplicate's non-conflicting rows, deleted_duplicates is the duplicate's rows whose
-- service_type the keep client already has.
--
-- For every other table, this can only report a plain count of the duplicate's rows in that
-- table ("count") — NOT a moved/deleted_duplicates split. Detecting a real conflict there means
-- knowing that table's own unique constraint(s) (e.g. platform_connections' unique (client_id,
-- platform_name)) and replicating merge_clients()'s per-row conflict check against them — work
-- merge_clients() itself only does by actually attempting the update and catching
-- unique_violation. This function deliberately does not replicate that per-table logic (no
-- hardcoded knowledge of any table's unique constraints, same "no hardcoded list" posture as the
-- FK discovery itself) — so this preview is a lower bound on what will move, and an upper bound
-- on it, but is not a guarantee: a generic-table conflict is still only discovered by
-- merge_clients() itself at the real merge.
-- ----------------------------------------------------------------------------
create or replace function public.merge_clients_preview(p_keep_id text, p_duplicate_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_related_counts jsonb := '{}'::jsonb;
  v_rec record;
  v_colname text;
  v_count integer;
  v_assignments_total integer;
  v_assignments_conflict integer;
  v_table_name text;
begin
  if v_actor_role not in ('executive', 'head_of_technical', 'ai_engineer') then
    raise exception 'Only executive, head_of_technical, or ai_engineer may preview a client merge.';
  end if;

  if p_keep_id is null or p_duplicate_id is null then
    raise exception 'p_keep_id and p_duplicate_id are both required.';
  end if;
  if p_keep_id = p_duplicate_id then
    raise exception 'p_keep_id and p_duplicate_id must be different clients.';
  end if;
  if not exists (select 1 from public.clients where id = p_duplicate_id) then
    raise exception 'Duplicate client % not found.', p_duplicate_id;
  end if;
  if not exists (select 1 from public.clients where id = p_keep_id) then
    raise exception 'Keep client % not found.', p_keep_id;
  end if;

  select count(*) into v_assignments_total from public.assignments where client_id = p_duplicate_id;
  select count(*) into v_assignments_conflict
  from public.assignments
  where client_id = p_duplicate_id
    and service_type in (select service_type from public.assignments where client_id = p_keep_id);

  v_related_counts := v_related_counts || jsonb_build_object(
    'assignments', jsonb_build_object('moved', v_assignments_total - v_assignments_conflict, 'deleted_duplicates', v_assignments_conflict)
  );

  for v_rec in
    select con.conrelid, con.conkey
    from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'public.clients'::regclass
      and con.conrelid <> 'public.assignments'::regclass
  loop
    if array_length(v_rec.conkey, 1) > 1 then
      raise exception 'merge_clients_preview does not support multi-column foreign keys (table %).', v_rec.conrelid::regclass;
    end if;

    select a.attname into v_colname
    from pg_attribute a
    where a.attrelid = v_rec.conrelid and a.attnum = v_rec.conkey[1];

    v_table_name := v_rec.conrelid::regclass::text;

    execute format('select count(*) from %s where %I = %L', v_rec.conrelid::regclass, v_colname, p_duplicate_id) into v_count;

    v_related_counts := v_related_counts || jsonb_build_object(v_table_name, jsonb_build_object('count', v_count));
  end loop;

  return v_related_counts;
end;
$$;

revoke all on function public.merge_clients_preview(text, text) from public, anon;
grant execute on function public.merge_clients_preview(text, text) to authenticated, service_role;

commit;
