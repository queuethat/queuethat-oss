-- PLT4 (#410): platform tenant RPCs. Directory paging, no guest data in detail, idempotent
-- status changes, ownership transfer.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();

-- Org A's guest data, so detail can be checked for leaks.
update app.visits set guest_name = 'Zelda Guestname' where id = tests.id('visit_a');
select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal2"}') $$;
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal2"}') $$;
grant execute on function tests.as_operator(), tests.as_support() to authenticated;

-- 60 orgs in total (the demo seed and the world already have some).
insert into app.organizations (name)
select 'Paging org ' || g from generate_series(1, 60 - (select count(*) from app.organizations)) g;

-- AC1: paging returns every org exactly once.
create table tests.pages (page int, id uuid);
grant all on tests.pages to authenticated;
select tests.as_support();
insert into tests.pages select 1, id from api.platform_list_orgs(null, null, 50, null);
insert into tests.pages select 2, id from api.platform_list_orgs(null, null, 50, (select id from tests.pages where page = 1 order by id desc limit 1));
select is((select count(*) from tests.pages where page = 1), 50::bigint, 'the first page has 50 orgs');
select is((select count(*) from tests.pages where page = 2), 10::bigint, 'the second page has the other 10');
select tests.as_postgres();
select is((select count(distinct id) from tests.pages), 60::bigint, 'AC1: all 60 orgs come back exactly once');
select tests.as_support();
select results_eq(
  $$ select name, slug, status::text, owner_email, members, locations, visits_7d
     from api.platform_list_orgs('test-location-a') $$,
  $$ values ('Org A', 'test-location-a', 'active', 'owner@test.local', 4, 1, 1) $$,
  'search by location slug finds the org with its directory columns');
select is((select count(*) from api.platform_list_orgs('owner@test')), 2::bigint, 'search by owner email');
select is((select count(*) from api.platform_list_orgs(null, 'suspended')), 0::bigint, 'filter by status');
select throws_ok($$ select api.platform_list_orgs(null, null, 500) $$, 'P0001', 'invalid_input', 'p_limit is capped at 200');

-- AC2: org detail never carries guest data.
create temp table detail as select * from api.platform_get_org(tests.id('org_a'));
select tests.as_postgres();
select ok(to_jsonb(d)::text not like '%Zelda%' and to_jsonb(d)::text not like '%+1415%'
          and to_jsonb(d)::text not like '%Gina%', 'AC2: no guest name, phone or email anywhere in platform_get_org')
from detail d;
select is((select jsonb_array_length(members) from detail), 4, 'detail lists the members');
select ok((select recent_audit::text not like '%"before"%' and recent_audit::text not like '%"after"%' from detail),
  'audit rows come without their payloads');

-- AC3: suspend twice, one change and one audit row.
select tests.as_support();
select throws_ok($$ select api.platform_set_org_status(tests.id('org_a'), 'suspended', 'x') $$,
  '42501', 'permission_denied', 'support cannot change org status');
select tests.as_operator();
select throws_ok($$ select api.platform_set_org_status(tests.id('org_a'), 'pending_deletion', 'x') $$,
  'P0001', 'invalid_input', 'pending_deletion is not set from here');
create temp table s1 as select * from api.platform_set_org_status(tests.id('org_a'), 'suspended', 'Unpaid invoice');
create temp table s2 as select * from api.platform_set_org_status(tests.id('org_a'), 'suspended', 'Again');
select tests.as_postgres();
select is((select to_jsonb(s2) from s2), (select to_jsonb(s1) from s1), 'AC3: suspending again returns the same row');
select is((select count(*) from app.platform_audit where action = 'org.suspend' and org_id = tests.id('org_a')), 1::bigint,
  'AC3: and writes no second audit row');
select results_eq(
  $$ select status::text, suspended_reason, suspended_by from app.organizations where id = tests.id('org_a') $$,
  $$ values ('suspended', 'Unpaid invoice', tests.id('platform')) $$,
  'the suspension records reason and operator');
select is((select count(*) from app.audit_log where table_name = 'organizations' and org_id = tests.id('org_a')
           and after ->> 'status' = 'suspended'), 1::bigint, 'the org''s own audit log has the change');
select tests.as_operator();
select is((api.platform_set_org_status(tests.id('org_a'), 'active', 'Paid')).status, 'active'::app.org_status,
  'an operator restores the org');

-- AC4 and the transfer itself.
select throws_ok($$ select api.platform_transfer_ownership(tests.id('org_a'), 'other_owner@test.local', 'asked') $$,
  'P0001', 'not_a_member', 'AC4: transfer to a non-member raises not_a_member');
select is((api.platform_transfer_ownership(tests.id('org_a'), 'ADMIN@test.local', 'Owner left the company')).owner_email,
  'admin@test.local', 'transfer makes the admin the owner');
select tests.as_postgres();
select results_eq(
  $$ select (select role::text from app.memberships where org_id = tests.id('org_a') and user_id = tests.id('owner')),
            (select count(*) from app.notifications where visit_id is null and template_key = 'org.ownership_transferred') $$,
  $$ values ('admin', 2::bigint) $$,
  'the previous owner becomes admin and both are emailed');

select * from finish();
rollback;
