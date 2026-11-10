-- N4 (#254): api.log_manual_contact.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_w'), tests.id('org_a'), tests.id('loc_a'), 'Wa', 'W');
select tests.new_visit('wv', 'queue_w');
select tests.new_visit('nophone', 'queue_w');
update app.visits set guest_phone_e164 = '+447700900123' where id = tests.id('wv');

select tests.act_as('staff');
select is(api.log_manual_contact(tests.id('wv'), 'whatsapp'), '+447700900123', 'staff get the number to build the wa.me link');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where table_name = 'manual_contact' and row_id = tests.id('wv')::text
           and actor = tests.id('staff') and after ->> 'channel' = 'whatsapp'), 1, 'each tap writes an audit row with the actor');
select tests.act_as('staff');
select throws_ok($$ select api.log_manual_contact(tests.id('nophone'), 'whatsapp') $$, 'P0001', 'no_contact', 'no phone, no link');
select throws_ok($$ select api.log_manual_contact(tests.id('wv'), 'sms') $$, 'P0001', 'invalid_input', 'only whatsapp');

select tests.as_postgres();
insert into app.suppressions (org_id, channel, value, reason) values (tests.id('org_a'), 'sms', '+447700900123', 'stop');
select tests.act_as('staff');
select throws_ok($$ select api.log_manual_contact(tests.id('wv'), 'whatsapp') $$, 'P0001', 'suppressed', 'an opted-out number is refused');

select tests.act_as('other_owner');
select throws_ok($$ select api.log_manual_contact(tests.id('wv'), 'whatsapp') $$, 'P0001', 'not_found', 'another org gets not_found');
select tests.as_anon();
select throws_ok($$ select api.log_manual_contact(tests.id('wv'), 'whatsapp') $$, '42501', null, 'anon cannot call it');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where table_name = 'manual_contact'), 1, 'refused calls left no audit rows');

select * from finish();
rollback;
