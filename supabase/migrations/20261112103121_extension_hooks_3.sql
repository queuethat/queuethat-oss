-- Extension hooks, part 3 (see supabase/README.md): the paid-send path. A deployment that runs a
-- shared sender refuses or charges sends through these; here they do nothing and the send path
-- behaves exactly as before.

create function private.ext_send_refusal(p_org_id uuid, p_channel text, p_reserved boolean) returns text
language sql stable set search_path = '' as $$ select null::text $$;
revoke execute on function private.ext_send_refusal(uuid, text, boolean) from public;
comment on function private.ext_send_refusal(uuid, text, boolean) is
  'Extension hook: a reason to refuse one paid send (SMS or WhatsApp) for p_org_id, or null to let '
  'api.reserve_send apply its own cap, country and budget checks. Called under the day''s counter '
  'lock, before anything is counted; p_reserved is true when the send was already reserved by an '
  'earlier attempt; refusing such a send does not give back the cap it already used. The reason '
  'becomes the reservation decision and the row''s error_code (suppressed): a snake_case code of at '
  'most 64 characters, other than quiet_hours, or it is stored as refused. The day''s lock is per '
  'org and channel, so a check shared across channels is the hook''s own to serialise. Returns null here.';

create function private.ext_send_reported(p_notification_id uuid, p_org_id uuid, p_channel text,
  p_status text, p_cost_micros bigint, p_segments int) returns void
language plpgsql volatile set search_path = '' as $$ begin null; end $$;
revoke execute on function private.ext_send_reported(uuid, uuid, text, text, bigint, int) from public;
comment on function private.ext_send_reported(uuid, uuid, text, text, bigint, int) is
  'Extension hook: called by api.report_outbox_result, in its transaction, once per dispatcher '
  'report on a claimed row, after the row is updated. p_status is the reported outcome (sent, '
  'failed, suppressed, gone). A row can be reported failed or suppressed more than once (retries, '
  'quiet hours) but sent at most once, so charge only on sent. p_cost_micros and p_segments are what '
  'was recorded and may be null. '
  'An error rolls the report back, so the row is reported again later: anything it records must be '
  'keyed by p_notification_id. Does nothing here.';

-- redefines api.reserve_send from 20261110171733_drop_hosted_schema.sql
create or replace function api.reserve_send(p_outbox_id uuid)
 RETURNS api.send_reservation
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n app.notifications;
  v_limits app.channel_limits;
  v_cap int;
  v_countries text[];
  v_day date := (now() at time zone 'UTC')::date;
  v_sent int;
  v_spent bigint;
  v_threshold int;
  v_budget bigint;
  v_refusal text;
begin
  select * into n from app.notifications where id = p_outbox_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into v_limits from app.channel_limits l where l.org_id = n.org_id and l.channel = n.channel;
  -- The operator ceiling bounds the org's own limit, which org admins can edit.
  v_cap := least(coalesce(v_limits.daily_cap, private.messaging_daily_ceiling(n.org_id)), private.messaging_daily_ceiling(n.org_id));

  -- Serialise on the day's counter row: concurrent dispatchers queue here, so the cap is exact.
  insert into app.usage_counters (org_id, channel, day) values (n.org_id, n.channel, v_day)
  on conflict do nothing;
  select c.sent into v_sent from app.usage_counters c
  where c.org_id = n.org_id and c.channel = n.channel and c.day = v_day for update;

  select * into n from app.notifications where id = p_outbox_id;
  -- A deployment that refuses sends of its own does so here (private.ext_send_refusal), before the
  -- already-reserved shortcut so a retried row cannot slip past it. Nothing is counted.
  v_refusal := private.ext_send_refusal(n.org_id, n.channel::text, n.reserved_at is not null);
  if v_refusal is not null and v_refusal <> 'allowed' then
    -- Stored as the row's error code: keep it a short code, and never one the outbox acts on.
    if v_refusal !~ '^[a-z][a-z0-9_]{0,63}$' or v_refusal = 'quiet_hours' then
      v_refusal := 'refused';
    end if;
    return row(v_refusal, v_sent, v_cap)::api.send_reservation;
  end if;
  if n.reserved_at is not null then
    return row('allowed', v_sent, v_cap)::api.send_reservation;
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
  v_budget := least(coalesce(v_limits.monthly_budget_micros, private.messaging_budget_ceiling(n.org_id)), private.messaging_budget_ceiling(n.org_id));
  select coalesce(sum(s.cost_micros), 0) into v_spent from app.notifications s
  where s.org_id = n.org_id and s.channel = n.channel and s.status = 'sent'
    and s.sent_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  if v_spent >= v_budget then
    return row('budget_reached', v_sent, v_cap)::api.send_reservation;
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
end $function$;

-- redefines api.report_outbox_result from 20261110171733_drop_hosted_schema.sql
create or replace function api.report_outbox_result(p_outbox_id uuid, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- What the deployment does with a finished send (private.ext_send_reported), such as charging for it.
  perform private.ext_send_reported(n.id, n.org_id, n.channel::text, v_status, v_cost, v_segments);

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
end $function$;

comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked or budget_reached '
  'for one paid send and counts it when allowed, or returns the deployment''s own refusal from '
  'private.ext_send_refusal (none here) without counting. The daily cap and monthly budget are the '
  'lower of the org''s own channel_limits and the deployment ceilings (messaging.* entitlements; '
  'young orgs get a lower daily ceiling).';
