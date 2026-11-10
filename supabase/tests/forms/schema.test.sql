-- F1 (#1277): forms schema caps, publish immutability, one-subject checks, cross-tenant denial.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();
select tests.new_id(k) from unnest(array['f1','f2','f3','f4','v_draft']) k;

-- Caps: the fixture form is 1 of 3 library forms for loc_a.
insert into app.forms (id, org_id, location_id, name) values
  (tests.id('f1'), tests.id('org_a'), tests.id('loc_a'), 'F1'),
  (tests.id('f2'), tests.id('org_a'), tests.id('loc_a'), 'F2');
select throws_ok($$ insert into app.forms (org_id, location_id, name) values (tests.id('org_a'), tests.id('loc_a'), 'F4') $$,
  'P0001', 'invalid_input', 'a 4th library form in a location is rejected');
select lives_ok($$ insert into app.forms (org_id, location_id, name, is_queue_default) values (tests.id('org_a'), tests.id('loc_a'), 'Default', true) $$,
  'queue default forms do not count toward the cap');
select throws_ok($$ insert into app.form_versions (org_id, location_id, form_id, version, fields)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('f1'), 1, (select jsonb_agg('{}'::jsonb) from generate_series(1, 21))) $$,
  '23514', null, '21 fields in a version are rejected');
select throws_ok($$ insert into app.form_versions (org_id, location_id, form_id, version, fields)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('f1'), 1, '{}') $$, '23514', null, 'fields must be an array');

-- Draft / publish.
insert into app.form_versions (id, org_id, location_id, form_id, version, fields)
values (tests.id('v_draft'), tests.id('org_a'), tests.id('loc_a'), tests.id('f1'), 1, '[{"key":"a"}]');
select is((select text_hash from app.form_versions where id = tests.id('v_draft')), null, 'a draft has no hash');
select throws_ok($$ insert into app.form_versions (org_id, location_id, form_id, version) values (tests.id('org_a'), tests.id('loc_a'), tests.id('f1'), 2) $$,
  '23505', null, 'one draft per form');
update app.form_versions set published_at = now() where id = tests.id('v_draft');
select is((select text_hash from app.form_versions where id = tests.id('v_draft')), extensions.digest('[{"key": "a"}]', 'sha256'), 'publishing stores the sha256 of the fields');
select throws_ok($$ update app.form_versions set fields = '[]' where id = tests.id('v_draft') $$, '42501', 'immutable_column', 'a published version cannot be updated');
select throws_ok($$ delete from app.form_versions where id = tests.id('v_draft') $$, '42501', 'immutable_column', 'a published version cannot be deleted');

-- Targets and responses need exactly one subject.
select throws_ok($$ insert into app.form_targets (org_id, location_id, form_id) values (tests.id('org_a'), tests.id('loc_a'), tests.id('f1')) $$,
  '23514', null, 'a target names a queue or a service');
select throws_ok($$ insert into app.form_responses (org_id, location_id, form_version_id, answers)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('v_draft'), '{}') $$, '23514', null, 'a response names a visit or an appointment');
select lives_ok($$ insert into app.form_responses (org_id, location_id, form_version_id, appointment_id)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('v_draft'), tests.id('appointment_a')) $$, 'a response can attach to an appointment');

-- Cross-tenant: org B cannot point its target at org A's form.
select throws_ok($$ insert into app.form_targets (org_id, location_id, form_id, queue_id, channel)
  values (tests.id('org_b'), tests.id('loc_b'), tests.id('f2'), tests.id('queue_a'), 'walk_in') $$, '23503', null, 'a target cannot reference another organisation''s form');
select tests.act_as('other_owner');
select is((select count(*)::int from app.form_responses), 0, 'another organisation sees no responses');

select * from finish();
rollback;
