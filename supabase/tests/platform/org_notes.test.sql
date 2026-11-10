-- #1135: internal platform notes and tags per tenant. Support and operators (aal2) read and write
-- them through the api; tenants, devices and anon can't reach them by any path; edits keep
-- history; every write is audited without the note text.
begin;
\ir ../helpers/_setup.psql
select plan(82);
select tests.create_world();

select tests.create_user('support');
select tests.create_user('support2');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support'), (tests.id('support2'), 'support');
insert into tests.actors values
  ('support', 'authenticated', jsonb_build_object('sub', tests.id('support'), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2')),
  ('support2', 'authenticated', jsonb_build_object('sub', tests.id('support2'), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2'));
create table tests.keep (name text primary key, id uuid, ver uuid);
grant all on tests.keep to authenticated;

-- ------------------------------------------------------------------ roles and MFA
select tests.act_as('support');
select lives_ok($$ insert into tests.keep select 'a', n.id, n.version_id
  from api.platform_add_note(tests.id('org_a'), 'Promised a credit on the next invoice', array['billing-issue', 'pilot']) n $$,
  'support adds a note');
select is((select author_email from api.platform_list_notes(tests.id('org_a')) where id = (select id from tests.keep where name = 'a')),
  'support@test.local', 'the note names its author');
select tests.act_as('platform');
select lives_ok($$ select api.platform_add_note(tests.id('org_a'), 'Onboarding call booked for Friday', array['pilot']) $$,
  'an operator adds a note');

-- AC: a second agent opening the tenant sees the earlier notes and tags.
select tests.act_as('support2');
select results_eq($$ select body from api.platform_list_notes(tests.id('org_a')) where body <> 'fixture note' order by body $$,
  $$ values ('Onboarding call booked for Friday'), ('Promised a credit on the next invoice') $$,
  'a second agent sees both notes, newest first order aside');
select results_eq($$ select tags from api.platform_list_notes(tests.id('org_a')) where body like 'Promised%' $$,
  $$ values (array['billing-issue', 'pilot']) $$, 'and the tags');
select is((select count(*) from api.platform_list_notes(tests.id('org_b'))), 0::bigint, 'another tenant has none (notes do not cross orgs)');

-- MFA: an aal1 session of either role is denied everything.
select tests.as_user(tests.id('platform'), '{"aal":"aal1"}');
select throws_ok($$ select api.platform_list_notes(tests.id('org_a')) $$, '42501', 'permission_denied', 'operator at aal1 cannot list');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x') $$, '42501', 'permission_denied', 'operator at aal1 cannot add');
select throws_ok($$ select api.platform_tagged_orgs() $$, '42501', 'permission_denied', 'operator at aal1 cannot list tagged orgs');
select tests.as_user(tests.id('support'), '{"aal":"aal1"}');
select throws_ok($$ select api.platform_list_notes(tests.id('org_a')) $$, '42501', 'permission_denied', 'support at aal1 cannot list');
select is((select count(*) from app.platform_org_notes), 0::bigint, 'support at aal1 reads no rows directly');
select tests.as_user(tests.id('support'));
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x') $$, '42501', 'permission_denied', 'a JWT without an aal claim is denied');

-- ------------------------------------------------------------------ tenants and anon never read
select tests.act_as('owner');
select is((select count(*) from app.platform_org_notes), 0::bigint, 'an org owner reads no notes about their own org');
select throws_ok($$ select api.platform_list_notes(tests.id('org_a')) $$, '42501', 'permission_denied', 'the owner cannot list through the api');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x') $$, '42501', 'permission_denied', 'the owner cannot add');
select throws_ok($$ select api.platform_tagged_orgs() $$, '42501', 'permission_denied', 'the owner cannot list tagged orgs');
select throws_ok($$ insert into app.platform_org_notes (id, org_id, root_id, version, body)
  values (gen_random_uuid(), tests.id('org_a'), gen_random_uuid(), 1, 'x') $$, '42501', null, 'the owner cannot insert directly');
select tests.act_as('other_owner');
select is((select count(*) from app.platform_org_notes), 0::bigint, 'another org''s owner reads none');
select tests.as_user(tests.id('owner'), '{"aal":"aal2"}');
select is((select count(*) from app.platform_org_notes), 0::bigint, 'an owner with an aal2 session still reads none');
select tests.act_as('staff');
select is((select count(*) from app.platform_org_notes), 0::bigint, 'staff read none');
select tests.act_as('display');
select is((select count(*) from app.platform_org_notes), 0::bigint, 'a paired screen reads none');
select tests.as_anon();
select throws_ok($$ select count(*) from app.platform_org_notes $$, '42501', null, 'anon has no table access');
select throws_ok($$ select api.platform_list_notes(tests.id('org_a')) $$, '42501', null, 'anon cannot call list');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x') $$, '42501', null, 'anon cannot call add');
select throws_ok($$ select api.platform_tagged_orgs() $$, '42501', null, 'anon cannot call tagged orgs');

-- Org detail (the one tenant read platform staff already have) never carries notes.
select tests.act_as('support');
select ok(to_jsonb(api.platform_get_org(tests.id('org_a')))::text not like '%Promised a credit%', 'org detail carries no note text');
select tests.as_postgres();
select is((select count(*) from app.audit_log where (before::text || coalesce(after::text, '')) like '%Promised a credit%'),
  0::bigint, 'the tenant audit_log holds no note text');

-- ------------------------------------------------------------------ validation and edge cases
select tests.act_as('support');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), '') $$, 'P0001', 'invalid_input', 'an empty note is rejected');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), E'  \n\t ') $$, 'P0001', 'invalid_input', 'a whitespace-only note is rejected');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), null) $$, 'P0001', 'invalid_input', 'a null note is rejected');
select is((select length(body) from api.platform_add_note(tests.id('org_a'), repeat('x', 4000))), 4000, 'a 4000-character note is stored whole');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), repeat('x', 4001)) $$, 'P0001', 'invalid_input', 'a 4001-character note is rejected');
select is((select body from api.platform_add_note(tests.id('org_a'), E'  padded  ')), 'padded', 'the body is trimmed');
select is((select tags from api.platform_add_note(tests.id('org_a'), 'dupes', array['VIP', 'vip', ' Vip ', 'pilot', 'pilot'])),
  array['pilot', 'vip'], 'duplicate and mixed-case tags collapse to one sorted set');
select is((select tags from api.platform_add_note(tests.id('org_a'), 'null tags', null)), '{}'::text[], 'null tags mean no tags');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', array['ok', null]) $$, 'P0001', 'invalid_input', 'a null tag is rejected');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', array['has space']) $$, 'P0001', 'invalid_input', 'a tag with a space is rejected');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', array['']) $$, 'P0001', 'invalid_input', 'an empty tag is rejected');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', array[repeat('a', 31)]) $$, 'P0001', 'invalid_input', 'a 31-character tag is rejected');
select lives_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', array[repeat('a', 30)]) $$, 'a 30-character tag is fine');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', array['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10','t11']) $$,
  'P0001', 'invalid_input', 'more than 10 tags are rejected');
select throws_ok($$ select api.platform_add_note(gen_random_uuid(), 'x') $$, 'P0001', 'not_found', 'an unknown org is not_found');
select throws_ok($$ select api.platform_list_notes(gen_random_uuid()) $$, 'P0001', 'not_found', 'listing an unknown org is not_found');
select throws_ok($$ select api.platform_tagged_orgs(array['bad tag']) $$, 'P0001', 'invalid_input', 'filtering by a bad tag is rejected');

-- Idempotency: a double click stores one note.
select lives_ok($$ select api.platform_add_note(tests.id('org_a'), 'retry me', '{}', null, '11111111-1111-1111-1111-111111111111') $$, 'first call');
select is((select count(*) from api.platform_add_note(tests.id('org_a'), 'retry me', '{}', null, '11111111-1111-1111-1111-111111111111')), 1::bigint, 'repeat call returns the row');
select tests.as_postgres();
select is((select count(*) from app.platform_org_notes where body = 'retry me'), 1::bigint, 'the repeated key stored one note');

-- ------------------------------------------------------------------ edits keep history
select tests.act_as('support');
select is((select version from api.platform_add_note(tests.id('org_a'), 'Credit issued', array['pilot'], (select id from tests.keep where name = 'a'))),
  2, 'the author edits their own note: version 2');
select is((select count(*) from api.platform_list_notes(tests.id('org_a')) where id = (select id from tests.keep where name = 'a')),
  1::bigint, 'the list shows only the current version');
select is((select body from api.platform_list_notes(tests.id('org_a')) where id = (select id from tests.keep where name = 'a')),
  'Credit issued', 'and it is the new text');
select is((select count(*) from api.platform_list_notes(tests.id('org_a'), true) where id = (select id from tests.keep where name = 'a')),
  2::bigint, 'history lists both versions');
select is((select count(*) from api.platform_add_note(tests.id('org_a'), 'Credit issued', array['pilot'], (select id from tests.keep where name = 'a'))), 1::bigint,
  'saving the same text again returns the row');
select tests.as_postgres();
select is((select count(*) from app.platform_org_notes where root_id = (select id from tests.keep where name = 'a')), 2::bigint, 'and writes no third version');
select tests.act_as('support2');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'hijack', '{}', (select id from tests.keep where name = 'a')) $$,
  '42501', 'permission_denied', 'support cannot edit another agent''s note');
select tests.act_as('platform');
select is((select version from api.platform_add_note(tests.id('org_a'), 'Operator correction', '{}', (select id from tests.keep where name = 'a'))), 3,
  'an operator edits anyone''s note');
select throws_ok($$ select api.platform_add_note(tests.id('org_b'), 'x', '{}', (select id from tests.keep where name = 'a')) $$,
  'P0001', 'not_found', 'a note id from another tenant is not_found');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', '{}', gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown note id is not_found');
select throws_ok($$ select api.platform_add_note(tests.id('org_a'), 'x', '{}', (select version_id from api.platform_list_notes(tests.id('org_a'), true) where id = (select id from tests.keep where name = 'a') and version = 2)) $$,
  'P0001', 'not_found', 'only a note''s stable id edits it, not a version id');

-- ------------------------------------------------------------------ append-only
select tests.as_postgres();
select throws_ok($$ update app.platform_org_notes set body = 'tampered' $$, '42501', 'platform_org_notes is append-only', 'even the owner role cannot update a note');
select throws_ok($$ delete from app.platform_org_notes $$, '42501', 'platform_org_notes is append-only', 'or delete one');
select throws_ok($$ truncate app.platform_org_notes $$, '42501', 'platform_org_notes is append-only', 'or truncate');
select tests.act_as('platform');
select throws_ok($$ update app.platform_org_notes set body = 'x' $$, '42501', null, 'an operator cannot update directly');
select throws_ok($$ delete from app.platform_org_notes $$, '42501', null, 'an operator cannot delete directly');
select tests.as_service();
select throws_ok($$ delete from app.platform_org_notes $$, '42501', null, 'the service role cannot delete');

-- ------------------------------------------------------------------ tags in the directory and attention
select tests.act_as('support');
select is((select count(*) from api.platform_tagged_orgs()), 1::bigint, 'only tenants with tagged notes are listed');
select is((select needs_attention from api.platform_tagged_orgs()), false,
  'after the edit dropped billing-issue, the tenant no longer needs attention');
select is((select count(*) from api.platform_tagged_orgs(array['VIP'])), 1::bigint, 'filter by a tag, case-insensitively');
select is((select count(*) from api.platform_tagged_orgs(array['churn-risk'])), 0::bigint, 'filter by an absent tag');
select is((select count(*) from api.platform_tagged_orgs('{}')), 1::bigint, 'an empty filter means any tag');
select lives_ok($$ select api.platform_add_note(tests.id('org_b'), 'Threatening to cancel', array['churn-risk']) $$, 'org B gets a churn-risk note');
select results_eq($$ select org_id from api.platform_tagged_orgs() $$, $$ select tests.id('org_b') union all select tests.id('org_a') $$,
  'attention tenants come first');
select is((select notes from api.platform_tagged_orgs(array['churn-risk'])), 1, 'the row counts current notes');

-- ------------------------------------------------------------------ audit
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action = 'org_note.add' and org_id = tests.id('org_a')),
  (select count(*) - 1 from app.platform_org_notes where org_id = tests.id('org_a') and version = 1),
  'every new note is audited once (repeats and same-text saves are not; the fixture is not)');
select is((select count(*) from app.platform_audit where action = 'org_note.edit'),
  (select count(*) from app.platform_org_notes where version > 1), 'every edit is audited once');
select is((select count(*) from app.platform_audit where target::text like '%Promised%' or target::text like '%Operator correction%' or reason like '%Promised%'),
  0::bigint, 'the audit never holds note text');
select is((select actor_id from app.platform_audit where action = 'org_note.edit' order by id desc limit 1), tests.id('platform'),
  'the audit names the editing operator');

-- ------------------------------------------------------------------ a purged org takes its notes with it
select tests.act_as('other_owner');
select lives_ok($$ select api.request_org_deletion(tests.id('org_b'), (select slug from app.locations where org_id = tests.id('org_b') order by created_at limit 1)) $$, 'org B''s owner requests deletion');
select tests.act_as('platform');
select is((select count(*) from api.platform_list_notes(tests.id('org_b'))), 1::bigint, 'a pending_deletion tenant''s notes stay readable');
select tests.as_postgres();
update app.organizations set deletion_scheduled_for = now() - interval '1 minute', external_purged_at = now() where id = tests.id('org_b');
select is(ops.purge_deleted_orgs(), 1, 'the purge removes the org');
select is((select count(*) from app.platform_org_notes where org_id = tests.id('org_b')), 0::bigint, 'and its notes with it');
select is((select count(*) from app.platform_org_notes where org_id = tests.id('org_a')), (select count(*) from app.platform_org_notes where org_id = tests.id('org_a')),
  'other tenants'' notes are untouched');
select tests.act_as('platform');
select throws_ok($$ select api.platform_list_notes(tests.id('org_b')) $$, 'P0001', 'not_found', 'a purged org is not_found');
select * from finish();
rollback;
