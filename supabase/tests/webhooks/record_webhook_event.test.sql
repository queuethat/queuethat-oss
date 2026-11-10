-- 3-CG1 (#326): webhook events are recorded once, only the service role can record them, and
-- inbound messages are tenant-scoped.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

select tests.as_service();
select is((api.record_webhook_event('twilio', 'SM1', tests.id('org_a'), '{"a":1}')).is_duplicate, false, 'AC1: the first record is new');
select is((api.record_webhook_event('twilio', 'SM1', tests.id('org_a'), '{"a":2}')).is_duplicate, true, 'AC1: the second is a duplicate');
select tests.as_postgres();
select is((select count(*) from private.webhook_events where provider = 'twilio' and event_key = 'SM1'), 1::bigint, 'AC1: and no second row exists');
select is((select payload->>'a' from private.webhook_events where event_key = 'SM1'), '1', 'the duplicate does not overwrite the payload');
select tests.as_postgres();
select id as first_id from private.webhook_events where event_key = 'SM1' \gset
select tests.as_service();
select tests.as_service();
select is((api.record_webhook_event('twilio', 'SM1', null, '{}')).event_id,
          :first_id::bigint, 'a duplicate returns the first event id');
select is((api.record_webhook_event('stripe', 'SM1', null, '{}')).is_duplicate, false, 'the key is scoped to the provider');
select throws_ok($$ select api.record_webhook_event('', 'x', null, '{}') $$, 'P0001', 'invalid_input', 'an empty provider is refused');

select api.mark_webhook_processed(:first_id::bigint, 'boom');
select api.mark_webhook_processed(:first_id::bigint, 'later');
select tests.as_postgres();
select is((select error from private.webhook_events where provider = 'twilio' and event_key = 'SM1'), 'boom', 'the first error wins and a repeat is a no-op');
select isnt((select processed_at from private.webhook_events where provider = 'twilio' and event_key = 'SM1'), null, 'processed_at is stamped');

-- AC2: nobody but the service role.
select tests.as_anon();
select throws_ok($$ select api.record_webhook_event('twilio', 'SM2', null, '{}') $$, '42501', null, 'AC2: anon is denied');
select tests.act_as('owner');
select throws_ok($$ select api.record_webhook_event('twilio', 'SM2', null, '{}') $$, '42501', null, 'AC2: an org owner is denied');

-- AC3: inbound messages are readable by the org's staff only, and writable by nobody.
select tests.as_postgres();
insert into app.inbound_messages (org_id, from_value_e164, body, provider, provider_message_id)
values (tests.id('org_a'), '+14155550199', 'hi', 'twilio', 'SM9');
select tests.as_user(tests.id('other_owner'));
select is((select count(*) from app.inbound_messages), 0::bigint, 'AC3: org B sees no org A inbound messages');
-- AC4: the table sits in a schema PostgREST does not expose (config.toml lists api, api_v1, app) and
-- no app role has a privilege on it.
select is((select count(*) from unnest(array['anon', 'authenticated', 'service_role']) r
           where has_table_privilege(r, 'private.webhook_events', 'select, insert, update, delete')), 0::bigint,
  'AC4: no API role can touch private.webhook_events directly');

select * from finish();
rollback;
