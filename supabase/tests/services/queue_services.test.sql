-- #75: app.queue_services. The link table refuses
-- cross-location and cross-tenant links.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

-- The fixture links (the dual-write trigger of the expand step is gone).
select ok((select count(*) = 2 from app.queue_services
           where queue_id = tests.id('queue_a') and service_id in (tests.id('service_a'), tests.id('service_a2'))),
  'the fixture queue offers both of its fixture services');

-- A second queue at the location can offer a service owned by the same location.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Chair 2', 'B');
select lives_ok(
  format($$ insert into app.queue_services (org_id, location_id, queue_id, service_id)
            values (%L, %L, %L, %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a2'), tests.id('service_a')),
  'two queues at one location can offer the same service');

-- Cross-location: a queue and service at different locations cannot be linked.
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second site', 'second-site-a', 'America/New_York');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_far'), tests.id('org_a'), tests.id('loc_a2'), 'Far', 'F');
select throws_ok(
  format($$ insert into app.queue_services (org_id, location_id, queue_id, service_id)
            values (%L, %L, %L, %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('queue_far'), tests.id('service_a')),
  '23503', null, 'a queue cannot offer a service from another location');

-- Cross-tenant: org B's owner cannot read or write org A's links.
select tests.act_as('other_owner');
select is((select count(*)::int from app.queue_services), 0, 'org B sees no org A links (RLS)');
select throws_ok(
  format($$ insert into app.queue_services (org_id, location_id, queue_id, service_id)
            values (%L, %L, %L, %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a2'), tests.id('service_a2')),
  '42501', null, 'org B cannot link org A rows (RLS)');

-- Deleting a queue or a service removes its links (cascade), not the other side.
select tests.as_service();
delete from app.queues where id = tests.id('queue_a2');
select is((select count(*)::int from app.services where id = tests.id('service_a')), 1,
  'deleting a queue keeps the service it offered');

select * from finish();
rollback;
