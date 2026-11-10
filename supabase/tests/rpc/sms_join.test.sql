-- 3-SMS7 (#356): texting a queue's keyword joins it, once, in the org that owns the number.
begin;
\ir ../helpers/_setup.psql
select plan(14);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
update app.queues set sms_keyword = 'CUTS' where id = tests.id('queue_a');

create function tests.inbound(p_org text, p_from text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), 'sms', p_from, '+14155550000', p_body, 'twilio', p_id)).handled_as
$$;
grant execute on function tests.inbound(text, text, text, text) to service_role;

-- AC1
select tests.as_service();
select is(tests.inbound('org_a', '+14155550321', 'cuts', 'j1'), 'join', 'AC1: the keyword joins');
select tests.as_postgres();
select is((select count(*) from app.visits where queue_id = tests.id('queue_a') and source = 'sms' and guest_phone_e164 = '+14155550321'),
  1::bigint, 'AC1: one visit with source sms');
select is((select count(*) from app.notifications where template_key = 'reply_join' and visit_id in
           (select id from app.visits where guest_phone_e164 = '+14155550321')), 1::bigint, 'AC1: one reply is queued');
select is((select vars ? 'ticket' and vars ? 'position' from app.notifications where template_key = 'reply_join'), true,
  'the reply carries the ticket and position');
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = '+14155550321' and c.channel = 'sms' and c.status = 'granted'), 1::bigint, 'the text is the consent');

-- AC2
select tests.as_service();
select is(tests.inbound('org_a', '+14155550321', ' CUTS! ', 'j2'), 'join', 'texting again is accepted');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550321'), 1::bigint, 'AC2: no second visit');

-- AC3: a closed queue.
update app.queues set manual_state = 'closed' where id = tests.id('queue_a');
select tests.as_service();
select is(tests.inbound('org_a', '+14155550322', 'CUTS', 'j3'), 'join_closed', 'AC3: a closed queue answers closed');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550322'), 0::bigint, 'AC3: and creates no visit');
select is((select count(*) from app.notifications where template_key = 'reply_join_closed'), 1::bigint, 'AC3: a closed reply is queued');

-- AC4: reserved words.
select throws_ok($$ update app.queues set sms_keyword = 'STOP' where id = tests.id('queue_a') $$, '23514', null, 'AC4: STOP is refused');
select throws_ok($$ update app.queues set sms_keyword = 'L' where id = tests.id('queue_a') $$, '23514', null, 'AC4: L is refused');

-- Closed replies are capped per org per minute.
update app.queues set manual_state = 'closed' where id = tests.id('queue_a');
select tests.as_service();
select tests.inbound('org_a', '+1415555040' || g, 'CUTS', 'k' || g) from generate_series(0, 7) g;
select tests.as_postgres();
select is((select count(*) from app.notifications where template_key = 'reply_join_closed'), 5::bigint,
  'closed replies stop at 5 a minute per org');

-- AC5: org A's keyword on org B's number does nothing.
update app.queues set manual_state = 'open' where id = tests.id('queue_a');
select tests.as_service();
select is(tests.inbound('org_b', '+14155550323', 'CUTS', 'j4'), 'unhandled', 'AC5: another org''s number does not join org A''s queue');

select * from finish();
rollback;
