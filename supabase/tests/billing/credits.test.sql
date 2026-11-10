-- 4-BILL4 (#380): prepaid SMS credit for platform-mode orgs: top-ups, debits at cost plus margin, no send at zero.
begin;
\ir ../helpers/_setup.psql
select plan(28);
select tests.create_world();

insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('us'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'US', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key, status, provider)
select tests.new_id('c' || i), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('us'), 'called', 1, 'c' || i, 'claimed', 'twilio'
from generate_series(1, 4) i;
insert into app.provider_settings (org_id, channel, provider, mode) values (tests.id('org_a'), 'sms', 'twilio', 'platform');
update app.platform_flags set billing_enabled = true;

-- AC1: a balance of zero stops the send before any provider call, and nothing is counted.
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('c1'))), 'insufficient_credit', 'AC1: no credit, no send');
select tests.as_postgres();
select is((select coalesce(sum(sent), 0)::int from app.usage_counters where org_id = tests.id('org_a') and channel = 'sms'
  and day = (now() at time zone 'UTC')::date), 0, 'the refused send is not counted');
select ok((select reserved_at is null from app.notifications where id = tests.id('c1')), 'and the message is not reserved');

-- AC2: a top-up replayed twice credits once.
select tests.as_service();
select is(api.apply_credit_topup('cs_1', tests.id('org_a'), 500, 'usd'), 'applied', 'a paid session credits the org');
select is(api.apply_credit_topup('cs_1', tests.id('org_a'), 500, 'usd'), 'duplicate', 'AC2: the replay is a duplicate');
select is(api.apply_credit_topup('cs_2', tests.id('org_a'), 500, 'eur'), 'ignored', 'only USD is credited');
select is(api.apply_credit_topup('cs_3', tests.id('org_a'), 5, 'usd'), 'ignored', 'and not an amount under 1.00');
select is(api.apply_credit_topup('cs_4', gen_random_uuid(), 500, 'usd'), 'unknown_org', 'an unknown org is reported');
select tests.as_postgres();
select is(private.credit_balance(tests.id('org_a')), 5000000::bigint, 'AC2: the balance rose once, by 5.00');

-- A send with credit is allowed; reporting it debits cost plus 10% margin, shown apart.
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('c1'))), 'allowed', 'with credit the send is allowed');
select api.report_outbox_result(tests.id('c1'), '{"status":"sent","provider":"twilio","segments":1,"cost_micros":10000,"currency":"USD"}');
select tests.as_postgres();
select results_eq($$ select amount_micros, cost_micros, margin_micros from app.credit_ledger where entry_type = 'debit' $$,
  $$ values (-11000::bigint, 10000::bigint, 1000::bigint) $$, 'the debit is cost plus margin, with both recorded');
select is(private.credit_balance(tests.id('org_a')), 4989000::bigint, 'and comes off the balance');
select is((select count(*) from app.notifications where template_key = 'credit_low' and org_id = tests.id('org_a')), 2::bigint,
  'dropping under $5 emails the owner and the admin');
-- the same message reported again, and a second debit the same day: no second debit, no second alert
update app.notifications set status = 'claimed' where id = tests.id('c1');
select tests.as_service();
select api.report_outbox_result(tests.id('c1'), '{"status":"sent","provider":"twilio","segments":1,"cost_micros":10000}');
select tests.as_postgres();
select is((select count(*) from app.credit_ledger where entry_type = 'debit'), 1::bigint, 'a repeated report debits once');

-- An estimated price is adjusted when the provider's final price arrives.
select tests.as_service();
select api.report_outbox_result(tests.id('c2'), '{"status":"sent","provider":"twilio","segments":1}');
select tests.as_postgres();
select is((select amount_micros from app.credit_ledger where notification_id = tests.id('c2')), -8690::bigint, 'an estimate (7900) plus margin is debited');
select tests.as_service();
select api.apply_provider_price(tests.id('org_a'), tests.id('c2'), 0.005, 'USD');
select tests.as_postgres();
select is(private.credit_balance(tests.id('org_a')), 4989000 - 8690 + 3190::bigint, 'the final price (5000) is reconciled by an adjustment');
select is((select count(*) from app.notifications where template_key = 'credit_low' and org_id = tests.id('org_a')), 2::bigint, 'one alert per member per day');

-- Not every org spends credit: billing off, or the org's own account.
update app.platform_flags set billing_enabled = false;
select ok(not private.uses_platform_credit(tests.id('org_a'), 'sms'), 'billing off: no credit is spent');
update app.platform_flags set billing_enabled = true;
update app.provider_settings set mode = 'own' where org_id = tests.id('org_a');
select ok(not private.uses_platform_credit(tests.id('org_a'), 'sms'), 'an org on its own account spends no credit');

-- The ledger is append-only, and tenants cannot read each other's.
select throws_ok($$update app.credit_ledger set amount_micros = 1$$, 'P0001', 'ledger_append_only', 'entries cannot be changed');
select throws_ok($$delete from app.credit_ledger$$, 'P0001', 'ledger_append_only', 'or deleted');
select tests.act_as('other_owner');
select is((select count(*) from app.credit_ledger), 0::bigint, 'AC3: org B cannot read org A''s ledger');
select tests.act_as('admin');
select ok((select count(*) from app.credit_ledger) > 0, 'an admin reads their own org''s ledger');

-- privileges and an unpriced send
select tests.act_as('staff');
select is((select count(*) from app.credit_ledger), 0::bigint, 'staff cannot read the ledger');
select throws_ok($$select api.apply_credit_topup('cs_9', tests.id('org_a'), 500, 'usd')$$, '42501', null, 'members cannot call apply_credit_topup');
select tests.as_anon();
select throws_ok($$select api.apply_credit_topup('cs_9', tests.id('org_a'), 500, 'usd')$$, '42501', null, 'anon cannot call apply_credit_topup');
select tests.as_postgres();
update app.provider_settings set mode = 'platform' where org_id = tests.id('org_a');
select tests.as_service();
select api.report_outbox_result(tests.id('c3'), '{"status":"sent","provider":"nowhere","segments":2}');
select tests.as_postgres();
select is((select amount_micros from app.credit_ledger where notification_id = tests.id('c3')), -22000::bigint, 'an unpriced send is debited at a flat rate plus margin');
select tests.as_service();
select api.apply_provider_price(tests.id('org_a'), tests.id('c2'), 0.005, 'USD');
select tests.as_postgres();
select is((select count(*) from app.credit_ledger where entry_type = 'adjustment' and notification_id = tests.id('c2')), 1::bigint, 'a repeated final price adjusts once');

select * from finish();
rollback;
