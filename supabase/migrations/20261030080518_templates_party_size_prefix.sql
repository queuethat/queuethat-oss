-- #93 follow-up: templates use party size bounds (#104) and per-service ticket prefixes (#103).
-- Restaurant: party size 1 to 12. Service counter: Registrations tickets read B001.
-- redefines private.industry_templates from 20261030071733_industry_templates.sql
create or replace function private.industry_templates() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'barber', jsonb_build_object(
      'name', 'Barber or salon', 'health_tagged', false,
      'description', 'One walk-in queue with haircut and beard services and three chairs.',
      'queues', jsonb_build_array(jsonb_build_object('name', 'Walk-ins', 'prefix', 'A', 'show_eta', true,
        'services', jsonb_build_array(
          jsonb_build_object('name', 'Haircut', 'minutes', 30),
          jsonb_build_object('name', 'Beard', 'minutes', 15)))),
      'resources', jsonb_build_array(
        jsonb_build_object('label', 'Chair 1', 'kind', 'chair'),
        jsonb_build_object('label', 'Chair 2', 'kind', 'chair'),
        jsonb_build_object('label', 'Chair 3', 'kind', 'chair'))),
    'clinic', jsonb_build_object(
      'name', 'Clinic', 'health_tagged', true,
      'description', 'Ticket numbers only, generic service names and two rooms. Names never appear on screens.',
      'queues', jsonb_build_array(jsonb_build_object('name', 'Reception', 'prefix', 'C', 'show_eta', false,
        'services', jsonb_build_array(
          jsonb_build_object('name', 'Appointment', 'minutes', 15),
          jsonb_build_object('name', 'Walk-in', 'minutes', 15)))),
      'resources', jsonb_build_array(
        jsonb_build_object('label', 'Room 1', 'kind', 'room'),
        jsonb_build_object('label', 'Room 2', 'kind', 'room'))),
    'restaurant', jsonb_build_object(
      'name', 'Restaurant', 'health_tagged', false,
      'description', 'A waitlist for parties of 1 to 12 with three tables.',
      'queues', jsonb_build_array(jsonb_build_object('name', 'Waitlist', 'prefix', 'W', 'show_eta', true,
        'party_min', 1, 'party_max', 12,
        'services', jsonb_build_array(jsonb_build_object('name', 'Table', 'minutes', 45)))),
      'resources', jsonb_build_array(
        jsonb_build_object('label', 'Table 1', 'kind', 'table', 'seats', 2),
        jsonb_build_object('label', 'Table 2', 'kind', 'table', 'seats', 4),
        jsonb_build_object('label', 'Table 3', 'kind', 'table', 'seats', 6))),
    'dmv_counter', jsonb_build_object(
      'name', 'Service counter', 'health_tagged', false,
      'description', 'Licences and registrations in one queue, three counters.',
      'queues', jsonb_build_array(jsonb_build_object('name', 'Counter service', 'prefix', 'A', 'show_eta', true,
        'services', jsonb_build_array(
          jsonb_build_object('name', 'Licences', 'minutes', 15),
          jsonb_build_object('name', 'Registrations', 'minutes', 15, 'prefix', 'B')))),
      'resources', jsonb_build_array(
        jsonb_build_object('label', 'Counter 1', 'kind', 'counter'),
        jsonb_build_object('label', 'Counter 2', 'kind', 'counter'),
        jsonb_build_object('label', 'Counter 3', 'kind', 'counter'))),
    'retail_repair', jsonb_build_object(
      'name', 'Retail or repair', 'health_tagged', false,
      'description', 'Drop-off and pick-up queue with two desks.',
      'queues', jsonb_build_array(jsonb_build_object('name', 'Service desk', 'prefix', 'R', 'show_eta', true,
        'services', jsonb_build_array(
          jsonb_build_object('name', 'Drop-off', 'minutes', 10),
          jsonb_build_object('name', 'Pick-up', 'minutes', 5)))),
      'resources', jsonb_build_array(
        jsonb_build_object('label', 'Desk 1', 'kind', 'desk'),
        jsonb_build_object('label', 'Desk 2', 'kind', 'desk'))),
    'events', jsonb_build_object(
      'name', 'Events and check-in', 'health_tagged', false,
      'description', 'A check-in queue with two desks, no wait estimates.',
      'queues', jsonb_build_array(jsonb_build_object('name', 'Check-in', 'prefix', 'E', 'show_eta', false,
        'services', jsonb_build_array(jsonb_build_object('name', 'Check-in', 'minutes', 2)))),
      'resources', jsonb_build_array(
        jsonb_build_object('label', 'Desk 1', 'kind', 'desk'),
        jsonb_build_object('label', 'Desk 2', 'kind', 'desk')))
  )
$$;
comment on function private.industry_templates() is
  'The six setup templates (barber, clinic, restaurant, dmv_counter, retail_repair, events) as '
  'jsonb keyed by template key: queues with prefixes and services, resources by kind, health_tagged.';


-- redefines api.apply_industry_template from 20261030071733_industry_templates.sql
create or replace function api.apply_industry_template(p_location_id uuid, p_template_key text, p_idempotency_key uuid)
returns api.template_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  tpl jsonb := private.industry_templates() -> p_template_key;
  claim record;
  q jsonb;
  s jsonb;
  r jsonb;
  v_queue app.queues;
  result api.template_result;
begin
  select * into loc from app.locations l where l.id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if tpl is null or p_idempotency_key is null then raise exception 'not_found'; end if;

  select * into claim from private.claim_idempotent(loc.org_id, 'apply_industry_template', p_idempotency_key);
  if claim.replay then
    if claim.response ->> 'template_key' is distinct from p_template_key then
      raise exception 'invalid_input'; -- the key was used for a different template
    end if;
    return jsonb_populate_record(null::api.template_result, claim.response);
  end if;
  if exists (select 1 from app.visits v
             where v.location_id = loc.id and v.service_day = private.service_day(loc.id)) then
    raise exception 'invalid_input' using detail = 'location_has_visits';
  end if;

  result := row(p_template_key, 0, 0, 0);
  if (tpl ->> 'health_tagged')::boolean then
    -- The tag covers the whole organization, so it needs an org-wide admin, not one scoped to a place.
    if not private.has_role(loc.org_id, null, 'admin') then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    update app.locations set display_names_enabled = false where org_id = loc.org_id and display_names_enabled;
    update app.organizations set health_tagged = true where id = loc.org_id;
  end if;

  for q in select * from jsonb_array_elements(tpl -> 'queues') loop
    -- Applying again, or after hand-made setup, never duplicates a queue of the same name.
    select * into v_queue from app.queues x
    where x.location_id = loc.id and x.archived_at is null and x.name = q ->> 'name';
    if not found then
      insert into app.queues (org_id, location_id, name, ticket_prefix, show_eta,
                              party_size_enabled, party_size_min, party_size_max)
      values (loc.org_id, loc.id, q ->> 'name', q ->> 'prefix', (q ->> 'show_eta')::boolean,
              q ? 'party_max', coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1))
      returning * into v_queue;
      result.queues_created := result.queues_created + 1;
    end if;
    for s in select * from jsonb_array_elements(q -> 'services') loop
      if not exists (select 1 from app.services x where x.queue_id = v_queue.id and x.name = s ->> 'name') then
        insert into app.services (org_id, location_id, queue_id, name, expected_minutes, ticket_prefix)
        values (loc.org_id, loc.id, v_queue.id, s ->> 'name', (s ->> 'minutes')::int, s ->> 'prefix');
        result.services_created := result.services_created + 1;
      end if;
    end loop;
  end loop;
  for r in select * from jsonb_array_elements(tpl -> 'resources') loop
    if not exists (select 1 from app.counters x
                   where x.location_id = loc.id and x.archived_at is null and x.label = r ->> 'label') then
      insert into app.counters (org_id, location_id, label, kind, seats)
      values (loc.org_id, loc.id, r ->> 'label', (r ->> 'kind')::app.resource_kind, (r ->> 'seats')::int);
      result.counters_created := result.counters_created + 1;
    end if;
  end loop;

  perform private.save_idempotent('apply_industry_template', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.apply_industry_template(uuid, text, uuid) is
  'Creates the template''s queues, services and counters in the location, skipping any with the '
  'same name already there. Owner or admin of the location; refuses (invalid_input, detail '
  'location_has_visits) when the location already has visits in the current service day. A clinic '
  'template tags the organization health_tagged and turns names off on displays for good. Raises '
  'not_found (unknown template or a location the caller cannot see), permission_denied (42501, a '
  'member below admin). Idempotent per key. Implemented by 2A-ORG4.';
