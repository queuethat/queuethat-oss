-- F5 (#1281): admin RPCs for the forms library. F1 made the tables read-only for `authenticated`;
-- these three definer functions are the only writers a manager reaches.
--
-- Why they are not pass-through (interface rule 3): each owns a rule a caller would otherwise have
-- to remember. save_form_draft owns the one-draft-per-form versioning and field validation (so a
-- published version can never hold a malformed field list); publish_form_version owns the freeze
-- (published_at, which the F1 trigger turns into the stored sha256) and refuses to mint a version
-- identical to the live one; attach_form owns the bulk, all-or-nothing, location-bound attach.
-- The 20-field and 3-form caps stay in the F1 triggers/checks so no path can skip them; the
-- functions surface them as invalid_input.
--
-- Alternative considered (rule 7): granting managers INSERT/UPDATE on the four tables and letting
-- the client version. Rejected: the client would re-derive version numbering and the draft/live
-- split, and I-3 policies cannot express "only the draft row".

-- Field list shape (B2 library v1). One place, so W1 (agreement, signature) extends it with
-- `create or replace` instead of touching the RPCs.
create function private.validate_form_fields(p_fields jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  f jsonb;
  t text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 20 then
    raise exception 'invalid_input' using detail = 'fields';
  end if;
  if (select count(distinct e ->> 'key') from jsonb_array_elements(p_fields) e) <> jsonb_array_length(p_fields) then
    raise exception 'invalid_input' using detail = 'duplicate key';
  end if;
  for f in select e from jsonb_array_elements(p_fields) e loop
    if jsonb_typeof(f) <> 'object'
       or exists (select 1 from jsonb_object_keys(f) k
                  where k not in ('key', 'label', 'help', 'type', 'options', 'required', 'visibility', 'sensitivity')) then
      raise exception 'invalid_input' using detail = 'field shape';
    end if;
    if jsonb_typeof(f -> 'key') is distinct from 'string' or (f ->> 'key') !~ '^[a-z][a-z0-9_]{0,39}$' then
      raise exception 'invalid_input' using detail = 'key';
    end if;
    if jsonb_typeof(f -> 'label') is distinct from 'string' or length(btrim(f ->> 'label')) not between 1 and 120 then
      raise exception 'invalid_input' using detail = 'label';
    end if;
    if f ? 'help' and (jsonb_typeof(f -> 'help') <> 'string' or length(f ->> 'help') > 300) then
      raise exception 'invalid_input' using detail = 'help';
    end if;
    t := f ->> 'type';
    if jsonb_typeof(f -> 'type') is distinct from 'string' or t not in (
         'short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'number', 'date',
         'phone', 'email', 'heading', 'marketing_consent') then
      raise exception 'invalid_input' using detail = 'type';
    end if;
    if (t in ('single_choice', 'multi_choice')) <> (f ? 'options') then
      raise exception 'invalid_input' using detail = 'options';
    end if;
    if f ? 'options' and (
         jsonb_typeof(f -> 'options') <> 'array'
         or jsonb_array_length(f -> 'options') not between 1 and 50
         or exists (select 1 from jsonb_array_elements(f -> 'options') o
                    where jsonb_typeof(o) <> 'string' or length(btrim(o #>> '{}')) not between 1 and 80)
         or (select count(distinct o) from jsonb_array_elements(f -> 'options') o) <> jsonb_array_length(f -> 'options')) then
      raise exception 'invalid_input' using detail = 'options';
    end if;
    if f ? 'required' and (jsonb_typeof(f -> 'required') <> 'boolean'
                           or ((f ->> 'required')::boolean and t in ('heading', 'marketing_consent'))) then
      raise exception 'invalid_input' using detail = 'required';
    end if;
    if f ? 'visibility' and not coalesce((f ->> 'visibility') = any (array['guest', 'staff_only']), false) then
      raise exception 'invalid_input' using detail = 'visibility';
    end if;
    if f ? 'sensitivity' and not coalesce((f ->> 'sensitivity') = any (array['normal', 'personal', 'sensitive']), false) then
      raise exception 'invalid_input' using detail = 'sensitivity';
    end if;
  end loop;
end $$;
comment on function private.validate_form_fields(jsonb) is
  'Raises invalid_input unless p_fields is an array of at most 20 field objects with unique keys, '
  'known types, 1 to 50 distinct options for choice types only, and known visibility/sensitivity values.';
revoke all on function private.validate_form_fields(jsonb) from public, anon, authenticated;

create function api.save_form_draft(
  p_org_id uuid, p_location_id uuid, p_form_id uuid, p_name text, p_purpose_text text,
  p_retention_days integer, p_fields jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_form app.forms;
  v_draft app.form_versions;
begin
  if not exists (select 1 from app.locations l where l.id = p_location_id and l.org_id = p_org_id)
     or not private.has_role(p_org_id, p_location_id, 'manager') then
    raise exception 'not_found';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 80
     or length(p_purpose_text) > 300
     or p_retention_days not between 1 and 365 then
    raise exception 'invalid_input';
  end if;
  perform private.validate_form_fields(p_fields);

  if p_form_id is null then
    insert into app.forms (org_id, location_id, name, purpose_text, retention_days)
    values (p_org_id, p_location_id, btrim(p_name), p_purpose_text, p_retention_days)
    returning * into v_form;
  else
    select * into v_form from app.forms f
    where f.id = p_form_id and f.org_id = p_org_id and f.location_id = p_location_id
    for update;
    if not found then
      raise exception 'not_found';
    end if;
    update app.forms set name = btrim(p_name), purpose_text = p_purpose_text, retention_days = p_retention_days
    where id = v_form.id;
  end if;

  select * into v_draft from app.form_versions v where v.form_id = v_form.id and v.published_at is null;
  if found then
    update app.form_versions set fields = p_fields where id = v_draft.id;
  else
    insert into app.form_versions (org_id, location_id, form_id, version, fields)
    values (p_org_id, p_location_id, v_form.id,
            coalesce((select max(v.version) from app.form_versions v where v.form_id = v_form.id), 0) + 1,
            p_fields);
  end if;
  return v_form.id;
end $$;
comment on function api.save_form_draft(uuid, uuid, uuid, text, text, integer, jsonb) is
  'Creates (p_form_id null) or updates a form in a location and saves its fields as the form''s one '
  'draft version; the live published version is untouched, so guests keep seeing it until '
  'api.publish_form_version. Returns the form id. Callable by managers and above of the location; '
  'raises not_found for a foreign org, location or form and for lower roles. Raises invalid_input '
  'for a bad name (1 to 80), purpose (over 300), retention (1 to 365 days or null = org default), '
  'a malformed field list (max 20), or a 4th library form in the location. Saving again is an overwrite.';
revoke all on function api.save_form_draft(uuid, uuid, uuid, text, text, integer, jsonb) from public, anon;
grant execute on function api.save_form_draft(uuid, uuid, uuid, text, text, integer, jsonb) to authenticated, service_role;

create function api.publish_form_version(p_org_id uuid, p_form_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_form app.forms;
  v_draft app.form_versions;
  v_live app.form_versions;
begin
  select * into v_form from app.forms f where f.id = p_form_id and f.org_id = p_org_id for update;
  if not found or not private.has_role(p_org_id, v_form.location_id, 'manager') then
    raise exception 'not_found';
  end if;
  select * into v_live from app.form_versions v
  where v.form_id = v_form.id and v.published_at is not null order by v.version desc limit 1;
  select * into v_draft from app.form_versions v where v.form_id = v_form.id and v.published_at is null;
  if not found then
    -- Nothing pending: publishing again is a no-op that reports the live version.
    if v_live.id is null then
      raise exception 'not_found';
    end if;
    return v_live.version;
  end if;
  perform private.validate_form_fields(v_draft.fields);
  if v_live.id is not null and v_live.fields = v_draft.fields then
    -- An unchanged draft would mint a version identical to the live one.
    delete from app.form_versions where id = v_draft.id;
    return v_live.version;
  end if;
  update app.form_versions set published_at = now() where id = v_draft.id;
  update app.forms set status = 'published' where id = v_form.id and status <> 'published';
  return v_draft.version;
end $$;
comment on function api.publish_form_version(uuid, uuid) is
  'Freezes the form''s draft as the next version: it gets published_at and the sha256 of its fields '
  'and can never change again. Targets follow the newest published version. Returns the version '
  'number now live. Publishing with no draft, or a draft identical to the live version, is a no-op '
  'that returns the live version. Callable by managers and above of the form''s location; raises '
  'not_found for a foreign or missing form, for lower roles, and for a form that was never saved.';
revoke all on function api.publish_form_version(uuid, uuid) from public, anon;
grant execute on function api.publish_form_version(uuid, uuid) to authenticated, service_role;

create function api.attach_form(
  p_org_id uuid, p_form_id uuid, p_target_ids uuid[], p_channel text default 'any'
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_form app.forms;
  v_ids uuid[];
begin
  select * into v_form from app.forms f where f.id = p_form_id and f.org_id = p_org_id;
  if not found or not private.has_role(p_org_id, v_form.location_id, 'manager') then
    raise exception 'not_found';
  end if;
  if p_channel is null or p_channel not in ('any', 'walk_in', 'booking')
     or cardinality(p_target_ids) > 100
     or exists (select 1 from unnest(p_target_ids) x where x is null) then
    raise exception 'invalid_input';
  end if;
  v_ids := (select coalesce(array_agg(distinct x), '{}') from unnest(p_target_ids) x);
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  if not exists (select 1 from app.form_versions v where v.form_id = v_form.id and v.published_at is not null) then
    raise exception 'invalid_input' using detail = 'unpublished';
  end if;
  -- Each id is a queue or a service of this form's location; any other id refuses the whole batch.
  if (select count(*) from app.queues q where q.id = any (v_ids) and q.org_id = p_org_id and q.location_id = v_form.location_id)
     + (select count(*) from app.services s where s.id = any (v_ids) and s.org_id = p_org_id and s.location_id = v_form.location_id)
     <> cardinality(v_ids) then
    raise exception 'not_found';
  end if;

  insert into app.form_targets (org_id, location_id, form_id, queue_id, channel)
  select p_org_id, v_form.location_id, v_form.id, q.id, p_channel
  from app.queues q where q.id = any (v_ids)
  on conflict (queue_id, channel) where queue_id is not null
  do update set form_id = excluded.form_id where app.form_targets.form_id <> excluded.form_id;

  insert into app.form_targets (org_id, location_id, form_id, service_id, channel)
  select p_org_id, v_form.location_id, v_form.id, s.id, p_channel
  from app.services s where s.id = any (v_ids)
  on conflict (service_id, channel) where service_id is not null
  do update set form_id = excluded.form_id where app.form_targets.form_id <> excluded.form_id;
  return cardinality(v_ids);
end $$;
comment on function api.attach_form(uuid, uuid, uuid[], text) is
  'Shows a published form on many queues and services at once, for p_channel (any, walk_in or '
  'booking). Each id is a queue or service of the form''s location; a target already showing '
  'another form switches to this one, one already showing it is left alone. All or nothing. '
  'Returns how many distinct targets now show the form; an empty list is a no-op returning 0. '
  'Callable by managers and above of the form''s location; raises not_found for a foreign form or '
  'for any id that is not a queue or service of that location, invalid_input for an unknown '
  'channel, a null id, more than 100 ids, or a form with no published version.';
revoke all on function api.attach_form(uuid, uuid, uuid[], text) from public, anon;
grant execute on function api.attach_form(uuid, uuid, uuid[], text) to authenticated, service_role;
