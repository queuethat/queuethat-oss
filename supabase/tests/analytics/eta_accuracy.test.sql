-- 2B-W2 (#290): api.eta_accuracy.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();

create function tests.ev(p_n int, p_lo int, p_hi int, p_wait_min int, p_day date default '2026-03-02')
returns uuid language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id('queue_a'));
  j timestamptz := p_day + interval '10 hours' + make_interval(mins => p_n);
  vid uuid := gen_random_uuid();
begin
  insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                          idempotency_key, joined_at, called_at, eta_quoted_low, eta_quoted_high)
  values (vid, q.org_id, q.location_id, q.id, p_day, 'E', p_n, 'E' || p_n, 'called', p_n, 'G',
          extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(), j,
          j + make_interval(mins => p_wait_min), p_lo, p_hi);
  return vid;
end $$;

alter table app.visits disable trigger user;
-- AC1: quoted 10-20 min, waited 5, 15 and 30.
select tests.ev(1, 10, 20, 5);
select tests.ev(2, 10, 20, 15);
select tests.ev(3, 10, 20, 30);
-- AC2: called without a quote.
select tests.ev(4, null, null, 7);
-- A recall: called_at is later than the first call event, which wins (waited 12, not 40).
select tests.ev(5, 10, 20, 40, '2026-03-03') as recalled \gset
insert into app.visit_events (org_id, visit_id, type, to_status, actor_kind, occurred_at)
values (tests.id('org_a'), :'recalled', 'call', 'called', 'staff', '2026-03-03 10:05Z'::timestamptz + interval '12 minutes');

select tests.act_as('manager');
select is((select row(visits, within_range_pct, pct_early, pct_late, excluded_no_quote)::text
           from api.eta_accuracy(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day')),
  '(3,33.3,33.3,33.3,1)', 'AC1/AC2: waits 5, 15, 30 on a 10-20 quote split in thirds; the unquoted visit is only excluded');
select is((select row(bias_min, avg_late_min, median_error_min, p90_error_min)::text
           from api.eta_accuracy(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day')),
  '(1.7,10.0,5.0,9.0)', 'bias, average miss when late, median and p90 error (errors 0, 5, 10)');
select is((select within_range_pct from api.eta_accuracy(tests.id('loc_a'), '2026-03-03', '2026-03-03', 'day')),
  100.0, 'a recall does not move the wait: the first call event (12 min) wins over called_at (40 min)');
select is((select count(*)::int from api.eta_accuracy(tests.id('loc_a'), '2026-03-02', '2026-03-03', 'day')), 2, 'grouping by day: one row per day');
select is((select count(*)::int from api.eta_accuracy(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'hour')),
  1, 'grouping by hour returns one bucket');
select is((select count(*)::int from api.eta_accuracy(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'service')),
  1, 'grouping by service returns one row');
select throws_ok(format($$ select * from api.eta_accuracy(%L, '2026-03-02', '2026-03-02', 'week') $$, tests.id('loc_a')),
  'P0001', 'invalid_input', 'an unknown group is refused');

select tests.act_as('staff');
select throws_ok(format($$ select * from api.eta_accuracy(%L, '2026-03-02', '2026-03-02', 'day') $$, tests.id('loc_a')),
  '42501', null, 'staff below manager are refused');
select tests.act_as('other_owner');
select throws_ok(format($$ select * from api.eta_accuracy(%L, '2026-03-02', '2026-03-02', 'day') $$, tests.id('loc_a')),
  'P0001', 'not_found', 'AC3: org B gets nothing for an org A location');

select * from finish();
rollback;
