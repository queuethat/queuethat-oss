-- #417 review: private.mfa_verification_attempt is GoTrue's MFA verification hook. It locks an
-- account out of TOTP after 5 wrong codes in 15 minutes, whatever IP the guesses come from.
begin;
\ir ../helpers/_setup.psql
select plan(13);

create function tests.attempt(p_user uuid, p_valid boolean) returns text
language sql as $$
  select private.mfa_verification_attempt(jsonb_build_object(
    'factor_id', gen_random_uuid(), 'factor_type', 'totp', 'user_id', p_user, 'valid', p_valid)) ->> 'decision'
$$;

create temp table ids as select gen_random_uuid() as victim, gen_random_uuid() as bystander;

select is(tests.attempt((select victim from ids), true), 'continue', 'a right code continues');
select is(
  (select array_agg(tests.attempt((select victim from ids), false)) from generate_series(1, 4)),
  array['continue', 'continue', 'continue', 'continue'],
  'the first 4 wrong codes continue (GoTrue reports them as wrong)');
select is(tests.attempt((select victim from ids), false), 'reject', 'the 5th wrong code locks the account');
select is(tests.attempt((select victim from ids), true), 'reject', 'a right code is refused while locked');
select is(tests.attempt((select bystander from ids), true), 'continue', 'the lockout is per account');

update private.mfa_failures set at = now() - interval '16 minutes' where user_id = (select victim from ids);
select is(tests.attempt((select victim from ids), true), 'continue', 'the lockout ends after 15 minutes');
select is((select count(*)::int from private.mfa_failures), 0, 'expired failures are deleted');

select ok(
  not has_function_privilege('anon', 'private.mfa_verification_attempt(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.mfa_verification_attempt(jsonb)', 'execute')
  and has_function_privilege('supabase_auth_admin', 'private.mfa_verification_attempt(jsonb)', 'execute'),
  'only supabase_auth_admin can call the hook');
select ok(
  (select relrowsecurity from pg_class where oid = 'private.mfa_failures'::regclass)
  and not has_table_privilege('authenticated', 'private.mfa_failures', 'select'),
  'mfa_failures has RLS on and no client access');

-- Follow-ups from the #541 re-review.
update private.mfa_failures set at = now() - interval '16 minutes' where user_id = (select victim from ids);
select tests.attempt((select victim from ids), true);
-- 5 wrong codes lock; more guesses while locked are not recorded.
select array_agg(tests.attempt((select victim from ids), false)) from generate_series(1, 5);
select is((select count(*)::int from private.mfa_failures where user_id = (select victim from ids)), 5,
  'five wrong codes are recorded');
select tests.attempt((select victim from ids), false);
select tests.attempt((select victim from ids), false);
select is((select count(*)::int from private.mfa_failures where user_id = (select victim from ids)), 5,
  'wrong codes while locked are not recorded, so guessing cannot extend the lock');
-- the lock still ends 15 minutes after the oldest of the five
update private.mfa_failures set at = now() - interval '16 minutes'
where ctid = (select ctid from private.mfa_failures where user_id = (select victim from ids) limit 1);
select is(tests.attempt((select victim from ids), true), 'continue',
  'the lock ends once the oldest wrong code is 15 minutes old');
-- an attempt for one account leaves other accounts' expired rows alone
insert into private.mfa_failures (user_id, at) values ((select bystander from ids), now() - interval '1 hour');
select tests.attempt((select victim from ids), true);
select is((select count(*)::int from private.mfa_failures where user_id = (select bystander from ids)), 1,
  'the prune is scoped to the attempting account');

select * from finish();
rollback;
