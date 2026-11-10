-- 4-RBAC1 (#373): custom roles and private.has_permission. AC1-AC3 plus the ladder, caps and tenancy.
begin;
\ir ../helpers/_setup.psql
select plan(31);
select tests.create_world();

create function pg_temp.perm(p_perm text) returns boolean language sql as
  $$ select private.has_permission(tests.id('org_a'), tests.id('loc_a'), p_perm) $$;
grant execute on function pg_temp.perm(text) to authenticated;
create function pg_temp.visit_version(p_visit text) returns int language sql security definer set search_path = '' as
  $$ select version from app.visits where id = tests.id(p_visit) $$;
grant execute on function pg_temp.visit_version(text) to authenticated;

-- Built-in roles keep the ladder.
select tests.act_as('staff');
select is(pg_temp.perm('visits.remove'), true, 'staff hold visits.remove');
select is(pg_temp.perm('payments.refund'), false, 'staff do not hold payments.refund');
select tests.act_as('manager');
select is(pg_temp.perm('payments.refund'), true, 'a manager holds payments.refund');
select is(pg_temp.perm('settings.integrations'), false, 'a manager does not hold settings.integrations');
select tests.act_as('admin');
select is(pg_temp.perm('settings.integrations') and pg_temp.perm('members.manage'), true, 'an admin holds integrations and members');
select is(pg_temp.perm('no.such.permission'), false, 'an unknown permission is never held');

-- Catalogue rules.
select tests.as_postgres();
select throws_ok($$ insert into app.custom_roles (org_id, name, permissions) values (tests.id('org_a'), 'Bad', array['queues.nope']) $$,
  'P0001', 'invalid_input', 'a permission outside the catalogue is rejected');
select throws_ok($$ insert into app.custom_roles (org_id, name, permissions) values (tests.id('org_a'), 'Bad', array['members.manage']) $$,
  'P0001', 'invalid_input', 'members.manage cannot be granted to a custom role');
select throws_ok($$ insert into app.custom_roles (org_id, name, permissions) values (tests.id('org_a'), 'Dup', array['visits.call', 'visits.call']) $$,
  'P0001', 'invalid_input', 'a repeated permission is rejected');

-- Members: greeter (calls only), cleaner-upper (removes only), cashier (refunds), all staff-based.
insert into app.custom_roles (id, org_id, name, permissions) values
  (tests.new_id('role_remover'), tests.id('org_a'), 'Remover', array['visits.remove']),
  (tests.new_id('role_cashier'), tests.id('org_a'), 'Cashier', array['payments.refund', 'payments.charge', 'visits.call', 'visits.remove']);
select tests.create_user('greeter');
select tests.create_user('remover');
select tests.create_user('cashier');
insert into app.memberships (org_id, user_id, role, custom_role_id) values
  (tests.id('org_a'), tests.id('greeter'), 'staff', tests.id('role_a')),
  (tests.id('org_a'), tests.id('remover'), 'staff', tests.id('role_remover')),
  (tests.id('org_a'), tests.id('cashier'), 'staff', tests.id('role_cashier'));
select tests.new_visit('v1', 'queue_a');
select tests.new_visit('v2', 'queue_a');
select tests.new_visit('v3', 'queue_a');

-- AC1: a custom role without visits.remove cannot remove a visit; with it, can.
select tests.as_user(tests.id('greeter'));
select throws_ok(format($$ select api.transition_visit(%L, 'remove', pg_temp.visit_version('v1'), gen_random_uuid(), null, 'gone') $$, tests.id('v1')),
  '42501', 'permission_denied', 'AC1: a role without visits.remove is denied');
select is((select status from api.transition_visit(tests.id('v1'), 'call', pg_temp.visit_version('v1'), gen_random_uuid())), 'called', 'the same role may call');
select is(pg_temp.perm('visits.remove'), false, 'the role lacks visits.remove, although staff hold it');
select tests.as_user(tests.id('remover'));
select is((select status from api.transition_visit(tests.id('v2'), 'remove', pg_temp.visit_version('v2'), gen_random_uuid(), null, 'gone')), 'removed', 'a role with visits.remove removes');
select throws_ok(format($$ select api.transition_visit(%L, 'call', pg_temp.visit_version('v3'), gen_random_uuid()) $$, tests.id('v3')),
  '42501', 'permission_denied', 'a role without visits.call cannot call');
select throws_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_a')),
  '42501', 'permission_denied', 'call_next is denied without visits.call');
select lives_ok(format($$ select api.transition_visit(%L, 'no_show', pg_temp.visit_version('v3'), gen_random_uuid()) $$, tests.id('v3')),
  'other staff actions are unaffected');
select tests.as_user(tests.id('greeter'));
select throws_ok(format($$ select api.transition_visit(%L, 'cancel', pg_temp.visit_version('v3'), gen_random_uuid()) $$, tests.id('v3')),
  '42501', 'permission_denied', 'cancel counts as removing: denied without visits.remove');
select tests.as_user(tests.id('remover'));
select tests.as_user(tests.id('greeter'));
select lives_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_a')), 'a role with visits.call may call_next');

-- Payments: staff-based custom roles hold payments.* only when listed; managers by the ladder.
select tests.as_postgres();
insert into app.payments (id, org_id, location_id, visit_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
values (tests.new_id('pay_r'), tests.id('org_a'), tests.id('loc_a'), tests.id('v1'), 'fake', 'pi_r', 'deposit', 'succeeded', 900, 'usd', 'r');
select tests.as_user(tests.id('greeter'));
select throws_ok(format($$ select api.staff_refund_payment(%L, null, null, gen_random_uuid()) $$, tests.id('pay_r')),
  '42501', 'permission_denied', 'a role without payments.refund cannot refund');
select tests.as_user(tests.id('cashier'));
select is((select status from api.staff_refund_payment(tests.id('pay_r'), 100, null, gen_random_uuid())), 'succeeded', 'a staff-based role with payments.refund can refund');
select tests.act_as('manager');
select lives_ok(format($$ select api.staff_refund_payment(%L, 100, null, gen_random_uuid()) $$, tests.id('pay_r')), 'a built-in manager still refunds');

-- AC3: a role from org B cannot be assigned to an org A membership; staff-only; roles in use stay.
select tests.as_postgres();
select throws_ok($$ update app.memberships set custom_role_id = tests.id('role_b') where org_id = tests.id('org_a') and user_id = tests.id('staff') $$,
  '23503', null, 'AC3: a role of another org is rejected');
select throws_ok($$ update app.memberships set custom_role_id = tests.id('role_a') where org_id = tests.id('org_a') and user_id = tests.id('owner') $$,
  '23514', null, 'an owner cannot hold a custom role');
select throws_ok($$ delete from app.custom_roles where id = tests.id('role_a') $$, '23503', null, 'a role in use cannot be deleted');
update app.memberships set role = 'manager' where org_id = tests.id('org_a') and user_id = tests.id('greeter');
select is((select custom_role_id from app.memberships where org_id = tests.id('org_a') and user_id = tests.id('greeter')), null, 'promoting a member clears the custom role');
select tests.as_user(tests.id('greeter'));
select is(pg_temp.perm('payments.refund'), true, 'the promoted member follows the ladder');

-- Suspended orgs keep only staff-level permissions for custom roles.
select tests.as_postgres();
update app.organizations set status = 'suspended' where id = tests.id('org_a');
select tests.as_user(tests.id('cashier'));
select is(pg_temp.perm('payments.refund'), false, 'a suspended org withholds manager-level permissions');
select is(pg_temp.perm('visits.call'), true, 'but not staff-level ones');
select tests.as_postgres();
update app.organizations set status = 'active' where id = tests.id('org_a');

-- Cross-tenant: org B's owner holds nothing in org A and reads none of its roles.
select tests.act_as('other_owner');
select is(pg_temp.perm('visits.call'), false, 'an org B owner holds no org A permission');
select is((select count(*)::int from app.custom_roles where org_id = tests.id('org_a')), 0, 'and sees no org A role');
select throws_ok($$ insert into app.custom_roles (org_id, name, permissions) values (tests.id('org_a'), 'Sneak', '{}') $$, '42501', null, 'nor creates one');

select * from finish();
rollback;
