-- 2P-NTF8 (#180): a manager's message to everyone in a queue goes through the outbox.
begin;
\ir ../helpers/_setup.psql
select plan(22);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
select tests.new_id(n) from unnest(array['k1', 'key2']) n;

-- queue_x: g1..g3 push, g4 push but opted out of broadcasts, g5 nothing to send to.
-- queue_y holds an unrelated guest. Org B has a queue and a manager of its own.
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_x'), tests.id('org_a'), tests.id('loc_a'), 'Broadcast', 'X'),
  (tests.new_id('queue_y'), tests.id('org_a'), tests.id('loc_a'), 'Other', 'Y');
select tests.new_visit(n, 'queue_x') from unnest(array['g1', 'g2', 'g3', 'g4', 'g5']) n;
select tests.new_visit('y1', 'queue_y');
select tests.new_visit('typed', 'queue_x');
select private.set_actor('system', null);
update app.visits set guest_email = 'victim@example.com' where id = tests.id('typed');
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
select v.org_id, v.id, 'https://push.example/' || i.name, 'k', 'a'
from app.visits v join tests.ids i on i.id = v.id where i.name in ('g1', 'g2', 'g3', 'g4', 'y1');
insert into app.alert_preferences (org_id, visit_id, triggers) values
  (tests.id('org_a'), tests.id('g4'), '{called,almost_up}');
create view tests.outbox as
  select n.*, (select t.name from tests.ids t where t.id = n.visit_id) as visit
  from app.notifications n where n.template_key = 'broadcast';
grant select on tests.outbox to authenticated, service_role;
create function tests.send(p_body text, p_key uuid default gen_random_uuid(), p_queue text default 'queue_x')
returns api.broadcast_result language sql as $$
  select api.send_queue_message(tests.id(p_queue), p_body, p_key)
$$;
grant execute on function tests.send(text, uuid, text) to authenticated;

------------------------------------------------------------------------------------------------
-- Delivery (AC1, AC3)
------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select results_eq($$ select (r).recipients, (r).suppressed from (select tests.send('Running {{eta_range}} late, {{ticket}}', tests.id('k1')) r) s $$,
  $$ values (3, 3) $$, 'AC1: three guests get it; the opt-out, the guest with nowhere to send and the one with only a typed email are suppressed');
select tests.as_postgres();
select results_eq($$ select visit from tests.outbox order by visit $$, $$ values ('g1'), ('g2'), ('g3') $$,
  'AC1: three rows, for g1..g3 only');
select is((select count(*)::int from tests.outbox where visit = 'typed'), 0,
  'free text is never mailed to an address a guest only typed');
select is((select count(*)::int from tests.outbox where channel = 'email'), 0, 'no email rows at all in this queue');
select is((select count(*)::int from tests.outbox where visit = 'y1'), 0, 'AC3: nothing reaches another queue''s guest');
select is((select vars->>'message' ~ ('^Running \d+–\d+ min late, ' || v.display_ticket || '$')
           from tests.outbox o join app.visits v on v.id = o.visit_id where o.visit = 'g1'), true,
  'the text is filled in per guest: the guest''s own ticket and estimate');
select is((select count(*)::int from app.audit_log where table_name = 'queue_broadcasts' and action = 'INSERT'
  and org_id = tests.id('org_a')), 2, 'the broadcast is audited (the fixture plus this one)');
select results_eq($$ select recipients, suppressed, body from app.queue_broadcasts where queue_id = tests.id('queue_x') $$,
  $$ values (3, 3, 'Running {{eta_range}} late, {{ticket}}') $$, 'the broadcast records its reach');

------------------------------------------------------------------------------------------------
-- Idempotency (AC4)
------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select results_eq($$ select (r).recipients, (r).suppressed from (select tests.send('ignored on replay', tests.id('k1')) r) s $$,
  $$ values (3, 3) $$, 'AC4: the same key returns the first result');
select tests.as_postgres();
select is((select count(*)::int from app.queue_broadcasts where queue_id = tests.id('queue_x')), 1, 'AC4: one broadcast exists');
select is((select count(*)::int from tests.outbox), 3, '... and no extra rows');

------------------------------------------------------------------------------------------------
-- Validation and permissions
------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select throws_ok($$ select tests.send('Hello {{counter}}') $$, 'P0001', 'unknown_variable', 'only ticket and eta_range are variables');
select throws_ok($$ select tests.send('x {{ticket') $$, 'P0001', 'unknown_variable', 'a malformed placeholder is rejected');
select throws_ok($$ select tests.send(repeat('a', 321)) $$, 'P0001', 'invalid_input', 'over 320 characters is invalid');
select throws_ok($$ select tests.send('   ') $$, 'P0001', 'invalid_input', 'an empty message is invalid');
select tests.act_as('staff');
select throws_ok($$ select tests.send('Hi') $$, '42501', 'permission_denied', 'AC2: staff below manager are denied');
select is((select count(*)::int from app.queue_broadcasts), 0, 'staff below manager do not read the broadcast history');
select tests.act_as('other_owner');
select throws_ok($$ select tests.send('Hi') $$, 'P0001', 'not_found', 'AC2: org B on an org A queue gets not_found');
select tests.as_anon();
select throws_ok($$ select tests.send('Hi') $$, '42501', null, 'anon cannot call it');

------------------------------------------------------------------------------------------------
-- Rate limit (AC2)
------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select lives_ok($$ select tests.send('one') $$, 'second broadcast');
select tests.send(m) from unnest(array['two', 'three', 'four', 'five']) m;
select throws_ok($$ select tests.send('seven') $$, 'P0001', 'rate_limited', 'AC2: the 7th within an hour is rate limited');
select tests.as_postgres();
update app.queue_broadcasts set created_at = now() - interval '2 hours' where queue_id = tests.id('queue_x');
select tests.act_as('manager');
select lives_ok($$ select tests.send('after an hour') $$, 'older broadcasts stop counting');
select tests.as_postgres();

select * from finish();
rollback;
