-- 3-SMS6 (#355): C and L act on the sender's single live place; opt-out words always win.
begin;
\ir ../helpers/_setup.psql
select plan(12);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
select tests.new_visit('typed', 'queue_a');
select tests.new_visit('twin1', 'queue_a');
select tests.new_visit('twin2', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550177' where id = tests.id('typed');
update app.visits set guest_phone_e164 = '+14155550188' where id in (tests.id('twin1'), tests.id('twin2'));

create function tests.inbound(p_org text, p_from text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), 'sms', p_from, '+14155550000', p_body, 'twilio', p_id)).handled_as
$$;
grant execute on function tests.inbound(text, text, text, text) to service_role;

select tests.as_service();
-- Unknown text: one hint, rate limited.
select is(tests.inbound('org_a', '+14155550177', 'what time?', 'c1'), 'unhandled', 'unknown text is left for staff');
select is(tests.inbound('org_a', '+14155550177', 'hello?', 'c2'), 'unhandled', 'and again');
select tests.as_postgres();
select is((select count(*) from app.notifications where template_key = 'reply_commands' and visit_id = tests.id('typed')), 1::bigint,
  'one commands hint per visit per 10 minutes');

-- Confirm.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550177', 'c', 'c3'), 'confirm', 'C confirms');
select tests.as_postgres();
select is((select count(*) from app.visit_events where visit_id = tests.id('typed') and type = 'on_my_way' and payload->>'source' = 'sms'),
  1::bigint, 'a guest on_my_way event records the confirmation');

-- AC2: CANCEL is an opt-out, the visit is unchanged.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550177', 'CANCEL', 'c4'), 'stop', 'AC2: CANCEL is an opt-out');
select tests.as_postgres();
select is((select status::text from app.visits where id = tests.id('typed')), 'waiting', 'AC2: and the visit is unchanged');
delete from app.suppressions;

-- AC1: L leaves as the guest.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550177', ' l ', 'c5'), 'leave', 'AC1: L leaves');
select tests.as_postgres();
select is((select status::text || ':' || (select actor_kind::text from app.visit_events e where e.visit_id = v.id order by id desc limit 1)
           from app.visits v where v.id = tests.id('typed')), 'cancelled:guest', 'AC1: cancelled with a guest actor');

-- J-15: two live places, act on neither.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550188', 'L', 'c6'), 'unhandled', 'two live places: no action');
-- AC4: org B's number, org A's guest.
select is(tests.inbound('org_b', '+14155550188', 'L', 'c7'), 'unhandled', 'AC4: another org changes nothing');
select tests.as_postgres();
select is((select count(*) from app.visits where id in (tests.id('twin1'), tests.id('twin2')) and status = 'waiting'), 2::bigint,
  'both visits are still waiting');

select * from finish();
rollback;
