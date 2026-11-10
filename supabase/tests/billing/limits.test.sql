-- 4-BILL3 (#379): plan limits are entitlement defaults enforced by triggers; guests are never touched.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

select tests.as_postgres();
update app.platform_flags set billing_enabled = true;

-- AC1: a free org with one location cannot create a second.
select throws_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_b'), 'Second', 'lim-b2', 'UTC')$$,
  'P0001', 'plan_limit_reached', 'AC1: a free org cannot add a second location');

-- A paid org can.
select lives_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Second', 'lim-a2', 'UTC')$$,
  'a subscribed org can add a location');

-- AC2: a downgrade keeps everything that exists; only new ones are refused.
update app.subscriptions set status = 'canceled' where org_id = tests.id('org_a');
select is((select count(*) from app.locations where org_id = tests.id('org_a')), 2::bigint, 'AC2: both locations are still there after the downgrade');
select lives_ok($$update app.locations set name = 'Renamed' where slug = 'lim-a2'$$, 'and can still be edited');
select ok(exists (select 1 from app.visits where org_id = tests.id('org_a')), 'and the visits are untouched');
select throws_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Third', 'lim-a3', 'UTC')$$,
  'P0001', 'plan_limit_reached', 'but a new one is refused');

-- An operator override beats the plan.
select tests.act_as('platform');
select api.platform_set_entitlement(tests.id('org_a'), 'limit.locations', '5', 'enterprise deal');
select tests.as_postgres();
select lives_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Third', 'lim-a3', 'UTC')$$,
  'an operator override wins over the free plan');

-- Seats: the free plan allows 3 members including the owner.
do $$ begin perform tests.create_user('seat1'); end $$;
do $$ begin perform tests.create_user('seat2'); end $$;
do $$ begin perform tests.create_user('seat3'); end $$;
select lives_ok($$insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('seat1'), 'staff'), (tests.id('org_b'), tests.id('seat2'), 'staff')$$,
  'a free org can fill its seats');
select throws_ok($$insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('seat3'), 'staff')$$,
  'P0001', 'plan_limit_reached', 'but not exceed them');

-- Paid channels need a plan that allows them, only while billing is on.
select ok('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'sms')), 'a free org lacks the plan for SMS');
select ok(not ('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'email'))), 'email is not a paid channel');
update app.platform_flags set billing_enabled = false;
select ok(not ('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'sms'))), 'billing off: paid channels need no plan');
select is((select count(*) from app.locations where org_id = tests.id('org_b')), 1::bigint, 'billing off: nothing was limited before either');

select * from finish();
rollback;
