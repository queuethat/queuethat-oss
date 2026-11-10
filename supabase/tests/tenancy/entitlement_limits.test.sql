-- Limits are entitlements (app.entitlement_defaults, per-org overrides in app.org_entitlements)
-- enforced by triggers; guests are never touched. The defaults ship unlimited.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();
select tests.as_postgres();

-- Out of the box nothing is limited.
select lives_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_b'), 'Unlimited', 'lim-b0', 'UTC')$$,
  'with the shipped defaults an org adds locations freely');
delete from app.locations where slug = 'lim-b0';

-- The deployment allows one location per org; org A is given five.
update app.entitlement_defaults set value = '1' where key = 'limit.locations';
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_a'), 'limit.locations', '5', 'larger customer');

-- AC1: an org at the default limit cannot create a second location.
select throws_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_b'), 'Second', 'lim-b2', 'UTC')$$,
  'P0001', 'plan_limit_reached', 'AC1: an org at the limit cannot add a second location');

-- An org with a higher override can.
select lives_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Second', 'lim-a2', 'UTC')$$,
  'an org with an override above the default can add a location');

-- AC2: lowering the limit keeps everything that exists; only new ones are refused.
delete from app.org_entitlements where org_id = tests.id('org_a') and key = 'limit.locations';
select is((select count(*) from app.locations where org_id = tests.id('org_a')), 2::bigint, 'AC2: both locations are still there after the limit drops');
select lives_ok($$update app.locations set name = 'Renamed' where slug = 'lim-a2'$$, 'and can still be edited');
select ok(exists (select 1 from app.visits where org_id = tests.id('org_a')), 'and the visits are untouched');
select throws_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Third', 'lim-a3', 'UTC')$$,
  'P0001', 'plan_limit_reached', 'but a new one is refused');

-- A per-org override beats the default again.
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_a'), 'limit.locations', '5', 'restored');
select lives_ok(
  $$insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Third', 'lim-a3', 'UTC')$$,
  'a per-org override wins over the default');

-- Seats: with a limit of 3 an org has 3 members including the owner.
update app.entitlement_defaults set value = '3' where key = 'limit.members';
do $$ begin perform tests.create_user('seat1'); end $$;
do $$ begin perform tests.create_user('seat2'); end $$;
do $$ begin perform tests.create_user('seat3'); end $$;
select lives_ok($$insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('seat1'), 'staff'), (tests.id('org_b'), tests.id('seat2'), 'staff')$$,
  'an org can fill its seats');
select throws_ok($$insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('seat3'), 'staff')$$,
  'P0001', 'plan_limit_reached', 'but not exceed them');

-- Paid channels need the paid_channels entitlement.
select ok(not ('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'sms'))), 'the shipped default allows SMS');
update app.entitlement_defaults set value = 'false' where key = 'paid_channels';
select ok('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'sms')), 'with paid_channels off an org may not switch on SMS');
select ok(not ('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'email'))), 'email is not a paid channel');
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_b'), 'paid_channels', 'true', 'allowed');
select ok(not ('plan_allows_paid_channels' = any (private.channel_missing(tests.id('org_b'), 'sms'))), 'a per-org override allows it again');

select * from finish();
rollback;
