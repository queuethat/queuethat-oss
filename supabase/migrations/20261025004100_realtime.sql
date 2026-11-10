-- V9 (#38): realtime signals from the visit engine (technical-design.md 3.4, I-5).
--
-- Every committed visit or queue change sends, once per queue per transaction:
--   * qpulse:{pulse_id}, event 'pulse', payload {version, now_serving}: guests refetch their own
--     status. pulse_id is random and is not the queue id.
--   * loc:{location_id}, event 'signal', payload {queue_id, visit_id, version}: staff and devices
--     refetch. visit_id is null when the change touched more than one visit or none.
-- version is app.queues.version as of commit, so it is final and ordered per queue: a client may
-- drop a message whose version is older than the one it holds.
--
-- Both topics are private channels: Realtime lets any subscriber of a public channel broadcast
-- to it, which would let anyone forge pulses. Receiving is authorized by the SELECT policies on
-- realtime.messages below; there is no INSERT policy, so no client can send on either topic.
--
-- Sends run at commit so the version is final and a rolled-back transaction sends nothing. Row
-- triggers on visit_events and queues write the change to private.realtime_changes; a deferred
-- constraint trigger on that table (not on visit_events or queues, so their DDL never meets
-- pending trigger events) sends once per queue at commit and deletes the transaction's rows.

create table private.realtime_changes (
  txid xid8 not null default pg_current_xact_id(),
  queue_id uuid not null,
  visit_id uuid
);
create index realtime_changes_txid_idx on private.realtime_changes (txid);

create function private.note_visit_event_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.realtime_changes (queue_id, visit_id)
  select v.queue_id, new.visit_id from app.visits v where v.id = new.visit_id;
  return null;
end $$;

create function private.note_queue_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.realtime_changes (queue_id) values (new.id);
  return null;
end $$;

create trigger note_realtime_change after insert on app.visit_events
  for each row execute function private.note_visit_event_change();
create trigger note_realtime_change after update of version on app.queues
  for each row when (new.version is distinct from old.version)
  execute function private.note_queue_change();

/** The display ticket most recently called on the queue today, or null. */
create function private.now_serving(p_queue app.queues) returns text
language sql stable set search_path = '' as $$
  select v.display_ticket
  from app.visits v
  where v.queue_id = p_queue.id
    and v.status in ('called', 'serving')
    and v.service_day = private.service_day(p_queue.location_id)
  order by v.called_at desc nulls last, v.id
  limit 1
$$;

create function private.flush_realtime_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
begin
  -- The first firing in a transaction sends everything; later firings find nothing left.
  for c in
    with done as (
      delete from private.realtime_changes where txid = pg_current_xact_id()
      returning queue_id, visit_id
    ), per_queue as (
      select queue_id, case when count(distinct visit_id) = 1 then min(visit_id::text)::uuid end
             as visit_id
      from done group by queue_id
    )
    select q, p.visit_id from per_queue p join app.queues q on q.id = p.queue_id order by q.id
  loop
    perform realtime.send(
      jsonb_build_object('version', (c.q).version, 'now_serving', private.now_serving(c.q)),
      'pulse', 'qpulse:' || (c.q).pulse_id, true);
    perform realtime.send(
      jsonb_build_object('queue_id', (c.q).id, 'visit_id', c.visit_id, 'version', (c.q).version),
      'signal', 'loc:' || (c.q).location_id, true);
  end loop;
  return null;
end $$;
comment on function private.flush_realtime_changes() is
  'Sends the pulse and location signal for every queue changed in this transaction, once each, '
  'and deletes the transaction''s change rows. visit_id is set only when exactly one visit of '
  'that queue changed. Runs as a deferred trigger, so only committed changes are signalled.';

create constraint trigger flush_realtime_changes after insert on private.realtime_changes
  deferrable initially deferred
  for each row execute function private.flush_realtime_changes();

------------------------------------------------------------------------------------------------
-- Who may receive
------------------------------------------------------------------------------------------------

/** True when the caller is staff of, or a device at, the location named by a loc: topic. */
create function private.can_follow_location(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
begin
  if p_topic !~ '^loc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select * into l from app.locations where id = substr(p_topic, 5)::uuid;
  return found and (private.has_role(l.org_id, l.id, 'staff') or private.is_device(l.org_id, l.id));
end $$;
comment on function private.can_follow_location(text) is
  'Realtime authorization for loc:{location_id}: members with staff role or higher at that '
  'location, and its unrevoked devices. False for any other topic shape or unknown location.';

-- Pulses carry nothing personal and the topic is unguessable, so anyone holding it may listen.
create policy follow_queue_pulse on realtime.messages for select to anon, authenticated
  using (extension = 'broadcast' and (select realtime.topic()) like 'qpulse:%');
create policy follow_location on realtime.messages for select to authenticated
  using (extension = 'broadcast' and (select private.can_follow_location(realtime.topic())));

revoke all on table private.realtime_changes from public, anon, authenticated;
revoke all on function private.note_visit_event_change() from public, anon, authenticated;
revoke all on function private.note_queue_change() from public, anon, authenticated;
revoke all on function private.now_serving(app.queues) from public, anon, authenticated;
revoke all on function private.flush_realtime_changes() from public, anon, authenticated;
revoke all on function private.can_follow_location(text) from public, anon;
grant execute on function private.can_follow_location(text) to authenticated;
