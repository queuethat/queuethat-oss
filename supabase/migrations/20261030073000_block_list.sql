-- 2P-PRV5 (#192): per-org block list by phone, email and device (C-8). Blocked online and kiosk
-- joins get the answer a closed queue gives; a staff add raises guest_blocked. Only hashes are
-- stored: phone and email with the platform block's Vault-keyed HMAC, devices with the per-queue
-- device_key_hash (so a device block covers the queue it joined, not the whole org). The platform
-- list (PLT8) is unchanged and checked first.

create table app.blocked_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  kind text not null check (kind in ('phone_hash', 'email_hash', 'device_key')),
  value_hash bytea not null,
  -- device blocks are per queue; null for contact blocks
  queue_id uuid,
  reason text not null check (length(btrim(reason)) between 1 and 200),
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'device_key') = (queue_id is not null)),
  foreign key (org_id, queue_id) references app.queues (org_id, id) on delete cascade,
  unique (org_id, id)
);
create unique index blocked_identities_value_idx
  on app.blocked_identities (org_id, kind, value_hash, coalesce(queue_id, '00000000-0000-0000-0000-000000000000'));
create trigger forbid_org_change before update on app.blocked_identities
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.blocked_identities
  for each row execute function private.audit_row();
revoke insert, update, delete, truncate on app.blocked_identities from authenticated;
alter table app.blocked_identities enable row level security;
create policy blocked_identities_select on app.blocked_identities for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));

create function private.is_org_blocked(
  p_org_id uuid, p_queue_id uuid, p_phone_e164 text, p_email text, p_device_hash bytea
) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from app.blocked_identities where org_id = p_org_id) then
    return false;
  end if;
  return exists (
    select 1 from app.blocked_identities b
    where b.org_id = p_org_id and (b.expires_at is null or b.expires_at > now())
      and ((b.kind = 'phone_hash' and b.value_hash = private.contact_block_hash('phone', p_phone_e164))
        or (b.kind = 'email_hash' and b.value_hash = private.contact_block_hash('email', p_email))
        or (b.kind = 'device_key' and b.queue_id = p_queue_id and b.value_hash = p_device_hash))
  );
end $$;
comment on function private.is_org_blocked(uuid, uuid, text, text, bytea) is
  'True when an unexpired block of this org matches the phone, the email or the device hash on '
  'this queue. Plaintext never touches the table. Not exposed.';
revoke all on function private.is_org_blocked(uuid, uuid, text, text, bytea) from public, anon, authenticated;

create function api.block_from_visit(
  p_visit_id uuid, p_reason text, p_expires_at timestamptz, p_idempotency_key uuid
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_claim record;
  v_first uuid;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'manager') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null or nullif(btrim(p_reason), '') is null or length(btrim(p_reason)) > 200
     or p_expires_at <= now() then
    raise exception 'invalid_input';
  end if;
  select * into v_claim from private.claim_idempotent(v.org_id, 'block_from_visit', p_idempotency_key);
  if v_claim.replay then
    return (v_claim.response ->> 'id')::uuid;
  end if;

  insert into app.blocked_identities (org_id, kind, value_hash, queue_id, reason, created_by, expires_at)
  select v.org_id, x.kind, x.hash, case when x.kind = 'device_key' then v.queue_id end,
         btrim(p_reason), (select auth.uid()), p_expires_at
  from (values (private.contact_block_hash('phone', v.guest_phone_e164), 'phone_hash'),
               (private.contact_block_hash('email', v.guest_email), 'email_hash'),
               (v.device_key_hash, 'device_key')) as x(hash, kind)
  where x.hash is not null
  on conflict (org_id, kind, value_hash, coalesce(queue_id, '00000000-0000-0000-0000-000000000000'))
  do update set reason = excluded.reason, expires_at = excluded.expires_at, created_by = excluded.created_by;
  select b.id into v_first from app.blocked_identities b
  where b.org_id = v.org_id
    and b.value_hash in (private.contact_block_hash('phone', v.guest_phone_e164),
                         private.contact_block_hash('email', v.guest_email), v.device_key_hash)
  order by b.kind desc, b.created_at limit 1;
  if v_first is null then
    raise exception 'invalid_input'; -- the visit carries no phone, email or device to block
  end if;
  perform private.save_idempotent('block_from_visit', p_idempotency_key, jsonb_build_object('id', v_first));
  return v_first;
end $$;
comment on function api.block_from_visit(uuid, text, timestamptz, uuid) is
  'Blocks the visit''s phone, email and device (whatever it carries) for the org, until '
  'p_expires_at or forever when null; manager or above of the visit''s location. Returns one of '
  'the block ids (listing shows all). Blocked online and kiosk joins get queue_not_accepting, '
  'staff adds guest_blocked. Re-blocking updates reason and expiry. Raises not_found for a visit '
  'outside the caller''s orgs, invalid_input for a blank reason, a past expiry or a visit with '
  'nothing to block. Idempotent on p_idempotency_key. Implemented in 2P-PRV5 (#192).';

create function api.unblock(p_block_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  b app.blocked_identities;
begin
  select * into b from app.blocked_identities where id = p_block_id;
  if not found or not private.has_role(b.org_id, null, 'manager') then
    return; -- unknown, already lifted and foreign ids look the same
  end if;
  -- A contact block covers the whole org, so lifting it needs a manager of every location.
  if b.kind <> 'device_key' and not exists (
       select 1 from app.memberships m
       where m.user_id = (select auth.uid()) and m.org_id = b.org_id and m.location_ids is null) then
    return;
  end if;
  if b.kind = 'device_key' and not private.has_role(
       b.org_id, (select q.location_id from app.queues q where q.id = b.queue_id), 'manager') then
    return;
  end if;
  delete from app.blocked_identities where id = b.id;
end $$;
comment on function api.unblock(uuid) is
  'Lifts one block of the caller''s org; manager or above (device blocks: of the queue''s '
  'location; phone and email blocks cover the whole org, so a manager of every location). '
  'Anything else, including unknown, already lifted and other orgs'' ids, does nothing. '
  'Implemented in 2P-PRV5 (#192).';

revoke all on function api.block_from_visit(uuid, text, timestamptz, uuid), api.unblock(uuid) from public, anon;
grant execute on function api.block_from_visit(uuid, text, timestamptz, uuid), api.unblock(uuid) to authenticated;

-- redefines private.join_core from 20261030063000_party_groups.sql
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
  p_device_key text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null,
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
  l app.locations;
begin
  -- Input. Blank name, phone, email, locale or device key count as not given.
  if p_idempotency_key is null
     or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     -- Plain ASCII local@domain only (#479 re-review): no quoted local parts, comments, IP
     -- literals, trailing dots or look-alike letters, so canonical_email and the block list see
     -- every address the way mail servers route it.
     or length(v_email) > 254
     or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$'
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
  -- A group join (2A-J15A) is several people from one device: only the key replays it.
  if not found and v_device_hash is not null and p_group_key is null then
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

  -- 2A-JN5: public joins to a location that requires it must type the code on its TV (current or
  -- previous window). Checked after the accepting predicate and before any rate slot is taken, so
  -- a wrong code costs the caller nothing but the answer. Kiosk and staff joins are exempt.
  if p_source = 'online' then
    select * into l from app.locations where id = q.location_id;
    if l.onsite_code_required then
      if nullif(btrim(p_onsite_code), '') is null then
        raise exception 'onsite_code_required';
      elsif btrim(p_onsite_code) not in (private.onsite_code(l.id, now()),
                                         private.onsite_code(l.id, now() - make_interval(mins => l.onsite_code_rotate_minutes))) then
        raise exception 'onsite_code_invalid';
      end if;
    end if;
  end if;

  -- PLT8: a contact blocked across the platform gets the same answer as a per-client flood, so an
  -- abuser learns nothing. Staff adds are exempt (design 3.5: staff joins carry a block-list override).
  if p_source <> 'staff' and private.is_blocked(q.org_id, v_phone, v_email) then
    raise exception 'rate_limited' using detail = 'client';
  end if;

  -- 2P-PRV5: this org's own block list (phone, email, device). Online and kiosk joins get the answer
  -- a closed queue gives, so an abuser learns nothing; a staff add is refused with guest_blocked
  -- until the block is lifted.
  if private.is_org_blocked(q.org_id, q.id, v_phone, v_email, v_device_hash) then
    if p_source = 'staff' then
      raise exception 'guest_blocked';
    end if;
    raise exception 'queue_not_accepting' using detail = 'closed';
  end if;

  -- 2A-J15A: one phone (or, online, one device) may hold several active visits, up to the queue's
  -- cap; the cap is a bound on abuse, not a ban. Staff adds are exempt.
  if p_source <> 'staff' and (
    select count(*) from app.visits v
    where v.queue_id = q.id and v.status in ('waiting', 'called', 'serving')
      and ((v_phone is not null and v.guest_phone_e164 = v_phone)
           or (v_device_hash is not null and v.device_key_hash = v_device_hash))
  ) >= q.max_active_per_contact then
    raise exception 'too_many_active_visits';
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
                          guest_token_hash, device_key_hash, source, idempotency_key, group_key)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, q.ticket_prefix,
          v_number, q.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key, p_group_key);
  perform private.bump_queue_version(q.id);
end $$;

comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, text, jsonb, uuid, text) is
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
  'queue_not_accepting with the reason as DETAIL), then the platform contact block list for '
  'non-staff sources (rate_limited, DETAIL client, the same answer as the per-client cap), then '
  'rate limits (rate_limited, DETAIL client, '
  'network, queue, queue_total or device): online joins at most 10 per IP and device and '
  'deployment_settings.per_network_joins (60) per IP per queue in 10 minutes; while the queue has join_rate_per_min online joins in the last minute only '
  'clients that have not joined it in 10 minutes get in, up to three times that rate; at most online_joins_per_hour (default 120) '
  'online joins per queue in any hour, from all clients together (visits staff removed don''t '
  'count); each kiosk '
  'join_rate_per_min per minute on its own; staff unlimited. Kiosk and staff joins ignore the '
  'device key. An email must be a plain ASCII local@domain (no quotes, comments, IP literals or '
  'trailing dot) of at most 254 characters. The phone and email are stored on the visit. Only '
  'staff adds also create or link the org''s guest_contacts row and guest. p_answers (intake, '
  '2A-Q5) is accepted and ignored until that ticket lands. p_group_key links the visits of one group on the visit (a group join skips the device-key replay, so a parent can join several people; only the idempotency key replays it). A non-staff join raises too_many_active_visits when the phone or, online, the device already holds queues.max_active_per_contact waiting, called or serving visits on the queue. When the '
  'location requires an on-site code, an online join without the displayed code (current or previous window) '
  'raises onsite_code_required or onsite_code_invalid, after the accepting predicate and before rate limits; kiosk and staff joins are exempt. A kiosk device of another location gets not_found (checked via is_device). Next, the org''s block list (private.is_org_blocked): non-staff joins get queue_not_accepting with DETAIL closed, staff adds get guest_blocked.';
