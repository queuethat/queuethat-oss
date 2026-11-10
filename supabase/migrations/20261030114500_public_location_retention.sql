-- 2P-PRV2 (#189): guests are told how long their details are kept, and admins can change it.
--
-- Expand-only: api.location_public gains a trailing attribute retention_days (the org's period),
-- so existing readers are untouched. Admins set the period with a column grant under the existing
-- organizations_update policy (admin or above); app.organizations is already audited
-- (audit_row records before and after), and the column's CHECK keeps it within 1-3650.

grant update (retention_days) on app.organizations to authenticated;

alter type api.location_public add attribute retention_days int;

-- redefines api.get_location_public from 20261030074500_org_deletion.sql
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
  if l.id is null or private.org_pending_deletion(l.org_id) then
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
         l.country_code,
         (select s.turnstile_site_key from private.deployment_settings s),
         (select o.retention_days from app.organizations o where o.id = l.org_id)
  into result
  from (select 1) one
  left join app.queues q on q.location_id = l.id and q.archived_at is null
  -- This page is the online entry point, so the hourly online ceiling counts as not accepting.
  left join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r on true
  left join lateral private.queue_eta(q.id) e on true;
  return result;
end $$;
comment on function api.get_location_public(text) is
  'Public view of a location by its slug (or a redirected old slug; slug is always the current '
  'one): name, contact, country (null when not set), and each non-archived queue with its '
  'accepting state and reason, waiting count, ETA for someone joining now, pulse topic and '
  'active services. Reasons are those of queue_not_accepting_reason, then ''online_full'' when '
  'the queue reached its hourly online-join ceiling (join_queue would refuse it with '
  'rate_limited, DETAIL queue_total); staff can still add guests then. captcha_site_key is the '
  'Turnstile site key when online joins need a pass (api.issue_join_pass), else null. Contains '
  'no guest data. retention_days is how long the business keeps guest contact details. Raises not_found for an unknown slug.';
