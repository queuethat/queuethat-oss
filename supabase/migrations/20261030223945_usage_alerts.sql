-- 3-PV7 (#346): email owners and admins once at 80% and once at 100% of a daily send cap. The alert is
-- account mail (no visit, recipient_ref = the member's auth user id), sent by the dispatcher like any
-- other row. Members opt out with memberships.notify_usage_alerts; a removed member has no membership
-- row, so is never queued.

alter table app.memberships add column notify_usage_alerts boolean not null default true;

create table app.usage_alerts (
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel app.notification_channel not null,
  day date not null,
  threshold int not null check (threshold in (80, 100)),
  created_at timestamptz not null default now(),
  primary key (org_id, channel, day, threshold)
);
alter table app.usage_alerts enable row level security;
create policy usage_alerts_select on app.usage_alerts for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
grant select on app.usage_alerts to authenticated;
grant all on app.usage_alerts to service_role;

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert'));
insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('usage_alert', 'email', 'transactional', '{org}: {channel} usage at {percent}% of today''s cap',
   '{org} has sent {count} of {cap} {channel} messages today (UTC), {percent}% of the daily cap. '
   'At 100% further messages are held back until the cap resets at 00:00 UTC. '
   'Review or raise the limit under Usage in your admin console (/admin/usage).'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

-- Queues usage_alert to every owner and admin of the org who has a sign-in email and has not opted out.
create function private.enqueue_usage_alert(p_org_id uuid, p_channel app.notification_channel, p_day date,
                                            p_threshold int, p_count int, p_cap int) returns void
language sql volatile security definer set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_org_id, null, 'email', m.user_id, 'usage_alert', t.version, t.category,
         jsonb_build_object('org', o.name, 'channel', p_channel::text, 'count', p_count, 'cap', p_cap,
                            'percent', p_threshold),
         concat_ws(':', 'usage_alert', p_org_id, p_channel, p_day, p_threshold, m.user_id)
  from app.memberships m
  join auth.users u on u.id = m.user_id and u.email is not null
  join app.organizations o on o.id = m.org_id
  cross join lateral private.resolve_template(p_org_id, null, 'usage_alert', 'email', o.default_locale) t
  where m.org_id = p_org_id and m.role in ('owner', 'admin') and m.notify_usage_alerts
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_usage_alert(uuid, app.notification_channel, date, int, int, int) is
  'Queues usage_alert by email to the org''s owners and admins who have not opted out. Idempotent per threshold, day and member. Called by api.reserve_send only.';
revoke all on function private.enqueue_usage_alert(uuid, app.notification_channel, date, int, int, int) from public, anon, authenticated;

-- redefines api.reserve_send from 20261030221951_usage_limits.sql
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
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked or budget_reached for one paid '
  'send and counts it (per UTC day) when allowed, whether or not the provider then succeeds. Atomic under '
  'concurrent dispatchers; a row already reserved is allowed again without counting twice. A number with an unknown calling code '
  'is country_blocked (a shared code such as +1 matches every country on it); an org with no channel_limits row has 200 a day and no allowed country. '
  'Raises not_found. Crossing 80% and 100% of the daily cap queues one usage_alert email per owner and admin. Implemented in 3-PV6 (#345), alerts in 3-PV7 (#346).';
