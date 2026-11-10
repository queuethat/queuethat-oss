-- 4-RBAC1 (#373): assigning a custom role, api.my_permissions, and the admin-level catalogue entries.
begin;
\ir ../helpers/_setup.psql
select plan(21);
select tests.create_world();

create function pg_temp.mid(p_user text) returns uuid language sql security definer set search_path = '' as
  $$ select id from app.memberships where org_id = tests.id('org_a') and user_id = tests.id(p_user) $$;
grant execute on function pg_temp.mid(text) to authenticated;
create function pg_temp.assigned(p_user text) returns uuid language sql security definer set search_path = '' as
  $$ select custom_role_id from app.memberships where org_id = tests.id('org_a') and user_id = tests.id(p_user) $$;
grant execute on function pg_temp.assigned(text) to authenticated;
create temp table made (name text primary key, key uuid);
grant all on made to authenticated;

-- Only an owner assigns; the target must be staff; the role must belong to the same org.
select tests.act_as('owner');
select is((select role from api.set_member_custom_role(pg_temp.mid('staff'), tests.id('role_a'), gen_random_uuid())), 'staff', 'an owner assigns a custom role');
select is(pg_temp.assigned('staff'), tests.id('role_a'), 'the membership now carries the role');
select throws_ok($$ select api.set_member_custom_role(pg_temp.mid('manager'), tests.id('role_a'), gen_random_uuid()) $$, 'P0001', 'forbidden_role', 'custom roles apply to staff members only');
select throws_ok($$ select api.set_member_custom_role(pg_temp.mid('staff'), tests.id('role_b'), gen_random_uuid()) $$, 'P0001', 'not_found', 'a role of another org is not_found');
select throws_ok($$ select api.set_member_custom_role(pg_temp.mid('staff'), tests.id('role_a'), null) $$, 'P0001', 'invalid_input', 'a key is required');
insert into made values ('clear', gen_random_uuid());
select is(pg_temp.assigned('staff'), tests.id('role_a'), 'still assigned before clearing');
select lives_ok(format($$ select api.set_member_custom_role(%L, null, %L) $$, pg_temp.mid('staff'), (select key from made where name = 'clear')), 'null clears the role');
select is(pg_temp.assigned('staff'), null, 'the member is a plain staff member again');
select lives_ok(format($$ select api.set_member_custom_role(%L, tests.id('role_a'), %L) $$, pg_temp.mid('staff'), (select key from made where name = 'clear')), 'replaying a key returns the first result and changes nothing');
select is(pg_temp.assigned('staff'), null, 'the replay did not reassign');
select tests.act_as('admin');
select throws_ok($$ select api.set_member_custom_role(pg_temp.mid('staff'), tests.id('role_a'), gen_random_uuid()) $$, '42501', 'permission_denied', 'an admin cannot assign custom roles');
select tests.act_as('staff');
select throws_ok($$ select api.set_member_custom_role(pg_temp.mid('staff'), tests.id('role_a'), gen_random_uuid()) $$, '42501', 'permission_denied', 'staff cannot assign custom roles');
select tests.act_as('other_owner');
select throws_ok($$ select api.set_member_custom_role(pg_temp.mid('staff'), tests.id('role_a'), gen_random_uuid()) $$, 'P0001', 'not_found', 'org B owner gets not_found on an org A membership');

select tests.as_postgres();
select throws_ok($$ insert into app.custom_roles (org_id, name, permissions) values (tests.id('org_a'), 'Integrator', array['settings.integrations']) $$,
  'P0001', 'invalid_input', 'admin-level settings.integrations is not grantable to a custom role');

-- my_permissions renders has_permission for the caller.
select tests.act_as('staff');
select is(api.my_permissions(tests.id('org_a'), null), array['payments.request', 'visits.call', 'visits.remove'], 'staff hold the staff-level permissions');
select tests.act_as('manager');
select is(api.my_permissions(tests.id('org_a'), tests.id('loc_a')), array['payments.charge', 'payments.refund', 'payments.request', 'visits.call', 'visits.remove'], 'a manager adds payments');
select tests.as_postgres();
update app.memberships set custom_role_id = tests.id('role_a') where id = pg_temp.mid('staff');
select tests.act_as('staff');
select is(api.my_permissions(tests.id('org_a'), null), array['visits.call'], 'a custom role narrows the list');
select tests.act_as('other_owner');
select is(api.my_permissions(tests.id('org_a'), null), '{}'::text[], 'a non-member holds nothing');
select tests.as_anon();
select throws_ok($$ select api.my_permissions(tests.id('org_a'), null) $$, '42501', null, 'anon cannot call it');

-- The column is readable (own row for staff, the org's rows for admins) but never writable.
select tests.act_as('staff');
select is((select count(*)::int from app.memberships where custom_role_id = tests.id('role_a')), 1, 'staff read custom_role_id on their own row');
select throws_ok($$ update app.memberships set custom_role_id = null where user_id = tests.id('staff') $$, '42501', null, 'but cannot write it');

select * from finish();
rollback;
