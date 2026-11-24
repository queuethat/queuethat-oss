-- #102: update and delete a webhook endpoint; the owner is emailed when an endpoint is switched off.
begin;
\ir ../helpers/_setup.psql
select plan(16);

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

create table tests.ep (name text primary key, id uuid);
grant all on tests.ep to authenticated, service_role;
select tests.act_as('admin');
insert into tests.ep select 'a', (api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/h', 'generic',
  array['visit.called'], false, gen_random_uuid())).id;

-- update
select api.update_webhook_endpoint((select id from tests.ep where name = 'a'), 'https://example.org/new',
  array['visit.joined', 'visit.served'], true);
select is((select url from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')), 'https://example.org/new', 'the URL changes');
select is((select event_types from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')),
  array['visit.joined', 'visit.served'], 'the events change');
select is((select include_guest_name from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')), true, 'the guest-name opt-in changes');
select is(tests.error_of(format('select api.update_webhook_endpoint(%L, %L, array[%L], false)', (select id from tests.ep where name = 'a'), 'http://example.org/x', 'visit.joined')),
  'P0001 invalid_url', 'http is refused unless the deployment allows it');
select is(tests.error_of(format('select api.update_webhook_endpoint(%L, %L, array[%L], false)', (select id from tests.ep where name = 'a'), 'https://example.org/x', 'visit.bogus')),
  'P0001 invalid_input', 'an unknown event type is invalid_input');
select is(tests.error_of(format('select api.update_webhook_endpoint(%L, %L, array[]::text[], false)', (select id from tests.ep where name = 'a'), 'https://example.org/x')),
  'P0001 invalid_input', 'no events is invalid_input');
select tests.as_postgres();
update app.webhook_endpoints set consecutive_failures = 7 where id = (select id from tests.ep where name = 'a');
select tests.act_as('admin');
select api.update_webhook_endpoint((select id from tests.ep where name = 'a'), 'https://example.org/other', array['visit.joined'], false);
select is((select consecutive_failures from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')), 0, 'a new URL resets the failure count');

-- auto-disable mails the owners once
select tests.as_postgres();
update app.webhook_endpoints set consecutive_failures = 19 where id = (select id from tests.ep where name = 'a');
insert into app.webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, payload, status, attempts)
values (tests.id('wd1'), tests.id('org_a'), (select id from tests.ep where name = 'a'), 'e1', 'visit.joined', '{}', 'claimed', 7);
select api.report_webhook_result(tests.id('wd1'), '{"status":"failed","attempt":7,"retryable":true}');
select is((select active from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')), false, 'the 20th dead delivery switches the endpoint off');
select is((select count(*)::int from app.notifications where template_key = 'webhook_disabled' and org_id = tests.id('org_a')), 1,
  'the owner is emailed once');
select is((select vars ->> 'host' from app.notifications where template_key = 'webhook_disabled' and org_id = tests.id('org_a')), 'example.org',
  'the email names the host, never the URL');

-- permissions and tenancy
select tests.act_as('staff');
select is(tests.error_of(format('select api.update_webhook_endpoint(%L, %L, array[%L], false)', (select id from tests.ep where name = 'a'), 'https://example.org/x', 'visit.joined')),
  '42501 permission_denied', 'staff cannot edit an endpoint');
select is(tests.error_of(format('select api.delete_webhook_endpoint(%L)', (select id from tests.ep where name = 'a'))),
  '42501 permission_denied', 'staff cannot delete an endpoint');
select tests.act_as('other_owner');
select is(tests.error_of(format('select api.update_webhook_endpoint(%L, %L, array[%L], false)', (select id from tests.ep where name = 'a'), 'https://example.org/x', 'visit.joined')),
  'P0001 not_found', 'cross-tenant: org B cannot edit an org A endpoint');
select is(tests.error_of(format('select api.delete_webhook_endpoint(%L)', (select id from tests.ep where name = 'a'))),
  'P0001 not_found', 'cross-tenant: org B cannot delete an org A endpoint');

-- delete
select tests.act_as('admin');
select api.delete_webhook_endpoint((select id from tests.ep where name = 'a'));
select tests.as_postgres();
select is((select count(*)::int from app.webhook_endpoints where id = (select id from tests.ep where name = 'a'))
        + (select count(*)::int from app.webhook_deliveries where endpoint_id = (select id from tests.ep where name = 'a')), 0,
  'delete removes the endpoint and its delivery log');
select tests.as_anon();
select throws_ok($$select api.delete_webhook_endpoint(gen_random_uuid())$$, '42501', null, 'anon cannot run it');
select * from finish();
rollback;
