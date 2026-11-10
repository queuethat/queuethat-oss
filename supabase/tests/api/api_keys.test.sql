-- 2B-I1 (#306): hashed, scoped API keys.
begin;
\ir ../helpers/_setup.psql
select plan(20);

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

create table tests.keys (name text primary key, key_id uuid, prefix text, plain text);
grant all on tests.keys to authenticated, service_role;

select tests.act_as('admin');
insert into tests.keys
select 'a', k.key_id, k.prefix, k.plaintext_key
from api.create_api_key(tests.id('org_a'), 'Zapier', array['queues:read', 'visits:read'], null, null,
                        gen_random_uuid()) k;
select matches((select plain from tests.keys where name = 'a'), '^qk_live_[0-9a-f]{8}_[0-9a-f]{32}$',
  'create returns the plaintext key in the documented format');

-- AC1: no column holds the plaintext secret
select tests.as_postgres();
select is((select count(*)::int from app.api_keys k, tests.keys t
           where t.name = 'a' and k.id = t.key_id and k::text like '%' || right(t.plain, 32) || '%'), 0,
  'AC1: no api_keys column contains the plaintext secret');
select is((select secret_hash from app.api_keys where id = (select key_id from tests.keys where name = 'a')),
  extensions.digest((select plain from tests.keys where name = 'a'), 'sha256'),
  'only the SHA-256 is stored');
select is((select count(*)::int from app.audit_log
           where table_name = 'api_keys' and (after::text like '%secret_hash%' or after is null)), 0,
  'the audit row exists and carries no secret_hash');
select is((select count(*)::int from app.audit_log where table_name = 'api_keys' and action = 'INSERT'
           and row_id = (select key_id::text from tests.keys where name = 'a')), 1,
  'creating a key writes an audit row');

-- the owner and admin read metadata, never the hash
select tests.act_as('admin');
select is((select count(*)::int from app.api_keys), 2, 'an admin lists the org keys (fixture + new)');
select is(tests.error_of('select secret_hash from app.api_keys'), '42501 permission denied for table api_keys',
  'secret_hash is not selectable by clients');

-- idempotent create
select is((select (k).key_id from (select api.create_api_key(tests.id('org_a'), 'x', array['queues:read'], null, null,
            '00000000-0000-0000-0000-0000000000a1') k) s) is not null, true, 'first call creates');
select is((select (k).plaintext_key from (select api.create_api_key(tests.id('org_a'), 'x', array['queues:read'], null, null,
            '00000000-0000-0000-0000-0000000000a1') k) s), null, 'a repeat returns no plaintext');
select is((select count(*)::int from app.api_keys where name = 'x'), 1, 'a repeat creates no second key');

-- AC3 manager / staff denied
select tests.act_as('manager');
select is(tests.error_of($$select api.create_api_key(tests.id('org_a'), 'n', array['queues:read'], null, null, gen_random_uuid())$$),
  '42501 permission_denied', 'AC3: a manager cannot create a key');
select tests.act_as('staff');
select is(tests.error_of($$select api.create_api_key(tests.id('org_a'), 'n', array['queues:read'], null, null, gen_random_uuid())$$),
  '42501 permission_denied', 'AC3: staff cannot create a key');

-- AC4 cross tenant
select tests.act_as('other_owner');
select is((select count(*)::int from app.api_keys), 0, 'AC4: org B sees zero org A keys');
select is(tests.error_of(format('select api.revoke_api_key(%L)', (select key_id from tests.keys where name = 'a'))),
  'P0001 not_found', 'AC4: org B cannot revoke an org A key');
select is(tests.error_of($$select api.create_api_key(tests.id('org_a'), 'n', array['queues:read'], null, null, gen_random_uuid())$$),
  'P0001 not_found', 'AC4: org B cannot create an org A key');

-- AC5 unknown scope
select tests.act_as('admin');
select is(tests.error_of($$select api.create_api_key(tests.id('org_a'), 'n', array['queues:fly'], null, null, gen_random_uuid())$$),
  'P0001 invalid_scope', 'AC5: an unknown scope is invalid_scope');

select is(tests.error_of($$select api.create_api_key(tests.id('org_a'), 'n', array['queues:read'], '{}', null, gen_random_uuid())$$),
  'P0001 invalid_input', 'an empty location list is invalid, not "no restriction"');
select is(tests.error_of($$select api.create_api_key(tests.id('org_b'), 'n', array['queues:read'], null, null, '00000000-0000-0000-0000-0000000000a1')$$),
  'P0001 not_found', 'a replayed idempotency key never answers for another org');

-- authenticate / AC2
select tests.as_postgres();
select is((select scopes from private.authenticate_api_key((select plain from tests.keys where name = 'a'))),
  array['queues:read', 'visits:read'], 'a live key authenticates and returns its scopes');
select tests.act_as('admin');
select api.revoke_api_key((select key_id from tests.keys where name = 'a'));
select api.revoke_api_key((select key_id from tests.keys where name = 'a'));
select tests.as_postgres();
select is(tests.error_of(format('select * from private.authenticate_api_key(%L)', (select plain from tests.keys where name = 'a'))),
  tests.error_of($$select * from private.authenticate_api_key('qk_live_00000000_00000000000000000000000000000000')$$),
  'AC2: a revoked key fails exactly like an unknown key');

select * from finish();
rollback;
