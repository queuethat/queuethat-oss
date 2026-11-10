-- #1326 (tracker #1267): one field vocabulary for the forms engine.
--
-- F2 (join) validated answers against app.intake_field_type (text, select, checkbox, phone, number,
-- date) and ordered by `position`; F5 (library) validates the B2 vocabulary (short_text, long_text,
-- single_choice, multi_choice, yes_no, number, date, phone, email, heading, marketing_consent) with
-- array order. A library form made every guest join fail and a queue default form could not be
-- republished from the library.
--
-- Decision: the B2 library names are canonical and field order is array order. The legacy names
-- text, select, checkbox and the `position` key are accepted as aliases everywhere a field list is
-- read or validated (private.normalize_form_field), so stored legacy versions (immutable, I-1/F1
-- hash) keep working. Queue default forms are re-published in canonical shape by the backfill below.
-- Alternative rejected: add the library types to app.intake_field_type. That leaks the library into
-- the legacy table and keeps two vocabularies.
--
-- redefines private.intake_snapshot from 20261109094337_forms_engine.sql
-- redefines private.validate_form_answers from 20261109094337_forms_engine.sql
-- redefines api.get_join_form from 20261109094337_forms_engine.sql
-- redefines private.validate_form_fields from 20261109114036_form_detach.sql (F6 widened it to accept the legacy types; this supersedes that with the alias normaliser)

create function private.normalize_form_field(p_field jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_field) is distinct from 'object' then p_field
    else (p_field - 'position')
         || case p_field ->> 'type'
              when 'text' then '{"type": "short_text"}'::jsonb
              when 'select' then '{"type": "single_choice"}'::jsonb
              when 'checkbox' then '{"type": "yes_no"}'::jsonb
              else '{}'::jsonb end
         -- a required legacy checkbox meant "must be ticked"; yes_no needs the flag to keep that
         || case when p_field ->> 'type' = 'checkbox' and p_field -> 'required' = 'true'::jsonb
                 then '{"must_be_true": true}'::jsonb else '{}'::jsonb end
  end
$$;
comment on function private.normalize_form_field(jsonb) is
  'One form field in canonical (B2 library) shape: legacy types text, select, checkbox become '
  'short_text, single_choice, yes_no (a required checkbox gets must_be_true) and the legacy position '
  'key is dropped. Canonical fields and non-objects are returned unchanged. Idempotent.';
revoke all on function private.normalize_form_field(jsonb) from public, anon, authenticated;

create function private.normalize_form_fields(p_fields jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_fields) = 'array'
    then (select coalesce(jsonb_agg(private.normalize_form_field(e) order by ord), '[]'::jsonb)
          from jsonb_array_elements(p_fields) with ordinality t(e, ord))
    else p_fields end
$$;
comment on function private.normalize_form_fields(jsonb) is
  'private.normalize_form_field over a field list, order kept (array order is field order).';
revoke all on function private.normalize_form_fields(jsonb) from public, anon, authenticated;

-- The active intake fields of a queue, canonical, in position order (the order becomes array order).
create or replace function private.intake_snapshot(p_queue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(private.normalize_form_field(jsonb_strip_nulls(jsonb_build_object(
           'key', f.key, 'label', f.label, 'help', f.help, 'type', f.type, 'options', f.options,
           'required', f.required, 'visibility', f.visibility, 'sensitivity', f.sensitivity)))
         order by f.position, f.key), '[]')
  from app.intake_fields f
  where f.queue_id = p_queue_id and f.active
$$;
comment on function private.intake_snapshot(uuid) is
  'The active intake fields of a queue as a jsonb array in the canonical shape of '
  'app.form_versions.fields, in position order.';

------------------------------------------------------------------------------------------------
-- Field list validation (admin side). Accepts the legacy aliases and `position`.
------------------------------------------------------------------------------------------------
create or replace function private.validate_form_fields(p_fields jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  e jsonb;
  f jsonb;
  t text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 20 then
    raise exception 'invalid_input' using detail = 'fields';
  end if;
  if (select count(distinct x ->> 'key') from jsonb_array_elements(p_fields) x) <> jsonb_array_length(p_fields) then
    raise exception 'invalid_input' using detail = 'duplicate key';
  end if;
  for e in select x from jsonb_array_elements(p_fields) x loop
    if jsonb_typeof(e) <> 'object'
       or exists (select 1 from jsonb_object_keys(e) k
                  where k not in ('key', 'label', 'help', 'type', 'options', 'required', 'visibility',
                                  'sensitivity', 'position', 'must_be_true')) then
      raise exception 'invalid_input' using detail = 'field shape';
    end if;
    if e ? 'position' and jsonb_typeof(e -> 'position') <> 'number' then
      raise exception 'invalid_input' using detail = 'position';
    end if;
    f := private.normalize_form_field(e);
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
    if f ? 'must_be_true' and (jsonb_typeof(f -> 'must_be_true') <> 'boolean' or t <> 'yes_no') then
      raise exception 'invalid_input' using detail = 'must_be_true';
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
  'known types, 1 to 50 distinct options for choice types only, and known visibility/sensitivity values. '
  'The legacy types text, select, checkbox and the position key are accepted as aliases '
  '(private.normalize_form_field); array order is field order.';

------------------------------------------------------------------------------------------------
-- Answer validation (guest and staff side) for every library type.
------------------------------------------------------------------------------------------------
create or replace function private.validate_form_answers(p_org_id uuid, p_fields jsonb, p_answers jsonb, p_audience text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  a jsonb := coalesce(p_answers, '{}');
  v_fields jsonb := private.normalize_form_fields(coalesce(p_fields, '[]'));
  f jsonb;
  k text;
  fk text;
  ft text;
  val jsonb;
  s text;
  o jsonb;
  seen jsonb;
  v_max int;
  v_probe text;
  out jsonb := '{}';
begin
  if p_audience not in ('guest', 'staff') then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(a) = 'null' then
    a := '{}';
  end if;
  -- Bounded before any work: a form has at most 20 fields, so more keys cannot all be valid.
  if jsonb_typeof(a) <> 'object' or octet_length(a::text) > 65536 then
    raise exception 'invalid_answers' using detail = '';
  end if;

  -- Every key must name an answerable field of the version that this audience may answer.
  for k in select jsonb_object_keys(a) loop
    select e into f from jsonb_array_elements(v_fields) e
    where e ->> 'key' = k and e ->> 'type' <> 'heading';
    if not found or (p_audience = 'guest' and coalesce(f ->> 'visibility', 'guest') = 'staff_only') then
      -- Echo only what looks like a field key, never arbitrary guest text.
      raise exception 'invalid_answers' using detail = case when k ~ '^[a-z][a-z0-9_]{0,39}$' then k else '' end;
    end if;
  end loop;

  for f in select e from jsonb_array_elements(v_fields) with ordinality t(e, ord) order by ord loop
    ft := f ->> 'type';
    fk := f ->> 'key';
    if ft = 'heading' then
      continue;
    end if;
    val := a -> fk;
    -- null, an empty string, an empty list, and false for a tick that must be ticked (or an
    -- optional consent) count as not answered
    if val is null or val = 'null'::jsonb or val = '[]'::jsonb
       or (jsonb_typeof(val) = 'string' and btrim(val #>> '{}') = '')
       or (val = 'false'::jsonb and (ft = 'marketing_consent'
                                     or (ft = 'yes_no' and coalesce((f ->> 'must_be_true')::boolean, false)))) then
      if coalesce((f ->> 'required')::boolean, false) and p_audience = 'guest'
         and coalesce(f ->> 'visibility', 'guest') = 'guest' then
        raise exception 'invalid_answers' using detail = fk;
      end if;
      continue;
    end if;

    case ft
      when 'short_text', 'long_text' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = fk; end if;
        s := btrim(val #>> '{}');
        -- (CASE sits outside the IF condition: PL/pgSQL ends a condition at the first THEN it sees.)
        v_max := case when ft = 'long_text' then 1000 else 500 end;
        v_probe := case when ft = 'long_text' then regexp_replace(s, '[\n\r\t]', '', 'g') else s end;
        if length(s) > v_max or v_probe ~ '[[:cntrl:]]' then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        perform private.sensitive_guard(regexp_replace(s, '[\n\r\t]', ' ', 'g'), 'invalid_answers', fk);
        -- A health-tagged org collects a sensitive answer as a short reason only.
        if f ->> 'sensitivity' = 'sensitive' and length(s) > 200
           and (select o2.health_tagged from app.organizations o2 where o2.id = p_org_id) then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        out := out || jsonb_build_object(fk, s);
      when 'single_choice' then
        if jsonb_typeof(val) <> 'string' or not coalesce(f -> 'options', '[]') @> jsonb_build_array(val) then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        out := out || jsonb_build_object(fk, val);
      when 'multi_choice' then
        if jsonb_typeof(val) <> 'array' or jsonb_array_length(val) > 50 then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        seen := '[]';
        for o in select x from jsonb_array_elements(val) x loop
          if jsonb_typeof(o) <> 'string' or not coalesce(f -> 'options', '[]') @> jsonb_build_array(o)
             or seen @> jsonb_build_array(o) then
            raise exception 'invalid_answers' using detail = fk;
          end if;
          seen := seen || jsonb_build_array(o);
        end loop;
        out := out || jsonb_build_object(fk, val);
      when 'yes_no', 'marketing_consent' then
        if jsonb_typeof(val) <> 'boolean' then raise exception 'invalid_answers' using detail = fk; end if;
        out := out || jsonb_build_object(fk, val);
      when 'phone' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = fk; end if;
        s := regexp_replace(val #>> '{}', '[[:space:]().-]', '', 'g');
        if s !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_answers' using detail = fk; end if;
        perform private.sensitive_guard(substr(s, 2), 'invalid_answers', fk);
        out := out || jsonb_build_object(fk, s);
      when 'email' then
        if jsonb_typeof(val) <> 'string' then raise exception 'invalid_answers' using detail = fk; end if;
        s := btrim(val #>> '{}');
        if length(s) > 254 or s !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:].]+$' then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        perform private.sensitive_guard(s, 'invalid_answers', fk);
        out := out || jsonb_build_object(fk, s);
      when 'number' then
        if jsonb_typeof(val) <> 'number' or abs((val #>> '{}')::numeric) > 1000000000000 then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        perform private.sensitive_guard(val #>> '{}', 'invalid_answers', fk);
        out := out || jsonb_build_object(fk, val);
      when 'date' then
        s := val #>> '{}';
        if jsonb_typeof(val) <> 'string' or s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        begin
          perform s::date;
        exception when others then
          raise exception 'invalid_answers' using detail = fk;
        end;
        out := out || jsonb_build_object(fk, s);
      else
        raise exception 'invalid_answers' using detail = fk;
    end case;
  end loop;
  return out;
end $$;
comment on function private.validate_form_answers(uuid, jsonb, jsonb, text) is
  'Checks answers against a form version''s field list (any B2 library type; legacy text, select, '
  'checkbox read as short_text, single_choice, yes_no) and returns them normalised (blank answers '
  'dropped, phones as E.164). p_audience guest (staff-only fields refused, required guest fields '
  'enforced) or staff (any field, nothing required). Headings take no answer. Unknown or wrongly typed '
  'answers raise invalid_answers with the failing key as DETAIL (never the value). Short text is at '
  'most 500 characters, long text 1000 (200 for a sensitive field of a health-tagged org); card and '
  'SIN/SSN numbers are refused. A required yes_no with must_be_true needs true.';

------------------------------------------------------------------------------------------------
-- get_join_form (anon): array order, canonical types, headings included.
------------------------------------------------------------------------------------------------
create or replace function api.get_join_form(p_queue_id uuid, p_service_id uuid default null) returns jsonb
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
               'must_be_true', case when coalesce((e ->> 'must_be_true')::boolean, false) then 'true'::jsonb end,
               'sensitivity', e ->> 'sensitivity'))
             order by ord)
      from app.form_versions fv,
           jsonb_array_elements(private.normalize_form_fields(fv.fields)) with ordinality t(e, ord)
      where fv.id = v_form and coalesce(e ->> 'visibility', 'guest') = 'guest'), '[]'));
end $$;
comment on function api.get_join_form(uuid, uuid) is
  'The form a walk-in guest fills on (queue, service): {form_version_id, fields[]} with key, label, '
  'help, type (canonical: short_text, long_text, single_choice, multi_choice, yes_no, number, date, '
  'phone, email, heading, marketing_consent), options, required, must_be_true and sensitivity of the '
  'guest-visible fields in form order (array order); staff-only fields never leave the database. A '
  'service form beats the queue form; no form is {form_version_id: null, fields: []}. The client '
  'renders it and never derives validity: api.join_queue checks the answers against this version. '
  'Contains no guest data. Raises not_found for an unknown or archived queue or an org being '
  'deleted. Why a new function: get_location_wait has a fixed return type and no service parameter.';

-- Backfill: re-publish every queue default form whose latest version is in the legacy shape. Published
-- versions are immutable, so this mints a canonical next version (and is a no-op when already canonical).
select private.sync_queue_default_form(q.id) from app.queues q
where exists (select 1 from app.intake_fields f where f.queue_id = q.id and f.active);

notify pgrst, 'reload schema';
