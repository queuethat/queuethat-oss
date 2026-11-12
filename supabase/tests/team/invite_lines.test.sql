-- M3b (#1323): invitations carry lines (queue_ids) to the new membership, and owners and admins set a staff
-- member's lines through api.set_member_lines. Same rules as memberships.queue_ids: staff only, non-empty,
-- the org's queues; a location-scoped admin stays inside their locations; other tenants are refused.
begin;
\ir ../helpers/_setup.psql
select plan(23);
select tests.create_world();
select tests.create_user('hire1');
select tests.create_user('hire2');
select tests.create_user('scopedadmin');
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'invite-lines-second', 'UTC');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('line_1'), tests.id('org_a'), tests.id('loc_a'), 'Dr Ada', 'D'),
  (tests.new_id('line_far'), tests.id('org_a'), tests.id('loc_a2'), 'Far line', 'F'),
  (tests.new_id('line_b'), tests.id('org_b'), tests.id('loc_b'), 'B line', 'B');
insert into app.memberships (org_id, user_id, role, location_ids)
values (tests.id('org_a'), tests.id('scopedadmin'), 'admin', array[tests.id('loc_a')]);
create temp table made (who text, inv api.invitation_row);
grant all on made to authenticated;

-- Invite with lines
select tests.as_user(tests.id('admin'));
insert into made select 'hire1', api.create_invitation(tests.id('org_a'), 'hire1@test.local', 'staff', null, null,
  gen_random_uuid(), array[tests.id('line_1'), tests.id('queue_a')]);
select tests.as_postgres();
select is((select queue_ids from app.invitations where email = 'hire1@test.local'),
  array[tests.id('line_1'), tests.id('queue_a')], 'an admin''s staff invite stores the lines');
select tests.as_user(tests.id('hire1'));
select is((select role from api.accept_invitation((select (inv).token from made where who = 'hire1'))), 'staff', 'the hire accepts');
select tests.as_postgres();
select is((select queue_ids from app.memberships where user_id = tests.id('hire1')),
  array[tests.id('line_1'), tests.id('queue_a')], 'the membership starts with the invited lines');

select tests.act_as('owner');
select lives_ok($$ select api.create_invitation(tests.id('org_a'), 'six@test.local', 'staff', null, null, gen_random_uuid()) $$,
  'six arguments still work (old callers)');
select tests.as_postgres();
select is((select queue_ids from app.invitations where email = 'six@test.local'), null, 'and mean every line');

select tests.act_as('owner');
select api.create_invitation(tests.id('org_a'), 'mgr@test.local', 'manager', null, null, gen_random_uuid(), array[tests.id('line_1')]);
select tests.as_postgres();
select is((select queue_ids from app.invitations where email = 'mgr@test.local'), null, 'a manager invite is never scoped to lines');

select tests.act_as('owner');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'e@test.local', 'staff', null, null, gen_random_uuid(), '{}'::uuid[]) $$,
  'P0001', 'invalid_input', 'an empty list is invalid_input');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'e@test.local', 'staff', null, null, gen_random_uuid(), array[gen_random_uuid()]) $$,
  'P0001', 'invalid_input', 'an unknown queue is invalid_input');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'e@test.local', 'staff', null, null, gen_random_uuid(), array[null::uuid]) $$,
  'P0001', 'invalid_input', 'a null entry is invalid_input');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'e@test.local', 'staff', null, null, gen_random_uuid(), array[tests.id('line_b')]) $$,
  'P0001', 'invalid_input', 'cross-tenant: another org''s queue is invalid_input');
select tests.as_user(tests.id('scopedadmin'));
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'e@test.local', 'staff', null, null, gen_random_uuid(), array[tests.id('line_far')]) $$,
  'P0001', 'invalid_input', 'a location-scoped admin cannot hand out a line at another location');
select lives_ok($$ select api.create_invitation(tests.id('org_a'), 'near@test.local', 'staff', array[tests.id('loc_a')], null, gen_random_uuid(), array[tests.id('line_1')]) $$,
  'but can at their own');
select tests.as_user(tests.id('other_owner'));
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'x@test.local', 'staff', null, null, gen_random_uuid(), array[tests.id('line_1')]) $$,
  'P0001', 'not_found', 'cross-tenant: another org''s owner cannot invite here');

-- set_member_lines
select tests.as_postgres();
create temp table ids as select
  (select id from app.memberships where user_id = tests.id('hire1')) as hire,
  (select id from app.memberships where user_id = tests.id('manager') and org_id = tests.id('org_a')) as mgr;
grant select on ids to public;
select tests.as_user(tests.id('admin'));
select lives_ok($$ select api.set_member_lines((select hire from ids), array[tests.id('line_1')], gen_random_uuid()) $$,
  'an admin sets a staff member''s lines');
select tests.as_postgres();
select is((select queue_ids from app.memberships where id = (select hire from ids)), array[tests.id('line_1')], 'and they are stored');
select tests.as_user(tests.id('admin'));
select lives_ok($$ select api.set_member_lines((select hire from ids), null, gen_random_uuid()) $$, 'null gives every line back');
select tests.as_postgres();
select is((select queue_ids from app.memberships where id = (select hire from ids)), null, 'and is stored as null');
select tests.as_user(tests.id('admin'));
select throws_ok($$ select api.set_member_lines((select mgr from ids), array[tests.id('line_1')], gen_random_uuid()) $$,
  'P0001', 'forbidden_role', 'a manager cannot be scoped to lines');
select throws_ok($$ select api.set_member_lines((select hire from ids), '{}'::uuid[], gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'an empty list is invalid_input');
select tests.as_user(tests.id('scopedadmin'));
select throws_ok($$ select api.set_member_lines((select hire from ids), array[tests.id('line_far')], gen_random_uuid()) $$,
  'P0001', 'forbidden_role', 'a location-scoped admin cannot manage an org-wide member');
select tests.act_as('manager');
select throws_ok($$ select api.set_member_lines((select hire from ids), array[tests.id('line_1')], gen_random_uuid()) $$,
  '42501', 'permission_denied', 'a manager cannot set lines');
select tests.as_user(tests.id('other_owner'));
select throws_ok($$ select api.set_member_lines((select hire from ids), array[tests.id('line_1')], gen_random_uuid()) $$,
  'P0001', 'not_found', 'cross-tenant: another org''s owner gets not_found');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log a where a.table_name = 'memberships' and a.row_id = (select hire from ids)::text
           and lower(a.action) = 'update' and a.after -> 'queue_ids' = to_jsonb(array[tests.id('line_1')])), 1,
  'the change is in the audit log');

select * from finish();
rollback;
