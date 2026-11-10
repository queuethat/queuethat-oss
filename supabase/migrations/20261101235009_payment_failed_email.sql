-- redefines api.apply_billing_event from 20261101220204_billing_annual_pricing.sql
-- #1083: owners hear about a failed payment. Interface choice: (a) a new trigger inside the existing billing
-- event function plus a cron sweep for the day-10 reminder, (b) a new RPC the billing function calls after
-- the event. (a) won: the state change and the email commit together, so a retried webhook cannot lose or
-- double the mail, and the Stripe-facing interface stays the same.
--
-- Both emails are account mail (no visit, recipient_ref = the owner's auth user id) sent by the dispatcher
-- like any outbox row (I-11). Nothing a guest typed reaches a recipient or the content: the variables are
-- the org name and the grace end date.

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('payment_failed', 'email', 'transactional', '{org}: your QueueThat payment failed',
   'We could not charge the card for {org}''s QueueThat subscription. Your paid features stay on until {grace_end}; '
   'after that {org} moves to the free plan. Your data is never deleted. '
   'Update your payment method under Billing in your admin console (/admin/billing).'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('payment_grace_ending', 'email', 'transactional', '{org}: update your payment method by {grace_end}',
   'The payment for {org}''s QueueThat subscription is still failing. Your paid features end on {grace_end}, '
   'after which {org} moves to the free plan. Your data is never deleted. '
   'Update your payment method under Billing in your admin console (/admin/billing).'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

-- Emails the owners of p_org_id (p_template: payment_failed or payment_grace_ending) while it is past_due.
-- Idempotent per owner, template and grace period, so one failure is one email and a later failure is another.
create function private.enqueue_payment_email(p_org_id uuid, p_template text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.subscriptions;
begin
  if not private.billing_enabled() then return; end if;
  select * into s from app.subscriptions x where x.org_id = p_org_id;
  if not found or s.status <> 'past_due' or s.grace_ends_at is null then return; end if;
  perform private.enqueue_account_email(
    p_org_id, p_template,
    jsonb_build_object(
      'org', (select o.name from app.organizations o where o.id = p_org_id),
      'grace_end', to_char(s.grace_ends_at at time zone 'UTC', 'FMMonth FMDD, YYYY') || ' UTC'),
    concat_ws(':', p_template, p_org_id, extract(epoch from s.grace_ends_at)::bigint));
end $$;
comment on function private.enqueue_payment_email(uuid, text) is
  'Queues payment_failed or payment_grace_ending by email to every owner of a past_due org while billing is on. '
  'Idempotent per owner, template and grace period. Called by api.apply_billing_event and ops.send_payment_grace_reminders only.';
revoke all on function private.enqueue_payment_email(uuid, text) from public, anon, authenticated;

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
  -- the first failure of a billing cycle tells the owners; repeats of it do not
  if v_status = 'past_due' and s.status is distinct from 'past_due' then
    perform private.enqueue_payment_email(s.org_id, 'payment_failed');
  end if;
  return 'applied';
end $$;
comment on function api.apply_billing_event(text, timestamptz, uuid, text, text, text, text, int, timestamptz) is
  'Service role only (billing function, after the Stripe signature check): applies one subscription '
  'event (subscription = created or updated, deleted, payment_failed) in Stripe''s order; older events '
  'than the newest applied are ignored, repeats change nothing. A payment failure sets past_due with a '
  'grace period of 14 days; data is never deleted, and the first move to past_due emails the org''s owners once (payment_failed). Returns applied, ignored, org_mismatch (metadata or '
  'customer belongs to another org: nothing written) or unknown_subscription. Raises invalid_input.';
revoke all on function api.apply_billing_event(text, timestamptz, uuid, text, text, text, text, int, timestamptz)
  from public, anon, authenticated;
grant execute on function api.apply_billing_event(text, timestamptz, uuid, text, text, text, text, int, timestamptz)
  to service_role;

-- Day 10 of the 14-day grace period (four days left): one reminder per grace period. Returns the emails queued.
create function ops.send_payment_grace_reminders() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
  v_rows int;
begin
  if not private.billing_enabled() then return 0; end if;
  for r in
    select s.org_id from app.subscriptions s
    where s.status = 'past_due' and s.grace_ends_at > now() and s.grace_ends_at <= now() + interval '4 days'
  loop
    -- enqueue_account_email returns void, so count the rows this call added through the dedupe key
    select count(*) into v_rows from app.notifications x
    where x.org_id = r.org_id and x.template_key = 'payment_grace_ending';
    perform private.enqueue_payment_email(r.org_id, 'payment_grace_ending');
    n := n + (select count(*) from app.notifications x
              where x.org_id = r.org_id and x.template_key = 'payment_grace_ending') - v_rows;
  end loop;
  return n;
end $$;
comment on function ops.send_payment_grace_reminders() is
  'Cron only: while billing is on, emails the owners of every org with four days or less of grace left, once per '
  'grace period. Returns how many emails it queued; repeat runs return 0.';
revoke all on function ops.send_payment_grace_reminders() from public, anon, authenticated;
select cron.schedule('payment-grace-reminders', '17 * * * *', 'select ops.send_payment_grace_reminders()');

notify pgrst, 'reload schema';
