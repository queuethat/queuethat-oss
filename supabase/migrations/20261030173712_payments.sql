-- V-4 (#318): payment holds and provider webhook events, test mode only until phase 3. Clients
-- read (owner and admin); every write is a service-role function, so a webhook is the only way a
-- hold changes state. Replayed provider events are no-ops and a terminal state never moves back.
create type app.payment_status as enum ('created', 'held', 'captured', 'released', 'failed');
grant usage on type app.payment_status to authenticated, service_role;

create table app.payment_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  visit_id uuid,
  appointment_id uuid,
  provider text not null check (length(provider) between 1 and 30),
  provider_hold_id text not null check (length(provider_hold_id) between 1 and 200),
  amount_minor int not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  status app.payment_status not null default 'created',
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visit_id is null or appointment_id is null),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  foreign key (org_id, appointment_id) references app.appointments (org_id, id),
  unique (provider, provider_hold_id),
  unique (org_id, idempotency_key)
);

create table app.payment_events (
  provider text not null,
  provider_event_id text not null,
  org_id uuid not null references app.organizations (id) on delete cascade,
  type text not null,
  -- Ids and amounts only: no card data or customer details are ever stored.
  payload_minimal jsonb not null default '{}',
  received_at timestamptz not null default now(),
  primary key (provider, provider_event_id)
);

alter table app.payment_holds enable row level security;
alter table app.payment_events enable row level security;
revoke all on app.payment_holds, app.payment_events from anon, authenticated;
grant select on app.payment_holds, app.payment_events to authenticated;
create policy payment_holds_select on app.payment_holds for select to authenticated
  using (private.has_role(org_id, null, 'admin'));
create policy payment_events_select on app.payment_events for select to authenticated
  using (private.has_role(org_id, null, 'admin'));

create function api.create_payment_hold(
  p_org_id uuid, p_visit_id uuid, p_appointment_id uuid, p_provider text, p_provider_hold_id text,
  p_amount_minor int, p_currency text, p_idempotency_key text
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into app.payment_holds (org_id, visit_id, appointment_id, provider, provider_hold_id,
                                 amount_minor, currency, idempotency_key)
  values (p_org_id, p_visit_id, p_appointment_id, p_provider, p_provider_hold_id,
          p_amount_minor, lower(p_currency), p_idempotency_key)
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from app.payment_holds where org_id = p_org_id and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;
comment on function api.create_payment_hold(uuid, uuid, uuid, text, text, int, text, text) is
  'Service role only (the local-testing payments Edge Function): records a hold the provider '
  'created, status created. Repeating an idempotency key returns the same hold. Raises the '
  'constraint errors for a bad amount, currency or an unknown visit or appointment of the org. '
  'Implemented in V2 (#318).';

create function api.record_payment_event(
  p_provider text, p_event_id text, p_type text, p_provider_hold_id text, p_amount_minor int, p_at timestamptz
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  h app.payment_holds;
  v_next app.payment_status;
begin
  if p_type not in ('hold_succeeded', 'hold_failed', 'captured', 'released') then
    raise exception 'invalid_input';
  end if;
  select * into h from app.payment_holds
  where provider = p_provider and provider_hold_id = p_provider_hold_id for update;
  if not found then
    return 'unknown_hold'; -- the provider may be ahead of our insert; the webhook asks it to retry
  end if;
  insert into app.payment_events (provider, provider_event_id, org_id, type, payload_minimal, received_at)
  values (p_provider, p_event_id, h.org_id, p_type,
          jsonb_strip_nulls(jsonb_build_object('hold_id', p_provider_hold_id, 'amount_minor', p_amount_minor, 'at', p_at)),
          now())
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;
  -- captured, released and failed are final: a late or reordered event can't move a hold back.
  if h.status in ('created', 'held') then
    v_next := case p_type
      when 'hold_succeeded' then 'held'
      when 'hold_failed' then case when h.status = 'created' then 'failed' else h.status end
      when 'captured' then 'captured'
      else 'released'
    end;
    update app.payment_holds set status = v_next, updated_at = now() where id = h.id;
  end if;
  return 'recorded';
end $$;
comment on function api.record_payment_event(text, text, text, text, int, timestamptz) is
  'Service role only (the payment-webhook Edge Function, after the provider signature checked '
  'out): stores the event once and moves the hold along created, held, then captured, released or '
  'failed, never out of a final state. Returns recorded, duplicate (same provider event id, no '
  'change) or unknown_hold. Raises invalid_input for an unknown type. Implemented in V2 (#318).';

revoke all on function api.create_payment_hold(uuid, uuid, uuid, text, text, int, text, text),
  api.record_payment_event(text, text, text, text, int, timestamptz) from public, anon, authenticated;
grant execute on function api.create_payment_hold(uuid, uuid, uuid, text, text, int, text, text),
  api.record_payment_event(text, text, text, text, int, timestamptz) to service_role;
