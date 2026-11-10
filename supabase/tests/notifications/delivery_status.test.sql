-- N6 (#256): delivery status reads and retry.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_d'), tests.id('org_a'), tests.id('loc_a'), 'Delivery', 'D');
select tests.new_visit('dv', 'queue_d');
update app.visits set guest_email = 'secret@example.com' where id = tests.id('dv');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key, status, attempts, error_code)
values (tests.new_id('n_dead'), tests.id('org_a'), tests.id('dv'), 'email', tests.id('dv'), 'almost_up', 1, 'd1', 'dead', 6, 'http_500'),
       (tests.new_id('n_sent'), tests.id('org_a'), tests.id('dv'), 'push', tests.id('dv'), 'almost_up', 1, 'd2', 'sent', 1, null);

select tests.act_as('staff');
select is((select count(*)::int from api.list_visit_notifications(tests.id('dv')) where id in (tests.id('n_dead'), tests.id('n_sent'))), 2, 'staff list the visit''s messages');
select is((select to_jsonb(s)::text !~ 'secret@example.com' from api.list_visit_notifications(tests.id('dv')) s limit 1), true,
  'no address or body appears');
select is((select count(*)::int from api.list_failed_notifications(tests.id('loc_a'), now() - interval '1 hour')), 1, 'the failed list holds the dead message');
select throws_ok($$ select api.retry_notification(tests.id('n_dead'), gen_random_uuid()) $$, 'P0001', 'not_found', 'staff cannot retry (manager+)');

select tests.act_as('other_owner');
select throws_ok($$ select * from api.list_visit_notifications(tests.id('dv')) $$, 'P0001', 'not_found', 'another org cannot list');
select throws_ok($$ select * from api.list_failed_notifications(tests.id('loc_a'), null) $$, 'P0001', 'not_found', 'another org cannot list failures');
select throws_ok($$ select api.retry_notification(tests.id('n_dead'), gen_random_uuid()) $$, 'P0001', 'not_found', 'another org cannot retry');

select tests.as_postgres();
select tests.new_visit('dv2', 'queue_d');
select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where id = tests.id('dv2');
select private.set_actor('staff', tests.id('staff'), 'no_show');
update app.visits set status = 'no_show' where id = tests.id('dv2');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key, status)
values (tests.new_id('n_old'), tests.id('org_a'), tests.id('dv2'), 'push', tests.id('dv2'), 'almost_up', 1, 'd3', 'dead');
select tests.act_as('owner');
select throws_ok($$ select api.retry_notification(tests.id('n_old'), gen_random_uuid()) $$, 'P0001', 'not_relevant',
  'an almost_up for a visit that is not waiting is not relevant');
select is((select (api.retry_notification(tests.id('n_dead'), gen_random_uuid())).status), 'queued', 'a relevant dead message is requeued');
select is((select (api.retry_notification(tests.id('n_dead'), gen_random_uuid())).status), 'queued', 'asking again changes nothing');
select tests.as_postgres();
select is((select attempts from app.notifications where id = tests.id('n_dead')), 0, 'attempts were reset');

select * from finish();
rollback;
