-- 2B-ORG3 (#267): api.org_overview (ORG-4). Body only; the signature and api.location_overview are
-- the 2B-API1 contract, so the row carries that type's columns.
-- redefines api.org_overview from 20261030162713_api_contracts_2b.sql

create or replace function api.org_overview(p_org_id uuid) returns setof api.location_overview
language sql stable security definer set search_path = '' as $$
  select l.id, l.name,
         count(q.id)::int,
         coalesce(w.waiting, 0)::int,
         w.longest,
         min(e.eta_low)::int,
         max(e.eta_high)::int,
         now()
  from app.locations l
  -- Open queues: not archived and accepting by the single predicate (manual state, hours, capacity).
  left join lateral (
    select q.id from app.queues q
    where q.location_id = l.id and q.archived_at is null
      and private.queue_not_accepting_reason(q.id) is null
  ) q on true
  left join lateral private.queue_eta(q.id) e on true
  -- Each location's own service day, so New York and Berlin roll over at their own midnight.
  left join lateral (
    select count(*) as waiting,
           (extract(epoch from now() - min(v.joined_at)) / 60)::int as longest
    from app.visits v
    where v.location_id = l.id and v.status = 'waiting' and v.service_day = private.service_day(l.id)
  ) w on true
  where l.org_id = p_org_id and private.has_role(l.org_id, l.id, 'staff')
  group by l.id, l.name, w.waiting, w.longest
  order by l.name, l.id
$$;
comment on function api.org_overview(uuid) is
  'One live summary row per location of the organization the caller can see (a member limited to '
  'some locations gets only those): open queues (accepting now), people waiting today, minutes '
  'the longest-waiting guest has waited, and the lowest eta_low and highest eta_high over the open '
  'queues (null when none shows a number). "Today" is each location''s own service day. Staff of '
  'the location; another organization''s id returns no rows. Implemented by 2B-ORG3 (#267).';
