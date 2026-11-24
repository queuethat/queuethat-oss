-- Plan gates: new rows of a gated ee feature are refused when the org is not entitled; rows that exist
-- stay; the shipped defaults gate nothing; a per-location queue cap counts active queues only.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
select tests.as_postgres();

-- Defaults ship open.
select lives_ok(
  $$insert into app.custom_roles (org_id, name) values (tests.id('org_a'), 'Open')$$,
  'with the shipped defaults an org can create a custom role');

-- A deployment that gates the feature (here: the default flipped; a plan supplies this in production).
update app.entitlement_defaults set value = 'false' where key in ('feature.custom_roles', 'feature.api', 'feature.integrations', 'feature.reports_pro');
select throws_ok(
  $$insert into app.custom_roles (org_id, name) values (tests.id('org_a'), 'Gated')$$,
  'P0001', 'feature_not_in_plan', 'a gated org cannot create a custom role');
select throws_ok(
  $$insert into app.api_keys (org_id, name, prefix, secret_hash, scopes) values (tests.id('org_a'), 'k', 'deadbeef', extensions.digest('x', 'sha256'), array['queues:read'])$$,
  'P0001', 'feature_not_in_plan', 'nor an API key');
select throws_ok(
  $$insert into app.webhook_endpoints (org_id, url, event_types, vault_secret_id) values (tests.id('org_a'), 'https://example.com/h', array['visit.called'], gen_random_uuid())$$,
  'P0001', 'feature_not_in_plan', 'nor a webhook endpoint');
select throws_ok(
  $$insert into app.provider_settings (org_id, channel, provider, mode) values (tests.id('org_b'), 'crm', 'hubspot', 'own')$$,
  'P0001', 'feature_not_in_plan', 'nor a CRM integration');
select throws_ok(
  $$insert into app.provider_settings (org_id, channel, provider, mode) values (tests.id('org_b'), 'llm', 'anthropic', 'own')$$,
  'P0001', 'feature_not_in_plan', 'nor an ask-your-data key');
select lives_ok(
  $$insert into app.provider_settings (org_id, channel, provider, mode) values (tests.id('org_b'), 'email', 'smtp', 'own')$$,
  'channels that are not gated are untouched');

-- Existing rows stay and keep working.
select ok(exists (select 1 from app.api_keys where org_id = tests.id('org_a')), 'the existing API key is still there');
select lives_ok($$update app.webhook_endpoints set active = false where org_id = tests.id('org_a')$$, 'and an existing webhook can still be edited');

-- Cross-tenant: an override for org B does not entitle org A.
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_b'), 'feature.custom_roles', 'true', 'paid');
select lives_ok(
  $$insert into app.custom_roles (org_id, name) values (tests.id('org_b'), 'Paid')$$,
  'an org with the entitlement can create a custom role');
select throws_ok(
  $$insert into app.custom_roles (org_id, name) values (tests.id('org_a'), 'Still gated')$$,
  'P0001', 'feature_not_in_plan', 'and that does not entitle another org');

-- Queue cap per location, active queues only.
-- The cap is set to what the location already has, so the next queue is over it.
update app.entitlement_defaults set value = to_jsonb((select count(*)::int from app.queues where location_id = tests.id('loc_a') and archived_at is null))
  where key = 'limit.queues';
select throws_ok(
  $$insert into app.queues (org_id, location_id, name) values (tests.id('org_a'), tests.id('loc_a'), 'Extra')$$,
  'P0001', 'plan_limit_reached', 'a location at its queue cap cannot add another');
update app.queues set archived_at = now() where id = (select id from app.queues where location_id = tests.id('loc_a') and archived_at is null limit 1);
select lives_ok(
  $$insert into app.queues (org_id, location_id, name) values (tests.id('org_a'), tests.id('loc_a'), 'After archive')$$,
  'archiving a queue frees its place');

select * from finish();
rollback;
