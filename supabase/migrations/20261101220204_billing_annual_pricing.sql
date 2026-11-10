-- #1085: annual pricing. A plan has a second Stripe Price for yearly billing; Checkout takes the
-- interval; the subscription records how it is billed so the page shows the right price. Additive:
-- no existing column changes, and a plan without an annual price simply offers monthly only.
-- Default annual price is 20% off twelve months ($182.40 per location per year for Standard).
-- Alternatives considered: one price row per plan and interval (a new table and a rewrite of the
-- webhook mapping, rejected as a redesign); deriving the interval from Stripe at read time
-- (rejected: the page must not call Stripe).

alter table app.plans
  add column unit_price_annual_minor int check (unit_price_annual_minor >= 0),
  add column stripe_price_id_annual text unique;
update app.plans set unit_price_annual_minor = round(unit_price_minor * 12 * 0.8) where id = 'standard';
alter table app.subscriptions
  add column billing_interval text not null default 'month' check (billing_interval in ('month', 'year'));

-- redefines api.apply_billing_event from 20261031032519_billing_hardening.sql
-- The only change: a subscription's price may be the plan's annual one, and the interval is recorded.
create or replace function api.apply_billing_event(
  p_type text, p_created timestamptz, p_org_id uuid, p_customer_id text, p_subscription_id text,
  p_status text, p_price_id text, p_quantity int, p_period_end timestamptz
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.subscriptions;
  v_status text;
  v_plan text;
  v_interval text;
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
  else
    return 'unknown_subscription';
  end if;

  -- a customer belongs to one org
  if p_customer_id is not null and exists (
    select 1 from app.subscriptions x where x.stripe_customer_id = p_customer_id and x.org_id <> s.org_id) then
    return 'org_mismatch';
  end if;

  if s.last_event_at is not null and p_created < s.last_event_at then return 'ignored'; end if;

  -- a late failure never revives a canceled subscription or starts a grace period on an unpaid first invoice
  if p_type = 'payment_failed' and s.status not in ('active', 'trialing', 'past_due') then return 'ignored'; end if;
  v_status := case p_type when 'deleted' then 'canceled' when 'payment_failed' then 'past_due' else p_status end;
  if v_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused') then
    raise exception 'invalid_input';
  end if;
  -- either of a plan's two prices identifies it; which one says how it is billed
  select p.id, case when p.stripe_price_id_annual = p_price_id then 'year' else 'month' end
    into v_plan, v_interval
  from app.plans p where p.stripe_price_id = p_price_id or p.stripe_price_id_annual = p_price_id;

  update app.subscriptions set
    stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
    stripe_subscription_id = p_subscription_id,
    plan_id = coalesce(v_plan, plan_id),
    billing_interval = coalesce(v_interval, billing_interval),
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


-- redefines api.billing_session_info from 20261031034120_billing_page.sql
-- Gains p_interval ('month' default, or 'year'): price_id is that interval's Stripe Price.
drop function api.billing_session_info(uuid);
create function api.billing_session_info(p_org_id uuid, p_interval text default 'month')
returns table (customer_id text, subscription_id text, price_id text, quantity int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.billing_enabled() then raise exception 'not_found'; end if;
  if p_interval not in ('month', 'year') then raise exception 'invalid_input'; end if;
  return query
  select s.stripe_customer_id,
         case when s.status in ('canceled', 'incomplete_expired') then null else s.stripe_subscription_id end,
         (select case p_interval when 'year' then p.stripe_price_id_annual else p.stripe_price_id end
          from app.plans p where p.id = 'standard'),
         greatest((select count(*)::int from app.locations l where l.org_id = p_org_id), 1)
  from (select 1) one
  left join app.subscriptions s on s.org_id = p_org_id;
end $$;
comment on function api.billing_session_info(uuid, text) is
  'Owner only: the Stripe customer and live subscription of the org (null if none), the Stripe Price id '
  'of the paid plan for p_interval (month or year; null if not configured) and the quantity a new '
  'subscription starts at (its locations, at least 1). Raises permission_denied (42501), not_found '
  'while billing is off, and invalid_input for any other interval.';
revoke all on function api.billing_session_info(uuid, text) from public, anon;
grant execute on function api.billing_session_info(uuid, text) to authenticated;

-- redefines api.org_billing from 20261101215141_billing_plan_comparison.sql
-- Gains billing_interval, and each plan's unitPriceAnnualMinor (null unless its annual Price is configured).
drop function api.org_billing(uuid);
create function api.org_billing(p_org_id uuid)
returns table (
  enabled boolean, plan_id text, plan_name text, unit_price_minor int, currency text, locations int,
  subscribed boolean, status text, quantity int, current_period_end timestamptz, grace_ends_at timestamptz,
  plans jsonb, paid_channels boolean, billing_interval text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.billing_enabled() then
    return query select false, null::text, null::text, null::int, null::text, null::int, false,
                        null::text, null::int, null::timestamptz, null::timestamptz,
                        null::jsonb, null::boolean, null::text;
    return;
  end if;
  return query
  select true, p.id, p.name, p.unit_price_minor, p.currency,
         (select count(*)::int from app.locations l where l.org_id = p_org_id),
         s.stripe_subscription_id is not null and s.status not in ('canceled', 'incomplete_expired'),
         s.status, s.quantity, s.current_period_end, s.grace_ends_at,
         -- Each plan's own limits: its entitlement row, else the global default. -1 is unlimited.
         (select jsonb_agg(jsonb_build_object(
            'id', q.id, 'name', q.name, 'unitPriceMinor', q.unit_price_minor, 'currency', q.currency,
            'unitPriceAnnualMinor', case when q.stripe_price_id_annual is not null then q.unit_price_annual_minor end,
            'maxLocations', coalesce((select pe.value from app.plan_entitlements pe where pe.plan_id = q.id and pe.key = 'limit.locations'),
                                     (select d.value from app.entitlement_defaults d where d.key = 'limit.locations')),
            'maxMembers', coalesce((select pe.value from app.plan_entitlements pe where pe.plan_id = q.id and pe.key = 'limit.members'),
                                   (select d.value from app.entitlement_defaults d where d.key = 'limit.members')),
            'paidChannels', coalesce((select pe.value from app.plan_entitlements pe where pe.plan_id = q.id and pe.key = 'paid_channels'),
                                     (select d.value from app.entitlement_defaults d where d.key = 'paid_channels'))
          ) order by q.unit_price_minor)
          from app.plans q),
         private.entitled(p_org_id, 'paid_channels'),
         coalesce(s.billing_interval, 'month')
  from app.plans p
  left join app.subscriptions s on s.org_id = p_org_id
  where p.id = private.org_plan(p_org_id);
end $$;
comment on function api.org_billing(uuid) is
  'Owner only: the org''s plan (the paid one while trialing, active or inside the grace period, else '
  'free), its per-location price, its location count and its subscription state, every plan with its '
  'price, annual price (null if not offered) and limits (plans, cheapest first; -1 is unlimited), '
  'whether this org may use paid channels, and how its subscription is billed (month or year). Returns '
  'enabled=false and nothing else while billing is off. Raises permission_denied (42501) for any other caller.';
revoke all on function api.org_billing(uuid) from public, anon;
grant execute on function api.org_billing(uuid) to authenticated;

notify pgrst, 'reload schema';
