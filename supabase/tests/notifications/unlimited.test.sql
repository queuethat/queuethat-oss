-- 2P-NTF4 (#176): a visit can receive many distinct automated messages and never the same one twice.
-- Audit result: no code path caps notifications per visit (grep of supabase/migrations for a
-- count over app.notifications by visit finds none); the only limits are the dedupe key, the
-- per-queue minimum interval between position/estimate updates, and (phase 3) per-org caps.
begin;
\ir ../helpers/_setup.psql
select plan(8);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, renotify_eta_delta_minutes) values
  (tests.new_id('queue_u'), tests.id('org_a'), tests.id('loc_a'), 'Unlimited', 'U', 20);
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
values (tests.new_id('svc_u'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_u'), 'Cut', 10);
select tests.new_visit(n, 'queue_u') from unnest(array['u1', 'u2', 'u3', 'u4', 'u5']) n;
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set service_id = tests.id('svc_u') where queue_id = tests.id('queue_u');
alter table app.visit_events enable trigger enqueue_notifications;
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
values (tests.id('org_a'), tests.id('u1'), 'https://push.example/u1', 'k', 'a');
delete from app.visit_notify_state where visit_id in (select id from app.visits where queue_id = tests.id('queue_u'));
select private.init_notify_state(id) from app.visits where queue_id = tests.id('queue_u');
create view tests.outbox as
  select n.* from app.notifications n where n.visit_id = tests.id('u1');
grant select on tests.outbox to service_role;

/** Moves u1 to p_key as staff, after the minimum interval since its last update. */
create function tests.move(p_key numeric) returns void language plpgsql as $$
begin
  update app.visit_notify_state set last_notified_at = now() - interval '1 hour' where visit_id = tests.id('u1');
  perform private.set_actor('staff', tests.id('staff'));
  update app.visits set sort_key = p_key where id = tests.id('u1');
end $$;

-- Six updates: back, front, back, front, back, front.
select tests.move(100000);
select tests.move(0);
select tests.move(100000);
select tests.move(0);
select tests.move(100000);
select tests.move(0);
select is((select count(*)::int from tests.outbox where template_key in ('position_changed', 'eta_changed')), 6,
  'six estimate updates, each after the minimum interval, are six messages');

select tests.act_as('staff');
select api.call_next(tests.id('queue_u'), tests.id('counter_a'), gen_random_uuid());
select api.transition_visit(tests.id('u1'), 'recall', (select version from app.visits where id = tests.id('u1')), gen_random_uuid());
select tests.as_postgres();

select is((select count(*)::int from tests.outbox where template_key = 'almost_up'), 1, 'one almost_up for the visit');
select is((select count(*)::int from tests.outbox where template_key = 'called'), 2, 'a call and a recall are two called messages');
select is((select count(*)::int from tests.outbox), 9,
  'AC1: nine automated messages for one visit and one recipient (no joined or served message exists yet)');
select is((select count(distinct dedupe_key)::int from tests.outbox), 9, 'AC1: no dedupe key repeats');

-- Replaying the same events enqueues nothing new.
select private.enqueue_notification(
  (select v from app.visits v where v.id = tests.id('u1')),
  (select max(id) from app.visit_events where visit_id = tests.id('u1') and type = 'call'), 'called',
  'e' || (select max(id) from app.visit_events where visit_id = tests.id('u1') and type = 'call'));
select is((select count(*)::int from tests.outbox where template_key = 'called'), 2, 'AC2: replaying the call enqueues nothing');
select private.enqueue_notification(
  (select v from app.visits v where v.id = tests.id('u1')),
  (select max(id) from app.visit_events where visit_id = tests.id('u1') and type = 'recall'), 'called',
  'e' || (select max(id) from app.visit_events where visit_id = tests.id('u1') and type = 'recall'));
select is((select count(*)::int from tests.outbox), 9, 'AC2: replaying the recall enqueues nothing either');
select is((select count(*)::int from tests.outbox where dedupe_key like 'renotify:%'), 6,
  'every update is keyed by its own event');

select * from finish();
rollback;
