-- #513: staff read visits, with each row's allowed_actions, through the invoker view
-- app.staff_visits. Column grants on app.visits (#496) still apply, and so does RLS.
-- Also: app.notifications.recipient_hash (an unsalted hash of the guest's address) is hidden.
begin;
\ir ../helpers/_setup.psql
select plan(14);

select tests.create_world();

select is(
  (select reloptions from pg_class where oid = 'app.staff_visits'::regclass),
  array['security_invoker=true'],
  'app.staff_visits is a security_invoker view');

-- The view exposes what staff may read on app.visits, plus allowed_actions, and nothing hidden.
select set_eq(
  $$ select attname::text from pg_attribute
     where attrelid = 'app.staff_visits'::regclass and attnum > 0 and not attisdropped $$,
  $$ select attname::text from pg_attribute
     where attrelid = 'app.visits'::regclass and attnum > 0 and not attisdropped
       and has_column_privilege('authenticated', 'app.visits', attname, 'SELECT')
     union all select unnest(array['allowed_actions', 'arrival_early_until', 'arrival_late_after', 'on_the_way', 'journey_id', 'journey_next_queue_id']) $$,
  'staff_visits has exactly the staff-visible visit columns plus allowed_actions, the arrival thresholds, on_the_way and the next journey queue');

select ok(
  has_table_privilege('authenticated', 'app.staff_visits', 'SELECT')
  and not has_table_privilege('authenticated', 'app.staff_visits', 'INSERT')
  and not has_table_privilege('authenticated', 'app.staff_visits', 'UPDATE')
  and not has_table_privilege('authenticated', 'app.staff_visits', 'DELETE'),
  'signed-in callers can only select from staff_visits');

select tests.act_as('staff');
select is(
  (select allowed_actions from app.staff_visits where id = tests.id('visit_a')),
  private.allowed_actions('waiting'),
  'staff of org A get allowed_actions for their visit');
select isnt_empty(
  $$ select v.id, s.name, c.label from app.staff_visits v
     left join app.services s on s.id = v.service_id
     left join app.counters c on c.id = v.counter_id
     where v.location_id = tests.id('loc_a') $$,
  'the console list reads through the view, joins included');
select throws_ok($$ select idempotency_key from app.staff_visits $$, '42703', null,
  'the view has no idempotency_key column');

select tests.act_as('other_owner');
select is_empty($$ select id from app.staff_visits where org_id = tests.id('org_a') $$,
  'org B''s owner sees no org A visits through the view');

select tests.act_as('display');
select is_empty($$ select id from app.staff_visits $$, 'a display device sees no visits through the view');

select tests.act_as('anon');
select throws_ok($$ select id from app.staff_visits $$, '42501', null,
  'anon cannot read the view');

select tests.act_as('staff');
select throws_ok(
  $$ update app.staff_visits set guest_name = 'x' where id = tests.id('visit_a') $$, '42501', null,
  'staff cannot write through the view');

-- Notifications: recipient_hash is for the dispatcher's per-inbox counts, never for staff.
select tests.as_postgres();
select ok(not has_column_privilege('authenticated', 'app.notifications', 'recipient_hash', 'SELECT'),
  'authenticated cannot select notifications.recipient_hash');
select is_empty(
  $$ select attname from pg_attribute
     where attrelid = 'app.notifications'::regclass and attnum > 0 and not attisdropped
       and attname <> 'recipient_hash'
       and not has_column_privilege('authenticated', 'app.notifications', attname, 'SELECT') $$,
  'every other notifications column stays readable');
select tests.act_as('staff');
select throws_ok($$ select recipient_hash from app.notifications $$, '42501', null,
  'staff cannot select recipient_hash');
select isnt_empty($$ select id, status, recipient_ref from app.notifications $$,
  'staff still read their org''s notifications');

select * from finish();
rollback;
