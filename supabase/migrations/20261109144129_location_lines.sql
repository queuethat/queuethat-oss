-- M5 (#1292): the guest provider picker. A location with provider lines (queues.kind 'provider') or an
-- "Anyone available" pool (kind 'pool') lets the guest choose a person, or the pool, before the service.
--
-- Alternatives (rule 7): append kind to api.public_queue and let api.get_location_public carry it (rejected:
-- the type is fixed, a trailing attribute would reach every old PWA bundle on TVs and kiosks that parse the
-- row positionally, and every poster page would pay for it) vs a new anon read, api.get_location_lines
-- (chosen). It is a new anon entry point, which rule 1 allows only with a reason: the picker needs the line's
-- kind and which line a link points at, neither of which an existing public type has room for.
--
-- `?for=<line>` is resolved here, not in the browser: p_for is a line id from the link; the row it names comes
-- back with selected = true. A value that names no line of this location selects nothing (no error, so a stale
-- poster link still opens the page, and a probe learns nothing about other tenants' ids).
--
-- Returns nothing for a location without provider or pool lines, so the picker is a function of data and the
-- page never re-derives it. Contains no guest data and no contact data (I-13): only a line's name (a person's
-- first name or a role, as the business typed it), its accepting state, waiting count and ETA.

create type api.public_line as (
  queue_id uuid,
  name text,
  kind text,
  accepting boolean,
  not_accepting_reason text,
  waiting_count int,
  eta_state api.eta_state,
  eta_low int,
  eta_high int,
  selected boolean
);
grant usage on type api.public_line to anon, authenticated, service_role;

create function api.get_location_lines(p_location_slug text, p_for text default null)
returns setof api.public_line
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  v_for uuid;
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
  -- A malformed or foreign id selects nothing.
  if p_for ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_for := p_for::uuid;
  end if;
  -- Only a location that has provider or pool lines has a picker.
  if not exists (select 1 from app.queues q
                 where q.location_id = l.id and q.archived_at is null and q.kind in ('provider', 'pool')) then
    return;
  end if;

  return query
  select q.id, q.name, q.kind, r.reason is null, r.reason,
         (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
         e.eta_state, e.eta_low, e.eta_high,
         q.id = v_for
  from app.queues q
  -- The online entry point: the hourly online ceiling counts, as in get_location_public.
  cross join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r
  cross join lateral private.queue_eta(q.id) e
  where q.location_id = l.id and q.archived_at is null
  -- "Anyone available" first, then people in the order the business set.
  order by (q.kind = 'pool') desc, q.sort_order, q.name;
end $$;
comment on function api.get_location_lines(text, text) is
  'The guest picker for a location with provider or "Anyone available" lines: one row per non-archived queue '
  '(kind general, provider or pool; pool first, then sort_order and name) with its accepting state and reason '
  '(as get_location_public), waiting count and the ETA a guest joining now would get. p_for is a line id taken '
  'from a link (/q/slug?for=...): the row it names has selected = true; a value naming no line of this location '
  'selects nothing. Returns no rows when the location has no provider or pool line. Contains no guest or '
  'contact data. Raises not_found for an unknown slug or a location being deleted.';
revoke all on function api.get_location_lines(text, text) from public, anon, authenticated, service_role;
grant execute on function api.get_location_lines(text, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
