-- Security review of the anon API (PR #429 comment 6393612159, re-review on #441 comment
-- 6393938804): three fixes to the join path.
--
-- 1. Rate limits per client, not just per queue. One client could use the whole per-queue
--    budget and shut every guest and the kiosk out. Online joins now have a per-client cap per
--    queue with the per-queue cap as a backstop, and kiosk joins have their own per-device budget.
-- 2. Unauthenticated joins never create or link guest_contacts. Whoever typed a number first used
--    to own it. The number is now kept on the visit only, for that visit's messages. Contacts and
--    guests come only from staff adds (and, later, from a verified join).
-- 3. Guest functions that take a token accept POST only, so no client can be built to put the
--    bearer token in a URL (technical-design.md 5: tokens are absent from logs).

------------------------------------------------------------------------------------------------
-- 1. Per-client join log
------------------------------------------------------------------------------------------------

-- One row per accepted non-staff join. Holds a hashed client key, not an IP, and only for an hour.
create table private.join_log (
  queue_id uuid not null references app.queues (id) on delete cascade,
  client_key bytea not null,
  at timestamptz not null default now()
);
create index join_log_client_idx on private.join_log (queue_id, client_key, at);
create index join_log_at_idx on private.join_log (at);
revoke all on private.join_log from public, anon, authenticated;

create function ops.purge_join_log() returns int
language sql volatile set search_path = '' as $$
  with d as (delete from private.join_log where at < now() - interval '1 hour' returning 1)
  select count(*)::int from d
$$;
comment on function ops.purge_join_log() is
  'Deletes join_log rows older than an hour. Run every 10 minutes by pg_cron; returns rows deleted.';
select cron.schedule('purge-join-log', '*/10 * * * *', 'select ops.purge_join_log()');

-- Deployment settings that are not secrets for the API but must not be readable through it.
create table private.deployment_settings (
  -- Which request header carries the real client IP. x-real-ip is set by the API gateway (Kong)
  -- from the TCP peer, so a client cannot forge it: right for local, CI and self-hosting.
  -- cf-connecting-ip only when the origin accepts traffic from Cloudflare alone; otherwise
  -- clients set it themselves and rotate it to dodge per-client limits.
  client_ip_header text not null default 'x-real-ip'
    check (client_ip_header in ('x-real-ip', 'cf-connecting-ip')),
  -- HMAC key for client keys: IPv4 has 2^32 values, so a plain hash would be the IP.
  client_key_secret bytea not null default extensions.gen_random_bytes(32),
  singleton boolean primary key default true check (singleton)
);
insert into private.deployment_settings default values;
revoke all on private.deployment_settings from public, anon, authenticated;

/**
 * The caller's client IP from the configured header, with IPv6 reduced to its /64 (one host
 * normally owns a whole /64). Null when the header is missing or not an address.
 */
create function private.client_ip() returns inet
language plpgsql stable set search_path = '' as $$
declare
  raw text := btrim(current_setting('request.headers', true)::jsonb
                    ->> (select s.client_ip_header from private.deployment_settings s));
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
  'x-real-ip), IPv6 as its /64 network. Null when absent or malformed.';
revoke all on function private.client_ip() from public, anon, authenticated;

/**
 * Who is joining, for per-client rate limits: the signed-in user (kiosks are users) or else the
 * client IP. Keyed with an HMAC so the log never holds a recoverable IP. Null when neither is
 * known (direct SQL).
 */
create function private.client_key() returns bytea
language sql stable set search_path = '' as $$
  select extensions.hmac(convert_to(k, 'UTF8'), (select s.client_key_secret from private.deployment_settings s), 'sha256')
  from (
    select coalesce('user:' || (select auth.uid())::text, 'ip:' || private.client_ip()::text) as k
  ) c
  where c.k is not null
$$;
comment on function private.client_key() is
  'HMAC-SHA256 of the caller''s identity for rate limits: the auth user id, or else the client '
  'IP (private.client_ip). Null when the caller is unknown. On Supabase Cloud, check which header '
  'carries the real client IP and set deployment_settings.client_ip_header before going live.';
revoke all on function private.client_key() from public, anon, authenticated;

/**
 * Rate limits for one join, taken inside join_core under its per-queue lock. Raises rate_limited
 * with DETAIL client, queue or device; otherwise records the join so later calls count it (the
 * row rolls back with the join if anything after this fails). Staff adds are not limited.
 */
create function private.take_join_slot(p_queue app.queues, p_source text) returns void
language plpgsql volatile set search_path = '' as $$
declare
  -- A person joins one queue a few times at most; venue Wi-Fi puts many guests behind one IP.
  per_client_online constant int := 10;
  per_client_window constant interval := interval '10 minutes';
  v_client bytea := private.client_key();
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
    -- Online: per client first.
    select count(*) into v_recent from private.join_log l
    where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - per_client_window;
    if v_recent >= per_client_online then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    -- Then, while the queue gets more than join_rate_per_min online joins a minute, each client
    -- gets one: anyone who joined in the window waits, but a guest who has not still gets in.
    -- Unknown callers count as having joined. The newcomer exemption stops at three times the
    -- rate, because fresh IPv6 /64s are cheap (one /48 holds 65,536 of them).
    select count(*) into v_queue_recent from app.visits v
    where v.queue_id = p_queue.id and v.source = 'online' and v.joined_at > now() - interval '1 minute';
    if v_queue_recent >= 3 * p_queue.join_rate_per_min
       or ((v_client is null or v_recent > 0) and v_queue_recent >= p_queue.join_rate_per_min) then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
  end if;

  if v_client is not null then
    insert into private.join_log (queue_id, client_key) values (p_queue.id, v_client);
  end if;
end $$;
revoke all on function private.take_join_slot(app.queues, text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- 2. The number typed at an unauthenticated join stays on the visit
------------------------------------------------------------------------------------------------

alter table app.visits
  -- Typed by the guest at an online or kiosk join; used only for this visit's messages. Not a
  -- guest_contacts row: typing a number proves nothing about owning it.
  add column guest_phone_e164 text check (guest_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  add column guest_email text
    check (length(guest_email) <= 254 and guest_email = lower(guest_email) and guest_email like '%_@_%');

------------------------------------------------------------------------------------------------
-- redefines private.join_core from 20261025003700_join_version_bump.sql
-- join_core: the 20261025003700_join_version_bump.sql body (org_suspended, FOR NO KEY UPDATE,
-- version bump) with the rate limits in take_join_slot and contacts for staff adds only
------------------------------------------------------------------------------------------------

create or replace function private.join_core(
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
  v_reason text;
  v_day date;
  v_number int;
  v_sort bigint;
  v_guest uuid;
  v_contact uuid;
  v_email_contact uuid;
begin
  -- Input. Blank name, phone, email or locale count as not given.
  if p_idempotency_key is null
     or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     or length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or v_party not between 1 and 50
     or length(v_locale) > 35 or v_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$' then
    raise exception 'invalid_input';
  end if;

  -- FOR NO KEY UPDATE, first: joins to one queue run one at a time from here, so the capacity
  -- and rate counts below see every committed join and a repeated key finds the first visit;
  -- set_queue_state waits for in-flight joins; and bump_queue_version below needs no upgrade
  -- (upgrading from FOR SHARE deadlocks two concurrent joins).
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

  select v.id into visit_id
  from app.visits v
  where v.queue_id = q.id and v.idempotency_key = p_idempotency_key;
  if found then
    token := null;
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

  perform private.take_join_slot(q, p_source);

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

  token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');

  perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
  insert into app.visits (org_id, location_id, queue_id, service_id, service_day, ticket_prefix,
                          ticket_number, display_ticket, status, sort_key, party_size, guest_name,
                          guest_id, contact_id, guest_phone_e164, guest_email, locale,
                          guest_token_hash, source, idempotency_key)
  values (q.org_id, q.location_id, q.id, p_service_id, v_day, q.ticket_prefix,
          v_number, q.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), p_source, p_idempotency_key)
  returning id into visit_id;
  perform private.bump_queue_version(q.id);
end $$;
comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid) is
  'Adds a waiting visit for every join entry point, bumps the queue version, and returns its id '
  'and plaintext token (stored only as private.token_hash). Repeating (queue, key) returns the '
  'first visit with a null token and changes nothing, even after the queue stopped accepting. '
  'Concurrent joins to one queue are serialized and never deadlock. Order of checks: input '
  '(invalid_input), queue and service (not_found; a kiosk outside the queue''s location, or of a '
  'non-active org, also gets not_found), the accepting predicate (org_suspended when the org is '
  'not active, capacity_reached when full, queue_not_accepting with the reason as DETAIL), then '
  'rate limits (rate_limited, DETAIL client, queue or device): online joins at most 10 per client '
  'per queue in 10 minutes, and while the queue has join_rate_per_min online joins in the last '
  'minute only clients that have not joined it in 10 minutes get in, up to three times that rate; '
  'each kiosk '
  'join_rate_per_min per minute on its own; staff unlimited. The phone and email are stored on '
  'the visit. Only staff adds also create or link the org''s guest_contacts row and guest.';

------------------------------------------------------------------------------------------------
-- api.join_queue: COMMENT only (the body from V1 is unchanged)
------------------------------------------------------------------------------------------------

comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key): repeating a call returns '
  'the same visit, with a fresh token only on the first call and null afterwards, even once the '
  'queue has stopped accepting. Client values for priority, status, org or ticket are never '
  'accepted. Blank name, phone, email or locale count as not given; party size defaults to 1. '
  'The phone and email are kept on the visit for its own messages and never linked to an '
  'existing guest. Raises queue_not_accepting (paused, closed or outside hours; the reason is the '
  'DETAIL), org_suspended (the org is not active), capacity_reached, rate_limited (per client, per queue or per kiosk; DETAIL says '
  'which), not_found (unknown queue or service, or a kiosk of another location), invalid_input '
  '(bad name, phone, email, party size, locale, or no key). Later phases append parameters with '
  'defaults; never add join_* variants. Implemented in V1 (#30).';

------------------------------------------------------------------------------------------------
-- 3. Token-taking guest functions are POST only
------------------------------------------------------------------------------------------------

-- PostgREST serves any function over GET and HEAD (VOLATILE only makes writes fail in their
-- read-only transaction), so a client could put p_token in a URL, where gateways, CDNs and
-- browsers log it. This pre-request hook refuses every method but POST for api functions with a
-- p_token argument, so no client can be built to do it. The gateway still logs a refused URL. It lives in public because every API role must be able to run it;
-- public is not an exposed schema, so it is not itself callable as /rpc.
create function public.pgrst_pre_request() returns void
language plpgsql stable set search_path = '' as $$
begin
  if current_setting('request.method', true) is distinct from 'POST' and exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
      and '/rpc/' || p.proname = current_setting('request.path', true)
      and 'p_token' = any (p.proargnames)
  ) then
    raise exception 'token_in_url' using errcode = 'PT405',
      hint = 'Call this function with POST and the token in the body.';
  end if;
end $$;
comment on function public.pgrst_pre_request() is
  'PostgREST db-pre-request hook. Refuses every method but POST (HTTP 405) for api functions that '
  'take p_token, so no client works with the guest token in a URL. Add checks for every request '
  'here, nowhere else.';
revoke all on function public.pgrst_pre_request() from public;
grant execute on function public.pgrst_pre_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.pgrst_pre_request';
notify pgrst, 'reload config';
