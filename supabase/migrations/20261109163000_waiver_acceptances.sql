-- W2 (#1304, tracker #1267): the waiver acceptance evidence record.
--
-- W1 stores what a guest accepted inside the answers (agreement {accepted, text_hash, accepted_at},
-- signature {name, guardian_name?, signed_at}). Answers are replaceable by staff and vanish with the
-- response, so this adds a separate, append-only evidence row per accepted agreement: which form
-- version, the hash of the text shown, server time, the typed name and guardian, and the subject.
--
-- Written only by a trigger on app.form_responses, so every entry point (join, booking, staff edit) is
-- covered and no function can forget it (interface rule 5). Nothing new is callable: no API, no grant to
-- anon, authenticated may only SELECT (staff of the location). No IP address or device fingerprint is
-- stored, by design. Retention: the row cascades from its response, so it is deleted by the same
-- retention purge that deletes the answers (organisation retention_days, capped at 365 by C3); there is
-- no waiver exception (Riz decision 2026-11-09). I-13: the table is not in any guest response, view or log.
--
-- Subject: the booking when the response was collected for an appointment, else the visit. It is fixed at
-- acceptance and never follows the response when a booking is carried to its visit (the appointment's
-- visit_id links them).
-- Alternatives rejected: calling a new insert function from join_core, set_booking_answers and
-- set_visit_answers (three more bodies to keep in sync); one hash column on form_versions (cannot tell
-- which agreement of a multi-agreement form was ticked).

create table app.waiver_acceptances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  form_response_id uuid not null references app.form_responses (id) on delete cascade,
  form_version_id uuid not null,
  field_key text not null,
  -- Hex sha256 of label, newline and body of the agreement the guest was shown (private.agreement_hash).
  text_hash text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null,
  -- Null when the form has no signature field; guardian only when that field collects one.
  typed_name text check (length(typed_name) between 2 and 120),
  guardian_name text check (length(guardian_name) between 1 and 120),
  signed_at timestamptz,
  subject_kind text not null check (subject_kind in ('visit', 'appointment')),
  subject_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  foreign key (org_id, form_version_id) references app.form_versions (org_id, id),
  unique (form_response_id, field_key)
);
create index waiver_acceptances_subject_idx on app.waiver_acceptances (subject_id);
create index waiver_acceptances_org_time_idx on app.waiver_acceptances (org_id, accepted_at desc);
create index waiver_acceptances_version_idx on app.waiver_acceptances (form_version_id);

comment on table app.waiver_acceptances is
  'Append-only evidence that a guest accepted an agreement: form version, text hash, server time, typed '
  'name, guardian and subject. Written by a trigger on app.form_responses; deleted with the response by the '
  'retention purge (cascade). No IP or device data. Never returned to guests.';

alter table app.waiver_acceptances enable row level security;
revoke all on app.waiver_acceptances from anon, authenticated;
grant select on app.waiver_acceptances to authenticated;
create policy waiver_acceptances_select on app.waiver_acceptances for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));

-- Evidence is never edited. Rows only leave through the response cascade (retention purge).
create function private.guard_waiver_acceptance() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'immutable_column' using errcode = '42501', detail = 'waiver acceptance';
end $$;
comment on function private.guard_waiver_acceptance() is
  'BEFORE UPDATE trigger on app.waiver_acceptances: an acceptance record is never changed.';
revoke all on function private.guard_waiver_acceptance() from public, anon, authenticated;
create trigger guard_waiver_acceptance before update on app.waiver_acceptances
  for each row execute function private.guard_waiver_acceptance();

-- One row per accepted agreement of the response's form version; the first answered signature supplies
-- the typed name and guardian. An existing row is kept as it is (the first acceptance is the evidence).
create function private.record_waiver_acceptances() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fields jsonb;
  v_sig jsonb;
  f jsonb;
begin
  select v.fields into v_fields from app.form_versions v where v.id = new.form_version_id;
  select new.answers -> (s ->> 'key') into v_sig
  from jsonb_array_elements(coalesce(v_fields, '[]')) s
  where s ->> 'type' = 'signature' and jsonb_typeof(new.answers -> (s ->> 'key')) = 'object'
  limit 1;
  for f in select a from jsonb_array_elements(coalesce(v_fields, '[]')) a where a ->> 'type' = 'agreement' loop
    if new.answers #>> array[f ->> 'key', 'accepted'] = 'true'
       and new.answers #>> array[f ->> 'key', 'text_hash'] is not null then
      insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash,
                                          accepted_at, typed_name, guardian_name, signed_at, subject_kind, subject_id)
      values (new.org_id, new.location_id, new.id, new.form_version_id, f ->> 'key',
              new.answers #>> array[f ->> 'key', 'text_hash'],
              (new.answers #>> array[f ->> 'key', 'accepted_at'])::timestamptz,
              v_sig ->> 'name', v_sig ->> 'guardian_name', (v_sig ->> 'signed_at')::timestamptz,
              case when new.appointment_id is not null then 'appointment' else 'visit' end,
              coalesce(new.appointment_id, new.visit_id))
      on conflict (form_response_id, field_key) do nothing;
    end if;
  end loop;
  return null;
end $$;
comment on function private.record_waiver_acceptances() is
  'AFTER INSERT/UPDATE OF answers trigger on app.form_responses: records one app.waiver_acceptances row per '
  'accepted agreement (hash and time as W1 stamped them, typed name and guardian from the form''s signature). '
  'Keeps the first record. Not callable.';
revoke all on function private.record_waiver_acceptances() from public, anon, authenticated;
create trigger record_waiver_acceptances after insert or update of answers on app.form_responses
  for each row execute function private.record_waiver_acceptances();
