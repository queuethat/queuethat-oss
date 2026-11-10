-- W1 (#1303, tracker #1267): `agreement` and `signature` field types for the forms engine.
--
-- Contract (W2 stores the evidence, W3 draws it):
--   field   {type: 'agreement', key, label (title), body, required?}  body: 1 to 8000 characters of
--           rich-text-lite = paragraphs split by a blank line, lines starting "- " are bullets,
--           **bold**; no HTML (< and > refused) and no control characters but newline.
--   field   {type: 'signature', key, label, collect_guardian?, required?}  needs an agreement in the form.
--   answer  agreement: true. stored: {accepted: true, text_hash, accepted_at}. text_hash is the hex
--           sha256 of label || E'\n' || body (UTF-8), accepted_at is server time; the client never supplies either.
--   answer  signature: {name, guardian_name?} (name 2 to 120 characters; guardian only when collect_guardian).
--           stored with signed_at (server time).
--   Editing an agreement means a new form version: published versions are immutable (F1), so what a
--   guest accepted is provable from the version they answered plus text_hash.
--   Staff cannot answer an agreement or signature, and replacing a visit's answers keeps them.
--   An agreement can only be published once the org has a privacy contact (C7), enforced by the version
--   trigger so every path to "published" (publish RPC, templates, queue defaults) is covered.
-- Expand-only: no table or signature changes; new keys on field objects are ignored by older readers.
-- Alternative rejected: a separate agreements table referenced by fields (a second owner of the text; the
-- form version already freezes it and hashes it). Another: put the hash only on the form version (cannot
-- tell which agreement in a multi-agreement form was ticked).
--
-- redefines private.validate_form_fields from 20261109114237_form_field_vocabulary.sql
-- redefines private.validate_form_answers from 20261109114237_form_field_vocabulary.sql
-- redefines api.get_join_form from 20261109115410_booking_answers.sql
-- redefines private.guard_form_version from 20261109080702_forms_schema.sql
-- redefines api.set_visit_answers from 20261109155001_queue_scope_staff_writes.sql

create function private.valid_agreement_body(p_body jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_body) = 'string'
     and length(btrim(p_body #>> '{}')) between 1 and 8000
     and (p_body #>> '{}') !~ '[<>]'
     and regexp_replace(p_body #>> '{}', '\n', '', 'g') !~ '[[:cntrl:]]'
$$;
comment on function private.valid_agreement_body(jsonb) is
  'True for an agreement body: a string of 1 to 8000 characters (after trimming) with no < or > and '
  'no control characters other than newline. The renderer shows it as rich-text-lite (blank line = '
  'paragraph, "- " = bullet, **bold**) and never as HTML.';
revoke all on function private.valid_agreement_body(jsonb) from public, anon, authenticated;

create function private.agreement_hash(p_field jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to((p_field ->> 'label') || E'\n' || (p_field ->> 'body'), 'utf8'), 'sha256'), 'hex')
$$;
comment on function private.agreement_hash(jsonb) is
  'Hex sha256 of an agreement field''s label, a newline and its body (UTF-8): what the guest was shown.';
revoke all on function private.agreement_hash(jsonb) from public, anon, authenticated;

create function private.keep_signed_answers(p_fields jsonb, p_existing jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}')
  from jsonb_each(case when jsonb_typeof(p_existing) = 'object' then p_existing else '{}'::jsonb end) e
  where exists (select 1 from jsonb_array_elements(private.normalize_form_fields(p_fields)) f
                where f ->> 'key' = e.key and f ->> 'type' in ('agreement', 'signature'))
$$;
comment on function private.keep_signed_answers(jsonb, jsonb) is
  'The agreement and signature answers among p_existing (as stored), for the fields of the version; '
  'staff edits merge them back so replacing answers never drops the guest''s evidence.';
revoke all on function private.keep_signed_answers(jsonb, jsonb) from public, anon, authenticated;

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
                                  'sensitivity', 'position', 'must_be_true', 'body', 'collect_guardian')) then
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
         'phone', 'email', 'heading', 'marketing_consent', 'agreement', 'signature') then
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
    -- W1: the agreement text lives on the field (agreement only); a signature may ask for a guardian.
    if (t = 'agreement') <> (f ? 'body') or (f ? 'body' and not private.valid_agreement_body(f -> 'body')) then
      raise exception 'invalid_input' using detail = 'body';
    end if;
    if f ? 'collect_guardian' and (jsonb_typeof(f -> 'collect_guardian') <> 'boolean' or t <> 'signature') then
      raise exception 'invalid_input' using detail = 'collect_guardian';
    end if;
    if t in ('agreement', 'signature') and f ->> 'visibility' = 'staff_only' then
      raise exception 'invalid_input' using detail = 'visibility';
    end if;
    if f ? 'visibility' and not coalesce((f ->> 'visibility') = any (array['guest', 'staff_only']), false) then
      raise exception 'invalid_input' using detail = 'visibility';
    end if;
    if f ? 'sensitivity' and not coalesce((f ->> 'sensitivity') = any (array['normal', 'personal', 'sensitive']), false) then
      raise exception 'invalid_input' using detail = 'sensitivity';
    end if;
  end loop;
  -- A signature signs an agreement of the same form.
  if exists (select 1 from jsonb_array_elements(p_fields) x where x ->> 'type' = 'signature')
     and not exists (select 1 from jsonb_array_elements(p_fields) x where x ->> 'type' = 'agreement') then
    raise exception 'invalid_input' using detail = 'signature_without_agreement';
  end if;
end $$;
comment on function private.validate_form_fields(jsonb) is
  'Raises invalid_input unless p_fields is an array of at most 20 field objects with unique keys, '
  'known types, 1 to 50 distinct options for choice types only, and known visibility/sensitivity values. '
  'The legacy types text, select, checkbox and the position key are accepted as aliases '
  '(private.normalize_form_field); array order is field order. An agreement carries its text in `body` '
  '(see private.valid_agreement_body), a signature may set collect_guardian, both are guest-visible, '
  'and a form with a signature needs an agreement (invalid_input, DETAIL body, collect_guardian, '
  'visibility, signature_without_agreement).';

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
    -- Staff never accept an agreement or sign for a guest: that evidence comes from the guest alone.
    if not found or (p_audience = 'guest' and coalesce(f ->> 'visibility', 'guest') = 'staff_only')
       or (p_audience = 'staff' and f ->> 'type' in ('agreement', 'signature')) then
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
    -- an empty signature object is a blank, like an empty string
    if ft = 'signature' and jsonb_typeof(val) = 'object'
       and btrim(coalesce(val ->> 'name', '')) = '' and btrim(coalesce(val ->> 'guardian_name', '')) = '' then
      val := null;
    end if;
    -- null, an empty string, an empty list, and false for a tick that must be ticked (or an
    -- optional consent) count as not answered
    if val is null or val = 'null'::jsonb or val = '[]'::jsonb
       or (jsonb_typeof(val) = 'string' and btrim(val #>> '{}') = '')
       or (val = 'false'::jsonb and (ft = 'marketing_consent'
                                     or (ft = 'yes_no' and coalesce((f ->> 'must_be_true')::boolean, false))
                                     or ft = 'agreement')) then
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
      when 'agreement' then
        -- The guest sends true; the stored answer is the evidence: what was accepted (hash) and when (server time).
        if val <> 'true'::jsonb then raise exception 'invalid_answers' using detail = fk; end if;
        out := out || jsonb_build_object(fk, jsonb_build_object(
          'accepted', true, 'text_hash', private.agreement_hash(f),
          'accepted_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
      when 'signature' then
        if jsonb_typeof(val) <> 'object'
           or exists (select 1 from jsonb_object_keys(val) x where x not in ('name', 'guardian_name')) then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        s := btrim(coalesce(val ->> 'name', ''));
        if jsonb_typeof(val -> 'name') is distinct from 'string' or length(s) not between 2 and 120 or s ~ '[[:cntrl:]]' then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        perform private.sensitive_guard(s, 'invalid_answers', fk);
        v_probe := btrim(coalesce(val ->> 'guardian_name', ''));
        if val ? 'guardian_name' and (jsonb_typeof(val -> 'guardian_name') <> 'string' or length(v_probe) > 120
           or v_probe ~ '[[:cntrl:]]' or (v_probe <> '' and not coalesce((f ->> 'collect_guardian')::boolean, false))) then
          raise exception 'invalid_answers' using detail = fk;
        end if;
        perform private.sensitive_guard(v_probe, 'invalid_answers', fk);
        out := out || jsonb_build_object(fk, jsonb_strip_nulls(jsonb_build_object(
          'name', s, 'guardian_name', nullif(v_probe, ''),
          'signed_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))));
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
  'SIN/SSN numbers are refused. A required yes_no with must_be_true needs true. An agreement is answered '
  'with true (stored as {accepted, text_hash, accepted_at}: sha256 hex of label, a newline and body, and '
  'the server time); a signature with {name 2 to 120 characters, guardian_name when the field '
  'collect_guardian is set} (stored with signed_at). Staff cannot answer either; the guest''s '
  'evidence is never taken from the client.';

create or replace function api.get_join_form(p_queue_id uuid, p_service_id uuid default null, p_channel text default 'walk_in')
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q app.queues;
  v_form uuid;
begin
  if p_channel not in ('walk_in', 'booking') then
    raise exception 'invalid_input';
  end if;
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or private.org_pending_deletion(q.org_id) then
    raise exception 'not_found';
  end if;
  -- Only an active service of this queue counts, as in join_core; any other id is ignored.
  if p_service_id is not null and not exists (
    select 1 from app.services s where s.id = p_service_id and s.queue_id = q.id and s.active) then
    p_service_id := null;
  end if;
  v_form := private.resolve_form_for(q.id, p_service_id, p_channel);
  return jsonb_build_object(
    'form_version_id', v_form,
    'fields', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'key', e ->> 'key', 'label', e ->> 'label', 'help', e -> 'help', 'type', e ->> 'type',
               'options', e -> 'options', 'body', e -> 'body', 'required', coalesce((e ->> 'required')::boolean, false),
               'collect_guardian', case when coalesce((e ->> 'collect_guardian')::boolean, false) then 'true'::jsonb end,
               'must_be_true', case when coalesce((e ->> 'must_be_true')::boolean, false) then 'true'::jsonb end,
               'sensitivity', e ->> 'sensitivity'))
             order by ord)
      from app.form_versions fv,
           jsonb_array_elements(private.normalize_form_fields(fv.fields)) with ordinality t(e, ord)
      where fv.id = v_form and coalesce(e ->> 'visibility', 'guest') = 'guest'), '[]'));
end $$;
comment on function api.get_join_form(uuid, uuid, text) is
  'The form a guest fills on (queue, service) for p_channel walk_in (default, joining the line) or booking (an appointment): {form_version_id, fields[]} with key, label, '
  'help, type (canonical: short_text, long_text, single_choice, multi_choice, yes_no, number, date, '
  'phone, email, heading, marketing_consent, agreement, signature), options, body (agreement text), required, must_be_true, collect_guardian and sensitivity of the '
  'guest-visible fields in form order (array order); staff-only fields never leave the database. A '
  'service form beats the queue form; no form is {form_version_id: null, fields: []}. The client '
  'renders it and never derives validity: api.join_queue and api.set_booking_answers check the answers against this version. '
  'Contains no guest data. Raises invalid_input for an unknown channel and not_found for an unknown or archived queue or an org being '
  'deleted.';

create or replace function private.guard_form_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null then
      raise exception 'immutable_column' using errcode = '42501', detail = 'published version';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.published_at is not null then
      raise exception 'immutable_column' using errcode = '42501', detail = 'published version';
    end if;
    if (new.form_id, new.version) is distinct from (old.form_id, old.version) then
      raise exception 'immutable_column' using errcode = '42501';
    end if;
  end if;
  if new.published_at is not null then
    -- W1: an agreement goes live only once the business has recorded its privacy contact (every path to published).
    if exists (select 1 from jsonb_array_elements(new.fields) e where e ->> 'type' = 'agreement')
       and not private.privacy_contact_recorded(new.org_id) then
      raise exception 'invalid_input' using detail = 'privacy_contact_required';
    end if;
    new.text_hash := extensions.digest(new.fields::text, 'sha256');
  else
    new.text_hash := null;
  end if;
  return new;
end $$;
comment on function private.guard_form_version() is
  'BEFORE trigger on app.form_versions: a published version (published_at set) can never be '
  'updated or deleted; publishing stores sha256 of the fields so what a guest saw is provable. '
  'Publishing a version with an agreement field needs the org''s privacy contact '
  '(invalid_input, DETAIL privacy_contact_required).';

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
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
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
  -- W1: replacing the answers never drops what the guest signed.
  v_answers := v_answers || private.keep_signed_answers(
    coalesce((select fv.fields from app.form_versions fv where fv.id = v_ver), '[]'),
    (select r.answers from app.form_responses r where r.visit_id = v.id and r.form_version_id = v_ver));

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
  'Replaces the intake answers of the visit (except an agreement or signature the guest gave, which stay) after validating them against the form '
  'version recorded for the visit (else the one a walk-in would get now; any visibility, nothing '
  'is required) and mirrors them into app.form_responses. Staff of the location. Writes an answers_updated '
  'event that names the keys and never the values. Raises invalid_answers (DETAIL: the failing '
  'key), stale_visit, not_found, invalid_input without a version or key. Idempotent per key. '
  'Implemented by 2A-Q7 (#106).';

notify pgrst, 'reload schema';
