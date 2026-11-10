-- 2B-I10 (#315): chat alerts. queue.long threshold alerts, delivery.dead, vendor URL check, tenancy.
begin;
\ir ../helpers/_setup.psql
select plan(14);

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

-- AC3
select tests.act_as('admin');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/h', 'slack', array['visit.joined'], false, gen_random_uuid())$$),
  'P0001 invalid_url', 'AC3: a slack endpoint needs a hooks.slack.com URL');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://hooks.slack.com.evil.test/x', 'slack', array['visit.joined'], false, gen_random_uuid())$$),
  'P0001 invalid_url', 'a lookalike host is rejected');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://hooks.slack.com:8443/services/x', 'slack', array['visit.joined'], false, gen_random_uuid())$$),
  'P0001 invalid_url', 'a vendor host on another port is rejected');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://discord.com/other/1', 'discord', array['visit.joined'], false, gen_random_uuid())$$),
  'P0001 invalid_url', 'a discord URL must be under /api/webhooks/');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://x.webhook.office.com/webhookb2/1', 'teams', array['queue.long'], false, gen_random_uuid())$$),
  'ok', 'a teams workflow URL is accepted');
select is(tests.error_of($$select api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/h', 'generic', array['queue.long','delivery.dead'], false, gen_random_uuid())$$),
  'ok', 'queue.long and delivery.dead are subscribable');
insert into tests.ep select 'slack', (api.create_webhook_endpoint(tests.id('org_a'), 'https://hooks.slack.com/services/T/B/x', 'slack',
  array['visit.joined', 'queue.long', 'delivery.dead'], false, gen_random_uuid())).id;

-- thresholds
select is(tests.error_of(format('select api.set_webhook_alert_thresholds(%L, %L)', (select id from tests.ep where name = 'slack'), '{"waiting": 0}')),
  'P0001 invalid_input', 'a zero threshold is invalid_input');
select is(tests.error_of(format('select api.set_webhook_alert_thresholds(%L, %L)', (select id from tests.ep where name = 'slack'), '{"bogus": 3}')),
  'P0001 invalid_input', 'an unknown threshold key is invalid_input');
select api.set_webhook_alert_thresholds((select id from tests.ep where name = 'slack'), '{"waiting": 1}');

-- AC1 + AC2: a second waiting visit goes over a threshold of 1
select tests.as_postgres();
delete from app.webhook_deliveries;
select tests.new_visit('visit_extra', 'queue_a');
select is((select count(*)::int from app.webhook_deliveries where event_type = 'visit.joined' and endpoint_id = (select id from tests.ep where name = 'slack')
           and payload::text !~ '@|\+[0-9]{6}|phone|email'), 1, 'AC1: the joined delivery carries no phone or email');
select is(ops.evaluate_queue_long(), 1, 'AC2: one queue.long is queued when waiting exceeds the threshold');
select is(ops.evaluate_queue_long(), 0, 'AC2: and no second within 30 minutes');
update app.webhook_deliveries set created_at = now() - interval '31 minutes', event_id = 'old' where event_type = 'queue.long';
select is(ops.evaluate_queue_long(), 1, 'a later check after 30 minutes alerts again');

-- delivery.dead carries no recipient
update app.notifications set status = 'dead' where id = tests.id('notification_a');
select is((select payload #>> '{data,notification,channel}' from app.webhook_deliveries where event_type = 'delivery.dead' and endpoint_id = (select id from tests.ep where name = 'slack')), 'push',
  'a dead guest message becomes delivery.dead with the channel only');

-- AC4
select tests.act_as('other_owner');
select is((select count(*)::int from app.webhook_endpoints) + (select count(*)::int from app.webhook_deliveries), 0,
  'AC4: org B sees no org A endpoints or alerts');
select * from finish();
rollback;
