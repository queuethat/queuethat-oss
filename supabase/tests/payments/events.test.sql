-- V2 (#318): payment holds and idempotent, monotonic provider events.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

select tests.as_service();
select lives_ok($$ select api.create_payment_hold(tests.id('org_a'), null, null, 'fake', 'h1', 2500, 'USD', 'k1') $$, 'a hold is recorded');
select is(api.create_payment_hold(tests.id('org_a'), null, null, 'fake', 'h1', 2500, 'USD', 'k1'),
          api.create_payment_hold(tests.id('org_a'), null, null, 'fake', 'h1', 2500, 'USD', 'k1'), 'the same idempotency key returns the same hold');

select is(api.record_payment_event('fake', 'e1', 'hold_succeeded', 'h1', null, now()), 'recorded', 'the first event is recorded');
select is(api.record_payment_event('fake', 'e1', 'hold_succeeded', 'h1', null, now()), 'duplicate', 'a replay is a duplicate');
select tests.as_postgres();
select is((select count(*)::int from app.payment_events where provider_event_id = 'e1'), 1, 'one event row for a twice-delivered event');
select is((select status::text from app.payment_holds where provider_hold_id = 'h1'), 'held', 'and one status change');
select tests.as_service();
select api.record_payment_event('fake', 'e2', 'captured', 'h1', 2500, now());
select api.record_payment_event('fake', 'e3', 'released', 'h1', null, now());
select tests.as_postgres();
select is((select status::text from app.payment_holds where provider_hold_id = 'h1'), 'captured', 'a cancel after capture leaves the hold captured');
select tests.as_service();
select is(api.record_payment_event('fake', 'e4', 'captured', 'nope', 1, now()), 'unknown_hold', 'an unknown hold is reported, not recorded');

select tests.act_as('other_owner');
select is((select count(*)::int from app.payment_holds), 0, 'an admin of org B sees no holds of org A');
select throws_ok($$ select api.record_payment_event('fake', 'e9', 'released', 'h1', null, now()) $$, '42501', null, 'signed-in users cannot record events');

select * from finish();
rollback;
