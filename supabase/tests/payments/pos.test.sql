-- 4-PAY1 (#387): counter payments. Staff request an amount; the guest's page finds it by link token.
begin;
\ir ../helpers/_setup.psql
select plan(26);
select tests.create_world();

select tests.as_postgres();
delete from app.payment_jobs;
delete from app.payments;
select tests.new_visit('visit_pos', 'queue_a');
alter table app.visits disable trigger guard_visit;
update app.visits set guest_token_hash = private.token_hash('tok-pos-visit-1') where id = tests.id('visit_pos');
alter table app.visits enable trigger guard_visit;
select private.set_actor('staff', null, 'call');
update app.visits set status = 'called' where id = tests.id('visit_pos');
select private.set_actor('staff', null, 'start');
update app.visits set status = 'serving' where id = tests.id('visit_pos');
select tests.new_visit('visit_wait', 'queue_a');

-- AC2: org B staff get not_found for org A's visit; so do members without a role at the location.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.staff_request_payment(%L, 1500, 'usd', gen_random_uuid()) $$, tests.id('visit_pos')),
  'P0001', 'not_found', 'AC2: another org''s staff get not_found');
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_request_payment(%L, 0, 'usd', gen_random_uuid()) $$, tests.id('visit_pos')),
  'P0001', 'invalid_input', 'a zero amount is refused');
select throws_ok(format($$ select api.staff_request_payment(%L, 100, 'USD', gen_random_uuid()) $$, tests.id('visit_pos')),
  'P0001', 'invalid_input', 'a currency must be lower-case ISO');
select throws_ok(format($$ select api.staff_request_payment(%L, 100, 'usd', gen_random_uuid()) $$, tests.id('visit_wait')),
  'P0001', 'illegal_payment_action', 'a waiting visit cannot be asked to pay');
select tests.as_anon();
select throws_ok(format($$ select api.staff_request_payment(%L, 100, 'usd', gen_random_uuid()) $$, tests.id('visit_pos')),
  '42501', null, 'anon cannot request a payment');

-- Staff request; repeating a key is the same answer.
select tests.act_as('staff');
select is((select amount_minor from api.staff_request_payment(tests.id('visit_pos'), 1500, 'usd', '00000000-0000-4000-8000-0000000000a1')),
  1500::bigint, 'staff request 15.00');
select is((select status || '/' || kind from api.staff_request_payment(tests.id('visit_pos'), 1500, 'usd', '00000000-0000-4000-8000-0000000000a1')),
  'requires_action/pos', 'a repeat of the key replays it');
select tests.as_postgres();
select is((select count(*) from app.payments where kind = 'pos'), 1::bigint, 'and creates one payment');
select is((select provider from app.payments where kind = 'pos'), 'pending', 'the provider is fixed later');

-- A new request corrects the amount until the guest opens the page.
select tests.act_as('staff');
select is((select amount_minor from api.staff_request_payment(tests.id('visit_pos'), 1800, 'usd', '00000000-0000-4000-8000-0000000000a2')),
  1800::bigint, 'a new request replaces the unopened one');
select tests.as_postgres();
select is((select count(*) from app.payments where kind = 'pos'), 1::bigint, 'still one payment');

-- The guest's page: service role only.
select tests.as_anon();
select throws_ok($$ select * from api.begin_pos_payment('tok-pos-visit-1', 'fake') $$, '42501', null, 'anon cannot peek');
select tests.act_as('owner');
select throws_ok($$ select * from api.begin_pos_payment('tok-pos-visit-1', 'fake') $$, '42501', null, 'signed-in users cannot peek');
select tests.as_service();
select is((select amount_minor from api.begin_pos_payment('tok-pos-visit-1', 'fake')), 1800::bigint,
  'AC1: the guest''s token finds the amount staff asked for');
select throws_ok($$ select * from api.begin_pos_payment('no-such-token-xx', 'fake') $$, 'P0001', 'not_found', 'an unknown token is not_found');
select tests.as_postgres();
select is((select provider from app.payments where kind = 'pos'), 'fake', 'the first open fixes the provider');
update app.payments set intent_id = 'pi_pos' where kind = 'pos';
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_request_payment(%L, 2000, 'usd', gen_random_uuid()) $$, tests.id('visit_pos')),
  'P0001', 'illegal_payment_action', 'once the guest has an intent the amount cannot change');

-- A custom role without payments.request, and a suspended org, cannot ask.
select tests.as_postgres();
update app.memberships set custom_role_id = tests.id('role_a')
where org_id = tests.id('org_a') and user_id = tests.id('staff');
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_request_payment(%L, 100, 'usd', gen_random_uuid()) $$, tests.id('visit_pos')),
  '42501', null, 'a custom role without payments.request cannot ask');
select tests.as_postgres();
update app.memberships set custom_role_id = null where org_id = tests.id('org_a') and user_id = tests.id('staff');
update app.organizations set status = 'suspended' where id = tests.id('org_a');
select tests.act_as('owner');
select throws_ok(format($$ select api.staff_request_payment(%L, 100, 'usd', gen_random_uuid()) $$, tests.id('visit_pos')),
  '42501', null, 'a suspended org cannot ask');
select tests.as_postgres();
update app.organizations set status = 'active' where id = tests.id('org_a');

-- Paid: the webhook path marks it, and a verified email contact gets one receipt.
select tests.as_postgres();
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_email'), tests.id('org_a'), tests.id('guest_a'), 'email', 'gina@example.test', 'online');
update app.guest_contacts set verified_at = now() where id = tests.id('contact_email');
update app.visits set contact_id = tests.id('contact_email') where id = tests.id('visit_pos');
select tests.as_service();
select is(api.apply_payment_event(tests.id('org_a'), 'fake', 'succeeded', 'pi_pos', tests.id('org_a'), 1800, null, null), 'applied',
  'the success event applies');
select tests.as_postgres();
select is((select status from app.payments where kind = 'pos'), 'succeeded', 'AC1: the payment is paid');
select is((select count(*) from app.notifications where template_key = 'receipt'), 1::bigint,
  'a verified email contact gets a receipt');
select is((select vars ->> 'amount' from app.notifications where template_key = 'receipt'), '18.00 USD', 'with the amount');
update app.payments set status = 'refunded' where kind = 'pos';
update app.payments set status = 'succeeded' where kind = 'pos';
select is((select count(*) from app.notifications where template_key = 'receipt'), 1::bigint, 'a repeat never sends a second');

-- An email contact nobody verified gets nothing either, nor does an address only typed into the form.
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_unverified'), tests.id('org_a'), tests.id('guest_a'), 'email', 'unverified@example.test', 'online');
select tests.new_visit('visit_typed', 'queue_a');
update app.visits set guest_email = 'typed@example.test', contact_id = tests.id('contact_unverified') where id = tests.id('visit_typed');
insert into app.payments (org_id, location_id, visit_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('visit_typed'), 'fake', 'pi_typed', 'pos', 'requires_action', 500, 'usd', 'typed');
update app.payments set status = 'succeeded' where intent_id = 'pi_typed';
select is((select count(*) from app.notifications where template_key = 'receipt'), 1::bigint, 'an address only typed into the form gets no receipt');
select throws_ok($$ insert into app.payments (org_id, location_id, visit_id, provider, kind, amount_minor, currency, idempotency_key)
  values (gen_random_uuid(), gen_random_uuid(), null, 'x', 'bogus', 1, 'usd', 'k') $$, '23514', null, 'other kinds stay refused');

select * from finish();
rollback;
