-- #541 security re-review follow-ups to private.mfa_verification_attempt:
-- (1) the prune now touches only this account's rows, so an attempt for one account never waits on
--     row locks held by another account's in-flight attempt;
-- (2) once an account is locked, further wrong codes are not recorded, so a stream of guesses can't
--     keep an operator locked out indefinitely or grow the table. The lock still ends 15 minutes
--     after the fifth wrong code.
-- redefines private.mfa_verification_attempt from 20261029215642_mfa_lockout.sql

create or replace function private.mfa_verification_attempt(event jsonb) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  account uuid := (event ->> 'user_id')::uuid;
  locked jsonb := jsonb_build_object('decision', 'reject',
                                     'message', 'Too many wrong codes. Try again in 15 minutes.');
begin
  -- One attempt per account at a time: without this, a burst of parallel guesses all count
  -- fewer than five failures and all continue (#541 security re-review).
  perform pg_advisory_xact_lock(hashtextextended('mfa_failures:' || account::text, 0));
  delete from private.mfa_failures
  where user_id = account and at < now() - interval '15 minutes';
  if (select count(*) from private.mfa_failures where user_id = account) >= 5 then
    return locked;
  end if;
  if not coalesce((event ->> 'valid')::boolean, false) then
    insert into private.mfa_failures (user_id) values (account);
    if (select count(*) from private.mfa_failures where user_id = account) >= 5 then
      return locked;
    end if;
  end if;
  return jsonb_build_object('decision', 'continue');
end $$;
comment on function private.mfa_verification_attempt(jsonb) is
  'Supabase Auth MFA verification hook. Counts wrong codes per account; from the fifth within 15 '
  'minutes, rejects every attempt (right codes too) until the oldest one ages out, so the session '
  'stays aal1. Attempts while locked are not recorded, so the lock never extends itself. Returns '
  '{decision: continue|reject, message}. Never raises.';
