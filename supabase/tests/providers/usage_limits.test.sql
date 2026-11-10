-- 3-PV6 (#345): api.reserve_send, channel_limits and usage_counters.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();

-- Org A: cap 3, allowlist {US}. Org B has no limits row (defaults: nothing allowed).
insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('us'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'US', 'online'),
  (tests.new_id('uk'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+447700900123', 'GB', 'online'),
  (tests.new_id('none'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+99955501234', null, 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id('n' || i), tests.id('org_a'), tests.id('visit_a'), 'sms',
       case when i = 9 then tests.id('uk') when i = 10 then tests.id('none') else tests.id('us') end,
       'called', 1, 'n' || i
from generate_series(1, 10) i;

select tests.as_service();
select is((select decision from api.reserve_send(tests.id('n1'))), 'allowed', 'first send is allowed');
select is((select sent_today from api.reserve_send(tests.id('n1'))), 1, 'reserving the same row again does not count twice');
select api.reserve_send(tests.id('n2'));
select api.reserve_send(tests.id('n3'));
select results_eq($$ select decision, sent_today, daily_cap from api.reserve_send(tests.id('n4')) $$,
  $$ values ('cap_reached', 3, 3) $$, 'AC1: the fourth distinct row is over a cap of 3');
select is((select decision from api.reserve_send(tests.id('n9'))), 'country_blocked',
  'AC2: a +44 number is blocked when only US is allowed');
select is((select decision from api.reserve_send(tests.id('n10'))), 'country_blocked', 'a contact with no country is blocked');
select throws_ok($$ select api.reserve_send(gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown row is not_found');
select tests.as_postgres();

select is((select sent from app.usage_counters where org_id = tests.id('org_a') and channel = 'sms'
           and day = (now() at time zone 'UTC')::date), 3, 'blocked and capped attempts are not counted');

-- Budget: spend of 5000 against a budget of 5000 stops the next send even under the cap.
update app.channel_limits set daily_cap = 50, monthly_budget_micros = 5000
where org_id = tests.id('org_a') and channel = 'sms';
update app.notifications set status = 'sent', sent_at = now(), cost_micros = 5000 where id = tests.id('n1');
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('n5'))), 'budget_reached', 'a spent monthly budget stops sends');
select tests.as_postgres();

-- AC3: org A being capped does not touch org B (its own defaults apply: nothing allowed, no row of A's counted).
select is((select count(*)::int from app.usage_counters where org_id = tests.id('org_b')), 0, 'AC3: org B has no counters');

-- AC4 and grants.
select tests.act_as('other_owner');
select throws_ok($$ insert into app.channel_limits (org_id, channel) values (tests.id('org_a'), 'whatsapp') $$,
  '42501', null, 'AC4: another org cannot create org A limits');
update app.channel_limits set daily_cap = 9999 where org_id = tests.id('org_a');
select tests.as_postgres();
select is((select daily_cap from app.channel_limits where org_id = tests.id('org_a') and channel = 'sms'), 50,
  'AC4: another org cannot change org A limits (no row is visible to update)');
select tests.act_as('staff');
select throws_ok($$ select api.reserve_send(tests.id('n6')) $$, '42501', null, 'staff cannot call reserve_send');

select tests.as_service();
-- NANP: +1 numbers outside the US and Canada resolve to their own country, so a US/CA allowlist blocks them.
select is(private.phone_countries('+14155550188'), array['US', 'CA'], '+1 415 is US and CA');
select is(private.phone_countries('+18765550100'), array['JM'], '+1 876 is Jamaica, not US/CA');
select is(private.phone_countries('+18095550100'), array['DO'], '+1 809 is the Dominican Republic');
select is(private.phone_countries('+19005550100'), array['ZZ'], '+1 900 premium rate is never allowlisted');
select is(private.phone_countries('+15005550100'), array['ZZ'], '+1 500 personal numbers are never allowlisted');
select tests.act_as('owner');
select throws_ok($$ update app.channel_limits set country_allowlist = '{ZZ}' where org_id = tests.id('org_a') $$, '22023', null, 'ZZ cannot be allowlisted');
select throws_ok($$ update app.channel_limits set country_allowlist = '{US,XX}' where org_id = tests.id('org_a') $$, '22023', null, 'unknown country cannot be allowlisted');
select lives_ok($$ update app.channel_limits set country_allowlist = '{US,CA}' where org_id = tests.id('org_a') $$, 'real countries still can');
select * from finish();
rollback;
