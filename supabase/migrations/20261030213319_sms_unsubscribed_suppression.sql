-- #350: an SMS the provider refuses because the recipient opted out of this org's sender is a
-- per-org stop, not a platform-wide bounce.
-- redefines api.report_outbox_result from 20261030211700_cost_ledger.sql
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
  'cost_source estimate; a quoted cost is marked provider. A retryable '
  'failure is retried after 30 s, doubling each time; the sixth failed attempt, a non-retryable '
  'failure or gone marks it dead; gone for a push row also deletes its subscription, and for '
  'email or SMS suppresses the address (reason complaint when error_code is complaint, else bounce; unsubscribed is an org-only stop). '
  'suppressed with error_code quiet_hours is retried in 15 '
  'minutes. Reports for rows no longer claimed are ignored. Raises invalid_input, not_found. '
  'Implemented in N3 (#69); cost in 3-PV4 (#343).';
