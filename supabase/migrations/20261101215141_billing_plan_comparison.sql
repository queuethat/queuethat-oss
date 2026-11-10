-- #1082: the billing page compares the plans before Checkout. api.org_billing already returns the
-- org's plan and Stripe state; it now also returns every plan with its price and limits, and whether
-- this org may use paid channels, so the client renders the comparison and never re-derives a limit.
-- Alternatives considered: a second RPC (api.billing_plans) was rejected as a shallow pass-through
-- next to org_billing; reading app.plan_entitlements from the client is blocked by RLS by design.
--
-- redefines api.org_billing from 20261031034120_billing_page.sql
-- The return type grows (plans, paid_channels), so the function is dropped and created again.
drop function api.org_billing(uuid);
create function api.org_billing(p_org_id uuid)
returns table (
  enabled boolean, plan_id text, plan_name text, unit_price_minor int, currency text, locations int,
  subscribed boolean, status text, quantity int, current_period_end timestamptz, grace_ends_at timestamptz,
  plans jsonb, paid_channels boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.billing_enabled() then
    return query select false, null::text, null::text, null::int, null::text, null::int, false,
                        null::text, null::int, null::timestamptz, null::timestamptz,
                        null::jsonb, null::boolean;
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
            'maxLocations', coalesce((select pe.value from app.plan_entitlements pe where pe.plan_id = q.id and pe.key = 'limit.locations'),
                                     (select d.value from app.entitlement_defaults d where d.key = 'limit.locations')),
            'maxMembers', coalesce((select pe.value from app.plan_entitlements pe where pe.plan_id = q.id and pe.key = 'limit.members'),
                                   (select d.value from app.entitlement_defaults d where d.key = 'limit.members')),
            'paidChannels', coalesce((select pe.value from app.plan_entitlements pe where pe.plan_id = q.id and pe.key = 'paid_channels'),
                                     (select d.value from app.entitlement_defaults d where d.key = 'paid_channels'))
          ) order by q.unit_price_minor)
          from app.plans q),
         private.entitled(p_org_id, 'paid_channels')
  from app.plans p
  left join app.subscriptions s on s.org_id = p_org_id
  where p.id = private.org_plan(p_org_id);
end $$;
comment on function api.org_billing(uuid) is
  'Owner only: the org''s plan (the paid one while trialing, active or inside the grace period, else '
  'free), its per-location price, its location count and its subscription state, every plan with its '
  'price and limits (plans, cheapest first; -1 is unlimited), and whether this org may use paid '
  'channels. Returns enabled=false and nothing else while billing is off. Raises permission_denied '
  '(42501) for any other caller.';

revoke all on function api.org_billing(uuid) from public, anon;
grant execute on function api.org_billing(uuid) to authenticated;

notify pgrst, 'reload schema';
