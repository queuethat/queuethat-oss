-- 3-DOM1 (#370): custom domains. AC1 unverified -> no slug; AC2 verified -> slug; AC3 domain_taken
-- without naming the holder; AC4 cross-tenant read is empty.
begin;
\ir ../helpers/_setup.psql
select plan(26);

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
create table tests.doms (name text primary key, id uuid);
grant all on tests.doms to authenticated, service_role;

-- add: lower-cases, returns pending with a token, idempotent
select tests.act_as('admin');
insert into tests.doms select 'a', (api.add_custom_domain(tests.id('org_a'), ' Book.Barber-A.COM. ', tests.id('loc_a'),
  '00000000-0000-0000-0000-0000000000d1')).id;
select is((select hostname from app.custom_domains where id = (select id from tests.doms where name = 'a')),
  'book.barber-a.com', 'the hostname is stored lower-case without the trailing dot');
select is((select status from app.custom_domains where id = (select id from tests.doms where name = 'a')),
  'pending', 'a new domain is pending');
select matches((select verification_token from app.custom_domains where id = (select id from tests.doms where name = 'a')),
  '^[0-9a-f]{32}$', 'it gets a verification token');
select is((select (api.add_custom_domain(tests.id('org_a'), 'book.barber-a.com', tests.id('loc_a'),
  '00000000-0000-0000-0000-0000000000d1')).id), (select id from tests.doms where name = 'a'),
  'a repeat with the same key returns the same domain');
select is((select (api.add_custom_domain(tests.id('org_a'), 'book.barber-a.com', tests.id('loc_a'), gen_random_uuid())).id),
  (select id from tests.doms where name = 'a'), 'adding your own hostname again returns it');
select is((select count(*)::int from app.custom_domains where hostname = 'book.barber-a.com'), 1, 'no duplicate row');
select is((select count(*)::int from app.audit_log where table_name = 'custom_domains' and action = 'INSERT'
           and row_id = (select id::text from tests.doms where name = 'a')), 1, 'adding writes an audit row');

-- validation
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), '192.168.0.1', tests.id('loc_a'), gen_random_uuid())$$),
  'P0001 invalid_input', 'an IPv4 address is refused');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), 'bücher.example.org', tests.id('loc_a'), gen_random_uuid())$$),
  'P0001 invalid_input', 'non-ASCII must arrive as punycode');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), 'join.queuethat.com', tests.id('loc_a'), gen_random_uuid())$$),
  'P0001 invalid_input', 'our own domain is refused');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), 'localhost', tests.id('loc_a'), gen_random_uuid())$$),
  'P0001 invalid_input', 'a single label is refused');
select is(tests.error_of(format($f$select api.add_custom_domain(tests.id('org_a'), %L, tests.id('loc_a'), gen_random_uuid())$f$,
  repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 63) || '.com')),
  'P0001 invalid_input', 'more than 253 characters is refused');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), 'x.example.org', tests.id('loc_b'), gen_random_uuid())$$),
  'P0001 not_found', 'a location of another org is not found');

-- roles
select tests.act_as('manager');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), 'm.example.org', tests.id('loc_a'), gen_random_uuid())$$),
  '42501 permission_denied', 'a manager cannot add a domain');
select is((select count(*)::int from app.custom_domains), 0, 'a manager reads no domains');

-- AC3 / AC4: org B
select tests.act_as('other_owner');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_b'), 'book.barber-a.com', tests.id('loc_b'), gen_random_uuid())$$),
  'P0001 domain_taken', 'AC3: another org adding a claimed hostname gets domain_taken');
select is((select count(*)::int from app.custom_domains), 0, 'AC4: org B reads zero org A domains');
select is(tests.error_of(format('select api.remove_custom_domain(%L, gen_random_uuid())', (select id from tests.doms where name = 'a'))),
  'P0001 not_found', 'org B cannot remove an org A domain (and cannot tell it exists)');
select is(tests.error_of($$select api.add_custom_domain(tests.id('org_a'), 'y.example.org', tests.id('loc_a'), gen_random_uuid())$$),
  'P0001 not_found', 'org B cannot add a domain to org A');

-- a stale unproved claim stops blocking
select tests.as_postgres();
update app.custom_domains set created_at = now() - interval '8 days' where hostname = 'book.barber-a.com';
select tests.act_as('other_owner');
select lives_ok($$select api.add_custom_domain(tests.id('org_b'), 'book.barber-a.com', tests.id('loc_b'), gen_random_uuid())$$,
  'an unproved claim older than 7 days is replaced by the next claimant');
select tests.as_postgres();
select is((select org_id from app.custom_domains where hostname = 'book.barber-a.com'), tests.id('org_b'), 'org B now holds it');
delete from app.custom_domains where hostname = 'book.barber-a.com';

-- resolve / record_domain_check (service role)
select tests.act_as('admin');
insert into tests.doms select 'b', (api.add_custom_domain(tests.id('org_a'), 'queue.barber-a.com', tests.id('loc_a'), gen_random_uuid())).id;
select tests.as_service();
select is((select api.resolve_custom_domain('queue.barber-a.com')), null, 'AC1: an unverified host resolves to nothing');
select api.record_domain_check((select id from tests.doms where name = 'b'), true);
select is((select api.resolve_custom_domain('Queue.Barber-A.com:443')), 'test-location-a',
  'AC2: a verified host resolves to the location slug (port and case ignored)');
select is((select string_agg(status, ',') from (
  select (api.record_domain_check((select id from tests.doms where name = 'b'), false)).status
  from generate_series(1, 3)) s), 'verified,verified,disabled',
  'three consecutive failures disable a verified domain');
select is((select api.resolve_custom_domain('queue.barber-a.com')), null, 'a disabled host resolves to nothing');

-- remove
select tests.act_as('admin');
select api.remove_custom_domain((select id from tests.doms where name = 'b'), '00000000-0000-0000-0000-0000000000d2');
select lives_ok($$select api.remove_custom_domain((select id from tests.doms where name = 'b'), '00000000-0000-0000-0000-0000000000d2')$$,
  'removing twice with the same key is a no-op');

select * from finish();
rollback;
