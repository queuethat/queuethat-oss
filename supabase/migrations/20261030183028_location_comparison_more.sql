-- 2B-R5 (#296): api.location_comparison gains median service, abandonment and average rating.
-- api.location_metrics only gains attributes; the signature and existing columns are unchanged.
-- redefines api.location_comparison from 20261030175238_location_comparison.sql
alter type api.location_metrics
  add attribute median_service_min numeric,
  add attribute abandonment_pct numeric,
  add attribute avg_rating numeric;

create or replace function api.location_comparison(p_org_id uuid, p_from_day date, p_to_day date)
returns setof api.location_metrics
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_from_day is null or p_to_day is null or p_to_day < p_from_day or p_to_day - p_from_day >= 400 then
    raise exception 'invalid_input';
  end if;
  return query
  select
    l.id, l.name,
    (count(v.id) filter (where v.status <> 'expired'))::int,
    round((avg(extract(epoch from v.called_at - v.joined_at) / 60))::numeric, 1),
    round((avg(extract(epoch from v.finished_at - v.serving_at) / 60) filter (where v.status = 'served'))::numeric, 1),
    round(100.0 * count(v.id) filter (where v.status = 'no_show')
          / nullif(count(v.id) filter (where v.called_at is not null), 0), 1),
    -- Same definition as api.eta_accuracy: of called visits with a quote, the share that waited
    -- inside the quoted range.
    round(100.0 * count(v.id) filter (where v.eta_quoted_low is not null and v.called_at is not null
            and extract(epoch from v.called_at - v.joined_at) / 60 between v.eta_quoted_low and v.eta_quoted_high)
          / nullif(count(v.id) filter (where v.eta_quoted_low is not null and v.called_at is not null), 0), 1),
    round((percentile_cont(0.5) within group (order by extract(epoch from v.finished_at - v.serving_at) / 60)
           filter (where v.status = 'served'))::numeric, 1),
    -- As api.outcome_rates: cancelled over visits that are no longer waiting (expired ones excluded).
    round(100.0 * count(v.id) filter (where v.status = 'cancelled')
          / nullif(count(v.id) filter (where v.status not in ('expected', 'waiting', 'expired')), 0), 1),
    (select round(avg(f.rating), 2) from app.visit_feedback f
       join app.visits fv on fv.org_id = f.org_id and fv.id = f.visit_id
      where f.location_id = l.id and fv.service_day between p_from_day and p_to_day)
  from app.locations l
  left join app.visits v on v.location_id = l.id and v.service_day between p_from_day and p_to_day
  where l.org_id = p_org_id and private.has_role(l.org_id, l.id, 'admin')
  group by l.id, l.name
  order by l.name, l.id;
end $$;
comment on function api.location_comparison(uuid, date, date) is
  'Per location of the organization, over service days p_from_day..p_to_day (each location''s own): '
  'visits (not counting expired), average wait to first call and average service in minutes, '
  'no_show_pct of called visits and within_eta_pct (called visits that waited inside their quoted '
  'range, as api.eta_accuracy), median_service_min, abandonment_pct (cancelled of visits no longer '
  'waiting, as api.outcome_rates) and avg_rating (1..5, from guest feedback), each null when it has no basis. Owners and admins see the locations '
  'they hold the role at, so a restricted member gets only theirs; anyone else gets zero rows. '
  'Raises invalid_input for a range over 400 days.';
