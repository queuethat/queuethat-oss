-- 4-INT1 (#395): the OAuth hand-off and vendor revocation for integration connections.
begin;
\ir ../helpers/_setup.psql
select plan(22);

select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function tests.error_of(text) to anon, authenticated, service_role;

select tests.as_postgres();
update app.provider_settings set enabled = true, verified_at = now(), secret_ids = jsonb_build_object(
  'access_token', vault.create_secret('tok-a', 'test:integration:tok'), 'application_secret', vault.create_secret('app-sec', 'test:integration:app'))
where id = tests.id('integration_setting_a');
select tests.new_visit('visit_b', 'queue_a');
update app.integration_jobs set status = 'queued';

-- OAuth hand-off
select tests.act_as('staff');
select is(tests.error_of($$select api.begin_integration_connect(tests.id('org_a'), 'pos')$$), '42501 permission_denied', 'staff cannot start a connect');
select tests.act_as('admin');
create temp table st (s text);
grant all on st to authenticated, service_role;
insert into st select api.begin_integration_connect(tests.id('org_a'), 'pos');
select is(tests.error_of($$select count(*) from app.integration_oauth_states$$), '42501 permission denied for table integration_oauth_states', 'the state table is not readable by clients');
select tests.as_postgres();
select is((select count(*)::int from app.integration_oauth_states where state_hash = extensions.digest((select s from st), 'sha256')), 1, 'only the hash is stored');
select tests.as_service();
select is(tests.error_of(format($$select api.consume_integration_state(%L, gen_random_uuid())$$, (select s from st))), 'P0001 not_found', 'a state is useless to another user');
select tests.as_postgres();
create temp table adm (id uuid);
insert into adm select (claims ->> 'sub')::uuid from tests.actors where name = 'admin';
grant all on adm to service_role;
-- an admin demoted before finishing cannot finish
select tests.as_postgres();
update app.memberships set role = 'staff' where user_id = (select id from adm);
select tests.as_service();
select is(tests.error_of(format($$select api.consume_integration_state(%L, %L)$$, (select s from st), (select id from adm))), 'P0001 not_found', 'a demoted user cannot finish');
select tests.as_postgres();
update app.memberships set role = 'admin' where user_id = (select id from adm);
select tests.as_service();
select is((select (c).secrets ->> 'access_token' from (select api.consume_integration_state((select s from st), (select id from adm)) c) x), 'tok-a',
  'the right user spends the state and gets the credentials');
select is(tests.error_of(format($$select api.consume_integration_state(%L, %L)$$, (select s from st), (select id from adm))), 'P0001 not_found', 'a state works once');

-- tokens saved by the callback replace the stored ones and verify the connection
select api.save_integration_tokens(tests.id('org_a'), 'pos', '{"access_token":"tok-b"}', '{"merchant_id":"M1"}', true);
select tests.as_postgres();
select is((select (verified_at is not null)::text || ':' || (config ->> 'merchant_id') from app.provider_settings where id = tests.id('integration_setting_a')),
  'true:M1', 'save marks the connection verified and merges config');
select is((select d.decrypted_secret from app.provider_settings s join vault.decrypted_secrets d on d.id = (s.secret_ids ->> 'access_token')::uuid
           where s.id = tests.id('integration_setting_a')), 'tok-b', 'and replaces the token in Vault');
select tests.as_service();

-- revocation by the vendor
select api.revoke_integration(tests.id('org_a'), 'pos');
select tests.as_postgres();
select is((select enabled::text || ':' || coalesce(verified_at::text, 'null') || ':' || (secret_ids ? 'access_token')::text from app.provider_settings where id = tests.id('integration_setting_a')),
  'false:null:false', 'revoke disables, unverifies and drops the tokens');
select is((select count(*)::int from vault.secrets where name like 'provider:' || tests.id('integration_setting_a') || ':%token'), 0, 'and deletes them from Vault');

select is((select status || ':' || error from app.integration_jobs where id = tests.id('integration_job_a')), 'dead:revoked', 'and dead-letters the waiting jobs');
select is((select secret_ids ? 'application_secret' from app.provider_settings where id = tests.id('integration_setting_a')), true, 'while the org''s own app credentials stay');

-- L6: a refresh that lands after the revoke must not bring the tokens back
select api.save_integration_tokens(tests.id('org_a'), 'pos', '{"access_token":"late"}', '{}', false);
select tests.as_postgres();
select is((select secret_ids ? 'access_token' from app.provider_settings where id = tests.id('integration_setting_a')), false, 'a late refresh does not recreate revoked tokens');

-- L1: a revocation for another merchant leaves the connection alone
select tests.as_service();
select api.save_integration_tokens(tests.id('org_a'), 'pos', '{"access_token":"tok-c"}', '{"merchant_id":"M1"}', true);
select api.revoke_integration(tests.id('org_a'), 'pos', 'OTHER');
select tests.as_postgres();
select is((select (verified_at is not null)::text || ':' || (secret_ids ? 'access_token')::text from app.provider_settings where id = tests.id('integration_setting_a')),
  'true:true', 'a revocation for another merchant is ignored');
select tests.as_service();
select api.revoke_integration(tests.id('org_a'), 'pos', 'M1');
select tests.as_postgres();
select is((select (verified_at is null)::text || ':' || (secret_ids ? 'access_token')::text from app.provider_settings where id = tests.id('integration_setting_a')),
  'true:false', 'a revocation for the connected merchant revokes it');

-- L4: editing the vendor app unverifies and drops the tokens; an unrelated edit keeps the hand-off data
select tests.as_service();
select api.save_integration_tokens(tests.id('org_a'), 'pos', '{"access_token":"tok-d"}', '{"merchant_id":"M1","application_id":"app1","environment":"sandbox"}', true);
select tests.as_postgres();
update app.provider_settings set enabled = true where id = tests.id('integration_setting_a');
update app.integration_jobs set status = 'queued', error = null where id = tests.id('integration_job_a');
select tests.act_as('admin');
select api.set_provider_settings(tests.id('org_a'), 'pos', 'square', 'own', '{"application_id":"app1","environment":"sandbox"}', '{}', gen_random_uuid());
select tests.as_postgres();
select is((select (verified_at is not null)::text || ':' || enabled::text || ':' || (secret_ids ? 'access_token')::text || ':' || (config ->> 'merchant_id')
           from app.provider_settings where id = tests.id('integration_setting_a')),
  'true:true:true:M1', 'saving the same app keeps tokens, verification and merchant_id');
select tests.act_as('admin');
select api.set_provider_settings(tests.id('org_a'), 'pos', 'square', 'own', '{"application_id":"app2","environment":"sandbox"}', '{}', gen_random_uuid());
select tests.as_postgres();
select is((select coalesce(verified_at::text, 'null') || ':' || enabled::text || ':' || (secret_ids ? 'access_token')::text
           from app.provider_settings where id = tests.id('integration_setting_a')),
  'null:false:false', 'a different application_id unverifies, disables and drops the tokens');
select is((select count(*)::int from vault.secrets where name like 'provider:' || tests.id('integration_setting_a') || ':%token'), 0, 'and deletes them from Vault');
select is((select status || ':' || error from app.integration_jobs where id = tests.id('integration_job_a')), 'dead:revoked', 'and dead-letters the waiting jobs');
select is((select config ->> 'merchant_id' from app.provider_settings where id = tests.id('integration_setting_a')), null, 'and forgets the old merchant');
select tests.as_service();
select api.save_integration_tokens(tests.id('org_a'), 'pos', '{"access_token":"tok-e"}', '{"merchant_id":"M2"}', true);
select tests.act_as('admin');
select api.set_provider_settings(tests.id('org_a'), 'pos', 'square', 'own', '{"application_id":"app2","environment":"production"}', '{}', gen_random_uuid());
select tests.as_postgres();
select is((select coalesce(verified_at::text, 'null') || ':' || (secret_ids ? 'access_token')::text from app.provider_settings where id = tests.id('integration_setting_a')),
  'null:false', 'a different environment does the same');

select * from finish();
rollback;
