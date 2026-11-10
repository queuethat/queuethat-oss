-- 2B-C5 (#304): guest export and import (C-6, no lock-in).
--
-- Bulk personal data: owner/admin only, aal2 when the caller has an authenticator, audited, and
-- exports are limited to five per org per day. Imported contacts get no marketing consent. A
-- transactional consent is recorded only when the row says so, with source 'import', the uploader
-- as captured_by and the consent text version the file names.
-- redefines api.export_guests from 20261030162713_api_contracts_2b.sql
-- redefines api.import_guests from 20261030162713_api_contracts_2b.sql

/** Dial code of the few countries a file may name; national numbers need one of these. */
create function private.dial_code(p_country text) returns text
language sql immutable set search_path = '' as $$
  select case upper(p_country)
    when 'US' then '1' when 'CA' then '1' when 'GB' then '44' when 'DE' then '49' when 'FR' then '33'
    when 'ES' then '34' when 'IT' then '39' when 'NL' then '31' when 'AU' then '61' when 'IN' then '91'
    when 'MX' then '52' when 'BR' then '55' when 'IE' then '353' when 'NZ' then '64' end
$$;
revoke all on function private.dial_code(text) from public, anon, authenticated;

/** E.164 for a phone typed in a file, or null when it cannot be normalised with the country default. */
create function private.normalize_phone(p_raw text, p_country text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := regexp_replace(coalesce(p_raw, ''), '[[:space:]().-]', '', 'g');
  d text := private.dial_code(p_country);
begin
  if v like '00%' then v := '+' || substr(v, 3); end if;
  if v !~ '^\+' then
    if d is null or v !~ '^[0-9]+$' then return null; end if;
    v := '+' || d || case when d = '1' then v else ltrim(v, '0') end;
  end if;
  return case when v ~ '^\+[1-9][0-9]{6,14}$' then v end;
end $$;
revoke all on function private.normalize_phone(text, text) from public, anon, authenticated;

create or replace function api.export_guests(p_org_id uuid) returns setof api.guest_export_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();
  perform pg_advisory_xact_lock(hashtext('export_guests:' || p_org_id::text));
  if (select count(*) from app.audit_log
      where org_id = p_org_id and action = 'EXPORT' and table_name = 'guest_list'
        and at > now() - interval '24 hours') >= 5 then
    raise exception 'rate_limited';
  end if;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id)
  values (p_org_id, (select auth.uid()), 'admin', 'EXPORT', 'guest_list', p_org_id::text);

  return query
  select g.id, g.first_name,
    (select c.value from app.guest_contacts c where c.guest_id = g.id and c.channel = 'phone' order by c.created_at limit 1),
    (select c.value from app.guest_contacts c where c.guest_id = g.id and c.channel = 'email' order by c.created_at limit 1),
    coalesce((select array_agg(t.name order by t.name) from app.guest_tag_links l
              join app.guest_tags t on t.id = l.tag_id where l.guest_id = g.id), '{}'),
    (select string_agg(n.body, E'\n' order by n.created_at) from app.guest_notes n
     where n.guest_id = g.id and n.deleted_at is null),
    (select count(*)::int from app.visits v where v.guest_id = g.id),
    (select max(v.joined_at) from app.visits v where v.guest_id = g.id),
    coalesce((select jsonb_object_agg(k.ch || ':' || k.purpose, k.status)
              from (select distinct on (s.channel, s.purpose) s.channel::text as ch, s.purpose::text as purpose, s.status
                    from app.consents s join app.guest_contacts c on c.id = s.contact_id
                    where c.guest_id = g.id order by s.channel, s.purpose, s.captured_at desc) k), '{}')
  from app.guests g
  where g.org_id = p_org_id and g.merged_into_id is null and g.anonymized_at is null
  order by g.created_at, g.id
  limit 50000;
end $$;
comment on function api.export_guests(uuid) is
  'One row per guest of the org: name, first phone and email, tags, notes, visit count and the '
  'latest consent status per channel and purpose. Owner or admin, otherwise not_found; mfa_required '
  'below aal2 for enrolled callers; rate_limited after five exports in 24 hours. Audited as EXPORT. '
  'Merged and anonymized guests are left out. Implemented in 2B-C5 (#304).';

create or replace function api.import_guests(p_org_id uuid, p_rows jsonb, p_idempotency_key uuid) returns setof api.import_row_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_claim record;
  r jsonb;
  n int := 0;
  v_name text;
  v_phone text;
  v_email text;
  v_country text;
  v_version text;
  v_tag text;
  v_existing uuid;
  v_guest uuid;
  v_contact uuid;
  v_channel app.notification_channel;
  v_out jsonb := '[]';
  v_res api.import_row_result;
begin
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 1000 then
    raise exception 'invalid_input';
  end if;
  perform private.require_aal2_if_enrolled();
  select * into v_claim from private.claim_idempotent(p_org_id, 'import_guests', p_idempotency_key);
  if v_claim.replay then
    -- Keys are per actor, not per org: a key reused for another org must not return this one's rows.
    if (v_claim.response ->> 'org_id')::uuid is distinct from p_org_id then
      raise exception 'invalid_input';
    end if;
    return query select * from jsonb_populate_recordset(null::api.import_row_result, v_claim.response -> 'rows');
    return;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    n := n + 1;
    v_res := row(n, null, null, null)::api.import_row_result;
    v_name := nullif(btrim(r ->> 'name'), '');
    v_country := upper(nullif(btrim(r ->> 'country'), ''));
    v_phone := null; v_email := null; v_guest := null; v_contact := null;
    if jsonb_typeof(r) <> 'object' then
      v_res.outcome := 'invalid'; v_res.error := 'not_an_object';
    elsif coalesce(length(v_name), 0) > 60 then
      v_res.outcome := 'invalid'; v_res.error := 'name_too_long';
    else
      if nullif(btrim(r ->> 'phone'), '') is not null and length(r ->> 'phone') <= 64 then
        v_phone := private.normalize_phone(r ->> 'phone', v_country);
      end if;
      if nullif(btrim(r ->> 'email'), '') is not null then
        v_email := lower(btrim(r ->> 'email'));
        if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          v_email := null;
          v_res.error := 'invalid_email';
        end if;
      end if;
      if nullif(btrim(r ->> 'phone'), '') is not null and v_phone is null then
        v_res.error := 'invalid_phone';
      end if;
      if v_phone is null and v_email is null then
        v_res.outcome := 'invalid';
        v_res.error := coalesce(v_res.error, 'no_contact');
      end if;
    end if;

    if v_res.outcome is null then
      select c.guest_id into v_existing from app.guest_contacts c
      where c.org_id = p_org_id and ((c.channel = 'phone' and c.value = v_phone)
                                     or (c.channel = 'email' and c.value = v_email))
      order by c.channel limit 1;
      v_res.outcome := case when v_existing is null then 'created' else 'matched' end;
      if v_existing is null then
        select o_guest_id into v_guest from private.find_or_create_guest(p_org_id, v_name, v_phone, v_email, 'import');
      else
        v_guest := v_existing;
        -- Attach what the file adds; a value that belongs to another guest stays where it is.
        if v_phone is not null then
          insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
          values (p_org_id, v_guest, 'phone', v_phone, 'import') on conflict do nothing;
        end if;
        if v_email is not null then
          insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
          values (p_org_id, v_guest, 'email', v_email, 'import') on conflict do nothing;
        end if;
      end if;
      v_res.guest_id := v_guest;

      v_version := left(nullif(btrim(r ->> 'consent_text_version'), ''), 64);
      if (r ->> 'transactional_consent') in ('true', 'yes', '1') then
        if v_version is null then
          v_res.error := 'consent_needs_text_version';
        else
          for v_contact, v_channel in
            select c.id, case c.channel when 'phone' then 'sms'::app.notification_channel else 'email' end
            from app.guest_contacts c
            where c.guest_id = v_guest and c.value in (coalesce(v_phone, ''), coalesce(v_email, ''))
          loop
            insert into app.consents (org_id, contact_id, channel, purpose, status, source,
                                      consent_text_version, consent_text_hash, captured_by_user_id)
            select p_org_id, v_contact, v_channel, 'transactional', 'granted', 'import', v_version,
                   encode(extensions.digest('import:' || v_version, 'sha256'), 'hex'), (select auth.uid())
            -- Never re-grant: any earlier row (granted or revoked) means the contact has a history.
            where not exists (select 1 from app.consents k where k.contact_id = v_contact
                              and k.channel = v_channel and k.purpose = 'transactional');
          end loop;
        end if;
      end if;

      if jsonb_typeof(r -> 'tags') = 'array' then
        for v_tag in select btrim(t) from jsonb_array_elements_text(r -> 'tags') t limit 10 loop
          continue when v_tag = '' or length(v_tag) > 40;
          insert into app.guest_tags (org_id, name) values (p_org_id, v_tag) on conflict do nothing;
          insert into app.guest_tag_links (org_id, guest_id, tag_id)
          select p_org_id, v_guest, t.id from app.guest_tags t
          where t.org_id = p_org_id and lower(t.name) = lower(v_tag) on conflict do nothing;
        end loop;
      end if;
    end if;
    v_out := v_out || to_jsonb(v_res);
    return next v_res;
  end loop;

  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (p_org_id, (select auth.uid()), 'admin', 'INSERT', 'guest_import', p_idempotency_key::text,
          jsonb_build_object('rows', n, 'created', (select count(*) from jsonb_array_elements(v_out) e where e ->> 'outcome' = 'created'),
                             'matched', (select count(*) from jsonb_array_elements(v_out) e where e ->> 'outcome' = 'matched')));
  perform private.save_idempotent('import_guests', p_idempotency_key,
    jsonb_build_object('org_id', p_org_id, 'rows', v_out));
  return;
end $$;
comment on function api.import_guests(uuid, jsonb, uuid) is
  'Imports up to 1000 rows ({name, phone, email, country, tags[], transactional_consent, '
  'consent_text_version}) and returns one result per row: created, matched (an existing contact '
  'was found; the file''s other contact is attached) or invalid with an error. No marketing '
  'consent is ever created; a transactional one only when the row asks and names a text version. '
  'Owner or admin, otherwise not_found; invalid_input for more than 1000 rows or a non-array; '
  'mfa_required below aal2 for enrolled callers. Audited. Idempotent on p_idempotency_key. '
  'Implemented in 2B-C5 (#304).';
