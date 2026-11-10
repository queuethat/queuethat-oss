-- 2P-CRM1 (#184): one guest per contact per org, extra contacts, consent evidence kept.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

-- AC1: a staff add and a later lookup of the same phone land on one guest.
select tests.act_as('staff');
select lives_ok(
  $$ select api.staff_add_visit(tests.id('queue_a'), null, 'Pat', '+14155550777', 1, gen_random_uuid()) $$,
  'staff add a walk-in with a phone');
select tests.as_postgres();
create temp table g1 as
  select o_guest_id as guest_id from private.find_or_create_guest(tests.id('org_a'), 'Pat again', '+14155550777', null, 'staff');
select is((select count(*) from app.guests where org_id = tests.id('org_a') and first_name = 'Pat'), 1::bigint,
  'AC1: one guest exists for that phone');
select is((select v.guest_id from app.visits v where v.guest_phone_e164 = '+14155550777'), (select guest_id from g1),
  'AC1: the visit and the lookup share the guest');

-- AC2: the same number in org B is a different guest and org A is untouched.
create temp table g2 as
  select o_guest_id as guest_id from private.find_or_create_guest(tests.id('org_b'), 'Pat', '+14155550777', 'pat@example.com', 'staff');
select isnt((select guest_id from g2), (select guest_id from g1), 'AC2: org B gets its own guest');
select is((select count(*) from app.guest_contacts where org_id = tests.id('org_a') and value = 'pat@example.com'), 0::bigint,
  'AC2: org A gained no contact');
select is((select count(*) from app.guest_contacts where guest_id = (select guest_id from g2)), 2::bigint,
  'a phone and an email land on one guest');

-- add_guest_contact
select tests.act_as('staff');
select lives_ok(
  $$ select api.add_guest_contact(tests.id('guest_a'), 'email', ' Gina@Example.com ', '00000000-0000-0000-0000-0000000000a1') $$,
  'staff attach an email (trimmed and lower-cased)');
select is((select value from app.guest_contacts where guest_id = tests.id('guest_a') and channel = 'email'), 'gina@example.com',
  'the email is stored normalised');
select is(api.add_guest_contact(tests.id('guest_a'), 'email', 'gina@example.com', '00000000-0000-0000-0000-0000000000a2'),
  (select id from app.guest_contacts where guest_id = tests.id('guest_a') and channel = 'email'),
  'adding a contact the guest has returns it');
select is(api.add_guest_contact(tests.id('guest_a'), 'email', 'x@example.com', '00000000-0000-0000-0000-0000000000a3'),
  api.add_guest_contact(tests.id('guest_a'), 'email', 'x@example.com', '00000000-0000-0000-0000-0000000000a3'),
  'a repeated idempotency key returns the same contact');
select throws_ok(
  $$ select api.add_guest_contact(tests.id('guest_a'), 'phone', '+14155550777', gen_random_uuid()) $$,
  'P0001', 'contact_in_use', 'AC3: a contact on another guest raises contact_in_use');
select throws_ok(
  $$ select api.add_guest_contact(tests.id('guest_a'), 'phone', '123', gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a malformed phone is rejected');

-- AC4: org B staff cannot touch an org A guest or contact.
select tests.act_as('other_owner');
select throws_ok(
  $$ select api.add_guest_contact(tests.id('guest_a'), 'email', 'b@example.com', gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC4: org B cannot add a contact to an org A guest');
select throws_ok(
  $$ select api.remove_guest_contact(tests.id('contact_a')) $$,
  'P0001', 'not_found', 'org B cannot remove an org A contact');

-- remove: consent evidence stays with the link nulled and a hash of the value.
select tests.act_as('staff');
select api.remove_guest_contact(tests.id('contact_a'));
select tests.as_postgres();
select is((select (c.contact_id is null and c.contact_value_sha256 = sha256('+14155550123')) from app.consents c
           where c.id = tests.id('consent_a')), true,
  'the consent row survives with the contact link nulled and the value hashed');

select * from finish();
rollback;
