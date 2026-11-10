-- redefines api.apply_billing_event from 20261031030923_billing.sql
-- A failed payment only moves a live subscription, and a customer owned by another org is refused on every path.

create or replace function api.apply_billing_event(
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
