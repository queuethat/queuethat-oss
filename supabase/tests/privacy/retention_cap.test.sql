-- C3 (#1269): retention is capped by the platform setting max_retention_days (default 365), new orgs
-- default to 365, existing values are never shortened silently, and the purge deletes answers.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

-- Platform setting and default.
select is((select max_retention_days from app.platform_flags), 365, 'the platform cap defaults to 365');
select is((select column_default from information_schema.columns
           where table_schema = 'app' and table_name = 'organizations' and column_name = 'retention_days'),
  '365', 'new orgs default to 365 days');
select is((select retention_days from app.organizations where id = tests.id('org_a')), 365,
  'an org created without a value gets 365');

-- The cap is enforced by the database, not the UI.
select tests.act_as('owner');
select lives_ok($$ update app.organizations set retention_days = 90 where id = tests.id('org_a') $$,
  'an owner may shorten retention');
select lives_ok($$ update app.organizations set retention_days = 365 where id = tests.id('org_a') $$,
  'and set it to exactly the cap');
select throws_ok($$ update app.organizations set retention_days = 366 where id = tests.id('org_a') $$,
  'P0001', 'retention_over_cap', 'above the cap is refused');
select tests.as_postgres();
select throws_ok($$ update app.organizations set retention_days = 3650 where id = tests.id('org_a') $$,
  'P0001', 'retention_over_cap', 'even for the database owner');
select throws_ok($$ insert into app.organizations (name, retention_days) values ('Long', 400) $$,
  'P0001', 'retention_over_cap', 'an org cannot be created above the cap');
select throws_ok($$ update app.organizations set retention_days = 0 where id = tests.id('org_a') $$,
  '23514', null, 'zero days is still refused');

-- A self-hoster can raise the cap in the platform setting.
update app.platform_flags set max_retention_days = 730;
select lives_ok($$ update app.organizations set retention_days = 700 where id = tests.id('org_a') $$,
  'a higher platform cap admits a longer period');
update app.organizations set retention_days = 365 where id = tests.id('org_a');
update app.platform_flags set max_retention_days = 365;

-- Existing orgs above the cap keep their value until the clamp is run on purpose.
alter table app.organizations disable trigger enforce_retention_cap;
update app.organizations set retention_days = 700 where id = tests.id('org_b');
alter table app.organizations enable trigger enforce_retention_cap;
update app.organizations set name = 'Org B renamed' where id = tests.id('org_b');
select is((select retention_days from app.organizations where id = tests.id('org_b')), 700,
  'unrelated updates leave a legacy value alone');
select is((select array_agg(retention_days order by retention_days) from ops.retention_preclamp_report()), array[700],
  'the pre-clamp report lists the orgs over the cap');
select throws_ok($$ select ops.clamp_retention() $$, 'P0001', 'retention_clamp_pending',
  'the clamp refuses while orgs are over the cap and no force flag is given');
select is((select retention_days from app.organizations where id = tests.id('org_b')), 700, 'nothing was shortened');
select is(ops.clamp_retention(true), 1, 'with force it clamps and returns the count');
select is((select retention_days from app.organizations where id = tests.id('org_b')), 365, 'the org is now at the cap');
select is(ops.clamp_retention(), 0, 'with nothing over the cap the clamp is a no-op');

-- Purge deletes answers with the visit's personal data, and only for the org's own visits.
select tests.as_postgres();
select private.set_actor('system', null);
create temp table ids as select tests.new_visit('Ann', 'queue_a') as v;
insert into app.visit_answers (org_id, location_id, visit_id, answers)
select tests.id('org_a'), tests.id('loc_a'), v, '{"note":"allergy"}' from ids;
select private.anonymize_visits(tests.id('org_b'), (select array[v] from ids));
select is((select count(*) from app.visit_answers where visit_id = (select v from ids)), 1::bigint, 'another org cannot purge the answers');
select private.anonymize_visits(tests.id('org_a'), (select array[v] from ids));
select is((select count(*) from app.visit_answers where visit_id = (select v from ids)), 0::bigint, 'anonymizing the visit deletes its answers');

select * from finish();
rollback;
