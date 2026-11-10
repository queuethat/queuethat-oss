-- N-12 (#256): staff read a visit's message history and retry a dead message. Expand only.
-- The outbox already is the delivery log; delivered_at is fed by provider status callbacks (none
-- of the free providers send them yet). Recipient addresses and rendered bodies are never returned.
alter table app.notifications add column delivered_at timestamptz;
-- recipient_hash is the only notifications column hidden from staff, so new columns are granted by name.
grant select (delivered_at) on app.notifications to authenticated;

create function private.notification_status_row(n app.notifications) returns api.notification_status
language sql stable set search_path = '' as $$
  select row(n.id, n.visit_id, n.channel::text, n.template_key, n.status::text, n.attempts, n.error_code,
             n.created_at, case when n.status = 'sent' then n.updated_at end, n.delivered_at)::api.notification_status
$$;
revoke all on function private.notification_status_row(app.notifications) from public, anon, authenticated;

-- redefines api.list_visit_notifications from 20261030162713_api_contracts_2b.sql
create or replace function api.list_visit_notifications(p_visit_id uuid) returns setof api.notification_status
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  return query
    select (private.notification_status_row(n)).* from app.notifications n
    where n.visit_id = v.id and n.org_id = v.org_id
    order by n.created_at, n.id;
end $$;
comment on function api.list_visit_notifications(uuid) is
  'Outbox delivery status of one visit, oldest first: channel, template, status, attempts, last '
  'error code (for a suppressed message the reason), sent and delivered times. Never the recipient '
  'address or the body. Staff of the visit''s location; raises not_found otherwise, also across '
  'tenants. Implemented in N6 (#256).';

-- redefines api.list_failed_notifications from 20261030162713_api_contracts_2b.sql
create or replace function api.list_failed_notifications(p_location_id uuid, p_since timestamptz)
returns setof api.notification_status
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
begin
  select * into l from app.locations where id = p_location_id;
  if not found or not private.has_role(l.org_id, l.id, 'staff') then
    raise exception 'not_found';
  end if;
  return query
    select (private.notification_status_row(n)).* from app.notifications n
    join app.visits v on v.id = n.visit_id and v.org_id = n.org_id
    where v.location_id = l.id and n.org_id = l.org_id
      and n.status in ('dead', 'failed', 'suppressed')
      and n.created_at >= coalesce(p_since, now() - interval '1 day')
    order by n.created_at desc, n.id
    limit 500;
end $$;
comment on function api.list_failed_notifications(uuid, timestamptz) is
  'Dead, failed and suppressed messages of a location created since p_since (default the last '
  'day), newest first, at most 500. Staff of the location; raises not_found otherwise. '
  'Implemented in N6 (#256).';

-- redefines api.retry_notification from 20261030162713_api_contracts_2b.sql
create or replace function api.retry_notification(p_notification_id uuid, p_idempotency_key uuid)
returns api.notification_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  l app.locations;
begin
  select * into n from app.notifications where id = p_notification_id for update;
  if found then
    select l2.* into l from app.visits v join app.locations l2 on l2.id = v.location_id where v.id = n.visit_id;
  end if;
  if not found or l.id is null or not private.has_role(n.org_id, l.id, 'manager') then
    raise exception 'not_found';
  end if;
  -- Only a dead message is requeued. Anything else is already moving or done, so asking again
  -- (a double tap, the same key) changes nothing.
  if n.status = 'dead' then
    if not api.outbox_still_relevant(n.id) then
      raise exception 'not_relevant';
    end if;
    update app.notifications
    set status = 'queued', attempts = 0, next_attempt_at = now(), locked_until = null, error_code = null
    where id = n.id returning * into n;
    perform private.kick_dispatcher();
  end if;
  return private.notification_status_row(n);
end $$;
comment on function api.retry_notification(uuid, uuid) is
  'Requeues a dead message with its attempts reset so the dispatcher sends it once more, if it is '
  'still relevant. A message that is not dead is returned unchanged, so repeating the call (any '
  'idempotency key) is a no-op. Managers of the visit''s location. Raises not_found (also across '
  'tenants and for account mail), not_relevant when the call was undone or the visit moved on. '
  'Implemented in N6 (#256).';
