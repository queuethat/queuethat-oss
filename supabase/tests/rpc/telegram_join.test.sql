-- 4-BOT2 (#382): /start <location slug> in Telegram joins the queue; /leave leaves; updates reach the chat.
begin;
\ir ../helpers/_setup.psql
select plan(23);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

create function tests.tg(p_chat text, p_update text, p_text text) returns jsonb language sql as $$
  select api.process_telegram_message(p_chat, p_update, p_text)
$$;
grant execute on function tests.tg(text, text, text) to service_role;

-- AC1/AC2: a chat joins, and /start twice is one visit.
select tests.as_service();
select is((tests.tg('4242', '1', '/start test-location-a')) ->> 'handled', 'join', 'the location slug joins its only queue');
select is((tests.tg('4242', '2', '/start test-location-a')) ->> 'handled', 'join', 'starting again is accepted');
select is((tests.tg('4242', '3', '/start@QueueBot test-location-a')) ->> 'ticket', (select display_ticket from app.visits where source = 'telegram'),
  'and repeats the same ticket');
select tests.as_postgres();
select is((select count(*) from app.visits where queue_id = tests.id('queue_a') and source = 'telegram'), 1::bigint,
  'AC2: one visit however often the chat starts');
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = 'tg:4242' and gc.channel = 'telegram' and c.channel = 'telegram' and c.status = 'granted'
             and c.source = 'telegram_start'), 1::bigint, '/start is one transactional telegram consent');
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = 'tg:4242' and c.channel <> 'telegram'), 0::bigint, 'and nothing else');

-- A second chat has its own place.
select tests.as_service();
select tests.tg('4243', '10', '/start test-location-a');
select tests.as_postgres();
select is((select count(*) from app.visits where source = 'telegram'), 2::bigint, 'a second chat has its own place');

-- Updates reach the chat.
select set_config('t.vid', (select l.visit_id::text from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id
                          where gc.value = 'tg:4242'), false);
select tests.act_as('staff');
select api.transition_visit(v.id, 'call', v.version, gen_random_uuid()) from app.visits v where v.id = current_setting('t.vid')::uuid;
select tests.as_postgres();
select is((select n.channel::text from app.notifications n where n.template_key = 'called' and n.channel = 'telegram'
           and n.recipient_ref = (select id from app.guest_contacts where value = 'tg:4242')), 'telegram', 'the call goes to the chat');

-- A keyword picks the queue; unknown things join nothing.
update app.queues set sms_keyword = 'CUTS' where id = tests.id('queue_a');
select tests.as_service();
select is((tests.tg('4244', '20', '/start test-location-a_cuts')) ->> 'handled', 'join', 'slug_KEYWORD joins that queue');
select is((tests.tg('4245', '21', '/start test-location-a_nope')) ->> 'handled', 'unknown', 'an unknown keyword joins nothing');
select is((tests.tg('4245', '22', '/start no-such-place')) ->> 'handled', 'unknown', 'an unknown slug joins nothing');
select is((tests.tg('4245', '23', '/start old-location-a')) ->> 'handled', 'join', 'a renamed location''s old slug still works');
select is((tests.tg('4246', '24', 'hello')) ->> 'handled', 'unhandled', 'other text is ignored');
select tests.as_postgres();

-- AC3: another org's slug or keyword never reaches org A.
select tests.as_service();
select is((tests.tg('4247', '30', '/start test-location-b_cuts')) ->> 'handled', 'unknown', 'AC3: org A''s keyword at org B''s location joins nothing');
select tests.as_postgres();
select is((select count(*) from app.visits where org_id = tests.id('org_b') and source = 'telegram'), 0::bigint, 'AC3: no org B visit');

-- A closed queue answers closed without a visit.
update app.queues set manual_state = 'closed' where id = tests.id('queue_a');
select tests.as_service();
select is((tests.tg('4248', '40', '/start test-location-a')) ->> 'handled', 'join_closed', 'a closed queue answers closed');
select tests.as_postgres();
select is((select count(*) from app.visits where id in
           (select l.visit_id from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id where gc.value = 'tg:4248')),
  0::bigint, 'and creates no visit');
update app.queues set manual_state = 'open' where id = tests.id('queue_a');

-- /leave: one live place is cancelled, repeating is a no-op.
select tests.as_service();
select is((tests.tg('4243', '50', '/leave')) ->> 'handled', 'leave', '/leave cancels the single live place');
select is((tests.tg('4243', '51', '/leave')) ->> 'handled', 'unhandled', 'leaving again is a no-op');
select tests.as_postgres();
select is((select status::text from app.visits where id in
           (select l.visit_id from app.channel_link_codes l join app.guest_contacts gc on gc.id = l.contact_id where gc.value = 'tg:4243')),
  'cancelled', 'the visit is cancelled');


-- A chat that keeps leaving and starting again is stopped after five joins an hour.
update app.queues set manual_state = 'open' where id = tests.id('queue_a');
select tests.as_service();
do $$ begin
  for g in 1..5 loop
    perform tests.tg('5000', (100 + 2 * g)::text, '/start test-location-a');
    perform tests.tg('5000', (101 + 2 * g)::text, '/leave');
  end loop;
end $$;
select is((tests.tg('5000', '70', '/start test-location-a')) ->> 'handled', 'join_closed', 'a sixth join within the hour is refused');
select is((tests.tg('5000', '71', '/leave')) ->> 'handled', 'unhandled', 'leaving with nothing live is a no-op');
select tests.as_postgres();

-- Only the service role can run it.
select tests.as_anon();
select throws_ok($$ select api.process_telegram_message('1', '1', '/start test-location-a') $$, '42501', null, 'anon cannot call it');
select tests.as_postgres();

select * from finish();
rollback;
