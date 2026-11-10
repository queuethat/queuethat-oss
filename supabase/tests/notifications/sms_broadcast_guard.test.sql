-- #1202 (messaging review M2): "Message everyone" does not go out by SMS over the shared number unless
-- the deployment switches it on, and then promotional-looking text is refused.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
select tests.new_id('k1');

select is(private.sms_broadcast_allowed(tests.id('org_a')), true, 'an org with no platform SMS is not restricted');
insert into app.provider_settings (org_id, channel, provider, mode, enabled)
values (tests.id('org_a'), 'sms', 'twilio', 'platform', true);
select is(private.sms_broadcast_allowed(tests.id('org_a')), false, 'an org sending over the platform number is blocked by default');
select is(private.sms_broadcast_allowed(tests.id('org_b')), true, 'another tenant is unaffected');

-- The SMS leg of a broadcast: a staff-added contact is a recipient for alerts but not for broadcast.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_a'), tests.id('loc_a'), 'Bcast', 'B');
select tests.new_visit('b1', 'queue_b');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source, verified_at) values
  (tests.new_id('phone_b1'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550177', 'staff', now());
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set contact_id = tests.id('phone_b1'), guest_id = tests.id('guest_a') where id = tests.id('b1');
alter table app.visit_events enable trigger enqueue_notifications;
select is((select count(*)::int from private.visit_recipients((select v from app.visits v where v.id = tests.id('b1')), 'broadcast') r
           where r.channel = 'sms'), 0, 'no SMS recipient for a broadcast over the platform number');
select is((select count(*)::int from private.visit_recipients((select v from app.visits v where v.id = tests.id('b1')), 'called') r
           where r.channel = 'sms'), 1, 'but the guest still gets their own alerts');

update private.deployment_settings set platform_sms_broadcast_enabled = true;
select is(private.sms_broadcast_allowed(tests.id('org_a')), true, 'the deployment switch turns it on');
select is((select count(*)::int from private.visit_recipients((select v from app.visits v where v.id = tests.id('b1')), 'broadcast') r
           where r.channel = 'sms'), 1, 'and the contact is a broadcast recipient');

-- Content screen.
select is(private.broadcast_promo_like('20% off all cuts today'), true, 'percent and off');
select is(private.broadcast_promo_like('Big sale, visit www.example.com'), true, 'sale and a link');
select is(private.broadcast_promo_like('We are running 15 minutes behind, thank you for waiting.'), false, 'a service message passes');

select tests.act_as('manager');
select throws_ok($$ select api.send_queue_message(tests.id('queue_b'), 'Half price coupon today', tests.id('k1')) $$,
  'P0001', 'invalid_input', 'a promotional body is refused when platform SMS broadcast is on');
select lives_ok($$ select api.send_queue_message(tests.id('queue_b'), 'Running 15 minutes behind.', gen_random_uuid()) $$,
  'a plain service message is accepted');
select tests.as_postgres();
update private.deployment_settings set platform_sms_broadcast_enabled = false;
select tests.act_as('manager');
select lives_ok($$ select api.send_queue_message(tests.id('queue_b'), 'Half price coupon today', gen_random_uuid()) $$,
  'with the switch off nothing goes out by SMS, so the screen has nothing to guard');
select tests.as_postgres();

select * from finish();
rollback;
