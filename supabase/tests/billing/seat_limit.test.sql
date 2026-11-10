-- #1081: the staff seat limit is checked when inviting, and a full org answers accepting with a handled error.
begin;
\ir ../helpers/_setup.psql
select plan(13);
create temp table seen (detail text);
grant all on seen to authenticated;
select tests.create_world();
select tests.create_user('s1');
select tests.create_user('s2');
select tests.create_user('s3');

select tests.as_postgres();
update app.platform_flags set billing_enabled = true;

-- org_b is on the free plan (3 seats) with one member; org_a is subscribed (unlimited seats).

-- Below the limit: members + pending = 1 + 1, so a third is fine.
select tests.act_as('other_owner');
select lives_ok($$ select api.create_invitation(tests.id('org_b'), 'one@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'below the limit: a free org can invite');
select lives_ok($$ select api.create_invitation(tests.id('org_b'), 'two@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'up to the limit: the last seat can be invited');

-- AC1: members (1) + pending (2) = 3 >= 3.
select throws_ok($$ select api.create_invitation(tests.id('org_b'), 'three@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'P0001', 'plan_limit_reached', 'AC1: a full free org cannot invite another address');
select is((select count(*)::int from app.invitations where org_id = tests.id('org_b') and email = 'three@x.test'), 0,
  'and nothing was created');
do $$ begin
  perform api.create_invitation(tests.id('org_b'), 'three@x.test', 'staff', null, null, gen_random_uuid());
exception when others then
  declare d text; begin
    get stacked diagnostics d = pg_exception_detail;
    insert into seen values (d);
  end;
end $$;
select is((select detail from seen), '3', 'the error detail is the plan limit');

-- Re-inviting an address that is already pending is a no-op for seats (resend).
select lives_ok($$ select api.create_invitation(tests.id('org_b'), 'ONE@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'AC1: inviting a pending address again still works at the limit');
select is((select count(*)::int from app.invitations where org_id = tests.id('org_b') and email = 'one@x.test' and revoked_at is null), 1,
  'and leaves exactly one live invitation for it');

-- Revoking frees the seat.
select lives_ok($$ select api.revoke_invitation((select id from app.invitations where email = 'two@x.test'), gen_random_uuid()) $$, 'revoke one');
select lives_ok($$ select api.create_invitation(tests.id('org_b'), 'three@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'a revoked invitation frees its seat');

-- Accepting when the org filled up meanwhile: a handled error, and the invitation stays pending.
select tests.as_postgres();
insert into app.invitations (org_id, email, role, token_hash)
  select tests.id('org_b'), u.email, 'staff', extensions.digest('late-token', 'sha256') from auth.users u where u.id = tests.id('s1');
-- fill the org out of band (the seats pending invitations hold are not membership rows)
delete from app.invitations where org_id = tests.id('org_b') and email in ('one@x.test', 'three@x.test');
insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('s2'), 'staff'), (tests.id('org_b'), tests.id('s3'), 'staff');
select tests.as_user(tests.id('s1'));
select throws_ok($$ select api.accept_invitation('late-token') $$, 'P0001', 'plan_limit_reached',
  'AC2: accepting into a full org raises plan_limit_reached');
select tests.as_postgres();
select is((select accepted_at from app.invitations where token_hash = extensions.digest('late-token', 'sha256')), null,
  'AC2: the invitation is still pending');

-- Paid plan: unlimited seats.
select tests.act_as('owner');
select lives_ok($$ select api.create_invitation(tests.id('org_a'), 'p' || g || '@x.test', 'staff', null, null, gen_random_uuid()) from generate_series(1, 6) g $$,
  'a subscribed org invites past 3');

-- Cross-tenant: org_b's owner cannot use org_a's seats or learn anything about them.
select tests.act_as('other_owner');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'x@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'cross-tenant: inviting into org A is not_found, not plan_limit_reached');

select * from finish();
rollback;
