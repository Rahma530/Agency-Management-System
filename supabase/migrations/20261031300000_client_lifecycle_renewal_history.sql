begin;

-- Preserve the distinction between a confirmed first renewal (0), an existing
-- renewal history (> 0), and legacy or incomplete data (null).
alter table public.clients
  add column renewal_history_count integer;

alter table public.clients
  add constraint clients_renewal_history_count_check
  check (renewal_history_count is null or renewal_history_count >= 0);

-- Store each continuous period during which a client worked with KMS. Tenure is
-- derived from these dates rather than stored as a separate value.
create table public.client_lifecycle_periods (
  id text primary key,
  client_id text not null references public.clients (id),
  started_on date not null,
  ended_on date,
  closure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_lifecycle_periods_date_order_check
    check (ended_on is null or ended_on >= started_on)
);

create unique index idx_client_lifecycle_periods_one_open
  on public.client_lifecycle_periods (client_id)
  where ended_on is null;

create index idx_client_lifecycle_periods_client_started_on
  on public.client_lifecycle_periods (client_id, started_on);

-- Record completed renewal events without changing the existing clients
-- renewal snapshot fields.
create table public.client_renewal_events (
  id text primary key,
  client_id text not null references public.clients (id),
  completed_target_date date not null,
  actual_renewal_date date not null,
  renewal_sequence integer not null,
  created_at timestamptz not null default now(),
  recorded_by text not null references public.users (id),
  constraint client_renewal_events_sequence_positive_check
    check (renewal_sequence > 0),
  constraint client_renewal_events_client_sequence_key
    unique (client_id, renewal_sequence)
);

create index idx_client_renewal_events_client_actual_date
  on public.client_renewal_events (client_id, actual_renewal_date);

alter table public.client_lifecycle_periods enable row level security;
alter table public.client_renewal_events enable row level security;

-- The parent clients lookup is evaluated under the caller's existing client
-- SELECT policy, so history visibility cannot exceed client visibility.
create policy "client_lifecycle_periods_select_rls"
  on public.client_lifecycle_periods
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.clients c
      where c.id = client_lifecycle_periods.client_id
    )
  );

create policy "client_renewal_events_select_rls"
  on public.client_renewal_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.clients c
      where c.id = client_renewal_events.client_id
    )
  );

-- Phase 1 intentionally exposes no direct authenticated write path. Later
-- transactional operations can add narrowly scoped mutation behavior.
revoke all on public.client_lifecycle_periods from anon, authenticated;
revoke all on public.client_renewal_events from anon, authenticated;
grant select on public.client_lifecycle_periods to authenticated;
grant select on public.client_renewal_events to authenticated;

commit;
