-- B1 (#1233): the monthly SMS bundle ("$10 a month, about 500 texts"). When Stripe says the bundle's invoice
-- is paid, a fixed amount of credit goes into the same prepaid ledger the top-ups use, so there is no second
-- quota to keep in step and multi-segment texts simply spend more of it. Credit rolls over and is never taken
-- back; a cancelled or never-paid subscription gets no further grants because no invoice is paid.
--
-- Interface choice: (a) a new service-role RPC api.apply_bundle_grant, (b) a new event type inside
-- api.apply_billing_event. (a) won: (b) would change a fixed signature (it needs an invoice id for
-- idempotency) and would put the subscription's last_event_at ordering in the way, which a grant must not
-- depend on. The RPC is not reachable by anon or authenticated users.
--
-- The amount is a deployment setting, not a parameter: the billing function only says which invoice was paid.
-- 6.00 USD is about 500 one-segment texts at 1.2 cents and is a placeholder until the real Twilio rate is known.

alter table app.platform_flags
  add column sms_bundle_grant_micros bigint not null default 6000000
    check (sms_bundle_grant_micros between 0 and 1000000000);

alter table app.credit_ledger drop constraint credit_ledger_entry_type_check;
alter table app.credit_ledger add constraint credit_ledger_entry_type_check
  check (entry_type in ('topup', 'debit', 'adjustment', 'addon_allowance'));
alter table app.credit_ledger add constraint credit_ledger_grant_shape
  check (entry_type <> 'addon_allowance' or (amount_micros > 0 and stripe_ref is not null));
-- the Stripe invoice that paid the grant: one grant per invoice
create unique index credit_ledger_one_grant on app.credit_ledger (stripe_ref) where entry_type = 'addon_allowance';

create function api.apply_bundle_grant(p_invoice_id text, p_subscription_id text, p_created timestamptz)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.subscriptions;
  v_amount bigint;
begin
  if p_invoice_id is null or length(p_invoice_id) not between 1 and 200
     or p_subscription_id is null or length(p_subscription_id) not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  select * into s from app.subscriptions x where x.stripe_subscription_id = p_subscription_id;
  if not found then return 'unknown_subscription'; end if;
  -- Paid invoices after a cancellation (or on a subscription that never went live) grant nothing. past_due is
  -- allowed: a paid invoice there is the retry that succeeded, and Stripe's status event may trail it.
  if s.status not in ('active', 'trialing', 'past_due') then return 'ignored'; end if;
  select f.sms_bundle_grant_micros into v_amount from app.platform_flags f;
  if coalesce(v_amount, 0) <= 0 then return 'ignored'; end if;
  insert into app.credit_ledger (org_id, entry_type, amount_micros, stripe_ref)
  values (s.org_id, 'addon_allowance', v_amount, p_invoice_id)
  on conflict (stripe_ref) where entry_type = 'addon_allowance' do nothing;
  return case when found then 'applied' else 'duplicate' end;
end $$;
comment on function api.apply_bundle_grant(text, text, timestamptz) is
  'Service role only (billing function, after the Stripe signature check and only for an invoice that carries the '
  'SMS bundle price): credits app.platform_flags.sms_bundle_grant_micros to the SMS credit ledger of the org that '
  'owns the subscription, once per invoice. Returns applied, duplicate (the invoice was already credited: nothing '
  'changes), ignored (the subscription is cancelled, unpaid or incomplete, or the grant is set to zero) or '
  'unknown_subscription. Credit already granted is never taken back. Raises invalid_input.';
revoke all on function api.apply_bundle_grant(text, text, timestamptz) from public, anon, authenticated;
grant execute on function api.apply_bundle_grant(text, text, timestamptz) to service_role;

notify pgrst, 'reload schema';
