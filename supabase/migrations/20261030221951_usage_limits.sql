-- 3-PV6 (#345): daily send cap, country allowlist and monthly budget for paid channels, checked by the
-- dispatcher through api.reserve_send before the provider is called (SMS pumping defence). Absent a
-- channel_limits row an org has the defaults: 200 a day and no country allowed.

create table app.channel_limits (
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel app.notification_channel not null check (channel in ('sms', 'whatsapp')),
  daily_cap int not null default 200 check (daily_cap between 0 and 100000),
  monthly_budget_micros bigint check (monthly_budget_micros >= 0),
  country_allowlist text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (org_id, channel)
);
create trigger forbid_org_change before update on app.channel_limits
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.channel_limits
  for each row execute function private.touch_updated_at();
create trigger audit_row after insert or update or delete on app.channel_limits
  for each row execute function private.audit_row();

-- Attempts per UTC day; incremented only by reserve_send.
create table app.usage_counters (
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel app.notification_channel not null,
  day date not null,
  sent int not null default 0,
  primary key (org_id, channel, day)
);

alter table app.channel_limits enable row level security;
alter table app.usage_counters enable row level security;
create policy channel_limits_select on app.channel_limits for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
create policy channel_limits_insert on app.channel_limits for insert to authenticated
  with check ((select private.has_role(org_id, null, 'admin')));
create policy channel_limits_update on app.channel_limits for update to authenticated
  using ((select private.has_role(org_id, null, 'admin')))
  with check ((select private.has_role(org_id, null, 'admin')));
create policy channel_limits_delete on app.channel_limits for delete to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
create policy usage_counters_select on app.usage_counters for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
grant select, insert, update, delete on app.channel_limits to authenticated;
grant select on app.usage_counters to authenticated;
grant all on app.channel_limits, app.usage_counters to service_role;

-- Country calling codes, so the allowlist is checked against the number itself, never a stored or
-- guest-supplied country. A shared code (+1) lists every country on it; the allowlist matches any.
create table app.dial_codes (prefix text not null check (prefix ~ '^[0-9]{1,4}$'), country_code text not null check (country_code ~ '^[A-Z]{2}$'), primary key (prefix, country_code));
alter table app.dial_codes enable row level security;
-- Read only through private.phone_countries; no tenant role reads or writes it.
create policy dial_codes_none on app.dial_codes for select to authenticated using (false);
grant all on app.dial_codes to service_role;
insert into app.dial_codes (prefix, country_code) values
  ('1','US'),('1','CA'),('44','GB'),('353','IE'),('61','AU'),('64','NZ'),('33','FR'),('49','DE'),('34','ES'),('39','IT'),
  ('31','NL'),('32','BE'),('41','CH'),('43','AT'),('45','DK'),('46','SE'),('47','NO'),('358','FI'),('351','PT'),('48','PL'),
  ('52','MX'),('55','BR'),('54','AR'),('56','CL'),('57','CO'),('91','IN'),('81','JP'),('82','KR'),('65','SG'),('852','HK'),
  ('971','AE'),('966','SA'),('972','IL'),('27','ZA'),('234','NG'),('254','KE'),('63','PH'),('62','ID'),('60','MY'),('66','TH');

-- Countries whose calling code is the longest prefix of an E.164 number; null when unknown.
create function private.phone_countries(p_e164 text) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_agg(d.country_code) from app.dial_codes d
  where p_e164 ~ '^\+[0-9]+$' and substr(p_e164, 2) like d.prefix || '%'
    and length(d.prefix) = (select max(length(q.prefix)) from app.dial_codes q where substr(p_e164, 2) like q.prefix || '%')
$$;
revoke all on function private.phone_countries(text) from public;
grant execute on function private.phone_countries(text) to service_role;

-- A row is reserved once: a quiet-hours or provider retry of the same row does not count twice.
alter table app.notifications add column reserved_at timestamptz;
grant select (reserved_at) on app.notifications to authenticated;

-- redefines api.reserve_send from 20261030210404_api_contracts_3.sql
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
  return row('allowed', v_sent + 1, v_cap)::api.send_reservation;
end $$;
comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked or budget_reached for one paid '
  'send and counts it (per UTC day) when allowed, whether or not the provider then succeeds. Atomic under '
  'concurrent dispatchers; a row already reserved is allowed again without counting twice. A number with an unknown calling code '
  'is country_blocked (a shared code such as +1 matches every country on it); an org with no channel_limits row has 200 a day and no allowed country. '
  'Raises not_found. Implemented in 3-PV6 (#345).';
