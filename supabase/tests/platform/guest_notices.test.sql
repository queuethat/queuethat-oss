-- C10 (#1276): the owner-approved guest breach notice (draft, approve, send through the outbox).
begin;
\ir ../helpers/_setup.psql
select plan(34);
select tests.create_world();

create table tests.keep (name text primary key, id uuid);
grant all on tests.keep to authenticated;

-- Org A's guest Gina, with an email contact, visited now; a second guest visited long ago.
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('email_a'), tests.id('org_a'), tests.id('guest_a'), 'email', 'gina@example.test', 'online');
update app.visits set guest_id = tests.id('guest_a') where id = tests.id('visit_a');
insert into app.guests (id, org_id, first_name) values (tests.new_id('guest_old'), tests.id('org_a'), 'Olga');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('email_old'), tests.id('org_a'), tests.id('guest_old'), 'email', 'olga@example.test', 'online');
-- C10b: guests whose only email was typed at join or booking (no contact record) are in the audience too.
-- 'gina+news@example.test' on a second visit is the same canonical address as her contact: one message.
select tests.new_visit('visit_typed', 'queue_a');
update app.visits set guest_email = 'typed@example.test' where id = tests.id('visit_typed');
select tests.new_visit('visit_dup', 'queue_a');
update app.visits set guest_email = 'gina+news@example.test' where id = tests.id('visit_dup');
insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                              guest_name, guest_email, source, idempotency_key)
values (tests.new_id('appt_typed'), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now(), now() + interval '20 minutes', current_date, 'Bea', 'booked@example.test', 'guest', gen_random_uuid());
-- Another business's guest with a typed email in the same window is never in org A's audience.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other', 'B');
select tests.new_visit('visit_b', 'queue_b');
update app.visits set guest_email = 'other@example.test' where id = tests.id('visit_b');
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'test-location-a2', 'Europe/Berlin');
insert into tests.keep select 'log', id from app.org_incident_log where title = 'fixture incident log';

-- ------------------------------------------------------------------ admin drafts, only an owner approves
select tests.act_as('admin');
select lives_ok($$ insert into tests.keep select 'n', id from api.save_guest_notice((select id from tests.keep where name = 'log'),
  'Please read', 'We found a problem with our systems.', now() - interval '1 hour', now() + interval '1 hour') $$,
  'an admin drafts a notice');
select results_eq($$ select status, recipient_count from api.list_guest_notices((select id from tests.keep where name = 'log')) $$,
  $$ values ('draft', 3) $$, 'it counts guests in the window by contact, typed join email and typed booking email, one per address, not who');
select throws_ok($$ select api.approve_guest_notice((select id from tests.keep where name = 'n')) $$, 'P0001', 'not_found',
  'an admin cannot approve');
select throws_ok($$ select api.send_guest_notice((select id from tests.keep where name = 'n')) $$, 'P0001', 'not_found',
  'an admin cannot send');
select tests.act_as('owner');
select throws_ok($$ select api.send_guest_notice((select id from tests.keep where name = 'n')) $$, 'P0001', 'invalid_input',
  'a draft is never sent');
select lives_ok($$ select api.approve_guest_notice((select id from tests.keep where name = 'n')) $$, 'an owner approves it');
select is((select status from api.save_guest_notice((select id from tests.keep where name = 'log'), 'Please read, edited', 'Edited text',
  now() - interval '1 hour', now() + interval '1 hour')), 'draft', 'an edit after approval returns it to draft');
select is((select count(*)::int from app.notifications where template_key = 'guest_incident_notice'), 0, 'nothing is queued before a send');
select lives_ok($$ select api.approve_guest_notice((select id from tests.keep where name = 'n')) $$, 'approved again');

-- ------------------------------------------------------------------ send
select lives_ok($$ select api.send_guest_notice((select id from tests.keep where name = 'n')) $$, 'an owner sends it');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'guest_incident_notice' and recipient_ref = tests.id('email_a')),
  1, 'the guest in the window is queued once');
select is((select count(*)::int from app.notifications where template_key = 'guest_incident_notice'), 3,
  'one row per distinct address: contact, typed join email, typed booking email; nobody outside the window or the business');
select is((select array_agg(private.canonical_email(private.notification_address('email', null, recipient_ref, org_id)) order by 1)
           from app.notifications where template_key = 'guest_incident_notice'),
  array['booked@example.test', 'gina@example.test', 'typed@example.test'], 'each resolves to the guest''s own typed address');
select is((select vars ->> 'notice_body' from app.notifications where template_key = 'guest_incident_notice' limit 1), 'Edited text',
  'the message is the owner''s text');
select is((select private.notification_address('email', null, recipient_ref, org_id) from app.notifications
  where template_key = 'guest_incident_notice' and recipient_ref = tests.id('email_a')), 'gina@example.test',
  'a contact resolves to the guest''s own address');
select ok(exists (select 1 from app.audit_log where table_name = 'guest_notices' and action = 'UPDATE'), 'the send is audited');
select api.unsubscribe_outbox((select id from app.notifications where template_key = 'guest_incident_notice' and recipient_ref = tests.id('email_a')));
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = 'gina@example.test'), 1,
  'the stop link in the notice suppresses the guest''s address for this business');
select api.unsubscribe_outbox((select id from app.notifications where template_key = 'guest_incident_notice' and recipient_ref = tests.id('visit_typed')));
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = 'typed@example.test'), 1,
  'the stop link works for an address typed at join');
select api.unsubscribe_outbox((select id from app.notifications where template_key = 'guest_incident_notice' and recipient_ref = tests.id('email_a')));
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = 'gina@example.test'), 1,
  'stopping twice changes nothing');
select tests.act_as('owner');
select lives_ok($$ select api.send_guest_notice((select id from tests.keep where name = 'n')) $$, 'sending again is a no-op');
select results_eq($$ select status, recipient_count from api.list_guest_notices((select id from tests.keep where name = 'log')) $$,
  $$ values ('sent', 3) $$, 'a sent notice keeps its count');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'guest_incident_notice'), 3, 'nothing is queued twice');

-- ------------------------------------------------------------------ limits
select tests.act_as('owner');
select throws_ok($$ select api.save_guest_notice((select id from tests.keep where name = 'log'), 'x', 'y', now(), now() - interval '1 day') $$,
  'P0001', 'invalid_input', 'an empty window is invalid');
select lives_ok($$ insert into tests.keep select 'n2', id from api.save_guest_notice((select id from tests.keep where name = 'log'),
  'Second', 'Second text', now() - interval '3 days', now() - interval '2 days') $$, 'a second notice for an old window');
select lives_ok($$ select api.approve_guest_notice((select id from tests.keep where name = 'n2')) $$, 'approved');
select throws_ok($$ select api.send_guest_notice((select id from tests.keep where name = 'n2')) $$, 'P0001', 'invalid_input',
  'a window with no guests sends nothing');

-- The location filter narrows the audience: another location of the business has none of these guests.
select tests.act_as('owner');
select results_eq($$ select recipient_count from api.save_guest_notice((select id from tests.keep where name = 'log'), 'Third', 'Third text',
  now() - interval '1 hour', now() + interval '1 hour', tests.id('loc_a2')) $$, $$ values (0) $$,
  'a location with no guests in the window reaches nobody');
select results_eq($$ select recipient_count from api.save_guest_notice((select id from tests.keep where name = 'log'), 'Third', 'Third text',
  now() - interval '1 hour', now() + interval '1 hour', tests.id('loc_a')) $$, $$ values (3) $$,
  'the location the guests visited or booked at reaches all three');
select throws_ok($$ select api.save_guest_notice((select id from tests.keep where name = 'log'), 'x', 'y',
  now() - interval '1 hour', now() + interval '1 hour', tests.id('loc_b')) $$, '23503', null,
  'another business''s location is refused');

-- ------------------------------------------------------------------ other roles and tenants
select tests.act_as('manager');
select throws_ok($$ select * from api.list_guest_notices((select id from tests.keep where name = 'log')) $$, 'P0001', 'not_found', 'a manager reads nothing');
select is((select count(*)::int from app.guest_notices), 0, 'and sees no rows');
select tests.act_as('other_owner');
select throws_ok($$ select api.send_guest_notice((select id from tests.keep where name = 'n2')) $$, 'P0001', 'not_found',
  'another business''s owner cannot send it');
select throws_ok($$ select * from api.save_guest_notice((select id from tests.keep where name = 'log'), 'x', 'y', now() - interval '1 day', now()) $$,
  'P0001', 'not_found', 'nor draft against its log');
select tests.as_anon();
select throws_ok($$ select api.send_guest_notice(gen_random_uuid()) $$, '42501', null, 'anon cannot call it');

select * from finish();
rollback;
