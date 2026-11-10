-- 2B-W2 (#290): api.eta_accuracy. Replaces the stub body from 20261030162713_api_contracts_2b.sql.
-- The function signature is unchanged. api.eta_accuracy_row only gains attributes (an unimplemented
-- stub, so nothing reads it yet); the original five columns keep their names and order.
-- Semantics: actual wait = first call (earliest 'call' event, else called_at) minus joined_at, in
-- minutes. A visit counts when it was called and had a quoted range; called visits without a quote
-- (hidden ETA) only add to excluded_no_quote. early = waited less than the quoted low, late = more
-- than the high. Error = distance outside the quoted range (0 inside); bias = mean of actual minus
-- the range midpoint (positive = guests waited longer than quoted).

alter type api.eta_accuracy_row
  add attribute pct_early numeric,
  add attribute pct_late numeric,
  add attribute avg_late_min numeric,
  add attribute p90_error_min numeric,
  add attribute excluded_no_quote int;

-- redefines api.eta_accuracy from 20261030162713_api_contracts_2b.sql
create or replace function api.eta_accuracy(p_location_id uuid, p_from_day date, p_to_day date, p_group text)
returns setof api.eta_accuracy_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := private.analytics_tz(p_location_id, p_from_day, p_to_day, 'day');
begin
  if p_group is null or p_group not in ('day', 'service', 'hour') then
    raise exception 'invalid_input';
  end if;
  return query
  with v as (
    select
      case p_group
        when 'day' then vi.service_day::text
        when 'hour' then to_char(vi.joined_at at time zone v_tz, 'HH24')
        else coalesce(s.name, '')
      end as grp,
      vi.eta_quoted_low as lo, vi.eta_quoted_high as hi,
      extract(epoch from coalesce((select min(e.occurred_at) from app.visit_events e
                                    where e.visit_id = vi.id and e.type = 'call'), vi.called_at)
                         - vi.joined_at) / 60 as waited
    from app.visits vi
    left join app.services s on p_group = 'service' and s.id = vi.service_id
    where vi.location_id = p_location_id
      and vi.service_day between p_from_day and p_to_day
      and (vi.called_at is not null
           or exists (select 1 from app.visit_events e where e.visit_id = vi.id and e.type = 'call'))
  ), m as (
    select v.grp, v.waited,
      v.lo is null as unquoted,
      greatest(v.lo - v.waited, v.waited - v.hi, 0) as err,
      v.waited - (v.lo + v.hi) / 2.0 as bias,
      v.waited < v.lo as early, v.waited > v.hi as late
    from v
  )
  select
    m.grp,
    (count(*) filter (where not m.unquoted))::int,
    round(100.0 * count(*) filter (where not m.unquoted and not m.early and not m.late)
          / nullif(count(*) filter (where not m.unquoted), 0), 1),
    round((percentile_cont(0.5) within group (order by m.err) filter (where not m.unquoted))::numeric, 1),
    round(avg(m.bias) filter (where not m.unquoted)::numeric, 1),
    round(100.0 * count(*) filter (where m.early) / nullif(count(*) filter (where not m.unquoted), 0), 1),
    round(100.0 * count(*) filter (where m.late) / nullif(count(*) filter (where not m.unquoted), 0), 1),
    round(avg(m.err) filter (where m.late)::numeric, 1),
    round((percentile_cont(0.9) within group (order by m.err) filter (where not m.unquoted))::numeric, 1),
    (count(*) filter (where m.unquoted))::int
  from m
  group by m.grp
  order by m.grp;
end $$;
comment on function api.eta_accuracy(uuid, date, date, text) is
  'How often the quoted ETA range held, per day, hour (location time) or service (p_group) over '
  'service days p_from_day..p_to_day. Counts called visits with a quote: within_range_pct, '
  'pct_early (waited under the quoted low), pct_late (over the high), median and p90 error in '
  'minutes outside the range, avg_late_min, bias_min (actual minus range midpoint). Called visits '
  'without a quote only add to excluded_no_quote. Managers and above of the location; others get '
  'not_found. Raises invalid_input for another p_group or a range over 400 days.';
