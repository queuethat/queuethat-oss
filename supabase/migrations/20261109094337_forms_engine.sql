-- F2 (#1278): the forms engine and join (epic #1267, design forms-privacy-design.md 2.2).
--
-- A queue's intake fields become a "Queue default form" (version 1, published) per queue. The join
-- resolves the form for (queue, service), validates the guest's answers against that published
-- version, and records the version and the answers in app.form_responses. Expand step: app.intake_fields
-- and app.visit_answers stay and are still written (contract comes after the soak, I-12), so the
-- staff console keeps working; a trigger republishes the queue default form on every intake edit
-- until F6 retires the intake editor.
--
-- redefines private.anonymize_visits from 20261109081804_retention_cap.sql
-- redefines private.validate_answers from 20261109081353_sensitive_guards.sql
-- redefines private.join_core from 20261031030425_ivr_join.sql
-- redefines private.anonymize_visits from 20261109081804_retention_cap.sql: also deletes form responses
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
  delete from app.visit_companions where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.visit_messages where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.visit_answers where org_id = p_org_id and visit_id = any (v_ids);
  delete from app.form_responses where org_id = p_org_id and visit_id = any (v_ids);
  update app.visit_feedback set comment = null where org_id = p_org_id and visit_id = any (v_ids);
  return cardinality(v_ids);
end $$;
comment on function private.anonymize_visits(uuid, uuid[]) is
  'Strips personal data from visits of one org (see body), notes, companions, chat messages, intake '
  'answers (also form responses) and feedback comments included; one anonymized event each. Idempotent. Used by the '
  'retention job and guest erasure. Not exposed.';

-- redefines api.set_visit_answers from 20261030084501_intake_fields.sql
--
-- Field shape in app.form_versions.fields (same keys as app.intake_fields so one validator serves both):
-- key, label, help, type, options, required, visibility (guest|staff_only), position, sensitivity.

-- The active intake fields of a queue as a form-version field list.
create function private.intake_snapshot(p_queue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'key', f.key, 'label', f.label, 'help', f.help, 'type', f.type, 'options', f.options,
           'required', f.required, 'visibility', f.visibility, 'position', f.position,
           'sensitivity', f.sensitivity)) order by f.position, f.key), '[]')
  from app.intake_fields f
  where f.queue_id = p_queue_id and f.active
$$;
comment on function private.intake_snapshot(uuid) is
  'The active intake fields of a queue as a jsonb array in the shape of app.form_versions.fields.';
revoke all on function private.intake_snapshot(uuid) from public, anon, authenticated;

-- Creates the queue default form on first use and publishes a new version when the fields changed.
create function private.sync_queue_default_form(p_queue_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  q app.queues;
  v_form uuid;
  v_fields jsonb;
  v_ver int;
  v_last jsonb;
begin
  select * into q from app.queues where id = p_queue_id;
  if not found then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('queue_form:' || p_queue_id::text, 0));
  v_fields := private.intake_snapshot(p_queue_id);
  select t.form_id into v_form from app.form_targets t
  where t.queue_id = p_queue_id and t.channel = 'any';
  if v_form is not null and not (select f.is_queue_default from app.forms f where f.id = v_form) then
    return; -- a library form replaced the default for this queue; intake edits no longer apply
  end if;
  if v_form is null then
    if v_fields = '[]' then
      return;
    end if;
    insert into app.forms (org_id, location_id, name, status, is_queue_default)
    values (q.org_id, q.location_id, 'Queue default form', 'published', true)
    returning id into v_form;
    insert into app.form_targets (org_id, location_id, form_id, queue_id, channel)
    values (q.org_id, q.location_id, v_form, q.id, 'any');
  end if;
  select v.version, v.fields into v_ver, v_last from app.form_versions v
  where v.form_id = v_form order by v.version desc limit 1;
  if v_last is distinct from v_fields then
    insert into app.form_versions (org_id, location_id, form_id, version, fields, published_at)
    values (q.org_id, q.location_id, v_form, coalesce(v_ver, 0) + 1, v_fields, now());
  end if;
end $$;
comment on function private.sync_queue_default_form(uuid) is
  'Keeps the queue''s default form equal to its active intake fields: creates form and queue target '
  'on first fields, publishes a new immutable version when the fields differ. No-op when a library '
  'form is attached to the queue instead.';
revoke all on function private.sync_queue_default_form(uuid) from public, anon, authenticated;

-- Definer: the manager editing intake fields cannot write app.forms (reads only for authenticated).
create function private.sync_intake_form() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform private.sync_queue_default_form(old.queue_id);
  else
    perform private.sync_queue_default_form(new.queue_id);
    if tg_op = 'UPDATE' then
      if old.queue_id <> new.queue_id then
        perform private.sync_queue_default_form(old.queue_id); -- a field moved to another queue
      end if;
    end if;
  end if;
  return null;
end $$;
comment on function private.sync_intake_form() is
  'AFTER trigger on app.intake_fields: republishes the queue default form (private.sync_queue_default_form).';
revoke all on function private.sync_intake_form() from public, anon, authenticated;
create trigger sync_intake_form after insert or update or delete on app.intake_fields
  for each row execute function private.sync_intake_form();

-- Backfill: every queue with intake fields gets its default form, version 1.
select private.sync_queue_default_form(q.id) from app.queues q
where exists (select 1 from app.intake_fields f where f.queue_id = q.id and f.active);

-- The published version a join on (queue, service) uses: a service target beats the queue target,
-- a walk_in target beats 'any'. Null when no form is attached (the queue asks nothing).
create function private.resolve_form(p_queue_id uuid, p_service_id uuid) returns uuid
language sql stable set search_path = '' as $$
  select v.id
  from app.queues q
  join app.form_targets t on t.org_id = q.org_id and t.location_id = q.location_id
       and (t.queue_id = q.id or (p_service_id is not null and t.service_id = p_service_id))
       and t.channel in ('any', 'walk_in')
  cross join lateral (
    select fv.id from app.form_versions fv
    where fv.form_id = t.form_id and fv.published_at is not null
    order by fv.version desc limit 1
  ) v
  where q.id = p_queue_id
  order by (t.service_id is not null) desc, (t.channel = 'walk_in') desc
  limit 1
$$;
comment on function private.resolve_form(uuid, uuid) is
  'Id of the latest published form version for a walk-in on (queue, service): a service target beats '
  'the queue target, a walk_in channel beats any; targets of another location are never used. Null '
  'when no form is attached.';
revoke all on function private.resolve_form(uuid, uuid) from public, anon, authenticated;

-- Validates answers against a field list (a form version's fields). Moved from validate_answers,
-- which read app.intake_fields rows; jsonb_populate_recordset gives the same row shape.
create function private.validate_form_answers(p_org_id uuid, p_fields jsonb, p_answers jsonb, p_audience text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  a jsonb := coalesce(p_answers, '{}');
  f app.intake_fields;
  k text;
  val jsonb;
  s text;
  out jsonb := '{}';
begin
  if p_audience not in ('guest', 'staff') then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(a) = 'null' then
    a := '{}';
  end if;
  -- Bounded before any work: a form has at most 20 fields, so more keys cannot all be valid.
  if jsonb_typeof(a) <> 'object' or octet_length(a::text) > 16384 then
    raise exception 'invalid_answers' using detail = '';
  end if;

  -- Every key must name a field of the version that this audience may answer.
  for k in select jsonb_object_keys(a) loop
    select * into f from jsonb_populate_recordset(null::app.intake_fields, p_fields) x where x.key = k;
    if not found or (p_audience = 'guest' and f.visibility = 'staff_only') then
      -- Echo only what looks like a field key, never arbitrary guest text.
      raise exception 'invalid_answers' using detail = case when k ~ '^[a-z][a-z0-9_]{0,39}$' then k else '' end;
    end if;
  end loop;

  for f in select * from jsonb_populate_recordset(null::app.intake_fields, p_fields) x order by x.position, x.key loop
    val := a -> f.key;
    -- null, an empty string and false count as not answered
    if val is null or val = 'null'::jsonb or (f.type = 'checkbox' and val = 'false'::jsonb)
       or (jsonb_typeof(val) = 'string' and btrim(val #>> '{}') = '') then
      if f.required and p_audience = 'guest' and f.visibility = 'guest' then
        raise exception 'invalid_answers' using detail = f.key;
      end if;
      continue;
    end if;

    case f.type
      when 'text' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = f.key; end if;
        s := btrim(val #>> '{}');
        if length(s) > 500 or s ~ '[[:cntrl:]]' then raise exception 'invalid_answers' using detail = f.key; end if;
        perform private.sensitive_guard(s, 'invalid_answers', f.key);
        -- A health-tagged org collects a sensitive answer as a short reason only.
        if f.sensitivity = 'sensitive' and length(s) > 200
           and (select o.health_tagged from app.organizations o where o.id = p_org_id) then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        if s <> '' then out := out || jsonb_build_object(f.key, s); end if;
      when 'select' then
        if jsonb_typeof(val) <> 'string' or not f.options @> jsonb_build_array(val) then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        out := out || jsonb_build_object(f.key, val);
      when 'checkbox' then
        if jsonb_typeof(val) <> 'boolean' then raise exception 'invalid_answers' using detail = f.key; end if;
        out := out || jsonb_build_object(f.key, val);
      when 'phone' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = f.key; end if;
        s := regexp_replace(val #>> '{}', '[[:space:]().-]', '', 'g');
        if s !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_answers' using detail = f.key; end if;
        out := out || jsonb_build_object(f.key, s);
      when 'number' then
        if jsonb_typeof(val) <> 'number' or abs((val #>> '{}')::numeric) > 1000000000000 then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        perform private.sensitive_guard(val #>> '{}', 'invalid_answers', f.key);
        out := out || jsonb_build_object(f.key, val);
      when 'date' then
        s := val #>> '{}';
        if jsonb_typeof(val) <> 'string' or s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception 'invalid_answers' using detail = f.key;
        end if;
        begin
          perform s::date;
        exception when others then
          raise exception 'invalid_answers' using detail = f.key;
        end;
        out := out || jsonb_build_object(f.key, s);
    end case;
  end loop;
  return out;
end $$;
comment on function private.validate_form_answers(uuid, jsonb, jsonb, text) is
  'Checks answers against a form version''s field list and returns them normalised (blank answers '
  'dropped, phones as E.164). p_audience guest (staff-only fields refused, required guest fields '
  'enforced) or staff (any field, nothing required). Unknown or wrongly typed answers raise '
  'invalid_answers with the failing key as DETAIL (never the value). Text is at most 500 characters '
  '(200 for a sensitive field of a health-tagged org); card and SIN/SSN numbers are refused.';
revoke all on function private.validate_form_answers(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- The old entry point, kept for its other callers: validates against the queue's default resolution.
create or replace function private.validate_answers(p_queue_id uuid, p_answers jsonb, p_audience text)
returns jsonb
language sql stable set search_path = '' as $$
  select private.validate_form_answers(
    q.org_id,
    coalesce((select fv.fields from app.form_versions fv where fv.id = private.resolve_form(q.id, null)), '[]'),
    p_answers, p_audience)
  from app.queues q where q.id = p_queue_id
$$;
comment on function private.validate_answers(uuid, jsonb, text) is
  'private.validate_form_answers against the form a walk-in on the queue (no service) would get; '
  'the queue''s active intake fields while only the default form exists.';
revoke all on function private.validate_answers(uuid, jsonb, text) from public, anon, authenticated;


-- redefines private.join_core from 20261031030425_ivr_join.sql
-- Verbatim copy of the latest body with the form resolution added (marked F2).
create or replace function private.join_core(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_source text,
  p_actor_kind app.actor_kind,
  p_actor_id uuid,
  p_device_key text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null,
  p_routing_rule_id uuid default null,
  p_arrive_after timestamptz default null,
  out visit_id uuid,
  out token text
)
language plpgsql volatile set search_path = '' as $$
declare
  q app.queues;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_party int := coalesce(p_party_size, 1);
  v_locale text := nullif(btrim(p_locale), '');
  v_device text := nullif(btrim(p_device_key), '');
  v_device_hash bytea;
  v_reason text;
  v_day date;
  v_number int;
  v_sort bigint;
  v_guest uuid;
  v_contact uuid;
  v_email_contact uuid;
  v_answers jsonb;
  v_form uuid;
  v_prefix text;
  v_class uuid;
  v_rule uuid;
  v_offset int;
  v_ref bytea;
  v_other uuid;
  v_scope app.single_active_scope;
  v_warn boolean := false;
  prior app.visits;
  l app.locations;
begin
  -- Input. Blank name, phone, email, locale or device key count as not given.
  if p_idempotency_key is null
     or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     -- Plain ASCII local@domain only (#479 re-review): no quoted local parts, comments, IP
     -- literals, trailing dots or look-alike letters, so canonical_email and the block list see
     -- every address the way mail servers route it.
     or length(v_email) > 254
     or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$'
     or v_party not between 1 and 50
     or length(v_locale) > 35 or v_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
     or v_device !~ '^[A-Za-z0-9_-]{22,128}$' then
    raise exception 'invalid_input';
  end if;
  -- Only an online join is one person's phone; a kiosk or a staff device serves many guests.
  if p_source <> 'online' then
    v_device := null;
  end if;

  -- FOR NO KEY UPDATE, first: joins to one queue run one at a time from here, so the capacity
  -- and rate counts below see every committed join and a repeated key or device finds the first
  -- visit; set_queue_state waits for in-flight joins; and bump_queue_version below needs no
  -- upgrade (upgrading from FOR SHARE deadlocks two concurrent joins).
  select * into q from app.queues where id = p_queue_id and archived_at is null for no key update;
  if not found then
    raise exception 'not_found';
  end if;
  if p_source = 'kiosk' and not private.is_device(q.org_id, q.location_id) then
    raise exception 'not_found';
  end if;
  v_prefix := q.ticket_prefix;
  if p_service_id is not null then
    -- 2A-Q4: a service's own prefix overrides the queue's; numbers run per prefix.
    select coalesce(s.ticket_prefix, q.ticket_prefix) into v_prefix
    from app.services s where s.id = p_service_id and s.queue_id = q.id and s.active;
    if not found then
      raise exception 'not_found';
    end if;
  end if;
  v_device_hash := private.device_key_hash(q.id, v_device);

  -- The same key again, or the same phone with an active visit here: that visit, unchanged.
  select * into prior from app.visits v
  where v.queue_id = q.id and v.idempotency_key = p_idempotency_key;
  -- A group join (2A-J15A) is several people from one device: only the key replays it.
  if not found and v_device_hash is not null and p_group_key is null then
    select * into prior from app.visits v
    where v.queue_id = q.id and v.device_key_hash = v_device_hash
      and v.status in ('waiting', 'called', 'serving')
    order by v.joined_at desc
    limit 1;
  end if;
  if prior.id is not null then
    visit_id := prior.id;
    -- The token goes back only to the caller that joined: the same source (never a staff add's
    -- token to a guest) and, online, the same device. Staff can read idempotency keys, so the key
    -- alone must not return a guest's link. And only when it is the derived one (older visits').
    token := private.visit_token(prior.id, prior.idempotency_key);
    if p_source = 'staff' or prior.source is distinct from p_source
       or (p_source = 'online' and (v_device_hash is null or prior.device_key_hash is distinct from v_device_hash))
       or private.token_hash(token) is distinct from prior.guest_token_hash then
      token := null;
    end if;
    return;
  end if;

  v_reason := private.queue_not_accepting_reason(q.id);
  if v_reason = 'full' then
    raise exception 'capacity_reached';
  elsif v_reason = 'org_suspended' then
    raise exception 'org_suspended';
  elsif v_reason is not null then
    raise exception 'queue_not_accepting' using detail = v_reason;
  end if;

  -- 2A-JN5: public joins to a location that requires it must type the code on its TV (current or
  -- previous window). Checked after the accepting predicate and before any rate slot is taken, so
  -- a wrong code costs the caller nothing but the answer. Kiosk and staff joins are exempt.
  if p_source = 'online' then
    select * into l from app.locations where id = q.location_id;
    if l.onsite_code_required or q.join_restriction = 'onsite_code' then
      if nullif(btrim(p_onsite_code), '') is null then
        raise exception 'onsite_code_required';
      elsif btrim(p_onsite_code) not in (private.onsite_code(l.id, now()),
                                         private.onsite_code(l.id, now() - make_interval(mins => l.onsite_code_rotate_minutes))) then
        raise exception 'onsite_code_invalid';
      end if;
    end if;
  end if;

  -- PLT8: a contact blocked across the platform gets the same answer as a per-client flood, so an
  -- abuser learns nothing. Staff adds are exempt (design 3.5: staff joins carry a block-list override).
  if p_source <> 'staff' and private.is_blocked(q.org_id, v_phone, v_email) then
    raise exception 'rate_limited' using detail = 'client';
  end if;

  -- 2P-PRV5: this org's own block list (phone, email, device). Online and kiosk joins get the answer
  -- a closed queue gives, so an abuser learns nothing; a staff add is refused with guest_blocked
  -- until the block is lifted.
  if private.is_org_blocked(q.org_id, q.id, v_phone, v_email, v_device_hash) then
    if p_source = 'staff' then
      raise exception 'guest_blocked';
    end if;
    raise exception 'queue_not_accepting' using detail = 'closed';
  end if;

  -- 2B-J3 (J-13): a place for later today. Only a queue that offers it, for a time that is still ahead,
  -- inside the max hours, on this service day and while the location is open.
  if p_arrive_after is not null and (
       not q.join_later_enabled
       or p_arrive_after <= now() + interval '1 minute'
       or p_arrive_after > now() + make_interval(hours => q.join_later_max_hours)
       or private.service_day(q.location_id, p_arrive_after) <> private.service_day(q.location_id)
       or not private.location_open_at(q.location_id, p_arrive_after)) then
    raise exception 'invalid_arrive_after';
  end if;
  -- Reserved places count toward capacity, or they could all activate past it.
  if p_arrive_after is not null and q.capacity is not null and (
       select count(*) from app.visits v
       where v.queue_id = q.id and (v.status = 'waiting' or (v.status = 'expected' and v.arrive_after is not null))
     ) >= q.capacity then
    raise exception 'capacity_reached';
  end if;

  -- 2B-W2 hook: a per-queue restriction (on-site, geofence) may refuse the join here; a no-op until
  -- a ticket replaces private.check_join_restriction.
  perform private.check_join_restriction(q.id, p_source, v_phone, v_email, v_device);

  -- 2B-J1 (J-16): with the org's rule on, one contact or device holds one active visit in the scope.
  -- A queue that allows several per contact (J-15) keeps its own visits out of the match.
  v_ref := private.device_ref_hash(q.org_id, v_device);
  select o.single_active_visit into v_scope from app.organizations o where o.id = q.org_id;
  if v_scope <> 'off' then
    v_other := private.find_active_visit(q.org_id, case when v_scope = 'location' then q.location_id end,
                                         v_phone, v_email, v_ref,
                                         case when q.max_active_per_contact > 1 then q.id end);
    if v_other is not null then
      if p_source = 'staff' then
        v_warn := true;
      else
        -- Only the device that holds the visit learns which queue it is in; a typed phone number
        -- is not proof of who is asking.
        raise exception 'already_in_queue' using detail = coalesce((
          select q2.name from app.visits v2 join app.queues q2 on q2.id = v2.queue_id
          where v2.id = v_other and v_ref is not null and v2.device_ref_hash = v_ref), 'contact');
      end if;
    end if;
  end if;

  -- 2A-J15A: one phone (or, online, one device) may hold several active visits, up to the queue's
  -- cap; the cap is a bound on abuse, not a ban. Staff adds are exempt.
  if p_source <> 'staff' and (
    select count(*) from app.visits v
    where v.queue_id = q.id
      and (v.status in ('waiting', 'called', 'serving') or (v.status = 'expected' and v.arrive_after is not null))
      and ((v_phone is not null and v.guest_phone_e164 = v_phone)
           or (v_device_hash is not null and v.device_key_hash = v_device_hash))
  ) >= q.max_active_per_contact then
    raise exception 'too_many_active_visits';
  end if;

  -- 2A-Q7: intake answers are checked before a rate slot is taken, so a bad form costs nothing.
  v_form := private.resolve_form(q.id, p_service_id);
  v_answers := private.validate_form_answers(
    q.org_id, coalesce((select fv.fields from app.form_versions fv where fv.id = v_form), '[]'), p_answers,
    case when p_source = 'staff' then 'staff' else 'guest' end);

  -- 2A-Q5: party size is a queue policy. Off: always one person, whatever the client sent. On:
  -- inside the queue's bounds, for every source.
  if q.party_size_enabled then
    if v_party not between q.party_size_min and q.party_size_max then
      raise exception 'party_size_out_of_range';
    end if;
  else
    v_party := 1;
  end if;

  perform private.take_join_slot(q, p_source, v_device);

  -- Staff see the guest, so a staff add records (or links) the org's contact and guest. Any other
  -- join keeps the typed phone and email on the visit only.
  if p_source in ('staff', 'sms', 'whatsapp', 'phone') then
    if v_phone is not null then
      select c.contact_id, c.guest_id into v_contact, v_guest
      from private.ensure_contact(q.org_id, 'phone', v_phone, null, v_name,
                                  case when p_source = 'staff' then 'staff' else 'online' end, true) c;
    end if;
    if v_email is not null then
      select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
      from private.ensure_contact(q.org_id, 'email', v_email, v_guest, v_name,
                                  case when p_source = 'staff' then 'staff' else 'online' end, true) c;
      v_contact := coalesce(v_contact, v_email_contact);
    end if;
  end if;

  if v_locale is null then
    select o.default_locale into v_locale from app.organizations o where o.id = q.org_id;
  end if;

  v_day := private.service_day(q.location_id);
  v_number := private.next_ticket(q.id, v_prefix, v_day);
  -- Spaced so a later reorder can take a midpoint. Called guests count: requeue keeps their place.
  visit_id := gen_random_uuid();
  -- 2B-Q2: the queue's priority rules run on server data only (source, validated answers); a class
  -- files the visit by arrival time minus its offset, no class goes behind everyone.
  select m.class_id, m.rule_id into v_class, v_rule from private.match_priority_rule(q.id, p_source, v_answers) m;
  if v_class is not null then
    -- Set first: a renumbering inside priority_sort_key is recorded under this actor.
    perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
    select pc.offset_minutes into v_offset from app.priority_classes pc where pc.id = v_class;
    v_sort := private.priority_sort_key(q.id, v_day, visit_id, now(), v_offset);
  else
    select coalesce(max(v.sort_key), 0) + 1024 into v_sort
    from app.visits v
    where v.queue_id = q.id and v.status in ('waiting', 'called');
  end if;
  token := private.visit_token(visit_id, p_idempotency_key);

  perform private.set_actor(p_actor_kind, p_actor_id, null, null,
    jsonb_build_object('source', p_source)
      || case when v_rule is null then '{}'::jsonb else jsonb_build_object('priority_rule_id', v_rule) end
      || case when p_routing_rule_id is null then '{}'::jsonb else jsonb_build_object('routing_rule_id', p_routing_rule_id) end
      || case when v_warn then jsonb_build_object('warning', 'already_in_queue', 'other_visit_id', v_other) else '{}'::jsonb end);
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix,
                          ticket_number, display_ticket, status, sort_key, party_size, guest_name,
                          guest_id, contact_id, guest_phone_e164, guest_email, locale,
                          guest_token_hash, device_key_hash, source, idempotency_key, group_key,
                          priority_class_id, device_ref_hash, arrive_after)
  values (visit_id, q.org_id, q.location_id, q.id, p_service_id, v_day, v_prefix,
          v_number, v_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
          (case when p_arrive_after is null then 'waiting' else 'expected' end)::api.visit_state, v_sort, v_party, v_name,
          v_guest, v_contact, v_phone, v_email, v_locale,
          private.token_hash(token), v_device_hash, p_source, p_idempotency_key, p_group_key,
          v_class, v_ref, p_arrive_after);
  if v_answers <> '{}' then
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (q.org_id, q.location_id, visit_id, v_answers);
  end if;
  -- F2: the form version the guest saw, with the answers (empty when none were given).
  if v_form is not null then
    insert into app.form_responses (org_id, location_id, form_version_id, visit_id, answers)
    values (q.org_id, q.location_id, v_form, visit_id, v_answers);
  end if;
  perform private.bump_queue_version(q.id);
end $$;

-- redefines api.set_visit_answers from 20261030084501_intake_fields.sql
create or replace function api.set_visit_answers(p_visit_id uuid, p_answers jsonb, p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_answers jsonb;
  v_ver uuid;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  -- Validated against the version the visit was asked (else the one a walk-in would get now).
  v_ver := (select r.form_version_id from app.form_responses r where r.visit_id = v.id order by r.created_at limit 1);
  v_ver := coalesce(v_ver, private.resolve_form(v.queue_id, v.service_id));
  v_answers := private.validate_form_answers(
    v.org_id, coalesce((select fv.fields from app.form_versions fv where fv.id = v_ver), '[]'), p_answers, 'staff');

  select * into claim from private.claim_idempotent(v.org_id, 'set_visit_answers', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;

  if v_answers = '{}' then
    delete from app.visit_answers where visit_id = v.id;
  else
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (v.org_id, v.location_id, v.id, v_answers)
    on conflict (visit_id) do update set answers = excluded.answers;
  end if;
  if v_ver is not null then
    insert into app.form_responses (org_id, location_id, form_version_id, visit_id, answers)
    values (v.org_id, v.location_id, v_ver, v.id, v_answers)
    on conflict (visit_id, form_version_id) where visit_id is not null do update set answers = excluded.answers;
  end if;
  -- The event names the answered keys, never the values.
  perform private.set_actor('staff', (select auth.uid()));
  perform private.record_visit_event(v.id, 'answers_updated',
                                     jsonb_build_object('keys', (select coalesce(jsonb_agg(k order by k), '[]') from jsonb_object_keys(v_answers) k)));

  result := private.visit_row(v.id);
  perform private.save_idempotent('set_visit_answers', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.set_visit_answers(uuid, jsonb, int, uuid) is
  'Replaces the intake answers of the visit after validating them against the form '
  'version recorded for the visit (else the one a walk-in would get now; any visibility, nothing '
  'is required) and mirrors them into app.form_responses. Staff of the location. Writes an answers_updated '
  'event that names the keys and never the values. Raises invalid_answers (DETAIL: the failing '
  'key), stale_visit, not_found, invalid_input without a version or key. Idempotent per key. '
  'Implemented by 2A-Q7 (#106).';

------------------------------------------------------------------------------------------------
-- get_join_form (anon): the questions a guest is asked before joining
------------------------------------------------------------------------------------------------

create function api.get_join_form(p_queue_id uuid, p_service_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q app.queues;
  v_form uuid;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or private.org_pending_deletion(q.org_id) then
    raise exception 'not_found';
  end if;
  -- Only an active service of this queue counts, as in join_core; any other id is ignored.
  if p_service_id is not null and not exists (
    select 1 from app.services s where s.id = p_service_id and s.queue_id = q.id and s.active) then
    p_service_id := null;
  end if;
  v_form := private.resolve_form(q.id, p_service_id);
  return jsonb_build_object(
    'form_version_id', v_form,
    'fields', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'key', e ->> 'key', 'label', e ->> 'label', 'help', e -> 'help', 'type', e ->> 'type',
               'options', e -> 'options', 'required', coalesce((e ->> 'required')::boolean, false),
               'sensitivity', e ->> 'sensitivity'))
             order by (e ->> 'position')::int, e ->> 'key')
      from app.form_versions fv, jsonb_array_elements(fv.fields) e
      where fv.id = v_form and coalesce(e ->> 'visibility', 'guest') = 'guest'), '[]'));
end $$;
comment on function api.get_join_form(uuid, uuid) is
  'The form a walk-in guest fills on (queue, service): {form_version_id, fields[]} with key, label, '
  'help, type, options, required and sensitivity of the guest-visible fields in position order; '
  'staff-only fields never leave the database. A service form beats the queue form; no form is '
  '{form_version_id: null, fields: []}. The client renders it and never derives validity: '
  'api.join_queue checks the answers against this version. Contains no guest data. Raises '
  'not_found for an unknown or archived queue or an org being deleted. Why a new function: '
  'get_location_wait has a fixed return type and no service parameter.';
revoke all on function api.get_join_form(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function api.get_join_form(uuid, uuid) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
