-- SMS names are plain names (issue #1247). The save-time guard (20261107235515) checks the template body, but the
-- values filled into it are tenant text too: the business name that opens every framed text (location_name), the
-- queue and counter names, the HELP reply's business name and contact, and the guest's typed first name. A manager
-- could name a location "Joe - 50% off at joes.example" and it would go out on the shared QueueThat number.
-- Fix, in the database and in one place: api.claim_outbox passes the variables of every SMS row through
-- private.sms_safe_vars. A name that is not a plain name (a link, address, phone-like digits, a blocklisted term,
-- placeholder braces, or any character outside Latin letters, digits and ' & , # ( ) / -, at most 5 digits) is replaced by a neutral
-- fallback; a plain name is trimmed to 40 characters. The link/contact/term test is the S1 check, extracted into
-- private.sms_text_problem and shared with private.sms_guard so there is one rule.
-- Alternatives: (a) refuse at save on organizations, locations, queues and resources (rejected: four write paths,
-- existing rows stay unprotected, and a rename would fail for a reason that has nothing to do with SMS);
-- (b) sanitize in the dispatcher (rejected: the rule would live outside the database).

-- Shared text rules ---------------------------------------------------------------------------------
/** Lower case, NFKC, no zero-width/bidi characters, single spaces, accents folded: the form the checks read. */
create function private.sms_fold(p_text text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(regexp_replace(regexp_replace(normalize(normalize(coalesce(p_text, ''), nfkc), nfd),
                         '[­​-‏‪-‮⁠-⁤⁦-⁩﻿]', '', 'g'),
                         '\s+', ' ', 'g'),
                         '[\u0300-\u036F]', '', 'g'))
$$;
comment on function private.sms_fold(text) is
  'The form in which SMS text is checked: lower case, NFKC (fullwidth folds to ASCII), zero-width and bidi characters removed, whitespace collapsed, every accent and diacritic dropped (NFD).';
revoke all on function private.sms_fold(text) from public, anon;
grant execute on function private.sms_fold(text) to authenticated;

/** The first rule a text breaks, or null: a blocklisted term (the term), 'url' or 'contact'. */
create function private.sms_text_problem(p_text text) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_plain text := private.sms_fold(p_text);
  v_term text;
begin
  select t.term into v_term from app.sms_guard_terms t
  where v_plain ~ (case when t.term ~ '^[a-z0-9]' then '(^|[^a-z0-9])' else '' end
                   || regexp_replace(t.term, '([^a-z0-9 ])', '\\\1', 'g')
                   || case when t.term ~ '[a-z0-9]$' then '(e?s)?($|[^a-z0-9])' else '' end)
  order by t.term limit 1;
  if v_term is not null then
    return v_term;
  end if;
  if v_plain ~ '(https?:|www\.|[a-z0-9-]+\.[a-z]{2,}/|[a-z0-9-]+\.(com|net|org|io|co|cc|to|tk|ly|me|us|ca|mx|es|dev|page|app|info|biz|xyz|link|site|online|shop|store|top|club|live)([^a-z0-9]|$))' then
    return 'url';
  end if;
  -- Phone numbers, tel:/sms:/mailto: links and addresses: a digit run of 7+ (spaces, dots, dashes allowed) or an @.
  if v_plain ~ '(tel:|sms:|mailto:|@)' or regexp_replace(v_plain, '[ .()-]', '', 'g') ~ '[0-9]{7,}' then
    return 'contact';
  end if;
  return null;
end $$;
comment on function private.sms_text_problem(text) is
  'The first S1 rule a text breaks: a term from app.sms_guard_terms (the term), "url" (a link or domain) or "contact" '
  '(a phone number, address, tel:/sms:/mailto:); null when none. Pure check, never raises.';
revoke all on function private.sms_text_problem(text) from public, anon;
grant execute on function private.sms_text_problem(text) to authenticated;

-- redefines private.sms_guard from 20261107235515_sms_template_guard.sql (same rules; the term/link/contact scan is
-- now private.sms_text_problem)
create or replace function private.sms_guard(p_org_id uuid, p_locale text, p_trigger text, p_body text) returns void
language plpgsql stable set search_path = '' as $$
declare
  v_plain text := private.sms_fold(p_body);
  v_problem text;
  v_name text;
  v_n int;
begin
  if length(coalesce(p_body, '')) > 1000 then
    raise exception 'template_guard' using detail = 'length';
  end if;
  -- {status_link} is the one link a text may carry; any other address or link variable is refused.
  v_plain := regexp_replace(v_plain, '\{\{\s*status_link\s*\}\}|\{status_link\}', '', 'g');
  v_problem := private.sms_text_problem(v_plain);
  if v_problem is not null then
    raise exception 'template_guard' using detail = v_problem;
  end if;
  if v_plain ~ '\{\{?\s*unsubscribe_url' then
    raise exception 'template_guard' using detail = 'unsubscribe_url';
  end if;
  -- A name must stand alone: next to a letter, digit, dot or another placeholder it could spell a link
  -- ("{{location_name}}.com/deal"). A sentence-ending dot is fine.
  foreach v_name in array array['guest_first_name', 'location_name', 'queue_name', 'counter', 'service', 'event_title', 'business_name'] loop
    if v_plain ~ ('([a-z0-9.}]\{\{?' || v_name || '|' || v_name || '\}\}?([a-z0-9{]|\.[a-z0-9]))') then
      raise exception 'template_guard' using detail = v_name;
    end if;
  end loop;

  select c.segments into v_n from private.sms_compose(p_org_id, p_locale, p_trigger, p_body, '{}') c;
  if v_n > 3 then
    raise exception 'template_guard' using detail = v_n || ' segments';
  end if;
end $$;
comment on function private.sms_guard(uuid, text, text, text) is
  'Raises template_guard (term, url, contact, unsubscribe_url or "N segments" in DETAIL) for a tenant SMS body that '
  'contains a blocklisted term, a link or contact detail other than {status_link}, or needs more than 3 segments once framed.';

-- Plain names ------------------------------------------------------------------------------------------
/** p_text, or null when it contains a blocklisted term, link or contact detail. */
create function private.sms_term_free(p_text text) returns text
language sql stable set search_path = '' as $$
  select case when private.sms_text_problem(p_text) is null then p_text end
$$;
revoke all on function private.sms_term_free(text) from public, anon;

/** A tenant-typed name made safe for a text: itself if it is a plain name, else p_fallback. */
create function private.sms_safe_label(p_text text, p_fallback text) returns text
language plpgsql stable set search_path = '' as $$
declare
  t text := btrim(left(regexp_replace(translate(
              regexp_replace(normalize(coalesce(p_text, ''), nfkc),
                '[­​-‏‪-‮⁠-⁤⁦-⁩﻿]', '', 'g'),
              chr(8217) || chr(8216), '''''') , '\s+', ' ', 'g'), 40));
begin
  if t = ''
     or t !~ '^[A-Za-z0-9\u00C0-\u024F ''&,#()/-]+$'
     or length(regexp_replace(t, '[^0-9]', '', 'g')) > 5
     or t ~ '1[ -]?8(00|33|44|55|66|77|88)'
     or private.sms_text_problem(t) is not null then
    return p_fallback;
  end if;
  return t;
end $$;
comment on function private.sms_safe_label(text, text) is
  'A tenant-typed name (business, queue, counter) in the only form an SMS may carry: at most 40 characters of letters, '
  'digits and '' & , . # ( ) / - with no link, address, phone-like digits or blocklisted term; anything else gives p_fallback.';
revoke all on function private.sms_safe_label(text, text) from public, anon;

/** The variables of an SMS row as the dispatcher may render them. */
create function private.sms_safe_vars(p_vars jsonb, p_locale text, p_org_name text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v jsonb := coalesce(p_vars, '{}'::jsonb);
  es boolean := p_locale = 'es';
  v_business text := coalesce(private.sms_safe_label(p_org_name, null), 'QueueThat');
  s text;
begin
  if v ? 'location_name' then
    v := v || jsonb_build_object('location_name', private.sms_safe_label(v ->> 'location_name', v_business));
  end if;
  if v ? 'business_name' then
    v := v || jsonb_build_object('business_name', private.sms_safe_label(v ->> 'business_name', v_business));
  end if;
  if v ? 'queue_name' then
    v := v || jsonb_build_object('queue_name',
      private.sms_safe_label(v ->> 'queue_name', case when es then 'la fila' else 'the queue' end));
  end if;
  if v ? 'counter' then
    v := v || jsonb_build_object('counter',
      private.sms_safe_label(v ->> 'counter', case when es then 'el mostrador' else 'the front desk' end));
  end if;
  if v ? 'guest_first_name' then
    v := v || jsonb_build_object('guest_first_name',
      coalesce(private.sms_term_free(private.sms_guest_name(v ->> 'guest_first_name')), case when es then 'hola' else 'there' end));
  end if;
  -- Any other tenant text (service and event names, ...) is a name too; only these system values pass as they are.
  for s in select key from jsonb_each(v) where jsonb_typeof(value) = 'string'
           and key <> all (array['location_name', 'business_name', 'queue_name', 'counter', 'guest_first_name',
                                 'business_phone', 'support_contact', 'ticket', 'position', 'eta_range', 'appointment_time',
                                 'code', 'offer_expires', 'starts_epoch', 'status_link', 'org_legal_name', 'org_postal_address'])
  loop
    v := v || jsonb_build_object(s, private.sms_safe_label(v ->> s, case when es then 'tu visita' else 'your visit' end));
  end loop;
  -- Contact details: a phone number or one plain email address, nothing else.
  if v ? 'business_phone' then
    s := btrim(v ->> 'business_phone');
    if s !~ '^\+?[0-9 ().-]{7,20}$' then
      v := v - 'business_phone';
    end if;
  end if;
  if v ? 'support_contact' then
    s := btrim(v ->> 'support_contact');
    if s !~ '^\+?[0-9 ().-]{7,20}$' and s !~ '^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){1,3}$' then
      v := v || jsonb_build_object('support_contact', 'support@queuethat.com');
    end if;
  end if;
  return v;
end $$;
comment on function private.sms_safe_vars(jsonb, text, text) is
  'The one place tenant and guest text is made safe for an SMS: location, business, queue and counter names through '
  'private.sms_safe_label (neutral fallback when not a plain name), the guest''s first name through private.sms_guest_name, '
  'business_phone and support_contact reduced to a phone number or one email address. Other variables pass unchanged.';
revoke all on function private.sms_safe_vars(jsonb, text, text) from public, anon;

-- redefines api.claim_outbox from 20261108001421_send_window_owner.sql (only the base-vars lateral changed)
create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  -- Send window (3-CG9, C5): a row that is outside its window waits for the next opening instead of
  -- being claimed, so a deferral costs no attempt and no dispatcher call. private.send_window_open owns
  -- which rows are exempt.
  update app.notifications n
  set next_attempt_at = w.opens, quiet_hours_deferred = true
  from (select x.id, private.next_send_window(coalesce(v.location_id, ap.location_id), now()) as opens
        from app.notifications x
        left join app.visits v on v.id = x.visit_id
        left join app.appointments ap on ap.id = x.appointment_id
        where x.status in ('queued', 'failed') and x.next_attempt_at <= now()
          and not private.send_window_open(coalesce(v.location_id, ap.location_id), x.template_key, x.channel, now())
        for update of x skip locked) w
  where n.id = w.id and w.opens > now();

  update app.notifications
  set status = 'dead', error_code = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= private.outbox_max_attempts();

  return query
  with due as (
    select n.id
    from app.notifications n
    left join app.visits dv on dv.id = n.visit_id
    left join app.appointments dap on dap.id = n.appointment_id
    where ((n.status in ('queued', 'failed') and n.next_attempt_at <= now())
        or (n.status = 'claimed' and n.locked_until < now()))
      -- The window is checked again here: nothing outside it is ever claimed, whatever was queued
      -- after the deferral pass above.
      and private.send_window_open(coalesce(dv.location_id, dap.location_id), n.template_key, n.channel, now())
    order by n.next_attempt_at
    limit p_limit
    for update of n skip locked
  ),
  claimed as (
    update app.notifications n
    set status = 'claimed',
        locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = n.attempts + case when n.status = 'claimed' then 1 else 0 end,
        consent_id = case when n.channel = 'push' or (n.visit_id is null and n.appointment_id is null) then null else (
          select c.id from app.consents c
          where c.contact_id = n.recipient_ref and c.channel = n.channel and c.purpose = n.category
          order by c.captured_at desc limit 1) end,
        recipient_hash = case when n.channel <> 'push' and (n.visit_id is not null or n.appointment_id is not null) then
          encode(sha256(convert_to(private.canonical_email(
            private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)), 'UTF8')), 'hex')
        end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, case when n.channel = 'sms' and n.visit_id is not null and n.template_key <> 'help'
              then private.sms_compose(t.body, t.locale) else t.body end,
         (case when n.category = 'marketing' then
              base.vars || jsonb_build_object('org_legal_name', o.legal_name, 'org_postal_address', o.postal_address)
              else base.vars end) || jsonb_build_object('org_hide_product_branding', o.hide_product_branding),
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              when a.value is not null then jsonb_build_object('kind', 'address', 'value', a.value)
         end,
         -- A push subscription is its own opt-in, and account mail is part of the service the
         -- member signed up for; other channels need the latest consent granted.
         n.channel = 'push' or (n.visit_id is null and n.appointment_id is null)
           -- Decision 20 (#398): an email typed at join consents to transactional mail about
           -- that visit only. The visit row (source, joined_at) is the record, and relevance ends
           -- it with the visit. SMS needs its own explicit consent (TCPA); marketing never rides.
           or (n.recipient_ref = coalesce(n.visit_id, n.appointment_id) and n.channel = 'email' and n.category = 'transactional')
           or coalesce((select c.status = 'granted' and c.revoked_at is null
                        from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and (
           -- The org's own list, plus bounces and complaints from any org: the address is dead
           -- or unwilling everywhere.
           exists (select 1 from app.suppressions sp
                   where sp.channel = n.channel and private.canonical_email(sp.value) = private.canonical_email(a.value)
                     and (sp.org_id = n.org_id or sp.reason in ('bounce', 'complaint')))
           -- Guest messages per address across the platform, so joins at many venues with one
           -- typed address can't flood it. Rows other batches hold count too; rows in this
           -- batch don't, so one batch can overshoot.
           or (n.recipient_hash is not null and (
                 select count(*) from app.notifications s
                 where s.recipient_hash = n.recipient_hash and s.status in ('claimed', 'sent')
                   and s.updated_at > now() - interval '1 day') >= private.address_daily_cap())),
         l.tz, n.attempts,
         -- A visit's token is stored hashed, so no message can link to its status page. An appointment
         -- email gets a one-off manage link instead: minted here, stored only as a hash, shown nowhere
         -- but this return value. A retry mints another and keeps the first (it may already be in a delivered mail).
         case when n.channel = 'email' and n.appointment_id is not null and n.template_key like 'appointment\_%'
              then private.mint_manage_path(n.appointment_id, n.id) end
  from claimed n
  join app.organizations o on o.id = n.org_id
  cross join lateral (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
  -- Account mail has no visit or appointment, so no location time zone either.
  left join app.visits v on v.id = n.visit_id
  left join app.appointments ap on ap.id = n.appointment_id
  left join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
  -- The business's name is not stored on the row, so the join confirmation said "us". Fill it here
  -- from the location; a value the row already carries (appointments set their own) wins.
  -- SMS text is made safe here, for every SMS row, whatever enqueued it (issue #1247).
  cross join lateral (select case when n.channel = 'sms'
                        then private.sms_safe_vars(jsonb_strip_nulls(jsonb_build_object('location_name', l.name)) || n.vars,
                                                   coalesce(v.locale, ap.locale, o.default_locale), o.name)
                        else jsonb_strip_nulls(jsonb_build_object('location_name', l.name)) || n.vars end) base (vars)
  left join lateral private.resolve_template(n.org_id, coalesce(v.queue_id, ap.queue_id), n.template_key, n.channel,
                                             coalesce(v.locale, ap.locale, o.default_locale)) t on true;
end $$;

