-- 2A-Q1 (#100): resource kinds, staff resources and the service-to-resource mapping (Q-4).
--
-- Counters are generalised in place (expand only, no rename) so phase-1 code that reads
-- app.counters keeps working on old kiosk and display bundles. Existing rows become kind 'counter'.

create type app.resource_kind as enum ('counter', 'desk', 'room', 'table', 'chair', 'staff');
grant usage on type app.resource_kind to authenticated, service_role;

alter table app.counters
  add column kind app.resource_kind not null default 'counter',
  add column member_user_id uuid references auth.users (id) on delete set null,
  add column seats int check (seats between 1 and 99),
  add column active boolean not null default true,
  add constraint counters_staff_member_check check (kind <> 'staff' or member_user_id is not null);

-- A staff resource names a member whose membership covers the resource's location. Checked on
-- write only: removing the member later deactivates nothing here (the admin UI archives).
create function private.check_resource_member() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'staff' and not exists (
    select 1 from app.memberships m
    where m.org_id = new.org_id
      and m.user_id = new.member_user_id
      and (m.location_ids is null or new.location_id = any (m.location_ids))
  ) then
    raise exception 'invalid_input' using detail = 'member_user_id is not a member of the location';
  end if;
  return new;
end $$;
comment on function private.check_resource_member() is
  'BEFORE trigger on app.counters: a staff resource must point at a member of its location.';
create trigger check_resource_member before insert or update on app.counters
  for each row execute function private.check_resource_member();

------------------------------------------------------------------------------------------------
-- Which resources can serve which services (empty mapping for a service = any resource)
------------------------------------------------------------------------------------------------

-- location_id is stored (composite FKs make "same location" a constraint, not a trigger) so policies
-- read it from the row like every other config table.
alter table app.services add unique (org_id, location_id, id);

create table app.service_resources (
  org_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  counter_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (service_id, counter_id),
  foreign key (org_id, location_id, service_id) references app.services (org_id, location_id, id) on delete cascade,
  foreign key (org_id, location_id, counter_id) references app.counters (org_id, location_id, id) on delete cascade
);
create index service_resources_counter_idx on app.service_resources (counter_id);

create trigger forbid_org_change before update on app.service_resources
  for each row execute function private.forbid_org_change();

alter table app.service_resources enable row level security;

create policy service_resources_select on app.service_resources for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy service_resources_insert on app.service_resources for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy service_resources_update on app.service_resources for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy service_resources_delete on app.service_resources for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

grant select, insert, update, delete on app.service_resources to authenticated;
grant all on app.service_resources to service_role;

create trigger audit_row after insert or update or delete on app.service_resources
  for each row execute function private.audit_row();

------------------------------------------------------------------------------------------------
-- Waiting-guest assignment (Q-18). assigned_staff_id already exists.
------------------------------------------------------------------------------------------------

alter table app.visits add column assigned_counter_id uuid;
alter table app.visits add foreign key (org_id, location_id, assigned_counter_id)
  references app.counters (org_id, location_id, id);
-- New columns are hidden from API roles until granted (20261025005400_visit_column_grants.sql).
grant select (assigned_counter_id) on app.visits to authenticated;

-- Staff read path (20261025091829_staff_visits.sql): the view must list the granted columns.
-- redefines app.staff_visits from 20261025091829_staff_visits.sql
create or replace view app.staff_visits with (security_invoker = true) as
select
  v.id, v.org_id, v.location_id, v.queue_id, v.service_id, v.service_day,
  v.ticket_prefix, v.ticket_number, v.display_ticket, v.status, v.sort_key,
  v.party_size, v.guest_name, v.guest_id, v.contact_id, v.locale, v.source,
  v.counter_id, v.assigned_staff_id, v.call_count, v.eta_quoted_low, v.eta_quoted_high,
  v.joined_at, v.called_at, v.serving_at, v.finished_at, v.version,
  v.guest_phone_e164, v.guest_email,
  private.allowed_actions(v.status) as allowed_actions,
  v.assigned_counter_id
from app.visits v;
