-- S2 (#23): ticket numbers restart per service day and prefix.
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();

select is(private.next_ticket(tests.id('queue_a'), 'A', '2026-06-10'), 1, 'first ticket of a new day is 1');
select is(private.next_ticket(tests.id('queue_a'), 'A', '2026-06-10'), 2, 'second ticket is 2');
select is(private.next_ticket(tests.id('queue_a'), 'A', '2026-06-11'), 1, 'the next service day starts again at 1');
select is(private.next_ticket(tests.id('queue_a'), 'B', '2026-06-10'), 1, 'another prefix has its own sequence');

select tests.act_as('staff');
select throws_ok($$ select private.next_ticket(tests.id('queue_a'), 'A', '2026-06-10') $$,
  '42501', null, 'staff cannot take ticket numbers directly');

select * from finish();
rollback;
