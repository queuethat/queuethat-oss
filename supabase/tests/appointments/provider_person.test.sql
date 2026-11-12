-- #1388: a provider line names its person (queues.provider_user_id) and its bookings only ever go to them,
-- even when staff availability is set for the whole location. Lines without a person behave as before.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();
update app.payment_policies set mode = 'none';

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');

select tests.create_user('ada');
select tests.create_user('ben');
select tests.create_user('far');
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'provider-person-second', 'UTC');
insert into app.memberships (org_id, user_id, role, location_ids) values
  (tests.id('org_a'), tests.id('ada'), 'staff', null), (tests.id('org_a'), tests.id('ben'), 'staff', null),
  (tests.id('org_a'), tests.id('far'), 'staff', array[tests.id('loc_a2')]);

insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind, provider_user_id) values
  (tests.new_id('line_ada'), tests.id('org_a'), tests.id('loc_a'), 'Dr Ada', 'D', 'provider', tests.id('ada')),
  (tests.new_id('line_open'), tests.id('org_a'), tests.id('loc_a'), 'Whoever', 'W', 'provider', null);
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes) values
  (tests.new_id('svc_ada'), tests.id('org_a'), tests.id('loc_a'), tests.id('line_ada'), 'Checkup', 30),
  (tests.new_id('svc_open'), tests.id('org_a'), tests.id('loc_a'), tests.id('line_open'), 'Checkup', 30);
insert into app.booking_policies (org_id, service_id, bookable, slot_minutes, slot_offset_minutes, min_notice_minutes)
select tests.id('org_a'), tests.id(k), true, 30, 0, 60 from unnest(array['svc_ada', 'svc_open']) k;
-- Location-wide rules: both providers work every service, which is what used to cross the lines.
insert into app.availability_rules (org_id, location_id, staff_user_id, weekday, starts, ends) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('ada'), 1, '09:00', '12:00'),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('ben'), 1, '09:00', '12:00');

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00')
         at time zone (select tz from app.locations where id = tests.id('loc_a'))) as slot;
grant select on ctx to public;
create function tests.slots(p_service text) returns setof private.slot_candidate language sql as $$
  select * from private.slot_candidates(tests.id(p_service), ((select slot from ctx) at time zone 'UTC')::date - 1,
                                        ((select slot from ctx) at time zone 'UTC')::date + 1)
$$;
grant execute on function tests.slots(text) to public;
create function tests.rows(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function tests.rows(text) to public;

-- The slot finder
select is((select free_staff from tests.slots('svc_ada') where slot_start = (select slot from ctx)),
  array[tests.id('ada')], 'on Ada''s line only Ada can take a slot, though Ben is free too');
select is((select cardinality(free_staff) from tests.slots('svc_open') where slot_start = (select slot from ctx)),
  2, 'a provider line without a person still offers anyone free');

-- Bookings
select tests.as_anon();
select api.book_appointment((select slug from ctx), tests.id('svc_ada'), (select slot from ctx), 'Ann', '+15551230201', null, 1, null, gen_random_uuid());
select api.book_appointment((select slug from ctx), tests.id('svc_ada'), (select slot from ctx) + interval '30 minutes', 'Amy', '+15551230202', null, 1, null, gen_random_uuid());
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Abe', '+15551230203', null, 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('svc_ada'), (select slot from ctx)),
  'P0001', 'slot_unavailable', 'once Ada is booked her line has no room at that time, though Ben is free');
select api.book_appointment((select slug from ctx), tests.id('svc_open'), (select slot from ctx) + interval '1 hour', 'Ola', '+15551230204', null, 1, null, gen_random_uuid());
select tests.as_postgres();
select is((select array_agg(distinct staff_user_id) from app.appointments where queue_id = tests.id('line_ada')),
  array[tests.id('ada')], 'every booking on Ada''s line is Ada''s (Ben was the less busy one)');
select ok((select staff_user_id from app.appointments where guest_name = 'Ola') = any (array[tests.id('ada'), tests.id('ben')]),
  'a line without a person assigns whoever is free, as before');

-- Ada's time off closes her line even though Ben works
insert into app.availability_exceptions (org_id, location_id, staff_user_id, local_date, kind)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('ada'),
        ((select slot from ctx) at time zone (select tz from app.locations where id = tests.id('loc_a')))::date, 'unavailable');
select is((select count(*)::int from tests.slots('svc_ada')), 0, 'Ada''s day off leaves her line with no slots');
select ok((select count(*)::int from tests.slots('svc_open')) > 0, 'while the open line still has Ben''s');
delete from app.availability_exceptions where staff_user_id = tests.id('ada');

-- A service-only "anyone" window on a provider line counts as the provider's
delete from app.availability_rules;
insert into app.availability_rules (org_id, location_id, service_id, staff_user_id, weekday, starts, ends)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('svc_ada'), null, 1, '09:00', '12:00');
select is((select free_staff from tests.slots('svc_ada') where slot_start = (select slot from ctx) + interval '2 hours'),
  array[tests.id('ada')], 'an "anyone" window on her line is Ada''s');
select is((select any_staff from tests.slots('svc_ada') limit 1), false, 'and never open to anyone else');

-- Rules on the column
select throws_ok($$ update app.queues set provider_user_id = tests.id('ada') where id = tests.id('queue_a') $$,
  '23514', null, 'a general line cannot have a provider person');
select throws_ok($$ update app.queues set provider_user_id = tests.id('far') where id = tests.id('line_open') $$,
  'P0001', 'invalid_input', 'the person must work at the line''s location');
select throws_ok($$ update app.queues set provider_user_id = tests.id('other_owner') where id = tests.id('line_open') $$,
  'P0001', 'invalid_input', 'cross-tenant: another org''s member cannot be the provider');

select tests.act_as('manager');
select is(tests.rows($$ update app.queues set provider_user_id = tests.id('ben') where id = tests.id('line_open') $$),
  1, 'a manager names a line''s person');
select tests.act_as('staff');
select is(tests.rows($$ update app.queues set provider_user_id = null where id = tests.id('line_open') $$),
  0, 'staff cannot change it');
select tests.as_user(tests.id('other_owner'));
select is(tests.rows($$ update app.queues set provider_user_id = null where id = tests.id('line_open') $$),
  0, 'cross-tenant: another org cannot change it');
select is((select count(*)::int from app.queues where provider_user_id is not null), 0, 'cross-tenant: nor see whose lines they are');

select tests.as_postgres();
select tests.create_user('cy');
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('cy'), 'staff');
update app.queues set provider_user_id = tests.id('cy') where id = tests.id('line_open');
delete from app.memberships where user_id = tests.id('cy');
select is((select provider_user_id from app.queues where id = tests.id('line_open')), null, 'removing the member clears the line''s person');
select is((select kind from app.queues where id = tests.id('line_open')), 'provider', 'and leaves the line a provider line');

select * from finish();
rollback;
