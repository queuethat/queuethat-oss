-- S4 (#25): outbox and contact rules beyond the RLS matrix.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

select throws_ok(
  $$ insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
     values (tests.id('org_a'), tests.id('visit_a'), 'push', tests.id('push_a'), 'called', 1, 'fixture-a') $$,
  '23505', null, 'a second notification with the same dedupe_key conflicts');

select tests.act_as('staff');
select is((select count(*) from app.notifications where org_id <> tests.id('org_a')), 0::bigint,
  'staff of org A see only org A notifications');
select throws_ok(
  $$ insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
     values (tests.id('org_a'), tests.id('visit_a'), 'push', tests.id('push_a'), 'called', 1, 'by-staff') $$,
  '42501', null, 'staff cannot insert notifications');

select tests.as_service();
select lives_ok(
  $$ update app.notifications set status = 'sent', attempts = 1 where id = tests.id('notification_a') $$,
  'the service role (dispatcher) writes the outbox');

select tests.as_postgres();
select throws_ok(
  $$ insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
     values (tests.id('org_a'), tests.id('guest_a'), 'phone', '415-555-0123', 'staff') $$,
  '23514', null, 'phone contacts must be E.164');
select is((select count(*) from app.notification_templates where org_id is null and trigger in ('called', 'almost_up')),
  12::bigint, 'default called and almost_up templates exist for push, email, console, telegram and sms (English and Spanish)');

select * from finish();
rollback;
