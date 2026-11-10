-- 2P-RPT1 (#197): api.history_stats buckets, percentiles, access and DST behaviour.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();

insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_ber'), tests.id('org_a'), 'Berlin', 'test-berlin', 'Europe/Berlin');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_ber'), tests.id('org_a'), tests.id('loc_ber'), 'Main', 'B');

-- Historical rows arrive in their final state; the transition guard is off while the fixture loads.
alter table app.visits disable trigger user;
create function tests.hv(p_n int, p_status api.visit_state, p_day date, p_joined timestamptz,
                         p_called_s int default null, p_service_s int default null,
                         p_queue text default 'queue_ber', p_guest text default 'Guest')
returns void language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id(p_queue));
begin
  perform private.set_actor('system', null);
  insert into app.visits (org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                          idempotency_key, joined_at, called_at, serving_at, finished_at)
  values (q.org_id, q.location_id, q.id, p_day, 'B', p_n, 'B' || p_n, p_status, p_n, p_guest,
          extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(), p_joined,
          p_joined + make_interval(secs => p_called_s), p_joined + make_interval(secs => p_called_s),
          p_joined + make_interval(secs => p_called_s + p_service_s));
end $$;

-- Fixture day 2026-03-02, Berlin (UTC+1): hour 09 has waits 60/120/180/600 s, hour 10 has two leavers.
select tests.hv(1, 'served', '2026-03-02', '2026-03-02 08:05+00', 60, 300);
select tests.hv(2, 'served', '2026-03-02', '2026-03-02 08:10+00', 120, 500);
select tests.hv(3, 'served', '2026-03-02', '2026-03-02 08:20+00', 180, 400);
select tests.hv(4, 'no_show', '2026-03-02', '2026-03-02 08:30+00', 600);
select tests.hv(5, 'cancelled', '2026-03-02', '2026-03-02 09:15+00');
select tests.hv(6, 'removed', '2026-03-02', '2026-03-02 09:20+00');
select tests.hv(7, 'expired', '2026-03-01', '2026-03-01 23:30+00');

alter table app.visits enable trigger user;
select tests.act_as('manager');
select is((select count(*)::int from api.history_stats(tests.id('loc_ber'), '2026-03-01', '2026-03-02', 'hour')), 3,
  'hour buckets are returned only where visits joined');
select results_eq($$
  select bucket_label, joined, served, no_show, cancelled, removed, expired, avg_wait_s, p50_wait_s, p90_wait_s, avg_service_s
  from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'hour') order by bucket_start
$$, $$ values
  ('2026-03-02 09:00', 4, 3, 1, 0, 0, 0, 240, 150, 474, 400),
  ('2026-03-02 10:00', 2, 0, 0, 1, 1, 0, null, null, null, null)
$$, 'AC1: counts and wait percentiles match the hand-computed hour');
select is((select bucket_start from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'hour') order by 1 limit 1),
  '2026-03-02 08:00+00'::timestamptz, 'hour bucket_start is the instant the local hour begins');
select results_eq($$
  select bucket_label, joined, served, expired from api.history_stats(tests.id('loc_ber'), '2026-03-01', '2026-03-02', 'day') order by 1
$$, $$ values ('2026-03-01', 1, 0, 1), ('2026-03-02', 6, 3, 0) $$, 'day buckets follow service_day');
select is((select joined from api.history_stats(tests.id('loc_ber'), '2026-03-01', '2026-03-02', 'day', tests.id('queue_ber')) order by 1 limit 1),
  1, 'the queue filter keeps the matching queue');
select is_empty($$ select 1 from api.history_stats(tests.id('loc_ber'), '2026-03-01', '2026-03-02', 'day', tests.id('queue_a')) $$,
  'and drops other queues');

-- AC2: anonymized visits give identical results.
select tests.as_postgres();
create table tests.before (like api.history_bucket);
grant all on tests.before to authenticated;
select tests.act_as('manager');
insert into tests.before select * from api.history_stats(tests.id('loc_ber'), '2026-03-01', '2026-03-02', 'hour');
select tests.as_postgres();
select private.set_actor('system', null);
alter table app.visits disable trigger user;
update app.visits set guest_name = null, guest_id = null, contact_id = null where location_id = tests.id('loc_ber');
alter table app.visits enable trigger user;
select tests.act_as('manager');
select set_eq($$ select * from api.history_stats(tests.id('loc_ber'), '2026-03-01', '2026-03-02', 'hour') $$,
  $$ select * from tests.before $$, 'AC2: anonymizing guests leaves the stats unchanged');

-- AC3: access.
select tests.act_as('admin');
select lives_ok($$ select * from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'day') $$, 'admins may call it');
select tests.act_as('staff');
select throws_ok($$ select * from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'day') $$, '42501', 'permission_denied',
  'AC3: staff are denied');
select tests.act_as('other_owner');
select throws_ok($$ select * from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'day') $$, 'P0001', 'not_found',
  'AC3: an org B owner gets not_found');
select tests.as_anon();
select throws_ok($$ select * from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'day') $$, '42501', null,
  'anon cannot execute it');
select tests.act_as('manager');
select throws_ok($$ select * from api.history_stats(gen_random_uuid(), '2026-03-02', '2026-03-02', 'day') $$, 'P0001', 'not_found',
  'an unknown location is not_found');
select throws_ok($$ select * from api.history_stats(tests.id('loc_ber'), '2026-03-02', '2026-03-02', 'week') $$, 'P0001', 'invalid_input',
  'an unknown bucket is invalid_input');
select throws_ok($$ select * from api.history_stats(tests.id('loc_ber'), '2025-01-01', '2026-03-02', 'day') $$, 'P0001', 'invalid_input',
  'a range over 400 days is invalid_input');

-- AC4: structural rule.
select tests.as_postgres();
select is_empty($$
  select c.oid::regclass::text from pg_class c
  where c.relnamespace in ('api'::regnamespace, 'app'::regnamespace)
    and ((c.relkind = 'm') or (c.relkind = 'v' and not coalesce('security_invoker=true' = any (c.reloptions), false)))
$$, 'AC4: no materialized view and no view without security_invoker in api or app');

alter table app.visits disable trigger user;
-- AC5: Berlin DST change (2026-03-29 has 23 local hours): hours 02 is skipped, nothing is duplicated.
select tests.hv(100 + h, 'served', '2026-03-29', ('2026-03-29 00:00+00'::timestamptz + make_interval(hours => h)), 30, 30)
from generate_series(-1, 21) h;
alter table app.visits enable trigger user;
select tests.act_as('manager');
select is((select count(*)::int from api.history_stats(tests.id('loc_ber'), '2026-03-29', '2026-03-29', 'hour')), 23,
  'AC5: the spring-forward day has 23 distinct local hour buckets, none duplicated');

-- Performance: one year of 200 visits a day.
select tests.as_postgres();
alter table app.visits disable trigger user;
select private.set_actor('system', null);
insert into app.visits (org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number, display_ticket,
                        status, sort_key, guest_name, guest_token_hash, source, idempotency_key, joined_at,
                        called_at, serving_at, finished_at)
select q.org_id, q.location_id, q.id, d::date, 'P', n, 'P' || n, 'served', n, 'G',
       extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(),
       d + make_interval(hours => 8, mins => n % 600), d + make_interval(hours => 8, mins => n % 600 + 5),
       d + make_interval(hours => 8, mins => n % 600 + 6), d + make_interval(hours => 8, mins => n % 600 + 15)
from app.queues q, generate_series('2025-04-01'::date, '2026-02-28'::date, '1 day') d, generate_series(1, 200) n
where q.id = tests.id('queue_ber');
alter table app.visits enable trigger user;
analyze app.visits;
select tests.act_as('manager');
create temp table perf as select clock_timestamp() as t0;
select count(*) from api.history_stats(tests.id('loc_ber'), '2025-04-01', '2026-02-28', 'day');
select ok(clock_timestamp() - (select t0 from perf) < interval '500 ms', 'a year of 200 visits a day buckets in under 500 ms');

select * from finish();
rollback;
