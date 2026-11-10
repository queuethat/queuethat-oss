-- PLT3 (#409): support grants. An owner can still record and revoke one (old bundles call these),
-- but a grant gave access to the hosted service's support staff, and there are none in this build:
-- a live grant opens nothing to anyone who is not a member.
begin;
\ir ../helpers/_setup.psql
select plan(21);
select tests.create_world();
select tests.create_user('stranger');

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

-- A live read grant is recorded and opens nothing.
select tests.act_as('owner');
create temp table g1 as select * from api.grant_support_access(tests.id('org_a'), 'read', 24, 'Billing question');
grant select on g1 to authenticated;
select is((select expires_at - created_at from g1), interval '24 hours', 'the grant lasts the hours asked for');
select tests.as_user(tests.id('stranger'), '{"aal":"aal2"}');
select is((select count(*) from app.visits), 0::bigint, 'a signed-in non-member reads no visits under a live read grant');
select is((select count(*) from app.support_grants), 0::bigint, 'and does not see the grant');
select tests.act_as('other_owner');
select is((select count(*) from app.visits where org_id = tests.id('org_a')), 0::bigint,
  'another org''s owner reads nothing of org A either');
select tests.act_as('staff');
select is((select count(*) from app.support_grants where id = (select id from g1)), 1::bigint,
  'members of the org see that a grant is recorded');

-- A live act grant replaces the read grant and still opens nothing.
select tests.act_as('owner');
create temp table g2 as select * from api.grant_support_access(tests.id('org_a'), 'act', 2, 'Fix the queue');
grant select on g2 to authenticated;
select tests.as_postgres();
select isnt((select revoked_at from app.support_grants where id = (select id from g1)), null,
  'a second live grant replaces the first');
select tests.as_user(tests.id('stranger'), '{"aal":"aal2"}');
select is((select count(*) from app.visits), 0::bigint, 'a non-member reads no visits under a live act grant');
select throws_ok($$ select api.transition_visit(tests.id('visit_a'), 'call', 0, gen_random_uuid()) $$,
  'P0001', 'not_found', 'and cannot transition a visit');
select throws_ok($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'or call the next guest');
update app.locations set name = 'Renamed by a stranger' where id = tests.id('loc_a');
select is(private.has_role(tests.id('org_a'), null, 'staff'), false, 'has_role denies the non-member');
select tests.as_postgres();
select is((select name from app.locations where id = tests.id('loc_a')), 'Location A', 'and the org''s settings are unchanged');
select is((select count(*)::int from private.support_grant(tests.id('org_a')) g where g.id is not null), 0,
  'private.support_grant returns no grant while one is live');

select throws_ok($$ insert into app.support_grants (org_id, scope, reason, expires_at, created_at)
                    values (tests.id('org_a'), 'read', 'x', now() + interval '1 hour', now()),
                           (tests.id('org_a'), 'read', 'y', now() + interval '1 hour', now()) $$,
  '23505', null, 'at most one unrevoked owner grant per org');

-- Revoke is idempotent.
select tests.act_as('owner');
select lives_ok($$ select api.revoke_support_access(tests.id('org_a')) $$, 'the owner revokes access');
select lives_ok($$ select api.revoke_support_access(tests.id('org_a')) $$, 'revoking again does nothing');
select tests.as_postgres();
select is((select count(*)::int from app.support_grants where org_id = tests.id('org_a') and revoked_at is null), 0,
  'no grant is left live');

select * from finish();
rollback;
