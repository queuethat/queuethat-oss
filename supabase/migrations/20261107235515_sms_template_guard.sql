-- Locked SMS templates, step 2 (plan S1, issue #1218). #20261107211348 made the database add the business
-- name and the STOP/HELP footer when a row is claimed. This adds the rest of the lock:
--   * the footer wording is versioned data (app.sms_footers), so changing it never touches tenant rows;
--   * private.sms_compose(org, locale, trigger, body, vars) shows the final text with its segment count and
--     encoding (GSM-7 vs UCS-2), the number the editor badge and the save-time check both use;
--   * a tenant SMS override is refused at save when, framed, it needs more than 3 segments, carries a link
--     other than {status_link}, or contains a term from app.sms_guard_terms (error template_guard, the term
--     or reason in DETAIL);
--   * system SMS defaults for position_changed, EN and ES, inactive until an org turns them on.
-- Alternatives considered: (a) a CHECK constraint on the table (rejected: it cannot read the footer or the
-- blocklist and gives no DETAIL); (b) a new api.* validate RPC for the editor (rejected: the existing save
-- path already fails with named errors, and rule 1 says extend before adding an entry point).
-- Note: no api.upsert_template exists; tenants write app.notification_templates under RLS and the
-- validate_template trigger is the single save-time gate, so the guard lives there.

------------------------------------------------------------------------------------------------
-- Footers and blocklist
------------------------------------------------------------------------------------------------
create table app.sms_footers (
  locale text not null check (locale ~ '^[a-z]{2}$'),
  version int not null check (version > 0),
  text text not null check (text like '%STOP%'),
  primary key (locale, version)
);
comment on table app.sms_footers is
  'The opt-out and help line that closes every framed guest SMS, per locale. Append a higher version to '
  'change the wording; the highest version is used. Every footer must contain STOP. Written by migrations only.';
alter table app.sms_footers enable row level security;
create policy sms_footers_select on app.sms_footers for select to authenticated using (true);
revoke insert, update, delete, truncate on app.sms_footers from public, anon, authenticated, service_role;
insert into app.sms_footers (locale, version, text) values
  ('en', 1, 'Reply STOP to opt out, HELP for help.'),
  ('es', 1, 'Responde STOP para cancelar, AYUDA para ayuda.');

create table app.sms_guard_terms (
  term text primary key check (term ~ '^[a-z0-9%$'' -]+$' and term = btrim(term)),
  reason text not null check (reason in ('promo', 'opt_out'))
);
comment on table app.sms_guard_terms is
  'Lowercase ASCII words and phrases a tenant SMS body may not contain (matched on word boundaries, '
  'ignoring case and accents): promotional wording that turns a service text into marketing, and wording '
  'that argues with the STOP footer. Tunable by migration; never edited by tenants.';
alter table app.sms_guard_terms enable row level security;
create policy sms_guard_terms_select on app.sms_guard_terms for select to authenticated using (true);
revoke insert, update, delete, truncate on app.sms_guard_terms from public, anon, authenticated, service_role;
insert into app.sms_guard_terms (term, reason) values
  ('sale', 'promo'), ('discount', 'promo'), ('promo', 'promo'), ('promotion', 'promo'), ('coupon', 'promo'),
  ('offer', 'promo'), ('deal', 'promo'), ('deals', 'promo'), ('free', 'promo'), ('prize', 'promo'),
  ('winner', 'promo'), ('% off', 'promo'), ('bonus', 'promo'), ('gift card', 'promo'), ('giveaway', 'promo'),
  ('limited time', 'promo'), ('act now', 'promo'), ('buy now', 'promo'), ('click here', 'promo'),
  ('subscribe', 'promo'), ('gratis', 'promo'), ('oferta', 'promo'), ('descuento', 'promo'),
  ('promocion', 'promo'), ('cupon', 'promo'), ('premio', 'promo'), ('ganador', 'promo'), ('rebaja', 'promo'),
  ('regalo', 'promo'), ('sorteo', 'promo'), ('compra ahora', 'promo'), ('tiempo limitado', 'promo'),
  ('unsubscribe', 'opt_out'), ('opt out', 'opt_out'), ('opt-out', 'opt_out'), ('ignore stop', 'opt_out'),
  ('do not reply', 'opt_out'), ('dont reply', 'opt_out'), ('reply start', 'opt_out'),
  ('ignora stop', 'opt_out'), ('no respondas', 'opt_out'), ('respond to stop', 'opt_out'),
  ('disregard stop', 'opt_out'), ('disregard the stop', 'opt_out'), ('ignore the stop', 'opt_out'),
  ('honor stop', 'opt_out'), ('reply yes', 'opt_out'), ('percent off', 'promo'), ('buy one', 'promo');

------------------------------------------------------------------------------------------------
-- Frame pieces
------------------------------------------------------------------------------------------------
-- redefines private.sms_footer from 20261107211348_sms_message_frame.sql
create or replace function private.sms_footer(p_locale text) returns text
language sql stable set search_path = '' as $$
  select f.text from app.sms_footers f
  where f.locale = case when p_locale = 'es' then 'es' else 'en' end
  order by f.version desc limit 1
$$;
comment on function private.sms_footer(text) is
  'The opt-out and help line closing every framed SMS: the latest app.sms_footers version for the locale (es, else en).';
-- The save-time guard runs as the member who saves, so the pure formatting helpers must be callable by them.
grant execute on function private.sms_footer(text), private.sms_compose(text, text) to authenticated;

-- The two-argument frame reads the footer table now, so it can no longer be declared immutable.
alter function private.sms_compose(text, text) stable;

/** Segments and encoding of a finished SMS (GSM 03.38 for GSM-7; UTF-16 units for UCS-2). */
create function private.sms_measure(p_text text, out segments int, out encoding text)
language plpgsql immutable set search_path = '' as $$
declare
  basic constant text := '@£$¥èéùìòÇ' || chr(10) || 'Øø' || chr(13)
    || 'ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  ext constant text := '^{}\[~]|€' || chr(12);
  c text;
  gsm int := 0;
  ucs int := 0;
begin
  encoding := 'gsm7';
  foreach c in array regexp_split_to_array(coalesce(p_text, ''), '') loop
    continue when c = '';
    ucs := ucs + case when ascii(c) > 65535 then 2 else 1 end;
    if strpos(basic, c) > 0 then gsm := gsm + 1;
    elsif strpos(ext, c) > 0 then gsm := gsm + 2;
    else encoding := 'ucs2';
    end if;
  end loop;
  if encoding = 'gsm7' then
    segments := case when gsm = 0 then 0 when gsm <= 160 then 1 else ceil(gsm / 153.0)::int end;
  else
    segments := case when ucs <= 70 then 1 else ceil(ucs / 67.0)::int end;
  end if;
end $$;
comment on function private.sms_measure(text) is
  'Segment count and encoding (gsm7 or ucs2) of a finished SMS. Any character outside GSM-7, such as an '
  'accented a, i, o, u or a curly quote, makes the whole message ucs2: 70-character segments, 67 when joined.';
revoke all on function private.sms_measure(text) from public, anon;
grant execute on function private.sms_measure(text) to authenticated;

/** A guest-typed first name made safe to put in a text: one word of Latin letters, ' and -, at most 20 characters. */
create function private.sms_guest_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  select nullif(left(regexp_replace(regexp_replace(split_part(btrim(coalesce(p_name, '')), ' ', 1),
                                                   '[^A-Za-z\u00C0-\u024F''-]', '', 'g'), '^[-'']+|[-'']+$', '', 'g'), 20), '')
$$;
comment on function private.sms_guest_name(text) is
  'The only form in which a guest-typed name may reach an SMS: its first word, letters, apostrophe and hyphen only '
  '(no digits, dots or slashes, so it cannot spell a link or a phone number), no edge hyphens, 20 characters at most; null if nothing is left.';
revoke all on function private.sms_guest_name(text) from public, anon;
grant execute on function private.sms_guest_name(text) to authenticated;

-- redefines private.sms_compose from 20261107211348_sms_message_frame.sql (the checker matches by name: this is a new
-- five-argument overload that calls the two-argument frame, which stays as it is)
-- Variables missing from p_vars take a long stand-in, so a length check is a worst case, not a guess.
create function private.sms_compose(p_org_id uuid, p_locale text, p_trigger text, p_body text, p_vars jsonb)
returns table (final_text text, segments int, encoding text)
language plpgsql stable set search_path = '' as $$
declare
  v_vars jsonb;
  v_text text;
  v_name text;
  k text;
  v text;
begin
  -- The business name is the org's or the longest of its locations' (the claim fills the real one).
  select n into v_name from (
    select o.name as n from app.organizations o where o.id = p_org_id
    union all
    select l.name from app.locations l where l.org_id = p_org_id) s
  order by length(n) desc limit 1;
  v_vars := jsonb_build_object(
      'guest_first_name', 'Alexandria', 'ticket', 'A-123', 'queue_name', 'Main queue', 'counter', 'Counter 3',
      'eta_range', '10-15 min', 'business_phone', '+1 415 555 0100', 'appointment_time', '3:30 pm',
      'status_link', 'https://queuethat.com/v/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'position', '12',
      'code', '123456', 'location_name', coalesce(v_name, 'Business'))
    || coalesce(p_vars, '{}'::jsonb);
  -- A guest's name is never taken as typed.
  if p_vars ? 'guest_first_name' then
    v_vars := v_vars || jsonb_build_object('guest_first_name',
      coalesce(private.sms_guest_name(p_vars ->> 'guest_first_name'), 'there'));
  end if;

  v_text := case when p_trigger = 'help' then p_body else private.sms_compose(p_body, p_locale) end;
  -- Optional [segments] holding a placeholder render in full for a worst case.
  v_text := regexp_replace(v_text, ' ?\[([^\[\]]*\{[^\[\]]*)\]', ' \1', 'g');
  for k, v in select * from jsonb_each_text(v_vars) loop
    continue when k !~ '^[a-z_]+$';
    v_text := regexp_replace(v_text, '\{\{\s*' || k || '\s*\}\}|\{' || k || '\}', replace(v, '\', '\\'), 'g');
  end loop;
  v_text := regexp_replace(v_text, '\{\{?[A-Za-z0-9_.]+\}?\}', '', 'g');
  return query select v_text, m.segments, m.encoding from private.sms_measure(v_text) m;
end $$;
comment on function private.sms_compose(uuid, text, text, text, jsonb) is
  'The final text of a guest SMS as it would be sent, with its segment count and encoding. The frame (business '
  'name first, versioned opt-out line last) is added here exactly as api.claim_outbox adds it; the HELP reply keeps '
  'its own text. Variables missing from p_vars take a long stand-in, so segments is a worst case; guest_first_name '
  'is reduced by private.sms_guest_name. Never raises for a body: the save-time check uses the result.';
revoke all on function private.sms_compose(uuid, text, text, text, jsonb) from public, anon;
grant execute on function private.sms_compose(uuid, text, text, text, jsonb) to authenticated;

------------------------------------------------------------------------------------------------
-- Save-time guard
------------------------------------------------------------------------------------------------
create function private.sms_guard(p_org_id uuid, p_locale text, p_trigger text, p_body text) returns void
language plpgsql stable set search_path = '' as $$
declare
  -- NFKC folds fullwidth forms; format characters (zero-width, bidi overrides) are dropped.
  v_plain text := translate(lower(regexp_replace(regexp_replace(normalize(coalesce(p_body, ''), nfkc),
                            '[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]', '', 'g'),
                            '\s+', ' ', 'g')),
                            'áéíóúñüàèìòù', 'aeiounuaeiou');
  v_term text;
  v_n int;
begin
  if length(coalesce(p_body, '')) > 1000 then
    raise exception 'template_guard' using detail = 'length';
  end if;
  select t.term into v_term from app.sms_guard_terms t
  where v_plain ~ (case when t.term ~ '^[a-z0-9]' then '(^|[^a-z0-9])' else '' end
                   || regexp_replace(t.term, '([^a-z0-9 ])', '\\\1', 'g')
                   || case when t.term ~ '[a-z0-9]$' then '(e?s)?($|[^a-z0-9])' else '' end)
  order by t.term limit 1;
  if v_term is not null then
    raise exception 'template_guard' using detail = v_term;
  end if;

  -- {status_link} is the one link a text may carry; any other address or link variable is refused.
  v_plain := regexp_replace(v_plain, '\{\{\s*status_link\s*\}\}|\{status_link\}', '', 'g');
  if v_plain ~ '\{\{?\s*unsubscribe_url' then
    raise exception 'template_guard' using detail = 'unsubscribe_url';
  end if;
  if v_plain ~ '(https?:|www\.|[a-z0-9-]+\.[a-z]{2,}/|[a-z0-9-]+\.(com|net|org|io|co|cc|to|tk|ly|me|us|ca|mx|es|dev|page|app|info|biz|xyz|link|site|online|shop|store|top|club|live)([^a-z0-9]|$))' then
    raise exception 'template_guard' using detail = 'url';
  end if;
  -- Phone numbers, tel:/sms:/mailto: links and addresses: a digit run of 7+ (spaces, dots, dashes allowed) or an @.
  if v_plain ~ '(tel:|sms:|mailto:|@)' or regexp_replace(v_plain, '[ .()-]', '', 'g') ~ '[0-9]{7,}' then
    raise exception 'template_guard' using detail = 'contact';
  end if;
  -- A guest's name must stand alone: next to a letter, digit or dot it could spell a link.
  if v_plain ~ '([a-z0-9.]\{\{?guest_first_name|guest_first_name\}\}?([a-z0-9]|\.[a-z0-9]))' then
    raise exception 'template_guard' using detail = 'guest_first_name';
  end if;

  select c.segments into v_n from private.sms_compose(p_org_id, p_locale, p_trigger, p_body, '{}') c;
  if v_n > 3 then
    raise exception 'template_guard' using detail = v_n || ' segments';
  end if;
end $$;
comment on function private.sms_guard(uuid, text, text, text) is
  'Raises template_guard (term, url, unsubscribe_url or "N segments" in DETAIL) for a tenant SMS body that '
  'contains a blocklisted term, a link other than {status_link}, or needs more than 3 segments once framed.';
revoke all on function private.sms_guard(uuid, text, text, text) from public, anon;
grant execute on function private.sms_guard(uuid, text, text, text) to authenticated;

-- redefines private.validate_template from 20261030062359_template_versions.sql
create or replace function private.validate_template() returns trigger
language plpgsql set search_path = '' as $$
declare
  allowed text[] := private.template_variables(new.trigger);
  unknown text;
  check_sms boolean := true;
begin
  if new.org_id is null then
    return new; -- system defaults are written by migrations
  end if;
  if new.category <> 'transactional' then
    raise exception 'invalid_category';
  end if;
  if allowed is null then
    raise exception 'invalid_trigger';
  end if;
  if private.template_malformed(new.body) or private.template_malformed(new.subject) then
    raise exception 'unknown_variable' using detail = 'malformed placeholder';
  end if;
  select u into unknown
  from unnest(private.template_used_variables(new.body) || private.template_used_variables(new.subject)) u
  where u <> all (allowed) order by u limit 1;
  if unknown is not null then
    raise exception 'unknown_variable' using detail = unknown;
  end if;
  -- A live SMS override is checked whenever its wording, language or switch changes, so an inactive
  -- override cannot be switched on past the guard. Turning one off is never blocked.
  if new.channel = 'sms' and new.active then
    if tg_op = 'UPDATE' then
      check_sms := (new.body, new.locale, new.trigger, new.channel, new.active)
        is distinct from (old.body, old.locale, old.trigger, old.channel, old.active);
    end if;
    if check_sms then
      perform private.sms_guard(new.org_id, new.locale, new.trigger, new.body);
    end if;
  end if;
  -- The version is the server's to keep: members cannot set or rewind it, so a snapshot is never
  -- skipped and notifications.template_version always names one text.
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then
      new.version := 1;
    end if;
  else
    if new.id <> old.id then
      raise exception 'immutable_column' using errcode = '42501';
    end if;
    new.version := old.version + case when (new.body, new.subject, new.active, new.trigger, new.channel,
                                            new.locale, new.queue_id)
      is distinct from (old.body, old.subject, old.active, old.trigger, old.channel, old.locale, old.queue_id)
      then 1 else 0 end;
  end if;
  new.updated_by := (select auth.uid());
  return new;
end $$;
comment on function private.validate_template() is
  'BEFORE INSERT/UPDATE on app.notification_templates for org and queue overrides: transactional '
  'guest triggers only (invalid_category, invalid_trigger), every {{variable}} on the trigger''s '
  'allowlist (unknown_variable, the name in the error detail), a live SMS body inside the locked frame '
  'rules (template_guard, see private.sms_guard), version +1 on a content change.';

------------------------------------------------------------------------------------------------
-- position_changed defaults (inactive: a tenant turns them on)
------------------------------------------------------------------------------------------------
insert into app.notification_templates (trigger, channel, locale, category, subject, body, active) values
  ('position_changed', 'sms', 'en', 'transactional', null, 'Your place in line is now number {position} ({ticket}).', false),
  ('position_changed', 'sms', 'es', 'transactional', null, 'Tu lugar en la fila es ahora el numero {position} ({ticket}).', false)
on conflict do nothing;
