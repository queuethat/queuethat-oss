-- 2P-PRV3 (#190): find, export and erase a guest.
begin;
\ir ../helpers/_setup.psql
select plan(23);
select tests.create_world();

select tests.as_postgres();
-- guest_a: two visits, one appointment-less guest with a phone, an email, 3 notifications.
select private.set_actor('system', null);
update app.visits set guest_id = tests.id('guest_a'), guest_name = 'Gina', guest_phone_e164 = '+14155550123',
  contact_id = tests.id('contact_a') where id = tests.id('visit_a');
select tests.new_visit('visit_a2', 'queue_a', 'Gina');
update app.visits set guest_id = tests.id('guest_a'), guest_name = 'Gina' where id = tests.id('visit_a2');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_a2'), tests.id('org_a'), tests.id('guest_a'), 'email', 'gina@example.com', 'staff');
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key, vars)
select tests.id('org_a'), tests.id('visit_a'), 'console', tests.id('contact_a'), 'called', 1, 'gr-' || n, '{"name":"Gina"}'
from generate_series(1, 3) n;
-- #1311: answers. visit_a holds the world's form response ({"note": "hello"} on Form A). visit_a2 has only
-- legacy answers, one of them staff-only. appointment_a (guest_a's, no visit yet) has its own response.
-- Another guest's visit in the same org holds answers that must not appear.
insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, visibility, position) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'reason', 'Reason for visit', 'text', 'guest', 1),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'triage', 'Triage', 'text', 'staff_only', 2);
insert into app.visit_answers (org_id, location_id, visit_id, answers)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('visit_a2'), '{"reason": "Beard trim", "triage": "Sensitive skin"}');
update app.appointments set guest_id = tests.id('guest_a') where id = tests.id('appointment_a');
insert into app.form_responses (org_id, location_id, form_version_id, appointment_id, answers)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('form_version_a'), tests.id('appointment_a'), '{"note": "booked note"}');
select tests.new_visit('visit_other', 'queue_a', 'Olga');
insert into app.visit_answers (org_id, location_id, visit_id, answers)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('visit_other'), '{"reason": "OTHERGUESTSECRET"}');

-- AC3: staff and managers are denied.
select tests.act_as('staff');
select is((select count(*) from api.find_guest_data('+14155550123', null)), 0::bigint, 'AC3: staff find nothing');
select throws_ok($$ select api.export_guest_data(tests.id('guest_a')) $$, 'P0001', 'not_found', 'AC3: staff cannot export');
select throws_ok($$ select api.erase_guest(tests.id('guest_a'), 'x', false, gen_random_uuid()) $$, 'P0001', 'not_found',
  'AC3: staff cannot erase');
select tests.act_as('manager');
select throws_ok($$ select api.erase_guest(tests.id('guest_a'), 'x', false, gen_random_uuid()) $$, 'P0001', 'not_found',
  'AC3: managers cannot erase');

-- AC4: org B admin gets not_found.
select tests.act_as('other_owner');
select throws_ok($$ select api.export_guest_data(tests.id('guest_a')) $$, 'P0001', 'not_found', 'AC4: org B cannot export');
select throws_ok($$ select api.erase_guest(tests.id('guest_a'), 'x', false, gen_random_uuid()) $$, 'P0001', 'not_found',
  'AC4: org B cannot erase');

select tests.act_as('admin');
select is((select visit_count from api.find_guest_data('+1 (415) 555-0123', null)), 2, 'admin finds the guest by phone');
select is((select count(*) from api.find_guest_data(null, 'Gina@Example.com')), 1::bigint, 'and by email');

-- AC1: the export holds every section.
create temp table ex as select * from api.export_guest_data(tests.id('guest_a'));
select is((select jsonb_array_length(visits) from ex), 2, 'AC1: export has both visits');
select is((select jsonb_array_length(contacts) from ex), 2, 'AC1: export has both contacts');
select cmp_ok((select jsonb_array_length(notifications) from ex), '>=', 3, 'AC1: export has the notifications');
select is((select count(*) from app.audit_log where action = 'EXPORT' and row_id = tests.id('guest_a')::text), 1::bigint,
  'export is audited');

-- #1311: intake answers.
create temp table ans as
select v ->> 'id' as visit_id, a as entry
from ex, jsonb_array_elements(ex.visits) v, jsonb_array_elements(v -> 'answers') a;
select is((select entry #> '{fields,0}' from ans where visit_id = tests.id('visit_a')::text and entry ->> 'form' = 'Form A'),
  '{"key": "note", "label": "note", "type": null, "visibility": "guest", "value": "hello"}'::jsonb,
  '#1311 AC: a visit lists its form response with the form name and each answered field');
select is((select entry ->> 'form_version' from ans where visit_id = tests.id('visit_a')::text), '1',
  '#1311: the response names the form version the guest answered');
select is((select entry -> 'fields' from ans where visit_id = tests.id('visit_a2')::text and entry -> 'form' = 'null'),
  '[{"key": "reason", "label": "Reason for visit", "type": "text", "visibility": "guest", "value": "Beard trim"},
    {"key": "triage", "label": "Triage", "type": "text", "visibility": "staff_only", "value": "Sensitive skin"}]'::jsonb,
  '#1311 AC: legacy answers are listed with their intake labels, staff-only fields included');
select is((select a #>> '{answers,0,fields,0,value}' from ex, jsonb_array_elements(ex.appointments) a
           where a ->> 'id' = tests.id('appointment_a')::text), 'booked note',
  '#1311 AC: an appointment lists the answers given when booking');
select is((select count(*)::int from ans where visit_id = tests.id('visit_a')::text), 1,
  '#1311: a visit with a form response does not repeat a legacy copy');
select is((select (to_jsonb(e)::text like '%OTHERGUESTSECRET%') from ex e), false,
  '#1311 AC: the export holds only this guest''s answers, never another guest''s in the same org');
select is((select count(*) from app.audit_log where after::text ~ 'hello|Beard trim|Sensitive skin|booked note'
           or before::text ~ 'hello|Beard trim|Sensitive skin|booked note'), 0::bigint,
  '#1311: the export audit row carries no answer values');
select tests.act_as('other_owner');
select throws_ok($$ select api.export_guest_data(tests.id('guest_a')) $$, 'P0001', 'not_found',
  '#1311 cross-tenant: org B cannot reach org A answers through the export');
select tests.act_as('admin');

-- AC2 + AC5: erase.
select api.erase_guest(tests.id('guest_a'), 'asked by email', true, '00000000-0000-0000-0000-0000000000e1');
select tests.as_postgres();
select is((select count(*) from app.visits where id in (tests.id('visit_a'), tests.id('visit_a2'))
           and guest_name is null and guest_phone_e164 is null and guest_id is null), 2::bigint,
  'AC2: both visits remain, anonymized');
select is((select (c.status = 'revoked' and c.revoked_via = 'erasure' and c.contact_id is null)
           from app.consents c where c.id = tests.id('consent_a')), true, 'AC2: consent is revoked and kept without the link');
select is((select count(*) from app.audit_log where action = 'ERASE' and (after::text ~* 'gina|@|\+1415' or before::text ~* 'gina')), 0::bigint,
  'AC5: the audit row holds no erased values');

select * from finish();
rollback;
