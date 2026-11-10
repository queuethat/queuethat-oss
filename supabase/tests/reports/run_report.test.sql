-- 4-RPT1 (#392): api.run_report and app.report_definitions.
-- AC1 unknown measure or SQL fragment -> invalid_report_definition; AC2 org B manager sees only org B;
-- AC3 guest_name (or any contact field) as a dimension is rejected.
begin;
\ir ../helpers/_setup.psql
select plan(33);
select tests.create_world();

-- Three served visits (waits 5, 15 and 10 min; services 10 and 20 min), one no-show, in queue A.
select tests.as_postgres();
select tests.new_visit('rv1', 'queue_a', 'Alice Secret');
select tests.new_visit('rv2', 'queue_a', 'Bob Secret');
select tests.new_visit('rv3', 'queue_a', 'Cy Secret');
select tests.new_visit('rv4', 'queue_a', 'Di Secret');
alter table app.visits disable trigger user;
update app.visits set status = 'served', service_day = date '2026-03-02', joined_at = '2026-03-02 10:00+00',
  called_at = '2026-03-02 10:05+00', serving_at = '2026-03-02 10:06+00', finished_at = '2026-03-02 10:16+00',
  eta_quoted_low = 1, eta_quoted_high = 3 where id = tests.id('rv1');
update app.visits set status = 'served', service_day = date '2026-03-03', joined_at = '2026-03-03 10:00+00',
  called_at = '2026-03-03 10:15+00', serving_at = '2026-03-03 10:16+00', finished_at = '2026-03-03 10:36+00',
  eta_quoted_low = 10, eta_quoted_high = 20 where id = tests.id('rv2');
update app.visits set status = 'served', service_day = date '2026-03-03', joined_at = '2026-03-03 11:00+00',
  called_at = '2026-03-03 11:10+00' where id = tests.id('rv3');
update app.visits set status = 'no_show', service_day = date '2026-03-03', joined_at = '2026-03-03 12:00+00'
  where id = tests.id('rv4');
alter table app.visits enable trigger user;

create temp table def as select jsonb_build_object('org_id', tests.id('org_a'),
  'measures', jsonb_build_array('visits', 'served', 'avg_wait_min', 'avg_service_min', 'no_show_pct', 'eta_error_min'),
  'dimensions', jsonb_build_array('service_day')) as j;
grant all on def to public;

select tests.as_user(tests.id('manager'));
select results_eq($$ select dims ->> 'service_day', measures ->> 'visits', measures ->> 'served' from api.run_report((select j from def), date '2026-03-01', date '2026-03-31') $$,
  $$ values ('2026-03-02', '1', '1'), ('2026-03-03', '3', '2') $$, 'groups by service day; counts visits and served');
select results_eq($$ select (measures ->> 'avg_wait_min')::numeric, (measures ->> 'avg_service_min')::numeric from api.run_report((select j from def), date '2026-03-03', date '2026-03-03') $$,
  $$ values (12.5, 20.0) $$, 'average wait is over called visits, average service over finished ones');
select results_eq($$ select (measures ->> 'no_show_pct')::numeric from api.run_report((select j from def), date '2026-03-03', date '2026-03-03') $$,
  $$ values (33.3) $$, 'no-show percent of all visits that day');
select results_eq($$ select (measures ->> 'eta_error_min')::numeric from api.run_report((select j from def), date '2026-03-02', date '2026-03-02') $$,
  $$ values (2.0) $$, 'ETA error is the distance outside the quoted range (waited 5, high 3)');
select is((select count(*)::int from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb), date '2026-03-01', date '2026-03-31')),
  1, 'no dimensions gives one row');
select results_eq($$ select dims ->> 'weekday', measures ->> 'visits' from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'dimensions', '["weekday"]'::jsonb), date '2026-03-01', date '2026-03-31') order by 1 $$,
  $$ values ('1', '1'), ('2', '3') $$, 'weekday is ISO (Monday = 1)');
select results_eq($$ select dims ->> 'queue', dims ->> 'location', measures ->> 'visits' from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'dimensions', '["queue","location"]'::jsonb, 'filters', jsonb_build_object('queue_id', tests.id('queue_a'))), date '2026-03-01', date '2026-03-31') $$,
  $$ select q.name, l.name, 4::text from app.queues q join app.locations l on l.id = q.location_id where q.id = tests.id('queue_a') $$, 'queue and location dimensions with a queue filter');
select is((select count(*)::int from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'dimensions', '["hour"]'::jsonb), date '2026-03-01', date '2026-03-31')),
  3, 'hour dimension: three distinct local hours');

-- AC1: unknown measure, unknown dimension, SQL fragments, shape errors.
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits; drop table app.visits"]'::jsonb), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'AC1: a SQL fragment as a measure is rejected');
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["revenue"]'::jsonb), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'AC1: an unknown measure is rejected');
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'dimensions', '["service_day\") x; select pg_sleep(1) --"]'::jsonb), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'AC1: a SQL fragment as a dimension is rejected');
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'filters', '{"queue_id": "x'' or 1=1 --"}'::jsonb), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'AC1: a filter value that is not a uuid is rejected');
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'filters', '{"1=1) or (1": "x"}'::jsonb), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'AC1: an unknown filter key is rejected');
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '["visits"]'::jsonb, 'where', '1=1'), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'AC1: an unknown top-level key is rejected');
select throws_ok($$ select * from api.run_report(jsonb_build_object('org_id', tests.id('org_a'), 'measures', '[]'), date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'at least one measure is required');
select throws_ok($$ select * from api.run_report('[]'::jsonb, date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'a definition must be an object');
select throws_ok($$ select * from api.run_report('{"measures": ["visits"]}'::jsonb, date '2026-03-01', date '2026-03-02') $$,
  'P0001', 'invalid_report_definition', 'running needs an org_id');

-- AC3: contact and guest fields are never a dimension.
select throws_ok(format($$ select * from api.run_report(jsonb_build_object('org_id', %L::uuid, 'measures', '["visits"]'::jsonb, 'dimensions', '["guest_name"]'::jsonb), date '2026-03-01', date '2026-03-02') $$, tests.id('org_a')),
  'P0001', 'invalid_report_definition', 'AC3: guest_name as a dimension is rejected');
select throws_ok(format($$ select * from api.run_report(jsonb_build_object('org_id', %L::uuid, 'measures', '["visits"]'::jsonb, 'dimensions', '["contact_id"]'::jsonb), date '2026-03-01', date '2026-03-02') $$, tests.id('org_a')),
  'P0001', 'invalid_report_definition', 'AC3: contact_id as a dimension is rejected');

-- Ranges.
select throws_ok($$ select * from api.run_report((select j from def), date '2026-03-05', date '2026-03-01') $$,
  'P0001', 'range_too_large', 'an inverted range is refused');
select throws_ok($$ select * from api.run_report((select j from def), date '2025-01-01', date '2026-03-01') $$,
  'P0001', 'range_too_large', 'a range over 400 days is refused');

-- Roles and tenants.
select tests.as_postgres();
select tests.as_user(tests.id('staff'));
select throws_ok($$ select * from api.run_report((select j from def), date '2026-03-01', date '2026-03-31') $$,
  '42501', null, 'staff cannot run reports');
select tests.as_postgres();
select tests.as_user(tests.id('other_owner'));
select throws_ok($$ select * from api.run_report((select j from def), date '2026-03-01', date '2026-03-31') $$,
  'P0001', 'not_found', 'AC2: org B cannot run a report against org A');
select is((select count(*)::int from api.run_report(jsonb_build_object('org_id', tests.id('org_b'), 'measures', '["visits"]'::jsonb, 'dimensions', '["service_day"]'::jsonb), date '2026-03-01', date '2026-03-31')),
  0, 'AC2: org B''s own report aggregates none of org A''s visits');
select throws_ok(format($$ select * from api.run_report(jsonb_build_object('org_id', %L::uuid, 'measures', '["visits"]'::jsonb, 'filters', jsonb_build_object('location_id', %L::uuid)), date '2026-03-01', date '2026-03-31') $$, tests.id('org_b'), tests.id('loc_a')),
  'P0001', 'not_found', 'AC2: org A''s location id under org B''s scope is not found');

-- Hardening: definer with a pinned search path and a statement timeout; anon cannot run it.
select tests.as_postgres();
select ok((select prosecdef and 'statement_timeout=5s' = any (proconfig) and 'search_path=""' = any (proconfig) from pg_proc where oid = 'api.run_report(jsonb, date, date)'::regprocedure),
  'run_report is a definer with search_path pinned and a 5 s statement timeout');

-- Saved definitions: manager and above of the org only.
select tests.as_user(tests.id('manager'));
select lives_ok($$ insert into app.report_definitions (org_id, name, definition) values (tests.id('org_a'), 'Weekly', '{"measures": ["visits"], "dimensions": ["weekday"]}') $$,
  'a manager saves a valid definition');
select throws_ok($$ insert into app.report_definitions (org_id, name, definition) values (tests.id('org_a'), 'Bad', '{"measures": ["guest_name"]}') $$,
  'P0001', 'invalid_report_definition', 'a saved definition is validated');
select is((select created_by from app.report_definitions where name = 'Weekly'), tests.id('manager'), 'the author is the caller');
select lives_ok(format($$ update app.report_definitions set created_by = %L where name = 'Weekly' $$, tests.id('other_owner')), 'an update naming another author is accepted');
select is((select created_by from app.report_definitions where name = 'Weekly'), tests.id('manager'), 'created_by does not change');
select lives_ok(format($$ insert into app.report_definitions (org_id, name, definition, created_by) values (tests.id('org_a'), 'Spoof', '{"measures": ["visits"]}', %L) $$, tests.id('other_owner')), 'insert with a spoofed author');
select is((select created_by from app.report_definitions where name = 'Spoof'), tests.id('manager'), 'spoofed created_by on insert is ignored');
select * from finish();
rollback;
