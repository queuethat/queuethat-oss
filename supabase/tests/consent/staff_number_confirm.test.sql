-- #1204 (messaging review M3): over the deployment's shared number a staff-typed number gets one
-- confirmation text and no alerts until its owner has confirmed it. The YES reply was handled by the
-- hosted service's shared-number webhook, which this build does not have (and the shared sender
-- cannot be switched on here, see providers/platform_twilio.test.sql), so only the sending side is
-- covered: one text, capped, and nothing to an unconfirmed number.
begin;
\ir ../helpers/_setup.psql
select plan(11);
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

-- Once the text has gone out the number still gets no alerts: only its owner's reply confirms it.
update app.notifications set status = 'sent', sent_at = now() where template_key = 'reply_confirm_number';
select is((select count(*)::int from private.visit_recipients((select v from app.visits v where v.id = tests.id('sv')), 'called') r
           where r.channel = 'sms'), 0, 'a sent confirmation text alone confirms nothing');

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

select * from finish();
rollback;
