-- 4-API1: phase 4 contracts. Stubs are definer-pinned and never anon-reachable; run_report's stub became real in 4-RPT1.
begin;
\ir ../helpers/_setup.psql
select plan(4);
select tests.create_world();

select tests.as_postgres();
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p
  where p.pronamespace = 'api'::regnamespace and obj_description(p.oid, 'pg_proc') like '%Stub until 4-%'
    and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))
$$, 'every phase 4 stub is a definer with search_path pinned');

select ok(has_function_privilege('authenticated', 'api.run_report(jsonb, date, date)', 'EXECUTE')
          and has_function_privilege('service_role', 'api.run_report(jsonb, date, date)', 'EXECUTE')
          and not has_function_privilege('anon', 'api.run_report(jsonb, date, date)', 'EXECUTE'),
  'run_report is for signed-in users, never anon');

select tests.as_postgres();
set local role authenticated;
select throws_ok($$ select * from api.run_report('{}'::jsonb, current_date, current_date) $$,
  'P0001', 'invalid_report_definition', '4-RPT1 replaced the stub: run_report now validates its definition');
reset role;

select is(pg_get_function_result('api.run_report(jsonb, date, date)'::regprocedure), 'SETOF api.report_cell',
  'run_report returns setof api.report_cell');
select * from finish();
rollback;
