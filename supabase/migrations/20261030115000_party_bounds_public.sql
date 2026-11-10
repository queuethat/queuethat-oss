-- 2A-Q9 (#108): the join page learns a queue's party-size bounds from api.get_location_wait.
-- 2A-GST8 left these attributes to 2A-Q5, which stored the policy but did not publish it; they are
-- appended, so no existing column moves. Null both when the queue ignores party size.

alter type api.public_wait add attribute party_size_min int, add attribute party_size_max int;

-- redefines api.get_location_wait from 20261030074500_org_deletion.sql
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
  if l.id is null or private.org_pending_deletion(l.org_id) then
    raise exception 'not_found';
  end if;

  return query
  select q.id, q.name,
         r.reason is null,
         (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
         e.eta_low, e.eta_high, e.eta_state,
         case when private.location_open_at(l.id, now()) then null
              else private.location_next_change(l.id, now()) end,
         now(),
         case when q.party_size_enabled then q.party_size_min end,
         case when q.party_size_enabled then q.party_size_max end
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
  '(the next opening while the location is closed by its hours, else null) the server time and the party-size bounds (null when the queue does not ask for a party size). Contains no guest data. Raises not_found for an '
  'unknown slug.';
