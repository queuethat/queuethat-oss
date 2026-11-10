-- T1 (#1295): the template catalog table, versioning and apply-by-copy.
begin;
\ir ../helpers/_setup.psql
select plan(18);

select tests.create_world();
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_new'), tests.id('org_a'), 'New place', 'new-place-a', 'America/New_York'),
       (tests.new_id('loc_new2'), tests.id('org_a'), 'Second place', 'second-place-a', 'America/New_York');

select is((select count(*) from app.template_catalog where version = 1), 6::bigint, 'the six existing templates are version 1');
select is((select health_tagged from app.template_catalog where key = 'clinic'), true, 'the clinic stays health-tagged');
select throws_ok($$ update app.template_catalog set tier = 1 where key = 'barber' $$, 'P0001', 'catalog_version_immutable',
  'a published version cannot be edited');
select throws_ok($$ delete from app.template_catalog where key = 'barber' $$, 'P0001', 'catalog_version_immutable',
  'a published version cannot be deleted');

-- Tenants read the catalog but cannot write it.
select tests.act_as('owner');
select is((select count(*) from api.list_template_catalog()), 6::bigint, 'a signed-in user lists the catalog');
select is((select payload -> 'queues' -> 0 ->> 'name' from api.list_template_catalog() where key = 'barber'), 'Walk-ins',
  'the listing carries the payload');
select throws_ok($$ insert into app.template_catalog (key, version, payload, tier, mode)
  values ('mine', 1, '{}'::jsonb, 1, 'walk_in') $$, '42501', null, 'the owner cannot add a template');
select throws_ok($$ update app.template_catalog set payload = '{}'::jsonb where key = 'barber' $$, '42501', null,
  'the owner cannot change a template');
select tests.as_anon();
select throws_ok($$ select * from api.list_template_catalog() $$, '42501', null, 'anon cannot list the catalog');

-- Apply copies version 1 and stamps it.
select tests.act_as('admin');
select api.apply_industry_template(tests.id('loc_new'), 'barber', gen_random_uuid());
select is((select q.origin_template || ' v' || q.origin_version from app.queues q where q.location_id = tests.id('loc_new')),
  'barber v1', 'the copy is stamped barber v1');

-- A later catalog version changes new copies only.
select tests.as_postgres();
insert into app.template_catalog (key, version, payload, tier, mode, health_tagged)
select key, 2, jsonb_set(payload, '{queues,0,services,0,minutes}', '45'), 1, 'both', false
from app.template_catalog where key = 'barber' and version = 1;
select tests.act_as('admin');
select is((select (payload -> 'queues' -> 0 -> 'services' -> 0 ->> 'minutes')::int || ' v' || version
           from api.list_template_catalog() where key = 'barber'), '45 v2', 'the listing shows the newest version');
select is((select s.expected_minutes from app.services s where s.location_id = tests.id('loc_new') and s.name = 'Haircut'), 30,
  'the existing copy keeps 30 minutes');
select is((select q.origin_version from app.queues q where q.location_id = tests.id('loc_new')), 1,
  'and still says v1');
select api.apply_industry_template(tests.id('loc_new2'), 'barber', gen_random_uuid());
select is((select s.expected_minutes from app.services s where s.location_id = tests.id('loc_new2') and s.name = 'Haircut'), 45,
  'a new copy uses version 2');
select is((select q.origin_version from app.queues q where q.location_id = tests.id('loc_new2')), 2, 'and is stamped v2');
select is((select s.expected_minutes from app.services s where s.location_id = tests.id('loc_new') and s.name = 'Haircut'), 30,
  'the first copy is still untouched');

-- Cross-tenant: org B cannot copy onto org A's location, and an unknown key is not_found.
select tests.act_as('other_owner');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new'), 'barber', gen_random_uuid()) $$,
  'P0001', 'not_found', 'org B gets not_found for an org A location');
select tests.act_as('admin');
select throws_ok($$ select api.apply_industry_template(tests.id('loc_new'), 'nope', gen_random_uuid()) $$,
  'P0001', 'not_found', 'an unknown template is not_found');

select * from finish();
rollback;
