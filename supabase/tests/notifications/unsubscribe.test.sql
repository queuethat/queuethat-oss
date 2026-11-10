-- #479 follow-up: api.unsubscribe_outbox stops one org's mail to an address.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_u'), tests.id('org_a'), tests.id('loc_a'), 'Unsub A', 'U'),
  (tests.new_id('queue_x'), tests.id('org_b'), tests.id('loc_b'), 'Unsub B', 'X');
select tests.new_visit('mine', 'queue_u');
select tests.new_visit('again', 'queue_u');
select tests.new_visit('elsewhere', 'queue_x');
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set guest_email = 'lee+q@example.com' where id = tests.id('mine');
update app.visits set guest_email = 'lee@example.com' where id in (tests.id('again'), tests.id('elsewhere'));
alter table app.visit_events enable trigger enqueue_notifications;
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.new_id('n_mine'), tests.id('org_a'), tests.id('mine'), 'email', tests.id('mine'), 'called', 1, 'u1'),
       (tests.new_id('n_again'), tests.id('org_a'), tests.id('again'), 'email', tests.id('again'), 'called', 1, 'u2'),
       (tests.new_id('n_else'), tests.id('org_b'), tests.id('elsewhere'), 'email', tests.id('elsewhere'), 'called', 1, 'u3');

select tests.as_service();
select lives_ok($$ select api.unsubscribe_outbox(tests.id('n_mine')) $$, 'the service role can unsubscribe');
select lives_ok($$ select api.unsubscribe_outbox(tests.id('n_mine')) $$, 'unsubscribing twice is a no-op');
select throws_ok($$ select api.unsubscribe_outbox(gen_random_uuid()) $$, 'P0001', 'not_found',
  'an unknown row raises not_found');
select tests.as_postgres();

select results_eq($$ select org_id, channel::text, value, reason from app.suppressions where reason = 'stop' and channel = 'email' $$,
  $$ values (tests.id('org_a'), 'email', 'lee@example.com', 'stop') $$,
  'one stop suppression for the canonical address, in the sending org only');

create table tests.jobs of api.outbox_job;
insert into tests.jobs select * from api.claim_outbox(50, 60);
select is((select is_suppressed from tests.jobs where id = tests.id('n_again')), true,
  'the org''s next email to the address, typed differently, is suppressed');
select is((select is_suppressed from tests.jobs where id = tests.id('n_else')), false,
  'cross-tenant: another org still mails the address');

select tests.act_as('staff');
select throws_ok($$ select api.unsubscribe_outbox(tests.id('n_again')) $$, '42501', null,
  'staff cannot call it');
select tests.as_postgres();
set local role anon;
select throws_ok($$ select api.unsubscribe_outbox(tests.id('n_again')) $$, '42501', null,
  'anon cannot call it; only the function holding the link secret can');
reset role;

select is((select count(*)::int from app.notification_templates
           where org_id is null and channel = 'email' and body not like '%[%{unsubscribe_url}]'), 0,
  'every system email template ends with the optional stop link');

select * from finish();
rollback;
