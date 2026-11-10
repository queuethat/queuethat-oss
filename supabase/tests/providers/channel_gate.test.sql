-- 3-CG13 (#338): a paid channel only turns on when the deployment and the org meet every prerequisite.
begin;
\ir ../helpers/_setup.psql
select plan(26);

select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || coalesce(' [' || nullif(d, '') || ']', '');
end $$;
grant execute on function tests.error_of(text) to authenticated, service_role;

select tests.as_postgres();
delete from app.channel_limits where org_id = tests.id('org_a');
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{"from_number":"+15005550006"}',
  '{"auth_token":"tok_secret_value_1234"}', gen_random_uuid());

-- AC1 plus the other prerequisites, in one list
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'sms', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [compliance_gate,provider_verified,country_allowlist,campaign_ref]',
  'AC1: the missing list names the gate, the unverified provider, the allowlist and the US campaign reference');
select is((select enabled from app.provider_settings where channel = 'sms'), false, 'and nothing was enabled');

select tests.as_postgres();
update app.platform_flags set compliance_gate_passed_at = now();
update app.provider_settings set verified_at = now() where channel = 'sms';
insert into app.channel_limits (org_id, channel, daily_cap, country_allowlist) values (tests.id('org_a'), 'sms', 0, '{US}');
select tests.act_as('owner');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'sms', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [daily_cap,campaign_ref]', 'a zero cap and a missing campaign reference still block');

select tests.as_postgres();
update app.channel_limits set daily_cap = 200 where org_id = tests.id('org_a');
update app.provider_settings set messaging_campaign_ref = 'CMP123' where channel = 'sms';
select tests.act_as('owner');
select is((select (r).enabled from (select api.set_channel_enabled(tests.id('org_a'), 'sms', true, gen_random_uuid()) r) x), true,
  'AC2: with every prerequisite the channel is enabled');
select is((select enabled from app.provider_settings where channel = 'sms'), true, 'and the setting says so');
select tests.as_postgres();
select cmp_ok((select count(*)::int from app.audit_log where table_name = 'provider_settings' and action = 'UPDATE' and after ->> 'enabled' = 'true'), '>=', 1,
  'AC2: an audit row records the change');

-- #920: adapters build their delivery-report URL from the endpoint id, which config carries (and an org cannot plant)
update app.provider_settings set config = config || '{"endpoint_id":"planted"}' where channel = 'sms';
select tests.as_service();
select is((api.get_channel_config(tests.id('org_a'), 'sms')).config ->> 'endpoint_id',
  (select endpoint_id::text from app.provider_settings where channel = 'sms'), 'get_channel_config returns the real endpoint id, not one stored in config');
select is((api.get_channel_config(tests.id('org_a'), 'sms')).config ->> 'from_number', '+15005550006', 'and the rest of config is unchanged');
select tests.as_postgres();

-- a hosted (platform) account also needs the legal review
select tests.as_postgres();
update private.deployment_settings set platform_messaging_enabled = true;
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'email', 'postmark', 'platform', '{}', '{}', gen_random_uuid());
select tests.as_postgres();
update app.provider_settings set verified_at = now() where channel = 'email';
select tests.act_as('owner');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'email', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [hosted_legal_review]', 'platform mode needs hosted_legal_reviewed_at');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'whatsapp', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [provider_settings]', 'a channel with no settings reports provider_settings');

-- AC3
select tests.act_as('admin');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'sms', false, gen_random_uuid())$$),
  '42501 permission_denied', 'AC3: an admin cannot switch channels');
select tests.act_as('other_owner');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'sms', true, gen_random_uuid())$$),
  'P0001 not_found', 'AC3: the owner of another org gets not_found');

-- AC4
select tests.as_postgres();
select tests.new_visit('gv', 'queue_a', 'Gate Guest');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.new_id('gate_n'), tests.id('org_a'), tests.id('gv'), 'sms', gen_random_uuid(), 'called', 1, 'gate-n-1'),
       (tests.new_id('gate_e'), tests.id('org_a'), tests.id('gv'), 'email', gen_random_uuid(), 'called', 1, 'gate-n-2');
select tests.act_as('owner');
select is((select (r).enabled from (select api.set_channel_enabled(tests.id('org_a'), 'sms', false, gen_random_uuid()) r) x), false,
  'disabling is allowed');
select tests.as_postgres();
select is((select status::text || ' ' || error_code from app.notifications where id = tests.id('gate_n')), 'suppressed channel_disabled',
  'AC4: the queued sms row is suppressed channel_disabled');
select is((select status::text from app.notifications where id = tests.id('gate_e')), 'queued', 'and another channel is untouched');
select tests.act_as('owner');
select is((select (r).enabled from (select api.set_channel_enabled(tests.id('org_a'), 'sms', false, gen_random_uuid()) r) x), false,
  'disabling again is a no-op');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'fax', true, gen_random_uuid())$$), 'P0001 invalid_input',
  'an unknown channel is invalid_input');

-- the flags are not readable by tenants
select is(tests.error_of('select * from app.platform_flags'), '42501 permission denied for table platform_flags', 'tenants cannot read platform_flags');
select tests.act_as('owner');
select is(tests.error_of('update app.platform_flags set compliance_gate_passed_at = now()'), '42501 permission denied for table platform_flags',
  'and cannot set the gate');

-- review follow-ups: payments can be switched off, CA admits US numbers, the gate keeps holding
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'payments', 'stripe', 'own', '{}', '{"secret_key":"sk_test_abcdefgh1234"}', gen_random_uuid());
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'payments', false, gen_random_uuid())$$), 'ok',
  'a payments channel can be switched off');

select tests.as_postgres();
update app.channel_limits set country_allowlist = '{CA}' where org_id = tests.id('org_a');
update app.provider_settings set messaging_campaign_ref = null, verified_at = now(), config = '{"from_number":"+442071838750"}' where channel = 'sms';
select is((select private.channel_missing(tests.id('org_a'), 'sms')), array['campaign_ref'], 'an allowlist of CA still needs a campaign reference (+1 is shared)');
update app.channel_limits set country_allowlist = '{GB}' where org_id = tests.id('org_a');
select is((select private.channel_missing(tests.id('org_a'), 'sms')), '{}'::text[], 'a UK sender with a UK allowlist needs none');
update app.provider_settings set config = '{}' where channel = 'sms';
select is((select private.channel_missing(tests.id('org_a'), 'sms')), array['campaign_ref'], 'an unknown sender (messaging service) needs one');

select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{"from_number":"+15005550006","messaging_campaign_ref":" CMP9 "}', '{}', gen_random_uuid());
select tests.as_postgres();
select is((select messaging_campaign_ref from app.provider_settings where channel = 'sms'), 'CMP9', 'set_provider_settings stores the campaign reference in its column');
select is((select config ? 'messaging_campaign_ref' from app.provider_settings where channel = 'sms'), false, 'and keeps it out of config');

-- the gate holds while the channel is on: an enabled channel whose prerequisites vanish stops resolving
update app.provider_settings set enabled = true where channel = 'sms';
update app.channel_limits set country_allowlist = '{US}' where org_id = tests.id('org_a');
update app.provider_settings set messaging_campaign_ref = null where channel = 'sms';
select tests.as_service();
select is((select (api.get_channel_config(tests.id('org_a'), 'sms')).enabled), false, 'get_channel_config stops serving a channel that no longer meets the gate');

select * from finish();
rollback;
