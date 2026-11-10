-- #478: a location's country, so the guest phone field defaults to the venue's dialling code
-- rather than whatever region the guest's browser is set to. Expand-only: a nullable column,
-- and one attribute appended to api.location_public (clients ignore fields they don't know).
--
-- No backfill from the time zone: many zones span several countries, a zone-to-country table is
-- several hundred rows, and before launch only seeded locations exist. Null keeps today's
-- behaviour (the browser's region) until an admin sets it in location settings.

alter table app.locations
  add column country_code text check (country_code ~ '^[A-Z]{2}$');
comment on column app.locations.country_code is
  'ISO 3166-1 alpha-2 country of the venue, e.g. GB. Defaults the guest phone field''s country. '
  'Null: guests'' browsers pick.';

alter type api.location_public add attribute country_code text;

------------------------------------------------------------------------------------------------
-- api.get_location_public: also returns country_code
------------------------------------------------------------------------------------------------

-- redefines api.get_location_public from 20261025001800_guest_rpcs.sql
create or replace function api.get_location_public(p_location_slug text) returns api.location_public
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  result api.location_public;
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

  select l.id, l.name, l.slug, l.tz, l.address, l.contact,
         coalesce(array_agg(row(
           q.id, q.name, q.manual_state, r.reason is null, r.reason,
           (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
           e.eta_state, e.eta_low, e.eta_high, q.pulse_id,
           array(select row(s.id, s.name, s.description)::api.public_service
                 from app.services s
                 where s.queue_id = q.id and s.active
                 order by s.sort_order, s.name)
         )::api.public_queue order by q.sort_order, q.name) filter (where q.id is not null),
         '{}'),
         l.country_code
  into result
  from (select 1) one
  left join app.queues q on q.location_id = l.id and q.archived_at is null
  left join lateral (select private.queue_not_accepting_reason(q.id) as reason) r on true
  left join lateral private.queue_eta(q.id) e on true;
  return result;
end $$;
comment on function api.get_location_public(text) is
  'Public view of a location by its slug (or a redirected old slug; slug is always the current '
  'one): name, contact, country (null when not set), and each non-archived queue with its '
  'accepting state and reason, waiting count, ETA for someone joining now, pulse topic and '
  'active services. Contains no guest data. Raises not_found for an unknown slug.';
