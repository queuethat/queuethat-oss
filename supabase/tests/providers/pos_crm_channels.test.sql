-- 4-INT1 (#395): pos and crm are provider channels. They skip the SMS compliance gate but still need
-- a completed connect (provider_verified) before an owner can switch them on.
begin;
\ir ../helpers/_setup.psql
select plan(8);

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

select tests.act_as('admin');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'pos', 'square', 'own',
  '{"application_id":"sq0idp-demo","environment":"sandbox"}', '{"application_secret":"sq0csp-demo-secret-1234"}', gen_random_uuid())$$),
  'ok', 'an admin saves a Square connection');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'crm', 'hubspot', 'own', '{}', '{"client_secret":"hs-secret-value-1234"}', gen_random_uuid())$$),
  'ok', 'and a HubSpot one');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'telegram', 'x1', 'own', '{}', '{}', gen_random_uuid())$$),
  'P0001 invalid_input', 'an unknown channel is still invalid_input');

select tests.act_as('owner');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'pos', true, gen_random_uuid())$$),
  'P0001 channel_prerequisite_missing [provider_verified]', 'pos needs a completed connect and no compliance gate');

select tests.as_postgres();
update app.provider_settings set verified_at = now() where channel = 'pos';
select tests.act_as('owner');
select is((select (r).enabled from (select api.set_channel_enabled(tests.id('org_a'), 'pos', true, gen_random_uuid()) r) x), true,
  'a verified pos connection can be enabled');

select tests.act_as('admin');
select is(tests.error_of($$select api.set_channel_enabled(tests.id('org_a'), 'crm', true, gen_random_uuid())$$),
  '42501 permission_denied', 'only an owner enables');

select tests.act_as('staff');
select is(tests.error_of($$select api.set_provider_settings(tests.id('org_a'), 'pos', 'square', 'own', '{}', '{}', gen_random_uuid())$$),
  '42501 permission_denied', 'staff cannot change a connection');

select tests.act_as('other_owner');
select is((select count(*)::int from app.provider_settings where channel in ('pos', 'crm')), 0, 'org B sees none of org A''s connections');

select * from finish();
rollback;
