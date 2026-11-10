-- Paid-message ceilings: operator entitlements bound what an org's own channel_limits allow.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('us'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id('n' || i), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('us'), 'called', 1, 'n' || i
from generate_series(1, 4) i;
update app.organizations set created_at = now() - interval '60 days';
update app.channel_limits set daily_cap = 100000, monthly_budget_micros = 999999999999, country_allowlist = '{US}'
where org_id = tests.id('org_a');

-- An org that sets its own cap far above the ceiling is still held to the ceiling (daily_cap is 200).
select is(private.messaging_daily_ceiling(tests.id('org_a')), 200, 'an established org gets the global daily ceiling');
select tests.as_service();
select is((select daily_cap from api.reserve_send(tests.id('n1'))), 200, 'reserve_send reports the ceiling, not the org''s own 100000');
select tests.as_postgres();

-- A young org gets the lower new-org ceiling.
update app.organizations set created_at = now() - interval '2 days' where id = tests.id('org_a');
select is(private.messaging_daily_ceiling(tests.id('org_a')), 25, 'a young org gets the new-org ceiling');
select tests.as_service();
select is((select daily_cap from api.reserve_send(tests.id('n2'))), 25, 'reserve_send reports the new-org ceiling');
select tests.as_postgres();

-- The new-org ceiling stops sends once reached.
update app.usage_counters set sent = 25 where org_id = tests.id('org_a') and channel = 'sms';
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('n3'))), 'cap_reached', 'a young org stops at 25 even though its own cap is 100000');
select tests.as_postgres();

-- The budget ceiling bounds an org budget too (and an unset one).
update app.notifications set status = 'sent', sent_at = now(), cost_micros = 20000000 where id = tests.id('n1');
update app.usage_counters set sent = 0 where org_id = tests.id('org_a');
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('n4'))), 'budget_reached', 'spend at the ceiling stops sends despite a huge own budget');
select tests.as_postgres();
update app.channel_limits set monthly_budget_micros = null where org_id = tests.id('org_a');
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('n4'))), 'budget_reached', 'a null own budget falls back to the ceiling');
select tests.as_postgres();

-- Only an operator raises a ceiling, and the raise applies to that org alone.
select tests.act_as('owner');
select throws_ok($$ select api.platform_set_entitlement(tests.id('org_a'), 'messaging.new_org_daily_cap', '500', 'self raise') $$,
  '42501', 'permission_denied', 'an org owner cannot raise its own ceiling');
select tests.act_as('platform');
select api.platform_set_entitlement(tests.id('org_a'), 'messaging.new_org_daily_cap', '150', 'verified pilot');
select tests.as_postgres();
select is(private.messaging_daily_ceiling(tests.id('org_a')), 150, 'an operator raise lifts the young org ceiling');
select is((select count(*)::int from app.org_entitlements where org_id = tests.id('org_b') and key like 'messaging.%'), 0,
  'the raise created no override for org B');
select is((select count(*)::int from app.platform_audit where org_id = tests.id('org_a') and action = 'entitlement.set'), 1,
  'the raise is audited');

select * from finish();
rollback;
