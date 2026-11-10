-- 2B-ORG3 (#267): api.org_overview.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();
delete from app.business_hours where org_id = tests.id('org_a');

insert into app.locations (id, org_id, name, slug, tz) values
  (tests.new_id('loc_ny'), tests.id('org_a'), 'New York', 'ny-' || gen_random_uuid(), 'America/New_York'),
  (tests.new_id('loc_be'), tests.id('org_a'), 'Berlin', 'be-' || gen_random_uuid(), 'Europe/Berlin');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('q_ny'), tests.id('org_a'), tests.id('loc_ny'), 'Walk-ins', 'N'),
  (tests.new_id('q_be'), tests.id('org_a'), tests.id('loc_be'), 'Walk-ins', 'B');
select tests.new_visit('ny1', 'q_ny'), tests.new_visit('be1', 'q_be'), tests.new_visit('be2', 'q_be');
-- AC1: at 02:00 UTC New York (22:00) and Berlin (04:00) are on different service days.
update app.visits set service_day = private.service_day(location_id), joined_at = now() - interval '12 minutes'
 where id in (tests.id('ny1'), tests.id('be1'));
update app.visits set service_day = private.service_day(location_id) - 1 where id = tests.id('be2');
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
select tests.id('org_a'), l, d, '00:00', '24:00' from unnest(array[tests.id('loc_ny'), tests.id('loc_be')]) l, generate_series(0, 6) d;

select tests.act_as('owner');
select is((select count(*)::int from api.org_overview(tests.id('org_a'))), 3, 'the owner sees every location');
select is((select waiting_count from api.org_overview(tests.id('org_a')) where location_name = 'Berlin'), 1,
  'AC1: Berlin counts only its own service day (the older visit is not today)');
select is((select longest_wait_min from api.org_overview(tests.id('org_a')) where location_name = 'New York'), 12, 'longest wait in minutes');
select ok((select queues_open >= 1 from api.org_overview(tests.id('org_a')) where location_name = 'New York'), 'open queues counted');

-- AC2: a member restricted to one location.
select tests.as_postgres();
update app.memberships set location_ids = array[tests.id('loc_ny')] where user_id = tests.id('staff');
select tests.act_as('staff');
select is((select array_agg(location_name) from api.org_overview(tests.id('org_a'))), array['New York'], 'AC2: only the assigned location');

-- AC3: cross tenant.
select tests.act_as('other_owner');
select is((select count(*)::int from api.org_overview(tests.id('org_a'))), 0, 'AC3: org B gets zero rows');
select tests.as_anon();
select throws_ok(format($$ select * from api.org_overview(%L) $$, tests.id('org_a')), '42501', null, 'anon cannot call it');

select * from finish();
rollback;
