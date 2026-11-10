-- 2P-SEC1 (#205): MFA enforcement in private.has_role and api.set_require_mfa.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

create table tests.subs as select name, (claims ->> 'sub')::uuid as sub from tests.actors;
grant select on tests.subs to authenticated, anon;
select tests.new_id('k1');
select tests.new_visit('v1', 'queue_a');
select tests.new_visit('v2', 'queue_a');

create function tests.as_aal(p_actor text, p_aal text) returns void language sql as $$
  select tests.as_user((select sub from tests.subs where name = p_actor), jsonb_build_object('aal', p_aal))
$$;
create function tests.loc_update_count() returns int language sql as $$
  with u as (update app.locations set name = name where id = tests.id('loc_a') returning 1) select count(*)::int from u
$$;
grant execute on function tests.as_aal(text, text), tests.loc_update_count() to authenticated;

-- AC5: the flag off changes nothing.
select tests.as_aal('admin', 'aal1');
select is(tests.loc_update_count(), 1, 'AC5: with require_mfa false an aal1 admin still updates a location');

-- Owner at aal2 turns it on.
select tests.as_aal('owner', 'aal2');
select lives_ok($$ select api.set_require_mfa(tests.id('org_a'), true) $$, 'an owner at aal2 turns the requirement on');
select tests.as_postgres();
select is((select require_mfa_for_admins from app.organizations where id = tests.id('org_a')), true, 'and it is stored');

-- AC1 / AC2
select tests.as_aal('admin', 'aal1');
select is(tests.loc_update_count(), 0, 'AC1: an aal1 admin cannot update a location');
select lives_ok($$ select api.call_next(tests.id('queue_a'), null, tests.id('k1')) $$, 'AC1: and can still call_next (manager level)');
select tests.as_aal('admin', 'aal2');
select is(tests.loc_update_count(), 1, 'AC2: the same admin at aal2 updates the location');
select tests.as_aal('manager', 'aal1');
select is(tests.loc_update_count(), 0, 'managers are unaffected by the requirement (they never had admin)');

-- AC3 / AC4
select tests.as_aal('owner', 'aal1');
select throws_ok($$ select api.set_require_mfa(tests.id('org_a'), false) $$, 'P0001', 'mfa_required',
  'AC3: an owner at aal1 gets mfa_required');
select tests.as_aal('other_owner', 'aal2');
select throws_ok($$ select api.set_require_mfa(tests.id('org_a'), false) $$, 'P0001', 'not_found',
  'AC4: an org B owner is denied (not_found)');
select tests.as_aal('admin', 'aal2');
select throws_ok($$ select api.set_require_mfa(tests.id('org_a'), false) $$, '42501', 'permission_denied',
  'an admin cannot change the requirement, even at aal2');
select throws_ok($$ update app.organizations set require_mfa_for_admins = false where id = tests.id('org_a') $$, '42501', null,
  'and cannot write the column directly');
select tests.as_anon();
select throws_ok($$ select api.set_require_mfa(tests.id('org_a'), false) $$, '42501', null, 'anon cannot execute it');

-- Aal2-if-enrolled helper.
select tests.as_postgres();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values (gen_random_uuid(), (select sub from tests.subs where name = 'owner'), 'phone', 'totp', 'verified', now(), now(), 's');
select tests.as_aal('owner', 'aal1');
select throws_ok($$ select private.require_aal2_if_enrolled() $$, 'P0001', 'mfa_required',
  'a user with a verified factor must be at aal2 for sensitive actions');
select tests.as_aal('owner', 'aal2');
select lives_ok($$ select private.require_aal2_if_enrolled() $$, 'and passes at aal2');

select * from finish();
rollback;
