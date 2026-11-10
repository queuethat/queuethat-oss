-- C5 (#1271): sensitive-field guards for the forms library (epic #1267, design section 4).
--
-- redefines private.check_intake_field from 20261030084501_intake_fields.sql
-- redefines private.validate_answers from 20261030084501_intake_fields.sql
-- check_intake_field becomes SECURITY DEFINER: it calls the revoked private guards and reads the
-- org's health tag, which a location-scoped manager cannot see.
-- Expand step: new nullable/defaulted columns only. Existing fields stay 'normal'.

create type app.intake_sensitivity as enum ('normal', 'personal', 'sensitive');
grant usage on type app.intake_sensitivity to authenticated, service_role;

alter table app.intake_fields
  add column sensitivity app.intake_sensitivity not null default 'normal',
  -- null = the org's retention_days; a sensitive field gets 90 (check_intake_field). Cap 365.
  add column retention_days int check (retention_days between 1 and 365);

-- Luhn mod-10 check (payment cards, Canadian SIN).
create function private.luhn_valid(p_digits text) returns boolean
language sql immutable strict set search_path = '' as $$
  select p_digits ~ '^[0-9]+$' and coalesce((
    select sum(case when t.i % 2 = 0 then (t.d * 2) / 10 + (t.d * 2) % 10 else t.d end)
    from (select substr(p_digits, length(p_digits) - n + 1, 1)::int as d, n as i
          from generate_series(1, length(p_digits)) n) t
  ), 1) % 10 = 0
$$;
comment on function private.luhn_valid(text) is 'True when a string of digits passes the Luhn check.';
revoke all on function private.luhn_valid(text) from public, anon, authenticated;

create function private.sensitive_kind(p_text text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  m text;
  d text;
begin
  if p_text is null then
    return null;
  end if;
  -- 13 to 19 digits, spaces or hyphens between them, Luhn valid: a payment card number.
  for m in select r[1] from regexp_matches(p_text, '((?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9]))', 'g') r loop
    d := regexp_replace(m, '[^0-9]', '', 'g');
    if length(d) between 13 and 19 and private.luhn_valid(d) then
      return 'card';
    end if;
  end loop;
  -- Canadian SIN: nine digits (optionally 3-3-3), Luhn valid.
  for m in select r[1] from regexp_matches(p_text, '((?<![0-9])[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}(?![0-9]))', 'g') r loop
    if private.luhn_valid(regexp_replace(m, '[^0-9]', '', 'g')) then
      return 'national_id';
    end if;
  end loop;
  -- US SSN written 3-2-4 with a valid structure.
  for m in select r[1] from regexp_matches(p_text, '((?<![0-9])[0-9]{3}[ -][0-9]{2}[ -][0-9]{4}(?![0-9]))', 'g') r loop
    d := regexp_replace(m, '[^0-9]', '', 'g');
    if substr(d, 1, 3) not in ('000', '666') and substr(d, 1, 1) <> '9'
       and substr(d, 4, 2) <> '00' and substr(d, 6, 4) <> '0000' then
      return 'national_id';
    end if;
  end loop;
  return null;
end $$;
comment on function private.sensitive_kind(text) is
  'card, national_id or null: whether free text holds a Luhn-valid payment card number (13-19 '
  'digits), a Luhn-valid SIN (9 digits) or a structurally valid SSN written 3-2-4. A guardrail '
  'against honest mistakes, not a DLP scanner: it does not see numbers split by words or '
  'unhyphenated SSNs.';
revoke all on function private.sensitive_kind(text) from public, anon, authenticated;

create function private.sensitive_guard(p_text text, p_code text default 'invalid_input', p_detail text default null)
returns void
language plpgsql immutable set search_path = '' as $$
declare
  k text := private.sensitive_kind(p_text);
begin
  if k is not null then
    -- The detail names the kind or the caller's key, never the text.
    raise exception using message = p_code, detail = coalesce(p_detail, 'sensitive_data:' || k);
  end if;
end $$;
comment on function private.sensitive_guard(text, text, text) is
  'Raises p_code (default invalid_input) when p_text holds a payment card or SIN/SSN number '
  '(private.sensitive_kind). DETAIL is p_detail, else sensitive_data:card or sensitive_data:national_id; '
  'never the text. A null or clean text passes. Used by intake field labels and answers and '
  'reusable by the forms engine.';
revoke all on function private.sensitive_guard(text, text, text) from public, anon, authenticated;

-- Hook for C7 (#1273): a sensitive field needs the org's recorded privacy contact. C7 replaces this
-- body with the real check; until then no contact can be recorded, so it does not block.
create function private.privacy_contact_recorded(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select true
$$;
comment on function private.privacy_contact_recorded(uuid) is
  'True when the org has a recorded privacy contact. Placeholder returning true until C7 '
  '(#1273) replaces it; check_intake_field calls it before a field becomes sensitive.';
revoke all on function private.privacy_contact_recorded(uuid) from public, anon, authenticated;

create or replace function private.check_intake_field() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type = 'select' and (
    jsonb_typeof(new.options) <> 'array'
    or jsonb_array_length(new.options) not between 1 and 50
    or exists (select 1 from jsonb_array_elements(new.options) o
               where jsonb_typeof(o) <> 'string' or length(btrim(o #>> '{}')) not between 1 and 80)
    or (select count(distinct o) from jsonb_array_elements(new.options) o) <> jsonb_array_length(new.options)
  ) then
    raise exception 'invalid_input' using detail = 'options';
  end if;
  perform private.sensitive_guard(new.label, 'invalid_input');
  perform private.sensitive_guard(new.help, 'invalid_input');
  if new.options is not null then
    perform private.sensitive_guard(new.options::text, 'invalid_input');
  end if;
  if new.sensitivity = 'sensitive' then
    if tg_op = 'INSERT' or old.sensitivity <> 'sensitive' then
      if not private.privacy_contact_recorded(new.org_id) then
        raise exception 'invalid_input' using detail = 'privacy_contact_required';
      end if;
      if (select o.health_tagged from app.organizations o where o.id = new.org_id) and new.type <> 'text' then
        raise exception 'invalid_input' using detail = 'health_tagged_text_only';
      end if;
    end if;
    new.retention_days := coalesce(new.retention_days, 90);
  end if;
  if tg_op = 'INSERT' and (select count(*) from app.intake_fields f where f.queue_id = new.queue_id) >= 20 then
    raise exception 'invalid_input' using detail = 'too many fields';
  end if;
  return new;
end $$;
comment on function private.check_intake_field() is
  'BEFORE trigger on app.intake_fields: select options are 1 to 50 distinct non-empty strings of '
  'at most 80 characters; a queue has at most 20 fields; label, help and options may not contain '
  'a payment-card or SIN/SSN number (invalid_input, DETAIL sensitive_data:card|national_id). A '
  'field becoming sensitive needs the org''s privacy contact (private.privacy_contact_recorded; '
  'invalid_input, DETAIL privacy_contact_required), is text only in a health-tagged org '
  '(health_tagged_text_only) and gets retention_days 90 unless set.';
create or replace function private.validate_answers(p_queue_id uuid, p_answers jsonb, p_audience text)
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
  -- Bounded before any work: a queue has at most 20 fields, so more keys cannot all be valid.
  if jsonb_typeof(a) <> 'object' or octet_length(a::text) > 16384 then
    raise exception 'invalid_answers' using detail = '';
  end if;

  -- Every key must name an active field this audience may answer.
  for k in select jsonb_object_keys(a) loop
    select * into f from app.intake_fields x where x.queue_id = p_queue_id and x.key = k and x.active;
    if not found or (p_audience = 'guest' and f.visibility = 'staff_only') then
      -- Echo only what looks like a field key, never arbitrary guest text.
      raise exception 'invalid_answers' using detail = case when k ~ '^[a-z][a-z0-9_]{0,39}$' then k else '' end;
    end if;
  end loop;

  for f in select * from app.intake_fields x where x.queue_id = p_queue_id and x.active order by x.position, x.key loop
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
           and (select o.health_tagged from app.organizations o where o.id = f.org_id) then
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
comment on function private.validate_answers(uuid, jsonb, text) is
  'Checks intake answers against the queue''s active fields and returns them normalised (blank '
  'answers dropped, phones as E.164). p_audience guest (join: staff-only fields refused, required '
  'guest fields enforced) or staff (set_visit_answers and staff adds: any active field, nothing '
  'required). Unknown, inactive or wrongly typed answers raise invalid_answers with the failing '
  'key as DETAIL (never the value). Text is at most 500 characters (200 for a sensitive field of a '
  'health-tagged org). Text and number answers holding a payment-card or SIN/SSN number are '
  'refused (private.sensitive_guard).';
revoke all on function private.validate_answers(uuid, jsonb, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
