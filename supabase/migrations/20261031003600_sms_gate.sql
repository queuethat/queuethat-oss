-- X1 follow-up: the text opt-in is offered only where SMS is switched on for the business.
--
-- Expand-only: api.location_public gains a trailing `sms_enabled`. The join page uses it to show
-- the opt-in checkbox; api.visit_status.text_consent says `unavailable` (instead of `off`) while
-- SMS is off, so the status page does not offer it; api.location_channels tells the staff console
-- the same for its add-guest form. One predicate (private.channel_enabled) owns the rule.
-- Alternatives considered: a column on app.locations kept in sync with provider_settings
-- (duplicated knowledge), or letting staff read provider_settings (admin-only secrets table).

create function private.channel_enabled(p_org_id uuid, p_channel text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.enabled from app.provider_settings s where s.org_id = p_org_id and s.channel = p_channel), false)
$$;
revoke all on function private.channel_enabled(uuid, text) from public, anon, authenticated;
comment on function private.channel_enabled(uuid, text) is
  'True when the org has switched the channel on (api.set_channel_enabled checked its prerequisites then).';

alter type api.location_public add attribute sms_enabled boolean;

-- redefines api.get_location_public from 20261030184447_location_routing_flag.sql
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
         (select o.retention_days from app.organizations o where o.id = l.org_id),
         exists (select 1 from app.routing_rules rr join app.queues tq on tq.id = rr.target_queue_id and tq.archived_at is null
                 where rr.location_id = l.id and rr.active),
         private.channel_enabled(l.org_id, 'sms')
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
  'no guest data. retention_days is how long the business keeps guest contact details. routing is true when the location has an active routing rule aimed at a live queue: the join page then offers a service picker and joins the location rather than a queue (api.join_queue with p_location_id). sms_enabled is true when the business has switched text messages on (the join page offers the text opt-in only then). Raises not_found for an unknown slug.';

-- redefines private.text_consent_state from 20261030224546_consent_ui.sql
create or replace function private.text_consent_state(p_visit app.visits) returns text
language sql stable set search_path = '' as $$
  select case
    when p_visit.guest_phone_e164 is null and p_visit.contact_id is null then 'none'
    when coalesce((select c.status = 'granted' and c.revoked_at is null
                   from app.consents c
                   where c.contact_id = p_visit.contact_id and c.channel = 'sms' and c.purpose = 'transactional'
                   order by c.captured_at desc limit 1), false) then 'on'
    when not private.channel_enabled(p_visit.org_id, 'sms') then 'unavailable'
    else 'off'
  end
$$;
comment on function private.text_consent_state(app.visits) is
  'none: the visit has no number; on: the number has a granted sms consent; unavailable: a number without consent while the business has texts switched off; off: a number without consent that could opt in.';

create function api.location_channels(p_location_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c order by c), '{}')
  from app.locations l, unnest(array['email', 'sms', 'whatsapp']) c
  where l.id = p_location_id and private.has_role(l.org_id, l.id, 'staff') and private.channel_enabled(l.org_id, c)
$$;
revoke all on function api.location_channels(uuid) from public, anon;
grant execute on function api.location_channels(uuid) to authenticated, service_role;
comment on function api.location_channels(uuid) is
  'The channels (email, sms, whatsapp) the business has switched on, for staff of the location; empty for anyone else. The add-guest form offers the text opt-in only when sms is in it.';

comment on function api.guest_grant_consent(text, text, int, text, text) is
  'Grants a transactional sms or whatsapp consent for the token''s open visit. The server renders the '
  'published text and refuses a different hash (consent_text_mismatch); the consent stores the version, '
  'hash and locale. Unknown, expired or ended-visit tokens raise the same not_found as get_visit_status; '
  'invalid_input without a phone or over GET; contact_suppressed for an opted-out number or one the org already holds for another guest (a typed number is unverified); rate_limited '
  'after 10 granted calls per visit per hour (a failed call raises, which rolls back its own attempt row, so only grants count; '
  'a visit''s number is fixed at join, so repeating a failed call on one visit repeats the same answer; what bounds probing of the org''s numbers through contact_suppressed is join_queue''s per-client, per-network and per-queue join limits, one join per number tested). A repeat returns the existing consent. Implemented in 3-CG5 (#330).';
