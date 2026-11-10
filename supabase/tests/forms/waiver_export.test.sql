-- W4 (#1306): staff read waiver records within their queue scope; managers export a date range, logged.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);
select tests.new_visit('own', 'queue_a', 'Own Guest');
select tests.new_visit('other', 'queue_a2', 'Other Guest');
select tests.new_id(k) from unnest(array['r_own', 'r_other']) k;
delete from app.waiver_acceptances;
insert into app.form_responses (id, org_id, location_id, form_version_id, visit_id, answers) values
  (tests.id('r_own'), tests.id('org_a'), tests.id('loc_a'), tests.id('form_version_a'), tests.id('own'), '{}'),
  (tests.id('r_other'), tests.id('org_a'), tests.id('loc_a'), tests.id('form_version_a'), tests.id('other'), '{}');
insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash, accepted_at,
                                    typed_name, subject_kind, subject_id) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('r_own'), tests.id('form_version_a'), 'terms', repeat('a', 64),
   '2026-11-09 15:42:00+00', 'Own Guest', 'visit', tests.id('own')),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('r_other'), tests.id('form_version_a'), 'terms', repeat('b', 64),
   '2026-11-02 12:00:00+00', 'Other Guest', 'visit', tests.id('other'));

-- Scope off: staff read both; scope on: a scoped member reads their line only (1 to 4).
select tests.act_as('staff');
select is((select count(*)::int from app.waiver_acceptances), 2, 'scope off: staff read every record at the location');
select tests.as_postgres();
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');
select tests.as_user(tests.id('scoped'));
select is((select typed_name from app.waiver_acceptances), 'Own Guest', 'scope on: a scoped member sees only their line''s record');
select tests.act_as('staff');
select is((select count(*)::int from app.waiver_acceptances), 2, 'an unscoped member is unaffected');
select tests.act_as('other_owner');
select is((select count(*)::int from app.waiver_acceptances), 0, 'cross-tenant: another org reads nothing');

-- Export (5 to 15).
select tests.act_as('manager');
select is(jsonb_array_length(api.export_waiver_records(tests.id('loc_a'), '2026-11-01', '2026-11-30') -> 'rows'), 2, 'a manager exports every record in the range');
select is((api.export_waiver_records(tests.id('loc_a'), '2026-11-09', '2026-11-09') -> 'rows' -> 0 ->> 'guest_name') || '/' ||
          (api.export_waiver_records(tests.id('loc_a'), '2026-11-09', '2026-11-09') -> 'rows' -> 0 ->> 'typed_name'),
          'Own Guest/Own Guest', 'the range filters by day and carries guest and typed name');
select is(jsonb_array_length(api.export_waiver_records(tests.id('loc_a'), '2026-12-01', '2026-12-31') -> 'rows'), 0, 'an empty range returns no rows');
select ok(not (api.export_waiver_records(tests.id('loc_a'), '2026-11-01', '2026-11-30')::text ~* '(phone|email)'), 'no contact data in the export');
select tests.as_postgres();
select ok((select count(*) from app.audit_log where action = 'EXPORT' and table_name = 'waiver_acceptances' and org_id = tests.id('org_a')) >= 4, 'every export writes an audit row');
select is((select after ->> 'rows' from app.audit_log where table_name = 'waiver_acceptances' and action = 'EXPORT' order by id limit 1), '2', 'the audit row records the row count');
select tests.act_as('staff');
select throws_ok($$ select api.export_waiver_records(tests.id('loc_a'), '2026-11-01', '2026-11-30') $$, '42501', 'permission_denied', 'staff cannot export');
select tests.act_as('other_owner');
select throws_ok($$ select api.export_waiver_records(tests.id('loc_a'), '2026-11-01', '2026-11-30') $$, '42501', 'permission_denied', 'cross-tenant: another org cannot export');
select tests.as_anon();
select throws_ok($$ select api.export_waiver_records(tests.id('loc_a'), '2026-11-01', '2026-11-30') $$, '42501', null, 'anon cannot export');
select tests.act_as('manager');
select throws_ok($$ select api.export_waiver_records(tests.id('loc_a'), '2026-11-30', '2026-11-01') $$, 'P0001', 'invalid_input', 'a reversed range is invalid');
select tests.as_postgres();
select is((select count(*)::int from app.memberships where user_id = tests.id('scoped') and queue_ids is not null), 1, 'only staff carry a line list, so managers are never scoped');

select * from finish();
rollback;
