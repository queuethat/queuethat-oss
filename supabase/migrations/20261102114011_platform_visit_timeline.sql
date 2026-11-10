-- PLT (#1136): visit search and event timeline for support, only under a live support grant.
--
-- A guest has no account (I-7), so when one complains the agent must see what happened to that one
-- visit, with the owner's consent. No new tenant-data path: the caller must hold a live grant
-- (private.support_grant: platform user, aal2, not a member, unrevoked, unexpired, 'read' or 'act'
-- or the operator's own break-glass), and every call writes a platform_audit row naming the grant.
-- Both functions are read-only and expose no contact data (I-13): no guest name, no answers, no
-- free-text reasons; recipients appear only as a masked value.
--
-- Interface alternatives (rule 7): (a) two read RPCs, search and timeline, here; (b) widen
-- platform_get_org to carry visits. (b) would put guest-adjacent data in a call that needs no
-- grant, so a grant check would fork inside one function. (a) keeps "no grant, no visit data".

create type api.platform_visit_hit as (
  visit_id uuid,
  display_ticket text,
  queue_id uuid,
  queue_name text,
  location_id uuid,
  location_name text,
  -- The location's local service day (computed in SQL from its time zone).
  service_day date,
  status api.visit_state,
  joined_at timestamptz,
  finished_at timestamptz
);

create type api.platform_visit_timeline as (
  visit_id uuid,
  display_ticket text,
  status api.visit_state,
  queue_name text,
  location_name text,
  -- IANA zone of the visit's location, so the console can show local time.
  tz text,
  service_day date,
  source text,
  party_size int,
  call_count int,
  joined_at timestamptz,
  finished_at timestamptz,
  -- The grant the lookup came through: {id, scope, reason, break_glass, created_at, expires_at}
  support_grant jsonb,
  -- Oldest first: [{id, type, from_status, to_status, actor_kind, occurred_at, undone,
  --   via_support, undoes_type}]. No actor ids, reasons or payloads beyond those keys.
  events jsonb,
  -- Oldest first: [{id, event_id, channel, template_key, category, status, attempts, error_code,
  --   created_at, updated_at, recipient}] where recipient is a masked value or the channel name.
  notifications jsonb
);
grant usage on type api.platform_visit_hit, api.platform_visit_timeline to authenticated;

/**
 * The caller's live support grant for the org, or permission_denied (42501). Same answer for an
 * unknown org, so the error never says whether a tenant exists.
 */
create function private.require_support_grant(p_org_id uuid) returns app.support_grants
language plpgsql stable set search_path = '' as $$
declare
  g app.support_grants;
begin
  perform private.require_platform('support');
  g := private.support_grant(p_org_id);
  if g.id is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return g;
end $$;
comment on function private.require_support_grant(uuid) is
  'The live support grant the caller holds for the org, or permission_denied (42501) without a '
  'platform role, an aal2 session, or an unrevoked, unexpired grant open to them.';

create function api.platform_search_visits(
  p_org_id uuid,
  p_ticket text default null,
  p_service_day date default null,
  p_queue_id uuid default null,
  p_status api.visit_state default null,
  p_limit int default 25
) returns setof api.platform_visit_hit
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.support_grants;
  v_ticket text := nullif(btrim(p_ticket), '');
  v_number int;
begin
  g := private.require_support_grant(p_org_id);
  if p_limit is null or p_limit not between 1 and 50 or length(coalesce(v_ticket, '')) > 20 then
    raise exception 'invalid_input';
  end if;
  -- "42" and "A042" both find ticket A042; a number too long for a ticket matches nothing.
  if v_ticket ~ '^[0-9]{1,9}$' then
    v_number := v_ticket::int;
  end if;

  perform private.platform_audit(
    'support.visit_search', p_org_id,
    jsonb_build_object('support_grant_id', g.id, 'break_glass', g.break_glass,
                       'ticket', v_ticket, 'service_day', p_service_day,
                       'queue_id', p_queue_id, 'status', p_status),
    g.reason);

  return query
  select v.id, v.display_ticket, v.queue_id, q.name, v.location_id, l.name, v.service_day,
         v.status, v.joined_at, v.finished_at
  from app.visits v
  join app.queues q on q.id = v.queue_id
  join app.locations l on l.id = v.location_id
  where v.org_id = p_org_id
    and (v_ticket is null
         or lower(v.display_ticket) = lower(v_ticket)
         or (v_number is not null and v.ticket_number = v_number))
    and (p_service_day is null or v.service_day = p_service_day)
    and (p_queue_id is null or v.queue_id = p_queue_id)
    and (p_status is null or v.status = p_status)
  order by v.joined_at desc, v.id
  limit p_limit;
end $$;
comment on function api.platform_search_visits(uuid, text, date, uuid, api.visit_state, int) is
  'Support or operator (aal2) holding a live support grant for the org: its visits, newest first, '
  'filtered by ticket ("42" or "A042"), local service day, queue and status; at most p_limit '
  '(1-50). Returns ticket, queue, location, status and times only, never a guest name or '
  'contact. Each call is audited in platform_audit with the grant id. Raises permission_denied '
  '(42501) without a live grant, an aal2 session or a platform role (also for an unknown org), '
  'invalid_input for a bad limit or a ticket over 20 characters.';

create function api.platform_visit_timeline(p_org_id uuid, p_visit_id uuid)
returns api.platform_visit_timeline
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.support_grants;
  v app.visits;
  result api.platform_visit_timeline;
begin
  g := private.require_support_grant(p_org_id);
  -- The org id scopes the lookup: a visit of another tenant is not_found, not leaked.
  select * into v from app.visits where id = p_visit_id and org_id = p_org_id;
  if not found then
    raise exception 'not_found';
  end if;

  perform private.platform_audit(
    'support.visit_timeline', p_org_id,
    jsonb_build_object('support_grant_id', g.id, 'break_glass', g.break_glass, 'visit_id', v.id),
    g.reason);

  result.visit_id := v.id;
  result.display_ticket := v.display_ticket;
  result.status := v.status;
  select q.name into result.queue_name from app.queues q where q.id = v.queue_id;
  select l.name, l.tz into result.location_name, result.tz from app.locations l where l.id = v.location_id;
  result.service_day := v.service_day;
  result.source := v.source;
  result.party_size := v.party_size;
  result.call_count := v.call_count;
  result.joined_at := v.joined_at;
  result.finished_at := v.finished_at;
  result.support_grant := jsonb_build_object(
    'id', g.id, 'scope', g.scope, 'reason', g.reason, 'break_glass', g.break_glass,
    'created_at', g.created_at, 'expires_at', g.expires_at);

  result.events := coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'type', e.type, 'from_status', e.from_status, 'to_status', e.to_status,
             'actor_kind', e.actor_kind, 'occurred_at', e.occurred_at,
             'undone', e.undone_by_event_id is not null,
             'via_support', e.payload ? 'support_grant_id',
             'undoes_type', e.payload ->> 'undoes_type') order by e.id)
    from app.visit_events e where e.visit_id = v.id and e.org_id = v.org_id), '[]');

  -- error_code is shown only when it looks like a code, so a provider message can't carry a number.
  -- Contact values come only as a masked phone or email; any other channel shows its name.
  result.notifications := coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', n.id, 'event_id', n.event_id, 'channel', n.channel,
             'template_key', n.template_key, 'category', n.category, 'status', n.status,
             'attempts', n.attempts, 'error_code', case when n.error_code ~ '^[a-z0-9_.:-]{1,40}$' then n.error_code end,
             'created_at', n.created_at, 'updated_at', n.updated_at,
             'recipient', coalesce(
               case c.channel
                 when 'phone' then private.mask_contact(c.channel, c.value)
                 when 'email' then private.mask_contact(c.channel, c.value)
               end,
               n.channel::text)) order by n.created_at, n.id)
    from app.notifications n
    left join app.guest_contacts c on c.id = n.recipient_ref and c.org_id = n.org_id
    where n.visit_id = v.id and n.org_id = v.org_id), '[]');

  return result;
end $$;
comment on function api.platform_visit_timeline(uuid, uuid) is
  'Support or operator (aal2) holding a live support grant for the org: one visit''s summary, its '
  'visit_events oldest first (type, statuses, actor kind, undone, whether support made it) and '
  'the notifications sent for it (channel, template, status, masked recipient), plus the grant '
  'it came through. No guest name, contact, answers or free-text reasons. Each call is audited '
  'in platform_audit with the grant and visit. Raises permission_denied (42501) without a live '
  'grant, an aal2 session or a platform role (also for an unknown org), not_found for an '
  'unknown visit or one of another org.';

revoke all on function private.require_support_grant(uuid) from public, anon, authenticated;
revoke all on function api.platform_search_visits(uuid, text, date, uuid, api.visit_state, int)
  from public, anon;
revoke all on function api.platform_visit_timeline(uuid, uuid) from public, anon;
grant execute on function api.platform_search_visits(uuid, text, date, uuid, api.visit_state, int)
  to authenticated;
grant execute on function api.platform_visit_timeline(uuid, uuid) to authenticated;
