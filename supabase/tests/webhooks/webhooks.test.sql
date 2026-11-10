-- 2B-I6 (#311): webhook endpoints, the delivery outbox and its enqueue trigger.
begin;
\ir ../helpers/_setup.psql
select plan(18);

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

create table tests.ep (name text primary key, id uuid, secret text);
grant all on tests.ep to authenticated, service_role;
select tests.act_as('admin');
insert into tests.ep select 'a', e.id, e.secret
from api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/hook', 'generic',
  array['visit.called', 'visit.joined'], false, gen_random_uuid()) e;
select matches((select secret from tests.ep where name = 'a'), '^whsec_[0-9a-f]{48}$', 'create returns the signing secret once');

-- AC3
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'http://example.com/h', 'generic', array['visit.called'], false, gen_random_uuid())$$),
  'P0001 invalid_url', 'AC3: http is invalid_url on a hosted deployment');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/h', 'generic', array['visit.nope'], false, gen_random_uuid())$$),
  'P0001 invalid_input', 'an unknown event type is invalid_input');
select tests.as_postgres();
update private.deployment_settings set allow_http_webhooks = true;
select tests.act_as('admin');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'http://example.com/h', 'generic', array['queue.state_changed'], false, gen_random_uuid())$$),
  'ok', 'http is allowed when the deployment says so');
select tests.as_postgres();
update private.deployment_settings set allow_http_webhooks = false;

select tests.act_as('manager');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/h', 'generic', array['visit.called'], false, gen_random_uuid())$$),
  '42501 permission_denied', 'a manager cannot create an endpoint');

-- AC1 + AC2
select tests.as_postgres();
select tests.new_visit('wv', 'queue_a', 'Alice Smith');
select is((select count(*)::int from app.webhook_deliveries where event_type = 'visit.joined' and event_id <> 'fixture'), 1,
  'a join queues exactly one delivery for the endpoint subscribed to visit.joined');
select is((select count(*)::int from app.webhook_deliveries where event_type = 'visit.called' and event_id <> 'fixture'), 0, 'and none for visit.called yet');
select is((select payload::text like '%Alice%' or payload::text like '%phone%' or payload::text like '%email%' from app.webhook_deliveries where event_id <> 'fixture' limit 1),
  false, 'AC2: no guest name, phone or email in the payload without the opt-in');
select is((select payload ->> 'api_version' from app.webhook_deliveries where event_id <> 'fixture' limit 1), 'v1', 'the payload is versioned');
update app.webhook_endpoints set include_guest_name = true;
select private.set_actor('system', null, 'call');
update app.visits set status = 'called', called_at = now(), call_count = 1 where id = tests.id('wv');
select is((select payload -> 'data' -> 'visit' ->> 'guest_first_name' from app.webhook_deliveries where event_type = 'visit.called' and event_id <> 'fixture'),
  'Alice', 'AC2: the first name appears only for an opted-in endpoint, and only the first name');

-- claim and report
select tests.as_service();
select is((select count(*)::int from api.claim_webhook_deliveries(10, 60)), 2, 'the sender claims both due deliveries');
select is((select count(*)::int from api.claim_webhook_deliveries(10, 60)), 0, 'a second claim finds nothing while leased');
select api.report_webhook_result((select id from app.webhook_deliveries where event_type = 'visit.called' and event_id <> 'fixture'), '{"status":"delivered","response_status":200,"response_ms":12}');
select tests.as_postgres();
select is((select status from app.webhook_deliveries where event_type = 'visit.called' and event_id <> 'fixture'), 'delivered', 'a delivered result is recorded');

-- review fixes: a location-restricted admin cannot manage org-wide endpoints; endpoint cap
select tests.as_postgres();
update app.memberships set location_ids = array[tests.id('loc_a')] where user_id = tests.id('admin');
select tests.act_as('admin');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/r', 'generic', array['visit.called'], false, gen_random_uuid())$$),
  '42501 permission_denied', 'a location-restricted admin cannot create an endpoint');
select is((select count(*)::int from app.webhook_deliveries), 0, 'nor read the deliveries');
select tests.as_postgres();
update app.memberships set location_ids = null where user_id = tests.id('admin');

-- AC4
select tests.act_as('other_owner');
select is((select count(*)::int from app.webhook_endpoints) + (select count(*)::int from app.webhook_deliveries), 0,
  'AC4: org B sees no org A endpoints or deliveries');
select is(tests.error_of(format('select api.rotate_webhook_secret(%L)', (select id from tests.ep where name = 'a'))),
  'P0001 not_found', 'AC4: org B cannot rotate an org A secret');
select tests.act_as('admin');
select isnt((select secret from api.rotate_webhook_secret((select id from tests.ep where name = 'a'))),
  (select secret from tests.ep where name = 'a'), 'rotation issues a new secret');

select * from finish();
rollback;
