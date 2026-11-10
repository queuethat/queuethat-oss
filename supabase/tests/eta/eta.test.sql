-- V5 (#34): private.eta_at and its callers, the degradation order and the quoted range.
begin;
\ir ../helpers/_setup.psql
select plan(28);
select tests.create_world();

-- Fixtures: queue_eta with a 20 and a 10 minute service (a visit with no service counts their
-- average, 15), and queue_wide with one 60 minute service. loc_a open all day.
delete from app.business_hours where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_eta'), tests.id('org_a'), tests.id('loc_a'), 'Estimates', 'E'),
  (tests.new_id('queue_wide'), tests.id('org_a'), tests.id('loc_a'), 'Wide', 'W');
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes) values
  (tests.new_id('svc_20'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_eta'), 'Long', 20),
  (tests.new_id('svc_10'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_eta'), 'Short', 10),
  (tests.new_id('svc_60'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_wide'), 'Hour', 60);

/** A visit in p_queue for p_service, moved to p_status (called/serving) p_elapsed ago. */
create function tests.eta_visit(p_name text, p_queue text, p_service text,
                                p_status text default 'waiting', p_elapsed interval default '0')
returns uuid
language plpgsql as $$
declare vid uuid := tests.new_visit(p_name, p_queue);
begin
  perform private.set_actor('system', null);
  update app.visits set service_id = tests.id(p_service) where id = vid;
  if p_status in ('called', 'serving') then
    perform private.set_actor('system', null, 'call');
    update app.visits set status = 'called', called_at = now() - p_elapsed where id = vid;
  end if;
  if p_status = 'serving' then
    perform private.set_actor('system', null, 'start');
    update app.visits set status = 'serving', serving_at = now() - p_elapsed where id = vid;
  end if;
  return vid;
end $$;

/** private.queue_eta as text, e.g. 'ok 15 45'. */
create function tests.qeta(p_queue text) returns text
language sql as $$
  select concat_ws(' ', e.eta_state, e.eta_low, e.eta_high) from private.queue_eta(tests.id(p_queue)) e
$$;

------------------------------------------------------------------------------------------------
-- The formula (technical-design.md 8)
------------------------------------------------------------------------------------------------
select is(tests.qeta('queue_eta'), 'next 0 10',
  'an empty queue is next; the range is the spread of one average service (0.5 x 15)');

select tests.eta_visit('w1', 'queue_eta', 'svc_20');
select tests.eta_visit('w2', 'queue_eta', 'svc_10');
select is(tests.qeta('queue_eta'), 'ok 15 45',
  'two ahead: mean 30, sigma 0.5 x 15 x sqrt 3 = 13, rounded down to 15 and up to 45');
select is(concat_ws(' ', e.eta_state, e.eta_low, e.eta_high), 'next 0 10',
  'the first waiting visit is next') from private.visit_eta(tests.id('w1')) e;
select is(concat_ws(' ', e.eta_state, e.eta_low, e.eta_high), 'ok 5 35',
  'a visit counts only the waiting visits ahead of it (mean 20, sigma 14)')
  from private.visit_eta(tests.id('w2')) e;

select tests.eta_visit('s1', 'queue_eta', 'svc_20', 'serving', '15 minutes');
select is(tests.qeta('queue_eta'), 'ok 20 50',
  'a guest being served adds what is left of their time (20 - 15 = 5)');
select private.set_actor('system', null);
update app.visits set serving_at = now() - interval '2 hours' where id = tests.id('s1');
select is(tests.qeta('queue_eta'), 'ok 20 50',
  'an overrunning guest still counts a fifth of their time (4, same rounding)');
update app.queues set servers_on_duty = 2 where id = tests.id('queue_eta');
select is(tests.qeta('queue_eta'), 'ok 5 20',
  '#548: two servers halve the work and the spread, and the guest takes the first chair that '
  'frees: mean 34 / 2 - 15 / 4 = 13.25, sigma 6.5');
update app.queues set servers_on_duty = 4 where id = tests.id('queue_eta');
select is(tests.qeta('queue_eta'), 'ok 0 10',
  '#548: four servers: mean 34 / 4 - 3 x 15 / 8 = 2.9, sigma 3.25; never below 0');
update app.queues set servers_on_duty = 1 where id = tests.id('queue_eta');

select is(concat_ws(' ', e.eta_state, e.eta_low, e.eta_high), '',
  'a visit that is no longer waiting has no estimate') from private.visit_eta(tests.id('s1')) e;
select is(concat_ws(' ', e.eta_state, e.eta_low, e.eta_high), '',
  'an unknown visit has no estimate') from private.visit_eta(gen_random_uuid()) e;

------------------------------------------------------------------------------------------------
-- Degradation order: hidden, paused, unstaffed, next, over_hour, ok
------------------------------------------------------------------------------------------------
update app.queues set servers_on_duty = 0 where id = tests.id('queue_eta');
select is(tests.qeta('queue_eta'), 'unstaffed',
  'AC1: with servers_on_duty = 0 the state is unstaffed and no number is returned');
update app.queues set manual_state = 'paused' where id = tests.id('queue_eta');
select is(tests.qeta('queue_eta'), 'paused', 'paused comes before unstaffed and carries no number');
update app.queues set show_eta = false where id = tests.id('queue_eta');
select is(tests.qeta('queue_eta'), 'hidden', 'AC2: with show_eta = false the state is hidden, before paused');
select is(concat_ws(' ', e.eta_state, e.eta_low, e.eta_high), 'hidden',
  'AC2: a visit''s estimate is hidden too') from private.visit_eta(tests.id('w2')) e;
update app.queues set show_eta = true, manual_state = 'closed', servers_on_duty = 1 where id = tests.id('queue_eta');
select is(tests.qeta('queue_eta'), 'ok 20 50', 'a closed queue still estimates for the guests already in it');
update app.queues set manual_state = 'open' where id = tests.id('queue_eta');

select tests.eta_visit('w' || i, 'queue_eta', 'svc_20') from generate_series(3, 7) i;
select is((select e.eta_state::text from private.queue_eta(tests.id('queue_eta')) e), 'over_hour',
  'a long queue whose low end is over an hour is over_hour');
select tests.eta_visit('wide', 'queue_wide', 'svc_60');
select is(tests.qeta('queue_wide'), 'uncertain 20 105',
  'a range whose high end is over 4 times its low is uncertain, and keeps its numbers for the quote');

-- How a range is shown, at each boundary.
select is(private.eta_range_state(35, 125), 'uncertain', '35-125 is uncertain: past 120 with a low end under an hour');
select is(private.eta_range_state(60, 130), 'over_hour', '60-130 is over_hour: even the low end is an hour');
select is(private.eta_range_state(55, 120), 'ok', '55-120 is ok: 120 itself is not past 120');
select is(private.eta_range_state(10, 40), 'ok', '10-40 is ok: exactly 4 times is not more than 4 times');
select is(private.eta_range_state(10, 45), 'ok', '10-45 is ok: the 4 times rule starts past 45');
select is(private.eta_range_state(10, 50), 'uncertain', '10-50 is uncertain: past 45 and over 4 times its low end');

------------------------------------------------------------------------------------------------
-- The quoted range is stored at join
------------------------------------------------------------------------------------------------
create table tests.quotes as select 'before'::text as name, e.* from private.queue_eta(tests.id('queue_wide')) e;
select tests.new_id('key_q');
select tests.as_anon();
select api.join_queue(tests.id('queue_wide'), tests.id('svc_60'), 'Q', null, null, 1, null, tests.id('key_q'));
select tests.as_postgres();
select results_eq($$ select eta_quoted_low, eta_quoted_high from app.visits where idempotency_key = tests.id('key_q') $$,
  $$ select eta_low, eta_high from tests.quotes $$,
  'join stores the range quoted to the guest, the queue estimate before they joined');

update app.queues set show_eta = false where id = tests.id('queue_wide');
select private.join_core(tests.id('queue_wide'), null, 'Staff add', null, null, 1, null,
  tests.new_id('key_hidden'), 'staff', 'staff', tests.id('staff'));
select results_eq($$ select eta_quoted_low, eta_quoted_high from app.visits where idempotency_key = tests.id('key_hidden') $$,
  $$ values (null::int, null::int) $$, 'a queue that shows no number quotes nothing');

select private.set_actor('system', null);
insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                        display_ticket, status, sort_key, guest_token_hash, source, idempotency_key,
                        eta_quoted_low, eta_quoted_high)
values (tests.new_id('forged'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_wide'), current_date,
        'W', 99, 'W099', 'waiting', 99999, '\x00', 'online', gen_random_uuid(), 1, 2);
select results_eq($$ select eta_quoted_low, eta_quoted_high from app.visits where id = tests.id('forged') $$,
  $$ values (null::int, null::int) $$, 'a quote supplied by the inserter is replaced');

------------------------------------------------------------------------------------------------
-- Access
------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'private.visit_eta(uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.queue_eta(uuid)', 'EXECUTE'),
  'the estimate functions are not callable through the API');
select ok(not has_function_privilege('authenticated', 'private.eta_at(uuid, bigint)', 'EXECUTE'),
  'nor is the formula');

select * from finish();
rollback;
