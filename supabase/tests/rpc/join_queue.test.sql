-- V1 (#30): api.join_queue, private.join_core and the accepting predicate.
begin;
\ir ../helpers/_setup.psql
select plan(45);
select tests.create_world();
-- 2A-Q5: party size is a queue policy; these tests join with a party of 2.
update app.queues set party_size_enabled = true, party_size_max = 8 where id = tests.id('queue_a');

/** The DETAIL of the error p_sql raises, or null when it succeeds. */
create function tests.error_detail(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;

/** Every row in our schemas whose JSON form contains p_needle, as schema.table. */
create function tests.rows_containing(p_needle text) returns setof text
language plpgsql as $$
declare t record; n bigint;
begin
  for t in select format('%I.%I', c.relnamespace::regnamespace::text, c.relname) as rel
           from pg_class c
           where c.relkind in ('r', 'p') and c.relnamespace::regnamespace::text = any(tests.own_schemas())
  loop
    execute format('select count(*) from %s x where to_jsonb(x)::text like %L', t.rel,
                   '%' || p_needle || '%') into n;
    if n > 0 then
      return next t.rel;
    end if;
  end loop;
end $$;

-- Fixtures: the shared queue_a with no opening hours, plus queues for capacity and the rate cap,
-- and an org B queue for cross-tenant checks.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, capacity) values
  (tests.new_id('queue_cap'), tests.id('org_a'), tests.id('loc_a'), 'Small', 'C', 3);
insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_rate_per_min) values
  (tests.new_id('queue_rate'), tests.id('org_a'), tests.id('loc_a'), 'Slow', 'R', 2);
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
insert into app.services (id, org_id, location_id, queue_id, name) values
  (tests.new_id('service_b'), tests.id('org_b'), tests.id('loc_b'), tests.id('queue_b'), 'Other');
select tests.new_id(k) from unnest(array['key_1', 'key_pat', 'key_none', 'key_gina', 'key_kiosk']) k;
create table tests.results (name text primary key, r api.join_result);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.results to anon, authenticated;
grant execute on function tests.error_detail(text) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- AC1: idempotent join
------------------------------------------------------------------------------------------------
select tests.as_anon();
insert into tests.results values
  ('first', api.join_queue(tests.id('queue_a'), tests.id('service_a'), '  Ann  ', null, null, 2, 'en-US', tests.id('key_1')));
insert into tests.results values
  ('again', api.join_queue(tests.id('queue_a'), tests.id('service_a'), 'Ann', null, null, 2, 'en-US', tests.id('key_1')));
select tests.as_postgres();

select is((select (r).display_ticket from tests.results where name = 'again'),
          (select (r).display_ticket from tests.results where name = 'first'),
  'AC1: joining twice with the same key returns the same ticket');
select is((select count(*)::int from app.visits where idempotency_key = tests.id('key_1')), 1,
  'AC1: joining twice with the same key creates one visit');
select is((select (r).token from tests.results where name = 'again'), null,
  'AC1: the repeated call returns no token without the device key that joined (#474 tests that)');
select is((select (r).status::text from tests.results where name = 'first'), 'waiting',
  'a new visit is waiting');
select is((select (r).display_ticket from tests.results where name = 'first'), 'A002',
  'tickets come from the queue''s counter (fixture visit_a holds A001)');

------------------------------------------------------------------------------------------------
-- AC4: server values only; AC5: token stored only as a hash
------------------------------------------------------------------------------------------------
select is_empty($$
  select a from pg_proc p, unnest(p.proargnames) a
  where p.oid = 'api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text, uuid, timestamptz)'::regprocedure
    and a ~ '(priority|status|org|ticket|source|sort)'
$$, 'AC4: join_queue takes no priority, status, org, ticket, source or ordering argument');
select results_eq($$
  select org_id, location_id, status::text, source, service_day, ticket_prefix, guest_name, party_size, locale
  from app.visits where idempotency_key = tests.id('key_1')
$$, $$
  values (tests.id('org_a'), tests.id('loc_a'), 'waiting', 'online',
          private.service_day(tests.id('loc_a')), 'A', 'Ann', 2, 'en-US')
$$, 'AC4: org, location, status, source, day and prefix come from the server; the name is trimmed');

select ok((select (r).token ~ '^[A-Za-z0-9_-]{43}$' from tests.results where name = 'first'),
  'AC5: the token is 32 bytes, base64url');
select is((select guest_token_hash from app.visits where idempotency_key = tests.id('key_1')),
          (select private.token_hash((r).token) from tests.results where name = 'first'),
  'AC5: the visit stores the token''s sha256');
select is_empty(format('select * from tests.rows_containing(%L)',
                       (select (r).token from tests.results where name = 'first')),
  'AC5: no row in api, app, private, ops or public contains the plaintext token');
select results_eq($$
  select type, actor_kind::text, actor_id, payload ->> 'source' from app.visit_events e
  join app.visits v on v.id = e.visit_id where v.idempotency_key = tests.id('key_1')
$$, $$ values ('joined', 'guest', null::uuid, 'online') $$,
  'the join writes one joined event with the guest actor');

------------------------------------------------------------------------------------------------
-- AC2: paused, closed and outside hours reject every join; a repeat still returns its visit
------------------------------------------------------------------------------------------------
update app.queues set manual_state = 'paused' where id = tests.id('queue_a');
select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'queue_not_accepting', 'AC2: a paused queue rejects joins');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$),
  'paused', 'the reason is the error DETAIL');
select is((api.join_queue(tests.id('queue_a'), tests.id('service_a'), 'Ann', null, null, 2, 'en-US', tests.id('key_1'))).display_ticket,
  'A002', 'a repeated key returns its visit even while the queue is paused');
select tests.as_postgres();
update app.queues set manual_state = 'closed' where id = tests.id('queue_a');
select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'queue_not_accepting', 'AC2: a closed queue rejects joins');
select tests.as_postgres();
update app.queues set manual_state = 'open', archived_at = now() where id = tests.id('queue_a');
select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'an archived queue is not found');
select tests.as_postgres();
update app.queues set archived_at = null where id = tests.id('queue_a');
insert into app.hours_exceptions (org_id, location_id, date, closed)
values (tests.id('org_a'), tests.id('loc_a'), (now() at time zone 'America/New_York')::date, true);
select tests.as_anon();
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$),
  'outside_hours', 'a queue outside its opening hours rejects joins');
select tests.as_postgres();
delete from app.hours_exceptions where location_id = tests.id('loc_a');

------------------------------------------------------------------------------------------------
-- AC3: capacity; rate cap
------------------------------------------------------------------------------------------------
select tests.as_anon();
select api.join_queue(tests.id('queue_cap'), null, 'C' || i, null, null, 1, null, gen_random_uuid())
from generate_series(1, 3) i;
select throws_ok($$ select api.join_queue(tests.id('queue_cap'), null, 'C4', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'capacity_reached', 'AC3: a 4th join to a capacity-3 queue with 3 waiting is rejected');
select tests.as_postgres();
select is(private.queue_not_accepting_reason(tests.id('queue_cap')), 'full', 'the predicate reports full');
select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where queue_id = tests.id('queue_cap') and display_ticket = 'C001';
select tests.as_anon();
select is((api.join_queue(tests.id('queue_cap'), null, 'C4', null, null, 1, null, gen_random_uuid())).display_ticket,
  'C004', 'capacity counts waiting guests only, so a call frees a place');

select api.join_queue(tests.id('queue_rate'), null, 'R' || i, null, null, 1, null, gen_random_uuid())
from generate_series(1, 2) i;
select throws_ok($$ select api.join_queue(tests.id('queue_rate'), null, 'R3', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'rate_limited', 'joins beyond join_rate_per_min in a minute are rate limited');
select tests.as_postgres();
select ok(private.queue_is_accepting(tests.id('queue_rate')), 'the rate cap is not part of the accepting predicate');
-- Staff adds (V4) share join_core but are neither capped nor counted.
select ok((select visit_id is not null from private.join_core(tests.id('queue_rate'), null, 'S', null, null, 1, null,
  gen_random_uuid(), 'staff', 'staff', tests.id('staff'))), 'staff adds are not rate limited');

------------------------------------------------------------------------------------------------
-- Input validation and contacts
------------------------------------------------------------------------------------------------
select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, repeat('x', 61), null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a name over 60 characters is rejected');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, E'Bo\nBby', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a name with control characters is rejected');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', '415 555 0100', null, 1, null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a phone number without a country code is rejected');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, 'not-an-email', 1, null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a malformed email is rejected');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 0, null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a party size below 1 is rejected');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, null) $$,
  'P0001', 'invalid_input', 'a join without an idempotency key is rejected');

select api.join_queue(tests.id('queue_a'), null, 'Pat', '+1 (415) 555-0100', ' Pat@Example.COM ', null, null, tests.id('key_pat'));
select api.join_queue(tests.id('queue_a'), null, 'Nobody', '', '  ', null, null, tests.id('key_none'));
select api.join_queue(tests.id('queue_a'), null, 'Gina', '+14155550123', null, null, null, tests.id('key_gina'));
select tests.as_postgres();
select results_eq($$
  select guest_phone_e164, guest_email, guest_id, contact_id from app.visits where idempotency_key = tests.id('key_pat')
$$, $$ values ('+14155550100', 'pat@example.com', null::uuid, null::uuid) $$,
  'phone is stored on the visit normalised to E.164 and email lower-cased, with no guest or contact');
select is((select count(*)::int from app.guest_contacts where value in ('+14155550100', 'pat@example.com')), 0,
  'a guest join creates no guest_contacts row (no squatting a number)');
select results_eq($$ select guest_id, contact_id, party_size, locale from app.visits where idempotency_key = tests.id('key_none') $$,
  $$ values (null::uuid, null::uuid, 1, 'en') $$,
  'with no phone or email nothing is stored; party size and locale take their defaults');
select results_eq($$ select guest_id, contact_id from app.visits where idempotency_key = tests.id('key_gina') $$,
  $$ values (null::uuid, null::uuid) $$,
  'a guest join with a phone the org already has links to neither that contact nor its guest');
select results_eq($$ select guest_id, first_name from app.guest_contacts c join app.guests g on g.id = c.guest_id
                     where c.id = tests.id('contact_a') $$,
  $$ values (tests.id('guest_a'), 'Gina') $$,
  'the existing contact and guest are unchanged');
select private.join_core(tests.id('queue_a'), null, 'Gina', '+14155550123', null, null, null,
  tests.new_id('key_staff'), 'staff', 'staff', tests.id('staff'));
select results_eq($$ select guest_id, contact_id from app.visits where idempotency_key = tests.id('key_staff') $$,
  $$ values (tests.id('guest_a'), tests.id('contact_a')) $$,
  'a staff add with a known phone links the existing contact and guest');

------------------------------------------------------------------------------------------------
-- Cross-tenant and kiosk
------------------------------------------------------------------------------------------------
select tests.as_anon();
select throws_ok($$ select api.join_queue(gen_random_uuid(), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'an unknown queue is not found');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), tests.id('service_b'), 'Bo', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'cross-tenant: a service of another org''s queue is not found');
select tests.act_as('kiosk');
select is((api.join_queue(tests.id('queue_a'), null, 'Kim', null, null, 1, null, tests.id('key_kiosk'))).status::text,
  'waiting', 'a kiosk joins a queue of its own location');
select throws_ok($$ select api.join_queue(tests.id('queue_b'), null, 'Kim', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'cross-tenant: a kiosk cannot join another location''s queue');
select tests.as_postgres();
select results_eq($$
  select v.source, e.actor_kind::text, e.actor_id from app.visits v join app.visit_events e on e.visit_id = v.id
  where v.idempotency_key = tests.id('key_kiosk')
$$, $$ select 'kiosk', 'device', id from tests.ids where name = 'kiosk' $$,
  'a kiosk join has source kiosk and the device as actor');

------------------------------------------------------------------------------------------------
-- Opening hours (loc_a: America/New_York; loc_b has none)
------------------------------------------------------------------------------------------------
insert into app.business_hours (org_id, location_id, weekday, opens, closes) values
  (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '17:00'),  -- Monday
  (tests.id('org_a'), tests.id('loc_a'), 5, '09:00', '17:00'),  -- Friday
  (tests.id('org_a'), tests.id('loc_a'), 6, '20:00', '02:00');  -- Saturday, past midnight
insert into app.hours_exceptions (org_id, location_id, date, closed) values
  (tests.id('org_a'), tests.id('loc_a'), '2026-12-25', true);
insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values
  (tests.id('org_a'), tests.id('loc_a'), '2026-11-02', false, '12:00', '14:00');
select is(array[
    private.within_hours(tests.id('loc_a'), '2026-10-26 10:00 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-10-26 08:59 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-10-26 17:00 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-10-27 10:00 America/New_York')],
  array[true, false, false, false],
  'weekly hours: open 09:00 to 17:00 local on Monday only, closing time exclusive');
select is(array[
    private.within_hours(tests.id('loc_a'), '2026-10-31 23:00 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-11-01 01:30 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-11-01 02:00 America/New_York')],
  array[true, true, false],
  'a Saturday 20:00 to 02:00 period runs into Sunday morning');
select is(array[
    private.within_hours(tests.id('loc_a'), '2026-12-25 10:00 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-11-02 10:00 America/New_York'),
    private.within_hours(tests.id('loc_a'), '2026-11-02 13:00 America/New_York')],
  array[false, false, true],
  'a date exception replaces the weekly hours (closed all day, or other hours)');
select ok(private.within_hours(tests.id('loc_b'), '2026-12-25 03:00 Europe/Berlin'),
  'a location with no hours configured is always within hours');
select is(private.queue_not_accepting_reason(tests.id('queue_a'), '2026-10-27 10:00 America/New_York'),
  'outside_hours', 'the predicate reports outside_hours');

select * from finish();
rollback;
