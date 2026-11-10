-- 4-BILL1 (#377): plans and one Stripe Billing subscription per org, quantity = its locations.
-- The platform's own Stripe account (not an org's BYO keys) is the source of truth for payment
-- state; the billing Edge Function verifies and forwards its events to api.apply_billing_event.
-- Self-host never sees any of it: with app.platform_flags.billing_enabled off (the default) every
-- trigger is a no-op, no plan applies and everything is free and unlimited.
--
-- Nothing here deletes or blocks data. A failed payment sets past_due with a grace period; after it
-- (or a cancellation) the org's plan resolves to 'free', which 4-BILL3 (#379) turns into limits on
-- new locations and seats only.

alter table app.platform_flags add column billing_enabled boolean not null default false;

create function private.billing_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select f.billing_enabled from app.platform_flags f), false)
$$;
revoke all on function private.billing_enabled() from public, anon, authenticated;
grant execute on function private.billing_enabled() to service_role;

------------------------------------------------------------------------------------------------
-- Plans (global)
------------------------------------------------------------------------------------------------

create table app.plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (length(btrim(name)) between 1 and 60),
  -- Display price per location per month in minor units. Stripe's Price is what is charged.
  unit_price_minor int not null default 0 check (unit_price_minor >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  stripe_price_id text unique
);
insert into app.plans (id, name, unit_price_minor) values ('free', 'Free', 0), ('standard', 'Standard', 1900);

-- Plan defaults for entitlement keys; private.entitlement reads them after an org's own override.
create table app.plan_entitlements (
  plan_id text not null references app.plans (id) on delete cascade,
  key text not null references app.entitlement_defaults (key) on delete cascade,
  value jsonb not null,
  primary key (plan_id, key)
);

alter table app.plans enable row level security;
alter table app.plan_entitlements enable row level security;
create policy plans_select on app.plans for select to authenticated using (true);
-- Read only through private.entitlement (definer).
create policy plan_entitlements_none on app.plan_entitlements for select to authenticated using (false);
revoke all on app.plans, app.plan_entitlements from public, anon, authenticated;
grant select on app.plans to authenticated;
grant all on app.plans, app.plan_entitlements to service_role;

------------------------------------------------------------------------------------------------
-- Subscriptions
------------------------------------------------------------------------------------------------

create table app.subscriptions (
  org_id uuid primary key references app.organizations (id) on delete cascade,
  plan_id text not null references app.plans (id) default 'standard',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text not null default 'incomplete' check (status in
    ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused')),
  -- What Stripe last confirmed, and what the org's locations call for.
  quantity int not null default 0 check (quantity >= 0),
  desired_quantity int not null default 0 check (desired_quantity >= 0),
  current_period_end timestamptz,
  grace_ends_at timestamptz,
  -- Stripe's created time of the newest event applied: older events are ignored.
  last_event_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger forbid_org_change before update on app.subscriptions
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.subscriptions
  for each row execute function private.touch_updated_at();

alter table app.subscriptions enable row level security;
create policy subscriptions_select on app.subscriptions for select to authenticated
  using ((select private.has_role(org_id, null, 'owner')));
revoke all on app.subscriptions from public, anon, authenticated;
grant select (org_id, plan_id, status, quantity, desired_quantity, current_period_end, grace_ends_at, updated_at)
  on app.subscriptions to authenticated;
grant select, insert, update on app.subscriptions to service_role;

-- The plan an org's entitlements come from; null while billing is off, so nothing is limited.
create function private.org_plan(p_org_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when not private.billing_enabled() then null else coalesce((
    select s.plan_id from app.subscriptions s
    where s.org_id = p_org_id
      and (s.status in ('trialing', 'active') or (s.status = 'past_due' and s.grace_ends_at > now()))
  ), 'free') end
$$;
comment on function private.org_plan(uuid) is
  'The org''s plan id: its subscription''s while trialing, active or past_due within the grace period, '
  'otherwise free. Null when billing is off, so no plan default applies.';
revoke all on function private.org_plan(uuid) from public, anon, authenticated;
grant execute on function private.org_plan(uuid) to authenticated, service_role;

-- redefines private.entitlement from 20261025003610_entitlements.sql
create or replace function private.entitlement(p_org_id uuid, p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.value from app.org_entitlements o where o.org_id = p_org_id and o.key = p_key),
    (select pe.value from app.plan_entitlements pe
     where pe.key = p_key and pe.plan_id = private.org_plan(p_org_id)),
    (select d.value from app.entitlement_defaults d where d.key = p_key)
  )
$$;
comment on function private.entitlement(uuid, text) is
  'The org''s value for an entitlement key: its override, else its plan default, else the global '
  'default, else null for an unknown key. The only place entitlements are resolved.';

------------------------------------------------------------------------------------------------
-- Quantity sync jobs
------------------------------------------------------------------------------------------------

create table app.billing_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  -- Provider error code only.
  last_error text check (length(last_error) <= 100),
  created_at timestamptz not null default now()
);
-- Quantity is read when the job runs, so one waiting job per org covers any number of changes.
create unique index billing_jobs_one_queued on app.billing_jobs (org_id) where status = 'queued';
create index billing_jobs_due_idx on app.billing_jobs (next_attempt_at) where status in ('queued', 'claimed');
alter table app.billing_jobs enable row level security;
create policy billing_jobs_none on app.billing_jobs for select to authenticated using (false);
revoke all on app.billing_jobs from public, anon, authenticated;
grant all on app.billing_jobs to service_role;
revoke delete on app.billing_jobs from service_role;

-- Records what the org's locations call for and, when Stripe holds a live subscription, queues a sync.
create function private.sync_subscription_quantity(p_org_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.subscriptions;
begin
  if not private.billing_enabled() then return; end if;
  -- an org being deleted takes its locations with it: nothing to record
  if not exists (select 1 from app.organizations where id = p_org_id) then return; end if;
  update app.subscriptions
  set desired_quantity = (select count(*) from app.locations l where l.org_id = p_org_id)
  where org_id = p_org_id
  returning * into s;
  if s.stripe_subscription_id is not null and s.status not in ('canceled', 'incomplete_expired')
     and s.quantity <> s.desired_quantity then
    insert into app.billing_jobs (org_id) values (p_org_id) on conflict (org_id) where status = 'queued' do nothing;
  end if;
end $$;
comment on function private.sync_subscription_quantity(uuid) is
  'Sets the org''s desired subscription quantity to its location count and queues one quantity sync '
  'when Stripe holds a live subscription with a different quantity. A no-op while billing is off.';
revoke all on function private.sync_subscription_quantity(uuid) from public, anon, authenticated;

create function private.sync_quantity_on_location() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.sync_subscription_quantity(coalesce(new.org_id, old.org_id));
  return null;
end $$;
revoke all on function private.sync_quantity_on_location() from public, anon, authenticated;
create trigger sync_subscription_quantity after insert or delete on app.locations
  for each row execute function private.sync_quantity_on_location();

-- Service role (billing function). Leases due jobs; the quantity is the one wanted now.
create function api.claim_billing_jobs(p_limit int, p_lease_seconds int)
returns table (id uuid, org_id uuid, stripe_subscription_id text, quantity int, attempts int)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit not between 1 and 100 or p_lease_seconds not between 5 and 3600 then
    raise exception 'invalid_input';
  end if;
  update app.billing_jobs b set status = 'dead', locked_until = null, last_error = 'lease_expired'
  where b.status = 'claimed' and b.locked_until < now() and b.attempts >= 6;
  return query
  with due as (
    select j.id from app.billing_jobs j
    where j.next_attempt_at <= now()
      and (j.status = 'queued' or (j.status = 'claimed' and j.locked_until < now()))
    order by j.next_attempt_at, j.created_at
    limit p_limit
    for update skip locked
  ), leased as (
    update app.billing_jobs j
    set status = 'claimed', attempts = j.attempts + 1,
        locked_until = now() + make_interval(secs => p_lease_seconds)
    from due where j.id = due.id
    returning j.id, j.org_id, j.attempts
  )
  select l.id, l.org_id, s.stripe_subscription_id, s.desired_quantity, l.attempts
  from leased l join app.subscriptions s on s.org_id = l.org_id;
end $$;
comment on function api.claim_billing_jobs(int, int) is
  'Service role only (billing function): leases up to p_limit due quantity-sync jobs, oldest first, '
  'with the org''s current subscription id and desired quantity. Two concurrent callers never get the '
  'same job; a lease that expires on a sixth attempt dead-letters the job. Raises invalid_input.';

-- p_result: {"ok": true, "quantity": n} or {"ok": false, "retryable": bool, "code": "..."}
create function api.report_billing_result(p_job_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  j app.billing_jobs;
begin
  select * into j from app.billing_jobs where id = p_job_id for update;
  if not found then raise exception 'not_found'; end if;
  if j.status <> 'claimed' then return; end if; -- a repeat, or the lease was lost: no-op
  if coalesce((p_result ->> 'ok')::boolean, false) then
    update app.billing_jobs set status = 'done', locked_until = null, last_error = null where id = j.id;
    update app.subscriptions set quantity = (p_result ->> 'quantity')::int where org_id = j.org_id;
    -- locations changed while the job ran
    perform private.sync_subscription_quantity(j.org_id);
  elsif coalesce((p_result ->> 'retryable')::boolean, false) and j.attempts < 6 then
    update app.billing_jobs
    set status = 'queued', locked_until = null, last_error = left(p_result ->> 'code', 100),
        next_attempt_at = now() + make_interval(secs => 30 * power(2, j.attempts))
    where id = j.id;
  else
    update app.billing_jobs
    set status = case when coalesce((p_result ->> 'retryable')::boolean, false) then 'dead' else 'failed' end,
        locked_until = null, last_error = left(p_result ->> 'code', 100)
    where id = j.id;
  end if;
end $$;
comment on function api.report_billing_result(uuid, jsonb) is
  'Service role only: records a claimed job''s outcome ({ok, quantity} or {ok:false, retryable, code}). '
  'Success stores the quantity Stripe now has and queues another sync if the locations moved meanwhile. '
  'Retryable failures back off 30 s x 2^attempts and go dead after 6 attempts; other failures are failed '
  'at once. Reporting a job that is not claimed is a no-op. Raises not_found.';

revoke all on function api.claim_billing_jobs(int, int), api.report_billing_result(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function api.claim_billing_jobs(int, int), api.report_billing_result(uuid, jsonb) to service_role;

-- Locations change rarely, so a minute's delay is fine: cron kicks the function when a job is due.
create function ops.kick_billing_jobs_if_due() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (
    select 1 from app.billing_jobs j
    where j.next_attempt_at <= now() and (j.status = 'queued' or (j.status = 'claimed' and j.locked_until < now()))
  ) then return; end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'billing_jobs_url';
  if v_url is null then return; end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || coalesce(v_key, '')));
exception when others then
  raise warning 'kick_billing_jobs failed: %', sqlerrm;
end $$;
revoke all on function ops.kick_billing_jobs_if_due() from public, anon, authenticated;
select cron.schedule('kick-billing-jobs', '* * * * *', 'select ops.kick_billing_jobs_if_due()');

------------------------------------------------------------------------------------------------
-- Stripe events
------------------------------------------------------------------------------------------------

-- p_type: subscription (created or updated), deleted, payment_failed. p_org_id is the org id we put
-- in the subscription's metadata when we created it; invoice events do not carry one.
create function api.apply_billing_event(
  p_type text, p_created timestamptz, p_org_id uuid, p_customer_id text, p_subscription_id text,
  p_status text, p_price_id text, p_quantity int, p_period_end timestamptz
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.subscriptions;
  v_status text;
  v_plan text;
begin
  if p_type not in ('subscription', 'deleted', 'payment_failed') or p_created is null
     or p_subscription_id is null or p_quantity < 0
     or (p_type = 'subscription' and p_status is null) then
    raise exception 'invalid_input';
  end if;

  select * into s from app.subscriptions x where x.stripe_subscription_id = p_subscription_id for update;
  if found then
    -- the subscription's own org is the authority; metadata must agree with it
    if p_org_id is not null and p_org_id <> s.org_id then return 'org_mismatch'; end if;
  elsif p_type = 'subscription' and p_org_id is not null then
    select * into s from app.subscriptions x where x.org_id = p_org_id for update;
    if not found then
      if not exists (select 1 from app.organizations where id = p_org_id) then return 'unknown_subscription'; end if;
      insert into app.subscriptions (org_id, desired_quantity)
      values (p_org_id, (select count(*) from app.locations l where l.org_id = p_org_id))
      returning * into s;
    -- a second live subscription for one org is not tracked
    elsif s.stripe_subscription_id is not null and s.status not in ('canceled', 'incomplete_expired') then
      return 'ignored';
    end if;
    -- a customer belongs to one org
    if p_customer_id is not null and exists (
      select 1 from app.subscriptions x where x.stripe_customer_id = p_customer_id and x.org_id <> s.org_id) then
      return 'org_mismatch';
    end if;
  else
    return 'unknown_subscription';
  end if;

  if s.last_event_at is not null and p_created < s.last_event_at then return 'ignored'; end if;

  v_status := case p_type when 'deleted' then 'canceled' when 'payment_failed' then 'past_due' else p_status end;
  if v_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused') then
    raise exception 'invalid_input';
  end if;
  select p.id into v_plan from app.plans p where p.stripe_price_id = p_price_id;

  update app.subscriptions set
    stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
    stripe_subscription_id = p_subscription_id,
    plan_id = coalesce(v_plan, plan_id),
    status = v_status,
    quantity = coalesce(p_quantity, quantity),
    current_period_end = coalesce(p_period_end, current_period_end),
    -- payment trouble starts one grace period; paying again ends it
    grace_ends_at = case when v_status = 'past_due' then coalesce(grace_ends_at, now() + interval '14 days')
                         when v_status in ('active', 'trialing') then null else grace_ends_at end,
    last_event_at = p_created
  where org_id = s.org_id;
  perform private.sync_subscription_quantity(s.org_id);
  return 'applied';
end $$;
comment on function api.apply_billing_event(text, timestamptz, uuid, text, text, text, text, int, timestamptz) is
  'Service role only (billing function, after the Stripe signature check): applies one subscription '
  'event (subscription = created or updated, deleted, payment_failed) in Stripe''s order; older events '
  'than the newest applied are ignored, repeats change nothing. A payment failure sets past_due with a '
  'grace period of 14 days; data is never deleted. Returns applied, ignored, org_mismatch (metadata or '
  'customer belongs to another org: nothing written) or unknown_subscription. Raises invalid_input.';
revoke all on function api.apply_billing_event(text, timestamptz, uuid, text, text, text, text, int, timestamptz)
  from public, anon, authenticated;
grant execute on function api.apply_billing_event(text, timestamptz, uuid, text, text, text, text, int, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
