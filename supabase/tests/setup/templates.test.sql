-- 2A-ORG4 (#92): industry templates and the clinic privacy guardrail.
begin;
\ir ../helpers/_setup.psql
select plan(23);

select tests.create_world();
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_new'), tests.id('org_a'), 'New place', 'new-place-a', 'America/New_York');

select tests.new_id('key_1');
select tests.act_as('admin');
select is((select count(*) from api.list_industry_templates()), (select count(distinct key) from app.template_catalog),
  'every catalog template is listed');
select is((select health_tagged from api.list_industry_templates() where key = 'clinic'), true, 'only the clinic is health-tagged');

-- AC1: barber.
select is((api.apply_industry_template(tests.id('loc_new'), 'barber', tests.id('key_1'))).services_created, 6,
  'AC1: the barber template (v2, T5) creates six services');
select is((select array_agg(s.name || ' ' || s.expected_minutes order by s.name)
           from app.services s where s.location_id = tests.id('loc_new')),
  array['Beard trim 15', 'Haircut 30', 'Haircut and beard 45', 'Hot towel shave 30', 'Kids'' cut (under 12) 20', 'Skin fade 40'],
  'AC1: barber services in English with their minutes');
select is((select array_agg(c.label order by c.label) from app.counters c where c.location_id = tests.id('loc_new')),
  array['Chair 1', 'Chair 2', 'Chair 3'], 'AC1: counters Chair 1-3');
select is((select count(*) from app.queues q where q.location_id = tests.id('loc_new')), 1::bigint, 'AC1: one queue');

-- AC3: the same key twice creates rows once and returns the same answer.
select is((api.apply_industry_template(tests.id('loc_new'), 'barber', tests.id('key_1'))).queues_created, 1,
  'AC3: a repeat with the same key replays the first result');
select is((select count(*) from app.queues q where q.location_id = tests.id('loc_new')), 1::bigint,
  'AC3: still one queue');
select is((api.apply_industry_template(tests.id('loc_new'), 'barber', gen_random_uuid())).queues_created, 0,
  'a new key on the same template creates nothing twice');

-- Restaurant party size and DMV per-service prefix (#93 follow-up).
select api.apply_industry_template(tests.id('loc_new'), 'restaurant', gen_random_uuid());
select api.apply_industry_template(tests.id('loc_new'), 'dmv_counter', gen_random_uuid());
select is((select row(q.party_size_enabled, q.party_size_min, q.party_size_max) from app.queues q
           where q.location_id = tests.id('loc_new') and q.name = 'Waitlist'), row(true, 1, 12),
  'the restaurant waitlist takes parties of 1 to 12');
select is((select s.ticket_prefix from app.services s where s.location_id = tests.id('loc_new') and s.name = 'Registrations'),
  'B', 'Registrations tickets use prefix B');

-- Every template applies cleanly.
select is((select count(*) from (
  select api.apply_industry_template(tests.id('loc_new'), k, gen_random_uuid())
  from unnest(array['restaurant', 'dmv_counter', 'retail_repair', 'events', 'barber']) k) x), 5::bigint,
  'the other templates apply cleanly');

-- Clinic guardrail (AC2).
select tests.act_as('admin');
update app.locations set display_names_enabled = true where org_id = tests.id('org_a');
select is((api.apply_industry_template(tests.id('loc_new'), 'clinic', gen_random_uuid())).counters_created, 2,
  'the clinic template creates Room 1 and Room 2');
select tests.as_postgres();
select is((select health_tagged from app.organizations where id = tests.id('org_a')), true, 'the org is health-tagged');
select is((select display_names_enabled from app.locations where id = tests.id('loc_new')), false,
  'applying the clinic template turns names off');
select is((select count(*) from app.locations where org_id = tests.id('org_a') and display_names_enabled), 0::bigint,
  'names are off at every location of the org');
select tests.act_as('admin');
select throws_ok($$ update app.locations set display_names_enabled = true where id = tests.id('loc_new') $$,
  'P0001', 'display_names_locked', 'AC2: an admin cannot turn names on for a clinic org');
select throws_ok($$ update app.organizations set health_tagged = false where id = tests.id('org_a') $$,
  '42501', null, 'an owner-level user cannot lift the tag');
select tests.act_as('owner');
select throws_ok($$ update app.organizations set health_tagged = false where id = tests.id('org_a') $$,
  '42501', null, 'not even the owner');

-- Refusals.
select tests.act_as('admin');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_a'), 'barber', gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a location with visits today is refused');
select tests.act_as('staff');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new'), 'barber', gen_random_uuid()) $$,
  '42501', null, 'staff cannot apply a template');
select tests.as_anon();
select throws_ok($$ select * from api.list_industry_templates() $$, '42501', null, 'anon cannot list templates');
select tests.act_as('other_owner');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new'), 'barber', gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC4: an admin of org B gets not_found for an org A location');

select * from finish();
rollback;
