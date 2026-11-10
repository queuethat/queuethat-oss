-- 2A-Q5 (#104): party size bounds are a queue policy enforced for every source.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5','k6']) k;
delete from app.business_hours;

create function tests.join_party(p_key text, p_size int) returns int
language sql as $$
  select (select party_size from app.visits v where v.idempotency_key = tests.id(p_key) and v.queue_id = tests.id('queue_a'))
  from (select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => p_size, p_locale => null,
    p_idempotency_key => tests.id(p_key))) j
$$;

-- AC2: disabled stores 1 whatever the client sent.
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.50"}', true);
select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G', p_phone_e164 => null,
  p_email => null, p_party_size => 6, p_locale => null, p_idempotency_key => tests.id('k1'));
select tests.as_postgres();
select is((select party_size from app.visits where idempotency_key = tests.id('k1')), 1, 'AC2: with party size off, 6 is stored as 1');

update app.queues set party_size_enabled = true, party_size_min = 1, party_size_max = 8 where id = tests.id('queue_a');

-- AC1: bounds 1-8 reject 9.
select tests.as_anon();
select throws_ok(format($$ select api.join_queue(p_queue_id => %L, p_service_id => null, p_name => 'G', p_phone_e164 => null,
  p_email => null, p_party_size => 9, p_locale => null, p_idempotency_key => %L) $$, tests.id('queue_a'), tests.id('k2')),
  'P0001', 'party_size_out_of_range', 'AC1: anon with party size 9 on bounds 1-8');
select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G', p_phone_e164 => null,
  p_email => null, p_party_size => 8, p_locale => null, p_idempotency_key => tests.id('k3'));
select tests.as_postgres();
select is((select party_size from app.visits where idempotency_key = tests.id('k3')), 8, 'the upper bound is accepted and stored');

update app.queues set party_size_min = 2 where id = tests.id('queue_a');
select tests.as_anon();
select throws_ok(format($$ select api.join_queue(p_queue_id => %L, p_service_id => null, p_name => 'G', p_phone_e164 => null,
  p_email => null, p_party_size => 1, p_locale => null, p_idempotency_key => %L) $$, tests.id('queue_a'), tests.id('k4')),
  'P0001', 'party_size_out_of_range', 'below the minimum is rejected');

-- AC3: staff adds follow the same rules.
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_add_visit(%L, null, 'W', null, 0, %L) $$, tests.id('queue_a'), tests.id('k5')),
  'P0001', 'invalid_input', 'AC3: staff_add_visit with 0 is rejected');
select throws_ok(format($$ select api.staff_add_visit(%L, null, 'W', null, 9, %L) $$, tests.id('queue_a'), tests.id('k5')),
  'P0001', 'party_size_out_of_range', 'AC3: staff_add_visit above the maximum is rejected');
select lives_ok(format($$ select api.staff_add_visit(%L, null, 'W', null, 4, %L) $$, tests.id('queue_a'), tests.id('k6')),
  'staff_add_visit inside the bounds works');

-- Bounds must be consistent.
select tests.as_postgres();
select throws_ok($$ update app.queues set party_size_min = 9, party_size_max = 3 where id = tests.id('queue_a') $$,
  '23514', null, 'min above max is refused by the table');
select throws_ok($$ update app.queues set party_size_max = 51 where id = tests.id('queue_a') $$,
  '23514', null, 'max above 50 is refused');

select * from finish();
rollback;
