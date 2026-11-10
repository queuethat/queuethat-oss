-- 2P-APT1 (#157): booking policies, availability rules/exceptions and capacity rules.
-- Config CRUD is direct table access under RLS; slot computation lives in 2P-APT2 (#158).
-- Local times are interpreted in the location timezone (technical-design.md 3.4).

create type app.capacity_scope as enum ('slot', 'day');
create type app.availability_kind as enum ('unavailable', 'extra');

-- One policy per service. location_id is derived from the service so RLS can scope by location.
create table app.booking_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  bookable boolean not null default false,
  slot_minutes int not null default 30 check (slot_minutes >= 5),
  slot_offset_minutes int not null default 0 check (slot_offset_minutes >= 0),
  -- null = the service's expected_minutes
  duration_minutes int check (duration_minutes between 1 and 600),
  buffer_before_minutes int not null default 0 check (buffer_before_minutes >= 0),
  buffer_after_minutes int not null default 0 check (buffer_after_minutes >= 0),
  min_notice_minutes int not null default 60 check (min_notice_minutes >= 0),
  max_days_ahead int not null default 30 check (max_days_ahead between 1 and 365),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (slot_offset_minutes < slot_minutes),
  foreign key (org_id, service_id) references app.services (org_id, id) on delete cascade,
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  unique (service_id)
);

create table app.availability_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  staff_user_id uuid, -- null = any staff
  service_id uuid,    -- null = all services
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  starts time not null,
  ends time not null, -- ends < starts crosses midnight, like business_hours
  valid_from date,
  valid_to date,
  check (starts <> ends),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  foreign key (org_id, service_id) references app.services (org_id, id) on delete cascade,
  foreign key (org_id, staff_user_id) references app.memberships (org_id, user_id) on delete cascade
);
create index availability_rules_location_idx on app.availability_rules (location_id, weekday);

create table app.availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  staff_user_id uuid,
  local_date date not null,
  kind app.availability_kind not null,
  starts time, -- null starts and ends = the whole day
  ends time,
  note text,
  check ((starts is null) = (ends is null)),
  check (starts is null or starts <> ends),
  check (kind = 'unavailable' or starts is not null),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  foreign key (org_id, staff_user_id) references app.memberships (org_id, user_id) on delete cascade
);
create index availability_exceptions_location_idx on app.availability_exceptions (location_id, local_date);

-- Specific date wins over weekday wins over the default (both null).
create table app.capacity_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  scope app.capacity_scope not null,
  weekday smallint check (weekday between 0 and 6),
  local_date date,
  capacity int not null check (capacity >= 0),
  check (weekday is null or local_date is null),
  foreign key (org_id, service_id) references app.services (org_id, id) on delete cascade,
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);
create unique index capacity_rules_key on app.capacity_rules (service_id, scope, weekday, local_date) nulls not distinct;

grant usage on type app.capacity_scope, app.availability_kind to authenticated, service_role;

-- Pins location_id to the service's location so the two can never disagree.
create function private.set_service_location() returns trigger
language plpgsql set search_path = '' as $$
begin
  select s.location_id into new.location_id from app.services s
  where s.org_id = new.org_id and s.id = new.service_id;
  return new;
end $$;
comment on function private.set_service_location() is
  'BEFORE trigger: copies location_id from the row''s service. A foreign service leaves it null and the insert fails.';

create function private.bump_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
comment on function private.bump_version() is 'BEFORE UPDATE trigger: increments version and touches updated_at.';

create trigger set_location before insert or update of service_id on app.booking_policies
  for each row execute function private.set_service_location();
create trigger set_location before insert or update of service_id on app.capacity_rules
  for each row execute function private.set_service_location();
create trigger bump_version before update on app.booking_policies
  for each row execute function private.bump_version();

do $$
declare t text;
begin
  foreach t in array array['booking_policies', 'availability_rules', 'availability_exceptions', 'capacity_rules'] loop
    execute format('create trigger forbid_org_change before update on app.%I
                    for each row execute function private.forbid_org_change()', t);
    execute format('create trigger audit_row after insert or update or delete on app.%I
                    for each row execute function private.audit_row()', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for select to authenticated
                    using ((select private.has_role(org_id, location_id, ''staff'')))', t || '_select', t);
    execute format('create policy %I on app.%I for insert to authenticated
                    with check ((select private.has_role(org_id, location_id, ''manager'')))', t || '_insert', t);
    execute format('create policy %I on app.%I for update to authenticated
                    using ((select private.has_role(org_id, location_id, ''manager'')))
                    with check ((select private.has_role(org_id, location_id, ''manager'')))', t || '_update', t);
    execute format('create policy %I on app.%I for delete to authenticated
                    using ((select private.has_role(org_id, location_id, ''manager'')))', t || '_delete', t);
  end loop;
end $$;
