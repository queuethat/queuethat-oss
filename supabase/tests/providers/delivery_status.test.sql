-- 3-SMS2 (#351): delivery status from callbacks and price reconciliation.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('phone_d'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'US', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, provider, provider_message_id, cost_micros, cost_source, sent_at) values
  (tests.new_id('d1'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_d'), 'called', 1, 'd1', 'sent',
   'twilio', 'SM_d1', 7900, 'estimate', now() - interval '20 minutes'),
  (tests.new_id('d2'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_d'), 'called', 1, 'd2', 'sent',
   'twilio', 'SM_d2', 7900, 'estimate', now() - interval '1 minute'),
  (tests.new_id('d3'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_d'), 'called', 1, 'd3', 'sent',
   'twilio', 'SM_d3', 7900, 'estimate', now() - interval '3 days');
select tests.as_service();

-- AC1: delivered, then a late "sent", stays delivered.
select ok(api.apply_delivery_status(tests.id('org_a'), 'twilio', 'SM_d1', 'delivered'), 'delivered is recorded');
select ok(api.apply_delivery_status(tests.id('org_a'), 'twilio', 'SM_d1', 'sent'), 'a late sent callback is accepted');
select results_eq($$ select delivery_status, delivered_at is not null from app.notifications where id = tests.id('d1') $$,
  $$ values ('delivered', true) $$, 'AC1: the status stays delivered');
select api.apply_delivery_status(tests.id('org_a'), 'twilio', 'SM_d1', 'undelivered', '30003');
select is((select delivery_status from app.notifications where id = tests.id('d1')), 'delivered',
  'a final status is never replaced by another one');

-- AC3: org B's endpoint cannot touch org A's message.
select ok(not api.apply_delivery_status(tests.id('org_b'), 'twilio', 'SM_d2', 'failed'), 'another org matches nothing');
select is((select delivery_status from app.notifications where id = tests.id('d2')), null, 'and nothing changed');

-- Only rows 10 minutes to 48 hours old, still estimated, are up for reconciliation.
select results_eq($$ select id from api.pending_price_reconciliation(100) $$, $$ values (tests.id('d1')) $$,
  'reconciliation candidates exclude fresh and 48 h+ rows');

-- AC2: -0.0079 USD is 7900 micros from the provider.
select api.apply_provider_price(tests.id('org_a'), tests.id('d1'), -0.0079, 'usd');
select results_eq($$ select cost_micros, cost_source, currency::text from app.notifications where id = tests.id('d1') $$,
  $$ values (7900::bigint, 'provider', 'USD') $$, 'AC2: price reconciled to micros');
select api.apply_provider_price(tests.id('org_b'), tests.id('d2'), -1, 'USD');
select is((select cost_source from app.notifications where id = tests.id('d2')), 'estimate', 'another org cannot price the row');
select api.apply_provider_price(tests.id('org_a'), tests.id('d2'), null, null);
select ok((select price_checked_at is not null and cost_source = 'estimate' from app.notifications where id = tests.id('d2')),
  'a null price only records the check');

select * from finish();
rollback;
