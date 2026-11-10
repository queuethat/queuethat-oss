-- 2A-GST8 (#129): body of api.get_location_wait. Signature and return type are those fixed by
-- 2A-API1 (20261030045508_api_contracts_2a.sql); nothing about them changes here.
--
-- opens_next_at is the next opening (private.location_next_change) while the location is closed by
-- its hours, null otherwise. The party-size, intake and on-site-code attributes are added to
-- api.public_wait by 2A-Q5, 2A-Q7 and 2A-JN5, which own them.

-- redefines api.get_location_wait from 20261030045508_api_contracts_2a.sql
create or replace function api.get_location_wait(p_location_slug text) returns setof api.public_wait
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null then
    raise exception 'not_found';
  end if;

  return query
  select q.id, q.name,
         r.reason is null,
         (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
         e.eta_low, e.eta_high, e.eta_state,
         case when private.location_open_at(l.id, now()) then null
              else private.location_next_change(l.id, now()) end,
         now()
  from app.queues q
  -- Same rule as get_location_public: this is the online entry point, so the hourly ceiling counts.
  cross join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r
  cross join lateral private.queue_eta(q.id) e
  where q.location_id = l.id and q.archived_at is null
  order by q.sort_order, q.name;
end $$;
comment on function api.get_location_wait(text) is
  'One row per non-archived queue of the location (or its redirected old slug): accepting (the '
  'queue accepting predicate, plus the hourly online ceiling as get_location_public), waiting '
  'count, the ETA a guest joining now would get (private.queue_eta: eta_state hidden, paused, '
  'unstaffed, next, over_hour, uncertain or ok, with numbers only for the last three), opens_next_at '
  '(the next opening while the location is closed by its hours, else null) and the server time. Contains no guest data. Raises not_found for an '
  'unknown slug.';
