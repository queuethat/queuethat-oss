-- V9 (#38): commit-time pulses and location signals, and who may receive or send them.
begin;
\ir ../helpers/_setup.psql
select plan(22);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Pickups', 'P');

-- The sends are deferred to commit, which a test transaction never reaches. flush() fires the
-- pending deferred triggers now, as COMMIT would, then defers again.
create function tests.flush() returns void
language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
create function tests.sent(p_event text) returns setof realtime.messages
language sql as $$
  select * from realtime.messages where event = p_event order by inserted_at, id
$$;
create table tests.topics as select 'qpulse:' || pulse_id as pulse from app.queues where id = tests.id('queue_a');
create function tests.pulse_topic() returns text language sql as $$ select pulse from tests.topics $$;
grant execute on all functions in schema tests to anon, authenticated;
grant select on tests.topics to anon, authenticated;

select tests.flush();
delete from realtime.messages;

-- AC1: a committed transition sends one pulse with only {version, now_serving}.
select tests.act_as('staff');
select api.call_next(tests.id('queue_a'), tests.id('counter_a'), gen_random_uuid());
select tests.as_postgres();
select is((select count(*) from realtime.messages), 0::bigint, 'nothing is sent before commit');
select tests.flush();

select is((select count(*) from tests.sent('pulse')), 1::bigint, 'call_next sends one pulse');
select is((select topic from tests.sent('pulse')), tests.pulse_topic(),
  'the pulse goes to the queue''s qpulse topic');
select is((select array_agg(k order by k) from tests.sent('pulse'), jsonb_object_keys(payload) k),
  array['id', 'now_serving', 'version'],
  'pulse payload keys are version and now_serving (id is added by realtime.send)');
select is((select (payload ->> 'version')::bigint from tests.sent('pulse')),
  (select version from app.queues where id = tests.id('queue_a')),
  'pulse version is the queue version after the bump');
select is((select payload ->> 'now_serving' from tests.sent('pulse')),
  (select display_ticket from app.visits where id = tests.id('visit_a')),
  'now_serving is the ticket just called');
select is((select count(*) from tests.sent('signal')), 1::bigint, 'call_next sends one signal');
select is((select topic from tests.sent('signal')), 'loc:' || tests.id('loc_a'),
  'the signal goes to the location topic');
select is((select array_agg(k order by k) from tests.sent('signal'), jsonb_object_keys(payload) k),
  array['id', 'queue_id', 'version', 'visit_id'], 'signal payload keys');
select is((select payload ->> 'visit_id' from tests.sent('signal')), tests.id('visit_a')::text,
  'the signal names the called visit');
select ok((select bool_and(private) from realtime.messages), 'every message is private');

-- A guest join signals too, with the bumped version.
delete from realtime.messages;
create table tests.before as select version from app.queues where id = tests.id('queue_a');
select tests.as_anon();
select api.join_queue(tests.id('queue_a'), null, 'Dee', null, null, 1, 'en', gen_random_uuid());
select tests.as_postgres();
select tests.flush();
select is((select count(*) from tests.sent('pulse')), 1::bigint, 'a guest join sends a pulse');
select is((select (payload ->> 'version')::bigint from tests.sent('signal')),
  (select version + 1 from tests.before), 'a join signals the bumped queue version');

-- A queue-only change signals with no visit; two queues in one transaction get one each.
delete from realtime.messages;
select tests.act_as('staff');
select api.set_queue_state(tests.id('queue_a'), 'paused');
select api.set_queue_state(tests.id('queue_a'), 'open');
select api.set_queue_state(tests.id('queue_a2'), 'paused');
select tests.as_postgres();
select tests.flush();
select is((select count(*) from tests.sent('pulse')), 2::bigint,
  'three changes to two queues send one pulse per queue');
select ok((select bool_and(payload -> 'visit_id' = 'null') from tests.sent('signal')),
  'queue state signals carry a null visit_id');

-- AC2: only staff and devices of the location may receive loc:; nobody may send.
create function tests.can_receive(p_actor text, p_topic text) returns boolean
language plpgsql as $$
declare n bigint;
begin
  perform tests.act_as(p_actor);
  perform set_config('realtime.topic', p_topic, true);
  select count(*) into n from realtime.messages where topic = p_topic;
  perform tests.as_postgres();
  return n > 0;
end $$;
select realtime.send('{}', 'probe', 'loc:' || tests.id('loc_a'), true);
select realtime.send('{}', 'probe', tests.pulse_topic(), true);

select ok(tests.can_receive('staff', 'loc:' || tests.id('loc_a')), 'staff of loc_a receive loc_a');
select ok(tests.can_receive('display', 'loc:' || tests.id('loc_a')), 'loc_a''s display receives loc_a');
select ok(not tests.can_receive('other_owner', 'loc:' || tests.id('loc_a')),
  'org B''s owner cannot receive loc_a');
select ok(not tests.can_receive('anon', 'loc:' || tests.id('loc_a')), 'anon cannot receive loc_a');
select ok(tests.can_receive('anon', tests.pulse_topic()), 'anon receives a queue pulse');

select tests.as_anon();
select set_config('realtime.topic', tests.pulse_topic(), true);
select throws_ok(
  format($$insert into realtime.messages (topic, extension, event, payload, private)
           values (%L, 'broadcast', 'pulse', '{"version": 999}', true)$$, tests.pulse_topic()),
  '42501', null, 'anon cannot send a forged pulse');
select tests.act_as('staff');
select set_config('realtime.topic', 'loc:' || tests.id('loc_a'), true);
select throws_ok(
  format($$insert into realtime.messages (topic, extension, event, payload, private)
           values (%L, 'broadcast', 'signal', '{}', true)$$, 'loc:' || tests.id('loc_a')),
  '42501', null, 'staff cannot send on the location topic');
select tests.as_postgres();

select * from finish();
rollback;
