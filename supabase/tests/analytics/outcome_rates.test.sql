-- 2P-RPT2 (#198): api.outcome_rates definitions, access and the shared history_stats check.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

create function tests.ov(p_n int, p_status api.visit_state, p_called_s int default null, p_end_s int default null,
                         p_day date default '2026-03-02')
returns void language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id('queue_a'));
  j timestamptz := p_day + interval '10 hours' + make_interval(mins => p_n);
begin
  perform private.set_actor('system', null);
  insert into app.visits (org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                          idempotency_key, joined_at, called_at, finished_at)
  values (q.org_id, q.location_id, q.id, p_day, 'R', p_n, 'R' || p_n, p_status, p_n, 'G',
          extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(), j,
          j + make_interval(secs => p_called_s), j + make_interval(secs => p_end_s));
end $$;

alter table app.visits disable trigger user;
-- 10 called: 8 served, 2 no-shows. 4 cancelled while waiting (2 min, 15 min, 15 min, 45 min). 3 expired.
select tests.ov(n, 'served', 60, 600) from generate_series(1, 8) n;
select tests.ov(n, 'no_show', 60, 120) from generate_series(9, 10) n;
select tests.ov(11, 'cancelled', null, 120);
select tests.ov(12, 'cancelled', null, 900);
select tests.ov(13, 'cancelled', null, 900);
select tests.ov(14, 'cancelled', null, 2700);
select tests.ov(n, 'expired', null, null) from generate_series(15, 17) n;
alter table app.visits enable trigger user;

select tests.act_as('manager');
select results_eq($$
  select left_waiting, cancelled, abandonment_rate, called, no_show, no_show_rate, abandon_lt10, abandon_10_30, abandon_gt30
  from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day')
$$, $$ values (14, 4, 0.2857, 10, 2, 0.2000, 1, 2, 1) $$,
  'AC1: 10 called and 2 no-shows give 0.2000; expired visits are in no figure (AC2)');
select is((select count(*)::int from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'hour')), 1,
  'hour buckets work too');
select is((select abandonment_rate from api.outcome_rates(tests.id('loc_a'), '2026-03-03', '2026-03-03', 'day')), null,
  'a day without visits has no bucket');
select tests.act_as('admin');
select lives_ok($$ select * from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day') $$, 'admins may call it');
select tests.act_as('staff');
select throws_ok($$ select * from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day') $$, '42501', 'permission_denied',
  'staff are denied');
select tests.act_as('other_owner');
select throws_ok($$ select * from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day') $$, 'P0001', 'not_found',
  'AC3: an org B owner gets not_found');
select throws_ok($$ select * from api.history_stats(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day') $$, 'P0001', 'not_found',
  'history_stats keeps the same check after moving to the shared helper');
select tests.as_anon();
select throws_ok($$ select * from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day') $$, '42501', null,
  'anon cannot execute it');
select tests.act_as('manager');
select throws_ok($$ select * from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'week') $$, 'P0001', 'invalid_input',
  'an unknown bucket is invalid_input');
select is((select sum(joined)::int from api.history_stats(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day')), 17,
  'history_stats still counts every visit');
select is((select count(*)::int from api.outcome_rates(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'day')), 1,
  'one day bucket');

select * from finish();
rollback;
