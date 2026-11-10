-- PLT1 (#407): platform_audit is append-only, organizations.status is not writable through the
-- API, platform roles cannot be self-granted, and every role change is audited.
begin;
\ir ../helpers/_setup.psql
select plan(19);

select tests.create_world();

-- AC3: no app role changes or removes platform_audit rows, or writes one directly.
select tests.act_as('owner');
select throws_ok($$ update app.platform_audit set reason = 'x' $$, '42501', null, 'AC3: owner cannot update platform_audit');
select throws_ok($$ delete from app.platform_audit $$, '42501', null, 'AC3: owner cannot delete platform_audit');
select throws_ok($$ insert into app.platform_audit (action) values ('fake.entry') $$, '42501', null,
  'owner cannot insert into platform_audit');
select tests.act_as('platform');
select throws_ok($$ update app.platform_audit set reason = 'x' $$, '42501', null, 'AC3: operator cannot update platform_audit');
select throws_ok($$ delete from app.platform_audit $$, '42501', null, 'AC3: operator cannot delete platform_audit');
select tests.as_service();
select throws_ok($$ update app.platform_audit set reason = 'x' $$, '42501', null, 'AC3: service role cannot update platform_audit');
select throws_ok($$ delete from app.platform_audit $$, '42501', null, 'AC3: service role cannot delete platform_audit');
select tests.as_postgres();
select throws_ok($$ update app.platform_audit set reason = 'x' $$, '42501', 'platform_audit is append-only',
  'even the table owner cannot update platform_audit');
select throws_ok($$ truncate app.platform_audit $$, '42501', 'platform_audit is append-only',
  'even the table owner cannot truncate platform_audit');

-- AC3: organizations.status is not writable directly; the other columns still are.
select is((select status from app.organizations where id = tests.id('org_a')), 'active'::app.org_status,
  'organizations default to active');
select tests.act_as('owner');
select throws_ok($$ update app.organizations set status = 'suspended' where id = tests.id('org_a') $$, '42501', null,
  'AC3: owner cannot update organizations.status');
select throws_ok($$ update app.organizations set suspended_reason = null where id = tests.id('org_a') $$, '42501', null,
  'owner cannot update the suspension columns');
select lives_ok($$ update app.organizations set name = 'Org A renamed' where id = tests.id('org_a') $$,
  'owner can still rename the org');
select tests.as_service();
select throws_ok($$ update app.organizations set status = 'active' $$, '42501', null,
  'AC3: service role cannot update organizations.status');

-- No one grants themselves a platform role.
select tests.act_as('owner');
select throws_ok($$ insert into app.platform_roles (user_id, role) values (auth.uid(), 'operator') $$, '42501', null,
  'an owner cannot grant themselves a platform role');
select tests.act_as('platform');
select throws_ok($$ update app.platform_roles set role = role $$, '42501', null,
  'an operator cannot change platform roles through the API');

-- AC4 (database half): a service-role grant, change and revoke each write an audit row.
select tests.as_service();
insert into app.platform_roles (user_id, role) values (tests.id('staff'), 'support');
update app.platform_roles set role = 'operator' where user_id = tests.id('staff');
delete from app.platform_roles where user_id = tests.id('staff');
select tests.as_postgres();
select results_eq(
  $$ select action, target ->> 'role', target ->> 'previous_role', target ->> 'via', actor_id
     from app.platform_audit where target ->> 'user_id' = tests.id('staff')::text order by id $$,
  $$ values ('platform_role.grant', 'support', null, 'service_role', null::uuid),
            ('platform_role.change', 'operator', 'support', 'service_role', null::uuid),
            ('platform_role.revoke', null, 'operator', 'service_role', null::uuid) $$,
  'AC4: grant, change and revoke are audited with the role that made them');
select is((select count(*) from app.platform_audit where org_id is not null), 0::bigint,
  'role changes are not about any org');

-- Operators read the audit; members do not.
select tests.act_as('platform');
select ok((select count(*) from app.platform_audit) >= 4, 'an aal2 operator reads platform_audit');

select * from finish();
rollback;
