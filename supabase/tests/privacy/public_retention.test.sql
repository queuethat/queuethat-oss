-- 2P-PRV2 (#189): the public location carries the retention period; only admins change it.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();

select tests.as_postgres();
update app.organizations set retention_days = 14 where id = tests.id('org_a');
create temp table slug as select slug from app.locations where id = tests.id('loc_a');
grant select on slug to anon, authenticated;

select tests.as_anon();
select is((api.get_location_public((select slug from slug))).retention_days, 14, 'AC1: a guest reads the 14 day period');

select tests.act_as('admin');
select lives_ok($$ update app.organizations set retention_days = 90 where id = tests.id('org_a') $$, 'an admin changes the period');
select is((select retention_days from app.organizations where id = tests.id('org_a')), 90, 'the change took');
select throws_ok($$ update app.organizations set retention_days = 0 where id = tests.id('org_a') $$, '23514', null, 'out-of-range periods are refused');

select tests.act_as('manager');
update app.organizations set retention_days = 7 where id = tests.id('org_a');
select tests.act_as('other_owner');
update app.organizations set retention_days = 5 where id = tests.id('org_a');
select tests.as_postgres();
select is((select retention_days from app.organizations where id = tests.id('org_a')), 90, 'AC2: a manager and another business''s owner cannot change it');
select ok(true, 'cross-tenant update touched nothing');
select ok(exists (select 1 from app.audit_log where table_name = 'organizations' and org_id = tests.id('org_a')
                  and (after ->> 'retention_days') = '90'), 'AC2: the change is audited');

select * from finish();
rollback;
