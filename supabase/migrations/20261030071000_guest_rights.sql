-- 2P-PRV3 (#190): find, export and erase a guest's data (X-5). Owner/admin only, audited, and
-- the session must be aal2 when the caller has an authenticator. Erasure reuses the retention
-- anonymizers: visits stay, anonymized; consent evidence stays, marked revoked.

alter table app.audit_log drop constraint audit_log_action_check;
alter table app.audit_log add constraint audit_log_action_check
  check (action in ('INSERT', 'UPDATE', 'DELETE', 'EXPORT', 'ERASE'));

create type api.guest_match as (guest_id uuid, name text, visit_count int, last_visit_at timestamptz);
create type api.guest_export as (
  guest jsonb, contacts jsonb, visits jsonb, appointments jsonb, notifications jsonb,
  consents jsonb, generated_at timestamptz
);
create type api.erasure_result as (
  guest_id uuid, visits_anonymized int, contacts_deleted int, erased_at timestamptz
);
grant usage on type api.guest_match, api.guest_export, api.erasure_result to authenticated;

create function api.find_guest_data(p_phone_e164 text, p_email text) returns setof api.guest_match
language plpgsql stable security definer set search_path = '' as $$
declare
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
begin
  if v_phone is null and v_email is null then
    raise exception 'invalid_input';
  end if;
  return query
  select g.id, g.first_name, s.n, s.last_at
  from app.guests g
  cross join lateral (
    select count(*)::int as n, max(v.joined_at) as last_at from app.visits v where v.guest_id = g.id
  ) s
  where g.anonymized_at is null and private.has_role(g.org_id, null, 'admin')
    and exists (select 1 from app.guest_contacts c
                where c.guest_id = g.id
                  and ((c.channel = 'phone' and c.value = v_phone) or (c.channel = 'email' and c.value = v_email)));
end $$;
comment on function api.find_guest_data(text, text) is
  'Guests holding exactly this phone (E.164 after stripping separators) or email in orgs where '
  'the caller is owner or admin. Raises invalid_input when both are blank. Implemented in '
  '2P-PRV3 (#190).';

create function api.export_guest_data(p_guest_id uuid) returns api.guest_export
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.guests;
  r api.guest_export;
begin
  select * into g from app.guests where id = p_guest_id;
  if not found or not private.has_role(g.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();

  r.guest := to_jsonb(g);
  select coalesce(jsonb_agg(to_jsonb(c) - 'org_id'), '[]') into r.contacts
  from app.guest_contacts c where c.guest_id = g.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'ticket', v.display_ticket, 'status', v.status, 'name', v.guest_name,
           'phone', v.guest_phone_e164, 'email', v.guest_email, 'party_size', v.party_size,
           'source', v.source, 'joined_at', v.joined_at, 'called_at', v.called_at,
           'serving_at', v.serving_at, 'finished_at', v.finished_at) order by v.joined_at), '[]')
    into r.visits from app.visits v where v.guest_id = g.id;
  select coalesce(jsonb_agg(to_jsonb(a) - 'guest_token_hash' - 'org_id' order by a.starts_at), '[]')
    into r.appointments from app.appointments a where a.guest_id = g.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'visit_id', n.visit_id, 'channel', n.channel, 'template', n.template_key,
           'status', n.status, 'created_at', n.created_at) order by n.created_at), '[]')
    into r.notifications
  from app.notifications n
  where n.org_id = g.org_id and (n.visit_id in (select v.id from app.visits v where v.guest_id = g.id)
        or n.recipient_ref in (select c.id from app.guest_contacts c where c.guest_id = g.id));
  select coalesce(jsonb_agg(to_jsonb(k) - 'org_id' order by k.captured_at), '[]') into r.consents
  from app.consents k where k.contact_id in (select c.id from app.guest_contacts c where c.guest_id = g.id);
  r.generated_at := now();

  insert into app.audit_log (org_id, actor, role, action, table_name, row_id)
  values (g.org_id, (select auth.uid()), 'admin', 'EXPORT', 'guests', g.id::text);
  return r;
end $$;
comment on function api.export_guest_data(uuid) is
  'Everything held about one guest as jsonb sections: profile, contacts, visits, appointments, '
  'notification log (no recipient), consents. Owner or admin of the guest''s org; audited as '
  'EXPORT. Raises not_found for a guest outside the caller''s orgs, mfa_required when the caller '
  'has an authenticator and the session is below aal2. Implemented in 2P-PRV3 (#190).';

create function api.erase_guest(
  p_guest_id uuid, p_reason text, p_keep_suppression boolean, p_idempotency_key uuid
) returns api.erasure_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.guests;
  r api.erasure_result;
  v_saved jsonb;
  v_visits uuid[];
  v_appts uuid[];
  v_contacts uuid[];
  c record;
begin
  if p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  -- The guest is gone after the first call, so a repeat is answered from the saved result.
  select k.response into v_saved from app.idempotency_keys k
  where k.actor_id = (select auth.uid()) and k.rpc = 'erase_guest' and k.key = p_idempotency_key;
  if v_saved is not null then
    return jsonb_populate_record(null::api.erasure_result, v_saved);
  end if;

  select * into g from app.guests where id = p_guest_id;
  if not found or not private.has_role(g.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();
  perform private.claim_idempotent(g.org_id, 'erase_guest', p_idempotency_key);

  select coalesce(array_agg(v.id), '{}') into v_visits from app.visits v where v.guest_id = g.id;
  select coalesce(array_agg(a.id), '{}') into v_appts from app.appointments a where a.guest_id = g.id;
  select coalesce(array_agg(c2.id), '{}') into v_contacts from app.guest_contacts c2 where c2.guest_id = g.id;

  r.guest_id := g.id;
  r.visits_anonymized := private.anonymize_visits(g.org_id, v_visits);
  perform private.anonymize_appointments(g.org_id, v_appts);

  update app.consents set status = 'revoked', revoked_at = coalesce(revoked_at, now()),
                          revoked_via = coalesce(revoked_via, 'erasure')
  where contact_id = any (v_contacts) and status <> 'revoked';
  delete from app.dev_inbox where notification_id in
    (select n.id from app.notifications n where n.org_id = g.org_id and n.recipient_ref = any (v_contacts));
  if p_keep_suppression then
    for c in select channel, value from app.guest_contacts where id = any (v_contacts) loop
      insert into app.suppressions (org_id, channel, value, reason)
      values (g.org_id, case c.channel when 'phone' then 'sms' else 'email' end::app.notification_channel,
              c.value, 'manual')
      on conflict do nothing;
    end loop;
  end if;
  r.contacts_deleted := cardinality(v_contacts);
  delete from app.guests where id = g.id; -- contacts cascade; consents keep a hash of the value
  r.erased_at := now();

  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (g.org_id, (select auth.uid()), 'admin', 'ERASE', 'guests', g.id::text,
          jsonb_build_object('reason', left(btrim(p_reason), 200), 'keep_suppression', p_keep_suppression,
                             'visits_anonymized', r.visits_anonymized, 'contacts_deleted', r.contacts_deleted));
  perform private.save_idempotent('erase_guest', p_idempotency_key, to_jsonb(r));
  return r;
end $$;
comment on function api.erase_guest(uuid, text, boolean, uuid) is
  'Erases one guest: visits and appointments are anonymized (rows and statistics stay), contacts '
  'and the guest are deleted, consents are marked revoked (revoked_via erasure) and kept with a '
  'hash of the value, notification variables and dev inbox rows are cleared. With '
  'p_keep_suppression the phone and email stay on the org''s suppression list so the person is '
  'not messaged again. Owner or admin; audited as ERASE without the erased values; idempotent on '
  'p_idempotency_key. Raises not_found for a guest outside the caller''s orgs, mfa_required below '
  'aal2 when the caller has an authenticator. Implemented in 2P-PRV3 (#190).';

revoke all on function api.find_guest_data(text, text), api.export_guest_data(uuid),
  api.erase_guest(uuid, text, boolean, uuid) from public, anon;
grant execute on function api.find_guest_data(text, text), api.export_guest_data(uuid),
  api.erase_guest(uuid, text, boolean, uuid) to authenticated;
