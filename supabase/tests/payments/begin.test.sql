-- 3-PAY3 (#364): token to payment requirement, recorded before the provider is called.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

select tests.as_postgres();
-- Fixture policy on service_a is a 500 hold; give the visit a link token and a service.
insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                              guest_name, source, idempotency_key, guest_token_hash)
values (tests.new_id('appt_far'), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '20 days', now() + interval '20 days 20 minutes', (now() + interval '20 days')::date,
        'Far', 'staff', gen_random_uuid(), private.token_hash('tok-pay-visit-1')),
       (tests.new_id('appt_near'), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '2 days', now() + interval '2 days 20 minutes', (now() + interval '2 days')::date,
        'Near', 'staff', gen_random_uuid(), private.token_hash('tok-pay-near-1'));
delete from app.payment_jobs;
delete from app.payments;

select tests.as_service();
select is((select kind from api.begin_payment('tok-pay-visit-1', 'fake', 'k1')), 'card_on_file', 'an appointment further out than 6 days gets a saved card');
select is((select amount_minor from api.begin_payment('tok-pay-visit-1', 'fake', 'k2')), 500::bigint, 'the amount is the policy amount');
select tests.as_postgres();
select is((select count(*)::int from app.payments), 1, 'repeating for the same visit reuses the payment');
select tests.as_service();
select is((select payment_id from api.begin_payment('tok-pay-visit-1', 'fake', 'k3')), (select id from app.payments), 'and returns the same id');
select lives_ok(format($$ select api.attach_payment_intent(%L, 'pi_1', null) $$, (select id from app.payments)), 'the intent id attaches');
select tests.as_postgres();
select is((select intent_id from app.payments), 'pi_1', 'and sticks');

select tests.as_postgres();
update app.payments set status = 'failed';
select tests.as_service();
select throws_ok($$ select api.begin_payment('tok-pay-near-1', 'fake', 'k1') $$, 'P0001', 'invalid_input', 'a key used for another booking is refused');
select is((select kind from api.begin_payment('tok-pay-near-1', 'fake', 'k4')), 'hold', 'an appointment within 6 days gets a hold');
select throws_ok($$ select api.begin_payment('no-such-token-xx', 'fake', 'k9') $$, 'P0001', 'not_found', 'an unknown token is not_found');
select tests.as_postgres();
update app.payment_policies set mode = 'none' where service_id = tests.id('service_a');
select tests.as_service();
select throws_ok($$ select api.begin_payment('tok-pay-visit-1', 'fake', 'k10') $$, 'P0001', 'payment_not_required', 'no policy, no payment');
select tests.as_postgres();
update app.payment_policies set mode = 'deposit' where service_id = tests.id('service_a');

select tests.as_anon();
select throws_ok($$ select api.begin_payment('tok-pay-visit-1', 'fake', 'k11') $$, '42501', null, 'guests cannot call it directly');
select tests.act_as('staff');
select throws_ok($$ select api.begin_payment('tok-pay-visit-1', 'fake', 'k12') $$, '42501', null, 'neither can staff');

select * from finish();
rollback;
