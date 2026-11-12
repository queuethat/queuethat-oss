-- 2A-Q7 (#106): intake fields, answers validation in join, set_visit_answers.
begin;
\ir ../helpers/_setup.psql
select plan(30);
select tests.create_world();
select tests.new_id(k) from unnest(array['j1','j2','j3','j4','j5','j6','j7','j8','j9','j10','j11','s1','s2','s3','s4']) k;

/** The DETAIL of the error p_sql raises, or null when it succeeds. */
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

delete from app.business_hours;
delete from app.visit_answers;
delete from app.intake_fields;
insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options, required, visibility, position) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'reason', 'Reason', 'select', '["cut","colour"]', true, 'guest', 1),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'note', 'Note', 'text', null, false, 'guest', 2),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'mobile', 'Mobile', 'phone', null, false, 'guest', 3),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'age', 'Age', 'number', null, false, 'guest', 4),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'since', 'Since', 'date', null, false, 'guest', 5),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'agree', 'Agree', 'checkbox', null, false, 'guest', 6),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'triage', 'Triage', 'text', null, false, 'staff_only', 7);

create function tests.join_with(p_key text, p_answers jsonb) returns text
language sql as $$
  select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Ann',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key), p_answers => p_answers)::text
$$;
grant execute on function tests.join_with(text, jsonb) to anon, authenticated;

select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.31"}', true);

-- AC1: required select.
select is(tests.error_detail($$ select tests.join_with('j1', '{}') $$), 'reason', 'AC1: a missing required field names the key');
select throws_ok($$ select tests.join_with('j1', '{}') $$, 'P0001', 'invalid_answers', 'and raises invalid_answers');
select is(tests.error_detail($$ select tests.join_with('j2', '{"reason": "perm"}') $$), 'reason', 'AC1: an option outside the list names the key');
select is(tests.error_detail($$ select tests.join_with('j3', '{"reason": "cut", "bogus": 1}') $$), 'bogus', 'an unknown key is rejected');
-- AC2: staff-only.
select is(tests.error_detail($$ select tests.join_with('j4', '{"reason": "cut", "triage": "urgent"}') $$), 'triage',
  'AC2: a guest cannot answer a staff-only field');
-- Types.
select is(tests.error_detail(format($q$ select tests.join_with('j5', %L) $q$, jsonb_build_object('reason', 'cut', 'note', repeat('x', 501))::text)), 'note', 'text is limited to 500 characters');
select is(tests.error_detail($$ select tests.join_with('j5', '{"reason": "cut", "mobile": "12"}') $$), 'mobile', 'a short phone is rejected');
select is(tests.error_detail($$ select tests.join_with('j5', '{"reason": "cut", "age": "ten"}') $$), 'age', 'a number must be a number');
select is(tests.error_detail($$ select tests.join_with('j5', '{"reason": "cut", "since": "2026-02-31"}') $$), 'since', 'an impossible date is rejected');
select is(tests.error_detail($$ select tests.join_with('j5', '{"reason": "cut", "agree": "yes"}') $$), 'agree', 'a checkbox must be a boolean');
select is(tests.error_detail($$ select tests.join_with('j5', '[1]') $$), '', 'answers must be an object');

select is(tests.error_detail($$ select tests.join_with('j5', '{"reason": "   "}') $$), 'reason', 'a blank-looking required answer counts as missing');
select is(tests.error_detail($$ select tests.join_with('j5', '{"reason": "cut", "Bad Key!": 1}') $$), '', 'an arbitrary unknown key is not echoed');
select is(tests.error_detail($$ select tests.join_with('j5', 'null') $$), 'reason', 'a JSON null is treated as no answers');

-- A good join stores normalised answers.
select lives_ok($$ select tests.join_with('j6', '{"reason": "colour", "note": "  hi  ", "mobile": "+1 (415) 555-0123", "age": 31, "since": "2026-01-02", "agree": true}') $$,
  'a valid join with every type is accepted') ;
select tests.as_postgres();
select is((select answers from app.visit_answers a join app.visits v on v.id = a.visit_id where v.idempotency_key = tests.id('j6')),
  '{"reason": "colour", "note": "hi", "mobile": "+14155550123", "age": 31, "since": "2026-01-02", "agree": true}'::jsonb,
  'answers are stored trimmed and normalised (phone as E.164)');
select is((select count(*)::int from app.visit_answers), 1, 'failed joins stored nothing');

-- AC3: a guest never sees answers.
select tests.as_anon();
select is((select position('colour' in api.get_visit_status((select token from (select (api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Bea',
  p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null, p_idempotency_key => tests.id('j7'),
  p_answers => '{"reason": "cut", "note": "private-note-text"}')).token as token) t))::text)), 0,
  'AC3: get_visit_status carries no answers');
select tests.as_postgres();

-- Staff add skips the required check.
select tests.act_as('staff');
select lives_ok($$ select api.staff_add_visit(tests.id('queue_a'), null, 'Walk-in', null, 1, tests.id('j8')) $$,
  'a staff add without intake answers is not blocked by required fields');

-- set_visit_answers: staff may answer any field, replacing the set.
select tests.as_postgres();
create temp table v6 as select id, version from app.visits where idempotency_key = tests.id('j6');
grant select on v6 to authenticated;
select tests.act_as('staff');
select lives_ok($$ select api.set_visit_answers((select id from v6), '{"reason": "cut", "triage": "urgent"}', (select version from v6), tests.id('s1')) $$,
  'staff set answers, including a staff-only field');
select tests.as_postgres();
select is((select answers from app.visit_answers where visit_id = (select id from v6)),
  '{"reason": "cut", "triage": "urgent"}'::jsonb, 'the answers were replaced');
select is((select payload from app.visit_events where visit_id = (select id from v6) and type = 'answers_updated'),
  '{"keys": ["reason", "triage"]}'::jsonb, 'the event names the keys only, never the values');
select is((select count(*)::int from app.audit_log where after::text like '%urgent%'), 0, 'the audit log never copies answers');
select tests.act_as('staff');
select throws_ok($$ select api.set_visit_answers((select id from v6), '{}', 0, tests.id('s2')) $$,
  'P0001', 'stale_visit', 'a stale version is rejected');
select throws_ok($$ select api.set_visit_answers((select id from v6), '{"nope": 1}', (select version from app.staff_visits where id = (select id from v6)), tests.id('s3')) $$,
  'P0001', 'invalid_answers', 'unknown keys are rejected for staff too');
select is((api.set_visit_answers((select id from v6), '{"reason": "cut", "triage": "urgent"}', 0, tests.id('s1'))).id, (select id from v6),
  'repeating a key returns the first result');

-- AC4 / cross tenant.
select tests.act_as('other_owner');
select throws_ok($$ select api.set_visit_answers((select id from v6), '{}', 0, gen_random_uuid()) $$,
  'P0001', 'not_found', 'org B cannot set org A answers');
select throws_ok($$ select count(*) from app.visit_answers $$, '42501', null, 'AC4: org B cannot read answers rows directly (F7b)');

-- Guest-visible questions never include staff-only fields.
select tests.as_postgres();
select ok(private.guest_intake_fields(tests.id('queue_a')) @> '[{"key": "reason", "required": true}]', 'guests are asked the guest fields');
select ok(not private.guest_intake_fields(tests.id('queue_a')) @> '[{"key": "triage"}]', 'but never the staff-only ones');

select * from finish();
rollback;
