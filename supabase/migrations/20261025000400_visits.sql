-- S3 (#24): the event spine. Visits, the append-only visit_events log, the state machine guard,
-- the generic audit log for config tables, and idempotency keys (technical-design.md 4, 4.1).
--
-- Invariants enforced here, for every caller including definer functions:
--   * A visit is never deleted, and never inserted or changed without a visit_events row.
--   * A status change must match a row in app.visit_transitions for the action being applied.
--   * Every change carries actor context (app.actor_kind / app.actor_id / app.action), set by the
--     api.* function doing the work through private.set_actor(); without it the write fails.

------------------------------------------------------------------------------------------------
-- Types
------------------------------------------------------------------------------------------------

-- Visit status. "Transferred", "snoozed" and "on my way" are events, not states.
create type api.visit_state as enum (
  'expected', 'waiting', 'called', 'serving', 'served', 'no_show', 'cancelled', 'removed', 'expired'
);

-- What staff, guests or the system do to a visit. Clients render buttons from the
-- allowed_actions the database returns; they never hold their own copy of the state machine.
create type api.visit_action as enum (
  'call', 'recall', 'start', 'requeue', 'complete', 'no_show', 'cancel', 'remove', 'reinstate',
  'expire', 'check_in'
);

create type app.actor_kind as enum ('staff', 'guest', 'device', 'system');

grant usage on type api.visit_state, api.visit_action to anon, authenticated, service_role;
grant usage on type app.actor_kind to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- State machine (global reference data, not tenant-scoped)
------------------------------------------------------------------------------------------------

create table app.visit_transitions (
  from_status api.visit_state not null,
  action api.visit_action not null,
  to_status api.visit_state not null,
  primary key (from_status, action)
);

insert into app.visit_transitions (from_status, action, to_status) values
  ('waiting',  'call',      'called'),
  ('called',   'recall',    'called'),
  ('called',   'start',     'serving'),
  ('called',   'requeue',   'waiting'),
  ('serving',  'complete',  'served'),
  ('waiting',  'no_show',   'no_show'),
  ('called',   'no_show',   'no_show'),
  ('waiting',  'cancel',    'cancelled'),
  ('called',   'cancel',    'cancelled'),
  ('waiting',  'remove',    'removed'),
  ('called',   'remove',    'removed'),
  ('no_show',  'reinstate', 'waiting'),
  ('expected', 'check_in',  'waiting'),
  ('expected', 'cancel',    'cancelled'),
  ('expected', 'no_show',   'no_show'),
  ('expected', 'expire',    'expired'),
  ('waiting',  'expire',    'expired'),
  ('called',   'expire',    'expired');

------------------------------------------------------------------------------------------------
-- Visits
------------------------------------------------------------------------------------------------

create table app.visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  queue_id uuid not null,
  service_id uuid,
  service_day date not null,
  ticket_prefix text not null,
  ticket_number int not null,
  display_ticket text not null,
  status api.visit_state not null,
  -- Position is computed from sort_key and never stored. Spaced on insert so reorder can take a midpoint.
  sort_key bigint not null,
  party_size int not null default 1 check (party_size between 1 and 50),
  guest_name text check (length(guest_name) <= 60),
  guest_id uuid,   -- foreign keys added with the guests tables (S4)
  contact_id uuid,
  locale text not null default 'en',
  -- sha256 of the 32-byte link token. The plaintext is returned once by join and never stored.
  guest_token_hash bytea not null unique,
  source text not null check (source in ('online', 'staff', 'kiosk', 'appointment')),
  counter_id uuid,
  assigned_staff_id uuid references auth.users (id) on delete set null,
  call_count int not null default 0,
  eta_quoted_low int,
  eta_quoted_high int,
  idempotency_key uuid not null,
  joined_at timestamptz not null default now(),
  called_at timestamptz,
  serving_at timestamptz,
  finished_at timestamptz,
  version int not null default 0,
  foreign key (org_id, location_id, queue_id) references app.queues (org_id, location_id, id),
  foreign key (org_id, queue_id, service_id) references app.services (org_id, queue_id, id),
  foreign key (org_id, location_id, counter_id) references app.counters (org_id, location_id, id),
  unique (queue_id, idempotency_key),
  unique (queue_id, service_day, ticket_prefix, ticket_number),
  unique (org_id, id)
);
create index visits_queue_active_idx on app.visits (queue_id, status, sort_key);
create index visits_location_day_idx on app.visits (location_id, service_day);

------------------------------------------------------------------------------------------------
-- Event log
------------------------------------------------------------------------------------------------

create table app.visit_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  visit_id uuid not null,
  -- 'joined', a visit_action name, 'undo', or 'updated' for non-status edits (reorder, counter...)
  type text not null,
  from_status api.visit_state,
  to_status api.visit_state not null,
  actor_kind app.actor_kind not null,
  actor_id uuid,
  reason text,
  payload jsonb not null default '{}',
  undone_by_event_id bigint references app.visit_events (id),
  occurred_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id)
);
create index visit_events_visit_idx on app.visit_events (visit_id, id);

------------------------------------------------------------------------------------------------
-- Actor context
------------------------------------------------------------------------------------------------

/**
 * Declares who is changing visits in this transaction and what they are doing. Every api.*
 * function that writes a visit calls this first; the event trigger refuses writes without it.
 */
create function private.set_actor(
  p_kind app.actor_kind,
  p_actor_id uuid,
  p_action text default null,
  p_reason text default null,
  p_payload jsonb default '{}'
) returns void
language sql volatile set search_path = '' as $$
  select set_config('app.actor_kind', p_kind::text, true),
         set_config('app.actor_id', coalesce(p_actor_id::text, ''), true),
         set_config('app.action', coalesce(p_action, ''), true),
         set_config('app.reason', coalesce(p_reason, ''), true),
         set_config('app.event_payload', coalesce(p_payload, '{}')::text, true);
$$;
comment on function private.set_actor(app.actor_kind, uuid, text, text, jsonb) is
  'Sets transaction-local actor context read by the visit triggers: actor kind and id, the '
  'action being applied (a visit_action name, ''undo'', or null for non-status edits), an '
  'optional reason and event payload. Call again before each distinct change.';
revoke all on function private.set_actor(app.actor_kind, uuid, text, text, jsonb) from public, anon, authenticated;

create function private.current_action() returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('app.action', true), '')
$$;

------------------------------------------------------------------------------------------------
-- Guard: legal transitions only, version bump on every change
------------------------------------------------------------------------------------------------

create function private.guard_visit() returns trigger
language plpgsql set search_path = '' as $$
declare
  act text := private.current_action();
  target api.visit_state;
begin
  if nullif(current_setting('app.actor_kind', true), '') is null then
    raise exception 'missing_actor_context'
      using hint = 'Visits change only through api.* functions, which call private.set_actor().';
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

create trigger guard_visit before insert or update on app.visits
  for each row execute function private.guard_visit();

------------------------------------------------------------------------------------------------
-- Event writer: every insert and update produces exactly one visit_events row
------------------------------------------------------------------------------------------------

create function private.write_visit_event() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into app.visit_events (org_id, visit_id, type, from_status, to_status,
                                actor_kind, actor_id, reason, payload)
  values (
    new.org_id,
    new.id,
    case when tg_op = 'INSERT' then 'joined' else coalesce(private.current_action(), 'updated') end,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status,
    current_setting('app.actor_kind')::app.actor_kind,
    nullif(current_setting('app.actor_id', true), '')::uuid,
    nullif(current_setting('app.reason', true), ''),
    coalesce(nullif(current_setting('app.event_payload', true), ''), '{}')::jsonb
  );
  return null;
end $$;

create trigger write_visit_event after insert or update on app.visits
  for each row execute function private.write_visit_event();

create function private.forbid_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are never deleted', tg_table_name using errcode = '42501';
end $$;

create trigger forbid_delete before delete on app.visits
  for each row execute function private.forbid_delete();

-- Append-only: the only permitted change is setting undone_by_event_id once (api.undo_event).
create function private.guard_visit_event() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visit_events is append-only' using errcode = '42501';
  end if;
  if old.undone_by_event_id is not null
     or (to_jsonb(new) - 'undone_by_event_id') <> (to_jsonb(old) - 'undone_by_event_id') then
    raise exception 'visit_events is append-only' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger guard_visit_event before update or delete on app.visit_events
  for each row execute function private.guard_visit_event();

------------------------------------------------------------------------------------------------
-- Audit log for config tables
------------------------------------------------------------------------------------------------

create table app.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.organizations (id) on delete cascade,
  actor uuid,
  role text,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  table_name text not null,
  row_id text,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index audit_log_org_idx on app.audit_log (org_id, at desc);

create function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  org uuid := coalesce((rec ->> 'org_id')::uuid, case when tg_table_name = 'organizations' then (rec ->> 'id')::uuid end);
  uid uuid := (select auth.uid());
begin
  -- System rows (org_id null) belong to no tenant, and rows removed by an org cascade have
  -- nowhere to be logged.
  if org is null or (tg_op = 'DELETE' and not exists (select 1 from app.organizations where id = org)) then
    return null;
  end if;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, before, after)
  values (
    org,
    uid,
    coalesce((select m.role::text from app.memberships m where m.user_id = uid and m.org_id = org),
             nullif(current_setting('request.jwt.claim.role', true), ''),
             'system'),
    tg_op,
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'old_slug', rec ->> 'user_id'),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return null;
end $$;
comment on function private.audit_row() is
  'AFTER trigger on config tables: records actor, role, before and after for every change.';

do $$
declare t text;
begin
  foreach t in array array['organizations', 'memberships', 'locations', 'business_hours',
                           'hours_exceptions', 'devices', 'slug_redirects', 'queues', 'services',
                           'counters'] loop
    execute format('create trigger audit_row after insert or update or delete on app.%I
                    for each row execute function private.audit_row()', t);
  end loop;
end $$;

------------------------------------------------------------------------------------------------
-- Idempotency keys for staff RPCs (anon joins dedupe on visits.idempotency_key instead)
------------------------------------------------------------------------------------------------

create table app.idempotency_keys (
  org_id uuid not null references app.organizations (id) on delete cascade,
  actor_id uuid not null,
  rpc text not null,
  key uuid not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (actor_id, rpc, key)
);
create index idempotency_keys_created_idx on app.idempotency_keys (created_at);

create function ops.purge_idempotency_keys() returns int
language sql volatile set search_path = '' as $$
  with d as (delete from app.idempotency_keys where created_at < now() - interval '48 hours' returning 1)
  select count(*)::int from d
$$;
comment on function ops.purge_idempotency_keys() is
  'Deletes idempotency keys older than 48 hours. Run hourly by pg_cron; returns rows deleted.';

select cron.schedule('purge-idempotency-keys', '17 * * * *', 'select ops.purge_idempotency_keys()');

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

-- Only definer functions write these tables. Staff read visits and events under RLS.
revoke insert, update, delete, truncate on app.visits, app.visit_events, app.audit_log,
  app.idempotency_keys, app.visit_transitions from authenticated;

alter table app.visit_transitions enable row level security;
alter table app.visits enable row level security;
alter table app.visit_events enable row level security;
alter table app.audit_log enable row level security;
alter table app.idempotency_keys enable row level security;

create policy visit_transitions_select on app.visit_transitions for select to authenticated
  using (true);

-- Displays and kiosks never read visits directly; they get sanitized snapshots via RPC.
create policy visits_select on app.visits for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));

create policy visit_events_select on app.visit_events for select to authenticated
  using (exists (
    select 1 from app.visits v
    where v.id = visit_id and (select private.has_role(v.org_id, v.location_id, 'staff'))
  ));

create policy audit_log_select on app.audit_log for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));

create policy idempotency_keys_select on app.idempotency_keys for select to authenticated
  using (actor_id = (select auth.uid()));
