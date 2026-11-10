-- Platform Twilio SMS (the deployment's shared sender): sms/twilio in mode platform is verified and
-- carries the platform campaign on save. The shared sender was paid for through the hosted service's
-- billing, which this build does not have, so the channel can be configured but never switched on.
begin;
\ir ../helpers/_setup.psql
select plan(15);

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
update app.platform_flags set compliance_gate_passed_at = now();
delete from app.channel_limits where org_id = tests.id('org_a');
insert into app.channel_limits (org_id, channel, country_allowlist) values (tests.id('org_a'), 'sms', '{US}');

select tests.act_as('owner');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'platform', '{}', '{}', gen_random_uuid())$$),
  'P0001 platform_mode_unavailable', 'platform mode is refused until the deployment turns it on');

select tests.as_postgres();
update private.deployment_settings set platform_messaging_enabled = true;
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'platform', '{}', '{}', gen_random_uuid());
select tests.as_postgres();
select isnt((select verified_at from app.provider_settings where channel = 'sms'), null, 'platform sms/twilio is verified on save');
select is((select messaging_campaign_ref from app.provider_settings where channel = 'sms'), 'platform', 'and carries the platform campaign');

select tests.act_as('owner');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'sms', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [hosted_legal_review,platform_requires_billing]', 'it still needs the hosted legal review');
select tests.as_postgres();
update app.platform_flags set hosted_legal_reviewed_at = now();
select tests.act_as('owner');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'sms', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [platform_requires_billing]', 'with the review done it still cannot be switched on: nobody would be charged');
select tests.as_postgres();
select is((select enabled from app.provider_settings where org_id = tests.id('org_a') and channel = 'sms'), false, 'and the channel stays off');
select tests.as_service();
select is((api.get_channel_config(tests.id('org_a'), 'sms')).enabled, false, 'the dispatcher gets no config');

-- the kill switch is still reported, also for a row switched on behind the gate
select tests.as_postgres();
update app.provider_settings set enabled = true where org_id = tests.id('org_a') and channel = 'sms';
update private.deployment_settings set platform_messaging_enabled = false;
select ok('platform_messaging' = any (private.channel_missing(tests.id('org_a'), 'sms')), 'turning platform messaging off is a missing prerequisite');
select tests.as_service();
select is((api.get_channel_config(tests.id('org_a'), 'sms')).enabled, false, 'and the dispatcher gets no config even for a row marked enabled');
select tests.as_postgres();
update private.deployment_settings set platform_messaging_enabled = true;
select tests.as_service();
select is((api.get_channel_config(tests.id('org_a'), 'sms')).enabled, false, 'nor with platform messaging back on');

-- an org cannot pick the platform campaign for its own account or skip verification
select tests.as_postgres();
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{"from_number":"+15005550006"}', '{"auth_token":"tok_secret_value_1234"}', gen_random_uuid());
select tests.as_postgres();
select is((select verified_at from app.provider_settings where channel = 'sms'), null, 'switching to own credentials clears verification');
select is((select enabled from app.provider_settings where channel = 'sms'), false, 'and disables the channel');
select is((select messaging_campaign_ref from app.provider_settings where channel = 'sms'), null,
  'and drops the platform campaign, so an own account needs a campaign of its own');
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'own', '{"from_number":"+15005550006","messaging_campaign_ref":"platform"}', '{}', gen_random_uuid());
select tests.as_postgres();
select is((select messaging_campaign_ref from app.provider_settings where channel = 'sms'), null, 'an org cannot claim the platform campaign by name');

-- SMS is a paid channel: an org without the paid_channels entitlement lacks it
select tests.as_postgres();
update app.entitlement_defaults set value = 'false' where key = 'paid_channels';
select ok('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'sms')), 'an org without paid_channels cannot use SMS');

select * from finish();
rollback;
