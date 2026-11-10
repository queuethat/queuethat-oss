-- 2A-GST8 (#129): api.get_location_wait, the public current-wait view.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_w'), tests.id('org_a'), tests.id('loc_a'), 'Wait', 'W');
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
values (tests.new_id('svc_w'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_w'), 'Cut', 10);
select tests.new_visit('w' || n, 'queue_w') from generate_series(1, 4) n;
update app.visits set service_id = tests.id('svc_w') where queue_id = tests.id('queue_w');

create table tests.wait_rows as
  select * from api.get_location_wait('test-location-a') where false;
grant all on tests.wait_rows to anon;

select tests.as_anon();
select lives_ok($$ insert into tests.wait_rows select * from api.get_location_wait('test-location-a') $$,
  'anon can read the public wait');
select is((select count(*)::int from tests.wait_rows where queue_id = tests.id('queue_w')), 1,
  'one row per queue');
select is((select waiting_count from tests.wait_rows where queue_id = tests.id('queue_w')), 4,
  'it counts the waiting guests');
select ok((select accepting from tests.wait_rows where queue_id = tests.id('queue_w')), 'and the queue accepts');
select is((select eta_state::text from tests.wait_rows where queue_id = tests.id('queue_w')), 'ok',
  'AC1: the state is ok');
select ok((select eta_low <= 40 and eta_high >= 40 and eta_high - eta_low <= 40
           from tests.wait_rows where queue_id = tests.id('queue_w')),
  'AC1: four 10-minute services with one server give a range around 40 minutes');
select ok((select as_of is not null and opens_next_at is null from tests.wait_rows
           where queue_id = tests.id('queue_w')), 'the server time is set');

-- AC3: only counts and ranges, nothing staff-only or personal.
select is((select array_agg(a.attname::text order by a.attnum) from pg_attribute a
           where a.attrelid = 'api.public_wait'::regtype::text::regclass and a.attnum > 0 and not a.attisdropped),
  array['queue_id', 'queue_name', 'accepting', 'waiting_count', 'eta_low', 'eta_high', 'eta_state',
        'opens_next_at', 'as_of', 'party_size_min', 'party_size_max', 'intake_fields', 'join_later_max_hours'], 'AC3: the row type has no names, tickets or staff-only fields');

-- AC2: show_eta off hides the numbers.
select tests.as_postgres();
update app.queues set show_eta = false where id = tests.id('queue_w');
select tests.as_anon();
select is((select concat_ws(' ', eta_state, eta_low, eta_high) from api.get_location_wait('test-location-a')
           where queue_id = tests.id('queue_w')), 'hidden', 'AC2: show_eta off gives hidden and no numbers');

-- A paused queue does not accept.
select tests.as_postgres();
update app.queues set show_eta = true, manual_state = 'paused' where id = tests.id('queue_w');
select tests.as_anon();
select ok(not (select accepting from api.get_location_wait('test-location-a') where queue_id = tests.id('queue_w')),
  'a paused queue is not accepting');

-- Archived queues are left out; redirected slugs resolve; unknown slugs are not_found.
select tests.as_postgres();
update app.queues set archived_at = now() where id = tests.id('queue_w');
insert into app.slug_redirects (old_slug, org_id, location_id) values ('old-loc-a', tests.id('org_a'), tests.id('loc_a'));
select tests.as_anon();
select is((select count(*)::int from api.get_location_wait('old-loc-a') where queue_id = tests.id('queue_w')), 0,
  'an archived queue is left out');
select ok((select count(*) from api.get_location_wait('old-loc-a')) >= 1, 'an old slug resolves to the location');
select throws_ok($$ select * from api.get_location_wait('no-such-place') $$, 'P0001', 'not_found',
  'an unknown slug is not_found');

-- Closed by its hours: the next opening is reported. Open: null.
select tests.as_postgres();
update app.queues set archived_at = null where id = tests.id('queue_w');
insert into app.hours_exceptions (org_id, location_id, date, closed)
select org_id, id, (now() at time zone tz)::date, true from app.locations where id = tests.id('loc_a');
select tests.as_anon();
select is((select opens_next_at is not null and opens_next_at > now() from api.get_location_wait('test-location-a')
           where queue_id = tests.id('queue_w')), true, 'a location closed today reports when it next opens');
select tests.as_postgres();
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.as_anon();
select is((select opens_next_at from api.get_location_wait('test-location-a') where queue_id = tests.id('queue_w')),
  null, 'an open location has no opens_next_at');

-- 2A-Q9 (#108): party bounds are published only while the queue asks for a party size.
select is((select party_size_min || '-' || party_size_max from api.get_location_wait('test-location-a') where queue_id = tests.id('queue_w')) is null,
  true, 'party bounds are null while party size is off');
select tests.as_postgres();
update app.queues set party_size_enabled = true, party_size_min = 2, party_size_max = 6 where id = tests.id('queue_w');
select tests.as_anon();
select is((select party_size_min || '-' || party_size_max from api.get_location_wait('test-location-a') where queue_id = tests.id('queue_w')),
  '2-6', 'and the queue''s bounds once it is on');

select * from finish();
rollback;
