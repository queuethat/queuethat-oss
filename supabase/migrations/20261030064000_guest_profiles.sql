-- 2P-CRM1 (#184): guest profiles with several contacts (C-1, C-2).
--
-- One guest per (org, contact value). private.find_or_create_guest is the single place that links
-- a phone and/or email to a guest; private.join_core's staff branch already does the same through
-- private.ensure_contact (online joins stay unlinked on purpose, see 20261025004110_join_hardening),
-- so join_core is not redefined. Staff attach and remove extra contacts through two RPCs.

-- Consent evidence outlives its contact (compliance: proof of what was agreed). Removing a contact
-- keeps the consent row with the link nulled and a hash of the value, so a later erasure request
-- can still be matched without storing the number.
alter table app.consents alter column contact_id drop not null;
alter table app.consents add column contact_value_sha256 bytea;
alter table app.consents drop constraint consents_org_id_contact_id_fkey;
alter table app.consents add foreign key (org_id, contact_id)
  references app.guest_contacts (org_id, id) on delete set null (contact_id);

create function private.hash_contact_on_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  update app.consents set contact_value_sha256 = sha256(convert_to(old.value, 'utf8'))
  where org_id = old.org_id and contact_id = old.id;
  return old;
end $$;
create trigger hash_contact_on_delete before delete on app.guest_contacts
  for each row execute function private.hash_contact_on_delete();

/**
 * The guest holding a phone and/or email in one org, created when neither exists. Matching is per
 * org on the normalised value only. A new guest takes both contacts; when the two values already
 * belong to different guests the phone's guest wins and the email stays where it is (merging is C-5).
 */
create function private.find_or_create_guest(
  p_org_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_source text,
  out o_guest_id uuid,
  out o_phone_contact_id uuid,
  out o_email_contact_id uuid
)
language plpgsql volatile set search_path = '' as $$
declare
  v_phone text := nullif(btrim(p_phone_e164), '');
  v_email text := nullif(lower(btrim(p_email)), '');
begin
  if v_phone is not null then
    select c.contact_id, c.guest_id into o_phone_contact_id, o_guest_id
    from private.ensure_contact(p_org_id, 'phone', v_phone, null, p_name, p_source, true) c;
  end if;
  if v_email is not null then
    select c.contact_id, coalesce(o_guest_id, c.guest_id) into o_email_contact_id, o_guest_id
    from private.ensure_contact(p_org_id, 'email', v_email, o_guest_id, p_name, p_source, true) c;
  end if;
end $$;
comment on function private.find_or_create_guest(uuid, text, text, text, text) is
  'Links a phone and/or email to one guest per org, creating the guest and contacts on first use. '
  'Never matches across orgs. Callers: staff adds, bookings (2P-APT3).';
revoke all on function private.find_or_create_guest(uuid, text, text, text, text)
  from public, anon, authenticated;

create function api.add_guest_contact(
  p_guest_id uuid, p_channel text, p_value text, p_idempotency_key uuid
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.guests;
  v_channel app.contact_channel;
  v_value text := btrim(p_value);
  v_claim record;
  v_owner uuid;
  v_id uuid;
begin
  select * into g from app.guests where id = p_guest_id and anonymized_at is null;
  if not found or not private.has_role(g.org_id, null, 'staff') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null or p_channel not in ('phone', 'email') or v_value is null then
    raise exception 'invalid_input';
  end if;
  v_channel := p_channel::app.contact_channel;
  if v_channel = 'phone' then
    v_value := regexp_replace(v_value, '[[:space:]().-]', '', 'g');
    if v_value !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_input'; end if;
  else
    v_value := lower(v_value);
    if length(v_value) > 254 or v_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'invalid_input';
    end if;
  end if;

  select * into v_claim from private.claim_idempotent(g.org_id, 'add_guest_contact', p_idempotency_key);
  if v_claim.replay then
    return (v_claim.response ->> 'id')::uuid;
  end if;

  select c.id, c.guest_id into v_id, v_owner
  from app.guest_contacts c
  where c.org_id = g.org_id and c.channel = v_channel and c.value = v_value;
  if found then
    -- Adding what the guest already has is a no-op; someone else's contact is never moved.
    if v_owner <> g.id then raise exception 'contact_in_use'; end if;
  else
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (g.org_id, g.id, v_channel, v_value, 'staff')
    returning id into v_id;
  end if;
  perform private.save_idempotent('add_guest_contact', p_idempotency_key, jsonb_build_object('id', v_id));
  return v_id;
end $$;
comment on function api.add_guest_contact(uuid, text, text, uuid) is
  'Attaches a phone (E.164 after stripping separators) or lower-cased email to a guest of the '
  'caller''s org; staff or above. Returns the contact id; adding a contact the guest already has '
  'returns it. Raises not_found for a guest outside the caller''s orgs or an anonymized one, '
  'contact_in_use when the value belongs to another guest of the org, invalid_input for a bad '
  'channel or value. Idempotent on p_idempotency_key. Implemented in 2P-CRM1 (#184).';

create function api.remove_guest_contact(p_contact_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  c app.guest_contacts;
begin
  select * into c from app.guest_contacts where id = p_contact_id;
  if not found or not private.has_role(c.org_id, null, 'staff') then
    raise exception 'not_found';
  end if;
  -- Visits keep their guest but lose the link to the removed contact (an 'updated' event each).
  perform private.set_actor('staff', (select auth.uid()), null, 'contact_removed');
  update app.visits set contact_id = null where org_id = c.org_id and contact_id = c.id;
  delete from app.guest_contacts where id = c.id;
end $$;
comment on function api.remove_guest_contact(uuid) is
  'Deletes a contact of the caller''s org; staff or above. Visits and consent records stay, with '
  'their link to the contact cleared (consents keep a hash of the value). Removing a contact that '
  'is already gone raises not_found. Implemented in 2P-CRM1 (#184).';

revoke all on function api.add_guest_contact(uuid, text, text, uuid), api.remove_guest_contact(uuid)
  from public, anon;
grant execute on function api.add_guest_contact(uuid, text, text, uuid), api.remove_guest_contact(uuid)
  to authenticated;
