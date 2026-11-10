-- PLT11 (#417): a per-account limit on wrong authenticator codes. GoTrue's own MFA limit is per
-- IP (and skipped without GOTRUE_RATE_LIMIT_HEADER), and it never locks a factor, so someone with
-- an operator's password could guess 6-digit codes from many IPs (#541 security review).
-- Supabase Auth calls this hook on every TOTP verification ([auth.hook.mfa_verification_attempt]
-- in config.toml); it runs as supabase_auth_admin, not through PostgREST.

create table private.mfa_failures (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index mfa_failures_user_idx on private.mfa_failures (user_id, at);
alter table private.mfa_failures enable row level security;
comment on table private.mfa_failures is
  'Wrong authenticator codes in the last 15 minutes, per account. Written only by the MFA hook.';

create function private.mfa_verification_attempt(event jsonb) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  account uuid := (event ->> 'user_id')::uuid;
begin
  -- One attempt per account at a time: without this, a burst of parallel guesses all count
  -- fewer than five failures and all continue (#541 security re-review).
  perform pg_advisory_xact_lock(hashtextextended('mfa_failures:' || account::text, 0));
  delete from private.mfa_failures where at < now() - interval '15 minutes';
  if not coalesce((event ->> 'valid')::boolean, false) then
    insert into private.mfa_failures (user_id) values (account);
  end if;
  if (select count(*) from private.mfa_failures where user_id = account) >= 5 then
    return jsonb_build_object('decision', 'reject',
                              'message', 'Too many wrong codes. Try again in 15 minutes.');
  end if;
  return jsonb_build_object('decision', 'continue');
end $$;
comment on function private.mfa_verification_attempt(jsonb) is
  'Supabase Auth MFA verification hook. Counts wrong codes per account; from the fifth within 15 '
  'minutes, rejects every attempt (right codes too) until the oldest one ages out, so the session '
  'stays aal1. Returns {decision: continue|reject, message}. Never raises.';

grant usage on schema private to supabase_auth_admin;
grant select, insert, delete on private.mfa_failures to supabase_auth_admin;
create policy mfa_failures_auth on private.mfa_failures for all to supabase_auth_admin
  using (true) with check (true);
revoke all on function private.mfa_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function private.mfa_verification_attempt(jsonb) to supabase_auth_admin;
