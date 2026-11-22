-- #75: a service offered by several provider lines is not tied to the first line's person.
-- (A service offered by one provider line still is: appointments/provider_person.test.sql.)
begin;
\ir ../helpers/_setup.psql
select plan(3);
select tests.create_world();
update app.payment_policies set mode = 'none';
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
select tests.create_user('ada');
select tests.create_user('ben');
insert into app.memberships (org_id, user_id, role, location_ids) values
  (tests.id('org_a'), tests.id('ada'), 'staff', null), (tests.id('org_a'), tests.id('ben'), 'staff', null);
insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind, provider_user_id, sort_order) values
  (tests.new_id('line_ada'), tests.id('org_a'), tests.id('loc_a'), 'Dr Ada', 'D', 'provider', tests.id('ada'), 1),
  (tests.new_id('line_ben'), tests.id('org_a'), tests.id('loc_a'), 'Dr Ben', 'E', 'provider', tests.id('ben'), 2);
insert into app.services (id, org_id, location_id, name, expected_minutes)
values (tests.new_id('svc'), tests.id('org_a'), tests.id('loc_a'), 'Checkup', 30);
insert into app.queue_services (org_id, location_id, queue_id, service_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('line_ada'), tests.id('svc'));
insert into app.booking_policies (org_id, service_id, bookable, slot_minutes, slot_offset_minutes, min_notice_minutes)
values (tests.id('org_a'), tests.id('svc'), true, 30, 0, 60);
insert into app.availability_rules (org_id, location_id, staff_user_id, weekday, starts, ends) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('ada'), 1, '09:00', '12:00'),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('ben'), 1, '09:00', '12:00');
create temp table ctx as
select ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00')
        at time zone (select tz from app.locations where id = tests.id('loc_a'))) as slot;
create function tests.free() returns uuid[] language sql as $$
  select free_staff from private.slot_candidates(tests.id('svc'), ((select slot from ctx) at time zone 'UTC')::date - 1,
                                                  ((select slot from ctx) at time zone 'UTC')::date + 1)
  where slot_start = (select slot from ctx)
$$;

select is(tests.free(), array[tests.id('ada')], 'offered by one provider line: only that person');
insert into app.queue_services (org_id, location_id, queue_id, service_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('line_ben'), tests.id('svc'));
select is(cardinality(tests.free()), 2, 'offered by two provider lines: anyone available');
update app.queues set archived_at = now() where id = tests.id('line_ben');
select is(tests.free(), array[tests.id('ada')], 'an archived line does not count: back to that person only');

select * from finish();
rollback;
