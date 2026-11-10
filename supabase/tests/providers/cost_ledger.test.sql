-- 3-PV4 (#343): per-message cost on report_outbox_result and api.usage_summary.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('phone_c'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'US', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, provider) values
  (tests.new_id('s1'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_c'), 'called', 1, 's1', 'claimed', 'twilio'),
  (tests.new_id('s2'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_c'), 'called', 1, 's2', 'claimed', 'twilio'),
  (tests.new_id('s3'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_c'), 'called', 1, 's3', 'claimed', 'twilio'),
  (tests.new_id('s4'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_c'), 'called', 1, 's4', 'claimed', 'twilio'),
  (tests.new_id('s5'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_c'), 'called', 1, 's5', 'claimed', 'telnyx');

select tests.as_service();
select api.report_outbox_result(tests.id('s1'), '{"status": "sent", "provider": "twilio", "segments": 1}');
select api.report_outbox_result(tests.id('s2'), '{"status": "sent", "provider": "twilio", "segments": 2}');
select api.report_outbox_result(tests.id('s3'), '{"status": "sent", "provider": "twilio", "segments": 3}');
select api.report_outbox_result(tests.id('s4'), '{"status": "suppressed", "provider": "twilio", "error_code": "no_consent"}');
select tests.as_postgres();

select results_eq($$ select segments, cost_micros, cost_source, currency::text from app.notifications
                     where id = tests.id('s3') $$,
  $$ values (3, 23700::bigint, 'estimate', 'USD') $$, 'a sent SMS with no quoted price is priced at segments x the rate');
select ok((select sent_at is not null from app.notifications where id = tests.id('s1')), 'a sent row records sent_at');
select results_eq($$ select cost_micros, cost_source from app.notifications where id = tests.id('s4') $$,
  $$ values (null::bigint, null::text) $$, 'AC3: a suppressed row carries no cost');

-- A quoted price wins over the table; an org row overrides the default.
select tests.as_service();
select api.report_outbox_result(tests.id('s5'),
  '{"status": "sent", "provider": "telnyx", "segments": 1, "cost_micros": 4321, "currency": "EUR"}');
select tests.as_postgres();
select results_eq($$ select cost_micros, cost_source, currency::text from app.notifications where id = tests.id('s5') $$,
  $$ values (4321::bigint, 'provider', 'EUR') $$, 'a provider-quoted cost is stored as given');
select is((select (private.message_rate(tests.id('org_a'), 'twilio', 'sms', 'US')).micros_per_unit), 7900::bigint,
  'the org override (fixture rate_a) is found');
insert into app.provider_rates (org_id, provider, channel, country_code, micros_per_unit)
values (tests.id('org_a'), 'twilio', 'sms', 'US', 1000);
select is((select (private.message_rate(tests.id('org_a'), 'twilio', 'sms', 'US')).micros_per_unit), 1000::bigint,
  'a country-specific org rate beats a country-less one');
select is((select (private.message_rate(tests.id('org_b'), 'twilio', 'sms', 'US')).micros_per_unit), 7900::bigint,
  'another org gets the platform default, not org A''s override');

-- usage_summary: s1..s3 (twilio) = 3 messages, 6 segments. Rates were 7900 when priced: 47400.
select tests.act_as('manager');
select results_eq($$ select messages, segments, cost_micros from api.usage_summary(tests.id('org_a'),
                       current_date - 1, current_date + 1) where provider = 'twilio' $$,
  $$ values (3, 6, 47400::bigint) $$, 'AC1: 1, 2 and 3 segments at 7900 micros sum to 6 segments and 47400 micros');
select throws_ok($$ select * from api.usage_summary(tests.id('org_a'), current_date - 400, current_date) $$,
  'P0001', 'range_too_large', 'a range over 366 days is refused');
select tests.act_as('staff');
select throws_ok($$ select * from api.usage_summary(tests.id('org_a'), current_date, current_date) $$,
  '42501', 'permission_denied', 'AC2: staff are below manager');
select tests.act_as('other_owner');
select is((select count(*)::int from api.usage_summary(tests.id('org_a'), current_date - 1, current_date + 1)), 0,
  'AC2: a manager of org B sees zero rows for org A');
select tests.as_anon();
select throws_ok($$ select * from api.usage_summary(tests.id('org_a'), current_date, current_date) $$,
  '42501', null, 'anon cannot execute usage_summary');

select * from finish();
rollback;
