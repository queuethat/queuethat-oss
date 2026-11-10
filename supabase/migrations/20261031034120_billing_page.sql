-- 4-BILL2 (#378): what the owner's billing page shows, and what the billing function needs to open a
-- Stripe session for the owner. Both are owner-only and never reveal another org's subscription.

-- One read for the whole page: the plan, the price per location, the locations, and Stripe's state.
-- enabled=false (billing off) returns that alone, so the page and its menu entry stay hidden.
create function api.org_billing(p_org_id uuid)
returns table (
  enabled boolean, plan_id text, plan_name text, unit_price_minor int, currency text, locations int,
  subscribed boolean, status text, quantity int, current_period_end timestamptz, grace_ends_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.billing_enabled() then
    return query select false, null::text, null::text, null::int, null::text, null::int, false,
                        null::text, null::int, null::timestamptz, null::timestamptz;
    return;
  end if;
  return query
  select true, p.id, p.name, p.unit_price_minor, p.currency,
         (select count(*)::int from app.locations l where l.org_id = p_org_id),
         s.stripe_subscription_id is not null and s.status not in ('canceled', 'incomplete_expired'),
         s.status, s.quantity, s.current_period_end, s.grace_ends_at
  from app.plans p
  left join app.subscriptions s on s.org_id = p_org_id
  where p.id = private.org_plan(p_org_id);
end $$;
comment on function api.org_billing(uuid) is
  'Owner only: the org''s plan (the paid one while trialing, active or inside the grace period, else '
  'free), its per-location price, its location count and its subscription state. Returns enabled=false '
  'and nothing else while billing is off. Raises permission_denied (42501) for any other caller.';

-- What the billing function needs to open a Checkout or Customer Portal session for this owner.
create function api.billing_session_info(p_org_id uuid)
returns table (customer_id text, subscription_id text, price_id text, quantity int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.billing_enabled() then raise exception 'not_found'; end if;
  return query
  select s.stripe_customer_id,
         case when s.status in ('canceled', 'incomplete_expired') then null else s.stripe_subscription_id end,
         (select p.stripe_price_id from app.plans p where p.id = 'standard'),
         greatest((select count(*)::int from app.locations l where l.org_id = p_org_id), 1)
  from (select 1) one
  left join app.subscriptions s on s.org_id = p_org_id;
end $$;
comment on function api.billing_session_info(uuid) is
  'Owner only: the Stripe customer and live subscription of the org (null if none), the price id of the '
  'paid plan and the quantity a new subscription starts at (its locations, at least 1). Raises '
  'permission_denied (42501), and not_found while billing is off.';

revoke all on function api.org_billing(uuid), api.billing_session_info(uuid) from public, anon;
grant execute on function api.org_billing(uuid), api.billing_session_info(uuid) to authenticated;

notify pgrst, 'reload schema';
