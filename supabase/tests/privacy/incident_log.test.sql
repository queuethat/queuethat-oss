-- C9 (#1275): a business's own incident log. Admins and owners add entries and fill in what they
-- did; nobody edits the table directly or deletes from it; other businesses and staff reach none of it.
begin;
\ir ../helpers/_setup.psql
select plan(26);
select tests.create_world();

create table tests.keep (name text primary key, id uuid);
grant all on tests.keep to authenticated;
-- the fixture row from create_world is not part of these counts
delete from app.guest_notices;
delete from app.org_incident_log;

-- ------------------------------------------------------------------ report a suspected incident
select tests.act_as('owner');
select lives_ok($$ insert into tests.keep select 'rep', api.report_incident(tests.id('org_a'), 'lost_device', 'Phone lost',
  'A staff phone with the console signed in', null, array['contact'], true, '22222222-2222-2222-2222-222222222222') $$,
  'an owner reports a suspected incident');
select is(api.report_incident(tests.id('org_a'), 'lost_device', 'Phone lost', null, null, '{}', true, '22222222-2222-2222-2222-222222222222'),
  (select id from tests.keep where name = 'rep'), 'repeating the key returns the same entry');
select is((select count(*)::int from app.org_incident_log), 1, 'and adds no second one');
select results_eq($$ select source, kind, title, description, data_categories, created_by from app.org_incident_log $$,
  $$ values ('manual', 'lost_device', 'Phone lost', 'A staff phone with the console signed in', array['contact'], tests.id('owner')) $$,
  'the entry is the business''s own (manual), whatever p_notify_platform says, with who reported it');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where visit_id is null), 0, 'reporting emails nobody');
select tests.act_as('admin');
select lives_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'Second entry', p_notify_platform => false) $$,
  'an admin adds an entry too, with no key');
select is((select count(*)::int from app.org_incident_log where source = 'manual'), 2, 'both are in the log');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'nope', 'x') $$, 'P0001', 'invalid_input', 'a bad kind is invalid');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', '  ') $$, 'P0001', 'invalid_input', 'a blank title is invalid');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x', p_data_categories => array['nope']) $$,
  'P0001', 'invalid_input', 'a bad data category is invalid');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x', p_detected_at => now() + interval '1 hour') $$,
  'P0001', 'invalid_input', 'a detection time in the future is invalid');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'nope', 'x', p_idempotency_key => '33333333-3333-3333-3333-333333333333') $$,
  'P0001', 'invalid_input', 'a refused report with a key');
select lives_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'Retried', p_idempotency_key => '33333333-3333-3333-3333-333333333333') $$,
  'does not use the key up: the corrected retry goes through');
select is((select count(*)::int from app.org_incident_log), 3, 'no refused report left a row');

-- ------------------------------------------------------------------ the business adds what it did
select lives_ok($$ select api.update_incident_log_entry((select id from tests.keep where name = 'rep'),
  p_people_affected => 12, p_actions_taken => 'Reset staff passwords', p_regulator_notified => 'Told the regulator on day 2') $$,
  'the business adds what it did');
select results_eq($$ select people_affected, actions_taken, regulator_notified from app.org_incident_log where id = (select id from tests.keep where name = 'rep') $$,
  $$ values (12, 'Reset staff passwords', 'Told the regulator on day 2') $$, 'it is stored');
select throws_ok($$ select api.update_incident_log_entry((select id from tests.keep where name = 'rep'), p_people_affected => -1) $$,
  'P0001', 'invalid_input', 'a negative count is invalid');
select throws_ok($$ update app.org_incident_log set title = 'changed' $$, '42501', null, 'the log cannot be edited directly');
select throws_ok($$ insert into app.org_incident_log (org_id, source, kind, title, detected_at)
                    values (tests.id('org_a'), 'manual', 'other', 'x', now()) $$, '42501', null, 'or written to directly');
select throws_ok($$ delete from app.org_incident_log $$, '42501', null, 'the 24-month record cannot be deleted');

-- ------------------------------------------------------------------ other tenants and roles
select tests.act_as('other_owner');
select is((select count(*)::int from app.org_incident_log), 0, 'another business reads none of it');
select throws_ok($$ select api.update_incident_log_entry((select id from tests.keep where name = 'rep'), p_people_affected => 1) $$,
  'P0001', 'not_found', 'and cannot edit an entry');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x') $$, '42501', 'permission_denied', 'nor report for it');
select tests.act_as('staff');
select is((select count(*)::int from app.org_incident_log), 0, 'staff read none of it');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x') $$, '42501', 'permission_denied', 'staff cannot report');
select tests.as_anon();
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x') $$, '42501', null, 'anon cannot call it');

select * from finish();
rollback;
