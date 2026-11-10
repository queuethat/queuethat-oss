-- 2P-NTF1 (#173): per-visit alert preferences are enforced at enqueue and again at claim time.
begin;
\ir ../helpers/_setup.psql
select plan(25);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();

-- queue_p: p1 (called first), p2, p3 waiting, each with a push subscription and a known token.
-- queue_q: q1 waiting. queue_pb is org B's.
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_p'), tests.id('org_a'), tests.id('loc_a'), 'Prefs', 'P'),
  (tests.new_id('queue_q'), tests.id('org_a'), tests.id('loc_a'), 'Other', 'Q'),
  (tests.new_id('queue_pb'), tests.id('org_b'), tests.id('loc_b'), 'Prefs B', 'B');
delete from app.business_hours;
delete from app.hours_exceptions;
insert into app.services (org_id, location_id, queue_id, name, expected_minutes)
select q.org_id, q.location_id, q.id, 'Cut', 20 from app.queues q where q.name in ('Prefs', 'Other', 'Prefs B');
create table tests.tokens (name text primary key, token text, vid uuid);
grant insert, select on tests.tokens to anon, authenticated, service_role;
create function tests.vid(p_name text) returns uuid language sql security definer set search_path = '' as $$
  select t.vid from tests.tokens t where t.name = p_name
$$;
grant execute on function tests.vid(text) to anon, authenticated, service_role;
select tests.as_anon();
insert into tests.tokens (name, token) select n, (api.join_queue(tests.id(q), null, n, null, null, 1, null, gen_random_uuid())).token
from (values ('p1', 'queue_p'), ('p2', 'queue_p'), ('p3', 'queue_p'), ('q1', 'queue_q'), ('pb1', 'queue_pb')) j (n, q);
select tests.as_postgres();
update tests.tokens t set vid = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
select v.org_id, v.id, 'https://push.example/' || t.name, 'k', 'a'
from tests.tokens t join app.visits v on v.id = t.vid;
create view tests.outbox as
  select n.*, (select t.name from tests.tokens t where t.vid = n.visit_id) as visit
  from app.notifications n where n.dedupe_key <> 'fixture-a';
grant select on tests.outbox to authenticated, service_role;

select col_is_pk('app', 'alert_preferences', 'visit_id',
  'preferences are keyed by visit, so a transfer to another queue keeps them');

------------------------------------------------------------------------------------------------
-- Guest RPCs
------------------------------------------------------------------------------------------------
select tests.as_anon();
select is((api.guest_get_alert_prefs((select token from tests.tokens where name = 'p2'))).triggers,
  array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast'],
  'a visit with no row has the default triggers');
select is((api.guest_get_alert_prefs((select token from tests.tokens where name = 'p2'))).available,
  array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast'],
  'only triggers with a template are offered');
select is((api.guest_set_alert_prefs((select token from tests.tokens where name = 'p2'), array['called', 'called'], gen_random_uuid())).triggers,
  array['called'], 'p2 drops almost_up (duplicates ignored)');
select is((api.guest_get_alert_prefs((select token from tests.tokens where name = 'p2'))).triggers, array['called'], 'the choice persists');
select lives_ok($$ select api.guest_set_alert_prefs((select token from tests.tokens where name = 'p2'), array['called'], gen_random_uuid()) $$,
  'setting the same list again is fine');
select throws_ok($$ select api.guest_set_alert_prefs((select token from tests.tokens where name = 'p2'), array['called', 'newsletter'], gen_random_uuid()) $$,
  'P0001', 'invalid_trigger', 'AC4: an unknown trigger name is rejected');
select throws_ok($$ select api.guest_set_alert_prefs((select token from tests.tokens where name = 'p2'), null, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a null list is invalid');
select is((api.guest_get_alert_prefs((select token from tests.tokens where name = 'p2'))).triggers, array['called'], 'a rejected change leaves the choice alone');
select throws_ok($$ select api.guest_get_alert_prefs('nope') $$, 'P0001', 'not_found', 'an unknown token gets not_found');
select throws_ok($$ select * from app.alert_preferences $$, '42501', null, 'AC5: anon has no table access');

------------------------------------------------------------------------------------------------
-- Enqueue honours the choice
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select api.call_next(tests.id('queue_p'), tests.id('counter_a'), gen_random_uuid());
select tests.as_postgres();
select results_eq($$ select visit from tests.outbox where template_key = 'almost_up' and visit like 'p%' order by visit $$,
  $$ values ('p3') $$,
  'AC1: p2 turned almost_up off and is 1st waiting; only p3 is queued');
select is((select count(*)::int from tests.outbox where visit = 'p2' and template_key = 'called'), 0,
  'p2 was not called');
select is((select count(*)::int from tests.outbox where visit = 'q1'), 0,
  'a call in queue_p queues nothing for another queue''s visit');

-- p1 was called, so its called row exists; p1 turns called off afterwards (AC2).
select is((select count(*)::int from tests.outbox where visit = 'p1' and template_key = 'called'), 1,
  'p1 got a called row');
select tests.as_service();
select is(api.outbox_still_relevant((select id from tests.outbox where visit = 'p1' and template_key = 'called')), true,
  'the called row is relevant while p1 wants called');
select tests.as_anon();
select api.guest_set_alert_prefs((select token from tests.tokens where name = 'p1'), array['almost_up'], gen_random_uuid());
select tests.as_service();
select is(api.outbox_still_relevant((select id from tests.outbox where visit = 'p1' and template_key = 'called')), false,
  'AC2: once p1 turns called off, the queued row is no longer relevant (the dispatcher suppresses it)');
select is(api.outbox_still_relevant((select id from tests.outbox where visit = 'p3' and template_key = 'almost_up')), true,
  'other guests'' rows are unaffected');
select tests.as_postgres();

-- A recall to a guest who switched called off queues nothing new.
select tests.act_as('staff');
select api.transition_visit(tests.vid('p1'), 'recall', (select version from app.visits where id = tests.vid('p1')), gen_random_uuid());
select tests.as_postgres();
select is((select count(*)::int from tests.outbox where visit = 'p1' and template_key = 'called'), 1,
  'a recall adds no called row for a guest who turned called off');

------------------------------------------------------------------------------------------------
-- Tenancy
------------------------------------------------------------------------------------------------
select tests.as_anon();
select api.guest_set_alert_prefs((select token from tests.tokens where name = 'pb1'), array['almost_up'], gen_random_uuid());
select tests.act_as('staff');
select is((select count(*)::int from app.alert_preferences where visit_id = tests.vid('pb1')), 0,
  'org A staff cannot read org B preferences');
select ok((select count(*) from app.alert_preferences where visit_id = tests.vid('p1')) = 1,
  'org A staff read their own org''s preferences');
select tests.act_as('other_owner');
select is((select count(*)::int from app.alert_preferences where visit_id in (tests.vid('p1'), tests.vid('p2'))), 0,
  'AC5: org B owner reads no org A preferences');
select is((select count(*)::int from app.alert_preferences where visit_id = tests.vid('pb1')), 1,
  'org B owner reads their own');
select throws_ok($$ update app.alert_preferences set triggers = '{}' where visit_id = tests.vid('pb1') $$,
  '42501', null, 'no client writes preferences');
select tests.as_postgres();
select is((select triggers from app.alert_preferences where visit_id = tests.vid('pb1')), array['almost_up'],
  'org B''s guest''s choice is untouched');

select * from finish();
rollback;
