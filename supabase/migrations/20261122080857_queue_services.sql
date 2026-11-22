-- Location-level services, step 1 of 3 (expand; queuethat-oss #75).
--
-- Today every queue owns its own copy of each service (app.services.queue_id NOT NULL), so a
-- barber location with 4 chairs stores "Haircut" 4 times, with 4 booking policies, 4 payment
-- policies and 4 form targets. The target model: a service belongs to the location, and a queue
-- "offers" it through app.queue_services.
--
-- This migration only adds the link table, backfills it 1:1 from services.queue_id and keeps it in
-- step with new services (dual write). Nothing reads it yet, so it can ship on its own and be
-- rolled back by dropping the table. The functions switch in the next migration; services.queue_id
-- is dropped one release after that (I-12).

create table app.queue_services (
  org_id uuid not null,
  location_id uuid not null,
  queue_id uuid not null,
  service_id uuid not null,
  -- The order a queue lists its services in, and (lowest wins) the queue an appointment for the
  -- service lands in.
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  primary key (queue_id, service_id),
  -- Composite keys make "queue and service are at the same location" a constraint, not a check.
  foreign key (org_id, location_id, queue_id) references app.queues (org_id, location_id, id) on delete cascade,
  foreign key (org_id, location_id, service_id) references app.services (org_id, location_id, id) on delete cascade
);
create index queue_services_service_idx on app.queue_services (service_id);
comment on table app.queue_services is
  'Which queue offers which service. A service belongs to a location; a queue offers a subset of '
  'the location''s services. A queue with no rows behaves as a queue-only line (no service choice).';

create trigger forbid_org_change before update on app.queue_services
  for each row execute function private.forbid_org_change();

alter table app.queue_services enable row level security;

create policy queue_services_select on app.queue_services for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff'))
         or (select private.is_device(org_id, location_id)));
create policy queue_services_insert on app.queue_services for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy queue_services_update on app.queue_services for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy queue_services_delete on app.queue_services for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

grant select, insert, update, delete on app.queue_services to authenticated;
grant all on app.queue_services to service_role;

create trigger audit_row after insert or update or delete on app.queue_services
  for each row execute function private.audit_row();

-- Backfill: every existing service is offered by the queue that owns it, nothing else.
insert into app.queue_services (org_id, location_id, queue_id, service_id, sort_order)
select org_id, location_id, queue_id, id, sort_order from app.services;

-- Dual write: until the next migration, code that still creates a service for a queue (older web
-- bundles, templates) keeps the link table complete.
create function private.link_new_service() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.queue_id is not null then
    insert into app.queue_services (org_id, location_id, queue_id, service_id, sort_order)
    values (new.org_id, new.location_id, new.queue_id, new.id, new.sort_order)
    on conflict do nothing;
  end if;
  return new;
end
$$;
comment on function private.link_new_service() is
  'Trigger: a service created with a queue_id is also offered by that queue. Temporary expand-step '
  'bridge; removed when services.queue_id is dropped.';
revoke all on function private.link_new_service() from public, anon, authenticated;

create trigger link_new_service after insert on app.services
  for each row execute function private.link_new_service();
