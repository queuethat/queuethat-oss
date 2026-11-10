-- S1 (#22): tenancy core. Organizations, memberships, locations, hours, devices, slug redirects,
-- the role helpers every policy uses, and api.create_organization.
--
-- Conventions every later migration follows:
--   * Every tenant table has org_id NOT NULL, and children reference parents through composite
--     foreign keys (org_id, parent_id) so a row can never point across tenants.
--   * org_id is immutable (private.forbid_org_change), which is what "WITH CHECK pins org_id" means:
--     even a member of two orgs cannot move a row between them.
--   * Policies are one per command and call private.has_role / private.is_device wrapped in
--     (select ...) so Postgres evaluates them once per statement.
--   * Domain errors are raised as `raise exception '<code>'` with errcode P0001; the message is the
--     stable code clients map in packages/domain/src/errors.ts.

------------------------------------------------------------------------------------------------
-- Types
------------------------------------------------------------------------------------------------

-- Declaration order is the role ladder: comparisons like role >= 'manager' rely on it.
create type app.member_role as enum ('staff', 'manager', 'admin', 'owner');
create type app.device_kind as enum ('display', 'kiosk');

------------------------------------------------------------------------------------------------
-- Generic trigger helpers
------------------------------------------------------------------------------------------------

create function private.forbid_org_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

------------------------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------------------------

create table app.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  logo_path text,
  default_locale text not null default 'en',
  legal_name text,
  postal_address text,
  support_contact text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.memberships (
  org_id uuid not null references app.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role app.member_role not null,
  -- null = every location in the org
  location_ids uuid[],
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on app.memberships (user_id);

create table app.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Printed on QR posters as /q/{slug}. Immutable; renames go through slug_redirects.
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 64),
  tz text not null,
  -- Local time at which a new service day starts. 04:00 keeps a bar open until 2 a.m. on one day.
  day_boundary interval not null default '04:00'
    check (day_boundary >= interval '0' and day_boundary < interval '24 hours'),
  last_rollover_day date,
  address text,
  contact text,
  -- Names on a public TV are a disclosure to the room (technical-design.md 6). Off by default.
  display_names_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);

create table app.business_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  opens time not null,
  closes time not null, -- closes < opens means the period crosses midnight
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);
create index business_hours_location_idx on app.business_hours (location_id, weekday);

create table app.hours_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  date date not null,
  closed boolean not null default false,
  opens time,
  closes time,
  note text,
  check (closed or (opens is not null and closes is not null)),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);
create index hours_exceptions_location_idx on app.hours_exceptions (location_id, date);

create table app.devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  kind app.device_kind not null,
  name text not null default '',
  auth_user_id uuid unique references auth.users (id) on delete set null,
  scopes text[] not null default '{}',
  last_seen_at timestamptz,
  app_version text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);

-- Old public slugs keep resolving after a location is renamed, so printed posters never break.
create table app.slug_redirects (
  old_slug text primary key,
  org_id uuid not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade
);

------------------------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------------------------

create function private.check_location() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    raise exception 'slug_immutable';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.tz) then
    raise exception 'invalid_timezone';
  end if;
  return new;
end $$;

create trigger check_location before insert or update on app.locations
  for each row execute function private.check_location();

create trigger forbid_org_change before update on app.memberships
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.locations
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.business_hours
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.hours_exceptions
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.devices
  for each row execute function private.forbid_org_change();

create trigger touch_updated_at before update on app.organizations
  for each row execute function private.touch_updated_at();
create trigger touch_updated_at before update on app.locations
  for each row execute function private.touch_updated_at();

------------------------------------------------------------------------------------------------
-- Role helpers
------------------------------------------------------------------------------------------------

create function private.has_role(p_org_id uuid, p_location_id uuid, p_min_role app.member_role)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.memberships m
    where m.user_id = (select auth.uid())
      and m.org_id = p_org_id
      and m.role >= p_min_role
      and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
  )
$$;
comment on function private.has_role(uuid, uuid, app.member_role) is
  'True when the caller is a member of the org with at least p_min_role. With a location, the '
  'membership must cover it (location_ids null = all). With p_location_id null, any membership '
  'in the org counts. The only role check policies and api functions use.';

create function private.is_device(p_org_id uuid, p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.devices d
    where d.auth_user_id = (select auth.uid())
      and d.revoked_at is null
      and d.org_id = p_org_id
      and (p_location_id is null or d.location_id = p_location_id)
  )
$$;
comment on function private.is_device(uuid, uuid) is
  'True when the caller is a paired, unrevoked display or kiosk of that org (and location, if '
  'given). Reads app.devices rather than JWT claims so revocation applies on the next request.';

create function private.device_kind() returns app.device_kind
language sql stable security definer set search_path = '' as $$
  select d.kind from app.devices d
  where d.auth_user_id = (select auth.uid()) and d.revoked_at is null
$$;
comment on function private.device_kind() is
  'The caller''s device kind, or null when the caller is not an active paired device.';

grant execute on function private.has_role(uuid, uuid, app.member_role) to authenticated, service_role;
grant execute on function private.is_device(uuid, uuid) to authenticated, service_role;
grant execute on function private.device_kind() to authenticated, service_role;
grant usage on type app.member_role, app.device_kind to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Row-level security
------------------------------------------------------------------------------------------------

alter table app.organizations enable row level security;
alter table app.memberships enable row level security;
alter table app.locations enable row level security;
alter table app.business_hours enable row level security;
alter table app.hours_exceptions enable row level security;
alter table app.devices enable row level security;
alter table app.slug_redirects enable row level security;

-- organizations: created only by api.create_organization; never deleted through the API.
create policy organizations_select on app.organizations for select to authenticated
  using ((select private.has_role(id, null, 'staff')) or (select private.is_device(id, null)));
create policy organizations_update on app.organizations for update to authenticated
  using ((select private.has_role(id, null, 'admin')))
  with check ((select private.has_role(id, null, 'admin')));

-- memberships: you see your own; owners manage the team (invites and role rules in phase 2a).
create policy memberships_select on app.memberships for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_role(org_id, null, 'admin')));
create policy memberships_insert on app.memberships for insert to authenticated
  with check ((select private.has_role(org_id, null, 'owner')));
create policy memberships_update on app.memberships for update to authenticated
  using ((select private.has_role(org_id, null, 'owner')))
  with check ((select private.has_role(org_id, null, 'owner')));
create policy memberships_delete on app.memberships for delete to authenticated
  using ((select private.has_role(org_id, null, 'owner')));

-- locations: members and devices of the location read; admins edit; created by owners/admins.
create policy locations_select on app.locations for select to authenticated
  using ((select private.has_role(org_id, id, 'staff')) or (select private.is_device(org_id, id)));
create policy locations_insert on app.locations for insert to authenticated
  with check ((select private.has_role(org_id, null, 'admin')));
create policy locations_update on app.locations for update to authenticated
  using ((select private.has_role(org_id, id, 'admin')))
  with check ((select private.has_role(org_id, id, 'admin')));

-- hours: read by members and devices of the location; managed by managers and up.
create policy business_hours_select on app.business_hours for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy business_hours_insert on app.business_hours for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy business_hours_update on app.business_hours for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy business_hours_delete on app.business_hours for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

create policy hours_exceptions_select on app.hours_exceptions for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy hours_exceptions_insert on app.hours_exceptions for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy hours_exceptions_update on app.hours_exceptions for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy hours_exceptions_delete on app.hours_exceptions for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

-- devices: admins see them; pairing, heartbeat and revocation go through RPCs (D1, #48).
create policy devices_select on app.devices for select to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')));

-- slug_redirects: written only by definer functions; admins can see them.
create policy slug_redirects_select on app.slug_redirects for select to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')));

------------------------------------------------------------------------------------------------
-- api.create_organization
------------------------------------------------------------------------------------------------

create type api.org_bootstrap as (org_id uuid, location_id uuid);
grant usage on type api.org_bootstrap to authenticated;

create function private.slugify(p_text text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(left(btrim(regexp_replace(lower(p_text), '[^a-z0-9]+', '-', 'g'), '-'), 48), ''), 'location')
$$;

/** A slug no location or redirect uses yet, derived from p_name. */
create function private.unique_location_slug(p_name text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  base text := private.slugify(p_name);
  candidate text := base;
begin
  while exists (select 1 from app.locations where slug = candidate)
     or exists (select 1 from app.slug_redirects where old_slug = candidate) loop
    candidate := base || '-' || substr(md5(gen_random_uuid()::text), 1, 4);
  end loop;
  return candidate;
end $$;

create function api.create_organization(p_name text, p_location_name text, p_tz text)
returns api.org_bootstrap
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result api.org_bootstrap;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Paired displays and kiosks are auth users too; they must never become owners of anything.
  if exists (select 1 from app.devices d where d.auth_user_id = uid)
     or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'kind', '') in ('display', 'kiosk') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'invalid_timezone';
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 or length(btrim(coalesce(p_location_name, ''))) = 0 then
    raise exception 'invalid_input';
  end if;

  insert into app.organizations (name, created_by) values (btrim(p_name), uid)
  returning id into result.org_id;

  insert into app.locations (org_id, name, slug, tz)
  values (result.org_id, btrim(p_location_name), private.unique_location_slug(p_location_name), p_tz)
  returning id into result.location_id;

  insert into app.memberships (org_id, user_id, role) values (result.org_id, uid, 'owner');

  return result;
end $$;
comment on function api.create_organization(text, text, text) is
  'Creates an organization, its first location and the caller''s owner membership in one '
  'transaction, and returns their ids. The location slug is derived from the location name and '
  'made unique. Raises not_authenticated (42501) without a session, permission_denied (42501) '
  'for a paired display or kiosk, invalid_timezone when p_tz is '
  'not an IANA zone name, invalid_input for blank names.';

revoke all on function api.create_organization(text, text, text) from public, anon;
grant execute on function api.create_organization(text, text, text) to authenticated;
