-- M7 (#1294): booking per provider. Two provider lines and an "Anyone available" pool in one location each
-- offer a "Checkup": the providers fill the same slot independently and are the assigned staff, the guest's
-- appointment names the provider (never for a pool), reports split by line and roll up per location, billing
-- counts the location once however many lines it has, and another tenant reaches none of it.
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
insert into app.memberships (org_id, user_id, role) values
  (tests.id('org_a'), tests.id('ada'), 'staff'), (tests.id('org_a'), tests.id('ben'), 'staff');

insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind) values
  (tests.new_id('pool'), tests.id('org_a'), tests.id('loc_a'), 'Anyone available', 'P', 'pool');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind, pulls_from) values
  (tests.new_id('line_ada'), tests.id('org_a'), tests.id('loc_a'), 'Dr Ada', 'D', 'provider', tests.id('pool')),
  (tests.new_id('line_ben'), tests.id('org_a'), tests.id('loc_a'), 'Dr Ben', 'B', 'provider', tests.id('pool'));
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes) values
  (tests.new_id('svc_ada'), tests.id('org_a'), tests.id('loc_a'), tests.id('line_ada'), 'Checkup', 30),
  (tests.new_id('svc_ben'), tests.id('org_a'), tests.id('loc_a'), tests.id('line_ben'), 'Checkup', 30),
  (tests.new_id('svc_pool'), tests.id('org_a'), tests.id('loc_a'), tests.id('pool'), 'Checkup', 30);
insert into app.booking_policies (org_id, service_id, bookable, slot_minutes, slot_offset_minutes, min_notice_minutes)
select tests.id('org_a'), tests.id(k), true, 30, 0, 60 from unnest(array['svc_ada', 'svc_ben', 'svc_pool']) k;
-- Each provider's service is theirs; the pool's is anyone's.
insert into app.availability_rules (org_id, location_id, service_id, staff_user_id, weekday, starts, ends) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('svc_ada'), tests.id('ada'), 1, '09:00', '12:00'),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('svc_ben'), tests.id('ben'), 1, '09:00', '12:00'),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('svc_pool'), null, 1, '09:00', '12:00');

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00')
         at time zone (select tz from app.locations where id = tests.id('loc_a'))) as slot;
create temp table tok (who text, token text);
grant select on ctx to public;
grant all on tok to public;

-- Appointments per provider
select tests.as_anon();
insert into tok select 'ada', (api.book_appointment((select slug from ctx), tests.id('svc_ada'), (select slot from ctx), 'Ann', '+15551230101', null, 1, null, gen_random_uuid())).token;
insert into tok select 'ben', (api.book_appointment((select slug from ctx), tests.id('svc_ben'), (select slot from ctx), 'Bea', '+15551230102', null, 1, null, gen_random_uuid())).token;
insert into tok select 'pool', (api.book_appointment((select slug from ctx), tests.id('svc_pool'), (select slot from ctx), 'Cas', '+15551230103', null, 1, null, gen_random_uuid())).token;
select is((select count(*)::int from tok where token is not null), 3, 'two providers and the pool each take the same slot');
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Dan', '+15551230104', null, 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('svc_ada'), (select slot from ctx)),
  'P0001', 'slot_unavailable', 'a provider who is booked has no slot left there, whatever the others have free');
select ok(exists (select 1 from api.get_available_slots((select slug from ctx), tests.id('svc_ada'),
                    ((select slot from ctx) at time zone 'UTC')::date - 1, ((select slot from ctx) at time zone 'UTC')::date + 1) s
                  where s.slot_start = (select slot from ctx) + interval '30 minutes'),
  'the provider''s next slot is still on offer');

select tests.as_postgres();
select results_eq($$ select q.name, a.staff_user_id from app.appointments a join app.queues q on q.id = a.queue_id
                     where a.queue_id in (tests.id('line_ada'), tests.id('line_ben'), tests.id('pool')) and a.status = 'booked' order by a.guest_name $$,
  $$ values ('Dr Ada'::text, tests.id('ada')), ('Dr Ben', tests.id('ben')), ('Anyone available', null::uuid) $$,
  'each appointment sits on the line booked and the provider is its staff (the pool assigns no one)');

-- The guest's status page names the provider, never for the pool
select tests.as_anon();
select is((api.get_appointment((select token from tok where who = 'ada'))).provider_name, 'Dr Ada', 'the guest sees whose appointment it is');
select is((api.get_appointment((select token from tok where who = 'ben'))).provider_name, 'Dr Ben', 'and the other provider''s guest sees theirs');
select is((api.get_appointment((select token from tok where who = 'pool'))).provider_name, null, '"Anyone available" names no one');
select is((api.get_appointment((select token from tok where who = 'ada'))).service_name, 'Checkup', 'the service name is unchanged');
insert into tok select 'ben2', (api.book_appointment((select slug from ctx), tests.id('svc_ben'), (select slot from ctx) + interval '1 hour', 'Eve', '+15551230105', null, 1, null, gen_random_uuid())).token;
select is((select (api.guest_cancel_appointment(token, gen_random_uuid())).provider_name from tok where who = 'ben2'), 'Dr Ben',
  'the cancel answer carries the provider too');
select tests.as_postgres();
select is((select to_jsonb(api.get_appointment((select token from tok where who = 'ada'))) ?| array['guest_name', 'guest_phone_e164', 'staff_user_id']),
  false, 'no contact data or staff account in the guest answer (I-13)');

-- Reports per line and rolled up per location (the day's visits come from the appointments)
select tests.as_postgres();
select is(private.materialize_due((select slot from ctx)), 3, 'the day''s three appointments become visits');
select is((select count(*)::int from app.visits v join app.appointments a on a.visit_id = v.id
           where a.queue_id in (tests.id('line_ada'), tests.id('line_ben'), tests.id('pool')) and v.queue_id = a.queue_id), 3, 'each visit is on its appointment''s line');
create temp table def as select
  jsonb_build_object('org_id', tests.id('org_a'), 'measures', jsonb_build_array('visits'),
                     'dimensions', jsonb_build_array('queue'), 'filters', jsonb_build_object('source', 'appointment')) as by_line,
  jsonb_build_object('org_id', tests.id('org_a'), 'measures', jsonb_build_array('visits'),
                     'dimensions', jsonb_build_array('location'), 'filters', jsonb_build_object('source', 'appointment')) as by_location,
  ((select slot from ctx) at time zone (select tz from app.locations where id = tests.id('loc_a')))::date as d;
grant select on def to public;
select tests.as_user(tests.id('manager'));
select results_eq($$ select dims ->> 'queue', (measures ->> 'visits')::int from api.run_report((select by_line from def), (select d from def), (select d from def)) order by 1 $$,
  $$ values ('Anyone available'::text, 1), ('Dr Ada', 1), ('Dr Ben', 1) $$, 'the report splits appointments by line');
select results_eq($$ select (measures ->> 'visits')::int from api.run_report((select by_location from def), (select d from def), (select d from def)) $$,
  $$ values (3) $$, 'and rolls them up into one row for the location');

-- Six lines are still one location
select tests.as_postgres();
insert into app.queues (org_id, location_id, name, ticket_prefix, kind)
select tests.id('org_a'), tests.id('loc_a'), 'Dr ' || i, chr(70 + i), 'provider' from generate_series(1, 2) i;
select is((select count(*)::int from app.queues where location_id = tests.id('loc_a') and archived_at is null), 6, 'the location has six lines');
select is((select count(*)::int from app.locations where org_id = tests.id('org_a')), 1, 'and the org has one location');

-- Cross-tenant
select tests.as_user(tests.id('other_owner'));
select throws_ok($$ select * from api.run_report((select by_line from def), (select d from def), (select d from def)) $$,
  'P0001', 'not_found', 'another tenant cannot report on these lines');
select is((select count(*)::int from app.appointments where queue_id in (tests.id('line_ada'), tests.id('line_ben'), tests.id('pool'))), 0,
  'another tenant sees none of the providers'' appointments');

select * from finish();
rollback;
