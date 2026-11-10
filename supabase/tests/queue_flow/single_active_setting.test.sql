-- 2B-J2 (#240): who may change the single-active-visit rule.
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();

select tests.act_as('admin');
select lives_ok($$ update app.organizations set single_active_visit = 'org' where id = tests.id('org_a') $$,
  'an admin changes the rule');
select tests.act_as('manager');
update app.organizations set single_active_visit = 'off' where id = tests.id('org_a');
select tests.act_as('staff');
update app.organizations set single_active_visit = 'off' where id = tests.id('org_a');
select tests.act_as('other_owner');
update app.organizations set single_active_visit = 'off' where id = tests.id('org_a');
select tests.as_postgres();
select is((select single_active_visit::text from app.organizations where id = tests.id('org_a')), 'org',
  'staff, a manager and another business''s owner cannot change it');
select ok(exists (select 1 from app.audit_log where table_name = 'organizations' and org_id = tests.id('org_a')
  and (after ->> 'single_active_visit') = 'org'), 'the change is audited');
select tests.act_as('staff');
select is((select single_active_visit::text from app.organizations where id = tests.id('org_a')), 'org',
  'staff can read the rule');
select is_empty($$ select 1 from app.organizations where id = tests.id('org_b') $$, 'and see no other org');
select * from finish();
rollback;
