-- 3-CG10 (#335): staff see whether each live guest can receive texts; org B sees nothing.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

select tests.new_visit(n, 'queue_a') from unnest(array['tnone', 'toff', 'ton', 'tstop']) n;
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550201' where id = tests.id('toff');
update app.visits set guest_phone_e164 = '+14155550202' where id = tests.id('ton');
update app.visits set guest_phone_e164 = '+14155550999' where id = tests.id('tstop'); -- opted out in the fixture
insert into app.guests (id, org_id) values (tests.new_id('tg'), tests.id('org_a'));
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('tc'), tests.id('org_a'), tests.id('tg'), 'phone', '+14155550202', 'staff');
update app.visits set contact_id = tests.id('tc') where id = tests.id('ton');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('tc'), 'sms', 'transactional', 'granted', 'online', '1', 'h');

create function tests.state(p text) returns text language sql as $$
  select text_state from api.visit_text_states(tests.id('loc_a')) where visit_id = tests.id(p)
$$;
grant execute on function tests.state(text) to authenticated;

select tests.act_as('staff');
select is(tests.state('tnone'), 'none', 'no number: none');
select is(tests.state('toff'), 'no_consent', 'a number without consent: no_consent');
select is(tests.state('ton'), 'on', 'a granted consent: on');
select is(tests.state('tstop'), 'opted_out', 'a STOP on file: opted_out, whatever else is recorded');
select tests.as_postgres();
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('tc'), 'sms', 'transactional', 'revoked', 'inbound', '1', 'h');
update app.consents set captured_at = now() + interval '1 second' where status = 'revoked' and contact_id = tests.id('tc');
select tests.act_as('staff');
select is(tests.state('ton'), 'no_consent', 'a later revoked consent: no_consent');
select tests.act_as('other_owner');
select is((select count(*)::int from api.visit_text_states(tests.id('loc_a'))), 0, 'org B gets no rows for an org A location');
select tests.as_anon();
select throws_ok($$ select * from api.visit_text_states(gen_random_uuid()) $$, '42501', null, 'anon cannot call it');
select tests.act_as('staff');
select is((select count(*)::int from api.visit_text_states(tests.id('loc_b'))), 0, 'nor does org A staff get org B''s');
select * from finish();
rollback;
