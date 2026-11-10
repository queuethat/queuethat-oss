-- M2b-2 (#1329): the queue scope from M1/M2 also binds the staff_* visit functions: add a walk-in,
-- capture consent, create a pay code, mark chat read, request a payment, send a chat message and
-- set companions. With organizations.scope_staff_to_lines off nothing changes. With it on, a scoped
-- staff member gets not_found for a queue or visit outside their queue_ids; unscoped staff, managers
-- and above are unaffected. Only the staff has_role test changes, to private.has_queue_access;
-- signatures, grants and comments stay.
--
-- Alternatives (rule 7): one shared check helper (rejected: each function loads its own row first,
-- so the check belongs beside that lookup) vs replacing the test in each entry point (chosen, as in M2).

-- redefines api.staff_add_visit from 20261025003700_join_version_bump.sql
create or replace function api.staff_add_visit(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_party_size int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  joined record;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_queue_access(q.org_id, q.id, 'staff') then
    raise exception 'not_found';
  end if;

  select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
    null, p_party_size, null, p_idempotency_key, 'staff', 'staff', (select auth.uid()));
  -- join_core bumps the queue version. The token is dropped: staff show the guest a QR by
  -- issuing a new one.

  return private.visit_row(joined.visit_id);
end $$;

-- redefines api.staff_capture_consent from 20261107205516_staff_number_confirm.sql
create or replace function api.staff_capture_consent(p_visit_id uuid, p_channel text, p_attested boolean, p_text_version int, p_idempotency_key uuid) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_claim record;
  v_contact uuid;
  v_guest uuid;
  c app.consents;
begin
  if p_channel is null or p_channel not in ('sms', 'whatsapp') or p_text_version is null or p_text_version < 1
     or p_idempotency_key is null or p_attested is null then
    raise exception 'invalid_input';
  end if;
  select * into v from app.visits where id = p_visit_id;
  if v.id is null or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not p_attested then
    raise exception 'attestation_required';
  end if;
  if v.status not in ('expected', 'waiting', 'called', 'serving') or v.guest_phone_e164 is null and v.contact_id is null then
    raise exception 'invalid_input';
  end if;

  select * into v_claim from private.claim_idempotent(v.org_id, 'staff_capture_consent', p_idempotency_key);
  if v_claim.replay then
    return private.consent_row_of((v_claim.response ->> 'id')::uuid);
  end if;

  select gc.id, gc.guest_id into v_contact, v_guest
  from app.guest_contacts gc
  where gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone';
  if v_contact is null then
    select gc.id, gc.guest_id into v_contact, v_guest
    from app.guest_contacts gc
    where gc.org_id = v.org_id and gc.channel = 'phone' and gc.value = v.guest_phone_e164;
  end if;

  if exists (select 1 from app.suppressions sp
             where sp.org_id = v.org_id and sp.channel = p_channel::app.notification_channel
               and sp.value = coalesce(v.guest_phone_e164, (select gc.value from app.guest_contacts gc where gc.id = v_contact))) then
    raise exception 'contact_suppressed';
  end if;

  if v_contact is null then
    v_guest := coalesce(v.guest_id, gen_random_uuid());
    insert into app.guests (id, org_id, first_name)
    values (v_guest, v.org_id, left(v.guest_name, 60))
    on conflict (id) do nothing;
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (v.org_id, v_guest, 'phone', v.guest_phone_e164, 'staff')
    returning id into v_contact;
  end if;

  if v.contact_id is distinct from v_contact then
    perform private.set_actor('staff', (select auth.uid()), null, 'consent_captured');
    update app.visits set contact_id = v_contact, guest_id = coalesce(guest_id, v_guest) where id = v.id;
  end if;

  select * into c from app.consents x
  where x.contact_id = v_contact and x.channel = p_channel::app.notification_channel and x.purpose = 'transactional'
  order by x.captured_at desc limit 1;
  if c.id is null or c.status <> 'granted' then
    insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version,
                              consent_text_hash, captured_by_user_id, attested_at, attestation_text_version)
    values (v.org_id, v_contact, p_channel::app.notification_channel, 'transactional', 'granted', 'staff',
            p_text_version::text, encode(sha256(convert_to('staff-attestation:v' || p_text_version, 'UTF8')), 'hex'),
            (select auth.uid()), now(), p_text_version)
    returning * into c;
  end if;
  -- Over the shared number the attested number is asked once to confirm: its owner replies YES.
  -- (The reply is a one-time text to a number whose owner has not yet agreed to anything else.)
  -- At most 20 confirmations per org per hour and 2 per number per day across all orgs, so a tenant cannot
  -- use the shared sender to text numbers it picked. Over a cap the attestation is still recorded; the
  -- number just stays unconfirmed. One per contact per UTC day, so a dead or unanswered one can be asked again.
  if p_channel = 'sms' and private.platform_sms_mode(v.org_id)
     and exists (select 1 from app.guest_contacts gc where gc.id = v_contact and gc.verified_at is null)
     and (select count(*) from app.notifications n where n.org_id = v.org_id and n.template_key = 'reply_confirm_number'
          and n.created_at > now() - interval '1 hour') < 20
     and (select count(*) from app.notifications n join app.guest_contacts cc on cc.id = n.recipient_ref
          where n.template_key = 'reply_confirm_number' and n.created_at > now() - interval '1 day'
            and cc.value = (select gc.value from app.guest_contacts gc where gc.id = v_contact)) < 2 then
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
    select v.org_id, v.id, 'sms', v_contact, 'reply_confirm_number', t.version, t.category,
           'reply_confirm_number:' || v_contact || ':' || (now() at time zone 'UTC')::date
    from private.resolve_template(v.org_id, v.queue_id, 'reply_confirm_number', 'sms', v.locale) t
    on conflict (dedupe_key) do nothing;
  end if;
  perform private.save_idempotent('staff_capture_consent', p_idempotency_key, jsonb_build_object('id', c.id));
  return private.consent_row_of(c.id);
end $$;

-- redefines api.staff_create_pay_code from 20261031113940_pos_pay_code.sql
create or replace function api.staff_create_pay_code(p_visit_id uuid) returns api.pay_code
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  p app.payments;
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := '';
  v_expires timestamptz := now() + interval '10 minutes';
begin
  -- Another tenant's visit, and a visit the caller has no role for, look the same: not_found.
  select * into v from app.visits x where x.id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then raise exception 'not_found'; end if;
  if private.write_blocked_reason(v.org_id, 'staff', (select auth.uid())) is not null
     or not private.has_permission(v.org_id, v.location_id, 'payments.request') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v.id::text, 0));
  select * into p from app.payments x
  where x.org_id = v.org_id and x.visit_id = v.id and x.kind = 'pos' and x.status = 'requires_action'
  order by x.created_at desc limit 1;
  if not found then raise exception 'illegal_payment_action'; end if;
  -- 32 symbols, so the low five bits of each byte are uniform. One live code per payment.
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  delete from app.pay_codes where payment_id = p.id;
  insert into app.pay_codes (code_hash, org_id, payment_id, expires_at)
  values (extensions.digest(v_code, 'sha256'), p.org_id, p.id, v_expires);
  return row(v_code, v_expires)::api.pay_code;
end $$;

-- redefines api.staff_mark_read from 20261030175652_visit_chat.sql
create or replace function api.staff_mark_read(p_visit_id uuid, p_up_to_id bigint)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  update app.visit_messages set read_at = now()
  where visit_id = v.id and sender = 'guest' and read_at is null and id <= coalesce(p_up_to_id, 0);
end $$;

-- redefines api.staff_request_payment from 20261031043839_pos_payment.sql
create or replace function api.staff_request_payment(
  p_visit_id uuid, p_amount_minor bigint, p_currency text, p_idempotency_key uuid
) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  p app.payments;
  claim record;
  v_row api.payment_row;
begin
  if p_idempotency_key is null or p_amount_minor is null or p_amount_minor not between 1 and 10000000
     or p_currency is null or p_currency !~ '^[a-z]{3}$' then
    raise exception 'invalid_input';
  end if;
  -- Another tenant's visit, and a visit the caller has no role for, look the same: not_found.
  select * into v from app.visits x where x.id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then raise exception 'not_found'; end if;
  -- has_role admits read-only support grants and suspended orgs; this write must not.
  if private.write_blocked_reason(v.org_id, 'staff', (select auth.uid())) is not null
     or not private.has_permission(v.org_id, v.location_id, 'payments.request') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.payments_connected(v.org_id) then raise exception 'illegal_payment_action'; end if;
  select * into claim from private.claim_idempotent(v.org_id, 'staff_request_payment', p_idempotency_key);
  if claim.replay then
    if (claim.response ->> 'visit_id')::uuid is distinct from v.id then raise exception 'invalid_input'; end if;
    return jsonb_populate_record(null::api.payment_row, claim.response);
  end if;
  if v.status not in ('called', 'serving', 'served') then raise exception 'illegal_payment_action'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v.id::text, 0));
  select * into p from app.payments x
  where x.org_id = v.org_id and x.visit_id = v.id and x.kind = 'pos' and x.status = 'requires_action'
  for update;
  if found then
    -- A mistyped amount is corrected until the guest's page opens the request (begin_pos_payment fixes the
    -- provider then, before any Stripe intent exists); after that it is refunded instead
    -- (staff_refund_payment) and never replaced under an intent that is already being created.
    if p.provider <> 'pending' then raise exception 'illegal_payment_action'; end if;
    update app.payments set amount_minor = p_amount_minor, currency = p_currency, updated_at = now()
    where id = p.id returning * into p;
  else
    insert into app.payments (org_id, location_id, visit_id, provider, kind, amount_minor, currency, idempotency_key)
    values (v.org_id, v.location_id, v.id, 'pending', 'pos', p_amount_minor, p_currency, p_idempotency_key::text)
    returning * into p;
  end if;
  v_row := private.payment_row(p);
  perform private.save_idempotent('staff_request_payment', p_idempotency_key, to_jsonb(v_row));
  return v_row;
end $$;

-- redefines api.staff_send_message from 20261030175652_visit_chat.sql
create or replace function api.staff_send_message(p_visit_id uuid, p_body text, p_idempotency_key uuid)
returns api.chat_message
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_body text := btrim(p_body);
  m app.visit_messages;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null or v_body is null or length(v_body) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  perform 1 from app.queues where id = v.queue_id for update;
  select * into v from app.visits where id = p_visit_id for update;
  if not private.chat_open(v) then
    raise exception 'illegal_transition' using detail = 'chat is closed for this visit';
  end if;
  if not (select q.chat_enabled from app.queues q where q.id = v.queue_id) then
    raise exception 'chat_disabled';
  end if;
  select * into m from app.visit_messages
  where visit_id = v.id and sender = 'staff' and idempotency_key = p_idempotency_key;
  if not found then
    insert into app.visit_messages (org_id, location_id, visit_id, sender, staff_user_id, body, idempotency_key)
    values (v.org_id, v.location_id, v.id, 'staff', (select auth.uid()), v_body, p_idempotency_key)
    returning * into m;
    perform private.bump_queue_version(v.queue_id);
  end if;
  return row(m.id, m.visit_id, m.sender, m.body, m.created_at, m.read_at)::api.chat_message;
end $$;

-- redefines api.staff_set_companions from 20261030173016_companions.sql
create or replace function api.staff_set_companions(p_visit_id uuid, p_names text[], p_expected_version int, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_names text[];
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or p_names is null then
    raise exception 'invalid_input';
  end if;
  select coalesce(array_agg(n), '{}') into v_names
  from (select btrim(x) n from unnest(p_names) x) s where n <> '';
  if exists (select 1 from unnest(v_names) n where length(n) > 40) then
    raise exception 'invalid_input';
  end if;
  if cardinality(v_names) > 9 then
    raise exception 'party_limit';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'staff_set_companions', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status not in ('waiting', 'called', 'serving', 'expected') then
    raise exception 'illegal_transition' using detail = format('edit companions of a %s visit', v.status);
  end if;

  delete from app.visit_companions where visit_id = v.id;
  insert into app.visit_companions (org_id, visit_id, first_name)
  select v.org_id, v.id, n from unnest(v_names) with ordinality t(n, o) order by o;
  v := private.sync_party(v, 'staff', (select auth.uid()));

  result := private.visit_row(v.id);
  perform private.save_idempotent('staff_set_companions', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

