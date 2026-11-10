-- 2B-R7 (#298): feedback and NPS reporting. Replaces the stub bodies from
-- 20261030162713_api_contracts_2b.sql; signatures and row types are unchanged.

/** The one access check behind both reports: zero rows for outsiders, permission_denied below manager. */
create function private.feedback_report_access(p_location_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select l.org_id into v_org from app.locations l where l.id = p_location_id;
  if v_org is null or not private.has_role(v_org, p_location_id, 'staff') then
    return false;
  end if;
  if not private.has_role(v_org, p_location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return true;
end $$;
comment on function private.feedback_report_access(uuid) is
  'True for managers and above of the location, false for anyone outside it (callers return no rows), '
  'raises permission_denied for staff. Shared by api.feedback_summary and api.feedback_comments.';
revoke all on function private.feedback_report_access(uuid) from public, anon, authenticated;

-- redefines api.feedback_summary from 20261030162713_api_contracts_2b.sql
create or replace function api.feedback_summary(p_location_id uuid, p_from_day date, p_to_day date, p_group text)
returns setof api.feedback_summary_row
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.feedback_report_access(p_location_id) then
    return;
  end if;
  if p_group is null or p_group not in ('all', 'week', 'service') or p_from_day is null
     or p_to_day is null or p_to_day < p_from_day or p_to_day - p_from_day >= 400 then
    raise exception 'invalid_input';
  end if;

  return query
  select
    g.grp,
    count(*)::int,
    round(avg(g.rating), 2),
    round(100.0 * ((count(*) filter (where g.nps >= 9)) - (count(*) filter (where g.nps <= 6)))
          / nullif(count(g.nps), 0), 1),
    (count(*) filter (where g.nps >= 9))::int,
    (count(*) filter (where g.nps between 7 and 8))::int,
    (count(*) filter (where g.nps <= 6))::int
  from (
    select
      case p_group
        when 'week' then to_char(date_trunc('week', v.service_day::timestamp), 'YYYY-MM-DD')
        when 'service' then coalesce(s.name, '')
        else 'all'
      end as grp,
      f.rating, f.nps
    from app.visit_feedback f
    join app.visits v on v.org_id = f.org_id and v.id = f.visit_id
    left join app.services s on s.id = v.service_id
    where f.location_id = p_location_id
      and v.service_day between p_from_day and p_to_day
  ) g
  group by g.grp
  order by g.grp;
end $$;
comment on function api.feedback_summary(uuid, date, date, text) is
  'Responses, average rating (1..5), NPS and promoter/passive/detractor counts for visits whose '
  'service day is in p_from_day..p_to_day, grouped by p_group: all, week (Monday as YYYY-MM-DD) or '
  'service name. NPS = (promoters - detractors) / answers with an NPS score x 100, null without any. '
  'Managers and above; staff get permission_denied, callers outside the location zero rows. '
  'Raises invalid_input for another p_group or a range over 400 days.';

-- redefines api.feedback_comments from 20261030162713_api_contracts_2b.sql
create or replace function api.feedback_comments(
  p_location_id uuid, p_from_day date, p_to_day date, p_limit int, p_after uuid
) returns setof api.feedback_comment_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v_at timestamptz;
  v_id uuid;
begin
  if not private.feedback_report_access(p_location_id) then
    return;
  end if;
  if p_from_day is null or p_to_day is null or p_to_day < p_from_day or p_to_day - p_from_day >= 400
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_input';
  end if;
  if p_after is not null then
    select f.created_at, f.id into v_at, v_id from app.visit_feedback f
    where f.id = p_after and f.location_id = p_location_id;
  end if;

  return query
  select f.id, f.visit_id, f.rating::int, f.nps::int, f.comment::text, f.created_at
  from app.visit_feedback f
  join app.visits v on v.org_id = f.org_id and v.id = f.visit_id
  where f.location_id = p_location_id
    and f.comment is not null
    and v.service_day between p_from_day and p_to_day
    and (p_after is null or (f.created_at, f.id) < (v_at, v_id))
  order by f.created_at desc, f.id desc
  limit p_limit;
end $$;
comment on function api.feedback_comments(uuid, date, date, int, uuid) is
  'Feedback comments, newest first, for visits whose service day is in the range. p_limit 1..100; '
  'pass the last id as p_after for the next page. visit_id links to the visit history; no contact '
  'data. Comments older than 90 days are already cleared by retention. Managers and above; staff get '
  'permission_denied, callers outside the location zero rows.';
