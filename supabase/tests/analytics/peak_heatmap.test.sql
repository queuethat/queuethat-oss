-- 2B-R3 (#294): api.peak_heatmap suggestion arithmetic, DST hours and cross-tenant denial.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

create function tests.heat_visit(p_n int, p_joined timestamptz, p_service_s int)
returns void language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id('queue_a'));
begin
  perform private.set_actor('system', null);
  insert into app.visits (org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                          idempotency_key, joined_at, called_at, serving_at, finished_at)
  values (q.org_id, q.location_id, q.id, (p_joined at time zone 'America/New_York')::date, 'H', p_n, 'H' || p_n,
          'served', p_n, 'G', extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(),
          p_joined, p_joined + interval '5 minutes', p_joined + interval '5 minutes',
          p_joined + interval '5 minutes' + make_interval(secs => p_service_s));
end $$;

alter table app.visits disable trigger user;
-- The world's own visits join at now(): on a Monday they would add a second dow=1 row and a third open
-- day. Move them out of every window so the assertions never depend on the day the suite runs.
update app.visits set service_day = date '2020-01-01', joined_at = timestamptz '2020-01-01 12:00+00'
 where location_id = tests.id('loc_a');
-- Monday 2026-03-02 10:00 EST (15:00Z): 12 visits of 10 minutes.
select tests.heat_visit(n, '2026-03-02 15:00+00'::timestamptz + make_interval(secs => n), 600) from generate_series(1, 12) n;
-- Monday 2026-03-09 is after the DST change: 10:00 EDT is 14:00Z. 12 more visits.
select tests.heat_visit(100 + n, '2026-03-09 14:00+00'::timestamptz + make_interval(secs => n), 600) from generate_series(1, 12) n;
alter table app.visits enable trigger user;

select tests.act_as('manager');
select results_eq($$ select dow, hour, avg_arrivals, avg_wait_min, suggested_staff
  from api.peak_heatmap(tests.id('loc_a'), 52) where dow = 1 $$,
  $$ values (1, 10, 12.00, 5.0, 3) $$,
  'AC1+AC2: 12 arrivals at 10 min give ceil(12*10/60/0.8) = 3; both Mondays land in local hour 10 across DST');
select is((select suggested_staff from api.peak_heatmap(tests.id('loc_a'), 52, 0.5) where dow = 1), 4,
  'a lower target utilisation raises the suggestion (ceil(12*10/60/0.5) = 4)');
select is_empty($$ select 1 from api.peak_heatmap(tests.id('loc_a'), 1) where dow = 1 $$, 'visits older than the window are ignored');
select throws_ok($$ select * from api.peak_heatmap(tests.id('loc_a'), 0) $$, 'P0001', 'invalid_input', 'weeks below 1 are rejected');

select is((select scheduled_staff from api.peak_heatmap(tests.id('loc_a'), 52) where dow = 1), 0.0,
  'scheduled_staff is 0 for an hour nobody is rostered while the location has other shifts');
select tests.as_postgres();
insert into app.staff_shifts (org_id, location_id, user_id, during) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('staff'), tstzrange('2026-03-02 14:00+00', '2026-03-02 20:00+00')),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('manager'), tstzrange('2026-03-02 14:00+00', '2026-03-02 20:00+00')),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('staff'), tstzrange('2026-03-09 13:00+00', '2026-03-09 19:00+00'));
select tests.act_as('manager');
select results_eq($$ select suggested_staff, scheduled_staff from api.peak_heatmap(tests.id('loc_a'), 52) where dow = 1 $$,
  $$ values (3, 1.5) $$, 'AC1 (#295): scheduled staff averages 2 and 1 on the two Mondays, below the 3 suggested');

select tests.act_as('other_owner');
select is_empty($$ select 1 from api.peak_heatmap(tests.id('loc_a'), 52) where dow = 1 $$, 'AC3: another org gets zero rows');
select tests.act_as('staff');
select is_empty($$ select 1 from api.peak_heatmap(tests.id('loc_a'), 52) where dow = 1 $$, 'staff get zero rows');

select * from finish();
rollback;
