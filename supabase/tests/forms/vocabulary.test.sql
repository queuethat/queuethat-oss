-- #1326: one field vocabulary across the forms engine (join answers, get_join_form, library validator).
begin;
\ir ../helpers/_setup.psql
select plan(31);
select tests.create_world();
select tests.new_id(k) from unnest(array['lib_form', 'lib_ver', 'jl1', 'jl2']) k;

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

-- A form with every library type (heading, staff-only note, required choice) in array order.
create temp table lib as select '[
  {"key":"intro","label":"About you","type":"heading"},
  {"key":"reason","label":"Reason","type":"short_text","required":true},
  {"key":"story","label":"Story","type":"long_text"},
  {"key":"pick","label":"Pick one","type":"single_choice","options":["a","b"]},
  {"key":"many","label":"Pick any","type":"multi_choice","options":["x","y","z"]},
  {"key":"ok","label":"Fine?","type":"yes_no"},
  {"key":"age","label":"Age","type":"number"},
  {"key":"dob","label":"Birthday","type":"date"},
  {"key":"cell","label":"Phone","type":"phone"},
  {"key":"mail","label":"Email","type":"email"},
  {"key":"mkt","label":"Send offers","type":"marketing_consent"},
  {"key":"triage","label":"Triage","type":"short_text","visibility":"staff_only"}
]'::jsonb as f;
grant select on lib to anon, authenticated;

-- 1 to 8: every library type validates and is normalised (issue point 2).
select is(private.validate_form_answers(tests.id('org_a'), (select f from lib),
  '{"reason":" sore knee ","story":"line1\nline2","pick":"b","many":["x","z"],"ok":false,"age":42,"dob":"2001-02-03","cell":"+1 (204) 555-0100","mail":" a@b.co ","mkt":true}', 'guest'),
  '{"reason":"sore knee","story":"line1\nline2","pick":"b","many":["x","z"],"ok":false,"age":42,"dob":"2001-02-03","cell":"+12045550100","mail":"a@b.co","mkt":true}'::jsonb,
  'every library type is accepted and normalised');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{}', 'guest') $$), 'reason', 'a required library field is enforced');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","pick":"c"}', 'guest') $$), 'pick', 'single_choice refuses a value outside the options');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","many":["x","q"]}', 'guest') $$), 'many', 'multi_choice refuses a value outside the options');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","many":["x","x"]}', 'guest') $$), 'many', 'multi_choice refuses a repeated value');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","mail":"not-an-email"}', 'guest') $$), 'mail', 'email must look like an address');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","intro":"hi"}', 'guest') $$), 'intro', 'a heading takes no answer');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","triage":"y"}', 'guest') $$), 'triage', 'a guest cannot answer a staff_only library field');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","story":"4111 1111 1111 1111"}', 'guest') $$), 'story', 'long_text refuses a card number');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), jsonb_build_object('reason','x','story',repeat('a',1001)), 'guest') $$), 'story', 'long_text is capped at 1000 characters');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","story":"4111 1111\n1111 1111"}', 'guest') $$), 'story', 'a card number split by a newline is refused');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","mail":"4111111111111111@x.co"}', 'guest') $$), 'mail', 'email refuses a card number');
select is(private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"reason":"x","mkt":false,"many":[],"mail":""}', 'guest'),
  '{"reason":"x"}'::jsonb, 'blank, empty-list and unticked consent count as not answered');
select is(private.validate_form_answers(tests.id('org_a'), (select f from lib), '{"triage":"urgent"}', 'staff'),
  '{"triage":"urgent"}'::jsonb, 'staff may answer any field and nothing is required');

-- Legacy names read as aliases; a required checkbox still has to be ticked.
create temp table legacy as select '[
  {"key":"a","label":"A","type":"text","position":2},
  {"key":"b","label":"B","type":"select","options":["p","q"],"position":1},
  {"key":"c","label":"C","type":"checkbox","required":true,"position":3}
]'::jsonb as f;
grant select on legacy to anon, authenticated;
select is(private.validate_form_answers(tests.id('org_a'), (select f from legacy), '{"a":"t","b":"q","c":true}', 'guest'),
  '{"a":"t","b":"q","c":true}'::jsonb, 'legacy text/select/checkbox answers validate');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from legacy), '{"a":"t","c":false}', 'guest') $$), 'c', 'a required legacy checkbox must still be ticked');
select is(private.normalize_form_fields((select f from legacy)) -> 2, '{"key":"c","label":"C","type":"yes_no","required":true,"must_be_true":true}'::jsonb, 'normalisation maps the type and drops position');

-- Library validator accepts the aliases and position (issue point 1) and rejects the rest.
select lives_ok($$ select private.validate_form_fields((select f from legacy)) $$, 'validate_form_fields accepts legacy names and position');
select lives_ok($$ select private.validate_form_fields((select f from lib)) $$, 'and the library vocabulary');
select throws_ok($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"text","position":"x"}]') $$, 'P0001', 'invalid_input', 'a non-numeric position is refused');
select throws_ok($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"short_text","must_be_true":true}]') $$, 'P0001', 'invalid_input', 'must_be_true is for yes_no only');
select throws_ok($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"banana"}]') $$, 'P0001', 'invalid_input', 'an unknown type is refused');

-- Queue default form from intake fields is canonical and republishable (issue point 1).
select tests.as_postgres();
delete from app.business_hours;
delete from app.intake_fields;
insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options, required, visibility, position) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'zed', 'Zed', 'text', null, false, 'guest', 2),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'why', 'Why', 'select', '["cut","colour"]', true, 'guest', 1);
select is((select jsonb_agg(e ->> 'type' order by o) from app.form_versions v, jsonb_array_elements(v.fields) with ordinality t(e, o)
           where v.id = private.resolve_form(tests.id('queue_a'), null)), '["single_choice", "short_text"]'::jsonb,
  'intake_snapshot publishes canonical types in position order');
select ok(not exists (select 1 from app.form_versions v, jsonb_array_elements(v.fields) e
           where v.id = private.resolve_form(tests.id('queue_a'), null) and e ? 'position'), 'and no position key');

-- A library form attached to the queue: get_join_form orders by array index (issue point 3).
insert into app.forms (id, org_id, location_id, name, status) values (tests.id('lib_form'), tests.id('org_a'), tests.id('loc_a'), 'Library', 'published');
insert into app.form_versions (id, org_id, location_id, form_id, version, fields, published_at)
values (tests.id('lib_ver'), tests.id('org_a'), tests.id('loc_a'), tests.id('lib_form'), 1, (select f from lib), now());
update app.form_targets set form_id = tests.id('lib_form') where queue_id = tests.id('queue_a') and channel = 'any';
select is(private.resolve_form(tests.id('queue_a'), null), tests.id('lib_ver'), 'the library form is what a walk-in resolves');
select tests.as_anon();
select is((select jsonb_agg(e ->> 'key') from jsonb_array_elements(api.get_join_form(tests.id('queue_a')) -> 'fields') e),
  '["intro","reason","story","pick","many","ok","age","dob","cell","mail","mkt"]'::jsonb, 'get_join_form follows array order, headings in, staff_only out');
select ok(api.get_join_form(tests.id('queue_a'))::text !~ '(triage|position|visibility)', 'nothing internal leaks');

-- A library form with short_text no longer breaks anon join (issue point 2), and a bad answer still fails.
select set_config('request.headers', '{"x-real-ip": "198.51.100.52"}', true);
select lives_ok($$ select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Ann', p_phone_e164 => null, p_email => null,
  p_party_size => 1, p_locale => null, p_idempotency_key => tests.id('jl1'), p_answers => '{"reason":"knee","pick":"a","many":["y"],"ok":true}') $$,
  'anon join works against a library form');
select is(tests.error_detail($$ select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Bob', p_phone_e164 => null, p_email => null,
  p_party_size => 1, p_locale => null, p_idempotency_key => tests.id('jl2'), p_answers => '{"pick":"a"}') $$), 'reason', 'and its required field is enforced');
select tests.as_postgres();
select is((select answers from app.form_responses r join app.visits v on v.id = r.visit_id where v.idempotency_key = tests.id('jl1')),
  '{"reason":"knee","pick":"a","many":["y"],"ok":true}'::jsonb, 'the answers are recorded against the library version');

-- Backfill: a legacy-shaped queue default form is republished canonical by sync (no mutation of the old version).
select tests.as_postgres();
update app.form_targets set form_id = (select id from app.forms where is_queue_default and org_id = tests.id('org_a') limit 1)
  where queue_id = tests.id('queue_a') and channel = 'any';
select is((select count(*)::int from app.form_versions v join app.forms f on f.id = v.form_id
           where f.is_queue_default and jsonb_path_exists(v.fields, '$[*] ? (@.type == "text" || @.type == "select" || @.type == "checkbox")') and v.version = (select max(version) from app.form_versions where form_id = f.id)),
  0, 'no queue default form is left with a legacy latest version');
select * from finish();
rollback;
