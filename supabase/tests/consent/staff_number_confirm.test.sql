-- #1204 (messaging review M3): over the shared number a staff-typed number is texted only after its
-- owner replies YES to a one-time confirmation.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();
select tests.new_id(n) from unnest(array['k1', 'k2']) n;

insert into app.provider_settings (org_id, channel, provider, mode, enabled) values
  (tests.id('org_a'), 'sms', 'twilio', 'platform', true);
select tests.new_visit('sv', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550177' where id = tests.id('sv');

select tests.act_as('staff');
select lives_ok($$ select api.staff_capture_consent(tests.id('sv'), 'sms', true, 1, tests.id('k1')) $$, 'staff attest the number');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'reply_confirm_number' and channel = 'sms'), 1,
  'one confirmation text is queued through the outbox');
select is((select count(distinct dedupe_key)::int from app.notifications where template_key = 'reply_confirm_number'), 1, 'one per contact per day');
select is((select count(*)::int from private.visit_recipients((select v from app.visits v where v.id = tests.id('sv')), 'called') r
           where r.channel = 'sms'), 0, 'until it is confirmed the number gets no alerts');

select tests.act_as('staff');
select lives_ok($$ select api.staff_capture_consent(tests.id('sv'), 'sms', true, 1, tests.id('k2')) $$, 'attesting again');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'reply_confirm_number'), 1, 'does not text it twice');

-- A YES from a different number, or before the confirmation went out, confirms nothing.
select tests.as_service();
select ok(not api.apply_platform_sms_event('confirm', '+14155550177'), 'a YES before the confirmation was sent confirms nothing');
select tests.as_postgres();
update app.notifications set status = 'sent', sent_at = now() where template_key = 'reply_confirm_number';
select tests.as_service();
select ok(not api.apply_platform_sms_event('confirm', '+14155550199'), 'a YES from another number confirms nothing');
select ok(api.apply_platform_sms_event('confirm', '+14155550177'), 'a YES from the number we asked confirms it');
select throws_ok($$ select api.apply_platform_sms_event('confirm', 'not-a-phone') $$, 'P0001', 'invalid_input', 'a malformed number is refused');
select tests.as_postgres();
select is((select count(*)::int from private.visit_recipients((select v from app.visits v where v.id = tests.id('sv')), 'called') r
           where r.channel = 'sms'), 1, 'after YES the number receives alerts');

-- Caps: 2 per number per day across orgs, 20 per org per hour.
insert into app.guests (id, org_id, first_name) values (tests.new_id('gc2'), tests.id('org_a'), 'C');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
select tests.new_id('cc' || i), tests.id('org_a'), tests.id('gc2'), 'phone', '+1415555' || (1000 + i), 'staff' from generate_series(1, 21) i;
insert into app.notifications (org_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
select tests.id('org_a'), 'sms', tests.id('cc' || i), 'reply_confirm_number', 1, 'transactional', 'cap:' || i from generate_series(1, 20) i;
select tests.new_visit('cv', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155559999' where id = tests.id('cv');
select tests.act_as('staff');
select lives_ok($$ select api.staff_capture_consent(tests.id('cv'), 'sms', true, 1, gen_random_uuid()) $$, 'an attestation over the org hourly cap still succeeds');
select tests.as_postgres();
select is((select count(*)::int from app.notifications n join app.guest_contacts c on c.id = n.recipient_ref
           where n.template_key = 'reply_confirm_number' and c.value = '+14155559999'), 0, 'but sends no confirmation text');

-- Another tenant's identical number is not confirmed by it, and an own-provider org is unaffected.
insert into app.guests (id, org_id, first_name) values (tests.new_id('gb'), tests.id('org_b'), 'B');
insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
values (tests.id('org_b'), tests.id('gb'), 'phone', '+14155550177', 'staff');
select is((select verified_at is null from app.guest_contacts where org_id = tests.id('org_b') and value = '+14155550177'), true,
  'org B''s contact for the same number stays unverified');
select is(private.platform_sms_mode(tests.id('org_b')), false, 'org B does not send over the platform number');

select tests.act_as('anon');
select throws_ok($$ select api.apply_platform_sms_event('confirm', '+14155550177') $$, '42501', null, 'anon cannot call it');
select tests.as_postgres();

select * from finish();
rollback;
