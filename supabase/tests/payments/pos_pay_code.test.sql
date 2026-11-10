-- 4-PAY2 (#992): the staff tablet's pay code for a counter payment.
begin;
\ir ../helpers/_setup.psql
select plan(24);
select tests.create_world();

select tests.as_postgres();
delete from app.payment_jobs;
delete from app.payments;
select tests.new_visit('visit_pos', 'queue_a');
alter table app.visits disable trigger guard_visit;
update app.visits set guest_token_hash = private.token_hash('tok-pay-code-1') where id = tests.id('visit_pos');
alter table app.visits enable trigger guard_visit;
select private.set_actor('staff', null, 'call');
update app.visits set status = 'called' where id = tests.id('visit_pos');

-- No unpaid request yet: nothing to show a code for.
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  'P0001', 'illegal_payment_action', 'no code before staff request a payment');
select api.staff_request_payment(tests.id('visit_pos'), 1500, 'usd', gen_random_uuid());

-- Who may mint.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  'P0001', 'not_found', 'AC: another org''s staff get not_found');
select tests.as_anon();
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  '42501', null, 'anon cannot mint a code');
select tests.as_service();
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  '42501', null, 'the service role cannot mint a code');

select tests.act_as('staff');
create temp table minted as select * from api.staff_create_pay_code(tests.id('visit_pos'));
grant all on minted to public;
select matches((select code from minted), '^[0-9A-HJKMNP-TV-Z]{8}$', 'an 8 character code');
select ok((select expires_at from minted) between now() + interval '9 minutes' and now() + interval '10 minutes 1 second',
  'valid for ten minutes');

-- Stored hashed only.
select tests.as_postgres();
select is((select count(*) from app.pay_codes), 1::bigint, 'one live code');
select is((select count(*) from app.pay_codes where code_hash = extensions.digest((select code from minted), 'sha256')), 1::bigint,
  'stored as sha256');
select is((select count(*) from app.pay_codes c where encode(c.code_hash, 'escape') like '%' || (select code from minted) || '%'), 0::bigint,
  'the plain code is not stored');

-- Redeem: service role only.
select tests.as_anon();
select throws_ok(format($$ select * from api.begin_pos_payment_by_code(%L, 'fake') $$, (select code from minted)),
  '42501', null, 'anon cannot redeem');
select tests.act_as('owner');
select throws_ok(format($$ select * from api.begin_pos_payment_by_code(%L, 'fake') $$, (select code from minted)),
  '42501', null, 'signed-in users cannot redeem');
select tests.as_service();
select is((select amount_minor from api.begin_pos_payment_by_code((select code from minted), 'fake')), 1500::bigint,
  'AC: the code opens the amount staff asked for');
select is((select amount_minor from api.begin_pos_payment_by_code(lower(substr((select code from minted), 1, 4)) || '-' || substr((select code from minted), 5), 'fake')),
  1500::bigint, 'case and a hyphen do not matter');
select throws_ok($$ select * from api.begin_pos_payment_by_code('ZZZZZZZZ', 'fake') $$, 'P0001', 'not_found', 'an unknown code is not_found');
select throws_ok($$ select * from api.begin_pos_payment_by_code('short', 'fake') $$, 'P0001', 'invalid_input', 'a malformed code is invalid_input');
select tests.as_postgres();
select is((select provider from app.payments where kind = 'pos'), 'fake', 'the first open fixes the provider');

-- The guest's link token is unaffected and never exposed.
select is((select amount_minor from api.begin_pos_payment('tok-pay-code-1', 'fake')), 1500::bigint, 'the token path still works');

-- A new code replaces the old one.
select tests.act_as('staff');
create temp table minted2 as select * from api.staff_create_pay_code(tests.id('visit_pos'));
grant all on minted2 to public;
select tests.as_service();
select throws_ok(format($$ select * from api.begin_pos_payment_by_code(%L, 'fake') $$, (select code from minted)),
  'P0001', 'not_found', 'AC: asking again replaces the earlier code');
select is((select amount_minor from api.begin_pos_payment_by_code((select code from minted2), 'fake')), 1500::bigint, 'the new one works');

-- Expiry.
select tests.as_postgres();
update app.pay_codes set expires_at = now() - interval '1 second';
select tests.as_service();
select throws_ok(format($$ select * from api.begin_pos_payment_by_code(%L, 'fake') $$, (select code from minted2)),
  'P0001', 'not_found', 'AC: an expired code is not_found');

-- Custom role without payments.request, suspended org.
select tests.as_postgres();
update app.memberships set custom_role_id = tests.id('role_a') where org_id = tests.id('org_a') and user_id = tests.id('staff');
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  '42501', null, 'a custom role without payments.request cannot mint');
select tests.as_postgres();
update app.memberships set custom_role_id = null where org_id = tests.id('org_a') and user_id = tests.id('staff');
update app.organizations set status = 'suspended' where id = tests.id('org_a');
select tests.act_as('owner');
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  '42501', null, 'a suspended org cannot mint');
select tests.as_postgres();
update app.organizations set status = 'active' where id = tests.id('org_a');

-- Once paid, a fresh code still in date is dead.
select tests.act_as('staff');
create temp table minted3 as select * from api.staff_create_pay_code(tests.id('visit_pos'));
grant all on minted3 to public;
select tests.as_postgres();
update app.payments set intent_id = 'pi_code', status = 'succeeded' where kind = 'pos';
select tests.as_service();
select throws_ok(format($$ select * from api.begin_pos_payment_by_code(%L, 'fake') $$, (select code from minted3)),
  'P0001', 'not_found', 'AC: a paid payment''s code is not_found');
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_create_pay_code(%L) $$, tests.id('visit_pos')),
  'P0001', 'illegal_payment_action', 'and no new code once paid');

select * from finish();
rollback;
