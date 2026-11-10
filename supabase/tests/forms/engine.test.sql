-- F2 (#1278): queue default forms, resolve_form, get_join_form, join records the version, set_visit_answers.
begin;
\ir ../helpers/_setup.psql
select plan(26);
select tests.create_world();
select tests.new_id(k) from unnest(array['j1','j2','j3','j4','j5','s1','s2','f_svc','v_svc','queue_b','service_b','f_b','v_b']) k;

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
create function tests.join_with(p_key text, p_answers jsonb, p_service uuid default null) returns text
language sql as $$
  select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => p_service, p_name => 'Ann',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key), p_answers => p_answers)::text
$$;
grant execute on function tests.join_with(text, jsonb, uuid) to anon, authenticated;

delete from app.business_hours;
delete from app.intake_fields;

-- The fixture's intake field already made the default form; removing all fields publishes an empty version.
select is((select count(*)::int from app.forms where is_queue_default and org_id = tests.id('org_a')), 1, 'F2: intake fields become one queue default form');
select is((select fields from app.form_versions where id = private.resolve_form(tests.id('queue_a'), null)), '[]'::jsonb, 'with no fields the latest version is empty');

insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options, required, visibility, position) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'reason', 'Reason', 'select', '["cut","colour"]', true, 'guest', 1),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'triage', 'Triage', 'text', null, false, 'staff_only', 2);
select is((select count(*)::int from app.form_targets t join app.forms f on f.id = t.form_id
           where f.is_queue_default and t.queue_id = tests.id('queue_a') and t.channel = 'any'), 1, 'the default form is attached to the queue');
select is((select jsonb_array_length(fields) from app.form_versions where id = private.resolve_form(tests.id('queue_a'), null)), 2, 'resolve_form returns a version holding both active fields');
create temp table ver0 as select count(*)::int n from app.form_versions v join app.forms f on f.id = v.form_id where f.is_queue_default;

-- Join: version and answers recorded, staff-only refused for guests.
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.41"}', true);
select is(tests.error_detail($$ select tests.join_with('j1', '{}') $$), 'reason', 'a required guest field is enforced from the form');
select is(tests.error_detail($$ select tests.join_with('j1', '{"reason": "cut", "triage": "x"}') $$), 'triage', 'a guest cannot answer a staff_only field');
select lives_ok($$ select tests.join_with('j2', '{"reason": "cut"}') $$, 'a valid join succeeds');
select tests.as_postgres();
select is((select r.form_version_id from app.form_responses r join app.visits v on v.id = r.visit_id where v.idempotency_key = tests.id('j2')),
  private.resolve_form(tests.id('queue_a'), null), 'F2: the join records the form version');
select is((select r.answers from app.form_responses r join app.visits v on v.id = r.visit_id where v.idempotency_key = tests.id('j2')),
  '{"reason": "cut"}'::jsonb, 'and the answers');
select is((select answers from app.visit_answers a join app.visits v on v.id = a.visit_id where v.idempotency_key = tests.id('j2')),
  '{"reason": "cut"}'::jsonb, 'the legacy visit_answers row is still written (expand step)');

-- Editing the fields publishes version 2; the recorded version of the old visit does not move.
insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, required, visibility, position)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'note', 'Note', 'text', false, 'guest', 3);
select is((select count(*)::int from app.form_versions v join app.forms f on f.id = v.form_id where f.is_queue_default), (select n + 1 from ver0), 'an intake edit publishes a new version and keeps the old ones');
update app.intake_fields set label = 'Note' where key = 'note';
select is((select count(*)::int from app.form_versions v join app.forms f on f.id = v.form_id where f.is_queue_default), (select n + 1 from ver0), 'an edit that changes nothing publishes nothing');

-- get_join_form: guest-visible fields only, with the version.
create temp table rv as select private.resolve_form(tests.id('queue_a'), null) as id;
grant select on rv to anon;
select tests.as_anon();
select is((select jsonb_agg(e ->> 'key') from jsonb_array_elements(api.get_join_form(tests.id('queue_a')) -> 'fields') e),
  '["reason", "note"]'::jsonb, 'get_join_form lists guest fields in order, no staff_only');
select is((api.get_join_form(tests.id('queue_a')) ->> 'form_version_id')::uuid, (select id from rv), 'and the version a join would use');
select ok(api.get_join_form(tests.id('queue_a'))::text !~ '(triage|visibility|org_id|position)', 'nothing staff-only or internal leaks');
select throws_ok($$ select api.get_join_form(gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown queue is not_found');

-- A service form beats the queue form; another org's service form is never used.
select tests.as_postgres();
insert into app.forms (id, org_id, location_id, name, status) values (tests.id('f_svc'), tests.id('org_a'), tests.id('loc_a'), 'Haircut intake', 'published');
insert into app.form_versions (id, org_id, location_id, form_id, version, fields, published_at)
values (tests.id('v_svc'), tests.id('org_a'), tests.id('loc_a'), tests.id('f_svc'), 1, '[{"key":"len","label":"Length","type":"text","position":1}]', now());
insert into app.form_targets (org_id, location_id, form_id, service_id) values (tests.id('org_a'), tests.id('loc_a'), tests.id('f_svc'), tests.id('service_a'));
select is(private.resolve_form(tests.id('queue_a'), tests.id('service_a')), tests.id('v_svc'), 'a service target beats the queue target');
select is(private.resolve_form(tests.id('queue_a'), tests.id('service_a2')), private.resolve_form(tests.id('queue_a'), null), 'a service without a form falls back to the queue form');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values (tests.id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'B', 'B');
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes) values (tests.id('service_b'), tests.id('org_b'), tests.id('loc_b'), tests.id('queue_b'), 'Other', 10);
insert into app.forms (id, org_id, location_id, name, status) values (tests.id('f_b'), tests.id('org_b'), tests.id('loc_b'), 'Org B form', 'published');
insert into app.form_versions (id, org_id, location_id, form_id, version, fields, published_at)
values (tests.id('v_b'), tests.id('org_b'), tests.id('loc_b'), tests.id('f_b'), 1, '[{"key":"secret","label":"B only","type":"text","position":1}]', now());
insert into app.form_targets (org_id, location_id, form_id, service_id) values (tests.id('org_b'), tests.id('loc_b'), tests.id('f_b'), tests.id('service_b'));
select is(private.resolve_form(tests.id('queue_a'), tests.id('service_b')), private.resolve_form(tests.id('queue_a'), null), 'cross-tenant: another org''s service form is never resolved');
select tests.as_anon();
select ok(api.get_join_form(tests.id('queue_a'), tests.id('service_b'))::text !~ 'secret', 'cross-tenant: get_join_form never returns it');

-- set_visit_answers validates against the version recorded at join (v1 has no "note").
select tests.as_postgres();
create temp table v2 as select id, version from app.visits where idempotency_key = tests.id('j2');
grant select on v2 to authenticated;
select tests.act_as('staff');
select is(tests.error_detail($$ select api.set_visit_answers((select id from v2), '{"reason": "colour", "note": "x"}', (select version from v2), tests.id('s1')) $$),
  'note', 'F2: a field added after the join is unknown to the recorded version');
select lives_ok($$ select api.set_visit_answers((select id from v2), '{"reason": "colour", "triage": "urgent"}', (select version from v2), tests.id('s2')) $$,
  'staff may answer staff_only fields of the recorded version');
select tests.as_postgres();
select is((select answers from app.form_responses where visit_id = (select id from v2)), '{"reason": "colour", "triage": "urgent"}'::jsonb, 'and the response follows');

-- Erasure: anonymizing the visit removes its form response; a service of another queue is ignored.
select private.anonymize_visits(tests.id('org_a'), array[(select id from v2)]);
select is((select count(*)::int from app.form_responses where visit_id = (select id from v2)), 0, 'anonymizing a visit deletes its form response');
select tests.as_anon();
select is(api.get_join_form(tests.id('queue_a'), gen_random_uuid()), api.get_join_form(tests.id('queue_a')), 'an unknown service id is ignored');
select tests.as_postgres();
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values (gen_random_uuid(), tests.id('org_a'), tests.id('loc_a'), 'Q2', 'Z');
update app.intake_fields set queue_id = (select id from app.queues where name = 'Q2') where key = 'note';
select is((select count(*)::int from app.form_versions v join app.form_targets t on t.form_id = v.form_id
           where t.queue_id = tests.id('queue_a') and v.fields::text like '%"note"%' and v.version = (select max(version) from app.form_versions where form_id = v.form_id)), 0,
  'moving a field to another queue republishes the old queue''s form without it');

select * from finish();
rollback;
