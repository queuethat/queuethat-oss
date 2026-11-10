-- #474: the same phone joining twice got a second ticket, and guests on one venue Wi-Fi shared a
-- 10-join cap. join_queue takes a per-device key (a random id the browser keeps):
--
-- 1. A join from a device that already has an active visit on the queue returns that visit and
--    its status token, and changes nothing (interface rule 4). Repeating an idempotency key now
--    returns the token too, so a lost response no longer strands the guest on a bare ticket.
--    Tokens are still stored only as sha256 (I-7): a returned token is re-derived with an HMAC
--    from a Vault secret, never read back. A replayed key gets the token only from the device
--    that joined, because staff can read idempotency keys (#485 security review).
-- 2. The per-client limit is per IP and device, so guests behind one Wi-Fi each get their own,
--    with a much higher per-network cap behind it.

------------------------------------------------------------------------------------------------
-- Storage
------------------------------------------------------------------------------------------------

-- HMAC key for guest link tokens (private.visit_token), in Vault so a database dump without
-- the Vault root key cannot rebuild them. Rotating it is safe: stored hashes and every issued link
-- keep working; only replays of visits from before the rotation return a null token.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'guest_token_secret',
  'HMAC-SHA256 key for guest link tokens (private.visit_token). Rotate with vault.update_secret.')
where not exists (select 1 from vault.secrets where name = 'guest_token_secret');

alter table private.deployment_settings
  -- Online joins one network (client IP) may make to one queue in 10 minutes, whatever device keys
  -- it sends. Venue Wi-Fi and carrier NAT put many guests behind one IP: raise it for a big venue.
  add column per_network_joins int not null default 60 check (per_network_joins > 0);

alter table app.visits
  -- HMAC of the queue and the joining device's key (private.device_key_hash), online joins only.
  -- Lets a rejoin from the same phone find its active visit. Not the key itself, which would let
  -- a database reader claim the visit, and per queue, so no org can link a phone across orgs.
  add column device_key_hash bytea;
create index visits_device_active_idx on app.visits (queue_id, device_key_hash)
  where device_key_hash is not null and status in ('waiting', 'called', 'serving');

alter table private.join_log
  -- The client IP (or user) alone, for the per-network cap. client_key adds the device.
  add column network_key bytea;
create index join_log_network_idx on private.join_log (queue_id, network_key, at);

------------------------------------------------------------------------------------------------
-- Keys and tokens
------------------------------------------------------------------------------------------------

/**
 * The link token of a visit created by join_core: base64url(HMAC-SHA256(Vault secret
 * guest_token_secret, 'visit:' || visit_id || ':' || idempotency_key)), 43 characters like a
 * random 32-byte token.
 */
create function private.visit_token(p_visit_id uuid, p_idempotency_key uuid) returns text
language plpgsql stable set search_path = '' as $$
declare
  secret bytea := (select decode(s.decrypted_secret, 'base64') from vault.decrypted_secrets s
                   where s.name = 'guest_token_secret');
begin
  if secret is null then
    raise exception 'guest_token_secret is missing from Vault';
  end if;
  return rtrim(translate(encode(extensions.hmac(
           convert_to('visit:' || p_visit_id::text || ':' || p_idempotency_key::text, 'UTF8'),
           secret, 'sha256'), 'base64'), '+/', '-_'), '=');
end $$;
comment on function private.visit_token(uuid, uuid) is
  'The guest link token join_core issues for a visit: base64url(HMAC-SHA256(Vault secret '
  'guest_token_secret, ''visit:'' || visit_id || '':'' || idempotency_key)). Deterministic, so a '
  'replay can return it while the table keeps only private.token_hash. Visits from before this '
  'migration, or before a rotation of the secret, have tokens it does not reproduce; callers '
  'compare hashes before returning it. Raises when the secret is missing.';
revoke all on function private.visit_token(uuid, uuid) from public, anon, authenticated;

/** HMAC of a queue and a device key with the client key secret; null for a null key. */
create function private.device_key_hash(p_queue_id uuid, p_device_key text) returns bytea
language sql stable set search_path = '' as $$
  select extensions.hmac(convert_to('device:' || p_queue_id::text || ':' || p_device_key, 'UTF8'),
                         (select s.client_key_secret from private.deployment_settings s), 'sha256')
  where p_device_key is not null
$$;
comment on function private.device_key_hash(uuid, text) is
  'HMAC-SHA256 of a queue id and a join device key, as stored in visits.device_key_hash: the same '
  'phone has unrelated hashes on different queues, so orgs cannot link it. Null for a null key.';
revoke all on function private.device_key_hash(uuid, text) from public, anon, authenticated;

-- redefines private.client_key from 20261025004110_join_hardening.sql
drop function private.client_key();
/**
 * Who is joining, for per-client rate limits: the signed-in user (kiosks are users), or else the
 * client IP and, when given, the device key. Keyed with an HMAC so the log never holds a
 * recoverable IP. Null when neither is known (direct SQL).
 */
create function private.client_key(p_device_key text default null) returns bytea
language sql stable set search_path = '' as $$
  select extensions.hmac(convert_to(k, 'UTF8'), (select s.client_key_secret from private.deployment_settings s), 'sha256')
  from (
    select coalesce('user:' || (select auth.uid())::text,
                    'ip:' || private.client_ip()::text || coalesce(' device:' || p_device_key, '')) as k
  ) c
  where c.k is not null
$$;
comment on function private.client_key(text) is
  'HMAC-SHA256 of the caller''s identity for rate limits: the auth user id, or else the client '
  'IP (private.client_ip) plus p_device_key when given. Without p_device_key it is the network '
  'key. Null when the caller is unknown. On Supabase Cloud, check which header carries the real '
  'client IP and set deployment_settings.client_ip_header before going live.';
revoke all on function private.client_key(text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- redefines private.take_join_slot from 20261025004700_queue_join_ceiling.sql
-- take_join_slot: the 004700 body (hourly queue_total ceiling) with the client keyed by IP and
-- device, and a per-network cap
------------------------------------------------------------------------------------------------

drop function private.take_join_slot(app.queues, text);
/**
 * Rate limits for one join, taken inside join_core under its per-queue lock. Raises rate_limited
 * with DETAIL client, network, queue, queue_total or device; otherwise records the join so later calls count
 * it (the row rolls back with the join if anything after this fails). Staff adds are not limited.
 */
create function private.take_join_slot(p_queue app.queues, p_source text, p_device_key text default null)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  -- A person joins one queue a few times at most. Venue Wi-Fi puts many guests behind one IP, and
  -- each phone has its own device key; the network cap stops one client minting device keys.
  per_client_online constant int := 10;
  per_network_online int := (select s.per_network_joins from private.deployment_settings s);
  per_client_window constant interval := interval '10 minutes';
  v_client bytea := private.client_key(p_device_key);
  v_network bytea := private.client_key();
  v_recent int;
  v_queue_recent int;
begin
  if p_source = 'staff' then
    return;
  end if;

  -- Each kiosk gets join_rate_per_min to itself, so online floods never reach the front desk.
  if p_source = 'kiosk' then
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min then
      raise exception 'rate_limited' using detail = 'device';
    end if;
  else
    -- Online: per client (IP and device) first, then per network (IP).
    select count(*) into v_recent from private.join_log l
    where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - per_client_window;
    if v_recent >= per_client_online then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.network_key = v_network and l.at > now() - per_client_window)
       >= per_network_online then
      raise exception 'rate_limited' using detail = 'network';
    end if;
    -- Then, while the queue gets more than join_rate_per_min online joins a minute, each client
    -- gets one: anyone who joined in the window waits, but a guest who has not still gets in.
    -- Unknown callers count as having joined. The newcomer exemption stops at three times the
    -- rate, because fresh IPv6 /64s and device keys are cheap.
    select count(*) into v_queue_recent from app.visits v
    where v.queue_id = p_queue.id and v.source = 'online' and v.joined_at > now() - interval '1 minute';
    if v_queue_recent >= 3 * p_queue.join_rate_per_min
       or ((v_client is null or v_recent > 0) and v_queue_recent >= p_queue.join_rate_per_min) then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- Finally the total for the hour, whoever is asking. Visits that left or were served still
    -- count, so leaving and rejoining from new addresses gains nothing. Visits staff removed don't:
    -- clearing junk joins gives the slots back to real guests.
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source = 'online' and v.status <> 'removed'
          and v.joined_at > now() - interval '1 hour')
       >= p_queue.online_joins_per_hour then
      raise exception 'rate_limited' using detail = 'queue_total';
    end if;
  end if;

  if v_client is not null then
    insert into private.join_log (queue_id, client_key, network_key) values (p_queue.id, v_client, v_network);
  end if;
end $$;
revoke all on function private.take_join_slot(app.queues, text, text) from public, anon, authenticated;
comment on function private.take_join_slot(app.queues, text, text) is
  'Join rate limits, called by private.join_core under its queue lock. Raises rate_limited with '
  'DETAIL client (10 online joins per IP and device key per queue in 10 minutes), network '
  '(deployment_settings.per_network_joins, default 60, per IP per queue in 10 minutes, whatever '
  'device keys it sends), queue (the per-minute backstop at join_rate_per_min, newcomers up to '
  'three times it), queue_total (the queue already took online_joins_per_hour online joins in the '
  'last hour, from any clients, not counting visits staff removed) or device (a kiosk over '
  'join_rate_per_min a minute). Kiosk and staff joins never count toward the online limits.';

------------------------------------------------------------------------------------------------
-- redefines private.join_core from 20261025004110_join_hardening.sql
-- join_core: the 004110 body with derived tokens, token on replay, and device rejoin
------------------------------------------------------------------------------------------------

drop function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid);
create function private.join_core(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_source text,
  p_actor_kind app.actor_kind,
  p_actor_id uuid,
  p_device_key text default null,
  out visit_id uuid,
  out token text
)
language plpgsql volatile set search_path = '' as $$
declare
  q app.queues;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_party int := coalesce(p_party_size, 1);
  v_locale text := nullif(btrim(p_locale), '');
  v_device text := nullif(btrim(p_device_key), '');
  v_device_hash bytea;
  v_reason text;
  v_day date;
  v_number int;
  v_sort bigint;
  v_guest uuid;
  v_contact uuid;
  v_email_contact uuid;
  prior app.visits;
begin
  -- Input. Blank name, phone, email, locale or device key count as not given.
  if p_idempotency_key is null
     or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     or length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or v_party not between 1 and 50
     or length(v_locale) > 35 or v_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
     or v_device !~ '^[A-Za-z0-9_-]{22,128}$' then
    raise exception 'invalid_input';
  end if;
  -- Only an online join is one person's phone; a kiosk or a staff device serves many guests.
  if p_source <> 'online' then
    v_device := null;
  end if;

  -- FOR NO KEY UPDATE, first: joins to one queue run one at a time from here, so the capacity
  -- and rate counts below see every committed join and a repeated key or device finds the first
  -- visit; set_queue_state waits for in-flight joins; and bump_queue_version below needs no
  -- upgrade (upgrading from FOR SHARE deadlocks two concurrent joins).
  select * into q from app.queues where id = p_queue_id and archived_at is null for no key update;
  if not found then
    raise exception 'not_found';
  end if;
  if p_source = 'kiosk' and not private.is_device(q.org_id, q.location_id) then
    raise exception 'not_found';
  end if;
  if p_service_id is not null and not exists (
    select 1 from app.services s where s.id = p_service_id and s.queue_id = q.id and s.active
  ) then
    raise exception 'not_found';
  end if;
  v_device_hash := private.device_key_hash(q.id, v_device);

  -- The same key again, or the same phone with an active visit here: that visit, unchanged.
  select * into prior from app.visits v
  where v.queue_id = q.id and v.idempotency_key = p_idempotency_key;
  if not found and v_device_hash is not null then
    select * into prior from app.visits v
    where v.queue_id = q.id and v.device_key_hash = v_device_hash
      and v.status in ('waiting', 'called', 'serving')
    order by v.joined_at desc
    limit 1;
  end if;
  if prior.id is not null then
    visit_id := prior.id;
    -- The token goes back only to the caller that joined: the same source (never a staff add's
    -- token to a guest) and, online, the same device. Staff can read idempotency keys, so the key
    -- alone must not return a guest's link. And only when it is the derived one (older visits').
    token := private.visit_token(prior.id, prior.idempotency_key);
    if p_source = 'staff' or prior.source is distinct from p_source
       or (p_source = 'online' and (v_device_hash is null or prior.device_key_hash is distinct from v_device_hash))
       or private.token_hash(token) is distinct from prior.guest_token_hash then
      token := null;
    end if;
    return;
  end if;

  v_reason := private.queue_not_accepting_reason(q.id);
  if v_reason = 'full' then
    raise exception 'capacity_reached';
  elsif v_reason = 'org_suspended' then
    raise exception 'org_suspended';
  elsif v_reason is not null then
    raise exception 'queue_not_accepting' using detail = v_reason;
  end if;

  perform private.take_join_slot(q, p_source, v_device);

  -- Staff see the guest, so a staff add records (or links) the org's contact and guest. Any other
  -- join keeps the typed phone and email on the visit only.
  if p_source = 'staff' then
    if v_phone is not null then
      select c.contact_id, c.guest_id into v_contact, v_guest
      from private.ensure_contact(q.org_id, 'phone', v_phone, null, v_name, p_source, true) c;
    end if;
    if v_email is not null then
      select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
      from private.ensure_contact(q.org_id, 'email', v_email, v_guest, v_name, p_source, true) c;
      v_contact := coalesce(v_contact, v_email_contact);
    end if;
  end if;

  if v_locale is null then
    select o.default_locale into v_locale from app.organizations o where o.id = q.org_id;
  end if;

  v_day := private.service_day(q.location_id);
  v_number := private.next_ticket(q.id, q.ticket_prefix, v_day);
  -- Spaced so a later reorder can take a midpoint. Called guests count: requeue keeps their place.
  select coalesce(max(v.sort_key), 0) + 1024 into v_sort
  from app.visits v
  where v.queue_id = q.id and v.status in ('waiting', 'called');

  visit_id := gen_random_uuid();
  token := private.visit_token(visit_id, p_idempotency_key);

  perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix,
                          ticket_number, display_ticket, status, sort_key, party_size, guest_name,
                          guest_id, contact_id, guest_phone_e164, guest_email, locale,
                          guest_token_hash, device_key_hash, source, idempotency_key)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, q.ticket_prefix,
          v_number, q.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key);
  perform private.bump_queue_version(q.id);
end $$;
comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text) is
  'Adds a waiting visit for every join entry point, bumps the queue version, and returns its id '
  'and token (private.visit_token, stored only as private.token_hash). Repeating (queue, key), '
  'or an online join whose p_device_key has a waiting, called or serving visit on the queue, '
  'returns that visit and changes nothing, even after the queue stopped accepting; the token comes '
  'back only to the source that joined and, online, only with the same device key; never for '
  'staff adds; null for visits whose token the current secret does not derive. '
  'Concurrent joins to one queue are serialized and never deadlock. Order of checks: input '
  '(invalid_input; a device key is 22 to 128 base64url characters), queue and service (not_found; '
  'a kiosk outside the queue''s location, or of a non-active org, also gets not_found), replay, '
  'the accepting predicate (org_suspended when the org is not active, capacity_reached when full, '
  'queue_not_accepting with the reason as DETAIL), then rate limits (rate_limited, DETAIL client, '
  'network, queue, queue_total or device): online joins at most 10 per IP and device and '
  'deployment_settings.per_network_joins (60) per IP per queue in 10 minutes; while the queue has join_rate_per_min online joins in the last minute only '
  'clients that have not joined it in 10 minutes get in, up to three times that rate; at most online_joins_per_hour (default 120) '
  'online joins per queue in any hour, from all clients together (visits staff removed don''t '
  'count); each kiosk '
  'join_rate_per_min per minute on its own; staff unlimited. Kiosk and staff joins ignore the '
  'device key. The phone and email are stored on the visit. Only staff adds also create or link '
  'the org''s guest_contacts row and guest.';
revoke all on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text)
  from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- redefines api.join_queue from 20261025001000_join_queue.sql
-- join_queue: p_device_key appended with a default (interface rule 1); body otherwise unchanged
------------------------------------------------------------------------------------------------

drop function api.join_queue(uuid, uuid, text, text, text, int, text, uuid);
create function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_device_key text default null
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
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;
comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key), and per (queue, '
  'p_device_key) while that device''s visit is waiting, called or serving: a repeat returns the '
  'same visit and changes nothing, even once the queue has stopped accepting. The token comes back '
  'only to the device that joined (a replayed key needs the same p_device_key; kiosks get their '
  'own visits'' tokens), else null, as for visits older than the token secret. The token is '
  'base64url(HMAC-SHA256(Vault secret guest_token_secret, ''visit:'' || visit_id || '':'' || '
  'idempotency_key)), never stored or rotated; the visit keeps only its sha256. p_device_key is a random id the guest''s browser keeps (22 to 128 '
  'base64url characters); kiosks'' is ignored, since many guests share one. Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises queue_not_accepting '
  '(paused, closed or outside hours; the reason is the DETAIL), org_suspended (the org is not '
  'active), capacity_reached, rate_limited (DETAIL client: this phone on this network; network: '
  'this network; queue: everyone, for a minute; queue_total: the queue''s online joins for the '
  'hour; device: this kiosk), not_found (unknown queue or '
  'service, or a kiosk of another location), invalid_input (bad name, phone, email, party size, '
  'locale or device key, or no key). Later phases append parameters with defaults; never add '
  'join_* variants. Implemented in V1 (#30), device key in #474.';
revoke all on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text) from public;
grant execute on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
