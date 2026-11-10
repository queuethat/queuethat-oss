-- F5 (#1281): save_form_draft / publish_form_version / attach_form. Roles, versioning, caps,
-- bulk attach, cross-tenant denial.
begin;
\ir ../helpers/_setup.psql
select plan(41);
select tests.create_world();
select tests.new_id(k) from unnest(array['n1', 'n2']) k;

-- Roles: manager and above only; staff and a foreign owner get not_found.
select tests.act_as('staff');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'X', null, null, '[]') $$,
  'P0001', 'not_found', 'staff cannot save a form');
select tests.act_as('other_owner');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'X', null, null, '[]') $$,
  'P0001', 'not_found', 'another organisation cannot create a form in this one');
select throws_ok($$ select api.save_form_draft(tests.id('org_b'), tests.id('loc_a'), null, 'X', null, null, '[]') $$,
  'P0001', 'not_found', 'a location of another organisation is not found');
select throws_ok($$ select api.publish_form_version(tests.id('org_a'), tests.id('form_a')) $$,
  'P0001', 'not_found', 'another organisation cannot publish');
select throws_ok($$ select api.attach_form(tests.id('org_b'), tests.id('form_a'), array[tests.id('queue_a')]) $$,
  'P0001', 'not_found', 'a form of another organisation is not found even under the caller''s org id');

-- Create, then overwrite the single draft.
select tests.act_as('manager');
select lives_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, ' Intake ', 'why', 90,
  '[{"key":"reason","label":"Reason","type":"short_text","required":true},
    {"key":"pick","label":"Pick","type":"single_choice","options":["a","b"],"sensitivity":"personal"}]') $$,
  'manager creates a form');
select tests.as_postgres();
select is((select count(*)::int from app.forms where name = 'Intake' and retention_days = 90), 1, 'name is trimmed and retention stored');
select is((select v.version from app.form_versions v join app.forms f on f.id = v.form_id where f.name = 'Intake'), 1, 'first save is version 1, a draft');
select tests.act_as('manager');
select lives_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), (select id from app.forms where name = 'Intake'), 'Intake', null, null,
  '[{"key":"reason","label":"Reason for visit","type":"long_text"}]') $$, 'saving again overwrites the draft');
select tests.as_postgres();
select is((select count(*)::int from app.form_versions v join app.forms f on f.id = v.form_id where f.name = 'Intake'), 1, 'still one version row');
select is((select v.fields -> 0 ->> 'label' from app.form_versions v join app.forms f on f.id = v.form_id where f.name = 'Intake'), 'Reason for visit', 'draft fields replaced');

-- Validation.
select tests.act_as('manager');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, '', null, null, '[]') $$, 'P0001', 'invalid_input', 'empty name rejected');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, 366, '[]') $$, 'P0001', 'invalid_input', 'retention over 365 rejected');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, null,
  (select jsonb_agg(jsonb_build_object('key', 'k' || g, 'label', 'L', 'type', 'short_text')) from generate_series(1, 21) g)) $$,
  'P0001', 'invalid_input', '21 fields rejected');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, null,
  '[{"key":"a","label":"A","type":"short_text"},{"key":"a","label":"B","type":"short_text"}]') $$, 'P0001', 'invalid_input', 'duplicate keys rejected');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, null, '[{"key":"a","label":"A","type":"single_choice"}]') $$,
  'P0001', 'invalid_input', 'a choice field needs options');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, null, '[{"key":"a","label":"A","type":"short_text","options":["x"]}]') $$,
  'P0001', 'invalid_input', 'a text field cannot carry options');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, null, '[{"key":"A b","label":"A","type":"short_text"}]') $$,
  'P0001', 'invalid_input', 'bad key rejected');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'N', null, null, '[{"key":"a","label":"A","type":"short_text","evil":1}]') $$,
  'P0001', 'invalid_input', 'unknown field properties rejected');

-- Form cap: form_a, Intake, plus one more is 3; the 4th is refused.
select lives_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'Third', null, null, '[]') $$, 'third library form allowed');
select throws_ok($$ select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), null, 'Fourth', null, null, '[]') $$, 'P0001', 'invalid_input', 'a 4th library form is refused');

-- Publish freezes with a hash; republishing is a no-op; a changed draft mints version 2.
select is(api.publish_form_version(tests.id('org_a'), (select id from app.forms where name = 'Intake')), 1, 'publish returns version 1');
select tests.as_postgres();
select is((select v.text_hash from app.form_versions v join app.forms f on f.id = v.form_id where f.name = 'Intake' and v.version = 1),
  extensions.digest((select v.fields::text from app.form_versions v join app.forms f on f.id = v.form_id where f.name = 'Intake' and v.version = 1), 'sha256'),
  'published version stores the sha256 of its fields');
select tests.act_as('manager');
select is(api.publish_form_version(tests.id('org_a'), (select id from app.forms where name = 'Intake')), 1, 'publishing again is a no-op');
select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), (select id from app.forms where name = 'Intake'), 'Intake', null, null,
  '[{"key":"reason","label":"Reason for visit","type":"long_text"}]');
select is(api.publish_form_version(tests.id('org_a'), (select id from app.forms where name = 'Intake')), 1, 'an unchanged draft does not mint a new version');
select api.save_form_draft(tests.id('org_a'), tests.id('loc_a'), (select id from app.forms where name = 'Intake'), 'Intake', null, null,
  '[{"key":"reason","label":"Why","type":"long_text"}]');
select is(api.publish_form_version(tests.id('org_a'), (select id from app.forms where name = 'Intake')), 2, 'a changed draft publishes as version 2');

-- Attach: bulk, queues and services, idempotent, all or nothing.
select is(api.attach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'),
  array[tests.id('queue_a'), tests.id('service_a'), tests.id('service_a')]), 2, 'attach reports distinct targets');
select is(api.attach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')]), 1, 'attaching again is idempotent');
select throws_ok($$ select api.attach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('service_a2'), tests.id('n1')]) $$,
  'P0001', 'not_found', 'one unknown id refuses the whole batch');
select throws_ok($$ select api.attach_form(tests.id('org_a'), tests.id('form_a'), array[tests.id('queue_a')], 'sms') $$,
  'P0001', 'invalid_input', 'unknown channel rejected');
select tests.as_postgres();
select is((select count(*)::int from app.form_targets t join app.forms f on f.id = t.form_id where f.name = 'Intake'), 2, 'exactly the two requested targets exist');
select is((select count(*)::int from app.form_targets where service_id = tests.id('service_a2')), 0, 'the refused batch attached nothing');

-- F6 (#1282): detach is the mirror of attach; widening accepts the legacy vocabulary.
select tests.act_as('staff');
select throws_ok($$ select api.detach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')]) $$,
  'P0001', 'not_found', 'staff cannot detach');
select tests.act_as('other_owner');
select throws_ok($$ select api.detach_form(tests.id('org_b'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')]) $$,
  'P0001', 'not_found', 'another organisation cannot detach');
select tests.act_as('manager');
select throws_ok($$ select api.detach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')], 'sms') $$,
  'P0001', 'invalid_input', 'unknown channel rejected');
select is(api.detach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a'), tests.id('n2')], 'walk_in'), 0,
  'a channel with no attachment removes nothing');
select is(api.detach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')]), 1, 'detach removes the queue attachment');
select is(api.detach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')]), 0, 'detaching again is a no-op');
select is(api.attach_form(tests.id('org_a'), (select id from app.forms where name = 'Intake'), array[tests.id('queue_a')]), 1, 'undo is attach with the same ids');
select tests.as_postgres();
select is((select count(*)::int from app.form_targets t join app.forms f on f.id = t.form_id where f.name = 'Intake'), 2, 'service attachment untouched by the queue detach');
select lives_ok($$ select private.validate_form_fields(
  '[{"key":"a","label":"A","type":"text","position":0},{"key":"b","label":"B","type":"select","options":["x"],"position":1},{"key":"c","label":"C","type":"checkbox","position":2}]') $$,
  'legacy types and position are accepted');

select * from finish();
rollback;
