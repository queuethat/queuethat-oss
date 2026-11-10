-- F1 (#1277): forms library schema. Expand step only: nothing reads or writes these tables yet,
-- app.intake_fields and app.visit_answers are untouched (contract step comes after the soak, I-12).
-- Design: docs forms-privacy-design.md 2.2.
--
-- Writes belong to later api.* functions (F2 join, F5 admin RPCs), so `authenticated` gets SELECT
-- only. The caps (3 library forms per location, 20 fields per version) and publish immutability
-- are enforced by triggers and checks so those functions cannot forget them.

create unique index services_org_location_id_idx on app.services (org_id, location_id, id);
create unique index appointments_org_location_id_idx on app.appointments (org_id, location_id, id);

create table app.forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  purpose_text text check (length(purpose_text) <= 300),
  origin_template text,
  origin_version int,
  -- Hard cap 365 days (design 12.3); null = the organisation default.
  retention_days int check (retention_days between 1 and 365),
  status text not null default 'draft' check (status in ('draft', 'published')),
  -- Per-queue fallback forms created by the F2 backfill; they do not count toward the library cap.
  is_queue_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  unique (org_id, id),
  unique (org_id, location_id, id)
);
create index forms_location_idx on app.forms (location_id);

create table app.form_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  form_id uuid not null,
  version int not null check (version >= 1),
  -- The ordered field list. Shape is validated by the F5 publish function; the cap is structural.
  fields jsonb not null default '[]'
    check (case when jsonb_typeof(fields) = 'array' then jsonb_array_length(fields) <= 20 else false end),
  -- Set by the publish trigger: sha256 of the fields as published. Null while a draft.
  text_hash bytea,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id, form_id) references app.forms (org_id, location_id, id),
  unique (form_id, version),
  unique (org_id, id)
);
-- At most one draft per form.
create unique index form_versions_one_draft_idx on app.form_versions (form_id) where published_at is null;

create table app.form_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  form_id uuid not null,
  queue_id uuid,
  service_id uuid,
  -- Where the form is shown. A service is the same row for walk-in and booking.
  channel text not null default 'any' check (channel in ('any', 'walk_in', 'booking')),
  created_at timestamptz not null default now(),
  check ((queue_id is null) <> (service_id is null)),
  foreign key (org_id, location_id, form_id) references app.forms (org_id, location_id, id),
  foreign key (org_id, location_id, queue_id) references app.queues (org_id, location_id, id),
  foreign key (org_id, location_id, service_id) references app.services (org_id, location_id, id)
);
-- One form per target and channel.
create unique index form_targets_queue_idx on app.form_targets (queue_id, channel) where queue_id is not null;
create unique index form_targets_service_idx on app.form_targets (service_id, channel) where service_id is not null;
create index form_targets_form_idx on app.form_targets (form_id);

create table app.form_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  form_version_id uuid not null,
  visit_id uuid,
  appointment_id uuid,
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((visit_id is null) <> (appointment_id is null)),
  foreign key (org_id, form_version_id) references app.form_versions (org_id, id),
  foreign key (org_id, location_id, visit_id) references app.visits (org_id, location_id, id),
  foreign key (org_id, location_id, appointment_id) references app.appointments (org_id, location_id, id)
);
create unique index form_responses_visit_idx on app.form_responses (visit_id, form_version_id) where visit_id is not null;
create unique index form_responses_appointment_idx on app.form_responses (appointment_id, form_version_id) where appointment_id is not null;
create index form_responses_version_idx on app.form_responses (form_version_id);

------------------------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------------------------

create function private.check_form() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not new.is_queue_default and (
    select count(*) from app.forms f where f.location_id = new.location_id and not f.is_queue_default
  ) >= 3 then
    raise exception 'invalid_input' using detail = 'too many forms';
  end if;
  if tg_op = 'UPDATE' and (new.location_id, new.is_queue_default) is distinct from (old.location_id, old.is_queue_default) then
    raise exception 'immutable_column' using errcode = '42501';
  end if;
  return new;
end $$;
comment on function private.check_form() is
  'BEFORE trigger on app.forms: a location has at most 3 library forms (queue defaults excluded); '
  'location and default flag never change.';
create trigger check_form before insert or update on app.forms
  for each row execute function private.check_form();

create function private.guard_form_version() returns trigger
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
    new.text_hash := extensions.digest(new.fields::text, 'sha256');
  else
    new.text_hash := null;
  end if;
  return new;
end $$;
comment on function private.guard_form_version() is
  'BEFORE trigger on app.form_versions: a published version (published_at set) can never be '
  'updated or deleted; publishing stores sha256 of the fields so what a guest saw is provable.';
create trigger guard_form_version before insert or update or delete on app.form_versions
  for each row execute function private.guard_form_version();

create trigger touch_updated_at before update on app.forms
  for each row execute function private.touch_updated_at();
create trigger touch_updated_at before update on app.form_responses
  for each row execute function private.touch_updated_at();
create trigger forbid_org_change before update on app.forms
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.form_versions
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.form_targets
  for each row execute function private.forbid_org_change();
create trigger forbid_org_change before update on app.form_responses
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.forms
  for each row execute function private.audit_row();
create trigger audit_row after insert or update or delete on app.form_targets
  for each row execute function private.audit_row();
-- No audit trigger on form_responses: audit_log would copy the answers.

------------------------------------------------------------------------------------------------
-- RLS: read-only for authenticated; writes arrive with the F2 and F5 definer functions.
------------------------------------------------------------------------------------------------

alter table app.forms enable row level security;
alter table app.form_versions enable row level security;
alter table app.form_targets enable row level security;
alter table app.form_responses enable row level security;
revoke insert, update, delete, truncate on app.forms, app.form_versions, app.form_targets, app.form_responses
  from authenticated;

create policy forms_select on app.forms for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')) or (select private.is_device(org_id, location_id)));
create policy form_versions_select on app.form_versions for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')) or (select private.is_device(org_id, location_id)));
create policy form_targets_select on app.form_targets for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')) or (select private.is_device(org_id, location_id)));
create policy form_responses_select on app.form_responses for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
