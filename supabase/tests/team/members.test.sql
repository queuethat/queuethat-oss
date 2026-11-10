-- 2A-TM2 (#96): role changes and offboarding. AC1-AC5 plus idempotency, sessions and unassigning.
begin;
\ir ../helpers/_setup.psql
select plan(30);
select tests.create_world();

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'succeeded'; exception when others then return sqlstate || ':' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to authenticated;
create temp table made (name text primary key, key uuid);
grant all on made to authenticated;
create function pg_temp.mid(p_user text) returns uuid language sql security definer set search_path = '' as
  $$ select id from app.memberships where org_id = tests.id('org_a') and user_id = tests.id(p_user) $$;
grant execute on function pg_temp.mid(text) to authenticated;

-- AC1: the only owner cannot be demoted or removed, by anyone.
select tests.act_as('owner');
select throws_ok($$ select api.set_member_role(pg_temp.mid('owner'), 'admin', null, gen_random_uuid()) $$, 'P0001', 'last_owner', 'AC1: the only owner cannot demote themselves');
select throws_ok($$ select api.remove_member(pg_temp.mid('owner'), null, gen_random_uuid()) $$, 'P0001', 'last_owner', 'AC1: nor remove themselves');
select tests.act_as('admin');
select throws_ok($$ select api.remove_member(pg_temp.mid('owner'), null, gen_random_uuid()) $$, 'P0001', 'last_owner', 'AC1: an admin removing the only owner gets last_owner');

-- Role ladder.
select is((select role from api.set_member_role(pg_temp.mid('staff'), 'manager', null, gen_random_uuid())), 'manager', 'an admin promotes staff to manager');
select throws_ok($$ select api.set_member_role(pg_temp.mid('staff'), 'admin', null, gen_random_uuid()) $$, 'P0001', 'forbidden_role', 'an admin cannot grant admin');
select throws_ok($$ select api.set_member_role(pg_temp.mid('admin'), 'staff', null, gen_random_uuid()) $$, 'P0001', 'forbidden_role', 'nobody changes their own role');
select tests.act_as('manager');
select throws_ok($$ select api.set_member_role(pg_temp.mid('staff'), 'staff', null, gen_random_uuid()) $$, '42501', 'permission_denied', 'a manager cannot manage people');
select tests.act_as('owner');
select throws_ok($$ select api.set_member_role(pg_temp.mid('staff'), 'wizard', null, gen_random_uuid()) $$, 'P0001', 'invalid_input', 'an unknown role is invalid_input');
select throws_ok($$ select api.set_member_role(pg_temp.mid('staff'), 'staff', array[tests.id('loc_b')], gen_random_uuid()) $$, 'P0001', 'invalid_input', 'a foreign location is invalid_input');
select is((select role from api.set_member_role(pg_temp.mid('admin'), 'manager', array[tests.id('loc_a')], gen_random_uuid())), 'manager', 'an owner demotes an admin and scopes them to a location');

-- AC5: the audit log records actor, before and after.
select tests.as_postgres();
select results_eq($$ select actor, before ->> 'role', after ->> 'role' from app.audit_log
                     where table_name = 'memberships' and action = 'UPDATE' and row_id = pg_temp.mid('admin')::text $$,
  $$ select tests.id('owner'), 'admin', 'manager' $$, 'AC5: the audit row names the actor and holds before and after');

-- Replay with the same key changes nothing and returns the same result.
select tests.act_as('owner');
insert into made values ('role', gen_random_uuid());
select is((select role from api.set_member_role(pg_temp.mid('staff'), 'staff', null, (select key from made where name = 'role'))), 'staff', 'owner sets staff back to staff');
select is((select role from api.set_member_role(pg_temp.mid('staff'), 'owner', null, (select key from made where name = 'role'))), 'staff', 'a replay with the same key returns the first result');

-- AC4: an owner of org B cannot touch org A.
select tests.act_as('other_owner');
select throws_ok($$ select api.set_member_role(pg_temp.mid('staff'), 'staff', null, gen_random_uuid()) $$, 'P0001', 'not_found', 'AC4: set_member_role on an org A membership is not_found');
select throws_ok($$ select api.remove_member(pg_temp.mid('staff'), null, gen_random_uuid()) $$, 'P0001', 'not_found', 'AC4: remove_member is not_found');
select throws_ok($$ select * from api.list_members(tests.id('org_a')) $$, 'P0001', 'not_found', 'AC4: list_members is not_found');

-- list_members: emails only for owners and admins.
select tests.act_as('owner');
select is((select count(*)::int from api.list_members(tests.id('org_a')) where email is not null), 4, 'an owner sees all four members with emails');
select tests.act_as('staff');
select is((select count(*)::int from api.list_members(tests.id('org_a')) where email is null), 4, 'staff see the members without emails');

-- A location-scoped admin cannot grant or manage wider access than they hold.
select tests.as_postgres();
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, location_ids) values (tests.id('org_a'), tests.id('scoped'), 'admin', array[tests.id('loc_a')]);
select tests.as_user(tests.id('scoped'));
select throws_ok($$ select api.set_member_role(pg_temp.mid('staff'), 'staff', null, gen_random_uuid()) $$, 'P0001', 'forbidden_role', 'a scoped admin cannot give someone every location');
select throws_ok($$ select api.remove_member(pg_temp.mid('staff'), null, gen_random_uuid()) $$, 'P0001', 'forbidden_role', 'nor manage a member who has every location');

-- Offboarding: the staff member has a waiting visit, a session and a refresh token.
select tests.as_postgres();
select tests.new_visit('assigned', 'queue_a');
update app.visits set assigned_staff_id = tests.id('staff') where id = tests.id('assigned');
insert into auth.sessions (id, user_id) values ('11111111-1111-4111-8111-111111111111', tests.id('staff'));
insert into auth.refresh_tokens (token, user_id, session_id) values ('rt-fixture', tests.id('staff')::text, '11111111-1111-4111-8111-111111111111');
select tests.act_as('owner');
insert into made values ('rm', gen_random_uuid());
select is((select removed_at is not null from api.remove_member(pg_temp.mid('staff'), 'left the company', (select key from made where name = 'rm'))), true, 'an owner removes staff');
select tests.as_postgres();
select is((select count(*)::int from app.memberships where user_id = tests.id('staff')), 0, 'the membership is gone');
select is((select count(*)::int from auth.sessions where user_id = tests.id('staff')) + (select count(*)::int from auth.refresh_tokens where user_id = tests.id('staff')::text), 0, 'AC3: their sessions and refresh tokens are deleted');
select is((select before ->> 'removal_reason' from app.audit_log where table_name = 'memberships' and action = 'DELETE' and before ->> 'user_id' = tests.id('staff')::text), 'left the company', 'the audit record keeps the reason');
select is((select assigned_staff_id from app.visits where id = tests.id('assigned')), null, 'their waiting visit is unassigned');
select results_eq($$ select type, actor_id from app.visit_events where type = 'unassigned' $$, $$ select 'unassigned', tests.id('owner') $$, 'with an unassigned event naming the owner');

-- AC2: the removed member's still-valid token reads nothing and changes nothing.
select tests.act_as('staff');
select is((select count(*)::int from app.staff_visits), 0, 'AC2: they see no visits');
select isnt(pg_temp.try($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$), 'succeeded', 'AC2: call_next is denied');

-- Replay of the removal after the member is gone answers the same.
select tests.act_as('owner');
select is((select removed_at is not null from api.remove_member(pg_temp.mid('staff'), 'ignored', (select key from made where name = 'rm'))), true, 'repeating the removal with the same key succeeds');
select throws_ok($$ select api.remove_member(gen_random_uuid(), null, gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown member is not_found');

select * from finish();
rollback;
