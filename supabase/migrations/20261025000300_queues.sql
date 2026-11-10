-- S2 (#23): queue configuration, counters, ticket counters and the service day.
--
-- Ticket numbers are keyed by (queue, prefix, service_day), so they restart each local day without
-- a reset job (technical-design.md 3.4). Queue state changes go through api.set_queue_state (V4),
-- which bumps queues.version and writes the audit/realtime signals; direct table edits are for config.

create type api.queue_state as enum ('open', 'paused', 'closed');
grant usage on type api.queue_state to anon, authenticated, service_role;

create table app.queues (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  ticket_prefix text not null default 'A' check (ticket_prefix ~ '^[A-Z]{1,3}$'),
  manual_state api.queue_state not null default 'open',
  -- Public realtime topic qpulse:{pulse_id}. Random and distinct from id so the topic reveals nothing.
  pulse_id uuid not null unique default gen_random_uuid(),
  servers_on_duty int not null default 1 check (servers_on_duty >= 0),
  capacity int check (capacity > 0), -- null = unlimited
  join_rate_per_min int not null default 60 check (join_rate_per_min > 0),
  show_eta boolean not null default true,
  sort_order int not null default 0,
  version bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  unique (org_id, id),
  unique (org_id, location_id, id)
);
create index queues_location_idx on app.queues (location_id);

create table app.services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  queue_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text,
  -- Drives the ETA until learned durations replace it (W-2, phase 2a).
  expected_minutes int not null default 10 check (expected_minutes between 1 and 600),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id, queue_id) references app.queues (org_id, location_id, id) on delete cascade,
  unique (org_id, id),
  unique (org_id, queue_id, id)
);
create index services_queue_idx on app.services (queue_id);

create table app.counters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  label text not null check (length(btrim(label)) between 1 and 40),
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  unique (org_id, id),
  unique (org_id, location_id, id)
);

create table app.ticket_counters (
  org_id uuid not null,
  queue_id uuid not null,
  prefix text not null,
  service_day date not null,
  last_value int not null,
  primary key (queue_id, prefix, service_day),
  foreign key (org_id, queue_id) references app.queues (org_id, id) on delete cascade
);

create trigger forbid_org_change before update on app.queues
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.services
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.counters
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.queues
  for each row execute function private.touch_updated_at();

------------------------------------------------------------------------------------------------
-- Service day and ticket numbers
------------------------------------------------------------------------------------------------

create function private.service_day(p_location_id uuid, p_at timestamptz default now())
returns date
language sql stable set search_path = '' as $$
  select ((p_at at time zone l.tz) - l.day_boundary)::date
  from app.locations l
  where l.id = p_location_id
$$;
comment on function private.service_day(uuid, timestamptz) is
  'The location''s business day containing p_at: local date of (p_at in the location timezone '
  'minus day_boundary). With the default 04:00 boundary, 01:30 local belongs to the previous day. '
  'Null for an unknown location.';

create function private.next_ticket(p_queue_id uuid, p_prefix text, p_service_day date)
returns int
language sql volatile set search_path = '' as $$
  insert into app.ticket_counters (org_id, queue_id, prefix, service_day, last_value)
  select q.org_id, q.id, p_prefix, p_service_day, 1 from app.queues q where q.id = p_queue_id
  on conflict (queue_id, prefix, service_day)
    do update set last_value = app.ticket_counters.last_value + 1
  returning last_value
$$;
comment on function private.next_ticket(uuid, text, date) is
  'Next ticket number for (queue, prefix, service day), starting at 1. Concurrency-safe: the '
  'upsert serializes callers on the counter row. Called only by definer functions.';

grant execute on function private.service_day(uuid, timestamptz) to authenticated, service_role;
revoke all on function private.next_ticket(uuid, text, date) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Row-level security: config is read by members and devices of the location and managed by
-- managers and up. Nothing is deleted through the API (queues and counters are archived).
------------------------------------------------------------------------------------------------

alter table app.queues enable row level security;
alter table app.services enable row level security;
alter table app.counters enable row level security;
alter table app.ticket_counters enable row level security;

create policy queues_select on app.queues for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy queues_insert on app.queues for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy queues_update on app.queues for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));

create policy services_select on app.services for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy services_insert on app.services for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy services_update on app.services for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));

create policy counters_select on app.counters for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy counters_insert on app.counters for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy counters_update on app.counters for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));

-- Written only by private.next_ticket; managers may look when debugging numbering.
create policy ticket_counters_select on app.ticket_counters for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
