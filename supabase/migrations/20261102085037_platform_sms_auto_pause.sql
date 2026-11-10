-- #1155: auto-pause a business's platform SMS when its STOP, undelivered or filtered rate spikes.
-- Every business sends through one shared toll-free number, so one business's bad traffic can get the number
-- filtered for all. Every 5 minutes each platform-mode SMS org is scored over its last 24 hours; with at least
-- 30 messages sent it is paused when STOP replies >= 3%, carrier-filtered (Twilio 30007) >= 5% or
-- undelivered/failed >= 25% of sent (unreachable handsets 30003/30005/30006 do not count: the guest's phone, not the
-- business's content). A pause only lifts by an operator (api.platform_set_sms_pause); an operator resume also
-- stops the job re-pausing the business for 24 hours.
-- Alternative considered: checking in claim_outbox instead of reserve_send (a second redefinition of a large
-- function for the same effect: platform SMS is paid, so it already passes reserve_send).

create table private.platform_sms_pauses (
  org_id uuid primary key references app.organizations (id) on delete cascade,
  -- auto: paused by the job; manual: paused by an operator; resumed: an operator lifted a pause
  state text not null check (state in ('auto', 'manual', 'resumed')),
  reason text,
  stats jsonb not null default '{}',
  set_at timestamptz not null default now(),
  set_by uuid
);
revoke all on private.platform_sms_pauses from public, anon, authenticated;

-- A STOP to the shared number carries no org: it counts against the one business that last texted that number.
create table private.platform_sms_stops (
  org_id uuid not null,
  phone text not null,
  at timestamptz not null default now()
);
create index platform_sms_stops_org_idx on private.platform_sms_stops (org_id, at);
revoke all on private.platform_sms_stops from public, anon, authenticated;

create function private.platform_sms_paused(p_org_id uuid, p_channel text) returns boolean
language sql stable set search_path = '' as $$
  select p_channel = 'sms' and exists (select 1 from private.platform_sms_pauses p
                                       where p.org_id = p_org_id and p.state in ('auto', 'manual'))
$$;
revoke all on function private.platform_sms_paused(uuid, text) from public, anon, authenticated;
comment on function private.platform_sms_paused(uuid, text) is
  'True when the org''s SMS is paused (automatically or by an operator).';

create function private.platform_sms_stats(p_org_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'sent', count(*) filter (where n.status = 'sent'),
    'filtered', count(*) filter (where n.status = 'sent' and n.error_code = 'twilio_30007'),
    'undelivered', count(*) filter (where n.status = 'sent' and n.delivery_status in ('undelivered', 'failed')
                                     and coalesce(n.error_code, '') not in ('twilio_30007', 'twilio_30003', 'twilio_30005', 'twilio_30006')),
    'stops', (select count(distinct s.phone) from private.platform_sms_stops s where s.org_id = p_org_id and s.at > now() - interval '24 hours'))
  from app.notifications n
  where n.org_id = p_org_id and n.channel = 'sms' and n.provider = 'twilio' and n.sent_at > now() - interval '24 hours'
$$;
revoke all on function private.platform_sms_stats(uuid) from public, anon, authenticated;

create function private.platform_sms_breach(p_stats jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when (p_stats ->> 'sent')::int < 30 then null
    -- distinct phones, and never fewer than 3: one or two burner numbers cannot pause a small business
    when (p_stats ->> 'stops')::numeric >= greatest(3, 0.03 * (p_stats ->> 'sent')::numeric) then 'stop_rate'
    when (p_stats ->> 'filtered')::numeric >= 0.05 * (p_stats ->> 'sent')::numeric then 'filtered_rate'
    when (p_stats ->> 'undelivered')::numeric >= 0.25 * (p_stats ->> 'sent')::numeric then 'undelivered_rate'
  end
$$;
revoke all on function private.platform_sms_breach(jsonb) from public, anon, authenticated;
comment on function private.platform_sms_breach(jsonb) is
  'The threshold a 24 h window breaches (stop_rate 3%, filtered_rate 5%, undelivered_rate 25%, each of sent, with at least 30 sent), else null.';

create function ops.pause_unhealthy_platform_sms() returns int
language plpgsql volatile set search_path = '' as $$
declare
  o record;
  v_stats jsonb;
  v_why text;
  v_count int := 0;
begin
  for o in
    select s.org_id from app.provider_settings s
    where s.channel = 'sms' and s.mode = 'platform' and s.enabled
      and not exists (select 1 from private.platform_sms_pauses p
                      where p.org_id = s.org_id and (p.state in ('auto', 'manual') or p.set_at > now() - interval '24 hours'))
  loop
    v_stats := private.platform_sms_stats(o.org_id);
    v_why := private.platform_sms_breach(v_stats);
    if v_why is not null then
      insert into private.platform_sms_pauses (org_id, state, reason, stats)
      values (o.org_id, 'auto', v_why, v_stats)
      on conflict (org_id) do update set state = 'auto', reason = excluded.reason, stats = excluded.stats, set_at = now(), set_by = null;
      perform private.platform_audit('sms.auto_pause', o.org_id, v_stats || jsonb_build_object('breach', v_why), v_why);
      v_count := v_count + 1;
    end if;
  end loop;
  delete from private.platform_sms_stops where at < now() - interval '3 days';
  return v_count;
end $$;
revoke all on function ops.pause_unhealthy_platform_sms() from public, anon, authenticated;
comment on function ops.pause_unhealthy_platform_sms() is
  'Cron, every 5 minutes: pauses platform-mode SMS orgs over a threshold (private.platform_sms_breach) and audits it. Returns how many it paused.';
select cron.schedule('pause-unhealthy-platform-sms', '*/5 * * * *', 'select ops.pause_unhealthy_platform_sms()');

create function api.platform_sms_health(p_org_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;
  return coalesce((select to_jsonb(p) - 'org_id' from private.platform_sms_pauses p where p.org_id = p_org_id), '{}'::jsonb)
         || jsonb_build_object('stats_24h', private.platform_sms_stats(p_org_id),
                               'platform_mode', exists (select 1 from app.provider_settings s
                                                        where s.org_id = p_org_id and s.channel = 'sms' and s.mode = 'platform'));
end $$;
revoke all on function api.platform_sms_health(uuid) from public, anon;
grant execute on function api.platform_sms_health(uuid) to authenticated;
comment on function api.platform_sms_health(uuid) is
  'Support or operator with aal2: the org''s platform SMS state (state auto|manual|resumed when a pause row exists, reason, set_at), its last-24h stats {sent, filtered, undelivered, stops} and platform_mode. Raises permission_denied (42501), not_found.';

create function api.platform_set_sms_pause(p_org_id uuid, p_pause boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  if p_pause is null or length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;
  insert into private.platform_sms_pauses (org_id, state, reason, stats, set_by)
  values (p_org_id, case when p_pause then 'manual' else 'resumed' end, btrim(p_reason),
          private.platform_sms_stats(p_org_id), (select auth.uid()))
  on conflict (org_id) do update set state = excluded.state, reason = excluded.reason, stats = excluded.stats,
    set_at = now(), set_by = excluded.set_by;
  perform private.platform_audit(case when p_pause then 'sms.pause' else 'sms.resume' end, p_org_id, '{}', btrim(p_reason));
  return api.platform_sms_health(p_org_id);
end $$;
revoke all on function api.platform_set_sms_pause(uuid, boolean, text) from public, anon;
grant execute on function api.platform_set_sms_pause(uuid, boolean, text) to authenticated;
comment on function api.platform_set_sms_pause(uuid, boolean, text) is
  'Operator with aal2: pauses (true) or resumes (false) the org''s platform SMS with a required reason, audited. A resume also keeps the automatic job from re-pausing the org for 24 hours. Returns api.platform_sms_health. Raises permission_denied (42501), invalid_input, not_found.';

-- redefines api.reserve_send from 20261031130238_paid_message_ceilings.sql
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
  -- A business whose texts drew STOPs, carrier filtering or failures is paused (private.platform_sms_paused):
  -- one business must not cost the shared sender its standing for the rest. Nothing is counted.
  if private.platform_sms_paused(n.org_id, n.channel::text) then
    return row('paused', v_sent, v_cap)::api.send_reservation;
  end if;
  -- (checked before the already-reserved shortcut so a retried or queued row cannot slip past a pause)

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

-- redefines api.apply_platform_sms_event from 20261101223126_platform_sms_events.sql
create or replace function api.apply_platform_sms_event(p_kind text, p_phone text default null, p_provider_message_id text default null,
                                             p_status text default null, p_error_code text default null) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if p_kind = 'status' then
    if coalesce(p_provider_message_id, '') = '' or coalesce(p_status, '') = '' then raise exception 'invalid_input'; end if;
    -- only a message sent through a platform-mode org can be reported on this route
    select n.org_id into v_org from app.notifications n
    join app.provider_settings s on s.org_id = n.org_id and s.channel = 'sms' and s.mode = 'platform'
    where n.provider = 'twilio' and n.provider_message_id = left(p_provider_message_id, 200) and n.channel = 'sms'
    limit 1;
    if v_org is null then return false; end if;
    return api.apply_delivery_status(v_org, 'twilio', p_provider_message_id, p_status, p_error_code);
  elsif p_kind in ('stop', 'start') then
    if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_input'; end if;
    if p_kind = 'stop' then
      -- A STOP answers the last text this sender sent that number: it counts against that one business only
      -- (not every business that texted the number lately), so one number cannot blame several tenants.
      insert into private.platform_sms_stops (org_id, phone)
      select x.org_id, p_phone from (
        select n.org_id
        from app.guest_contacts gc
        join app.notifications n on n.org_id = gc.org_id and n.recipient_ref = gc.id
        join app.provider_settings s on s.org_id = n.org_id and s.channel = 'sms' and s.mode = 'platform'
        where gc.channel = 'phone' and gc.value = p_phone and n.channel = 'sms' and n.status = 'sent'
          and n.sent_at > now() - interval '3 days'
        order by n.sent_at desc limit 1) x;
      insert into app.suppressions (org_id, channel, value, reason)
      select s.org_id, 'sms', p_phone, 'platform_stop' from app.provider_settings s
      where s.channel = 'sms' and s.mode = 'platform'
      on conflict (org_id, channel, value) do nothing;
    else
      -- only a stop given to this sender; an org's own stop, a bounce, complaint or manual block stays
      delete from app.suppressions x using app.provider_settings s
      where x.org_id = s.org_id and s.channel = 'sms' and s.mode = 'platform'
        and x.channel = 'sms' and x.value = p_phone and x.reason = 'platform_stop';
    end if;
    return true;
  end if;
  raise exception 'invalid_input';
end $$;

comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, paused (the org''s platform SMS is paused, see ops.pause_unhealthy_platform_sms), cap_reached, country_blocked, budget_reached or '
  'insufficient_credit (a platform-mode org with no prepaid credit left) for one paid send and counts it '
  'when allowed. The daily cap and monthly budget are the lower of the org''s own channel_limits and the operator ceilings (messaging.* entitlements; young orgs get a lower daily ceiling). Credit is debited when the send is reported, so a burst already in flight can overdraw by '
  'the messages of one dispatch batch.';
comment on function api.apply_platform_sms_event(text, text, text, text, text) is
  'Service role only (provider-webhook, platform Twilio number). kind status: applies a delivery report (p_status, p_error_code) '
  'to the platform-mode org that owns p_provider_message_id; false when none does. kind stop or start: records a sender-level opt-out '
  'of p_phone (E.164) in every platform-mode SMS org, or lifts a stop (never a bounce, complaint or manual block); a stop also counts against each '
  'platform-mode org that last texted that number within 3 days, once per distinct number (auto-pause). Raises invalid_input.';

notify pgrst, 'reload schema';
