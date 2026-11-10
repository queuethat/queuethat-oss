-- V6 (#35): api.get_visit_status, api.guest_act and api.get_location_public.
begin;
\ir ../helpers/_setup.psql
select plan(41);
select tests.create_world();

-- Fixtures: loc_a open all day. Three guests join queue_a behind the world's visit_a (Ann with a
-- phone and email, Bob, Cara); a paused and an archived queue in loc_a; org B's queue in loc_b.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, manual_state, sort_order) values
  (tests.new_id('queue_paused'), tests.id('org_a'), tests.id('loc_a'), 'Returns', 'R', 'paused', 1);
insert into app.queues (id, org_id, location_id, name, ticket_prefix, archived_at) values
  (tests.new_id('queue_old'), tests.id('org_a'), tests.id('loc_a'), 'Old', 'O', now());
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
insert into app.services (id, org_id, location_id, queue_id, name, active) values
  (tests.new_id('service_off'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'Retired', false);
create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;

select tests.as_anon();
insert into tests.tokens (name, token)
  select 'ann', (api.join_queue(tests.id('queue_a'), tests.id('service_a'), 'Ann', '+14155550188',
                                'ann@example.com', 2, 'en', gen_random_uuid())).token;
insert into tests.tokens (name, token)
  select 'bob', (api.join_queue(tests.id('queue_a'), null, 'Bob', null, null, 1, 'en', gen_random_uuid())).token;
insert into tests.tokens (name, token)
  select 'cara', (api.join_queue(tests.id('queue_a'), null, 'Cara', null, null, 1, 'en', gen_random_uuid())).token;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id
from app.visits v where v.guest_token_hash = private.token_hash(t.token);

create function tests.status(p_name text) returns api.visit_status
language sql as $$ select api.get_visit_status((select token from tests.tokens where name = p_name)) $$;
create function tests.leave(p_name text) returns api.visit_status
language sql as $$
  select api.guest_act((select token from tests.tokens where name = p_name), 'leave', gen_random_uuid())
$$;
create function tests.vid(p_name text) returns uuid
language sql as $$ select visit_id from tests.tokens where name = p_name $$;
grant execute on all functions in schema tests to anon;

------------------------------------------------------------------------------------------------
-- get_visit_status: a waiting guest (AC1)
------------------------------------------------------------------------------------------------
select tests.as_anon();
select results_eq($$ select (s).status::text, (s).position, (s).people_ahead, (s).queue_name,
                            (s).location_name, (s).counter_label, (s).call_count
                     from (select tests.status('ann') s) x $$,
  $$ values ('waiting', 2, 1, 'Walk-ins', 'Location A', null::text, 0) $$,
  'a waiting guest sees status, position 2 behind visit_a, people ahead, queue and location');
select is((tests.status('ann')).guest_actions, array['leave', 'need_more_time']::api.guest_action[],
  'a waiting guest may leave or ask for more time');
select ok((tests.status('ann')).eta_state is not null and (tests.status('ann')).eta_low is not null,
  'a waiting guest gets an ETA');
select is((tests.status('ann')).as_of, now(), 'as_of is the server time');
select is((tests.status('cara')).position, 4, 'positions follow join order');
select tests.as_postgres();
select is(row((tests.status('ann')).eta_state, (tests.status('ann')).eta_low, (tests.status('ann')).eta_high)::text,
  (select row(e.eta_state, e.eta_low, e.eta_high)::text from private.visit_eta(tests.vid('ann')) e),
  'the ETA is private.visit_eta');
select is((tests.status('ann')).version, (select version from app.visits where id = tests.vid('ann')),
  'version is the visit''s version');
select is((tests.status('ann')).display_ticket, (select display_ticket from app.visits where id = tests.vid('ann')),
  'the ticket is the visit''s display ticket');
select is((tests.status('ann')).queue_pulse_id,
  (select pulse_id from app.queues where id = tests.id('queue_a')), 'the pulse topic is the queue''s pulse_id');

-- AC1: no contact data, no names, no other guests.
select set_eq($$ select a.attname::text from pg_attribute a
                 where a.attrelid = 'api.visit_status'::regclass and a.attnum > 0 $$,
  array['display_ticket', 'status', 'position', 'people_ahead', 'eta_state', 'eta_low', 'eta_high',
        'counter_label', 'call_count', 'called_at', 'queue_name', 'location_name', 'queue_pulse_id',
        'guest_actions', 'version', 'as_of', 'grace_until', 'warn_at', 'snoozes_left', 'on_the_way', 'companions',
        'chat_version', 'unread_staff_messages', 'arrive_after', 'text_consent'],
  'AC1: visit_status has no name, phone, email, contact or guest id field (companions: own party only; arrive_after: its own reserved time; text_consent: none, off or on, never the number)');
select set_config('request.method', 'GET', true);
select throws_ok($$ select tests.status('ann') $$, 'P0001', 'invalid_input',
  'get_visit_status refuses GET, so the token never travels in a URL');
select set_config('request.method', 'POST', true);
select tests.as_anon();
select ok(to_jsonb(tests.status('ann'))::text !~* '(ann|bob|cara|4155550188|example\.com)',
  'AC1: the status of a guest with phone and email contains none of them, nor other guests'' names');

------------------------------------------------------------------------------------------------
-- get_visit_status: a called guest
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select (api.call_next(tests.id('queue_a'), tests.id('counter_a'), gen_random_uuid())).id;
select (api.call_next(tests.id('queue_a'), tests.id('counter_a'), gen_random_uuid())).id;
select tests.as_anon();
select results_eq($$ select (s).status::text, (s).position, (s).people_ahead, (s).counter_label,
                            (s).call_count, (s).called_at is not null, (s).eta_state::text
                     from (select tests.status('ann') s) x $$,
  $$ values ('called', null::int, null::int, 'Chair 1', 1, true, null::text) $$,
  'a called guest sees the counter, call count and time, and no position or ETA');
select is((tests.status('ann')).guest_actions, array['leave', 'on_my_way', 'need_more_time']::api.guest_action[],
  'a called guest may still leave, say they are on the way or ask for more time');
select is((tests.status('bob')).position, 1, 'the guest behind is now first');

------------------------------------------------------------------------------------------------
-- guest_act leave (AC3)
------------------------------------------------------------------------------------------------
select tests.as_postgres();
create table tests.marks (name text primary key, n bigint);
insert into tests.marks select 'version', version from app.queues where id = tests.id('queue_a');
grant select on tests.marks to anon;

select tests.as_anon();
select results_eq($$ select (s).status::text, (s).position, (s).guest_actions from (select tests.leave('bob') s) x $$,
  $$ values ('cancelled', null::int, '{undo_leave}'::api.guest_action[]) $$,
  'leave moves a waiting guest to cancelled; only undo_leave remains');
select tests.as_postgres();
select results_eq($$ select type, from_status::text, to_status::text, actor_kind::text, actor_id
                     from app.visit_events where visit_id = tests.vid('bob') order by id desc limit 1 $$,
  $$ values ('cancel', 'waiting', 'cancelled', 'guest', null::uuid) $$,
  'leave writes a cancel event with the guest as actor');
select ok((select finished_at is not null from app.visits where id = tests.vid('bob')), 'leave sets finished_at');
select is((select version from app.queues where id = tests.id('queue_a')),
  (select n + 1 from tests.marks where name = 'version'), 'leave bumps the queue version once');
insert into tests.marks select 'events', count(*) from app.visit_events where visit_id = tests.vid('bob');
update tests.marks set n = (select version from app.queues where id = tests.id('queue_a')) where name = 'version';

select tests.as_anon();
select is((tests.leave('bob')).status, 'cancelled'::api.visit_state,
  'AC3: leaving twice returns cancelled without error');
select tests.as_postgres();
select is((select count(*) from app.visit_events where visit_id = tests.vid('bob')),
  (select n from tests.marks where name = 'events'), 'AC3: the second leave writes no event');
select is((select version from app.queues where id = tests.id('queue_a')),
  (select n from tests.marks where name = 'version'), 'AC3: the second leave does not bump the queue');

select tests.as_anon();
select is((tests.leave('ann')).status, 'cancelled'::api.visit_state, 'a called guest can leave');
select tests.as_postgres();
select results_eq($$ select (select status::text from app.visits where id = tests.id('visit_a')),
                            (select status::text from app.visits where id = tests.vid('cara')) $$,
  $$ values ('called', 'waiting') $$, 'a token changes only its own visit');
select tests.as_anon();
select throws_ok($$ select api.guest_act((select token from tests.tokens where name = 'cara'), null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'guest_act without an action raises invalid_input');

-- A visit that was served can no longer be left.
select tests.as_postgres();
select private.set_actor('system', null, 'call');
update app.visits set status = 'called', called_at = now() where id = tests.vid('cara');
select private.set_actor('system', null, 'start');
update app.visits set status = 'serving', serving_at = now() where id = tests.vid('cara');
select private.set_actor('system', null, 'complete');
update app.visits set status = 'served', finished_at = now() - interval '11 hours' where id = tests.vid('cara');
select tests.as_anon();
select throws_ok($$ select tests.leave('cara') $$, 'P0001', 'illegal_transition',
  'leave after being served raises illegal_transition');
select results_eq($$ select (s).status::text, (s).counter_label, (s).guest_actions from (select tests.status('cara') s) x $$,
  $$ values ('served', null::text, '{}'::api.guest_action[]) $$,
  'a visit that ended 11 hours ago is still visible, with no actions');

------------------------------------------------------------------------------------------------
-- Unknown and expired tokens (AC2)
------------------------------------------------------------------------------------------------
select throws_ok($$ select api.get_visit_status('no-such-token') $$, 'P0001', 'not_found',
  'AC2: an unknown token raises not_found');
select throws_ok($$ select api.get_visit_status(null) $$, 'P0001', 'not_found', 'a null token raises not_found');
select tests.as_postgres();
select private.set_actor('system', null);
update app.visits set finished_at = now() - interval '12 hours 1 minute' where id = tests.vid('cara');
select tests.as_anon();
select throws_ok($$ select tests.status('cara') $$, 'P0001', 'not_found',
  'AC2: a token 12 hours after the visit ended raises the same not_found');
select throws_ok($$ select tests.leave('cara') $$, 'P0001', 'not_found',
  'guest_act on an expired token raises not_found too');
-- Rollover's expire sets no finished_at: the visit ends at its expire event, so it is shown.
insert into tests.tokens (name, token)
  select 'dan', (api.join_queue(tests.id('queue_a'), null, 'Dan', null, null, 1, 'en', gen_random_uuid())).token;
select tests.as_postgres();
select private.set_actor('system', null, 'expire');
update app.visits set status = 'expired' where guest_token_hash = (select private.token_hash(token) from tests.tokens where name = 'dan');
select tests.as_anon();
select is((tests.status('dan')).status, 'expired'::api.visit_state,
  'a visit expired without finished_at is still shown within 12 hours of its last event');

------------------------------------------------------------------------------------------------
-- get_location_public
------------------------------------------------------------------------------------------------
select tests.as_anon();
create temp table loc as select (api.get_location_public('test-location-a')).*;
select results_eq($$ select id, name, slug, tz from loc $$,
  $$ values (tests.id('loc_a'), 'Location A', 'test-location-a', 'America/New_York') $$,
  'the location by slug');
select results_eq($$ select q.name, q.state::text, q.accepting, q.not_accepting_reason
                     from loc, unnest(loc.queues) q $$,
  $$ values ('Walk-ins', 'open', true, null::text), ('Returns', 'paused', false, 'paused') $$,
  'non-archived queues in sort order with the accepting predicate; archived and other locations'' left out');
select is((select q.services from loc, unnest(loc.queues) q where q.id = tests.id('queue_a')),
  array[row(tests.id('service_a'), 'Haircut', null)::api.public_service], 'only active services');
select is((select q.waiting_count from loc, unnest(loc.queues) q where q.id = tests.id('queue_a')), 0,
  'the waiting count');
select tests.as_postgres();
select is((select row(q.eta_state, q.eta_low, q.eta_high)::text from loc, unnest(loc.queues) q where q.id = tests.id('queue_a')),
  (select row(e.eta_state, e.eta_low, e.eta_high)::text from private.queue_eta(tests.id('queue_a')) e),
  'the ETA is private.queue_eta');
select is((select q.pulse_id from loc, unnest(loc.queues) q where q.id = tests.id('queue_a')),
  (select pulse_id from app.queues where id = tests.id('queue_a')), 'each queue carries its pulse topic');
select tests.as_anon();
select is((api.get_location_public('old-location-a')).slug, 'test-location-a',
  'an old slug resolves to the location with its current slug');
select throws_ok($$ select api.get_location_public('nope') $$, 'P0001', 'not_found', 'an unknown slug raises not_found');
select is((api.get_location_public('test-location-b')).queues[1].name, 'Other org',
  'another org''s location shows only its own queues');

select * from finish();
rollback;
