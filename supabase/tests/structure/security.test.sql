-- F11 (#21): structural security rules (technical-design.md 5). Each rule is asserted twice:
-- the real schema must be clean, and a deliberately broken object (created and rolled back
-- inside a savepoint) must be caught, so a rule can't silently stop matching anything.
begin;
\ir ../helpers/_setup.psql
select plan(19);

-- The real schema is clean.
select is_empty('select * from tests.tables_without_rls()', 'every table in an exposed schema has RLS on');
select is_empty('select * from tests.tables_without_policies()', 'every table in an exposed schema has at least one policy');
select is_empty('select * from tests.definers_without_search_path()', 'every SECURITY DEFINER function pins search_path');
select is_empty('select * from tests.definers_not_allowlisted()', 'every SECURITY DEFINER function is in supabase/security-definer-allowlist.txt');
select is_empty('select * from tests.anon_definers_not_allowlisted()', 'anon can execute only allowlisted SECURITY DEFINER functions');
select is_empty('select * from tests.views_without_security_invoker()', 'every view uses security_invoker');
select is_empty('select * from tests.matviews_in_exposed_schemas()', 'no materialized view sits in an exposed schema');
select is_empty('select * from tests.anon_relation_grants()', 'anon and PUBLIC hold no table privileges');
select is_empty('select * from tests.tenant_tables_without_org_id()', 'every app table has org_id unless listed in global_tables');

-- Each rule catches a violation.
select ok(tests.catches('create table app.zz (id int primary key, org_id uuid)',
  'select * from tests.tables_without_rls()', 'app.zz'), 'catches a table without RLS');
select ok(tests.catches('create table app.zz (id int primary key, org_id uuid); alter table app.zz enable row level security',
  'select * from tests.tables_without_policies()', 'app.zz'), 'catches a table with no policies');
select ok(tests.catches('create table app.zz (id int primary key)',
  'select * from tests.tenant_tables_without_org_id()', 'app.zz'), 'catches a tenant table without org_id');
select ok(tests.catches($$create function api.zz() returns int language sql security definer as 'select 1'$$,
  'select * from tests.definers_without_search_path()', 'api.zz()'), 'catches a definer without search_path');
select ok(tests.catches($$create function api.zz() returns int language sql security definer set search_path = '' as 'select 1'$$,
  'select * from tests.definers_not_allowlisted()', 'api.zz()'), 'catches a definer missing from the allowlist');
select ok(tests.catches($$create function api.zz() returns int language sql security definer set search_path = '' as 'select 1';
                          grant execute on function api.zz() to anon$$,
  'select * from tests.anon_definers_not_allowlisted()', 'api.zz()'), 'catches a definer granted to anon without allowlisting');
select ok(tests.catches('create view app.zz as select 1 as x',
  'select * from tests.views_without_security_invoker()', 'app.zz'), 'catches a view without security_invoker');
select ok(tests.catches('create materialized view app.zz as select 1 as x',
  'select * from tests.matviews_in_exposed_schemas()', 'app.zz'), 'catches a materialized view in an exposed schema');
select ok(tests.catches('create table app.zz (id int primary key, org_id uuid); grant select on app.zz to anon',
  'select * from tests.anon_relation_grants()', 'app.zz: SELECT'), 'catches a table privilege granted to anon');
select ok(tests.catches('create table app.zz (id int primary key, org_id uuid); alter table app.zz enable row level security; create policy p on app.zz using (true)',
  'select * from tests.tables_without_matrix_entry()', 'app.zz'), 'catches a table without a matrix entry');

select * from finish();
rollback;
