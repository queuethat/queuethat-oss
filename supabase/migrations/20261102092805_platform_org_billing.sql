-- #1131: the tenant billing panel for platform support. Two read-only functions:
--   api.platform_org_billing(org)  one tenant's plan, standing, limits, overrides and queued Stripe syncs
--   api.platform_billing_overview() the counts and attention list for the support queue (#1128)
-- Interface choice: (a) widen api.platform_get_org with a billing member, (b) a separate function.
-- (b) won: the org detail page keeps loading without billing, a billing failure cannot hide the
-- rest of the tenant, and api.platform_get_org (also changed by #1129) is left alone.
--
-- Both need a platform role of support or higher and an aal2 session, like every api.platform_*
-- read. No support grant is needed: this is plan and payment state, never guest data. Neither returns
-- card data, the Stripe subscription id or anything a webhook secret touches; the customer id is
-- the one Stripe identifier, for the "Open in Stripe" link. Limits are resolved by
-- private.entitlement, so the page never recomputes them.

create type api.platform_org_billing as (
  billing_enabled boolean,
  org_status app.org_status,
  has_subscription boolean,
  -- The plan on the subscription row, and the plan the org's entitlements actually come from now
  -- (free after cancellation or an expired grace period; null while billing is off).
  plan_id text,
  plan_name text,
  effective_plan text,
  billing_interval text,
  -- Stripe's subscription status: incomplete, incomplete_expired, trialing, active, past_due, unpaid,
  -- canceled or paused. Null without a subscription.
  status text,
  -- billing_off, no_subscription, good, grace (past_due, still on the paid plan) or free (the
  -- subscription does not currently earn its plan: canceled, unpaid, grace over, incomplete, paused).
  standing text,
  current_period_end timestamptz,
  -- Locations Stripe bills for, what the org's locations call for, and how many exist now.
  locations_billed int,
  locations_wanted int,
  locations_actual int,
  grace_ends_at timestamptz,
  -- Newest payment_failed email queued for this org's owners, and the reminder before the grace ends.
  last_payment_failed_at timestamptz,
  grace_reminder_at timestamptz,
  stripe_customer_id text,
  -- [{key, value, source: override|plan|default}] for every entitlement key, as the resolver returns it
  entitlements jsonb,
  -- [{key, value, reason, set_by_email, set_at}]: overrides operators set, newest first
  overrides jsonb,
  -- [{status, attempts, next_attempt_at, last_error, created_at}]: quantity syncs not done yet
  pending_jobs jsonb
);

create type api.platform_billing_overview as (
  billing_enabled boolean,
  past_due int,
  canceled_30d int,
  trials_ending_7d int,
  -- [{org_id, name, reason: past_due|canceled|trial_ending, at}]: soonest or most recent first, at most 100
  attention jsonb
);
grant usage on type api.platform_org_billing, api.platform_billing_overview to authenticated;

create function api.platform_org_billing(p_org_id uuid) returns api.platform_org_billing
language plpgsql stable security definer set search_path = '' as $$
declare
  o app.organizations;
  s app.subscriptions;
  r api.platform_org_billing;
begin
  perform private.require_platform('support');
  select * into o from app.organizations where id = p_org_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into s from app.subscriptions x where x.org_id = o.id;

  r.billing_enabled := private.billing_enabled();
  r.org_status := o.status;
  r.has_subscription := s.org_id is not null;
  r.effective_plan := private.org_plan(o.id);
  r.locations_actual := (select count(*)::int from app.locations l where l.org_id = o.id);
  if s.org_id is not null then
    r.plan_id := s.plan_id;
    r.plan_name := (select p.name from app.plans p where p.id = s.plan_id);
    r.billing_interval := s.billing_interval;
    r.status := s.status;
    r.current_period_end := s.current_period_end;
    r.locations_billed := s.quantity;
    r.locations_wanted := s.desired_quantity;
    r.grace_ends_at := s.grace_ends_at;
    r.stripe_customer_id := s.stripe_customer_id;
  end if;
  r.standing := case
    when not r.billing_enabled then 'billing_off'
    when s.org_id is null then 'no_subscription'
    when s.status = 'past_due' and s.grace_ends_at > now() then 'grace'
    when r.effective_plan = s.plan_id then 'good'
    else 'free' end;

  r.last_payment_failed_at := (
    select max(n.created_at) from app.notifications n
    where n.org_id = o.id and n.template_key = 'payment_failed');
  r.grace_reminder_at := (
    select max(n.created_at) from app.notifications n
    where n.org_id = o.id and n.template_key = 'payment_grace_ending');

  r.entitlements := coalesce((
    select jsonb_agg(jsonb_build_object(
             'key', d.key,
             'value', private.entitlement(o.id, d.key),
             'source', case
               when exists (select 1 from app.org_entitlements e where e.org_id = o.id and e.key = d.key) then 'override'
               when exists (select 1 from app.plan_entitlements pe
                            where pe.key = d.key and pe.plan_id = r.effective_plan) then 'plan'
               else 'default' end) order by d.key)
    from app.entitlement_defaults d), '[]');
  r.overrides := coalesce((
    select jsonb_agg(jsonb_build_object('key', e.key, 'value', e.value, 'reason', e.reason,
                                        'set_by_email', u.email, 'set_at', e.set_at)
                     order by e.set_at desc, e.key)
    from app.org_entitlements e left join auth.users u on u.id = e.set_by
    where e.org_id = o.id), '[]');
  r.pending_jobs := coalesce((
    select jsonb_agg(jsonb_build_object('status', j.status, 'attempts', j.attempts,
                                        'next_attempt_at', j.next_attempt_at, 'last_error', j.last_error,
                                        'created_at', j.created_at) order by j.created_at desc)
    from (select * from app.billing_jobs where org_id = o.id and status <> 'done'
          order by created_at desc limit 20) j), '[]');
  return r;
end $$;
comment on function api.platform_org_billing(uuid) is
  'Support or operator with aal2: one tenant''s billing state. Whether billing is on, the org''s '
  'status, its subscription (plan, interval, Stripe status, period end, locations billed, wanted '
  'and existing, grace end), its standing (billing_off, no_subscription, good, grace or free), the '
  'plan its entitlements come from now, every entitlement as the resolver returns it with its source, '
  'the overrides operators set (who, why, when), unfinished quantity-sync jobs and the Stripe '
  'customer id. An org with no subscription returns has_subscription false. No card data, no Stripe '
  'subscription id, no guest data; no support grant is needed. Raises permission_denied (42501) '
  'without a platform role and aal2, not_found for an unknown org.';

create function api.platform_billing_overview() returns api.platform_billing_overview
language plpgsql stable security definer set search_path = '' as $$
declare
  r api.platform_billing_overview;
begin
  perform private.require_platform('support');
  r.billing_enabled := private.billing_enabled();
  r.past_due := 0;
  r.canceled_30d := 0;
  r.trials_ending_7d := 0;
  r.attention := '[]';
  if not r.billing_enabled then
    return r;
  end if;
  select count(*) filter (where s.status = 'past_due')::int,
         count(*) filter (where s.status = 'canceled' and s.last_event_at > now() - interval '30 days')::int,
         count(*) filter (where s.status = 'trialing' and s.current_period_end > now()
                            and s.current_period_end <= now() + interval '7 days')::int
    into r.past_due, r.canceled_30d, r.trials_ending_7d
  from app.subscriptions s;
  r.attention := coalesce((
    select jsonb_agg(jsonb_build_object('org_id', a.org_id, 'name', a.name, 'reason', a.reason, 'at', a.at)
                     order by a.rank, a.at, a.org_id)
    from (select * from (
            select s.org_id, o.name,
                   case s.status when 'past_due' then 'past_due' when 'canceled' then 'canceled' else 'trial_ending' end as reason,
                   case s.status when 'past_due' then 0 when 'trialing' then 1 else 2 end as rank,
                   case s.status when 'past_due' then s.grace_ends_at when 'trialing' then s.current_period_end
                                 else s.last_event_at end as at
            from app.subscriptions s join app.organizations o on o.id = s.org_id
            where s.status = 'past_due'
               or (s.status = 'canceled' and s.last_event_at > now() - interval '30 days')
               or (s.status = 'trialing' and s.current_period_end > now()
                   and s.current_period_end <= now() + interval '7 days')) b
          order by b.rank, b.at, b.org_id limit 100) a), '[]');
  return r;
end $$;
comment on function api.platform_billing_overview() is
  'Support or operator with aal2: counts of past_due subscriptions, cancellations in the last 30 days '
  'and trials ending within 7 days, plus up to 100 of those orgs (past_due first, then trials by end, '
  'then cancellations) for the support attention queue. Counts and list are zero and empty while '
  'billing is off. Names and ids only; no payment or guest data. Raises permission_denied (42501) '
  'without a platform role and aal2.';

revoke all on function api.platform_org_billing(uuid), api.platform_billing_overview() from public, anon;
grant execute on function api.platform_org_billing(uuid), api.platform_billing_overview() to authenticated;

notify pgrst, 'reload schema';
