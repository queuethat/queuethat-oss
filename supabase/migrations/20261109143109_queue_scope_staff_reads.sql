-- M2c-1 (#1339): the queue scope from M1/M2/M2b also binds the staff reads that return guest data:
-- visit_history, visit_text_states, list_visit_notifications, guest_badges, find_visit_by_scan_code and
-- search_visits. With organizations.scope_staff_to_lines off nothing changes. With it on, a scoped staff
-- member gets not_found for a visit outside their queue_ids, and list/search results hold only rows from
-- their queues; unscoped staff, managers and above are unaffected. Signatures, grants and comments stay.
--
-- Alternatives (rule 7): leave the reads to RLS only (rejected: these are security definer and bypass it)
-- vs the same has_queue_access test beside each function's has_role test or row filter (chosen, as in M2).
-- guest_badges still counts a guest's visits across every queue: the badge is a count, not a row.

-- redefines api.visit_history from 20261030073600_notes_history.sql
create or replace function api.visit_history(p_visit_id uuid)
returns setof api.visit_history_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;

  return query
  select h.occurred_at, h.type, h.from_status, h.to_status, h.actor_kind, h.actor_label, h.reason, h.summary
  from (
    select e.occurred_at, e.id as ord, 0 as src,
           e.type, e.from_status, e.to_status, e.actor_kind::text as actor_kind,
           coalesce(
             e.payload ->> 'operator_name',
             case e.actor_kind::text
               when 'guest' then 'Guest'
               when 'system' then 'System'
               when 'platform' then 'Support'
               when 'device' then case (select d.kind::text from app.devices d
                                        where d.auth_user_id = e.actor_id and d.org_id = e.org_id)
                                    when 'kiosk' then 'Kiosk' else 'Display' end
               else coalesce(
                      (select m.display_name from app.memberships m
                       where m.org_id = e.org_id and m.user_id = e.actor_id),
                      (select split_part(u.email, '@', 1) from auth.users u
                       where u.id = e.actor_id
                         and exists (select 1 from app.memberships m
                                     where m.org_id = e.org_id and m.user_id = u.id)),
                      'Staff')
             end) as actor_label,
           e.reason,
           -- Personal data is never in a summary: contact and name keys are dropped, and notes
           -- are never in a payload at all.
           (e.payload - array['name', 'guest_name', 'first_name', 'phone', 'phone_e164', 'email',
                              'contact', 'answers', 'notes', 'operator_name'])
             || case when e.undone_by_event_id is not null then '{"undone": true}'::jsonb else '{}'::jsonb end
             as summary
    from app.visit_events e
    where e.visit_id = v.id
    union all
    -- What was sent to the guest and how it went; never where it went.
    select n.created_at, 0, 1, 'notification', null, null, 'system', 'System', null,
           jsonb_strip_nulls(jsonb_build_object('channel', n.channel, 'template', n.template_key,
                                                'status', n.status, 'error_code', n.error_code))
    from app.notifications n
    where n.visit_id = v.id and n.org_id = v.org_id
  ) h
  order by h.occurred_at, h.src, h.ord;
end $$;

-- redefines api.visit_text_states from 20261030230921_visit_text_states.sql
create or replace function api.visit_text_states(p_location_id uuid) returns table (visit_id uuid, text_state text)
language sql stable security definer set search_path = '' as $$
  select v.id,
         case
           when coalesce(v.guest_phone_e164, gc.value) is null then 'none'
           when exists (select 1 from app.suppressions sp
                        where sp.org_id = v.org_id and sp.channel = 'sms'
                          and sp.value = coalesce(v.guest_phone_e164, gc.value)) then 'opted_out'
           when coalesce((select c.status = 'granted' and c.revoked_at is null
                          from app.consents c
                          where c.contact_id = v.contact_id and c.channel = 'sms' and c.purpose = 'transactional'
                          order by c.captured_at desc limit 1), false) then 'on'
           else 'no_consent'
         end
  from app.visits v
  left join app.guest_contacts gc on gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone'
  where v.location_id = p_location_id
    and private.has_queue_access(v.org_id, v.queue_id, 'staff')
    and v.status in ('expected', 'waiting', 'called', 'serving')
$$;

-- redefines api.list_visit_notifications from 20261030172909_delivery_status.sql
create or replace function api.list_visit_notifications(p_visit_id uuid) returns setof api.notification_status
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  return query
    select (private.notification_status_row(n)).* from app.notifications n
    where n.visit_id = v.id and n.org_id = v.org_id
    order by n.created_at, n.id;
end $$;

-- redefines api.guest_badges from 20261030064100_guest_rpcs_crm.sql
create or replace function api.guest_badges(p_visit_ids uuid[]) returns setof api.guest_badge
language plpgsql stable security definer set search_path = '' as $$
begin
  if cardinality(p_visit_ids) > 200 then
    raise exception 'invalid_input';
  end if;
  return query
  select v.id, s.n, s.last_at, s.n > 1
  from app.visits v
  cross join lateral (
    select count(*)::int as n, max(h.joined_at) as last_at from app.visits h where h.guest_id = v.guest_id
  ) s
  where v.id = any (p_visit_ids) and v.guest_id is not null
    and private.has_queue_access(v.org_id, v.queue_id, 'staff');
end $$;

-- redefines api.find_visit_by_scan_code from 20261030073517_visit_info.sql
create or replace function api.find_visit_by_scan_code(p_location_id uuid, p_code text)
returns api.visit_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits
  where location_id = p_location_id and scan_code = upper(btrim(coalesce(p_code, '')));
  -- One answer for an unknown code, another tenant's location, a past day and no access.
  if not found
     or not private.has_queue_access(v.org_id, v.queue_id, 'staff')
     or v.service_day is distinct from private.service_day(v.location_id) then
    raise exception 'not_found';
  end if;
  return private.visit_row(v.id);
end $$;

-- redefines api.search_visits from 20261030062132_search_visits.sql
create or replace function api.search_visits(p_location_id uuid, p_query text, p_days int default 1, p_limit int default 20)
returns setof api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  v_q text := btrim(coalesce(p_query, ''));
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_phone boolean;
  v_like text;
  v_from date;
begin
  select * into loc from app.locations where id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_days is null or p_days not between 1 and 7 or p_limit is null or p_limit < 1
     or length(v_q) < 2 or length(v_q) > 80 then
    raise exception 'invalid_input';
  end if;

  -- A query made only of digits and phone punctuation is a phone number; under four digits it
  -- matches tickets and names only, never a phone.
  v_phone := v_q ~ '^[0-9+()[:space:].-]+$' and length(v_digits) >= 4;

  -- Serialize one user's calls so parallel connections cannot all pass the count. Limits: 30
  -- calls a minute per user, 10 phone-mode calls a minute per user and 120 a minute per
  -- location, so many accounts cannot walk the digit space of a location's phones either.
  perform pg_advisory_xact_lock(hashtextextended((select auth.uid())::text, 0));
  insert into private.search_log (user_id, location_id, phone) values ((select auth.uid()), loc.id, v_phone);
  if (select count(*) from private.search_log
      where user_id = (select auth.uid()) and at > now() - interval '1 minute') > 30
     or (v_phone and (select count(*) from private.search_log
                      where user_id = (select auth.uid()) and phone and at > now() - interval '1 minute') > 10)
     or (select count(*) from private.search_log
         where location_id = loc.id and at > now() - interval '1 minute') > 120 then
    raise exception 'rate_limited';
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_from := private.service_day(loc.id) - (p_days - 1);

  return query
    select (private.visit_row(x.id)).*
    from (
      select v.id, v.joined_at
      from app.visits v
      left join app.services s on s.id = v.service_id
      where v.location_id = loc.id and v.org_id = loc.org_id and v.service_day >= v_from
        and private.has_queue_access(v.org_id, v.queue_id, 'staff')
        and (v.guest_name ilike v_like
             or v.display_ticket ilike v_like
             or s.name ilike v_like
             or (v_phone and exists (
                   select 1 from app.guest_contacts c
                   where c.id = v.contact_id and c.org_id = v.org_id and c.channel = 'phone'
                     and right(c.value, length(v_digits)) = v_digits)))
      order by v.joined_at desc, v.id
      limit least(p_limit, 50)
    ) x
    order by x.joined_at desc, x.id;
end $$;
;
