-- PLT1 (#407): organizations.status and the suspension columns are not writable through the API,
-- by an owner or by the service role; the other columns still are.
begin;
\ir ../helpers/_setup.psql
select plan(5);

select tests.create_world();

select is((select status from app.organizations where id = tests.id('org_a')), 'active'::app.org_status,
  'organizations default to active');
select tests.act_as('owner');
select throws_ok($$ update app.organizations set status = 'suspended' where id = tests.id('org_a') $$, '42501', null,
  'AC3: owner cannot update organizations.status');
select throws_ok($$ update app.organizations set suspended_reason = null where id = tests.id('org_a') $$, '42501', null,
  'owner cannot update the suspension columns');
select lives_ok($$ update app.organizations set name = 'Org A renamed' where id = tests.id('org_a') $$,
  'owner can still rename the org');
select tests.as_service();
select throws_ok($$ update app.organizations set status = 'active' $$, '42501', null,
  'AC3: service role cannot update organizations.status');

select * from finish();
rollback;
