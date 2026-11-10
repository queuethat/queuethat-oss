-- 2A-NT1 (#132): joined, no_show_warning, removed and served alerts, the queue's own list, the
-- guest's narrowing choice, relevance at send time, locale, coalescing and tenancy.
begin;
\ir ../helpers/_setup.psql
select plan(20);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, notify_triggers) values
  (tests.new_id('queue_all'), tests.id('org_a'), tests.id('loc_a'), 'All', 'X',
   '{joined,called,almost_up,position_changed,eta_changed,no_show_warning,removed,served}'),
  (tests.new_id('queue_def'), tests.id('org_a'), tests.id('loc_a'), 'Default', 'D', default),
  (tests.new_id('queue_pos'), tests.id('org_a'), tests.id('loc_a'), 'Position', 'P', default),
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'B', 'B',
   '{joined,called,almost_up,position_changed,eta_changed,no_show_warning,removed,served}');
select tests.new_visit(n, 'queue_all') from unnest(array['a1', 'a2', 'a3', 'a4']) n;
select tests.new_visit(n, 'queue_def') from unnest(array['d1', 'd2']) n;
select tests.new_visit(n, 'queue_pos') from unnest(array['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']) n;
select tests.new_visit('b1', 'queue_b');
update app.visits set locale = 'es' where id = tests.id('a4');
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
select v.org_id, v.id, 'https://push.example/' || i.name, 'k', 'a'
from app.visits v join tests.ids i on i.id = v.id;
-- Baselines for the position queue (joining before a subscription existed wrote none to send).
delete from app.visit_notify_state where visit_id in (select id from app.visits where queue_id = tests.id('queue_pos'));
select private.init_notify_state(id) from app.visits where queue_id = tests.id('queue_pos');
-- Org A's Spanish removal wording, version 9, so the version shows which template was used.
insert into app.notification_templates (org_id, trigger, channel, locale, body, version)
values (tests.id('org_a'), 'removed', 'push', 'es', 'Quitado: {{ticket}}', 9);

create view tests.outbox as
  select n.*, (select t.name from tests.ids t where t.id = n.visit_id) as visit
  from app.notifications n where n.dedupe_key <> 'fixture-a' and n.channel = 'push';
grant select on all tables in schema tests to authenticated;
create function tests.remove(p_name text) returns void language plpgsql as $$
begin
  perform api.transition_visit(tests.id(p_name), 'remove',
                               (select version from app.visits where id = tests.id(p_name)), gen_random_uuid(),
                               null, 'test');
end $$;
grant execute on function tests.remove(text) to authenticated;

select is((select notify_triggers from app.queues where id = tests.id('queue_def')),
  array['called', 'almost_up', 'position_changed', 'eta_changed'],
  'a queue offers the phase 1 alerts and the position and estimate updates by default');
select throws_ok($$ update app.queues set notify_triggers = '{called,sms_blast}' where id = tests.id('queue_def') $$,
  '23514', null, 'a queue cannot offer a trigger that does not exist');

------------------------------------------------------------------------------------------------
-- removed (AC2) and served
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select tests.remove('a1');
select tests.remove('d1');
select tests.as_postgres();
select results_eq($$ select visit, template_key from tests.outbox where template_key = 'removed' $$,
  $$ values ('a1', 'removed') $$, 'AC2: removing a guest enqueues one removed row where the queue offers it, none where it does not');
select tests.act_as('staff');
select api.transition_visit(tests.id('a2'), 'call', (select version from app.visits where id = tests.id('a2')), gen_random_uuid());
select api.transition_visit(tests.id('a2'), 'start', (select version from app.visits where id = tests.id('a2')), gen_random_uuid());
select api.transition_visit(tests.id('a2'), 'complete', (select version from app.visits where id = tests.id('a2')), gen_random_uuid());
select tests.as_postgres();
select is((select count(*)::int from tests.outbox where template_key = 'served' and visit = 'a2'), 1,
  'completing a visit enqueues one served row');
select ok(api.outbox_still_relevant((select id from tests.outbox where template_key = 'served' and visit = 'a2')),
  'and it is still worth sending');
select ok(api.outbox_still_relevant((select id from tests.outbox where template_key = 'removed' and visit = 'a1')),
  'a removal that stands is still worth sending');

-- The guest narrowing their choice stops it.
insert into app.alert_preferences (org_id, visit_id, triggers)
values (tests.id('org_a'), tests.id('a3'), '{called,almost_up}');
select tests.act_as('staff');
select tests.remove('a3');
select tests.as_postgres();
select is((select count(*)::int from tests.outbox where visit = 'a3' and template_key = 'removed'), 0,
  'a guest who switched removed off gets no removed row');
select is(private.visit_alert_triggers(tests.id('d2')), array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast'],
  'with no saved choice a guest gets what the queue offers, and announcements');
insert into app.alert_preferences (org_id, visit_id, triggers) values (tests.id('org_a'), tests.id('d2'), '{called,removed}');
select is(private.visit_alert_triggers(tests.id('d2')), array['called'],
  'a guest cannot switch on an alert the queue does not offer');

------------------------------------------------------------------------------------------------
-- joined
------------------------------------------------------------------------------------------------
select set_config('request.headers', '{"x-real-ip": "198.51.100.77"}', true);
select tests.as_anon();
select is((api.join_queue(tests.id('queue_all'), null, 'Jo', null, 'jo@example.com', 1, 'en', gen_random_uuid())).status::text,
  'waiting', 'setup: a guest joins with an email');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'joined' and channel = 'email'), 0,
  'a joined message is never mailed to an email the guest only typed (nobody verified it)');
select tests.new_visit('j1', 'queue_all');
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
values (tests.id('org_a'), tests.id('j1'), 'https://push.example/j1', 'k', 'a');
select private.enqueue_notification((select v from app.visits v where v.id = tests.id('j1')),
  (select min(e.id) from app.visit_events e where e.visit_id = tests.id('j1')), 'joined', 'joined:j1');
select is((select count(*)::int from app.notifications where template_key = 'joined' and visit_id = tests.id('j1')
           and channel = 'push'), 1,
  'a joined message still reaches a verified recipient (a push subscription)');
select tests.as_anon();
select api.join_queue(tests.id('queue_def'), null, 'Jan', null, 'jan@example.com', 1, 'en', gen_random_uuid());
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'joined'), 1,
  'and none where it does not');

------------------------------------------------------------------------------------------------
-- no_show_warning and its relevance (AC3)
------------------------------------------------------------------------------------------------
select tests.new_visit('w1', 'queue_all');
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
values (tests.id('org_a'), tests.id('w1'), 'https://push.example/w1', 'k', 'a');
select tests.act_as('staff');
select api.transition_visit(tests.id('w1'), 'call', (select version from app.visits where id = tests.id('w1')), gen_random_uuid());
select tests.as_postgres();
select private.set_actor('system', null);
select private.record_visit_event(tests.id('w1'), 'no_show_warning', '{}');
select is((select count(*)::int from tests.outbox where visit = 'w1' and template_key = 'no_show_warning'), 1,
  'the warning event enqueues one no_show_warning row');
select ok(api.outbox_still_relevant((select id from tests.outbox where visit = 'w1' and template_key = 'no_show_warning')),
  'it is relevant while the guest is still called');
select tests.act_as('staff');
select api.transition_visit(tests.id('w1'), 'start', (select version from app.visits where id = tests.id('w1')), gen_random_uuid());
select tests.as_postgres();
select ok(not api.outbox_still_relevant((select id from tests.outbox where visit = 'w1' and template_key = 'no_show_warning')),
  'AC3: once the guest starts being served the warning is dropped');

------------------------------------------------------------------------------------------------
-- Locale (AC4)
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select tests.remove('a4');
select tests.as_postgres();
select is((select template_version from tests.outbox where visit = 'a4' and template_key = 'removed'), 9,
  'AC4: a Spanish visit uses the Spanish template');
select is((select template_version from tests.outbox where visit = 'a1' and template_key = 'removed'), 1,
  'an English visit keeps the English default');

------------------------------------------------------------------------------------------------
-- Position updates coalesce (AC1)
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select tests.remove('p1');
select tests.remove('p2');
select tests.remove('p3');
select tests.remove('p4');
select tests.remove('p5');
select tests.as_postgres();
select is((select count(*)::int from tests.outbox where visit = 'p10' and template_key in ('position_changed', 'eta_changed')), 1,
  'AC1: with five guests ahead gone within minutes, the last guest gets one place or estimate update, not five');

------------------------------------------------------------------------------------------------
-- Tenancy (AC5)
------------------------------------------------------------------------------------------------
select tests.act_as('other_owner');
select is_empty($$ select 1 from app.notifications where org_id = tests.id('org_a') $$,
  'AC5: staff of org B see no org A notifications');

select * from finish();
rollback;
