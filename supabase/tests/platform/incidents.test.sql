-- #1274 (C8): the platform incident register. Operators with aal2 only; support, tenants,
-- devices and anon reach nothing; the 72-hour clock, the affected-tenant finder, the break-glass
-- link and five-year retention are enforced in the database.
begin;
\ir ../helpers/_setup.psql
select plan(42);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
insert into tests.actors values
  ('support', 'authenticated', jsonb_build_object('sub', tests.id('support'), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2'));
create table tests.keep (name text primary key, id uuid);
grant all on tests.keep to authenticated;

-- ------------------------------------------------------------------ who may use it
select tests.act_as('platform');
select lives_ok($$ insert into tests.keep select 'a', id from api.platform_create_incident(
  'unauthorized_access', 'Staff session token leaked', now() - interval '1 hour', 'Found in a log',
  array[tests.id('org_a')], array['contact', 'visit_history'], 120) $$, 'an operator files an incident');
select results_eq($$ select status::text, notify_state, escalated from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'a')) $$,
  $$ values ('suspected', 'pending', false) $$, 'new incidents are suspected, with the clock running');
select is((select notify_due_at - detected_at from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'a'))),
  interval '72 hours', 'the notify deadline is 72 hours after detection');
select ok((select retain_until = detected_at + interval '5 years' from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'a'))),
  'it is kept five years');
select is((select id from api.platform_create_incident('other', 'dup', null, null, '{}', '{}', null,
  '11111111-1111-1111-1111-111111111111')),
  (select id from api.platform_create_incident('other', 'dup', null, null, '{}', '{}', null,
  '11111111-1111-1111-1111-111111111111')), 'the same idempotency key returns the same incident');

select tests.act_as('support');
select throws_ok($$ select api.platform_list_incidents() $$, '42501', 'permission_denied', 'support cannot list');
select throws_ok($$ select api.platform_create_incident('other', 'x') $$, '42501', 'permission_denied', 'support cannot file');
select throws_ok($$ select api.platform_incident_tenants(tests.id('incident_a')) $$, '42501', 'permission_denied', 'support cannot find tenants');
select throws_ok($$ select api.platform_incident_break_glass(tests.id('incident_a')) $$, '42501', 'permission_denied', 'support cannot read the break-glass link');
select is((select count(*) from app.platform_incidents), 0::bigint, 'support reads no rows directly');

select tests.as_user(tests.id('platform'), '{"aal":"aal1"}');
select throws_ok($$ select api.platform_list_incidents() $$, '42501', 'permission_denied', 'an operator at aal1 is denied');
select is((select count(*) from app.platform_incident_events), 0::bigint, 'and reads no timeline rows');

select tests.act_as('owner');
select throws_ok($$ select api.platform_list_incidents() $$, '42501', 'permission_denied', 'a tenant owner cannot list');
select throws_ok($$ select api.platform_add_incident_note(tests.id('incident_a'), 'x') $$, '42501', 'permission_denied', 'a tenant owner cannot add a note');
select is((select count(*) from app.platform_incidents), 0::bigint, 'a tenant owner reads no incidents about their own org');
select tests.as_anon();
select throws_ok($$ select api.platform_list_incidents() $$, '42501', null, 'anon cannot call it');

-- ------------------------------------------------------------------ validation
select tests.act_as('platform');
select throws_ok($$ select api.platform_create_incident('nope', 'x') $$, 'P0001', 'invalid_input', 'an unknown kind is invalid');
select throws_ok($$ select api.platform_create_incident('other', '  ') $$, 'P0001', 'invalid_input', 'a blank title is invalid');
select throws_ok($$ select api.platform_create_incident('other', 'x', null, null, '{}', array['bogus']) $$, 'P0001', 'invalid_input', 'an unknown data category is invalid');
select throws_ok($$ select api.platform_create_incident('other', 'x', now() + interval '1 day') $$, 'P0001', 'invalid_input', 'detection cannot be in the future');
select throws_ok($$ select api.platform_update_incident(gen_random_uuid(), 'contained') $$, 'P0001', 'not_found', 'an unknown incident is not_found');

-- ------------------------------------------------------------------ updates and timeline
select lives_ok($$ select api.platform_update_incident((select id from tests.keep where name = 'a'),
  'contained', p_containment => 'Revoked all sessions', p_root_cause => 'Token logged at debug level') $$, 'an operator contains it');
select lives_ok($$ select api.platform_add_incident_note((select id from tests.keep where name = 'a'), 'Vendor confirmed log purge') $$, 'and adds a note');
select results_eq($$ select kind from app.platform_incident_events where incident_id = (select id from tests.keep where name = 'a') order by created_at, id $$,
  $$ values ('created'), ('status'), ('containment'), ('note') $$, 'the timeline records each change in order');
select is((select root_cause from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'a'))),
  'Token logged at debug level', 'root cause is stored');
select is((select count(*) from api.platform_list_incidents('contained')), 1::bigint, 'the list filters by status');
select throws_ok($$ select api.platform_add_incident_note((select id from tests.keep where name = 'a'), ' ') $$, 'P0001', 'invalid_input', 'a blank note is invalid');
select is((select count(*) from app.platform_audit where action like 'incident.%'), 3::bigint, 'creates and updates are audited');
select is((select count(*) from app.platform_audit where action like 'incident.%' and target::text like '%Token logged%'), 0::bigint, 'the audit never holds the free text');

-- ------------------------------------------------------------------ the clock
select tests.as_postgres();
update app.platform_incidents set detected_at = now() - interval '73 hours' where id = (select id from tests.keep where name = 'a');
select tests.act_as('platform');
select results_eq($$ select notify_state, escalated from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'a')) $$,
  $$ values ('overdue', true) $$, 'past 72 hours without notice the incident is escalated');
select lives_ok($$ select api.platform_update_incident((select id from tests.keep where name = 'a'), p_mark_notified => true) $$, 'marking tenants notified');
select results_eq($$ select notify_state, escalated from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'a')) $$,
  $$ values ('done', false) $$, 'stops the clock');
select results_eq($$ select notify_state, escalated from api.platform_list_incidents(p_id => tests.id('incident_a')) $$,
  $$ values ('pending', false) $$, 'a fresh incident is pending, not escalated');
select lives_ok($$ select api.platform_update_incident(tests.id('incident_a'), p_waive_reason => 'No tenant data reached') $$, 'a waiver reason');
select is((select notify_state from api.platform_list_incidents(p_id => tests.id('incident_a'))), 'done', 'also stops the clock');

-- ------------------------------------------------------------------ finder and break-glass link
select results_eq($$ select org_name, (owners -> 0 ->> 'email') from api.platform_incident_tenants((select id from tests.keep where name = 'a')) $$,
  $$ values ('Org A', 'owner@test.local') $$,
  'the finder lists the scoped org''s owner');
select is((select breach_contact ->> 'email' from api.platform_incident_tenants((select id from tests.keep where name = 'a'))), 'privacy@example.test',
  'and the org''s breach contact from C7 (app.org_privacy)');
select is((select count(*) from api.platform_incident_tenants((select id from tests.keep where name = 'a'))), 1::bigint, 'and only scoped orgs, never org B');
select lives_ok($$ select api.platform_break_glass(tests.id('org_a'), 'Investigating the leak') $$, 'an operator opens break-glass on a scoped org');
select results_eq($$ select reason, org_name from api.platform_incident_break_glass((select id from tests.keep where name = 'a')) $$,
  $$ values ('Investigating the leak', 'Org A') $$, 'the register links it');

-- ------------------------------------------------------------------ retention
select throws_ok($$ delete from app.platform_incidents $$, '42501', null, 'a recent incident cannot be deleted');
select throws_ok($$ update app.platform_incident_events set body = 'x' $$, '42501', null, 'the timeline cannot be edited');

select * from finish();
rollback;
