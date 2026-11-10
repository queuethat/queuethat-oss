-- Turnstile hostname check (pre-launch, #560 security review). siteverify reports the hostname
-- the widget ran on. A site key is public, so another site can embed it and mint tokens there;
-- with Turnstile on, a pass is now issued only for one of the deployment's own hostnames.
-- The join-pass Edge Function forwards siteverify's hostname and the database owns the list,
-- next to the site key it belongs with.

/** True when every element is a bare lowercase hostname: no scheme, port, path, blank or null. */
create function private.is_hostname_list(p_hosts text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(coalesce(h ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$', false)), true)
  from unnest(p_hosts) h
$$;

alter table private.deployment_settings
  add column turnstile_hostnames text[] not null default '{}'
    check (private.is_hostname_list(turnstile_hostnames));
comment on column private.deployment_settings.turnstile_hostnames is
  'Bare lowercase hostnames the join page is served on (the host of the app''s public URL, plus '
  'any other). With turnstile_site_key set, join-pass issues no pass for a token solved '
  'anywhere else; an empty list means no passes at all (fails closed).';

------------------------------------------------------------------------------------------------
-- redefines api.issue_join_pass from 20261029205946_join_pass.sql
-- issue_join_pass: the 205946 body, plus the hostname check before the insert
------------------------------------------------------------------------------------------------

drop function api.issue_join_pass();
create function api.issue_join_pass(p_hostname text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  s private.deployment_settings;
  pass text := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
begin
  select * into s from private.deployment_settings;
  if s.turnstile_site_key is not null
     and (p_hostname is null or not lower(p_hostname) = any (s.turnstile_hostnames)) then
    raise exception 'captcha_required' using detail = 'hostname';
  end if;
  delete from private.join_passes where expires_at < now() - interval '1 day';
  insert into private.join_passes (pass_hash, expires_at)
  values (extensions.digest(pass, 'sha256'), now() + interval '5 minutes');
  return pass;
end $$;
comment on function api.issue_join_pass(text) is
  'Issues a pass for one online join, valid for 5 minutes: 32 random bytes, base64url. Only its '
  'sha256 is stored. p_hostname is the hostname Cloudflare''s siteverify reported for the token; '
  'with Turnstile on it must be in deployment_settings.turnstile_hostnames (case-insensitive), '
  'else raises captcha_required (DETAIL hostname). Service role only: the join-pass Edge '
  'Function calls it after Turnstile accepts the guest''s token.';
revoke all on function api.issue_join_pass(text) from public, anon, authenticated;
grant execute on function api.issue_join_pass(text) to service_role;

notify pgrst, 'reload schema';
