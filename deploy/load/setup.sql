-- K1 realtime spike fixture (#28). Applied by run.sh to a LOCAL database only, never a migration.
-- It mimics the production shape in technical-design.md 3.4: an AFTER INSERT trigger on an event
-- table calls realtime.send twice (private loc:{location_id}, public qpulse:{pulse_id}), and guests
-- refetch their own status through a definer RPC keyed by sha256(token).
-- Remove with teardown.sql or `pnpm db:reset`.

set client_min_messages = warning;
-- run.sh pipes teardown.sql in first, so re-running is safe.
create schema loadtest;

create table loadtest.queues (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null default gen_random_uuid(),
  pulse_id uuid not null unique default gen_random_uuid(),
  version bigint not null default 0,
  now_serving int not null default 0
);

create table loadtest.visits (
  id bigint generated always as identity primary key,
  queue_id uuid not null references loadtest.queues (id),
  ticket_number int not null,
  sort_key bigint not null,
  status text not null default 'waiting',
  guest_token_hash bytea not null unique
);
create index on loadtest.visits (queue_id, status, sort_key);

create table loadtest.visit_events (
  id bigint generated always as identity primary key,
  queue_id uuid not null references loadtest.queues (id),
  version bigint not null,
  now_serving int not null,
  occurred_at timestamptz not null default clock_timestamp()
);

create function loadtest.on_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  q loadtest.queues;
begin
  select * into q from loadtest.queues where id = new.queue_id;
  -- Staff/device topic. Production authorizes it with RLS on realtime.messages.
  perform realtime.send(
    jsonb_build_object('version', new.version, 'event_id', new.id),
    'visit_event', 'loc:' || q.location_id, true);
  -- Public pulse: only {version, now_serving}. sent_at exists for latency measurement only.
  perform realtime.send(
    jsonb_build_object('version', new.version, 'now_serving', new.now_serving,
                       'sent_at', extract(epoch from new.occurred_at) * 1000),
    'pulse', 'qpulse:' || q.pulse_id, false);
  return null;
end $$;

create trigger visit_events_realtime after insert on loadtest.visit_events
  for each row execute function loadtest.on_event();

-- Seeds one queue with p_guests waiting visits; guest i uses token 'lt-<i>'. Returns pulse_id.
create function loadtest.seed(p_guests int) returns uuid
language plpgsql set search_path = '' as $$
declare
  q loadtest.queues;
begin
  truncate loadtest.visit_events, loadtest.visits, loadtest.queues;
  insert into loadtest.queues default values returning * into q;
  -- 1000 walk-ins ahead of the guests give staff someone to call without moving guests' status.
  insert into loadtest.visits (queue_id, ticket_number, sort_key, guest_token_hash)
  select q.id, 100000 + j, j, sha256(convert_to('walkin-' || j, 'utf8'))
  from generate_series(1, 1000) j;
  insert into loadtest.visits (queue_id, ticket_number, sort_key, guest_token_hash)
  select q.id, i, 1000 + i, sha256(convert_to('lt-' || i, 'utf8'))
  from generate_series(1, p_guests) i;
  return q.pulse_id;
end $$;

-- Stand-in for api.call_next: serve the head of the line, bump the version, write the event.
create function api.loadtest_call_next(p_pulse_id uuid) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  q loadtest.queues;
  v_id bigint;
begin
  select * into q from loadtest.queues where pulse_id = p_pulse_id for update;
  select id into v_id from loadtest.visits
    where queue_id = q.id and status = 'waiting'
      and ticket_number > 100000 -- only walk-ins; load-test guests stay waiting
    order by sort_key limit 1 for update skip locked;
  update loadtest.visits set status = 'served' where id = v_id;
  update loadtest.queues set version = version + 1, now_serving = now_serving + 1
    where id = q.id returning * into q;
  insert into loadtest.visit_events (queue_id, version, now_serving)
    values (q.id, q.version, q.now_serving);
  return q.version;
end $$;

-- Stand-in for api.get_visit_status: token hash lookup plus a position count, the expensive part.
create function api.loadtest_visit_status(p_token text)
returns table (ticket_number int, status text, "position" bigint, version bigint, as_of timestamptz)
language sql stable security definer set search_path = '' as $$
  select v.ticket_number, v.status,
         (select count(*) from loadtest.visits w
           where w.queue_id = v.queue_id and w.status = 'waiting' and w.sort_key < v.sort_key),
         q.version, clock_timestamp()
  from loadtest.visits v join loadtest.queues q on q.id = v.queue_id
  where v.guest_token_hash = sha256(convert_to(p_token, 'utf8'));
$$;

revoke all on function api.loadtest_call_next(uuid) from public, anon, authenticated;
grant execute on function api.loadtest_call_next(uuid) to service_role;
grant execute on function api.loadtest_visit_status(text) to anon;
