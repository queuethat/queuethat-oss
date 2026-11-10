-- 2A-ST4 (#137): visit notes, tags and the visit history (features S-8 and S-16).
--
-- Notes are free text and may hold personal data, so they live only on the visit (staff read them
-- through a column grant), never in an event payload, and retention clears them with the rest of
-- the visit's personal data. The event records which fields changed, not what they say.

create function private.valid_tags(p_tags text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(p_tags) <= 10
     and not exists (select 1 from unnest(p_tags) t where t is null or length(t) not between 1 and 24)
$$;
comment on function private.valid_tags(text[]) is
  'True for at most 10 tags of 1 to 24 characters each. The visits.tags check.';
revoke all on function private.valid_tags(text[]) from public, anon, authenticated;

alter table app.visits
  add column notes text check (notes is null or length(notes) between 1 and 1000),
  add column tags text[] not null default '{}' check (private.valid_tags(tags));
-- Staff of the location read both with the other visit columns (displays and kiosks never read
-- visits). Postgres gives a new column no privilege when the table has only column grants.
grant select (notes, tags) on app.visits to authenticated;
-- redefines app.staff_visits from 20261030063000_party_groups.sql
create or replace view app.staff_visits with (security_invoker = true) as
select
  v.id, v.org_id, v.location_id, v.queue_id, v.service_id, v.service_day,
  v.ticket_prefix, v.ticket_number, v.display_ticket, v.status, v.sort_key,
  v.party_size, v.guest_name, v.guest_id, v.contact_id, v.locale, v.source,
  v.counter_id, v.assigned_staff_id, v.call_count, v.eta_quoted_low, v.eta_quoted_high,
  v.joined_at, v.called_at, v.serving_at, v.finished_at, v.version,
  v.guest_phone_e164, v.guest_email,
  private.allowed_actions(v.status) as allowed_actions,
  v.assigned_counter_id,
  v.group_key,
  v.notes,
  v.tags
from app.visits v;

------------------------------------------------------------------------------------------------
-- api.update_visit_notes (signature and grants from 2A-API2)
------------------------------------------------------------------------------------------------

-- redefines api.update_visit_notes from 20261030045508_api_contracts_2a.sql
create or replace function api.update_visit_notes(
  p_visit_id uuid,
  p_notes text,
  p_tags text[],
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_notes text := nullif(btrim(p_notes), '');
  v_tags text[];
  v_changed text[] := '{}';
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or length(p_notes) > 2000
     or length(v_notes) > 1000 or cardinality(p_tags) > 50 then
    raise exception 'invalid_input';
  end if;
  if p_tags is not null then
    -- Trimmed, blanks dropped, duplicates (ignoring case) dropped, first spelling and order kept.
    select coalesce(array_agg(d.t order by d.o), '{}') into v_tags
    from (
      select distinct on (lower(btrim(u.x))) btrim(u.x) as t, u.o
      from unnest(p_tags) with ordinality as u(x, o)
      where btrim(u.x) <> ''
      order by lower(btrim(u.x)), u.o
    ) d;
    if not private.valid_tags(v_tags) then
      raise exception 'invalid_input';
    end if;
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'update_visit_notes', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  -- Retention has cleared this visit; text added now would never be cleared again.
  if v.anonymized_at is not null then
    raise exception 'invalid_input';
  end if;

  -- A null argument leaves that field as it is; '' or '{}' clears it.
  if p_notes is not null and v_notes is distinct from v.notes then
    v_changed := v_changed || array['notes'];
  end if;
  if p_tags is not null and v_tags is distinct from v.tags then
    v_changed := v_changed || array['tags'];
  end if;
  if cardinality(v_changed) = 0 then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('update_visit_notes', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'notes_updated', null,
                            jsonb_build_object('changed', to_jsonb(v_changed)));
  update app.visits
  set notes = case when p_notes is not null then v_notes else notes end,
      tags = case when p_tags is not null then v_tags else tags end
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('update_visit_notes', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.update_visit_notes(uuid, text, text[], int, uuid) is
  'Sets the staff-only notes (up to 1000 characters) and tags (up to 10, 1 to 24 characters each, '
  'trimmed and de-duplicated ignoring case) of a visit in any status, and records a notes_updated '
  'event naming the changed fields, never their text. A null notes or tags leaves that field as it '
  'is; '''' or ''{}'' clears it. Refused (invalid_input) once retention has anonymized the visit. Staff read both from app.visits. Nothing changed is a no-op '
  '(last_event_id null). Staff of the location. Raises stale_visit, invalid_input (over-long notes, '
  'too many or over-long tags, no version or key), not_found for unknown or foreign visits. '
  'Idempotent per key. Implemented in 2A-ST4 (#137).';

------------------------------------------------------------------------------------------------
-- api.visit_history (signature and grants from 2A-API2)
------------------------------------------------------------------------------------------------

-- redefines api.visit_history from 20261030045508_api_contracts_2a.sql
create or replace function api.visit_history(p_visit_id uuid)
returns setof api.visit_history_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
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
comment on function api.visit_history(uuid) is
  'Everything that happened to a visit, oldest first: its events with who did them (actor_label is '
  'the member''s display name, else the part of their email before the @; ''Guest'', ''Display'', '
  '''Kiosk'', ''Support'', ''System''; an operator name when one was set) and a summary of the '
  'payload without personal data, then the notifications sent for it (type ''notification'': '
  'channel, template, status, error_code, never a recipient). Staff of the location. Raises '
  'not_found for unknown or foreign visits. Implemented in 2A-ST4 (#137).';

------------------------------------------------------------------------------------------------
-- Retention clears notes with the rest of a visit's personal data
------------------------------------------------------------------------------------------------

-- redefines private.anonymize_visits from 20261030065000_retention.sql
create or replace function private.anonymize_visits(p_org_id uuid, p_visit_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_ids uuid[];
begin
  perform private.set_actor('system', null, 'anonymized', 'retention');
  with u as (
    update app.visits set guest_name = null, guest_id = null, contact_id = null,
                          guest_phone_e164 = null, guest_email = null, device_key_hash = null,
                          notes = null, tags = '{}', anonymized_at = now()
    where org_id = p_org_id and id = any (p_visit_ids) and anonymized_at is null
    returning id
  )
  select array_agg(id) into v_ids from u;
  if v_ids is null then
    return 0;
  end if;
  perform set_config('app.retention', 'on', true);
  update app.visit_events
  set payload = payload - array['name', 'guest_name', 'first_name', 'phone', 'phone_e164', 'email',
                                'contact', 'answers']
  where org_id = p_org_id and visit_id = any (v_ids);
  perform set_config('app.retention', '', true);
  update app.notifications set vars = '{}', recipient_hash = null
  where org_id = p_org_id and visit_id = any (v_ids);
  return cardinality(v_ids);
end $$;
comment on function private.anonymize_visits(uuid, uuid[]) is
  'Strips personal data from visits of one org (see body), notes included; one anonymized event '
  'each. Idempotent. Used by the retention job and guest erasure. Not exposed.';

notify pgrst, 'reload schema';
