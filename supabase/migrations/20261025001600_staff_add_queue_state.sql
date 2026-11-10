-- V4 (#33): staff add a walk-in, and staff open, pause or close a queue (technical-design.md 3.5).
--
-- api.staff_add_visit is a thin wrapper over private.join_core (V1): every join rule, including
-- the accepting predicate and contact linking, stays there. api.set_queue_state is the only
-- writer of queues.manual_state; the queues audit trigger records the change and the version
-- bump signals everyone following the queue.

------------------------------------------------------------------------------------------------
-- The staff queue row
------------------------------------------------------------------------------------------------

create function private.queue_row(p_queue_id uuid) returns api.queue_row
language sql stable set search_path = '' as $$
  select q.id, q.location_id, q.name, q.ticket_prefix, q.manual_state, r.reason is null, r.reason,
         q.servers_on_duty, q.capacity,
         (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
         q.version
  from app.queues q
  cross join lateral (select private.queue_not_accepting_reason(q.id) as reason) r
  where q.id = p_queue_id
$$;
comment on function private.queue_row(uuid) is
  'The api.queue_row staff functions return: accepting and not_accepting_reason straight from '
  'private.queue_not_accepting_reason, waiting_count counted the way its capacity rule counts.';

revoke all on function private.queue_row(uuid) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.staff_add_visit (signature and grants from S5, 20261025000600_api_contracts.sql)
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

  -- Take the lock bump_queue_version needs before join_core takes FOR SHARE. Upgrading later
  -- deadlocks: a concurrent join holds SHARE while it waits for join_core's advisory lock.
  perform 1 from app.queues where id = q.id for no key update;

  select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
    null, p_party_size, null, p_idempotency_key, 'staff', 'staff', (select auth.uid()));
  -- join_core returns a token only when it created the visit; a repeated key changes nothing.
  -- The token itself is dropped: staff show the guest a QR by issuing a new one.
  if joined.token is not null then
    perform private.bump_queue_version(q.id);
  end if;

  return private.visit_row(joined.visit_id);
end $$;
comment on function api.staff_add_visit(uuid, uuid, text, text, int, uuid) is
  'Adds a walk-in on the guest''s behalf (source staff, actor the calling member) and returns its '
  'row. Same rules as join_queue through the same private.join_core, including the accepting '
  'predicate (Q-17 applies to every entry point), except that staff adds are not rate-capped and '
  'a phone the org already knows links that guest''s contact. Idempotent per (queue, key): a '
  'repeat returns the visit''s current row, even once the queue has stopped accepting. Raises '
  'queue_not_accepting (reason as DETAIL), capacity_reached, not_found (also for a queue the '
  'caller is not staff of), invalid_input. Implemented in V4 (#33).';

------------------------------------------------------------------------------------------------
-- api.set_queue_state (signature and grants from S5)
------------------------------------------------------------------------------------------------

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
  'changes nothing. Raises not_found for a queue outside the caller''s locations, invalid_input '
  'for a null state. Implemented in V4 (#33).';
