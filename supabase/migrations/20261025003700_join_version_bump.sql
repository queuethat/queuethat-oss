-- Online and kiosk joins bump queues.version (follow-up to V4, #432), so displays and staff
-- screens following the queue see every join, not only staff adds.
--
-- The bump moves into private.join_core, the one join body, so no entry point can forget it.
-- join_core now takes the queue row FOR NO KEY UPDATE as its first lock. That lock serializes
-- joins per queue, which the advisory lock did before, and is the lock bump_queue_version needs,
-- so there is no FOR SHARE to upgrade and nothing to deadlock on. api.staff_add_visit drops the
-- lock and bump it took itself; api.join_queue is unchanged.

------------------------------------------------------------------------------------------------
-- private.join_core (latest body: 20261025002300_org_status_enforcement.sql)
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
  perform private.bump_queue_version(q.id);
end $$;
comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid) is
  'Adds a waiting visit for every join entry point, bumps the queue version, and returns its id '
  'and plaintext token (stored only as private.token_hash). Repeating (queue, key) returns the '
  'first visit with a null token and changes nothing, even after the queue stopped accepting. '
  'Concurrent joins to one queue are serialized and never deadlock. Order of checks: input (invalid_input), queue and '
  'service (not_found; a kiosk outside the queue''s location, or of a non-active org, also gets '
  'not_found), the accepting predicate (org_suspended when the org is not active, '
  'capacity_reached when full, queue_not_accepting with the reason as DETAIL), then the '
  'per-queue rate cap over the last minute for non-staff sources (rate_limited). A new phone or '
  'email creates a guest and contact. One the org already has is linked only for staff adds; any '
  'other source stores no contact for it, so a typed number never reaches another guest''s '
  'history or consents.';

------------------------------------------------------------------------------------------------
-- api.staff_add_visit (V4, 20261025001600_staff_add_queue_state.sql)
------------------------------------------------------------------------------------------------

create or replace function api.staff_add_visit(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_party_size int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  joined record;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;

  select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
    null, p_party_size, null, p_idempotency_key, 'staff', 'staff', (select auth.uid()));
  -- join_core bumps the queue version. The token is dropped: staff show the guest a QR by
  -- issuing a new one.

  return private.visit_row(joined.visit_id);
end $$;
