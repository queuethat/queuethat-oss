-- feature.rollup: an org without the feature is refused with feature_not_in_plan; the shipped default is open;
-- someone who may not see the org's locations learns nothing about its plan.
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();

select tests.act_as('owner');
select lives_ok($$ select * from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'with the shipped default the rollup is open');

select tests.as_postgres();
update app.entitlement_defaults set value = 'false' where key = 'feature.rollup';
select tests.act_as('owner');
select throws_ok($$ select * from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'P0001', 'feature_not_in_plan', 'an owner of an org without the feature is refused');
select tests.act_as('other_owner');
select is_empty($$ select 1 from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'another org gets zero rows, not a plan answer');
select tests.act_as('staff');
select is_empty($$ select 1 from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'staff get zero rows, not a plan answer');

select tests.as_postgres();
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_a'), 'feature.rollup', 'true', 'paid');
select tests.act_as('owner');
select lives_ok($$ select * from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'an org with the entitlement can use it again');

select * from finish();
rollback;
