-- C5 (#1271): sensitive_guard, sensitivity class, retention default, health-tagged limit.
begin;
\ir ../helpers/_setup.psql
select plan(33);
select tests.create_world();

create function tests.error_detail(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;
grant execute on function tests.error_detail(text) to anon, authenticated;

-- AC1: the detector.
select is(private.sensitive_kind('card 4111 1111 1111 1111 ok'), 'card', 'a spaced Luhn-valid card number is found');
select is(private.sensitive_kind('4111-1111-1111-1111'), 'card', 'hyphens too');
select is(private.sensitive_kind('4111111111111111'), 'card', 'and bare digits');
select is(private.sensitive_kind('4111 1111 1111 1112'), null, 'a 16-digit run that fails Luhn is not a card');
select is(private.sensitive_kind('046 454 286'), 'national_id', 'a Luhn-valid SIN is found');
select is(private.sensitive_kind('SIN 046454286.'), 'national_id', 'unspaced too');
select is(private.sensitive_kind('123-45-6789'), 'national_id', 'a valid SSN is found');
select is(private.sensitive_kind('666-45-6789'), null, 'an impossible SSN area is not');
select is(private.sensitive_kind('call +1 204 555 0123 or 204-555-0123 on 2026-11-09, ticket 1234'), null,
  'phones, dates and short numbers pass');
select is(private.sensitive_kind(null), null, 'null passes');
select is(tests.error_detail($$ select private.sensitive_guard('4111 1111 1111 1111') $$), 'sensitive_data:card', 'the guard raises with the kind as DETAIL');
select throws_ok($$ select private.sensitive_guard('046 454 286', 'invalid_answers', 'note') $$, 'P0001', 'invalid_answers', 'and the caller''s code');
select lives_ok($$ select private.sensitive_guard('Haircut') $$, 'clean text passes');

-- Labels, help and options (existing intake_fields).
select tests.act_as('manager');
select is(tests.error_detail($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'k1', 'Card 4111 1111 1111 1111', 'text') $$),
  'sensitive_data:card', 'a field label with a card number is refused');
select is(tests.error_detail($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, help, type)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'k2', 'Id', 'e.g. 046 454 286', 'text') $$),
  'sensitive_data:national_id', 'help text too');
select is(tests.error_detail($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'k3', 'Pick', 'select', '["a", "4111111111111111"]') $$),
  'sensitive_data:card', 'and select options');
select is(tests.error_detail($$ update app.intake_fields set label = 'SSN 123-45-6789' where id = tests.id('intake_a') $$),
  'sensitive_data:national_id', 'an update is guarded too');

-- AC2/3: sensitivity class and the 90-day default.
select lives_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'plain', 'Plain', 'text') $$, 'a normal field saves');
select is((select sensitivity::text from app.intake_fields where key = 'plain' and queue_id = tests.id('queue_a')), 'normal', 'sensitivity defaults to normal');
select is((select retention_days from app.intake_fields where key = 'plain' and queue_id = tests.id('queue_a')), null, 'with no retention override');
select lives_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'meds', 'Medications', 'text', 'sensitive') $$, 'a sensitive field saves');
select is((select retention_days from app.intake_fields where key = 'meds' and queue_id = tests.id('queue_a')), 90, 'and defaults to 90 days');
select lives_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity, retention_days)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'meds2', 'Allergies', 'text', 'sensitive', 30) $$, 'a shorter retention is kept');
select throws_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, retention_days)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'long', 'Long', 'text', 366) $$, '23514', null, 'retention is capped at 365');
select throws_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'bad', 'Bad', 'text', 'secret') $$, '22P02', null, 'the class is one of three values');

-- The C7 hook: a missing privacy contact stops a sensitive field.
select tests.as_postgres();
create or replace function private.privacy_contact_recorded(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$ select false $$;
select tests.act_as('manager');
select is(tests.error_detail($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'meds3', 'Conditions', 'text', 'sensitive') $$),
  'privacy_contact_required', 'a sensitive field needs the recorded privacy contact');
select lives_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'dob', 'Date of birth', 'date', 'personal') $$, 'a personal field does not');

-- AC4: health-tagged orgs: a short free-text reason only.
select tests.as_postgres();
create or replace function private.privacy_contact_recorded(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$ select true $$;
update app.organizations set health_tagged = true where id = tests.id('org_a');
select tests.act_as('manager');
select is(tests.error_detail($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'dx', 'Diagnosis', 'select', '["a","b"]', 'sensitive') $$),
  'health_tagged_text_only', 'a sensitive field of a health-tagged org must be free text');
select lives_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'why', 'Reason for visit', 'text', 'sensitive') $$, 'free text is allowed');
select tests.as_postgres();
select is(tests.error_detail(format($q$ select private.validate_answers(tests.id('queue_a'), %L, 'staff') $q$,
  jsonb_build_object('why', repeat('x', 201))::text)), 'why', 'and its answer is at most 200 characters');
select is(tests.error_detail(format($q$ select private.validate_answers(tests.id('queue_a'), %L, 'staff') $q$,
  jsonb_build_object('plain', 'card 4111 1111 1111 1111')::text)), 'plain', 'an answer holding a card number is refused (DETAIL: the key)');

-- Cross-tenant: org A's manager cannot add a field to org B's queue, and org B cannot see org A's.
select tests.act_as('manager');
select throws_ok($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type)
  values (tests.id('org_b'), tests.id('loc_b'), tests.id('queue_b'), 'x', 'X', 'text') $$, '42501', null, 'cross-tenant insert is denied');
select tests.act_as('other_owner');
select is((select count(*)::int from app.intake_fields where org_id = tests.id('org_a')), 0, 'org B sees none of org A''s fields');

select * from finish();
rollback;
