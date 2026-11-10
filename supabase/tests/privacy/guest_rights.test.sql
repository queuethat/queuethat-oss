-- 2P-PRV3 (#190): find, export and erase a guest.
begin;
\ir ../helpers/_setup.psql
select plan(15);
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
