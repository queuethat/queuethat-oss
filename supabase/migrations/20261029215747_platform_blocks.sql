-- PLT8 (#414): a platform-wide contact block list checked at join (technical-design.md 3.6).
-- A spammer who moves between shops is stopped everywhere by one operator action.
--
--   * No plaintext: rows hold an HMAC-SHA-256 of the canonical value (E.164 phone; email through
--     private.canonical_email, so +tags, Gmail dots and provider aliases share one hash) keyed by a pepper in Vault (`contact_block_pepper`), created here once per
--     database. A table dump without the pepper can't be brute-forced from known numbers.
--     Rotating the pepper invalidates every block.
--   * One owner of "is this contact blocked" (rule 2): private.is_blocked. The per-org block list
--     (2A, C-8) extends that function; it already takes the org.
--   * A blocked join gets `rate_limited`, the same code as the flood cap, so an abuser can't tell
--     they are blocked.
--   * A block reason that contains the contact is rejected, so plaintext can't reach the row or
--     the audit through the free-text field (#465).

------------------------------------------------------------------------------------------------
-- Pepper
------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'contact_block_pepper') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'contact_block_pepper',
      'HMAC key for app.platform_blocks.contact_hash (PLT8). Rotating it invalidates every block.');
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- Table
------------------------------------------------------------------------------------------------

create table app.platform_blocks (
  contact_hash bytea primary key,
  kind app.contact_channel not null,
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- null blocks until removed
  expires_at timestamptz
);

------------------------------------------------------------------------------------------------
-- Hashing and the check
------------------------------------------------------------------------------------------------

create function private.contact_block_hash(p_kind app.contact_channel, p_value text) returns bytea
language plpgsql stable set search_path = '' as $$
declare
  v text;
  pepper text;
begin
  if p_kind = 'phone' then
    v := nullif(regexp_replace(coalesce(p_value, ''), '[[:space:]().-]', '', 'g'), '');
    if v !~ '^\+[1-9][0-9]{6,14}$' then return null; end if;
  else
    v := nullif(lower(btrim(p_value)), '');
    if length(v) > 254 or v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then return null; end if;
    -- One owner for "which inbox is this": the same canonical form as the mail abuse limits.
    v := private.canonical_email(v);
  end if;
  select s.decrypted_secret into pepper from vault.decrypted_secrets s where s.name = 'contact_block_pepper';
  if pepper is null then
    raise exception 'contact_block_pepper is missing from vault';
  end if;
  return extensions.hmac(p_kind::text || ':' || v, pepper, 'sha256');
end $$;
comment on function private.contact_block_hash(app.contact_channel, text) is
  'HMAC-SHA-256 of the canonical contact. Phone: strip spaces, dots, dashes and parentheses, must '
  'be E.164. Email: must look like local@domain.tld, then private.canonical_email, so address '
  'variants that reach one inbox share one hash. Null for an invalid or blank value. Raises when '
  'the Vault pepper is missing.';

create function private.is_blocked(p_org_id uuid, p_phone_e164 text, p_email text) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  -- Most joins carry no contact, and most databases have no blocks: skip the Vault read.
  if (p_phone_e164 is null and p_email is null) or not exists (select 1 from app.platform_blocks) then
    return false;
  end if;
  return exists (
    select 1 from app.platform_blocks b
    where b.contact_hash in (private.contact_block_hash('phone', p_phone_e164),
                             private.contact_block_hash('email', p_email))
      and (b.expires_at is null or b.expires_at > now())
  );
end $$;
comment on function private.is_blocked(uuid, text, text) is
  'True when the phone or email is on the platform block list and the block has not expired. '
  'p_org_id is for the per-org list (2A), which extends this function. The only block check.';

revoke all on function private.contact_block_hash(app.contact_channel, text) from public, anon, authenticated;
revoke all on function private.is_blocked(uuid, text, text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- private.join_core
------------------------------------------------------------------------------------------------

-- redefines private.join_core from 20261025093000_join_email_ascii.sql
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

  -- PLT8: a contact blocked across the platform gets the same answer as a per-client flood, so an
  -- abuser learns nothing. Staff adds are exempt (design 3.5: staff joins carry a block-list override).
  if p_source <> 'staff' and private.is_blocked(q.org_id, v_phone, v_email) then
    raise exception 'rate_limited' using detail = 'client';
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
  'staff adds also create or link the org''s guest_contacts row and guest.';

------------------------------------------------------------------------------------------------
-- Operator RPCs
------------------------------------------------------------------------------------------------

create function api.platform_block_contact(p_value text, p_kind text, p_reason text, p_expires_at timestamptz)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_kind app.contact_channel;
  v_hash bytea;
  v_reason text := lower(coalesce(p_reason, ''));
  v_digits text;
  v_local text;
begin
  perform private.require_platform('operator');
  if p_kind is null or p_kind not in ('phone', 'email') or p_reason is null or length(trim(p_reason)) = 0
     or p_expires_at <= now() then
    raise exception 'invalid_input';
  end if;
  v_kind := p_kind::app.contact_channel;
  v_hash := private.contact_block_hash(v_kind, p_value);
  if v_hash is null then
    raise exception 'invalid_input';
  end if;

  -- The reason is stored and audited in plaintext, so it must not carry the contact. A phone is
  -- caught by its last 7 digits in any format; an email by an address or its local part.
  if v_kind = 'phone' then
    v_digits := right(regexp_replace(p_value, '[^0-9]', '', 'g'), 7);
    if position(v_digits in regexp_replace(v_reason, '[^0-9]', '', 'g')) > 0 then
      raise exception 'invalid_input' using detail = 'reason_contains_contact';
    end if;
  else
    v_local := split_part(split_part(lower(btrim(p_value)), '@', 1), '+', 1);
    if position('@' in v_reason) > 0
       or (length(v_local) >= 4 and position(v_local in v_reason) > 0) then
      raise exception 'invalid_input' using detail = 'reason_contains_contact';
    end if;
  end if;

  insert into app.platform_blocks (contact_hash, kind, reason, created_by, expires_at)
  values (v_hash, v_kind, p_reason, (select auth.uid()), p_expires_at)
  on conflict (contact_hash) do update
    set reason = excluded.reason, created_by = excluded.created_by, expires_at = excluded.expires_at;

  -- The audit names the block by a hash prefix, never the contact.
  perform private.platform_audit('contact_block.add', null,
    jsonb_build_object('kind', v_kind, 'hash_prefix', left(encode(v_hash, 'hex'), 12),
                       'expires_at', p_expires_at),
    p_reason);
end $$;
comment on function api.platform_block_contact(text, text, text, timestamptz) is
  'Operator only (aal2). Blocks a phone (E.164) or email from joining any org''s queue, until '
  'p_expires_at or forever when null. Repeating it updates the reason and expiry. Stores only an '
  'HMAC of the canonical contact (see private.contact_block_hash); the audit row holds a hash '
  'prefix. Raises permission_denied (42501) or invalid_input (bad kind or value, blank reason, '
  'expiry in the past, or a reason that contains the contact, DETAIL reason_contains_contact).';

create function api.platform_unblock_contact(p_value text, p_kind text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash bytea;
  removed int;
begin
  perform private.require_platform('operator');
  if p_kind is null or p_kind not in ('phone', 'email') then
    raise exception 'invalid_input';
  end if;
  v_hash := private.contact_block_hash(p_kind::app.contact_channel, p_value);
  if v_hash is null then
    raise exception 'invalid_input';
  end if;
  delete from app.platform_blocks where contact_hash = v_hash;
  get diagnostics removed = row_count;
  if removed > 0 then
    perform private.platform_audit('contact_block.remove', null,
      jsonb_build_object('kind', p_kind, 'hash_prefix', left(encode(v_hash, 'hex'), 12)), null);
  end if;
end $$;
comment on function api.platform_unblock_contact(text, text) is
  'Operator only (aal2). Removes the block on a phone or email; a no-op when there is none. '
  'Audited when a block was removed. Raises permission_denied (42501) or invalid_input.';

revoke all on function api.platform_block_contact(text, text, text, timestamptz) from public, anon;
revoke all on function api.platform_unblock_contact(text, text) from public, anon;
grant execute on function api.platform_block_contact(text, text, text, timestamptz) to authenticated;
grant execute on function api.platform_unblock_contact(text, text) to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

revoke insert, update, delete, truncate on app.platform_blocks from authenticated, service_role;

alter table app.platform_blocks enable row level security;

create policy platform_blocks_select on app.platform_blocks for select to authenticated
  using ((select private.is_platform('support')));
