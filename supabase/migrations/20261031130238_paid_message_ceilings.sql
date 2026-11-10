-- Paid-message ceilings (#398 decision, batch 1): an operator-controlled upper bound on what any org can
-- send on SMS and WhatsApp, applied inside api.reserve_send. channel_limits is writable by org admins, so
-- an org's own cap and budget can only lower the ceiling, never raise it. Ceilings are entitlements, so
-- they change only through api.platform_set_entitlement (operator, aal2, audited) or a plan default.
-- A new org (younger than messaging.new_org_days) gets the lower messaging.new_org_daily_cap until an
-- operator raises it. The monthly budget is never unlimited.

insert into app.entitlement_defaults (key, value, description) values
  ('messaging.daily_cap', '200', 'Ceiling on paid messages (SMS, WhatsApp) per channel per UTC day; an org''s own limit can only be lower'),
  ('messaging.new_org_daily_cap', '25', 'Daily ceiling while the org is younger than messaging.new_org_days; raise per org to lift it early'),
  ('messaging.new_org_days', '14', 'Age in days under which messaging.new_org_daily_cap applies'),
  ('messaging.monthly_budget_micros', '20000000', 'Ceiling on paid-message spend per channel per UTC month in micros (20 USD); an org''s own budget can only be lower');

create function private.messaging_daily_ceiling(p_org_id uuid) returns int
language sql stable security definer set search_path = '' as $$
  select case
    when o.created_at > now() - make_interval(days => coalesce(nullif(private.entitlement(p_org_id, 'messaging.new_org_days') #>> '{}', '')::int, 14))
      then least(base.v, coalesce(nullif(private.entitlement(p_org_id, 'messaging.new_org_daily_cap') #>> '{}', '')::int, 25))
    else base.v end
  from app.organizations o,
       lateral (select greatest(coalesce(nullif(private.entitlement(p_org_id, 'messaging.daily_cap') #>> '{}', '')::int, 200), 0) as v) base
  where o.id = p_org_id
$$;
revoke all on function private.messaging_daily_ceiling(uuid) from public, anon, authenticated;
comment on function private.messaging_daily_ceiling(uuid) is
  'Most paid messages per channel per UTC day the org may send, whatever its channel_limits say: messaging.daily_cap, or the lower new-org cap while the org is young. Null for an unknown org.';

create function private.messaging_budget_ceiling(p_org_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select greatest(coalesce(nullif(private.entitlement(p_org_id, 'messaging.monthly_budget_micros') #>> '{}', '')::bigint, 20000000), 0)
$$;
revoke all on function private.messaging_budget_ceiling(uuid) from public, anon, authenticated;
comment on function private.messaging_budget_ceiling(uuid) is
  'Most paid-message spend per channel per UTC month in micros the org may reach, whatever its channel_limits say. Never null.';

-- redefines api.reserve_send from 20261031040553_sms_credits.sql
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
  v_budget bigint;
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
end $$;
comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked, budget_reached or '
  'insufficient_credit (a platform-mode org with no prepaid credit left) for one paid send and counts it '
  'when allowed. The daily cap and monthly budget are the lower of the org''s own channel_limits and the operator ceilings (messaging.* entitlements; young orgs get a lower daily ceiling). Credit is debited when the send is reported, so a burst already in flight can overdraw by '
  'the messages of one dispatch batch.';
