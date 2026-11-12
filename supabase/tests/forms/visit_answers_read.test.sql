-- F7 (#1283): staff read a visit's answers through api.get_visit_answers, which logs every access
-- (who, when, visit; never values), honours queue scope (M1) and denies other tenants.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();
select tests.new_id(k) from unnest(array['s1', 'queue_a2']) k;

delete from app.intake_fields;
insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options, required, visibility, position) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'reason', 'Reason', 'select', '["cut","colour"]', false, 'guest', 1),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'triage', 'Triage', 'text', null, false, 'staff_only', 2);
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
select tests.new_visit('va', 'queue_a');
select tests.new_visit('va2', 'queue_a2');
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);

select tests.act_as('staff');
select lives_ok($$ select api.set_visit_answers(tests.id('va'), '{"reason": "cut", "triage": "urgent-canary"}',
  (select version from app.staff_visits where id = tests.id('va')), tests.id('s1')) $$, 'staff answer a staff-only field');
select tests.as_postgres();
delete from app.audit_log where table_name = 'form_responses';
create temp table got (r jsonb);
grant insert on got to authenticated;

-- Staff read: the form in order with visibility, and the answers.
select tests.act_as('staff');
insert into got select api.get_visit_answers(tests.id('va'));
select tests.as_postgres();
select is((select jsonb_path_query_array(r, '$.fields[*].key') from got), '["reason", "triage"]'::jsonb, 'the form fields in form order');
select is((select jsonb_path_query_array(r, '$.fields[*].visibility') from got), '["guest", "staff_only"]'::jsonb,
  'each field says who it is for');
select is((select r -> 'fields' -> 0 ->> 'type' from got), 'single_choice', 'types are canonical');
select is((select r -> 'answers' from got), '{"reason": "cut", "triage": "urgent-canary"}'::jsonb, 'the answers');
select is((select r ->> 'location_id' from got)::uuid, tests.id('loc_a'), 'the location, for the live signal');

-- The access is logged: who, when, which visit; never a value.
select is((select count(*)::int from app.audit_log where action = 'READ' and table_name = 'form_responses'
           and row_id = tests.id('va')::text and actor = tests.id('staff')), 1, 'the read wrote one access row');
select is((select role from app.audit_log where action = 'READ' and row_id = tests.id('va')::text), 'staff', 'with the reader''s role');
select is((select count(*)::int from app.audit_log where after::text like '%canary%' or before::text like '%canary%'), 0,
  'the access row never copies an answer');
select tests.act_as('staff');
select api.get_visit_answers(tests.id('va'));
select tests.act_as('manager');
select api.get_visit_answers(tests.id('va'));
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where action = 'READ' and row_id = tests.id('va')::text), 2,
  'a second read by the same member within 10 minutes adds nothing; another member is logged');

-- A visit without answers reads as an empty object, still logged.
select tests.act_as('staff');
select is((select api.get_visit_answers(tests.id('va2')) -> 'answers'), '{}'::jsonb, 'no answers is an empty object');

-- Queue scope (M1): off, a listed member reads every line; on, only their own.
select tests.as_user(tests.id('scoped'));
select lives_ok($$ select api.get_visit_answers(tests.id('va2')) $$, 'scope off: a listed member reads another line');
select tests.as_postgres();
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');
select tests.as_user(tests.id('scoped'));
select throws_ok($$ select api.get_visit_answers(tests.id('va2')) $$, 'P0001', 'not_found', 'scope on: another line is not_found');
select lives_ok($$ select api.get_visit_answers(tests.id('va')) $$, 'scope on: their own line reads');

-- Cross tenant and guests.
select tests.act_as('other_owner');
select throws_ok($$ select api.get_visit_answers(tests.id('va')) $$, 'P0001', 'not_found', 'another org cannot read the answers');
select tests.as_anon();
select throws_ok($$ select api.get_visit_answers(tests.id('va')) $$, '42501', null, 'a guest cannot call it');

select * from finish();
rollback;
