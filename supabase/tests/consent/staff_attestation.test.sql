-- 3-CG3 (#328): staff attest that a guest agreed to texts; nothing else creates staff consent.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
select tests.new_id(n) from unnest(array['k1', 'k2', 'k3', 'k4']) n;

select tests.new_visit('sv', 'queue_a');
select tests.new_visit('sv2', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550177' where id = tests.id('sv');
update app.visits set guest_phone_e164 = '+14155550999' where id = tests.id('sv2'); -- suppressed in the fixture

create function tests.capture(p_visit text, p_attested boolean, p_key text default 'k1', p_channel text default 'sms')
returns api.consent_row language sql as $$
  select api.staff_capture_consent(tests.id(p_visit), p_channel, p_attested, 1, tests.id(p_key))
$$;
grant execute on function tests.capture(text, boolean, text, text) to authenticated;

select tests.act_as('staff');
select throws_ok($$ select tests.capture('sv', false) $$, 'P0001', 'attestation_required', 'AC1: not attested is refused');
select tests.as_postgres();
select is((select count(*)::int from app.consents where source = 'staff'), 0, 'AC1: and no consent row exists');

select tests.act_as('staff');
select throws_ok($$ select tests.capture('sv2', true, 'k2') $$, 'P0001', 'contact_suppressed', 'AC2: an opted-out number cannot be re-consented by staff');
select results_eq($$ select (r).channel, (r).purpose, (r).status from (select tests.capture('sv', true) r) s $$,
  $$ values ('sms', 'transactional', 'granted') $$, 'a transactional consent is granted');
select tests.as_postgres();
select results_eq($$ select c.source, c.captured_by_user_id = tests.id('staff'), c.attested_at is not null, c.attestation_text_version
  from app.consents c where c.source = 'staff' $$, $$ values ('staff', true, true, 1) $$, 'it records who attested, when and which text version');
select is((select v.contact_id is not null and gc.value = '+14155550177'
  from app.visits v join app.guest_contacts gc on gc.id = v.contact_id where v.id = tests.id('sv')), true,
  'the visit''s phone became a contact the dispatcher can use');

select tests.act_as('staff');
select lives_ok($$ select tests.capture('sv', true) $$, 'AC5: the same key again');
select lives_ok($$ select tests.capture('sv', true, 'k3') $$, 'a new key for the same contact');
select tests.as_postgres();
select is((select count(*)::int from app.consents where source = 'staff'), 1, 'AC5: still one consent row');

select throws_ok($$ insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  values (tests.id('org_a'), tests.id('contact_a'), 'sms', 'transactional', 'granted', 'staff', '1', 'h') $$,
  '23514', null, 'AC3: a staff consent without attestation violates the CHECK');

select tests.act_as('staff');
select throws_ok($$ select tests.capture('sv', true, 'k4', 'push') $$, 'P0001', 'invalid_input', 'only sms and whatsapp can be attested');
select tests.act_as('other_owner');
select throws_ok($$ select tests.capture('sv', true, 'k4') $$, 'P0001', 'not_found', 'AC4: org B on an org A visit gets not_found');
select tests.as_anon();
select throws_ok($$ select tests.capture('sv', true, 'k4') $$, '42501', null, 'anon cannot call it');

select * from finish();
rollback;
