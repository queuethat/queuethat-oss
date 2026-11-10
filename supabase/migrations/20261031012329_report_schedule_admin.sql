-- 3-RPT2 (#369): what the report schedules page needs from the database.
--
--   * api.list_report_schedules: the org's schedules with their next send time. The rule for "next"
--     (wall-clock time in the location's zone, ISO weekday, DST-safe) lives here with the sender, so
--     the page only renders it. Only admins and owners of a location see its schedules, as RLS does for the table.
--   * api.send_report_preview: queues one report to the caller, for the schedule's last period, so an
--     owner can see what recipients will get. Why a new RPC: a preview needs the privileged enqueue,
--     which no table write can reach. Alternative: let the page insert a notification row directly
--     (rejected: clients never write the outbox, I-11).

-- The first local send time after p_now: strictly later, on a matching weekday for weekly schedules.
create function private.next_report_at(p_frequency text, p_weekday smallint, p_send_at time, p_tz text, p_now timestamptz)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_date date := (p_now at time zone p_tz)::date;
  v_candidate timestamptz;
  d int;
begin
  for d in 0..7 loop
    continue when p_frequency = 'weekly' and extract(isodow from v_date + d)::int <> p_weekday;
    v_candidate := ((v_date + d) + p_send_at) at time zone p_tz;
    if v_candidate > p_now then
      return v_candidate;
    end if;
  end loop;
  return null;
end $$;
comment on function private.next_report_at(text, smallint, time, text, timestamptz) is
  'First send time of a report schedule strictly after p_now, in the location''s zone (a wall-clock time a DST jump skips lands right after the jump). Null for a weekly schedule without a weekday.';

create type api.report_schedule_row as (
  id uuid,
  location_id uuid,
  location_name text,
  tz text,
  frequency text,
  weekday smallint,
  send_at_local time,
  recipients uuid[],
  enabled boolean,
  next_send_at timestamptz
);
grant usage on type api.report_schedule_row to authenticated, service_role;

create function api.list_report_schedules(p_org_id uuid) returns setof api.report_schedule_row
language sql stable security definer set search_path = '' as $$
  select s.id, s.location_id, l.name, l.tz, s.frequency, s.weekday, s.send_at_local, s.recipients, s.enabled,
         case when s.enabled then private.next_report_at(s.frequency, s.weekday, s.send_at_local, l.tz, now()) end
  from app.report_schedules s
  join app.locations l on l.id = s.location_id
  where s.org_id = p_org_id and private.has_role(s.org_id, s.location_id, 'admin')
  order by l.name, s.send_at_local, s.id
$$;
comment on function api.list_report_schedules(uuid) is
  'The org''s report schedules with the location name and zone and, while enabled, the next send time. Only owners and admins of the location see its rows; anyone else gets none.';
revoke all on function api.list_report_schedules(uuid) from public, anon;
grant execute on function api.list_report_schedules(uuid) to authenticated;

create function api.send_report_preview(p_schedule_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.report_schedules;
  v_today date;
begin
  select * into s from app.report_schedules where id = p_schedule_id;
  if not found or not private.has_role(s.org_id, s.location_id, 'admin') then
    raise exception 'not_found';
  end if;
  if (select count(*) from app.notifications n
      where n.org_id = s.org_id and n.recipient_ref = (select auth.uid()) and n.dedupe_key like 'report:preview:%'
        and n.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;
  select (now() at time zone l.tz)::date into v_today from app.locations l where l.id = s.location_id;
  perform private.enqueue_report(
    s.id, array[(select auth.uid())],
    case s.frequency when 'weekly' then v_today - 7 else v_today - 1 end, v_today - 1,
    'preview:' || s.id::text || ':' || clock_timestamp()::text);
end $$;
comment on function api.send_report_preview(uuid) is
  'Queues the schedule''s report, for its latest finished period, to the calling owner or admin only. Raises not_found (unknown schedule or not an admin of its location) and rate_limited (5 an hour).';
revoke all on function api.send_report_preview(uuid) from public, anon;
grant execute on function api.send_report_preview(uuid) to authenticated;
