-- 2B-R7 (#298): feedback reporting gains response rate inputs, the 1..5 distribution and the context a
-- comment needs. api.feedback_summary_row and api.feedback_comment_row only gain attributes; signatures
-- and existing columns are unchanged.
alter type api.feedback_summary_row
  add attribute served int,
  add attribute rating_1 int,
  add attribute rating_2 int,
  add attribute rating_3 int,
  add attribute rating_4 int,
  add attribute rating_5 int;
alter type api.feedback_comment_row
  add attribute guest_id uuid,
  add attribute ticket text,
  add attribute service text;

-- redefines api.feedback_summary from 20261030162713_api_contracts_2b.sql
-- redefines api.feedback_summary from 20261030173036_feedback_reporting.sql
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
    (count(g.fid))::int,
    round(avg(g.rating), 2),
    round(100.0 * ((count(*) filter (where g.nps >= 9)) - (count(*) filter (where g.nps <= 6)))
          / nullif(count(g.nps), 0), 1),
    (count(*) filter (where g.nps >= 9))::int,
    (count(*) filter (where g.nps between 7 and 8))::int,
    (count(*) filter (where g.nps <= 6))::int,
    (count(*) filter (where g.was_served))::int,
    (count(*) filter (where g.rating = 1))::int,
    (count(*) filter (where g.rating = 2))::int,
    (count(*) filter (where g.rating = 3))::int,
    (count(*) filter (where g.rating = 4))::int,
    (count(*) filter (where g.rating = 5))::int
  from (
    select
      case p_group
        when 'week' then to_char(date_trunc('week', v.service_day::timestamp), 'YYYY-MM-DD')
        when 'service' then coalesce(s.name, '')
        else 'all'
      end as grp,
      f.id as fid, f.rating, f.nps, v.status = 'served' as was_served
    from app.visits v
    left join app.visit_feedback f on f.org_id = v.org_id and f.visit_id = v.id
    left join app.services s on s.id = v.service_id
    where v.location_id = p_location_id
      and v.service_day between p_from_day and p_to_day
      and (v.status = 'served' or f.id is not null)
  ) g
  group by g.grp
  order by g.grp;
end $$;
comment on function api.feedback_summary(uuid, date, date, text) is
  'Responses, average rating (1..5), NPS and promoter/passive/detractor counts for visits whose '
  'service day is in p_from_day..p_to_day, grouped by p_group: all, week (Monday as YYYY-MM-DD) or '
  'service name. served counts the served visits of the group (responses / served is the response rate) and '
  'rating_1..rating_5 count the responses per rating. NPS = (promoters - detractors) / answers with an NPS score x 100, null without any. '
  'Managers and above; staff get permission_denied, callers outside the location zero rows. '
  'Raises invalid_input for another p_group or a range over 400 days.';

-- redefines api.feedback_comments from 20261030162713_api_contracts_2b.sql
-- redefines api.feedback_comments from 20261030173036_feedback_reporting.sql
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
  select f.id, f.visit_id, f.rating::int, f.nps::int, f.comment::text, f.created_at,
         v.guest_id, v.display_ticket::text, s.name::text
  from app.visit_feedback f
  join app.visits v on v.org_id = f.org_id and v.id = f.visit_id
  left join app.services s on s.id = v.service_id
  where f.location_id = p_location_id
    and f.comment is not null
    and v.service_day between p_from_day and p_to_day
    and (p_after is null or (f.created_at, f.id) < (v_at, v_id))
  order by f.created_at desc, f.id desc
  limit p_limit;
end $$;
comment on function api.feedback_comments(uuid, date, date, int, uuid) is
  'Feedback comments, newest first, for visits whose service day is in the range. p_limit 1..100; '
  'pass the last id as p_after for the next page. guest_id (null for a visit without a guest profile) '
  'links to the guest''s visit history, ticket and service name give context; no contact data. Comments older than 90 days are already cleared by retention. Managers and above; staff get '
  'permission_denied, callers outside the location zero rows.';
