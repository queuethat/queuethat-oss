-- 2B-I8 (#313): send_webhook_test and set_webhook_active.
begin;
\ir ../helpers/_setup.psql
select plan(9);

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

select api.send_webhook_test((select id from tests.ep where name = 'a'));
select tests.as_postgres();
select is((select count(*)::int from app.webhook_deliveries where event_type = 'ping' and status = 'queued'), 1, 'a test queues one ping');
select tests.act_as('admin');
select api.send_webhook_test((select id from tests.ep where name = 'a'));
select tests.as_postgres();
select is((select count(*)::int from app.webhook_deliveries where event_type = 'ping'), 1, 'a repeat within 10 seconds is a no-op');

select tests.act_as('admin');
select api.set_webhook_active((select id from tests.ep where name = 'a'), false);
select is((select active from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')), false, 'an endpoint can be switched off');
select is(tests.error_of(format('select api.send_webhook_test(%L)', (select id from tests.ep where name = 'a'))),
  'P0001 invalid_input', 'an endpoint that is off cannot be tested');
select tests.as_postgres();
update app.webhook_endpoints set consecutive_failures = 50, disabled_reason = 'too_many_failures' where id = (select id from tests.ep where name = 'a');
select tests.act_as('admin');
select api.set_webhook_active((select id from tests.ep where name = 'a'), true);
select is((select active and consecutive_failures = 0 and disabled_reason is null from app.webhook_endpoints where id = (select id from tests.ep where name = 'a')), true,
  'switching on clears the failure count and reason');

select tests.act_as('staff');
select is(tests.error_of(format('select api.set_webhook_active(%L, false)', (select id from tests.ep where name = 'a'))),
  '42501 permission_denied', 'staff cannot manage endpoints');
select tests.act_as('other_owner');
select is(tests.error_of(format('select api.send_webhook_test(%L)', (select id from tests.ep where name = 'a'))),
  'P0001 not_found', 'cross-tenant: org B cannot test an org A endpoint');
select is(tests.error_of(format('select api.set_webhook_active(%L, false)', (select id from tests.ep where name = 'a'))),
  'P0001 not_found', 'cross-tenant: org B cannot switch an org A endpoint');
select tests.as_anon();
select throws_ok($$select api.send_webhook_test(gen_random_uuid())$$, '42501', null, 'anon cannot run it');
select * from finish();
rollback;
