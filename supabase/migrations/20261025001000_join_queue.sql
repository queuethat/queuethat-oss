-- V1 (#30): the accepting predicate and the join body (technical-design.md 3.5, visit engine).
--
-- private.queue_not_accepting_reason is the one place that decides whether a queue takes joins
-- (Q-17: every entry point, including staff adds and the public page, asks it). private.join_core
-- is the deep module behind api.join_queue and, from V4, api.staff_add_visit: validation, the
-- predicate, idempotency, the rate cap, ticket numbering, ordering, contacts and the token.

------------------------------------------------------------------------------------------------
-- Guest link tokens
------------------------------------------------------------------------------------------------

create function private.token_hash(p_token text) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.digest(p_token, 'sha256')
$$;
comment on function private.token_hash(text) is
  'sha256 of a guest link token as stored in visits.guest_token_hash. Every function that '
  'resolves a token (get_visit_status, guest_act, guest_register_push) looks it up through this.';

------------------------------------------------------------------------------------------------
-- The accepting predicate
------------------------------------------------------------------------------------------------

create function private.within_hours(p_location_id uuid, p_at timestamptz default now())
returns boolean
language sql stable set search_path = '' as $$
  with here as (
    select (p_at at time zone l.tz) as local,
           exists (select 1 from app.business_hours b where b.location_id = l.id) as has_weekly
    from app.locations l
    where l.id = p_location_id
  ),
  -- Today and yesterday (local dates): yesterday's overnight period can still be running.
  days as (
    select h.local::date - k as day, k as days_back, h.local::time as t, h.has_weekly
    from here h, generate_series(0, 1) k
  ),
  periods as (
    -- A date exception replaces that date's weekly hours; closed exceptions contribute nothing.
    select d.days_back, d.t, e.opens, e.closes
    from days d
    join app.hours_exceptions e on e.location_id = p_location_id and e.date = d.day and not e.closed
    union all
    select d.days_back, d.t, b.opens, b.closes
    from days d
    join app.business_hours b on b.location_id = p_location_id and b.weekday = extract(dow from d.day)
    where not exists (select 1 from app.hours_exceptions e
                      where e.location_id = p_location_id and e.date = d.day)
    union all
    -- No weekly hours configured: open all day unless an exception says otherwise.
    select d.days_back, d.t, time '00:00', time '24:00'
    from days d
    where not d.has_weekly
      and not exists (select 1 from app.hours_exceptions e
                      where e.location_id = p_location_id and e.date = d.day)
  )
  select exists (
    select 1 from periods p
    where (p.days_back = 0 and p.t >= p.opens and (p.t < p.closes or p.closes < p.opens))
       or (p.days_back = 1 and p.closes < p.opens and p.t < p.closes)
  )
$$;
comment on function private.within_hours(uuid, timestamptz) is
  'True when p_at falls inside the location''s opening hours in its own timezone. A location '
  'with no weekly hours is open all day. A hours_exceptions row for a local date replaces that '
  'date''s weekly hours (closed = shut all day). closes < opens runs past midnight into the next '
  'date. False for an unknown location.';

create function private.queue_not_accepting_reason(p_queue_id uuid, p_at timestamptz default now())
returns text
language sql stable set search_path = '' as $$
  select case
    when q.archived_at is not null or q.manual_state = 'closed' then 'closed'
    when q.manual_state = 'paused' then 'paused'
    when not private.within_hours(q.location_id, p_at) then 'outside_hours'
    when q.capacity is not null
         and (select count(*) from app.visits v where v.queue_id = q.id and v.status = 'waiting')
             >= q.capacity then 'full'
  end
  from app.queues q
  where q.id = p_queue_id
$$;
comment on function private.queue_not_accepting_reason(uuid, timestamptz) is
  'Why the queue takes no joins at p_at: ''closed'' (closed or archived), ''paused'', '
  '''outside_hours'' or ''full'' (waiting count at capacity), checked in that order; null when '
  'it accepts, or when the queue does not exist. The only accepting rule; public_queue and '
  'queue_row report it as not_accepting_reason.';

create function private.queue_is_accepting(p_queue_id uuid, p_at timestamptz default now())
returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from app.queues q where q.id = p_queue_id)
     and private.queue_not_accepting_reason(p_queue_id, p_at) is null
$$;
comment on function private.queue_is_accepting(uuid, timestamptz) is
  'True when the queue exists and private.queue_not_accepting_reason is null.';

------------------------------------------------------------------------------------------------
-- Contacts
------------------------------------------------------------------------------------------------

/**
 * The contact row for (org, channel, value), created on first use. A new contact belongs to
 * p_guest_id, or to a new guest named p_first_name when that is null. An existing contact keeps
 * its guest: a join never moves a contact between guests.
 *
 * An existing contact is returned only when p_link_existing; otherwise both outputs are null and
 * nothing is stored. Typing a number proves nothing about owning it, so an unauthenticated join
 * must not attach itself to someone else's guest history or inherit the consents recorded on
 * their contact (the dispatcher sends to any contact with consent). Staff adds may link: staff
 * see the guest in person. Guests link once a join can verify the number (OTP, phase 3).
 */
create function private.ensure_contact(
  p_org_id uuid,
  p_channel app.contact_channel,
  p_value text,
  p_guest_id uuid,
  p_first_name text,
  p_source text,
  p_link_existing boolean,
  out contact_id uuid,
  out guest_id uuid
)
language plpgsql volatile set search_path = '' as $$
begin
  select c.id, c.guest_id into contact_id, guest_id
  from app.guest_contacts c
  where c.org_id = p_org_id and c.channel = p_channel and c.value = p_value;
  if found then
    if not p_link_existing then
      contact_id := null;
      guest_id := null;
    end if;
    return;
  end if;

  begin
    guest_id := p_guest_id;
    if guest_id is null then
      insert into app.guests (org_id, first_name) values (p_org_id, p_first_name)
      returning id into guest_id;
    end if;
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (p_org_id, guest_id, p_channel, p_value, p_source)
    returning id into contact_id;
  exception when unique_violation then
    -- A concurrent join created it first; the subtransaction dropped our guest row.
    contact_id := null;
    guest_id := null;
    if p_link_existing then
      select c.id, c.guest_id into contact_id, guest_id
      from app.guest_contacts c
      where c.org_id = p_org_id and c.channel = p_channel and c.value = p_value;
    end if;
  end;
end $$;

------------------------------------------------------------------------------------------------
-- The join body
------------------------------------------------------------------------------------------------

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

  -- FOR SHARE keeps manual_state fixed until commit: set_queue_state waits for in-flight joins.
  select * into q from app.queues where id = p_queue_id and archived_at is null for share;
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

  -- Joins to one queue run one at a time from here, so the capacity and rate counts below see
  -- every committed join and a repeated key always finds the first visit.
  perform pg_advisory_xact_lock(hashtextextended('join_queue:' || q.id::text, 0));

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
  elsif v_reason is not null then
    raise exception 'queue_not_accepting' using detail = v_reason;
  end if;

  -- Staff adds are not a flood risk and are not counted or capped.
  if p_source <> 'staff' and (
    select count(*) from app.visits v
    where v.queue_id = q.id and v.source <> 'staff' and v.joined_at > now() - interval '1 minute'
  ) >= q.join_rate_per_min then
    raise exception 'rate_limited';
  end if;

  if v_phone is not null then
    select c.contact_id, c.guest_id into v_contact, v_guest
    from private.ensure_contact(q.org_id, 'phone', v_phone, null, v_name, p_source,
                                p_source = 'staff') c;
  end if;
  if v_email is not null then
    select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
    from private.ensure_contact(q.org_id, 'email', v_email, v_guest, v_name, p_source,
                                p_source = 'staff') c;
    v_contact := coalesce(v_contact, v_email_contact);
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
                          guest_id, contact_id, locale, guest_token_hash, source, idempotency_key)
  values (q.org_id, q.location_id, q.id, p_service_id, v_day, q.ticket_prefix,
          v_number, q.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          'waiting', v_sort, v_party, v_name,
          v_guest, v_contact, v_locale, private.token_hash(token), p_source, p_idempotency_key)
  returning id into visit_id;
end $$;
comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid) is
  'Adds a waiting visit for every join entry point and returns its id and plaintext token (stored '
  'only as private.token_hash). Repeating (queue, key) returns the first visit with a null token, '
  'even after the queue stopped accepting. Order of checks: input (invalid_input), queue and '
  'service (not_found; a kiosk outside the queue''s location also gets not_found), the accepting '
  'predicate (capacity_reached when full, queue_not_accepting with the reason as DETAIL), then the '
  'per-queue rate cap over the last minute for non-staff sources (rate_limited). A new phone or '
  'email creates a guest and contact. One the org already has is linked only for staff adds; any '
  'other source stores no contact for it, so a typed number never reaches another guest''s '
  'history or consents.';

revoke all on function private.token_hash(text) from public, anon, authenticated;
revoke all on function private.within_hours(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.queue_not_accepting_reason(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.queue_is_accepting(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.ensure_contact(uuid, app.contact_channel, text, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.join_queue (signature and grants from S5, 20261025000600_api_contracts.sql)
------------------------------------------------------------------------------------------------

create or replace function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid
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
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;
comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key): repeating a call returns '
  'the same visit, with a fresh token only on the first call and null afterwards, even once the '
  'queue has stopped accepting. Client values for priority, status, org or ticket are never '
  'accepted. Blank name, phone, email or locale count as not given; party size defaults to 1. '
  'Raises queue_not_accepting (paused, closed or outside hours; the reason is the DETAIL), '
  'capacity_reached, rate_limited, not_found (unknown queue or service, or a kiosk of another '
  'location), invalid_input (bad name, phone, email, party size, locale, or no key). Later phases '
  'append parameters with defaults; never add join_* variants. Implemented in V1 (#30).';
