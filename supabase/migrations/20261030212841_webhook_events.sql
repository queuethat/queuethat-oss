-- 3-CG1 (#326): inbound provider events are recorded once; inbound messages gain provider ids.
-- Expand-only. private.webhook_events lives in the unexposed schema (service role via the two
-- definer functions below); app.inbound_messages already exists from 2P-NTF10 (#182).

create table private.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (length(provider) between 1 and 40),
  event_key text not null check (length(event_key) between 1 and 200),
  org_id uuid references app.organizations (id) on delete cascade,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}',
  processed_at timestamptz,
  error text,
  unique (provider, event_key)
);
create index webhook_events_org_idx on private.webhook_events (org_id, received_at desc);
revoke all on private.webhook_events from public, anon, authenticated, service_role;
comment on table private.webhook_events is
  'One row per provider event, keyed by (provider, event_key) so a replay is a no-op. Payloads may '
  'hold phone numbers: it is in the retention list with app.inbound_messages. Service role only, '
  'through api.record_webhook_event.';

alter table app.inbound_messages
  add column provider text,
  add column provider_message_id text,
  add column to_address text,
  add column visit_id uuid,
  add column handled_as text check (handled_as in ('stop', 'start', 'help', 'join', 'unhandled', 'stored')),
  -- api.inbound_result.inbound_id is a uuid (fixed in 3-API1) while the dev table's id is a bigint.
  add column public_id uuid not null default gen_random_uuid() unique,
  add constraint inbound_messages_visit_fk foreign key (org_id, visit_id)
    references app.visits (org_id, id) on delete set null (visit_id),
  add constraint inbound_messages_provider_pair check ((provider is null) = (provider_message_id is null));
create unique index inbound_messages_provider_msg_idx
  on app.inbound_messages (provider, provider_message_id) where provider is not null;
comment on column app.inbound_messages.public_id is
  'The uuid api.inbound_result returns; id stays the internal bigint.';

-- redefines api.record_webhook_event from 20261030210404_api_contracts_3.sql
create or replace function api.record_webhook_event(p_provider text, p_event_key text, p_org_id uuid, p_payload jsonb)
returns api.webhook_record
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  if coalesce(p_provider, '') = '' or coalesce(p_event_key, '') = '' then
    raise exception 'invalid_input';
  end if;
  insert into private.webhook_events (provider, event_key, org_id, payload)
  values (p_provider, p_event_key, p_org_id, coalesce(p_payload, '{}'))
  on conflict (provider, event_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from private.webhook_events where provider = p_provider and event_key = p_event_key;
    return row(v_id, true)::api.webhook_record;
  end if;
  return row(v_id, false)::api.webhook_record;
end $$;
comment on function api.record_webhook_event(text, text, uuid, jsonb) is
  'Service role only (provider-webhook): stores the event once per (provider, event key); a repeat '
  'returns the first event''s id with is_duplicate = true and changes nothing. Raises invalid_input '
  'for an empty provider or key. Implemented in 3-CG1 (#326).';

-- redefines api.mark_webhook_processed from 20261030210404_api_contracts_3.sql
create or replace function api.mark_webhook_processed(p_event_id bigint, p_error text default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update private.webhook_events
  set processed_at = coalesce(processed_at, now()), error = coalesce(error, left(p_error, 500))
  where id = p_event_id;
end $$;
comment on function api.mark_webhook_processed(bigint, text) is
  'Service role only: stamps processed_at and the error (first one wins, 500 chars), if any. '
  'Repeats and unknown ids are no-ops. Implemented in 3-CG1 (#326).';

-- redefines ops.retention_tick from 20261030065000_retention.sql: also purges webhook events and inbound messages
create or replace function ops.retention_tick() returns int
language plpgsql volatile set search_path = '' as $$
declare
  o record;
  v_visits uuid[];
  v_appts uuid[];
  nv int;
  na int;
  nc int;
  total int := 0;
begin
  for o in select id, retention_days from app.organizations loop
    select coalesce(array_agg(id), '{}') into v_visits from (
      select v.id from app.visits v
      where v.org_id = o.id and v.anonymized_at is null
        and v.status in ('served', 'no_show', 'cancelled', 'removed', 'expired')
        and coalesce(v.finished_at, v.joined_at) < now() - make_interval(days => o.retention_days)
      limit 5000) s;
    select coalesce(array_agg(id), '{}') into v_appts from (
      select a.id from app.appointments a
      where a.org_id = o.id and a.anonymized_at is null
        and a.status in ('completed', 'cancelled', 'no_show')
        and a.ends_at < now() - make_interval(days => o.retention_days)
      limit 5000) s;
    nv := private.anonymize_visits(o.id, v_visits);
    na := private.anonymize_appointments(o.id, v_appts);

    with d as (
      delete from app.guests g
      where g.org_id = o.id
        and g.created_at < now() - make_interval(days => o.retention_days)
        and not exists (select 1 from app.visits v where v.guest_id = g.id and v.anonymized_at is null)
        and not exists (select 1 from app.appointments a where a.guest_id = g.id and a.anonymized_at is null)
      returning (select count(*) from app.guest_contacts c where c.guest_id = g.id) as contacts
    )
    select coalesce(sum(contacts), 0)::int into nc from d;

    insert into app.retention_runs (org_id, visits_anonymized, contacts_deleted, appointments_anonymized)
    values (o.id, nv, nc, na);
    total := total + nv;
  end loop;

  delete from app.dev_inbox where created_at < now() - interval '7 days';
  delete from private.webhook_events w using app.organizations o2
  where w.org_id = o2.id and w.received_at < now() - make_interval(days => o2.retention_days);
  delete from private.webhook_events where org_id is null and received_at < now() - interval '30 days';
  delete from app.inbound_messages m using app.organizations o3
  where m.org_id = o3.id and m.received_at < now() - make_interval(days => o3.retention_days);
  delete from app.push_subscriptions p using app.visits v
  where v.id = p.visit_id and v.status in ('served', 'no_show', 'cancelled', 'removed', 'expired')
    and coalesce(v.finished_at, v.joined_at) < now() - interval '1 day';
  return total;
end $$;
