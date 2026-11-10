-- Turnstile on online joins (pre-launch blocker named in #482). Off until an operator sets
-- private.deployment_settings.turnstile_site_key. Then every online join needs a single-use
-- pass, and only the join-pass Edge Function (service role) can issue one, after Cloudflare's
-- siteverify accepts the guest's Turnstile token. The join itself still goes from the browser
-- to api.join_queue, so the per-client limits and the device-bound token keep seeing the guest,
-- and the check sits inside the database, where calling the RPC directly can't skip it (I-8's
-- pattern). Kiosk joins and staff adds never need a pass.

alter table private.deployment_settings
  add column turnstile_site_key text check (turnstile_site_key ~ '^[0-9A-Za-z_-]{10,100}$');
comment on column private.deployment_settings.turnstile_site_key is
  'Cloudflare Turnstile site key (public). Null: no CAPTCHA on online joins. Set together with '
  'TURNSTILE_SECRET_KEY on the join-pass Edge Function; without that secret every online join '
  'fails closed with captcha_required.';

create table private.join_passes (
  pass_hash bytea primary key,
  expires_at timestamptz not null,
  -- Set when a join spends the pass. A replay of that join (same queue and key, which
  -- join_core answers with the same visit) may present it again for a day.
  queue_id uuid,
  idempotency_key uuid
);
create index join_passes_expires_idx on private.join_passes (expires_at);
revoke all on private.join_passes from public, anon, authenticated;

create function api.issue_join_pass() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  pass text := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
begin
  delete from private.join_passes where expires_at < now() - interval '1 day';
  insert into private.join_passes (pass_hash, expires_at)
  values (extensions.digest(pass, 'sha256'), now() + interval '5 minutes');
  return pass;
end $$;
comment on function api.issue_join_pass() is
  'Issues a pass for one online join, valid for 5 minutes: 32 random bytes, base64url. Only its '
  'sha256 is stored. Service role only: the join-pass Edge Function calls it after Turnstile '
  'accepts the guest''s token.';
revoke all on function api.issue_join_pass() from public, anon, authenticated;
grant execute on function api.issue_join_pass() to service_role;

/**
 * Spends `p_pass` on the join of `p_queue_id` with `p_key` when Turnstile is on; does nothing
 * when it's off. Runs in the join's transaction, so a join the database refuses leaves the pass
 * unspent. A replay must name the same queue and key: join_core dedupes per (queue, key), so
 * anything looser would let one pass buy a visit on every queue (#560 security review). The
 * replay window (a day) is shorter than idempotency keys live (48 h).
 */
create function private.spend_join_pass(p_pass text, p_queue_id uuid, p_key uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if (select s.turnstile_site_key from private.deployment_settings s) is null then
    return;
  end if;
  update private.join_passes p set queue_id = p_queue_id, idempotency_key = p_key
  where p.pass_hash = extensions.digest(coalesce(p_pass, ''), 'sha256')
    and ((p.idempotency_key is null and p.expires_at > now())
         or (p.queue_id = p_queue_id and p.idempotency_key = p_key
             and p.expires_at > now() - interval '1 day'));
  if not found then
    raise exception 'captcha_required';
  end if;
end $$;
revoke all on function private.spend_join_pass(text, uuid, uuid) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- redefines api.get_location_public from 20261025120416_join_page_online_full.sql
-- get_location_public: the 120416 body, plus the deployment's Turnstile site key
------------------------------------------------------------------------------------------------

alter type api.location_public add attribute captcha_site_key text;

create or replace function api.get_location_public(p_location_slug text) returns api.location_public
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  result api.location_public;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null then
    raise exception 'not_found';
  end if;

  select l.id, l.name, l.slug, l.tz, l.address, l.contact,
         coalesce(array_agg(row(
           q.id, q.name, q.manual_state, r.reason is null, r.reason,
           (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
           e.eta_state, e.eta_low, e.eta_high, q.pulse_id,
           array(select row(s.id, s.name, s.description)::api.public_service
                 from app.services s
                 where s.queue_id = q.id and s.active
                 order by s.sort_order, s.name)
         )::api.public_queue order by q.sort_order, q.name) filter (where q.id is not null),
         '{}'),
         l.country_code,
         (select s.turnstile_site_key from private.deployment_settings s)
  into result
  from (select 1) one
  left join app.queues q on q.location_id = l.id and q.archived_at is null
  -- This page is the online entry point, so the hourly online ceiling counts as not accepting.
  left join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r on true
  left join lateral private.queue_eta(q.id) e on true;
  return result;
end $$;
comment on function api.get_location_public(text) is
  'Public view of a location by its slug (or a redirected old slug; slug is always the current '
  'one): name, contact, country (null when not set), and each non-archived queue with its '
  'accepting state and reason, waiting count, ETA for someone joining now, pulse topic and '
  'active services. Reasons are those of queue_not_accepting_reason, then ''online_full'' when '
  'the queue reached its hourly online-join ceiling (join_queue would refuse it with '
  'rate_limited, DETAIL queue_total); staff can still add guests then. captcha_site_key is the '
  'Turnstile site key when online joins need a pass (api.issue_join_pass), else null. Contains '
  'no guest data. Raises not_found for an unknown slug.';

------------------------------------------------------------------------------------------------
-- redefines api.join_queue from 20261025004800_join_device_key.sql
-- join_queue: the 004800 body, plus p_join_pass spent on online joins
------------------------------------------------------------------------------------------------

drop function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text);
create function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_device_key text default null,
  p_join_pass text default null
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  joined record;
  result api.join_result;
begin
  if private.device_kind() = 'kiosk' then
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'kiosk', 'device', (select auth.uid()));
  else
    perform private.spend_join_pass(p_join_pass, p_queue_id, p_idempotency_key);
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;
comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text) is
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
  'leaves it unspent. Kiosks need none. Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises captcha_required (online '
  'join without a valid pass), queue_not_accepting '
  '(paused, closed or outside hours; the reason is the DETAIL), org_suspended (the org is not '
  'active), capacity_reached, rate_limited (DETAIL client: this phone on this network; network: '
  'this network; queue: everyone, for a minute; queue_total: the queue''s online joins for the '
  'hour; device: this kiosk), not_found (unknown queue or '
  'service, or a kiosk of another location), invalid_input (bad name, phone, email, party size, '
  'locale or device key, or no key). Later phases append parameters with defaults; never add '
  'join_* variants. Implemented in V1 (#30), device key in #474, join pass for Turnstile.';
revoke all on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text) from public;
grant execute on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
