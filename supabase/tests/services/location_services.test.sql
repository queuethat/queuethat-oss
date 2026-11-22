-- #75 PR B: services belong to the location; queues offer them through app.queue_services.
begin;
\ir ../helpers/_setup.psql
select plan(23);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix, sort_order)
values (tests.new_id('queue_b2'), tests.id('org_a'), tests.id('loc_a'), 'Chair 2', 'B', 5);
select tests.new_id('k1'); select tests.new_id('k2'); select tests.new_id('k3');
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

-- Join: the queue must offer the service.
select throws_ok(
  format($$ select api.join_queue(%L, %L, 'Ann', null, null, 1, 'en-US', %L) $$,
         tests.id('queue_b2'), tests.id('service_a'), tests.id('k1')),
  'P0001', 'not_found', 'join rejects a service the queue does not offer');
insert into app.queue_services (org_id, location_id, queue_id, service_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_b2'), tests.id('service_a'));
select lives_ok(
  format($$ select api.join_queue(%L, %L, 'Ann', null, null, 1, 'en-US', %L) $$,
         tests.id('queue_b2'), tests.id('service_a'), tests.id('k1')),
  'join accepts it once the queue offers it (one service, two queues)');
select is((select v.service_id from app.visits v where v.queue_id = tests.id('queue_b2')), tests.id('service_a'),
  'the visit records the location-level service');

-- The public location read lists a queue's services from the link table.
select is((select count(*)::int from api.get_location_public('test-location-a') l,
           unnest(l.queues) q, unnest(q.services) s where q.name = 'Chair 2'), 1,
  'the public read lists the services a queue offers');
delete from app.queue_services where queue_id = tests.id('queue_b2');
select is((select count(*)::int from api.get_location_public('test-location-a') l,
           unnest(l.queues) q, unnest(q.services) s where q.name = 'Chair 2'), 0,
  'and none once the queue stops offering them');
insert into app.queue_services (org_id, location_id, queue_id, service_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_b2'), tests.id('service_a'));

-- Appointments land in the first queue (queue sort order) that offers the service.
select is(private.service_queue(tests.id('service_a')),
  (select id from app.queues where location_id = tests.id('loc_a') order by sort_order, created_at limit 1)
  , 'an appointment goes to the first queue that offers the service');
select is(private.service_queue(gen_random_uuid()), null::uuid, 'a service no queue offers has no queue');

-- No-op: a location without duplicate names has nothing to merge.
select is((select count(*)::int from private.service_merge_plan(tests.id('loc_a'))), 0,
  'the dry run lists nothing for a location without duplicates');
select is(private.merge_identical_services(tests.id('loc_a')), 0, 'merging it is a no-op');
select is((select count(*)::int from app.services where location_id = tests.id('loc_a') and active), 1,
  'and changes no service');

-- Dedupe: two queues, each with its own copy of Cut (identical) and Shave (15 vs 20 minutes).
create temp table dd as select tests.new_id('cut1') c1, tests.new_id('cut2') c2, tests.new_id('sh1') s1, tests.new_id('sh2') s2;
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes, color) values
  (tests.id('cut1'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'Cut', 25, '#112233'),
  (tests.id('cut2'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_b2'), 'Cut', 25, '#112233'),
  (tests.id('sh1'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'Shave', 15, null),
  (tests.id('sh2'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_b2'), 'Shave', 20, null);
update app.services set created_at = now() - interval '1 day' where id = tests.id('cut1');
insert into app.booking_policies (org_id, location_id, service_id, bookable)
select org_id, location_id, id, true from app.services where id in (tests.id('cut1'), tests.id('cut2'));
-- A past visit on the copy that will be retired.
select tests.new_visit('visit_cut2', 'queue_b2');
update app.visits set service_id = tests.id('cut2') where id = tests.id('visit_cut2');

select is((select outcome from private.service_merge_plan(tests.id('loc_a')) where service_name = 'Cut'), 'merge',
  'dry run: identical copies are marked merge');
select ok((select bool_and(flagged) and bool_or(detail like '%minutes%') from private.service_merge_plan(tests.id('loc_a')) where service_name = 'Shave'),
  'dry run: copies that differ are flagged with what differs');
select is((select count(*)::int from app.services where id in (tests.id('cut1'), tests.id('cut2')) and active), 2,
  'the dry run changed nothing');

select is(private.merge_identical_services(tests.id('loc_a')), 1, 'merge: one group (Cut) merged');
select is((select count(*)::int from app.services where location_id = tests.id('loc_a') and name = 'Cut' and active), 1,
  'merge: one active Cut remains');
select is((select merged_into_id from app.services where id = tests.id('cut2')), tests.id('cut1'),
  'merge: the retired copy points at the survivor (the oldest)');
select is((select count(*)::int from app.queue_services where service_id = tests.id('cut1')
           and queue_id in (tests.id('queue_a'), tests.id('queue_b2'))), 2,
  'merge: both queues offer the survivor');
select is((select count(*)::int from app.services where location_id = tests.id('loc_a') and name = 'Shave' and active), 2,
  'merge: differing Shave copies stay separate');
select is((select s.name from app.visits v join app.services s on s.id = v.service_id where v.id = tests.id('visit_cut2')), 'Cut',
  'merge: the old visit still reads its service (not rewritten)');

-- Templates: the location-level shape (services listed once, queues name them) creates each service
-- once and links it to every queue; the per-queue shape still works and dedupes by name.
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_new'), tests.id('org_a'), 'New place', 'new-place-a', 'America/New_York');
insert into app.template_catalog (key, version, payload, tier, mode) values ('shape_new', 1, $j${
  "key": "shape_new", "version": 1, "name": "Shop", "description": "Shop",
  "services": [{"name": "Cut", "minutes": 20}, {"name": "Beard", "minutes": 10}],
  "queues": [{"name": "Chair 1", "prefix": "A", "show_eta": true, "services": ["Cut", "Beard"]},
             {"name": "Chair 2", "prefix": "B", "show_eta": true, "services": ["Cut"]}],
  "resources": []
}$j$::jsonb, 1, 'walk_in'),
('shape_old', 1, $j${
  "key": "shape_old", "version": 1, "name": "Shop2", "description": "Shop2",
  "queues": [{"name": "Chair 1", "prefix": "A", "show_eta": true, "services": [{"name": "Cut", "minutes": 20}]},
             {"name": "Chair 2", "prefix": "B", "show_eta": true, "services": [{"name": "Cut", "minutes": 20}]}],
  "resources": []
}$j$::jsonb, 1, 'walk_in');
select tests.act_as('admin');
select is((api.apply_industry_template(tests.id('loc_new'), 'shape_new', gen_random_uuid())).services_created, 2,
  'new template shape: two services created once');
select is((select count(*)::int from app.queue_services where location_id = tests.id('loc_new')), 3,
  'new template shape: Chair 1 offers two, Chair 2 offers one');
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_old'), tests.id('org_a'), 'Old place', 'old-place-a', 'America/New_York');
select tests.act_as('admin');
select is((api.apply_industry_template(tests.id('loc_old'), 'shape_old', gen_random_uuid())).services_created, 1,
  'old template shape: the copy per queue becomes one service');
select is((select count(*)::int from app.queue_services where location_id = tests.id('loc_old')), 2,
  'old template shape: both queues offer it');

select * from finish();
rollback;
