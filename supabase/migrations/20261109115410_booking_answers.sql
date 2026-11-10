-- F3 (#1279): booking parity for the forms engine (epic #1267, design forms-privacy-design.md 2.2).
--
-- A booking carries answers against a form version, and check-in carries them to the visit by
-- reference, so a guest is never asked twice. Alternatives (rule 7): (1) append a defaulted `answers`
-- param to api.book_appointment (rejected: a phase-0 signature, and it would leave an overload), vs
-- (2) a new anon api.set_booking_answers(token, answers) called right after booking (chosen: the
-- token the guest already holds is the credential, so the booking path is untouched). The form is
-- fetched with api.get_join_form, extended with a defaulted channel instead of a second read function.
-- Answers reach the visit by pointing the same app.form_responses row at it (no copy); the legacy
-- app.visit_answers row the staff console reads is mirrored until the contract step (I-12).
--
-- redefines private.resolve_form from 20261109094337_forms_engine.sql
-- redefines api.get_join_form from 20261109114237_form_field_vocabulary.sql
-- redefines private.anonymize_appointments from 20261030100002_appointment_retention.sql

-- A response may point at both: the booking that collected it and the visit it was carried to.
alter table app.form_responses drop constraint form_responses_check;
alter table app.form_responses add constraint form_responses_subject_check
  check (visit_id is not null or appointment_id is not null);

-- The published version for (queue, service) on a channel: a service target beats the queue target,
-- the channel's own target beats 'any'.
create function private.resolve_form_for(p_queue_id uuid, p_service_id uuid, p_channel text) returns uuid
language sql stable set search_path = '' as $$
  select v.id
  from app.queues q
  join app.form_targets t on t.org_id = q.org_id and t.location_id = q.location_id
       and (t.queue_id = q.id or (p_service_id is not null and t.service_id = p_service_id))
       and t.channel in ('any', p_channel)
  cross join lateral (
    select fv.id from app.form_versions fv
    where fv.form_id = t.form_id and fv.published_at is not null
    order by fv.version desc limit 1
  ) v
  where q.id = p_queue_id
  order by (t.service_id is not null) desc, (t.channel = p_channel) desc
  limit 1
$$;
comment on function private.resolve_form_for(uuid, uuid, text) is
  'Id of the latest published form version for (queue, service) on a channel (walk_in or booking): a '
  'service target beats the queue target, the channel''s own target beats any; targets of another '
  'location are never used. Null when no form is attached.';
revoke all on function private.resolve_form_for(uuid, uuid, text) from public, anon, authenticated;

-- redefines private.resolve_form from 20261109094337_forms_engine.sql: now the walk-in case of resolve_form_for
create or replace function private.resolve_form(p_queue_id uuid, p_service_id uuid) returns uuid
language sql stable set search_path = '' as $$
  select private.resolve_form_for(p_queue_id, p_service_id, 'walk_in')
$$;
comment on function private.resolve_form(uuid, uuid) is
  'private.resolve_form_for on the walk_in channel: the form a walk-in on (queue, service) gets.';

-- redefines api.get_join_form from 20261109114237_form_field_vocabulary.sql: appends p_channel (nothing calls it yet)
drop function api.get_join_form(uuid, uuid);
create function api.get_join_form(p_queue_id uuid, p_service_id uuid default null, p_channel text default 'walk_in')
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
               'options', e -> 'options', 'required', coalesce((e ->> 'required')::boolean, false),
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
  'phone, email, heading, marketing_consent), options, required, must_be_true and sensitivity of the '
  'guest-visible fields in form order (array order); staff-only fields never leave the database. A '
  'service form beats the queue form; no form is {form_version_id: null, fields: []}. The client '
  'renders it and never derives validity: api.join_queue and api.set_booking_answers check the answers against this version. '
  'Contains no guest data. Raises invalid_input for an unknown channel and not_found for an unknown or archived queue or an org being '
  'deleted.';
revoke all on function api.get_join_form(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function api.get_join_form(uuid, uuid, text) to anon, authenticated, service_role;

-- Points the booking's responses at its visit and mirrors the answers for the staff console.
-- Callable only from definer code: it writes tables guests cannot touch.
create function private.carry_booking_answers(p_appointment_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.appointments;
  v_answers jsonb;
begin
  select * into a from app.appointments where id = p_appointment_id;
  if not found or a.visit_id is null or a.anonymized_at is not null
     or exists (select 1 from app.visits v where v.id = a.visit_id
                and (v.anonymized_at is not null or v.status in ('served', 'no_show', 'cancelled', 'removed', 'expired'))) then
    return;
  end if;
  update app.form_responses set visit_id = a.visit_id
  where appointment_id = a.id and visit_id is distinct from a.visit_id;
  select r.answers into v_answers from app.form_responses r
  where r.appointment_id = a.id order by r.updated_at desc limit 1;
  if v_answers is null or v_answers = '{}' then
    delete from app.visit_answers where visit_id = a.visit_id;
  else
    insert into app.visit_answers (org_id, location_id, visit_id, answers)
    values (a.org_id, a.location_id, a.visit_id, v_answers)
    on conflict (visit_id) do update set answers = excluded.answers;
  end if;
end $$;
comment on function private.carry_booking_answers(uuid) is
  'Carries a booking''s answers to its visit by reference: the same form_responses row also points at '
  'the visit, and the legacy visit_answers row is mirrored. No-op before the visit exists. Idempotent.';
revoke all on function private.carry_booking_answers(uuid) from public, anon, authenticated;

create function private.carry_answers_on_visit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.carry_booking_answers(new.id);
  return null;
end $$;
comment on function private.carry_answers_on_visit() is
  'AFTER trigger on app.appointments: when the booking gets its visit (materialization, a new day), '
  'its answers go with it.';
revoke all on function private.carry_answers_on_visit() from public, anon, authenticated;
create trigger carry_answers_on_visit after update on app.appointments
  for each row when (new.visit_id is not null and new.visit_id is distinct from old.visit_id)
  execute function private.carry_answers_on_visit();

create function api.set_booking_answers(p_token text, p_answers jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set statement_timeout = '2s' set lock_timeout = '2s' as $$
declare
  a app.appointments;
  v_ver uuid;
  v_answers jsonb;
begin
  a := private.appointment_by_token(p_token);
  -- An erased booking keeps its token hash for the manage link, but takes no new answers.
  if a.id is null or a.anonymized_at is not null then
    raise exception 'not_found';
  end if;
  if a.status::text not in ('booked', 'pending_payment', 'checked_in') then
    raise exception 'too_late_to_change';
  end if;
  -- The version recorded first stays the booking's version; otherwise the one in force now.
  select r.form_version_id into v_ver from app.form_responses r
  where r.appointment_id = a.id order by r.created_at limit 1;
  v_ver := coalesce(v_ver, private.resolve_form_for(a.queue_id, a.service_id, 'booking'));
  v_answers := private.validate_form_answers(
    a.org_id, coalesce((select fv.fields from app.form_versions fv where fv.id = v_ver), '[]'), p_answers, 'guest');
  if v_ver is not null then
    insert into app.form_responses (org_id, location_id, form_version_id, appointment_id, answers)
    values (a.org_id, a.location_id, v_ver, a.id, v_answers)
    on conflict (appointment_id, form_version_id) where appointment_id is not null
    do update set answers = excluded.answers;
    perform private.carry_booking_answers(a.id);
  end if;
  return jsonb_build_object('form_version_id', v_ver);
end $$;
comment on function api.set_booking_answers(text, jsonb) is
  'Records the guest''s answers to the booking''s form: replaces any earlier answers, validated against '
  'the version first recorded for the booking (else the booking-channel form in force: required '
  'guest fields enforced, staff-only fields refused). The guest''s appointment token is the credential. '
  'When the booking already has its visit the answers are carried to it, and a later check-in or '
  'materialization carries them too, so the guest is never asked twice. Idempotent. Returns '
  '{form_version_id} (null when no form applies). Raises not_found for an unknown or expired token, '
  'too_late_to_change for a cancelled, completed or no-show booking, invalid_answers (DETAIL the failing '
  'key, never a value). Why a new function: api.book_appointment is a fixed phase-0 signature.';
revoke all on function api.set_booking_answers(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function api.set_booking_answers(text, jsonb) to anon, authenticated, service_role;

-- redefines private.anonymize_appointments from 20261030100002_appointment_retention.sql: also deletes form responses
create or replace function private.anonymize_appointments(p_org_id uuid, p_ids uuid[]) returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int;
begin
  perform private.set_actor('system', null, null, 'retention');
  update app.appointments set guest_name = '—', guest_id = null, contact_id = null,
                              guest_email = null, guest_phone_e164 = null, anonymized_at = now()
  where org_id = p_org_id and id = any (p_ids) and anonymized_at is null;
  get diagnostics n = row_count;
  delete from app.push_subscriptions where org_id = p_org_id and appointment_id = any (p_ids);
  delete from app.form_responses where org_id = p_org_id and appointment_id = any (p_ids);
  delete from app.visit_answers where org_id = p_org_id
    and visit_id in (select a.visit_id from app.appointments a where a.id = any (p_ids));
  update app.notifications set recipient_hash = null
  where org_id = p_org_id and appointment_id = any (p_ids) and recipient_hash is not null;
  return n;
end $$;

notify pgrst, 'reload schema';
