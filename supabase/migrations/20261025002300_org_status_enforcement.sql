-- PLT2 (#408): a non-active org (suspended or pending_deletion) is enforced where every caller
-- already passes, not in each policy or RPC (technical-design.md 3.6, rule 5).
--
--   * private.has_role: in a non-active org only staff-level checks (p_min_role = 'staff') pass,
--     which is what read policies and the staff RPCs ask for, so members still see their org and
--     why it is unavailable. Every manager-level or higher check fails, so config writes stop.
--   * private.is_device: false for a non-active org, so displays and kiosks stop.
--   * private.queue_not_accepting_reason: 'org_suspended' comes first, so get_location_public
--     shows the queue as not accepting with that reason and join_core raises org_suspended.
--   * private.guard_visit: staff visit RPCs (call_next, transition, undo) check
--     has_role(..., 'staff'), which still passes, so the visit guard rejects staff and device
--     writes in a non-active org with org_suspended (42501). Guest leave and system rollover still apply: a
--     suspension never silently drops a guest who is already waiting.
--
-- Status itself changes only through platform RPCs (PLT4). Setting it back to 'active' restores
-- everything; nothing here stores state of its own.

create or replace function private.has_role(p_org_id uuid, p_location_id uuid, p_min_role app.member_role)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.memberships m
    join app.organizations o on o.id = m.org_id
    where m.user_id = (select auth.uid())
      and m.org_id = p_org_id
      and m.role >= p_min_role
      and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
      and (o.status = 'active' or p_min_role = 'staff')
  )
$$;
comment on function private.has_role(uuid, uuid, app.member_role) is
  'True when the caller is a member of the org with at least p_min_role. With a location, the '
  'membership must cover it (location_ids null = all). With p_location_id null, any membership '
  'in the org counts. When the org is not active (suspended or pending_deletion), only '
  'staff-level checks pass (reads, and staff RPCs whose visit writes private.guard_visit then '
  'rejects); every manager-level or higher check fails. The only role check policies and api '
  'functions use.';

create or replace function private.is_device(p_org_id uuid, p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.devices d
    join app.organizations o on o.id = d.org_id
    where d.auth_user_id = (select auth.uid())
      and d.revoked_at is null
      and d.org_id = p_org_id
      and (p_location_id is null or d.location_id = p_location_id)
      and o.status = 'active'
  )
$$;
comment on function private.is_device(uuid, uuid) is
  'True when the caller is a paired, unrevoked display or kiosk of that org (and location, if '
  'given) and the org is active. Reads app.devices rather than JWT claims so revocation and '
  'suspension apply on the next request.';

create or replace function private.queue_not_accepting_reason(p_queue_id uuid, p_at timestamptz default now())
returns text
language sql stable set search_path = '' as $$
  select case
    when o.status <> 'active' then 'org_suspended'
    when q.archived_at is not null or q.manual_state = 'closed' then 'closed'
    when q.manual_state = 'paused' then 'paused'
    when not private.within_hours(q.location_id, p_at) then 'outside_hours'
    when q.capacity is not null
         and (select count(*) from app.visits v where v.queue_id = q.id and v.status = 'waiting')
             >= q.capacity then 'full'
  end
  from app.queues q
  join app.organizations o on o.id = q.org_id
  where q.id = p_queue_id
$$;
comment on function private.queue_not_accepting_reason(uuid, timestamptz) is
  'Why the queue takes no joins at p_at: ''org_suspended'' (the org is not active), ''closed'' '
  '(closed or archived), ''paused'', ''outside_hours'' or ''full'' (waiting count at capacity), '
  'checked in that order; null when it accepts, or when the queue does not exist. The only '
  'accepting rule; public_queue and queue_row report it as not_accepting_reason.';

-- join_core: the body is unchanged except that org_suspended is raised as its own code.
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
  elsif v_reason = 'org_suspended' then
    raise exception 'org_suspended';
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
  'service (not_found; a kiosk outside the queue''s location, or of a non-active org, also gets '
  'not_found), the accepting predicate (org_suspended when the org is not active, '
  'capacity_reached when full, queue_not_accepting with the reason as DETAIL), then the '
  'per-queue rate cap over the last minute for non-staff sources (rate_limited). A new phone or '
  'email creates a guest and contact. One the org already has is linked only for staff adds; any '
  'other source stores no contact for it, so a typed number never reaches another guest''s '
  'history or consents.';

-- guard_visit: unchanged except for the org status check after the actor check.
create or replace function private.guard_visit() returns trigger
language plpgsql set search_path = '' as $$
declare
  act text := private.current_action();
  target api.visit_state;
begin
  if nullif(current_setting('app.actor_kind', true), '') is null then
    raise exception 'missing_actor_context'
      using hint = 'Visits change only through api.* functions, which call private.set_actor().';
  end if;

  -- Staff and devices cannot change visits of a non-active org; guests and the system can.
  if current_setting('app.actor_kind') in ('staff', 'device')
     and exists (select 1 from app.organizations o where o.id = new.org_id and o.status <> 'active') then
    raise exception 'org_suspended' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('waiting', 'expected') then
      raise exception 'illegal_transition' using detail = format('a visit cannot start as %s', new.status);
    end if;
    new.version := 0;
    return new;
  end if;

  if new.org_id is distinct from old.org_id or new.id is distinct from old.id
     or new.guest_token_hash is distinct from old.guest_token_hash then
    raise exception 'immutable_column' using errcode = '42501';
  end if;

  -- Undo is validated by api.undo_event (V3), which restores the previous status.
  if act = 'undo' then
    new.version := old.version + 1;
    return new;
  end if;

  if act is not null and act <> 'transfer' then
    select t.to_status into target
    from app.visit_transitions t
    where t.from_status = old.status and t.action::text = act;
    if target is null or target <> new.status then
      raise exception 'illegal_transition'
        using detail = format('%s -> %s via %s', old.status, new.status, act);
    end if;
  elsif new.status is distinct from old.status then
    raise exception 'illegal_transition'
      using detail = format('%s -> %s without an action', old.status, new.status);
  end if;

  new.version := old.version + 1;
  return new;
end $$;

-- set_queue_state writes app.queues, which guard_visit does not cover, and passes has_role at
-- staff level. Unchanged except for the org status check.
create or replace function api.set_queue_state(p_queue_id uuid, p_state api.queue_state)
returns api.queue_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if exists (select 1 from app.organizations o where o.id = q.org_id and o.status <> 'active') then
    raise exception 'org_suspended' using errcode = '42501';
  end if;
  if p_state is null then
    raise exception 'invalid_input';
  end if;

  -- Waits for in-flight joins (they hold the queue FOR SHARE), so none lands after the change.
  update app.queues set manual_state = p_state
  where id = q.id and manual_state <> p_state;
  if found then
    perform private.bump_queue_version(q.id);
  end if;

  return private.queue_row(q.id);
end $$;
comment on function api.set_queue_state(uuid, api.queue_state) is
  'Opens, pauses or closes a queue for every entry point at once and returns it; staff or above '
  'of the queue''s location. Pausing and closing both stop new joins and keep waiting guests in '
  'line. A change is audited and bumps the queue version; setting the current state again '
  'changes nothing. Raises not_found for a queue outside the caller''s locations, org_suspended '
  '(42501) when the org is not active, invalid_input for a null state. Implemented in V4 (#33).';
