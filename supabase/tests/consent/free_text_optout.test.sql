-- C1 (#1227): free-text opt-outs suppress like STOP; a bare no, longer texts and YES do not.
begin;
\ir ../helpers/_setup.psql
select plan(23);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();

create function tests.inbound(p_org text, p_from text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), 'sms', p_from, '+14155550000', p_body, 'twilio', p_id)).handled_as
$$;
grant execute on function tests.inbound(text, text, text, text) to service_role;

-- AC1: each phrase suppresses the sender for the org.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550301', 'Stop texting me', 'f1'), 'stop', 'stop texting me opts out');
select is(tests.inbound('org_a', '+14155550302', 'please stop', 'f2'), 'stop', 'please stop opts out');
select is(tests.inbound('org_a', '+14155550303', 'Remove me!', 'f3'), 'stop', 'remove me opts out');
select is(tests.inbound('org_a', '+14155550304', 'unsubscribe me', 'f4'), 'stop', 'unsubscribe me opts out');
select is(tests.inbound('org_a', '+14155550305', 'No más', 'f5'), 'stop', 'Spanish no más opts out (accent folded)');
select is(tests.inbound('org_a', '+14155550306', 'PARE', 'f6'), 'stop', 'pare opts out');
select is(tests.inbound('org_a', '+14155550307', 'Baja, gracias', 'f7'), 'stop', 'baja opts out');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and channel = 'sms' and reason = 'stop'
           and value between '+14155550301' and '+14155550307'), 7, 'every phrase left a suppression');

-- AC2: nothing else does.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550311', 'no', 'n1'), 'unhandled', 'a bare no does not');
select is(tests.inbound('org_a', '+14155550312', 'stop by at 5', 'n2'), 'unhandled', 'stop inside a longer text does not');
select is(tests.inbound('org_a', '+14155550313', 'can you remove me from the 3pm slot', 'n3'), 'unhandled', 'remove me inside a longer text does not');
select is(tests.inbound('org_a', '+14155550314', 'no more than two please', 'n4'), 'unhandled', 'no more inside a longer text does not');
select is(tests.inbound('org_a', '+14155550315', 'baja la voz', 'n5'), 'unhandled', 'baja inside a longer text does not');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value between '+14155550311' and '+14155550315'), 0,
  'none of them suppressed anything');

-- AC3: a replay returns the first answer and changes nothing.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550301', 'Stop texting me', 'f1'), 'stop', 'a replayed webhook returns the first answer');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = '+14155550301'), 1, 'and there is still one suppression');
select is((select count(*)::int from app.inbound_messages where org_id = tests.id('org_a') and provider_message_id = 'f1'), 1, 'and one stored message');

-- AC4: cross-org. An org's inbound text never touches another org.
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_b')), 0, 'org B has no suppression from org A''s inbound text');

-- YES no longer lifts a STOP; START still does.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550301', 'YES', 'y1'), 'unhandled', 'YES is not a keyword');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = '+14155550301'), 1, 'YES left the stop in place');
select tests.as_service();
select is(tests.inbound('org_a', '+14155550301', 'start', 'y2'), 'start', 'START is still an opt-in');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = '+14155550301'), 0, 'and lifts the stop');

-- A queue cannot claim YES, nor a free-text opt-out word, as its join keyword.
select ok(not private.valid_sms_keyword('YES') and not private.valid_sms_keyword('BAJA') and private.valid_sms_keyword('CUTS'),
  'YES and BAJA are reserved, an ordinary word is not');

select * from finish();
rollback;
