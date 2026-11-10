-- #496: signed-in callers read app.visits through a column grant that leaves out the secrets.
-- Every column is classified below. A column added later is hidden by default (it is not in
-- the grant), and this test fails until it is listed as staff-visible (and granted) or hidden.
begin;
\ir ../helpers/_setup.psql
select plan(12);

create temp table staff_visible (col name) on commit drop;
insert into staff_visible values
  ('id'), ('org_id'), ('location_id'), ('queue_id'), ('service_id'), ('service_day'),
  ('ticket_prefix'), ('ticket_number'), ('display_ticket'), ('status'), ('sort_key'),
  ('party_size'), ('guest_name'), ('guest_id'), ('contact_id'), ('locale'), ('source'),
  ('counter_id'), ('assigned_staff_id'), ('assigned_counter_id'), ('call_count'), ('eta_quoted_low'), ('eta_quoted_high'),
  ('joined_at'), ('called_at'), ('serving_at'), ('finished_at'), ('version'),
  ('guest_phone_e164'), ('guest_email'), ('group_key'), ('notes'), ('tags'), ('scheduled_at'), ('journey_id'), ('priority_class_id'), ('arrive_after');

create temp table hidden (col name) on commit drop;
-- idempotency_key: with the device key it replays a join and returns the guest's link token.
-- guest_token_hash, device_key_hash: let staff correlate guests and devices across visits.
-- scan_code: the guest's door QR; staff resolve it through api.find_visit_by_scan_code, not by listing codes.
insert into hidden values ('idempotency_key'), ('guest_token_hash'), ('device_key_hash'), ('anonymized_at'), ('grace_until'),
  ('scan_code'), ('snooze_count'),
  -- manually_ordered: how the line was arranged, not something the console shows.
  ('manually_ordered'),
  -- device_ref_hash: would let staff link one guest's device across queues.
  ('device_ref_hash'),
  -- attribution: where an online join came from (2B-J8); reporting reads it, the console does not.
  ('attribution');
grant select on staff_visible, hidden to authenticated;

select is_empty(
  $$ select attname from pg_attribute
     where attrelid = 'app.visits'::regclass and attnum > 0 and not attisdropped
     except select col from staff_visible except select col from hidden $$,
  'every app.visits column is classified as staff-visible or hidden (add new columns to this test)');

select set_eq(
  $$ select attname from pg_attribute
     where attrelid = 'app.visits'::regclass and attnum > 0 and not attisdropped
       and has_column_privilege('authenticated', 'app.visits', attname, 'SELECT') $$,
  'select col from staff_visible',
  'authenticated can select exactly the staff-visible columns');

select ok(not has_table_privilege('authenticated', 'app.visits', 'SELECT'),
  'authenticated has no table-level SELECT on app.visits');

select ok(has_table_privilege('service_role', 'app.visits', 'SELECT'),
  'service_role still reads every column');

select tests.create_world();
select tests.act_as('staff');

select throws_ok($$ select idempotency_key from app.visits $$, '42501', null,
  'staff cannot select idempotency_key');
select throws_ok($$ select guest_token_hash from app.visits $$, '42501', null,
  'staff cannot select guest_token_hash');
select throws_ok($$ select device_key_hash from app.visits $$, '42501', null,
  'staff cannot select device_key_hash');
select throws_ok($$ select * from app.visits $$, '42501', null,
  'staff cannot select * from app.visits');

-- A whole-row reference needs SELECT on every column, so the PostgREST computed column
-- app.allowed_actions(app.visits) is closed to signed-in callers. Staff get actions from the
-- api.visit_row RPCs; a list that needs them per row needs its own read (see the migration).
select throws_ok($$ select app.allowed_actions(v) from app.visits v $$, '42501', null,
  'the whole-row computed column app.allowed_actions is not readable by staff');

-- What the staff console selects (features/console/api.ts), joins included.
select isnt_empty(
  $$ select v.id, v.queue_id, v.display_ticket, v.status, v.guest_name, v.party_size,
            v.joined_at, v.called_at, v.serving_at, s.name, c.label
     from app.visits v
     left join app.services s on s.id = v.service_id
     left join app.counters c on c.id = v.counter_id
     where v.location_id = tests.id('loc_a') and v.status in ('waiting', 'called', 'serving')
     order by v.sort_key $$,
  'staff can still read the console columns');

-- Cross-tenant is unchanged: org B's owner sees no org A rows, even through granted columns.
select tests.act_as('other_owner');
select is_empty($$ select id from app.visits where org_id = tests.id('org_a') $$,
  'another org''s owner still sees no org A visits');

select tests.act_as('display');
select is_empty($$ select id from app.visits $$, 'a display device still reads no visits directly');

select * from finish();
rollback;
