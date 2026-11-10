-- 2B-R5 (#296): api.location_comparison. Replaces the stub body from 20261030162713_api_contracts_2b.sql;
-- the signature and api.location_metrics are unchanged.
-- redefines api.location_comparison from 20261030162713_api_contracts_2b.sql
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
          / nullif(count(v.id) filter (where v.eta_quoted_low is not null and v.called_at is not null), 0), 1)
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
  'range, as api.eta_accuracy), each null when it has no basis. Owners and admins see the locations '
  'they hold the role at, so a restricted member gets only theirs; anyone else gets zero rows. '
  'Raises invalid_input for a range over 400 days.';
