-- 2A-TM1 (#95): staff invitations. AC1-AC5 plus idempotency, expiry and the single-use token.
begin;
\ir ../helpers/_setup.psql
select plan(25);
select tests.create_world();
select tests.create_user('newhire');
create temp table made (inv api.invitation_row);
grant all on made to authenticated;

-- AC1: an admin cannot invite an owner or an admin; an owner can.
select tests.act_as('admin');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'a@x.test', 'owner', null, null, gen_random_uuid()) $$,
  'P0001', 'forbidden_role', 'AC1: an admin inviting an owner is forbidden_role');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'a@x.test', 'admin', null, null, gen_random_uuid()) $$,
  'P0001', 'forbidden_role', 'AC1: an admin inviting an admin is forbidden_role');
select tests.act_as('manager');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'a@x.test', 'staff', null, null, gen_random_uuid()) $$,
  '42501', 'permission_denied', 'a manager cannot invite');
select tests.act_as('owner');
select lives_ok($$ select api.create_invitation(tests.id('org_a'), 'Boss@X.test', 'admin', null, 'Boss', gen_random_uuid()) $$,
  'an owner can invite an admin');

-- Create one for the new hire and keep the token.
select tests.as_user(tests.id('admin'));
insert into made select api.create_invitation(tests.id('org_a'), ' NewHire@Test.Local ', 'staff',
  array[tests.id('loc_a')], 'New Hire', '00000000-0000-4000-8000-000000000001');
select is((select (inv).email from made), 'newhire@test.local', 'the email is stored trimmed and lower-cased');
select isnt((select (inv).token from made), null, 'the token is returned once');

-- AC4: no column holds the plaintext token.
select tests.as_postgres();
select is((select count(*)::int from app.invitations i where to_jsonb(i)::text like '%' || (select (inv).token from made) || '%'),
  0, 'AC4: no invitations column contains the plaintext token');
select is((select count(*)::int from app.idempotency_keys k where k.response::text like '%' || (select (inv).token from made) || '%'),
  0, 'AC4: nor does the idempotency record');
select is((select token_hash from app.invitations where id = (select (inv).id from made)),
  extensions.digest((select (inv).token from made), 'sha256'), 'only the sha256 is stored');

-- Replay with the same key returns the invitation without a token and creates nothing new.
select tests.as_user(tests.id('admin'));
select is((select (api.create_invitation(tests.id('org_a'), ' NewHire@Test.Local ', 'staff', array[tests.id('loc_a')], 'New Hire',
  '00000000-0000-4000-8000-000000000001')).token), null, 'a replay returns the invitation without the token');
select tests.as_postgres();
select is((select count(*)::int from app.invitations where email = 'newhire@test.local'), 1, 'and creates no second row');

-- AC2: another user's email gets not_found and no membership.
select tests.act_as('staff');
select throws_ok(format($$ select api.accept_invitation(%L) $$, (select (inv).token from made)),
  'P0001', 'not_found', 'AC2: a user with a different email gets not_found');
select tests.as_postgres();
select is((select count(*)::int from app.memberships where org_id = tests.id('org_a') and display_name = 'New Hire'), 0,
  'AC2: and no membership is created');

-- Accepting as the invited user creates the membership; repeating returns the same one.
select tests.as_user(tests.id('newhire'));
select is((select role from api.accept_invitation((select (inv).token from made))), 'staff', 'the invited user accepts and becomes staff');
select tests.as_postgres();
select is((select display_name || ':' || location_ids::text from app.memberships
           where org_id = tests.id('org_a') and user_id = tests.id('newhire')),
  'New Hire:{' || tests.id('loc_a') || '}', 'the membership carries the name and location scope');
select tests.as_user(tests.id('newhire'));
select is((select id from api.accept_invitation((select (inv).token from made))),
  (select id from app.memberships where org_id = tests.id('org_a') and user_id = tests.id('newhire')),
  'accepting again returns the same membership');

-- AC3: used, expired and revoked tokens all answer not_found.
select tests.as_user(tests.id('staff'));
select throws_ok(format($$ select api.accept_invitation(%L) $$, (select (inv).token from made)),
  'P0001', 'not_found', 'AC3: a used token is not_found for anyone else');
select tests.as_postgres();
select tests.create_user('late');
select tests.create_user('gone');
create temp table toks (name text primary key, token text);
grant select on toks to authenticated;
insert into toks select 'late', 'late-token';
insert into toks select 'gone', 'gone-token';
insert into app.invitations (org_id, email, role, token_hash, expires_at)
values (tests.id('org_a'), 'late@test.local', 'staff', extensions.digest('late-token', 'sha256'), now() - interval '1 minute');
insert into app.invitations (org_id, email, role, token_hash, revoked_at)
values (tests.id('org_a'), 'gone@test.local', 'staff', extensions.digest('gone-token', 'sha256'), now());
select tests.as_user(tests.id('late'));
select throws_ok($$ select api.accept_invitation('late-token') $$, 'P0001', 'not_found', 'AC3: an expired token is not_found');
select tests.as_user(tests.id('gone'));
select throws_ok($$ select api.accept_invitation('gone-token') $$, 'P0001', 'not_found', 'AC3: a revoked token is not_found');
select throws_ok($$ select api.accept_invitation('no-such-token') $$, 'P0001', 'not_found', 'AC3: an unknown token is not_found');

-- Revoking: an admin cannot revoke an owner invite; a repeat revoke changes nothing.
select tests.act_as('admin');
select throws_ok($$ select api.revoke_invitation((select id from app.invitations where email = 'boss@x.test'), gen_random_uuid()) $$,
  'P0001', 'forbidden_role', 'an admin cannot revoke an admin invitation');
select tests.act_as('owner');
select lives_ok($$ select api.revoke_invitation((select id from app.invitations where email = 'boss@x.test'), gen_random_uuid()) $$,
  'an owner revokes it');

-- AC5: an admin of org B sees no org A invitations and cannot revoke them.
select tests.act_as('other_owner');
select is((select count(*)::int from app.invitations), 0, 'AC5: zero rows of org A invitations');
select throws_ok($$ select api.revoke_invitation(tests.id('invitation_a'), gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC5: revoking an org A invitation is not_found');
select throws_ok($$ select api.create_invitation(tests.id('org_a'), 'z@x.test', 'staff', null, null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC5: inviting into org A is not_found');

select * from finish();
rollback;
