-- S6 (#27): the demo seed and the test factories produce valid, visible rows.
begin;
\ir ../helpers/_setup.psql
select plan(6);

select is((select slug from app.locations where id = '00000000-0000-4000-8000-00000000d101'), 'demo-barber',
  'the demo location is seeded at /q/demo-barber');
select is((select count(*) from app.services where org_id = '00000000-0000-4000-8000-00000000d001'), 3::bigint,
  'the demo org has three services');

select tests.as_user('00000000-0000-4000-8000-0000000000a1');
select is((select count(*) from app.locations), 1::bigint, 'owner@demo.test sees exactly the demo location');
select tests.as_user('00000000-0000-4000-8000-0000000000b1');
select is((select name from app.locations), 'Other Salon Berlin', 'owner@other.test sees only Other Salon');

select tests.as_postgres();
select lives_ok('select tests.create_world()', 'the fixture world builds on top of the demo seed');
select tests.act_as('staff');
select is((select status::text from app.visits where id = tests.id('visit_a')), 'waiting',
  'factory visits are valid and visible to staff of their location');

select * from finish();
rollback;
