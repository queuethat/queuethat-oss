-- PLT3 (#409): owner-granted support access and audited break-glass. Support act as themselves:
-- every change names them with actor_kind 'platform' and the grant id.
begin;
\ir ../helpers/_setup.psql
select plan(33);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
create function tests.as_support(p_aal text default 'aal2') returns void
language sql as $$ select tests.as_user(tests.id('support'), jsonb_build_object('aal', p_aal)) $$;
create function tests.as_operator(p_aal text default 'aal2') returns void
language sql as $$ select tests.as_user(tests.id('platform'), jsonb_build_object('aal', p_aal)) $$;
grant execute on function tests.as_support(text), tests.as_operator(text) to authenticated;

-- No grant yet: support see nothing.
select tests.as_support();
select is((select count(*) from app.visits), 0::bigint, 'support without a grant see no visits');

-- AC5 and input checks.
select tests.act_as('manager');
select throws_ok($$ select api.grant_support_access(tests.id('org_a'), 'read', 24, 'help') $$,
  '42501', 'permission_denied', 'AC5: a manager cannot grant support access');
select tests.act_as('other_owner');
select throws_ok($$ select api.grant_support_access(tests.id('org_a'), 'read', 24, 'help') $$,
  '42501', 'permission_denied', 'another org''s owner cannot grant access to org A');
select tests.act_as('owner');
select throws_ok($$ select api.grant_support_access(tests.id('org_a'), 'read', 73, 'help') $$,
  'P0001', 'invalid_input', 'more than 72 hours is refused');
select throws_ok($$ select api.grant_support_access(tests.id('org_a'), 'own', 1, 'help') $$,
  'P0001', 'invalid_input', 'an unknown scope is refused');
select throws_ok($$ select api.grant_support_access(tests.id('org_a'), 'read', 1, ' ') $$,
  'P0001', 'invalid_input', 'a blank reason is refused');

-- AC1: a read grant reads and never writes.
select tests.act_as('owner');
create temp table g1 as select * from api.grant_support_access(tests.id('org_a'), 'read', 24, 'Billing question');
grant select on g1 to authenticated;
select is((select expires_at - created_at from g1), interval '24 hours', 'the grant lasts the hours asked for');
select tests.as_support();
select is((select count(*) from app.visits where org_id = tests.id('org_a')), 1::bigint,
  'AC1: support with a read grant see org A visits');
select is((select count(*) from app.visits where org_id = tests.id('org_b')), 0::bigint,
  'the grant opens only org A');
select throws_ok($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$,
  '42501', 'permission_denied', 'AC1: support with a read grant cannot call_next');
select throws_ok($$ select api.set_queue_state(tests.id('queue_a'), 'paused') $$,
  '42501', 'permission_denied', 'support with a read grant cannot change queue state');
select is((select count(*) from app.devices), 0::bigint, 'a read grant does not reach admin-level reads');
select tests.as_support('aal1');
select is((select count(*) from app.visits), 0::bigint, 'a grant needs an aal2 session');
select tests.act_as('staff');
select is((select count(*) from app.visits where org_id = tests.id('org_b')), 0::bigint,
  'a grant gives nothing to users without a platform role');

-- AC2: an act grant replaces the read grant; writes are attributed to the support user.
select tests.act_as('owner');
create temp table g2 as select * from api.grant_support_access(tests.id('org_a'), 'act', 2, 'Fix the queue');
grant select on g2 to authenticated;
select tests.as_postgres();
select isnt((select revoked_at from app.support_grants where id = (select id from g1)), null,
  'a second live grant replaces the first');
select tests.as_support();
select lives_ok($$ select api.transition_visit(tests.id('visit_a'), 'call', 0, gen_random_uuid()) $$,
  'support with an act grant can transition a visit');
select tests.as_postgres();
select results_eq(
  $$ select actor_kind::text, actor_id, (payload ->> 'support_grant_id')::uuid
     from app.visit_events where visit_id = tests.id('visit_a') and type = 'call' $$,
  $$ values ('platform', tests.id('support'), (select id from g2)) $$,
  'AC2: the visit event names the support user with actor_kind platform and the grant');
select tests.as_support();
select lives_ok($$ update app.locations set name = 'Renamed by support' where id = tests.id('loc_a') $$,
  'an act grant reaches admin-level writes');
select throws_ok($$ insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('support'), 'owner') $$,
  '42501', null, 'an act grant never reaches owner');
select throws_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', 'Support kiosk') $$,
  '42501', 'permission_denied', 'an act grant cannot pair a device, which would outlive the grant');
select tests.act_as('staff');
select is((select (api.undo_event((select id from app.visit_events where visit_id = tests.id('visit_a') and type = 'call'),
                                  gen_random_uuid())).status::text), 'waiting',
  'staff can undo a support action');
select tests.as_postgres();
select results_eq(
  $$ select role, actor, support_grant_id from app.audit_log
     where table_name = 'locations' and after ->> 'name' = 'Renamed by support' $$,
  $$ values ('platform', tests.id('support'), (select id from g2)) $$,
  'the audit log names the support user, role platform and the grant');

-- AC3: one minute after expiry the grant does nothing.
update app.support_grants set created_at = now() - interval '2 hours 1 minute',
                              expires_at = now() - interval '1 minute' where id = (select id from g2);
select tests.as_support();
select is((select count(*) from app.visits), 0::bigint, 'AC3: an expired grant reads nothing');
select throws_ok($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC3: an expired grant behaves as if it never existed');

select tests.as_postgres();
select throws_ok($$ insert into app.support_grants (org_id, scope, reason, expires_at, created_at)
                    values (tests.id('org_a'), 'read', 'x', now() + interval '1 hour', now()),
                           (tests.id('org_a'), 'read', 'y', now() + interval '1 hour', now()) $$,
  '23505', null, 'at most one unrevoked owner grant per org');

-- Revoke is idempotent.
select tests.act_as('owner');
create temp table g3 as select * from api.grant_support_access(tests.id('org_a'), 'read', 1, 'again');
select lives_ok($$ select api.revoke_support_access(tests.id('org_a')) $$, 'the owner revokes access');
select lives_ok($$ select api.revoke_support_access(tests.id('org_a')) $$, 'revoking again does nothing');
select tests.as_support();
select is((select count(*) from app.visits), 0::bigint, 'a revoked grant reads nothing');

-- AC4: break-glass.
select tests.as_postgres();
select tests.new_visit('visit_w', 'queue_a');
select tests.as_support();
select throws_ok($$ select api.platform_break_glass(tests.id('org_a'), 'abuse report') $$,
  '42501', 'permission_denied', 'support cannot break glass; only operators');
select tests.as_operator();
create temp table bg as select * from api.platform_break_glass(tests.id('org_a'), 'Abuse report #12');
select is((select api.platform_break_glass(tests.id('org_a'), 'again')).id, (select id from bg),
  'breaking glass again while it is live returns the same grant');
select is((select count(*) from app.visits where org_id = tests.id('org_a')), 2::bigint,
  'break-glass reads org A');
select throws_ok($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$,
  '42501', 'permission_denied', 'break-glass is read-only');
select tests.as_postgres();
select ok(
  (select count(*) from app.platform_audit where action = 'support.break_glass' and org_id = tests.id('org_a')
     and reason = 'Abuse report #12' and actor_id = tests.id('platform')) = 1
  and (select count(*) from app.audit_log where table_name = 'support_grants' and action = 'INSERT'
     and role = 'platform' and after ->> 'reason' = 'Abuse report #12') = 1,
  'AC4: break-glass is in platform_audit and in the org''s own audit_log, with the reason');

select * from finish();
rollback;
