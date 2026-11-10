-- N2 (#68): notifications enqueued from visit events, outbox_still_relevant, dispatcher kicks.
begin;
\ir ../helpers/_setup.psql
select plan(26);
-- The local seed configures a dispatcher (01_local_dispatcher.sql); these asserts start from none.
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
delete from net.http_request_queue;
select tests.create_world();

-- queue_n: n1..n4 waiting. n1 has an email contact and a push subscription, n2 a phone contact,
-- n3 and n4 a push subscription. Org B gets the same shape for the cross-tenant case.
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_n'), tests.id('org_a'), tests.id('loc_a'), 'Notify', 'N'),
  (tests.new_id('queue_nb'), tests.id('org_b'), tests.id('loc_b'), 'Notify B', 'B');
select tests.new_visit(n, 'queue_n') from unnest(array['n1', 'n2', 'n3', 'n4']) n;
select tests.new_visit('b1', 'queue_nb');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('email_n1'), tests.id('org_a'), tests.id('guest_a'), 'email', 'n1@example.com', 'online'),
  (tests.new_id('phone_n2'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550124', 'online');
-- Attaching contacts is a visit edit; keep it from enqueueing so the cases below start clean.
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set contact_id = tests.id('email_n1'), guest_id = tests.id('guest_a') where id = tests.id('n1');
update app.visits set contact_id = tests.id('phone_n2'), guest_id = tests.id('guest_a') where id = tests.id('n2');
alter table app.visit_events enable trigger enqueue_notifications;
insert into app.push_subscriptions (id, org_id, visit_id, endpoint, p256dh, auth) values
  (tests.new_id('push_n1'), tests.id('org_a'), tests.id('n1'), 'https://push.example/n1', 'k', 'a'),
  (tests.new_id('push_n3'), tests.id('org_a'), tests.id('n3'), 'https://push.example/n3', 'k', 'a'),
  (tests.new_id('push_n4'), tests.id('org_a'), tests.id('n4'), 'https://push.example/n4', 'k', 'a'),
  (tests.new_id('push_b1'), tests.id('org_b'), tests.id('b1'), 'https://push.example/b1', 'k', 'a');
-- An org A override for almost_up push, so the version tells which template was used.
insert into app.notification_templates (org_id, trigger, channel, body, version)
values (tests.id('org_a'), 'almost_up', 'push', 'Org A: {ticket}', 7);

create view tests.outbox as
  select n.*, (select t.name from tests.ids t where t.id = n.visit_id) as visit
  from app.notifications n where n.dedupe_key <> 'fixture-a';
grant select on all tables in schema tests to authenticated;

select is(column_default, '2', 'queues.almost_up_threshold defaults to 2')
from information_schema.columns
where table_schema = 'app' and table_name = 'queues' and column_name = 'almost_up_threshold';
select is((select count(*)::int from tests.outbox), 0,
  'joins enqueue nothing');

------------------------------------------------------------------------------------------------
-- called
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select api.call_next(tests.id('queue_n'), tests.id('counter_a'), gen_random_uuid());
select tests.as_postgres();

select results_eq($$ select channel::text, recipient_ref, template_version, category::text, status::text, vars
                     from tests.outbox where visit = 'n1' and template_key = 'called' order by channel $$,
  $$ values ('email', tests.id('email_n1'), 3, 'transactional', 'queued', '{"ticket": "N001", "counter": "Chair 1"}'::jsonb),
            ('push', tests.id('push_n1'), 1, 'transactional', 'queued', '{"ticket": "N001", "counter": "Chair 1"}'::jsonb) $$,
  'a call queues one called row per recipient (push and email) with the snapshotted ticket and counter');
select is((select array_agg(distinct event_id) from tests.outbox where visit = 'n1'),
  (select array_agg(id) from app.visit_events where visit_id = tests.id('n1') and type = 'call'),
  'called rows point at the call event');
select is((select dedupe_key from tests.outbox where visit = 'n1' and channel = 'push'),
  format('e%s:push:%s', (select max(id) from app.visit_events where visit_id = tests.id('n1')), tests.id('push_n1')),
  'dedupe_key = event:channel:recipient');
select is((select count(*)::int from tests.outbox where visit = 'n1' and template_key = 'almost_up'), 0,
  'the called guest gets no almost_up');

------------------------------------------------------------------------------------------------
-- almost_up (AC1)
------------------------------------------------------------------------------------------------
select results_eq($$ select visit, channel::text, template_version from tests.outbox
                     where template_key = 'almost_up' order by visit $$,
  $$ values ('n3', 'push', 7) $$,
  'n2 (1st, an unverified online phone) and n3 (2nd, push) are in range; only n3 has a recipient, with the org template');
select is((select count(*)::int from tests.outbox where visit = 'n4'), 0,
  'n4 in 3rd place gets nothing');

-- Reorder n3 behind n4 and back again (no reorder RPC yet: a non-status edit as staff).
select private.set_actor('staff', tests.id('staff'));
update app.visits set sort_key = 1000000 where id = tests.id('n3');
update app.visits set sort_key = 3 * 1024 where id = tests.id('n3');
select is((select count(*)::int from tests.outbox where visit = 'n3' and template_key = 'almost_up'), 1,
  'AC1: exactly one almost_up row for the 2nd in line, even after reorder back and forth');
select is((select count(*)::int from tests.outbox where visit = 'n4' and template_key = 'almost_up'), 1,
  'n4 got its own almost_up while it was 2nd during the reorder');

-- Threshold is per queue.
update app.queues set almost_up_threshold = 1 where id = tests.id('queue_nb');
select tests.new_visit('b2', 'queue_nb');
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
values (tests.id('org_b'), tests.id('b2'), 'https://push.example/b2', 'k', 'a');
select private.set_actor('staff', tests.id('other_owner'), 'cancel');
update app.visits set status = 'cancelled', finished_at = now() where id = tests.id('b1');
select results_eq($$ select visit, template_version from tests.outbox where template_key = 'almost_up' and org_id = tests.id('org_b') $$,
  $$ values ('b2', 1) $$,
  'with threshold 1 only the new first in line is messaged, using the system template, not org A''s');
select is((select count(*)::int from tests.outbox where org_id <> (select org_id from app.visits where id = visit_id)), 0,
  'every row belongs to its visit''s org');

------------------------------------------------------------------------------------------------
-- SMS is template-gated; recall messages again
------------------------------------------------------------------------------------------------
insert into app.notification_templates (org_id, trigger, channel, body)
values (tests.id('org_a'), 'called', 'sms', 'Your turn {ticket}');
-- A typed-in phone is texted only once verified (private.visit_recipients).
update app.guest_contacts set verified_at = now() where id = tests.id('phone_n2');
select tests.act_as('staff');
select api.transition_visit(tests.id('n2'), 'call', (select version from app.visits where id = tests.id('n2')), gen_random_uuid());
select tests.as_postgres();
select results_eq($$ select channel::text, recipient_ref from tests.outbox where visit = 'n2' and template_key = 'called' $$,
  $$ values ('sms', tests.id('phone_n2')) $$,
  'once an sms template exists, a phone contact gets an sms row');

select tests.act_as('staff');
select api.transition_visit(tests.id('n1'), 'recall', (select version from app.visits where id = tests.id('n1')), gen_random_uuid());
select tests.as_postgres();
select is((select count(*)::int from tests.outbox where visit = 'n1' and template_key = 'called'), 4,
  'a recall queues a new called row per recipient');

------------------------------------------------------------------------------------------------
-- outbox_still_relevant (AC2)
------------------------------------------------------------------------------------------------
create table tests.picks as
  select 'n1_first' as name, (select id from tests.outbox where visit = 'n1' and channel = 'push' order by event_id limit 1) as id
  union all select 'n1_recall', (select id from tests.outbox where visit = 'n1' and channel = 'push' order by event_id desc limit 1)
  union all select 'n2_called', (select id from tests.outbox where visit = 'n2' and template_key = 'called')
  union all select 'n3_almost', (select id from tests.outbox where visit = 'n3' and template_key = 'almost_up');
grant select on tests.picks to service_role;

select tests.as_service();
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n2_called')), true,
  'a pending called row is relevant while the call stands');
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n1_first')), false,
  'a called row superseded by a recall is not relevant');
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n1_recall')), true,
  'the recall''s row is');
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n3_almost')), true,
  'almost_up is relevant while the guest waits');
select is(api.outbox_still_relevant(gen_random_uuid()), false, 'an unknown id is not relevant');
select tests.as_postgres();

-- Undo the call of n2 the way api.undo_event (V3) does: restore the status, mark the event undone.
select private.set_actor('staff', tests.id('staff'), 'undo');
update app.visits set status = 'waiting', counter_id = null, called_at = null where id = tests.id('n2');
update app.visit_events set undone_by_event_id = (select max(id) from app.visit_events where visit_id = tests.id('n2'))
where id = (select max(id) from app.visit_events where visit_id = tests.id('n2') and type = 'call');
-- n3 is called, n1 finishes.
select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where id = tests.id('n3');
select private.set_actor('staff', tests.id('staff'), 'cancel');
update app.visits set status = 'cancelled' where id = tests.id('n1');

select tests.as_service();
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n2_called')), false,
  'AC2: after the call is undone, the pending called row is not relevant');
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n3_almost')), false,
  'almost_up after the guest was called is not relevant');
select is(api.outbox_still_relevant((select id from tests.picks where name = 'n1_recall')), false,
  'nothing is relevant for a finished visit');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- Dispatcher kicks
------------------------------------------------------------------------------------------------
select is((select count(*)::int from net.http_request_queue), 0,
  'without a dispatcher_url secret nothing is kicked');
select vault.create_secret('http://dispatcher.test/kick', 'dispatcher_url');
select private.set_actor('staff', tests.id('staff'), 'requeue');
update app.visits set status = 'waiting', counter_id = null where id = tests.id('n3');
select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where id = tests.id('n3');
select results_eq($$ select url, method::text from net.http_request_queue $$,
  $$ values ('http://dispatcher.test/kick', 'POST') $$,
  'enqueues kick the dispatcher once per transaction');
select is(ops.kick_dispatcher_if_due(), true, 'the 15 s job kicks while rows are due');
select is((select schedule from cron.job where jobname = 'kick-dispatcher'), '15 seconds',
  'pg_cron re-kicks every 15 seconds');

select * from finish();
rollback;
