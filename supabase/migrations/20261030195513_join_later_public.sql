-- 2B-J4 (#242): the join page learns whether a queue offers joining for later, and how far ahead.
--
-- Expand-only: api.public_wait gains a trailing attribute join_later_max_hours, null unless the
-- queue has join_later_enabled. Nothing about guests or other settings is exposed.
-- redefines api.get_location_wait from 20261030115002_intake_wait.sql

alter type api.public_wait add attribute join_later_max_hours int;

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
         case when q.party_size_enabled then q.party_size_max end,
         private.guest_intake_fields(q.id),
         case when q.join_later_enabled then q.join_later_max_hours end
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
  '(the next opening while the location is closed by its hours, else null) the server time the party-size bounds (null when the queue does not ask for a party size) and the guest-visible intake fields in position order (key, label, help, type, options, required; an empty array when there are none; never staff-only or inactive fields). join_later_max_hours (2B-J4: how many hours ahead a guest may reserve a place, null when the queue does not offer joining later). Contains no guest data. Raises not_found for an '
  'unknown slug.';
