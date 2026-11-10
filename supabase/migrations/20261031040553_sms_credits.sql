-- 4-BILL4 (#380): hosted SMS credits at cost plus a transparent margin, for orgs that send through the
-- platform's own messaging account (provider mode platform) while billing is on. Prepaid only: no
-- auto-refill. An append-only ledger holds top-ups (positive) and debits (negative, cost and margin shown
-- separately); the balance is its sum. api.reserve_send refuses a send at or below zero
-- (insufficient_credit), and api.report_outbox_result debits the sent message from its actual cost.
-- All amounts are micros of one currency (USD); a message priced in another currency is debited at face value.

alter table app.platform_flags
  add column sms_margin_bps int not null default 1000 check (sms_margin_bps between 0 and 100000),
  add column credit_low_micros bigint not null default 5000000 check (credit_low_micros >= 0);

create table app.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  entry_type text not null check (entry_type in ('topup', 'debit', 'adjustment')),
  -- signed effect on the balance: top-ups add, debits and adjustments follow cost + margin
  amount_micros bigint not null,
  cost_micros bigint not null default 0,
  margin_micros bigint not null default 0,
  -- not a foreign key: the message log is purged by retention, the ledger is not
  notification_id uuid,
  -- the Stripe Checkout session that paid a top-up
  stripe_ref text check (length(stripe_ref) between 1 and 200),
  created_at timestamptz not null default now(),
  check (entry_type <> 'topup' or (amount_micros > 0 and stripe_ref is not null))
);
create unique index credit_ledger_one_topup on app.credit_ledger (stripe_ref) where entry_type = 'topup';
create unique index credit_ledger_one_debit on app.credit_ledger (notification_id) where entry_type = 'debit';
create index credit_ledger_org_idx on app.credit_ledger (org_id, created_at);

-- append-only (an org deletion still cascades)
create function private.forbid_ledger_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from app.organizations where id = old.org_id) then
    return old;
  end if;
  raise exception 'ledger_append_only';
end $$;
revoke all on function private.forbid_ledger_change() from public, anon, authenticated;
create trigger append_only before update or delete on app.credit_ledger
  for each row execute function private.forbid_ledger_change();

alter table app.credit_ledger enable row level security;
create policy credit_ledger_select on app.credit_ledger for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
revoke all on app.credit_ledger from public, anon, authenticated;
grant select on app.credit_ledger to authenticated;
grant select on app.credit_ledger to service_role; -- rows are appended only by the definer functions below

create view app.credit_balance with (security_invoker = true) as
  select l.org_id, sum(l.amount_micros)::bigint as balance_micros from app.credit_ledger l group by l.org_id;
revoke all on app.credit_balance from public, anon, authenticated;
grant select on app.credit_balance to authenticated;

create function private.credit_balance(p_org_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.amount_micros), 0)::bigint from app.credit_ledger l where l.org_id = p_org_id
$$;
revoke all on function private.credit_balance(uuid) from public, anon, authenticated;

-- True when this paid channel spends prepaid credit: billing is on and the org uses the platform account.
create function private.uses_platform_credit(p_org_id uuid, p_channel text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_channel in ('sms', 'whatsapp') and private.billing_enabled() and exists (
    select 1 from app.provider_settings s where s.org_id = p_org_id and s.channel = p_channel and s.mode = 'platform')
$$;
revoke all on function private.uses_platform_credit(uuid, text) from public, anon, authenticated;

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low'));
insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('credit_low', 'email', 'transactional', '{org}: SMS credit is running low',
   '{org} has {balance} of SMS credit left. At zero, text messages are skipped until you add credit under Billing '
   'in your admin console (/admin/billing). Credit is never topped up automatically.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

-- Emails owners and admins once per UTC day while the balance is under the deployment's threshold.
create function private.check_credit_low(p_org_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $fn$
declare
  v_balance bigint := private.credit_balance(p_org_id);
begin
  if v_balance >= (select f.credit_low_micros from app.platform_flags f) then return; end if;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_org_id, null, 'email', m.user_id, 'credit_low', t.version, t.category,
         jsonb_build_object('org', o.name, 'balance', to_char(greatest(v_balance, 0) / 1000000.0, 'FM$999,999,990.00')),
         concat_ws(':', 'credit_low', p_org_id, (now() at time zone 'UTC')::date, m.user_id)
  from app.memberships m
  join auth.users u on u.id = m.user_id and u.email is not null
  join app.organizations o on o.id = m.org_id
  cross join lateral private.resolve_template(p_org_id, null, 'credit_low', 'email', o.default_locale) t
  where m.org_id = p_org_id and m.role in ('owner', 'admin') and m.notify_usage_alerts
  on conflict (dedupe_key) do nothing;
end $fn$;
revoke all on function private.check_credit_low(uuid) from public, anon, authenticated;

create function private.credit_margin(p_cost bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select round(p_cost * (select f.sms_margin_bps from app.platform_flags f) / 10000.0)::bigint
$$;
revoke all on function private.credit_margin(bigint) from public, anon, authenticated;

-- One debit per message (a repeat is a no-op); cost and margin are recorded apart.
create function private.debit_credit(p_notification_id uuid, p_org_id uuid, p_cost bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_margin bigint := private.credit_margin(p_cost);
begin
  if p_cost is null or p_cost < 0 then return; end if; -- a debit never adds credit
  insert into app.credit_ledger (org_id, entry_type, amount_micros, cost_micros, margin_micros, notification_id)
  values (p_org_id, 'debit', -(p_cost + v_margin), p_cost, v_margin, p_notification_id)
  on conflict (notification_id) where entry_type = 'debit' do nothing;
  if found then perform private.check_credit_low(p_org_id); end if;
end $$;
revoke all on function private.debit_credit(uuid, uuid, bigint) from public, anon, authenticated;

-- Adds a top-up once per Checkout session: Stripe retries and replays never credit twice.
create function api.apply_credit_topup(p_session_id text, p_org_id uuid, p_amount_minor bigint, p_currency text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_session_id is null or length(p_session_id) not between 1 and 200 then raise exception 'invalid_input'; end if;
  if lower(coalesce(p_currency, '')) <> 'usd' or p_amount_minor is null or p_amount_minor not between 100 and 1000000 then
    return 'ignored';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then return 'unknown_org'; end if;
  insert into app.credit_ledger (org_id, entry_type, amount_micros, stripe_ref)
  values (p_org_id, 'topup', p_amount_minor * 10000, p_session_id)
  on conflict (stripe_ref) where entry_type = 'topup' do nothing;
  return case when found then 'applied' else 'duplicate' end;
end $$;
comment on function api.apply_credit_topup(text, uuid, bigint, text) is
  'Service role only (billing function, after the Stripe signature check): credits a paid Checkout session to '
  'the org''s SMS credit ledger. USD only, 1.00 to 10,000.00. Returns applied, duplicate (the session was '
  'already credited: nothing changes), ignored (unsupported amount or currency) or unknown_org. Raises invalid_input.';
revoke all on function api.apply_credit_topup(text, uuid, bigint, text) from public, anon, authenticated;
grant execute on function api.apply_credit_topup(text, uuid, bigint, text) to service_role;

-- A provider's final price replaces the estimate: the difference (and its margin) is booked as an adjustment.
-- redefines api.apply_provider_price from 20261030215521_delivery_status_price_reconcile.sql
create or replace function api.apply_provider_price(p_org_id uuid, p_notification_id uuid, p_price numeric, p_currency text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old bigint;
  v_new bigint;
  v_delta bigint;
  v_margin bigint;
begin
  select n.cost_micros into v_old from app.notifications n
  where n.id = p_notification_id and n.org_id = p_org_id and n.cost_source = 'estimate' for update;
  if not found then return; end if;
  update app.notifications n set
    price_checked_at = now(),
    cost_micros = case when p_price is null then n.cost_micros else round(abs(p_price) * 1000000)::bigint end,
    currency = case when p_price is null then n.currency else upper(left(coalesce(p_currency, n.currency), 3)) end,
    cost_source = case when p_price is null then n.cost_source else 'provider' end
  where n.id = p_notification_id and n.org_id = p_org_id
  returning n.cost_micros into v_new;
  v_delta := coalesce(v_new, 0) - coalesce(v_old, 0);
  if v_delta <> 0 and exists (
    select 1 from app.credit_ledger l where l.notification_id = p_notification_id and l.entry_type = 'debit') then
    v_margin := private.credit_margin(abs(v_delta)) * sign(v_delta);
    insert into app.credit_ledger (org_id, entry_type, amount_micros, cost_micros, margin_micros, notification_id)
    values (p_org_id, 'adjustment', -(v_delta + v_margin), v_delta, v_margin, p_notification_id);
    perform private.check_credit_low(p_org_id);
  end if;
end $$;

-- redefines api.reserve_send from 20261030223945_usage_alerts.sql
create or replace function api.reserve_send(p_outbox_id uuid) returns api.send_reservation
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_limits app.channel_limits;
  v_cap int;
  v_countries text[];
  v_day date := (now() at time zone 'UTC')::date;
  v_sent int;
  v_spent bigint;
  v_threshold int;
begin
  select * into n from app.notifications where id = p_outbox_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into v_limits from app.channel_limits l where l.org_id = n.org_id and l.channel = n.channel;
  v_cap := coalesce(v_limits.daily_cap, 200);

  -- Serialise on the day's counter row: concurrent dispatchers queue here, so the cap is exact.
  insert into app.usage_counters (org_id, channel, day) values (n.org_id, n.channel, v_day)
  on conflict do nothing;
  select c.sent into v_sent from app.usage_counters c
  where c.org_id = n.org_id and c.channel = n.channel and c.day = v_day for update;

  select * into n from app.notifications where id = p_outbox_id;
  if n.reserved_at is not null then
    return row('allowed', v_sent, v_cap)::api.send_reservation;
  end if;

  -- Platform-mode orgs spend prepaid credit: no balance, no send (and nothing is counted).
  if private.uses_platform_credit(n.org_id, n.channel::text) and private.credit_balance(n.org_id) <= 0 then
    return row('insufficient_credit', v_sent, v_cap)::api.send_reservation;
  end if;
  -- An unknown country cannot be on the allowlist.
  select private.phone_countries(c.value) into v_countries
  from app.guest_contacts c where c.id = n.recipient_ref and c.org_id = n.org_id;
  if v_countries is null or not (v_countries && coalesce(v_limits.country_allowlist, '{}')) then
    return row('country_blocked', v_sent, v_cap)::api.send_reservation;
  end if;
  if v_sent >= v_cap then
    return row('cap_reached', v_sent, v_cap)::api.send_reservation;
  end if;
  if v_limits.monthly_budget_micros is not null then
    select coalesce(sum(s.cost_micros), 0) into v_spent from app.notifications s
    where s.org_id = n.org_id and s.channel = n.channel and s.status = 'sent'
      and s.sent_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
    if v_spent >= v_limits.monthly_budget_micros then
      return row('budget_reached', v_sent, v_cap)::api.send_reservation;
    end if;
  end if;

  update app.usage_counters set sent = sent + 1
  where org_id = n.org_id and channel = n.channel and day = v_day;
  update app.notifications set reserved_at = now() where id = n.id;
  -- One alert per threshold, channel and UTC day: the first send that reaches 80% and the one that reaches 100%.
  foreach v_threshold in array array[80, 100] loop
    if v_cap > 0 and (v_sent + 1) * 100 >= v_threshold * v_cap then
      insert into app.usage_alerts (org_id, channel, day, threshold) values (n.org_id, n.channel, v_day, v_threshold)
      on conflict do nothing;
      if found then
        perform private.enqueue_usage_alert(n.org_id, n.channel, v_day, v_threshold, v_sent + 1, v_cap);
      end if;
    end if;
  end loop;
  return row('allowed', v_sent + 1, v_cap)::api.send_reservation;
end $$;
comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked, budget_reached or '
  'insufficient_credit (a platform-mode org with no prepaid credit left) for one paid send and counts it '
  'when allowed. Credit is debited when the send is reported, so a burst already in flight can overdraw by '
  'the messages of one dispatch batch.';

-- redefines api.report_outbox_result from 20261030213319_sms_unsubscribed_suppression.sql
create or replace function api.report_outbox_result(p_outbox_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_status text := p_result ->> 'status';
  v_code text := left(p_result ->> 'error_code', 100);
  v_provider text;
  v_segments int := (p_result ->> 'segments')::int;
  v_cost bigint := (p_result ->> 'cost_micros')::bigint;
  v_source text;
  v_currency char(3);
  v_rate app.provider_rates;
begin
  if v_status is null or v_status not in ('sent', 'failed', 'suppressed', 'gone') then
    raise exception 'invalid_input';
  end if;
  select * into n from app.notifications where id = p_outbox_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- A report for a row this dispatcher no longer holds (its lease expired) changes nothing.
  if n.status <> 'claimed' then
    return;
  end if;

  v_provider := coalesce(left(p_result ->> 'provider', 50), n.provider);
  if v_status = 'sent' then
    if v_cost is not null then
      v_source := 'provider';
      v_currency := coalesce(left(p_result ->> 'currency', 3), 'USD');
    elsif n.channel in ('sms', 'whatsapp') then
      -- The provider quoted no price: estimate from the rate table and reconcile later (3-SMS2).
      v_rate := private.message_rate(n.org_id, v_provider, n.channel,
        (select c.country_code from app.guest_contacts c where c.id = n.recipient_ref and c.org_id = n.org_id));
      if v_rate.id is not null then
        v_segments := coalesce(v_segments, 1);
        v_cost := v_segments * v_rate.micros_per_unit;
        v_currency := v_rate.currency;
        v_source := 'estimate';
      end if;
    end if;
  end if;

  update app.notifications set
    status = case
      when v_status = 'sent' then 'sent'
      when v_status = 'suppressed' and v_code = 'quiet_hours' then 'queued'
      when v_status = 'suppressed' then 'suppressed'
      when v_status = 'failed' and coalesce((p_result ->> 'retryable')::boolean, false)
           and n.attempts + 1 < private.outbox_max_attempts() then 'failed'
      else 'dead'
    end::app.notification_status,
    attempts = n.attempts + case when v_status in ('failed', 'gone') then 1 else 0 end,
    -- 30 s, 1, 2, 4, 8 min; quiet hours look again every 15 min until the window opens.
    next_attempt_at = case
      when v_status = 'failed' then now() + interval '30 seconds' * power(2, n.attempts)
      when v_code = 'quiet_hours' then now() + interval '15 minutes'
      else n.next_attempt_at
    end,
    quiet_hours_deferred = n.quiet_hours_deferred or v_code is not distinct from 'quiet_hours',
    locked_until = null,
    provider = v_provider,
    provider_message_id = left(p_result ->> 'provider_message_id', 200),
    error_code = case when v_status = 'gone' then coalesce(v_code, 'gone') else v_code end,
    segments = v_segments,
    cost_micros = v_cost,
    currency = coalesce(v_currency, n.currency),
    cost_source = v_source,
    sent_at = case when v_status = 'sent' then now() else n.sent_at end
  where id = n.id;

    -- A send nobody priced (no rate row, no quoted cost) is debited at a flat 0.01 per segment, never free.
  if v_status = 'sent' and private.uses_platform_credit(n.org_id, n.channel::text) then
    perform private.debit_credit(n.id, n.org_id, coalesce(v_cost, 10000 * coalesce(v_segments, 1)));
  end if;

  -- A push service that answers 404/410 has dropped the subscription for good.
  if v_status = 'gone' and n.channel = 'push' then
    delete from app.push_subscriptions s where s.id = n.recipient_ref and s.org_id = n.org_id;
  end if;
  -- An email or SMS that is gone bounced hard, or the recipient complained (error_code
  -- complaint); claim_outbox honours both in every org. error_code unsubscribed (the guest opted out
  -- of this org's sender, e.g. Twilio 21610) is a per-org stop: it must not block other orgs.
  if v_status = 'gone' and n.channel <> 'push' then
    insert into app.suppressions (org_id, channel, value, reason)
    select n.org_id, n.channel, a.value, case v_code when 'complaint' then 'complaint' when 'unsubscribed' then 'stop' else 'bounce' end
    from (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
    where a.value is not null
    on conflict (org_id, channel, value) do nothing;
  end if;
end $$;
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros, currency} for a row the caller has claimed. A sent '
  'SMS or WhatsApp with no cost_micros is priced at segments (default 1) x the provider rate and marked '
  'cost_source estimate; a quoted cost is marked provider; in platform mode with billing on the cost plus '
  'margin is debited from the org''s credit. A retryable failure is retried after 30 s, doubling each time; '
  'the sixth failed attempt, a non-retryable failure or gone marks it dead; gone for a push row also deletes '
  'its subscription, and for email or SMS suppresses the address (reason complaint when error_code is '
  'complaint, else bounce; unsubscribed is an org-only stop). suppressed with error_code quiet_hours is '
  'retried in 15 minutes. Reports for rows no longer claimed are ignored. Raises invalid_input, not_found.';

notify pgrst, 'reload schema';
