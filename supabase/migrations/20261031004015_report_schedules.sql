-- 3-RPT1 (#368): scheduled email reports. An owner or admin picks a location, a daily or weekly
-- cadence, a local send time and recipients (current members). Every 15 minutes pg_cron asks
-- ops.enqueue_due_reports() which schedules are due in their location's time zone, snapshots
-- aggregate numbers and queues one account-mail row (recipient_ref = the member's user id) per
-- recipient. The dispatcher sends it like any other row; reports carry numbers only, never a
-- guest name, phone or email.

create table app.report_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  location_id uuid not null references app.locations (id) on delete cascade,
  frequency text not null check (frequency in ('daily', 'weekly')),
  -- ISO weekday, 1 = Monday .. 7 = Sunday; only for weekly.
  weekday smallint check (weekday between 1 and 7),
  send_at_local time not null,
  -- User ids of members. Membership is re-checked at every send, so a removed member gets nothing.
  recipients uuid[] not null default '{}' check (cardinality(recipients) <= 20),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((frequency = 'weekly') = (weekday is not null))
);
create index report_schedules_org_idx on app.report_schedules (org_id, location_id);
comment on table app.report_schedules is
  'Scheduled aggregate email reports per location. send_at_local is wall-clock time in the location''s zone; weekday is ISO (1 = Monday).';

create trigger forbid_org_change before update on app.report_schedules
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.report_schedules
  for each row execute function private.touch_updated_at();
create trigger audit_row after insert or update or delete on app.report_schedules
  for each row execute function private.audit_row();

-- Runs before RLS, so it must see every location itself (definer): a caller outside the org is then
-- refused by the policy, not by this check. The location must belong to the org, and an enabled schedule needs recipients who are members of it.
create function private.validate_report_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'not_found';
  end if;
  if exists (select 1 from unnest(new.recipients) r(user_id)
             where not exists (select 1 from app.memberships m where m.org_id = new.org_id and m.user_id = r.user_id)) then
    raise exception 'invalid_recipient';
  end if;
  if new.enabled and cardinality(new.recipients) = 0 then
    raise exception 'invalid_recipient';
  end if;
  return new;
end $$;
create trigger validate_report_schedule before insert or update on app.report_schedules
  for each row execute function private.validate_report_schedule();

alter table app.report_schedules enable row level security;
create policy report_schedules_select on app.report_schedules for select to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')));
create policy report_schedules_insert on app.report_schedules for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'admin')));
create policy report_schedules_update on app.report_schedules for update to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')))
  with check ((select private.has_role(org_id, location_id, 'admin')));
create policy report_schedules_delete on app.report_schedules for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'admin')));
grant select, insert, update, delete on app.report_schedules to authenticated;
grant all on app.report_schedules to service_role;

-- The numbers in a report. Aggregates over the location's service days, nothing identifying.
-- eta_miss_min is the average distance (minutes) between the wait and the quoted range, 0 when inside it.
create function private.report_vars(p_location_id uuid, p_from date, p_to date, p_tz text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with v as (
    select vi.status, vi.joined_at,
           extract(epoch from vi.called_at - vi.joined_at) / 60 as waited,
           vi.eta_quoted_low as lo, vi.eta_quoted_high as hi
    from app.visits vi
    where vi.location_id = p_location_id and vi.service_day between p_from and p_to
  ), hours as (
    select to_char(v.joined_at at time zone p_tz, 'HH24') as h, count(*) as n
    from v group by 1 order by n desc, h limit 1
  )
  select jsonb_build_object(
    'visits', (select count(*) from v),
    'served', (select count(*) filter (where status = 'served') from v),
    'avg_wait_min', coalesce((select round(avg(waited))::int::text from v where waited is not null), 'n/a'),
    'no_show_pct', coalesce((select round(100.0 * count(*) filter (where status = 'no_show') / nullif(count(*), 0))::int::text from v), 'n/a'),
    'busiest_hour', coalesce((select h || ':00' from hours), 'n/a'),
    'eta_miss_min', coalesce((select round(avg(greatest(lo - waited, waited - hi, 0)))::int::text
                              from v where waited is not null and lo is not null), 'n/a')
  )
$$;
comment on function private.report_vars(uuid, date, date, text) is
  'Aggregate report numbers for a location and service-day range: visits, served, average wait, no-show percent, busiest local hour, average ETA miss. Text "n/a" when there is no data. No guest data.';
revoke all on function private.report_vars(uuid, date, date, text) from public, anon, authenticated;

-- Queues one report email per recipient of schedule p_schedule_id for the given period, idempotent per
-- p_key and member. Members who left, or have no sign-in email, are skipped. Returns the rows queued.
create function private.enqueue_report(p_schedule_id uuid, p_user_ids uuid[], p_from date, p_to date, p_key text)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.report_schedules;
  v_tz text;
  v_vars jsonb;
  v_count int;
begin
  select * into s from app.report_schedules where id = p_schedule_id;
  select l.tz into v_tz from app.locations l where l.id = s.location_id;
  select private.report_vars(s.location_id, p_from, p_to, v_tz)
         || jsonb_build_object('org', o.name, 'location', l.name, 'frequency', s.frequency,
                               'period', case when p_from = p_to then p_from::text else p_from::text || ' to ' || p_to::text end)
    into v_vars
  from app.locations l join app.organizations o on o.id = l.org_id where l.id = s.location_id;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select s.org_id, null, 'email', m.user_id, 'report_summary', t.version, t.category, v_vars,
         concat_ws(':', 'report', p_key, m.user_id)
  from app.memberships m
  join auth.users u on u.id = m.user_id and u.email is not null
  join app.organizations o on o.id = m.org_id
  cross join lateral private.resolve_template(s.org_id, null, 'report_summary', 'email', o.default_locale) t
  where m.org_id = s.org_id and m.user_id = any (p_user_ids)
    and (m.location_ids is null or s.location_id = any (m.location_ids))
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
comment on function private.enqueue_report(uuid, uuid[], date, date, text) is
  'Queues the report_summary email for the listed members of a schedule''s org (current members only), once per key and member. Returns rows queued.';
revoke all on function private.enqueue_report(uuid, uuid[], date, date, text) from public, anon, authenticated;

-- A schedule is due from its local send time for one hour (so a missed tick or short outage still sends,
-- and a report scheduled for a time that a DST jump skips fires right after the jump). The local date is
-- part of the key, so each period queues once even when the hour repeats on a fall-back night. Daily reports
-- cover yesterday, weekly ones the seven days before today. Returns the number of emails queued.
create function ops.enqueue_due_reports(p_now timestamptz default now()) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  s record;
  v_local timestamp;
  v_total int := 0;
begin
  for s in
    select rs.*, l.tz from app.report_schedules rs join app.locations l on l.id = rs.location_id where rs.enabled
  loop
    v_local := p_now at time zone s.tz;
    continue when v_local::time < s.send_at_local or v_local::time - s.send_at_local >= interval '1 hour';
    continue when s.frequency = 'weekly' and extract(isodow from v_local)::int <> s.weekday;
    v_total := v_total + private.enqueue_report(
      s.id, s.recipients,
      case s.frequency when 'weekly' then v_local::date - 7 else v_local::date - 1 end, v_local::date - 1,
      s.id::text || ':' || v_local::date::text);
  end loop;
  return v_total;
end $$;
comment on function ops.enqueue_due_reports(timestamptz) is
  'pg_cron (every 15 minutes): queues the report email for every enabled schedule whose local send time has come, once per local date. Not callable through the API.';
revoke all on function ops.enqueue_due_reports(timestamptz) from public, anon, authenticated;
select cron.schedule('enqueue-due-reports', '*/15 * * * *', 'select ops.enqueue_due_reports()');

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary'));
insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('report_summary', 'email', 'transactional', '{location}: {frequency} queue report, {period}',
   E'{org}, {location}, {period}\n\nVisits: {visits} ({served} served)\nAverage wait: {avg_wait_min} min\nNo-shows: {no_show_pct}%\nBusiest hour: {busiest_hour}\nETA off by (average): {eta_miss_min} min\n\nMore detail in your admin console (/admin).'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');
