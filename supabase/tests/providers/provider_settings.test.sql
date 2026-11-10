-- 3-PV1 (#340): per-org provider settings, secrets in Vault.
begin;
\ir ../helpers/_setup.psql
select plan(23);

select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function tests.error_of(text) to authenticated, service_role;

-- AC1: the token goes in, only the last four characters come back
select tests.act_as('admin');
select is((select (r).secret_hints ->> 'auth_token' from (select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own',
  '{"from_number":"+15005550006"}', '{"auth_token":"tok_secret_value_1234"}', gen_random_uuid()) r) x), '1234',
  'set returns the last four characters of the secret');
select is((select (p.config::text || p.secret_hints::text || p.provider) like '%tok_secret_value%' from app.provider_settings p where channel = 'sms'), false,
  'AC1: the settings row holds no secret value');
select is(tests.error_of('select secret_ids from app.provider_settings'), '42501 permission denied for table provider_settings',
  'AC1: the Vault ids are not readable by admins');
select is(tests.error_of('select * from vault.decrypted_secrets'), '42501 permission denied for schema vault',
  'AC1: authenticated cannot read the Vault views');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where table_name = 'provider_settings' and (after::text like '%secret_ids%' or after::text like '%tok_secret%')),
  0, 'the audit row carries neither the Vault ids nor the secret');
select is((select count(*)::int from app.audit_log where table_name = 'provider_settings' and action = 'INSERT' and after ->> 'channel' = 'sms'), 1, 'and an audit row exists');

-- service role reads it back, but only once the channel is enabled
select tests.as_service();
select is((select (api.get_channel_config(tests.id('org_a'), 'sms')).provider), null, 'a disabled channel yields an empty config');
select tests.as_postgres();
update app.platform_flags set compliance_gate_passed_at = now();
delete from app.channel_limits where org_id = tests.id('org_a');
insert into app.channel_limits (org_id, channel, country_allowlist) values (tests.id('org_a'), 'sms', '{US}');
update app.provider_settings set enabled = true, verified_at = now(), messaging_campaign_ref = 'CMP1' where channel = 'sms';
select tests.as_service();
select is((select (api.get_channel_config(tests.id('org_a'), 'sms')).secrets ->> 'auth_token'), 'tok_secret_value_1234',
  'the service role reads the decrypted secret of an enabled channel');
select is((select (api.get_webhook_secret('twilio', (select endpoint_id from app.provider_settings where channel = 'sms'))).secrets #>> '{signing,0}'),
  'tok_secret_value_1234', 'get_webhook_secret returns {signing: [...]} for the endpoint');
select is(tests.error_of($$select api.get_webhook_secret('postmark', (select endpoint_id from app.provider_settings where channel = 'sms'))$$), 'P0001 not_found',
  'get_webhook_secret needs the matching provider');
select tests.act_as('admin');
select is(tests.error_of($$select api.get_channel_config(tests.id('org_a'), 'sms')$$), '42501 permission denied for function get_channel_config',
  'authenticated cannot call get_channel_config');
select is(tests.error_of($$select api.get_webhook_secret('twilio', gen_random_uuid())$$), '42501 permission denied for function get_webhook_secret',
  'authenticated cannot call get_webhook_secret');

-- a repeat with the same key changes nothing; a new secret clears verification and the enable flag
select tests.act_as('admin');
select is((select (r).version from (select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{}', '{"auth_token":"tok_new_9999"}', gen_random_uuid()) r) x),
  2, 'rotating a secret bumps the version');
select is((select (r).version from (select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{}', '{"auth_token":"ignored_0000"}',
  (select k.key from app.idempotency_keys k where k.rpc = 'set_provider_settings' order by created_at desc limit 1)) r) x),
  2, 'a repeat with the same idempotency key changes nothing');
select is((select enabled or verified_at is not null from app.provider_settings where channel = 'sms'), false, 'and clears verified_at and enabled');
select tests.as_postgres();
select is((select count(*)::int from vault.secrets where name like 'provider:%'), 1, 'the secret is updated in place, not duplicated');

-- AC2
select tests.act_as('owner');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'platform', '{}', '{}', gen_random_uuid())$$),
  'P0001 platform_mode_unavailable', 'AC2: platform mode needs the deployment flag');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'fax', 'twilio', 'own', '{}', '{}', gen_random_uuid())$$),
  'P0001 invalid_input', 'an unknown channel is invalid_input');

-- AC3
select tests.act_as('other_owner');
select is((select count(*)::int from app.provider_settings), 0, 'AC3: another org sees zero rows');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{}', '{}', gen_random_uuid())$$),
  'P0001 not_found', 'AC3: another org cannot write org A settings');

-- AC4
select tests.act_as('manager');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{}', '{}', gen_random_uuid())$$),
  '42501 permission_denied', 'AC4: below admin is denied');

-- org erasure (purge) must still work with settings and Vault secrets present
select tests.as_postgres();
insert into app.organizations (id, name) values ('00000000-0000-0000-0000-0000000000aa', 'purge me');
insert into app.provider_settings (org_id, channel, provider, mode, secret_ids)
values ('00000000-0000-0000-0000-0000000000aa', 'sms', 'twilio', 'own', jsonb_build_object('auth_token', vault.create_secret('x', 'provider:purge-test')));
select is(tests.error_of($$delete from app.organizations where id = '00000000-0000-0000-0000-0000000000aa'$$), 'ok',
  'deleting an org cascades past the settings audit trigger');
select is((select count(*)::int from vault.secrets where name = 'provider:purge-test'), 0, 'and the Vault secrets go with it');

select * from finish();
rollback;
