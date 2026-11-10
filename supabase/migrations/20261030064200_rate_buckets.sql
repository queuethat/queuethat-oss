-- 2A-JN2 (#112): per-IP rate buckets for the public-join Edge Function, and the two database
-- changes that function needs: the service role joins without a Turnstile pass (the function
-- verifies its own CAPTCHA), and private.client_ip believes the service role's forwarded address.

create table private.rate_buckets (
  key text not null check (length(key) <= 200),
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);
comment on table private.rate_buckets is
  'Fixed-window counters for api.hit_rate_limit. Keys hold hashes (sha256 of ip + daily salt), never raw addresses.';
revoke all on private.rate_buckets from public, anon, authenticated;

-- In api, not ops as the ticket sketched: PostgREST exposes only api (config.toml), and the Edge Function
-- reaches the database through it. Nothing but service_role may execute it.
create function api.hit_rate_limit(p_key text, p_limit int, p_window_seconds int, p_count boolean default true)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  w timestamptz;
  n int;
begin
  if p_key is null or length(p_key) not between 1 and 200 or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid_input';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  if p_count then
    insert into private.rate_buckets as b (key, window_start, count) values (p_key, w, 1)
    on conflict (key, window_start) do update set count = b.count + 1
    returning b.count into n;
    return n <= p_limit;
  end if;
  select b.count into n from private.rate_buckets b where b.key = p_key and b.window_start = w;
  return coalesce(n, 0) < p_limit;
end $$;
comment on function api.hit_rate_limit(text, int, int, boolean) is
  'Fixed-window rate limit. Counts one hit on p_key in the current p_window_seconds window and '
  'returns true while the count is within p_limit, false once over. With p_count false it only '
  'looks: true while another hit would still be within the limit. Service role only; the '
  'public-join Edge Function passes hashed keys. Raises invalid_input for a bad key, limit or window.';
revoke all on function api.hit_rate_limit(text, int, int, boolean) from public, anon, authenticated;
grant execute on function api.hit_rate_limit(text, int, int, boolean) to service_role;

create function ops.purge_rate_buckets() returns int
language sql volatile security definer set search_path = '' as $$
  with d as (delete from private.rate_buckets where window_start < now() - interval '1 day' returning 1)
  select count(*)::int from d
$$;
comment on function ops.purge_rate_buckets() is 'Deletes rate buckets older than a day. Run daily by pg_cron; returns rows deleted.';
revoke all on function ops.purge_rate_buckets() from public, anon, authenticated;
select cron.schedule('purge-rate-buckets', '23 3 * * *', 'select ops.purge_rate_buckets()');

-- redefines private.client_ip from 20261025004110_join_hardening.sql
create or replace function private.client_ip() returns inet
language plpgsql stable set search_path = '' as $$
declare
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  -- The public-join Edge Function reaches PostgREST through Kong, which overwrites x-real-ip with
  -- its own peer, so it forwards the guest's address in x-qm-client-ip. Only the service role
  -- (that function's key) is believed; anyone else's copy of the header is ignored.
  raw text := btrim(coalesce(
    case when (select auth.role()) = 'service_role' then headers ->> 'x-qm-client-ip' end,
    headers ->> (select s.client_ip_header from private.deployment_settings s)));
  ip inet;
begin
  if raw is null or raw = '' then
    return null;
  end if;
  begin
    ip := raw::inet;
  exception when invalid_text_representation then
    return null;
  end;
  if family(ip) = 6 then
    return network(set_masklen(ip, 64));
  end if;
  return host(ip)::inet;
end $$;

comment on function private.client_ip() is
  'Client IP from the header named in private.deployment_settings.client_ip_header (default '
  'x-real-ip), IPv6 as its /64 network. x-qm-client-ip replaces it for the service role (public-join). Null when absent or malformed.';

-- redefines api.join_queue from 20261030045508_api_contracts_2a.sql
create or replace function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_device_key text default null,
  p_join_pass text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  joined record;
  result api.join_result;
begin
  if private.device_kind() = 'kiosk' then
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'kiosk', 'device', (select auth.uid()),
      null, p_answers, p_group_key, p_onsite_code);
  else
    -- The public-join Edge Function (service role) has already verified the CAPTCHA with its own
    -- provider (2A-JN2); everyone else needs a Turnstile pass when the deployment has a site key.
    if (select auth.role()) is distinct from 'service_role' then
      perform private.spend_join_pass(p_join_pass, p_queue_id, p_idempotency_key);
    end if;
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key,
      p_answers, p_group_key, p_onsite_code);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;

comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key), and per (queue, '
  'p_device_key) while that device''s visit is waiting, called or serving: a repeat returns the '
  'same visit and changes nothing, even once the queue has stopped accepting. The token comes back '
  'only to the device that joined (a replayed key needs the same p_device_key; kiosks get their '
  'own visits'' tokens), else null, as for visits older than the token secret. The token is '
  'base64url(HMAC-SHA256(Vault secret guest_token_secret, ''visit:'' || visit_id || '':'' || '
  'idempotency_key)), never stored or rotated; the visit keeps only its sha256. p_device_key is a random id the guest''s browser keeps (22 to 128 '
  'base64url characters); kiosks'' is ignored, since many guests share one. When the deployment '
  'has a Turnstile site key, an online join needs p_join_pass from api.issue_join_pass: unused '
  'and unexpired, or spent within the last day on this same queue and p_idempotency_key (a '
  'replay); a refused join '
  'leaves it unspent. Kiosks need none, and neither does the service role (the public-join Edge Function, which verifies its CAPTCHA before calling). Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises captcha_required (online '
  'join without a valid pass), queue_not_accepting '
  '(paused, closed or outside hours; the reason is the DETAIL), org_suspended (the org is not '
  'active), capacity_reached, rate_limited (DETAIL client: this phone on this network; network: '
  'this network; queue: everyone, for a minute; queue_total: the queue''s online joins for the '
  'hour; device: this kiosk), not_found (unknown queue or '
  'service, or a kiosk of another location), invalid_input (bad name, phone, email, party size, '
  'locale or device key, or no key). p_answers (intake answers, 2A-Q5), p_group_key (join as '
  'a group, 2A-J15A) and p_onsite_code (the code on the display, 2A-JN5) are accepted and '
  'ignored until those tickets land; later they add party_size_out_of_range, invalid_answers, '
  'onsite_code_required, onsite_code_invalid, captcha_failed and too_many_active_visits. Later '
  'phases append parameters with defaults; never add join_* variants. Implemented in V1 (#30), '
  'device key in #474, join pass for Turnstile.';
