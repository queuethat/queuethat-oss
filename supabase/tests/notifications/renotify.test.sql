-- 2P-NTF3 (#175): position and estimate updates when they move past the queue's thresholds.
begin;
\ir ../helpers/_setup.psql
select plan(24);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();

-- queue_r: r1..r6 waiting, all a 10 minute service, each with a push subscription. Org B has one
-- visit for the cross-tenant case. The eta threshold is raised so only big moves cross it.
delete from app.business_hours where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, renotify_eta_delta_minutes) values
  (tests.new_id('queue_r'), tests.id('org_a'), tests.id('loc_a'), 'Renotify', 'R', 40),
  (tests.new_id('queue_rb'), tests.id('org_b'), tests.id('loc_b'), 'Renotify B', 'B', 40);
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes) values
  (tests.new_id('svc_r'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_r'), 'Cut', 10),
  (tests.new_id('svc_rb'), tests.id('org_b'), tests.id('loc_b'), tests.id('queue_rb'), 'Cut', 10);
select tests.new_visit(n, 'queue_r') from unnest(array['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) n;
select tests.new_visit('rb1', 'queue_rb');
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set service_id = tests.id('svc_r') where queue_id = tests.id('queue_r');
update app.visits set service_id = tests.id('svc_rb') where queue_id = tests.id('queue_rb');
alter table app.visit_events enable trigger enqueue_notifications;
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
select v.org_id, v.id, 'https://push.example/' || i.name, 'k', 'a'
from app.visits v join tests.ids i on i.id = v.id where i.name like 'r%';
delete from app.visit_notify_state where visit_id in (select id from app.visits where queue_id in (tests.id('queue_r'), tests.id('queue_rb')));
select private.init_notify_state(id) from app.visits where queue_id in (tests.id('queue_r'), tests.id('queue_rb'));
create view tests.outbox as
  select n.*, (select t.name from tests.ids t where t.id = n.visit_id) as visit
  from app.notifications n where n.dedupe_key <> 'fixture-a' and n.template_key in ('position_changed', 'eta_changed');
grant select on tests.outbox to authenticated, service_role;
/** Moves a visit to sort_key p_key as staff, the way a reorder will (event type edit). */
create function tests.reorder(p_name text, p_key numeric) returns void language plpgsql as $$
begin
  perform private.set_actor('staff', tests.id('staff'));
  update app.visits set sort_key = p_key where id = tests.id(p_name);
end $$;

select is((select count(*)::int from app.visit_notify_state where visit_id in (select id from app.visits where queue_id = tests.id('queue_r'))), 6,
  'every waiting visit has a baseline');
select is((select count(*)::int from tests.outbox), 0, 'joining and baselines send nothing');
select results_eq($$ select renotify_eta_delta_minutes, 3, 300 from app.queues where id = tests.id('queue_r') $$ ,
  $$ values (40, 3, 300) $$, 'thresholds default to 3 places and 5 minutes');

------------------------------------------------------------------------------------------------
-- A big reorder (AC1)
------------------------------------------------------------------------------------------------
select tests.reorder('r1', 100000);
select results_eq($$ select visit, template_key from tests.outbox order by visit, template_key $$,
  $$ values ('r1', 'eta_changed') $$,
  'AC1: r1 to the back changes its estimate by more than 40 minutes: one eta_changed; r2..r6 each moved up one place and under the threshold get nothing (AC3)');
select ok((select vars ? 'eta_later' and not vars ? 'eta_sooner' and vars ? 'eta_range' and (vars->>'position')::int = 6
           from tests.outbox where visit = 'r1'), 'the row carries the new place and the later-wording variable');
select is((select last_position from app.visit_notify_state where visit_id = tests.id('r1')), 6, 'r1''s baseline moved to what it was told');
select is((select last_position from app.visit_notify_state where visit_id = tests.id('r2')), 2, 'untouched baselines stay put');

-- AC2: three reorders inside the minimum interval send nothing more.
select tests.reorder('r1', 0);
select tests.reorder('r1', 200000);
select tests.reorder('r1', 0);
select is((select count(*)::int from tests.outbox where visit = 'r1'), 1,
  'AC2: further reorders inside the 5 minute interval enqueue nothing');
-- Five minutes later the sweep tells r1 where it stands now.
update app.visit_notify_state set last_notified_at = now() - interval '10 minutes' where visit_id = tests.id('r1');
select ok(ops.renotify_sweep() >= 1, 'the sweep finds r1 due');
select results_eq($$ select template_key, vars ? 'eta_sooner' from tests.outbox where visit = 'r1' order by vars ? 'eta_sooner' $$,
  $$ values ('eta_changed', false), ('eta_changed', true) $$,
  'AC2: the latest values are sent: r1 is back at the front, sooner wording');
select is(ops.renotify_sweep(), 0, 'a second sweep in the same minute sends nothing');

------------------------------------------------------------------------------------------------
-- Preferences (AC4) and the position-only trigger
------------------------------------------------------------------------------------------------
insert into app.alert_preferences (org_id, visit_id, triggers) values
  (tests.id('org_a'), tests.id('r2'), '{called}'),
  (tests.id('org_a'), tests.id('r3'), '{position_changed}');
select tests.reorder('r2', 300000);
select is((select count(*)::int from tests.outbox where visit = 'r2'), 0,
  'AC4: a guest without eta_changed or position_changed in their preferences gets nothing');
select is((select last_position from app.visit_notify_state where visit_id = tests.id('r2')), 2,
  '... and is not marked as told');
select tests.reorder('r3', 400000);
select results_eq($$ select template_key from tests.outbox where visit = 'r3' $$, $$ values ('position_changed') $$,
  'a guest who only follows position_changed gets that, even though the estimate moved too');
select ok((select vars ? 'position_back' and not vars ? 'position_up' from tests.outbox where visit = 'r3'),
  '... with the moved-back wording');

------------------------------------------------------------------------------------------------
-- Delivery details
------------------------------------------------------------------------------------------------
select is((select count(*)::int from tests.outbox where dedupe_key not like 'renotify:%'), 0, 'dedupe keys are scoped renotify:<trigger>:<visit>:<event or minute>');
select is((select count(distinct dedupe_key)::int from tests.outbox), (select count(*)::int from tests.outbox), 'no dedupe key repeats');
select tests.as_service();
select is(api.outbox_still_relevant((select id from tests.outbox where visit = 'r3')), true, 'a position update is relevant while the guest waits');
select tests.as_postgres();
select private.set_actor('staff', tests.id('staff'), 'cancel');
update app.visits set status = 'cancelled', finished_at = now() where id = tests.id('r3');
select tests.as_service();
select is(api.outbox_still_relevant((select id from tests.outbox where visit = 'r3')), false, '... and not once they leave');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- Tenancy
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select ok((select count(*) from app.visit_notify_state where visit_id = tests.id('r1')) = 1, 'org A staff read their own baselines');
select is((select count(*)::int from app.visit_notify_state where visit_id = tests.id('rb1')), 0, 'org A staff cannot read org B baselines');
select tests.act_as('other_owner');
select is((select count(*)::int from app.visit_notify_state where visit_id = tests.id('r1')), 0, 'AC5: org B owner reads no org A baselines');
select is((select count(*)::int from app.visit_notify_state where visit_id = tests.id('rb1')), 1, 'org B owner reads their own');
select throws_ok($$ update app.visit_notify_state set last_position = 9 where visit_id = tests.id('rb1') $$, '42501', null, 'no client writes baselines');
select tests.as_postgres();

select * from finish();
rollback;
