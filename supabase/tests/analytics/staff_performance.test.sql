-- 2B-R1 (#292): api.staff_performance values, scoping and cross-tenant denial.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

create function tests.perf_visit(p_n int, p_status api.visit_state, p_staff text, p_service_s int,
                                 p_counter text default 'counter_a', p_auto boolean default false)
returns void language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id('queue_a'));
  j timestamptz := '2026-03-02 15:00+00'::timestamptz + make_interval(mins => p_n);
  vid uuid := gen_random_uuid();
begin
  perform private.set_actor('system', null);
  insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                          idempotency_key, joined_at, called_at, serving_at, finished_at, counter_id)
  values (vid, q.org_id, q.location_id, q.id, '2026-03-02', 'P', p_n, 'P' || p_n, p_status, p_n, 'G',
          extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(), j,
          j + interval '1 minute', j + interval '90 seconds', j + interval '90 seconds' + make_interval(secs => p_service_s),
          tests.id(p_counter));
  insert into app.visit_events (org_id, visit_id, type, from_status, to_status, actor_kind, actor_id, occurred_at, payload)
  values (q.org_id, vid, 'call', 'waiting', 'called', 'staff', tests.id(p_staff), j, '{}');
  if p_auto then
    insert into app.visit_events (org_id, visit_id, type, from_status, to_status, actor_kind, payload)
    values (q.org_id, vid, 'complete', 'serving', p_status, 'system', '{"auto_closed": true}');
  end if;
end $$;

alter table app.visits disable trigger user;
select tests.perf_visit(1, 'served', 'staff', 600);
select tests.perf_visit(2, 'served', 'staff', 1200);
select tests.perf_visit(3, 'served', 'staff', 1800);
select tests.perf_visit(4, 'no_show', 'staff', 0);
select tests.perf_visit(5, 'served', 'manager', 300, 'counter_pair');
select tests.perf_visit(6, 'served', 'staff', 99999, 'counter_a', true);
alter table app.visits enable trigger user;

select tests.act_as('manager');
select results_eq($$ select served, avg_service_sec, avg_wait_sec, no_shows from api.staff_performance(
    tests.id('loc_a'), '2026-03-02', '2026-03-02', 'staff') where grp_id = tests.id('staff') $$,
  $$ values (3, 1200, 30, 1) $$, 'AC1: visits of 10, 20 and 30 min average 20 min; auto-closed excluded');
select is((select count(*)::int from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'staff')), 2,
  'a manager sees every staff member who called visits');
select results_eq($$ select label, served from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'counter')
  order by label $$, $$ values ('Chair 1', 3), ('Chair 2', 1) $$, 'by counter groups on counter_id');

select tests.act_as('staff');
select results_eq($$ select grp_id from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'staff') $$,
  $$ values (tests.id('staff')) $$, 'AC2: a staff caller receives only their own row');
select is((select count(*)::int from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'counter')), 1,
  'by counter, staff see only counters where they called visits');

select tests.act_as('other_owner');
select is_empty($$ select 1 from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'staff') $$,
  'AC3: another org''s owner gets zero rows');

select tests.act_as('manager');
select throws_ok($$ select * from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'queue') $$,
  'P0001', 'invalid_input', 'an unknown grouping is rejected');
select tests.act_as('display');
select is_empty($$ select 1 from api.staff_performance(tests.id('loc_a'), '2026-03-02', '2026-03-02', 'staff') $$,
  'a display device gets zero rows');

select * from finish();
rollback;
