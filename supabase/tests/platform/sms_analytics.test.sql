-- A1 (#1222): the SMS daily rollup and api.platform_sms_analytics. Totals reconcile to
-- app.notifications, history survives a purge, late receipts and pruned sources behave, and
-- only platform support/operators with aal2 can read it (any org, by filter).
begin;
\ir ../helpers/_setup.psql
select plan(32);

select tests.create_world();
select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal2"}') $$;
create function tests.as_operator_aal1() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal1"}') $$;
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal2"}') $$;
grant execute on function tests.as_operator(), tests.as_operator_aal1(), tests.as_support() to authenticated;

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Queue B', 'B');
select tests.new_visit('visit_b', 'queue_b');
update app.visits set locale = 'es' where id = tests.id('visit_b');
insert into app.guests (id, org_id, first_name) values (tests.new_id('guest_b'), tests.id('org_b'), 'Bea');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_b'), tests.id('org_b'), tests.id('guest_b'), 'phone', '+34600111222', 'online');

/** One notification with explicit day, status, delivery state, segments and cost. */
create function tests.sms(p_key text, p_org text, p_visit text, p_ref uuid, p_status app.notification_status,
                          p_at timestamptz, p_delivery text, p_error text, p_segments int, p_cost bigint,
                          p_channel app.notification_channel default 'sms') returns void
language sql as $$
  insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 dedupe_key, status, created_at, updated_at, provider, delivery_status, error_code,
                                 segments, cost_micros)
  values (tests.new_id(p_key), tests.id(p_org), tests.id(p_visit), p_channel, p_ref, 'called', 1, p_key,
          p_status, p_at, p_at, 'twilio', p_delivery, p_error, p_segments, p_cost)
$$;
-- Org A, 10 March: delivered x2 (one 2 segments), filtered, undelivered, dead, suppressed, queued, plus an email.
select tests.sms('a1', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-10 09:00Z', 'delivered', null, 1, 8000);
select tests.sms('a2', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-10 23:59Z', 'delivered', null, 2, 16000);
select tests.sms('a3', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-10 10:00Z', 'undelivered', 'twilio_30007', 1, 8000);
select tests.sms('a4', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-10 11:00Z', 'undelivered', 'twilio_30008', 1, 8000);
select tests.sms('a5', 'org_a', 'visit_a', tests.id('contact_a'), 'dead', '2026-03-10 12:00Z', null, 'http_500', null, null);
select tests.sms('a6', 'org_a', 'visit_a', tests.id('contact_a'), 'suppressed', '2026-03-10 13:00Z', null, 'suppressed', null, null);
select tests.sms('a7', 'org_a', 'visit_a', tests.id('contact_a'), 'queued', '2026-03-10 14:00Z', null, null, null, null);
select tests.sms('a8', 'org_a', 'visit_a', tests.id('visit_a'), 'sent', '2026-03-10 15:00Z', null, null, null, null, 'email');
-- Org A, 11 March (a late receipt for this one arrives on the 12th), and org B (Spanish, Spain) on the 10th.
select tests.sms('a9', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-11 08:00Z', 'sent', null, 1, 8000);
select tests.sms('b1', 'org_b', 'visit_b', tests.id('contact_b'), 'sent', '2026-03-10 09:00Z', 'delivered', null, 1, 9000);
-- What the tenant was charged for a1 (cost + 10% margin).
insert into app.credit_ledger (org_id, entry_type, amount_micros, cost_micros, margin_micros, notification_id)
values (tests.id('org_a'), 'debit', -8800, 8000, 800, tests.id('a1'));

select private.platform_sms_rollup('2026-03-11');

select results_eq(
  $$ select day, messages, segments, delivered, failed, filtered, undelivered, suppressed, cost_micros, billed_micros
     from app.platform_sms_daily where org_id = tests.id('org_a') and day = '2026-03-10' $$,
  $$ values ('2026-03-10'::date, 7, 5, 2, 1, 1, 1, 1, 40000::bigint, 8800::bigint) $$,
  'org A, 10 March: counted by status, delivery state and cost; email excluded; billed from the ledger');
select is((select country from app.platform_sms_daily where org_id = tests.id('org_a') and day = '2026-03-10'
           and template_key = 'called'), 'CA/US', 'a shared calling code lists its countries');
select is((select locale from app.platform_sms_daily where org_id = tests.id('org_b') and day = '2026-03-10'
           and template_key = 'called'), 'es', 'locale comes from the visit');
select is((select country from app.platform_sms_daily where org_id = tests.id('org_b') and day = '2026-03-10'
           and template_key = 'called'), 'ES', 'a single-country code gives one country');

-- AC1: totals reconcile to app.notifications for the range.
select results_eq(
  $$ select sum(messages)::bigint, sum(segments)::bigint, sum(cost_micros)::bigint from app.platform_sms_daily
     where day between '2026-03-10' and '2026-03-11' $$,
  $$ select count(*), coalesce(sum(segments), 0)::bigint, coalesce(sum(cost_micros), 0)::bigint from app.notifications
     where channel = 'sms' and created_at >= '2026-03-10 00:00Z' and created_at < '2026-03-12 00:00Z' $$,
  'AC1: messages, segments and cost reconcile to app.notifications');

-- Idempotent: running again changes nothing.
create temp table before_rerun as select day, org_id, template_key, locale, country, messages, segments, delivered,
  failed, filtered, undelivered, suppressed, cost_micros, billed_micros from app.platform_sms_daily;
select private.platform_sms_rollup('2026-03-11');
select private.platform_sms_rollup('2026-03-11');
select set_eq($$ select day, org_id, template_key, locale, country, messages, segments, delivered, failed, filtered,
                         undelivered, suppressed, cost_micros, billed_micros from app.platform_sms_daily $$,
  $$ select * from before_rerun $$, 'a repeated run leaves identical rows');

-- Late delivery receipt: the 11th was recomputed two days later and now shows delivered.
update app.notifications set delivery_status = 'delivered' where id = tests.id('a9');
select private.platform_sms_rollup('2026-03-13');
select is((select delivered from app.platform_sms_daily where org_id = tests.id('org_a') and day = '2026-03-11'), 1,
  'a receipt that arrives within two days is picked up');
update app.notifications set delivery_status = 'delivered' where id = tests.id('a4');
select private.platform_sms_rollup('2026-03-13');
select is((select undelivered from app.platform_sms_daily where org_id = tests.id('org_a') and day = '2026-03-10'), 1,
  'a day older than the window is not recomputed');

-- Backfill: missed days after the last one computed are filled, at most 31 back.
select tests.sms('a10', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-14 08:00Z', 'delivered', null, 1, 8000);
select tests.sms('a11', 'org_a', 'visit_a', tests.id('contact_a'), 'sent', '2026-03-16 08:00Z', 'delivered', null, 1, 8000);
select private.platform_sms_rollup('2026-03-17');
select is((select count(distinct day)::int from app.platform_sms_daily where day in ('2026-03-14', '2026-03-16')), 2,
  'days missed since the last run are backfilled');

-- STOPs: counted per distinct phone and kept after private.platform_sms_stops is pruned.
insert into private.platform_sms_stops (org_id, phone, at) values
  (tests.id('org_a'), '+14155550001', '2026-03-17 09:00Z'), (tests.id('org_a'), '+14155550001', '2026-03-17 10:00Z'),
  (tests.id('org_a'), '+14155550002', '2026-03-17 11:00Z');
select private.platform_sms_rollup('2026-03-17');
select is((select sum(stops)::int from app.platform_sms_daily where org_id = tests.id('org_a') and day = '2026-03-17'), 2,
  'STOPs count distinct phones per day');
delete from private.platform_sms_stops;
select private.platform_sms_rollup('2026-03-18');
select is((select sum(stops)::int from app.platform_sms_daily where org_id = tests.id('org_a') and day = '2026-03-17'), 2,
  'the per-day STOP count survives the pruning of the stop rows');

-- Opt-ins and phone verification counts.
update app.consents set captured_at = '2026-03-18 09:00Z' where id = tests.id('consent_a');
update app.guest_contacts set verified_at = '2026-03-18 09:05Z' where id = tests.id('contact_a');
insert into private.phone_code_attempts (visit_id, kind, at) values
  (tests.id('visit_a'), 'request', '2026-03-18 09:01Z'), (tests.id('visit_a'), 'request', '2026-03-18 09:02Z'),
  (tests.id('visit_a'), 'verify', '2026-03-18 09:03Z');
select private.platform_sms_rollup('2026-03-18');
select results_eq(
  $$ select sum(optins)::int, sum(otp_sent)::int, sum(otp_verified)::int from app.platform_sms_daily
     where org_id = tests.id('org_a') and day = '2026-03-18' $$,
  $$ values (1, 2, 1) $$, 'opt-ins, OTP requests (not verify attempts) and verified numbers are counted');

-- AC2: a purged org keeps its history, now and after later runs.
select tests.as_postgres();
update app.organizations set status = 'pending_deletion', deletion_requested_at = now(),
  deletion_scheduled_for = now() - interval '1 minute', external_purged_at = now() where id = tests.id('org_b');
select is(ops.purge_deleted_orgs(), 1, 'org B is purged');
select is((select count(*)::int from app.notifications where org_id = tests.id('org_b')), 0, 'its messages are gone');
select is((select messages from app.platform_sms_daily where org_id = tests.id('org_b') and day = '2026-03-10'), 1,
  'AC2: its rollup history survives the purge');
select private.platform_sms_rollup('2026-03-19');
select is((select messages from app.platform_sms_daily where org_id = tests.id('org_b') and day = '2026-03-10'), 1,
  'AC2: and a later run does not erase it');

-- AC3: access.
select tests.as_operator();
select is((select count(*)::int from api.platform_sms_analytics('2026-03-10', '2026-03-11')), 3,
  'an operator reads the range (org A on both days, org B on the 10th)');
select is((select count(*)::int from api.platform_sms_analytics('2026-03-10', '2026-03-11', tests.id('org_a'))), 2,
  'AC4: the org filter narrows to one org');
select is((select count(*)::int from api.platform_sms_analytics('2026-03-10', '2026-03-11', tests.id('org_b'))), 1,
  'AC4: the filter reaches a purged org');
select is((select count(*)::int from api.platform_sms_analytics('2026-03-10', '2026-03-11', gen_random_uuid())), 0,
  'an unknown org gives no rows, not an error');
select tests.as_support();
select is((select sum(messages)::int from api.platform_sms_analytics('2026-03-10', '2026-03-10')), 8, 'support reads it too');
select throws_ok($$ select * from api.platform_sms_analytics('2026-03-11', '2026-03-10') $$, 'P0001', 'invalid_input',
  'a reversed range is invalid_input');
select throws_ok($$ select * from api.platform_sms_analytics('2025-03-09', '2026-03-10') $$, 'P0001', 'invalid_input',
  'a range over 366 days is invalid_input');
select lives_ok($$ select * from api.platform_sms_analytics('2025-03-10', '2026-03-10') $$, 'exactly 366 days is allowed');

select tests.as_operator_aal1();
select throws_ok($$ select * from api.platform_sms_analytics('2026-03-10', '2026-03-11') $$, '42501', 'permission_denied',
  'AC3: an operator without aal2 is denied');
select tests.act_as('owner');
select throws_ok($$ select * from api.platform_sms_analytics('2026-03-10', '2026-03-11') $$, '42501', 'permission_denied',
  'AC3: an org owner is denied, even for their own org');
select is((select count(*)::int from app.platform_sms_daily), 0, 'an org owner cannot read the table either');
select tests.act_as('anon');
select throws_ok($$ select * from api.platform_sms_analytics('2026-03-10', '2026-03-11') $$, '42501', null, 'anon is denied');

select tests.as_postgres();
-- Six calls got past the checks: four operator reads, one support read, the 366-day read. Denied or invalid calls leave no row.
select is((select count(*)::int from app.platform_audit where action = 'sms.analytics.read'), 6,
  'every successful call is audited');
select is((select target ->> 'to' from app.platform_audit where action = 'sms.analytics.read'
           order by id desc limit 1), '2026-03-10', 'the audit row records the range');
select is((select count(*)::int from app.platform_audit where action = 'sms.analytics.read'
           and org_id = tests.id('org_b')), 1, 'and the org filter');
select is((select schedule from cron.job where jobname = 'platform-sms-tick'), '20 * * * *', 'the rollup runs hourly at :20');

select * from finish();
rollback;
