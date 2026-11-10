-- V6 (#35): the guest's own API (technical-design.md 3.5, 5).
--
-- Guests have no table access; get_visit_status, guest_act and get_location_public are all they
-- read and change. private.visit_by_token is the one place that turns a link token into a visit,
-- so unknown and expired tokens cannot be told apart. Status never carries contact data.

------------------------------------------------------------------------------------------------
-- Token lookup and the guest's snapshot
------------------------------------------------------------------------------------------------

create function private.visit_by_token(p_token text, p_lock boolean default false)
returns app.visits
language plpgsql volatile set search_path = '' as $$
declare
  v app.visits;
  v_ended timestamptz;
begin
  if p_lock then
    select * into v from app.visits
    where guest_token_hash = private.token_hash(coalesce(p_token, '')) for update;
  else
    select * into v from app.visits
    where guest_token_hash = private.token_hash(coalesce(p_token, ''));
  end if;
  if not found then
    raise exception 'not_found';
  end if;

  if v.status in ('served', 'no_show', 'cancelled', 'removed', 'expired') then
    -- Visits that ended without finished_at (rollover's expire) end at their last event.
    v_ended := coalesce(v.finished_at,
                        (select max(e.occurred_at) from app.visit_events e where e.visit_id = v.id));
    if v_ended < now() - interval '12 hours' then
      raise exception 'not_found';
    end if;
  end if;
  return v;
end $$;
comment on function private.visit_by_token(text, boolean) is
  'The visit whose guest_token_hash matches p_token, locked FOR UPDATE when p_lock. Raises '
  'not_found for an unknown token and, identically, for a visit that ended (served, no_show, '
  'cancelled, removed, expired) more than 12 hours ago.';

create function private.visit_status(p_visit app.visits) returns api.visit_status
language sql stable set search_path = '' as $$
  select p_visit.display_ticket, p_visit.status, pos.n, pos.n - 1,
         e.eta_state, e.eta_low, e.eta_high,
         case when p_visit.status in ('called', 'serving') then c.label end,
         p_visit.call_count, p_visit.called_at, q.name, l.name, q.pulse_id,
         private.guest_actions(p_visit.status), p_visit.version, now()
  from app.queues q
  join app.locations l on l.id = q.location_id
  left join app.counters c on c.id = p_visit.counter_id
  cross join lateral (select private.visit_position(p_visit) as n) pos
  cross join lateral private.visit_eta(p_visit.id) e
  where q.id = p_visit.queue_id
$$;
comment on function private.visit_status(app.visits) is
  'The api.visit_status a guest sees for p_visit: no guest name, contact or other guests. The '
  'counter label only while called or serving; position and ETA only while waiting.';

revoke all on function private.visit_by_token(text, boolean) from public, anon, authenticated;
revoke all on function private.visit_status(app.visits) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.get_visit_status (signature and grants from S5, 20261025000600_api_contracts.sql)
------------------------------------------------------------------------------------------------

create or replace function api.get_visit_status(p_token text) returns api.visit_status
language plpgsql stable security definer set search_path = '' as $$
begin
  -- PostgREST serves any function over GET, which would put the bearer token in access logs and
  -- browser history (technical-design.md 5). POST only.
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  return private.visit_status(private.visit_by_token(p_token));
end $$;
comment on function api.get_visit_status(text) is
  'The guest''s own visit: ticket, status, position, ETA triple, counter when called, pulse '
  'topic, available guest actions and server as_of time. Never includes contact data or other '
  'guests. Unknown tokens and tokens expired 12 hours after the visit ended raise the same '
  'not_found; a GET request raises invalid_input (the token must not be in a URL). Implemented '
  'in V6 (#35).';

------------------------------------------------------------------------------------------------
-- api.guest_act (signature and grants from S5)
------------------------------------------------------------------------------------------------

create or replace function api.guest_act(p_token text, p_action api.guest_action, p_idempotency_key uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  if p_action is null then
    raise exception 'invalid_input';
  end if;
  v := private.visit_by_token(p_token, true);

  -- One branch per api.guest_action value. Each must be safe to repeat by itself: guests have no
  -- auth.uid(), so the staff idempotency table cannot hold their keys.
  case p_action
    when 'leave' then
      if v.status = 'cancelled' then
        return private.visit_status(v);
      end if;
      if not 'leave' = any (private.guest_actions(v.status)) then
        raise exception 'illegal_transition' using detail = format('leave from %s', v.status);
      end if;
      perform private.set_actor('guest', null, 'cancel');
      update app.visits set status = 'cancelled', finished_at = now()
      where id = v.id
      returning * into v;
  end case;

  perform private.bump_queue_version(v.queue_id);
  return private.visit_status(v);
end $$;
comment on function api.guest_act(text, api.guest_action, uuid) is
  'Applies a guest action to the token''s visit and returns the new status. leave moves waiting or '
  'called to cancelled (a guest-actor cancel event); leaving again returns cancelled without '
  'error or a new event. Every action is safe to repeat, so p_idempotency_key is accepted but not '
  'needed yet. Raises not_found as get_visit_status does, invalid_input without an action, '
  'illegal_transition when the action no longer applies (e.g. already served). New guest actions '
  'are new api.guest_action values. Implemented in V6 (#35).';

------------------------------------------------------------------------------------------------
-- api.get_location_public (signature and grants from S5)
------------------------------------------------------------------------------------------------

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
         '{}')
  into result
  from (select 1) one
  left join app.queues q on q.location_id = l.id and q.archived_at is null
  left join lateral (select private.queue_not_accepting_reason(q.id) as reason) r on true
  left join lateral private.queue_eta(q.id) e on true;
  return result;
end $$;
comment on function api.get_location_public(text) is
  'Public view of a location by its slug (or a redirected old slug; slug is always the current '
  'one): name, contact, and each non-archived queue with its accepting state and reason, waiting '
  'count, ETA for someone joining now, pulse topic and active services. Contains no guest data. '
  'Raises not_found for an unknown slug. Implemented in V6 (#35).';
