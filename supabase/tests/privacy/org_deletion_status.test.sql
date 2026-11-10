-- 2P-PRV9 (#196): the owner reads when a pending deletion is due, and nobody else can.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

select tests.as_postgres();
create temp table slug as select slug from app.locations where id = tests.id('loc_a');
grant select on slug to authenticated;

select tests.act_as('owner');
select is(api.get_org_deletion(tests.id('org_a')), null, 'no deletion pending reads as null');
create temp table sched as select api.request_org_deletion(tests.id('org_a'), (select slug from slug)) as at;
grant select on sched to authenticated;
select is(api.get_org_deletion(tests.id('org_a')), (select at from sched), 'the owner reads the purge time while locked');
select ok(not private.has_role(tests.id('org_a'), null, 'staff'), 'the org is locked, yet the read still answers');

select tests.act_as('admin');
select throws_ok($$ select api.get_org_deletion(tests.id('org_a')) $$, 'P0001', 'not_found', 'an admin cannot read it');
select tests.act_as('other_owner');
select throws_ok($$ select api.get_org_deletion(tests.id('org_a')) $$, 'P0001', 'not_found', 'cross-tenant: an owner of org B cannot read it');
select tests.as_anon();
select throws_ok($$ select api.get_org_deletion(tests.id('org_a')) $$, '42501', null, 'anon cannot execute it');

select * from finish();
rollback;
